/* Pure SillyTavern timeline normalization. Also loaded by Node tests. */
(function (root, factory) {
    const logic = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = logic;
    root.EchoGraphTimelineLogic = logic;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    const SYSTEM_TYPES = new Set(['help', 'welcome', 'empty', 'generic', 'comment',
        'slash_commands', 'formatting', 'hotkeys', 'macros', 'welcome_prompt',
        'assistant_note', 'assistant_message']);
    const uuid = () => globalThis.crypto?.randomUUID?.() ||
        'eg-' + Math.random().toString(36).slice(2) + Date.now().toString(36);

    function activeExtra(message) {
        // SillyTavern writes edits to the active message before copying them to swipe_info.
        return message.extra || {};
    }

    function isNotice(message, extra = activeExtra(message)) {
        return SYSTEM_TYPES.has(extra.type) || extra.uses_system_ui === true ||
            (message.is_system === true && message.name === 'SillyTavern System' &&
             message.force_avatar === 'img/five.png' && extra.swipeable === false);
    }

    function roleAndInclusion(message) {
        const extra = activeExtra(message);
        const role = extra.type === 'narrator' ? 'narrator' : message.is_user ? 'user' : 'assistant';
        return { role, included: extra.type !== 'comment' && !extra.tool_invocations &&
            !isNotice(message, extra) && message.is_system !== true };
    }

    function stamp(chat, makeId = uuid) {
        const seenMessages = new Set(), seenVersions = new Set();
        let changed = false;
        for (const message of chat) {
            if (!message || typeof message !== 'object') continue;
            const swipes = Array.isArray(message.swipe_info) && message.swipe_info.length
                ? message.swipe_info : null;
            if (!message.extra || typeof message.extra !== 'object') { message.extra = {}; changed = true; }
            const extras = swipes ? swipes.map(swipe => {
                if (!swipe.extra || typeof swipe.extra !== 'object') { swipe.extra = {}; changed = true; }
                return swipe.extra;
            }) : [message.extra];
            const active = activeExtra(message);
            const selectedIndex = Number.isInteger(message.swipe_id) ? message.swipe_id : 0;
            const selected = swipes ? extras[selectedIndex] || extras[0] : extras[0];
            if (active.eg_version_id && selected.eg_version_id !== active.eg_version_id) {
                selected.eg_version_id = active.eg_version_id;
                changed = true;
            }
            let msgId = active.eg_msg_id || extras.find(e => e.eg_msg_id)?.eg_msg_id;
            if (!msgId || seenMessages.has(msgId)) { msgId = makeId(); changed = true; }
            seenMessages.add(msgId);
            for (const extra of extras) {
                if (extra.eg_msg_id !== msgId) { extra.eg_msg_id = msgId; changed = true; }
                if (!extra.eg_version_id || seenVersions.has(extra.eg_version_id)) {
                    extra.eg_version_id = makeId(); changed = true;
                }
                seenVersions.add(extra.eg_version_id);
            }
            for (const field of ['eg_msg_id', 'eg_version_id']) {
                if (message.extra[field] !== selected[field]) { message.extra[field] = selected[field]; changed = true; }
            }
            if (!isNotice(message, active) && active.type !== 'narrator' &&
                active.type !== 'comment' && !active.tool_invocations) {
                const hidden = message.is_system === true;
                for (const extra of extras) {
                    if (hidden && extra.eg_hidden !== true) { extra.eg_hidden = true; changed = true; }
                    if (!hidden && Object.hasOwn(extra, 'eg_hidden')) { delete extra.eg_hidden; changed = true; }
                }
                if (hidden) message.extra.eg_hidden = true;
                else if (Object.hasOwn(message.extra, 'eg_hidden')) { delete message.extra.eg_hidden; changed = true; }
            }
        }
        return changed;
    }

    function normalize(chat) {
        return chat.map(message => {
            const extra = activeExtra(message);
            const classification = roleAndInclusion(message);
            return { msg_id: extra.eg_msg_id, version_id: extra.eg_version_id,
                role: classification.role, content: String(message.mes ?? ''),
                included: classification.included };
        });
    }

    function registrationPayload(metadata, owner, fileName, previousFileExists) {
        return { chat_uuid: metadata.echograph.chat_uuid,
            integrity: String(metadata.integrity || ''), owner: String(owner),
            file_name: String(fileName), previous_file_exists: !!previousFileExists };
    }

    function bookEntries(value) {
        const entries = value?.entries || value || {};
        return (Array.isArray(entries) ? entries : Object.values(entries)).map(entry => ({
            uid: entry.uid, key: entry.key || [], keysecondary: entry.keysecondary || [],
            content: entry.content || '', disable: !!entry.disable,
        }));
    }
    async function basePayload(ctx, worldInfo) {
        const group = ctx.groups?.find(item => item.id === ctx.groupId);
        const members = ctx.groupId
            ? [...(group?.members || [])].sort().map(avatar =>
                ctx.characters?.find(item => item.avatar === avatar))
            : [ctx.characters?.[ctx.characterId]];
        if (!members.length || members.some(member => !member)) {
            throw new Error('Unable to resolve every group member card');
        }
        const cards = members.map(character => {
            const data = character?.data || {};
            return Object.fromEntries(['name', 'description', 'personality', 'scenario', 'mes_example']
                .map(field => [field, data[field] ?? character?.[field] ?? '']));
        });
        const specs = [];
        function add(source, names) {
            for (const name of (Array.isArray(names) ? names : [names]).filter(Boolean)) specs.push({ source, name });
        }
        for (const character of members) {
            const data = character?.data || {};
            add('character', data.extensions?.world);
            const characterFile = String(character?.avatar || '').replace(/\.png$/i, '');
            const extra = worldInfo.world_info.charLore?.find(item => item.name === characterFile);
            add('character_extra', extra?.extraBooks);
        }
        add('chat', ctx.chatMetadata?.world_info);
        add('global', worldInfo.selected_world_info);
        add('persona', ctx.powerUserSettings?.persona_description_lorebook);
        const books = [];
        for (const spec of specs) {
            const loaded = await ctx.loadWorldInfo(spec.name);
            if (loaded) books.push({ ...spec, entries: bookEntries(loaded) });
        }
        for (const character of members) {
            const embedded = character?.data?.character_book;
            if (embedded) books.push({ source: 'embedded', name: 'character_book',
                entries: bookEntries(embedded) });
        }
        return ctx.groupId ? { cards, books } : { card: cards[0], books };
    }
    function hash(value) {
        // Stable and cheap; collision resistance is supplied by the engine's SHA-256 keys.
        const text = JSON.stringify(value);
        let h = 2166136261;
        for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
        return (h >>> 0).toString(16);
    }
    return { activeExtra, isNotice, roleAndInclusion, stamp, normalize,
        registrationPayload, basePayload, hash };
});
