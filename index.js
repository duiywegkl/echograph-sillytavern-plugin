/* EchoGraph timeline integration for SillyTavern 1.19.0. */
jQuery(async () => {
    if (window.__echoGraphTimelineLoaded) return;
    window.__echoGraphTimelineLoaded = true;
    await import('./timeline_logic.js');
    const worldInfo = await import('/scripts/world-info.js');
    const logic = window.EchoGraphTimelineLogic;
    const context = () => window.SillyTavern.getContext();
    const previousSettings = context().extensionSettings.echograph_settings || {};
    const settings = context().extensionSettings.echograph_timeline ||= {
        enabled: previousSettings.enabled ?? true,
        api_base_url: previousSettings.api_base_url || 'http://127.0.0.1:9543',
        show_notifications: previousSettings.show_notifications ?? true,
    };
    settings.show_notifications ??= true;
    let chatUuid = null, chatKey = null, generation = false, generationType = null, timer = null;
    let saveTimer = null, lastHash = null, lastObservedHash = null, lastBaseHash = null, epoch = 0;
    let status = { state: 'disconnected' };
    let retryTimer = null, retryDelay = 3000, outageNotified = false;
    const inconsistentReasonsNotified = new Set();

    async function request(path, options = {}, timeout = 3000) {
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), timeout);
        try {
            let result;
            try {
                result = await fetch(`${settings.api_base_url}${path}`, {
                    ...options, signal: controller.signal,
                    headers: { 'Content-Type': 'application/json', ...options.headers },
                });
            } catch (error) {
                error.network = true;
                throw error;
            }
            if (!result.ok) {
                const error = new Error(`HTTP ${result.status}: ${await result.text()}`);
                error.httpStatus = result.status;
                error.network = [404, 502, 503, 504].includes(result.status);
                throw error;
            }
            const data = await result.json();
            if (path !== '/timeline/heartbeat' && settings.enabled) void heartbeat();
            return data;
        } finally { clearTimeout(id); }
    }
    const post = (path, payload) => request(path, { method: 'POST', body: JSON.stringify(payload) });

    async function heartbeat() {
        if (!settings.enabled) return;
        try {
            await post('/timeline/heartbeat', { chat_uuid: chatUuid });
            if (settings.enabled && !chatUuid) updateStatus({ state: 'idle' });
        } catch (error) {
            if (settings.enabled && !chatUuid) updateStatus({ state: 'disconnected', reason: error.message });
        }
    }

    function renderStatus() {
        const text = logic.statusText(status);
        $('#eg-timeline-status').text(text);
        $('#eg-timeline-header-status').text(text);
        $('#eg-timeline-retry').toggle(status.state === 'inconsistent' ||
            (status.state === 'needs_base' && !!status.reason));
    }
    function updateStatus(next) {
        const previous = status;
        status = next;
        if (next.state === 'disconnected' && previous.state !== 'disconnected') {
            lastHash = null; lastBaseHash = null;
        }
        if (next.state === 'disconnected' && settings.enabled && context().chatId && !outageNotified) {
            outageNotified = true;
            if (settings.show_notifications) toastr.warning('EchoGraph 后端未连接', 'EchoGraph');
        } else if (outageNotified && next.state !== 'disconnected') {
            outageNotified = false;
            if (settings.show_notifications) toastr.success('EchoGraph 已重新连接', 'EchoGraph');
        }
        if (next.state === 'inconsistent') {
            const reason = next.reason || '提取失败';
            if (!inconsistentReasonsNotified.has(reason) && settings.show_notifications) {
                toastr.error(`图谱与聊天不一致：${reason}`, 'EchoGraph');
                inconsistentReasonsNotified.add(reason);
            }
        }
        renderStatus();
    }
    function scheduleRegistrationRetry() {
        if (!settings.enabled || retryTimer) return;
        retryTimer = setTimeout(() => {
            retryTimer = null;
            void register();
        }, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 30000);
    }
    function registrationFailed(error, currentEpoch) {
        if (currentEpoch !== epoch || !settings.enabled) return;
        chatUuid = null;
        updateStatus({ state: 'disconnected', reason: error.message });
        scheduleRegistrationRetry();
    }
    function scheduleSave() {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(async () => {
            if (generation) { scheduleSave(); return; }
            try { await context().saveChat(); } catch (error) { console.warn('EchoGraph save:', error); }
        }, 800);
    }
    async function chatFileExists(ctx, fileName) {
        if (!fileName) return false;
        const character = ctx.characters?.[ctx.characterId];
        const response = await fetch('/api/chats/search', {
            method: 'POST', headers: ctx.getRequestHeaders(),
            body: JSON.stringify({ query: fileName, avatar_url: ctx.groupId ? null : character?.avatar,
                group_id: ctx.groupId || null }),
        });
        if (!response.ok) throw new Error(`聊天列表 HTTP ${response.status}`);
        const chats = await response.json();
        return chats.some(item => item.file_name === fileName);
    }
    async function register() {
        if (!settings.enabled) return;
        clearTimeout(retryTimer); retryTimer = null;
        const ctx = context(), key = `${ctx.groupId || ctx.characters?.[ctx.characterId]?.avatar}:${ctx.chatId}`;
        if (!ctx.chatId || (!ctx.groupId && !ctx.characters?.[ctx.characterId])) {
            ++epoch; chatUuid = null; chatKey = null;
            void heartbeat();
            return;
        }
        const currentEpoch = ++epoch;
        chatKey = key; chatUuid = null; lastHash = null; lastBaseHash = null; lastObservedHash = null;
        try {
        const metadata = ctx.chatMetadata;
        metadata.echograph ||= {};
        if (!metadata.echograph.chat_uuid) {
            metadata.echograph.chat_uuid = ctx.uuidv4(); ctx.saveMetadataDebounced();
        }
        const proposed = metadata.echograph.chat_uuid;
        const previous = await request(`/timeline/identity/${encodeURIComponent(proposed)}`);
        const previousExists = await chatFileExists(ctx, previous.previous_file_name);
        if (currentEpoch !== epoch) return;
        const owner = String(ctx.groupId || ctx.characters[ctx.characterId].avatar);
        const registered = await post('/timeline/register',
            logic.registrationPayload(metadata, owner, ctx.chatId, previousExists));
        if (currentEpoch !== epoch || key !== chatKey) return;
        chatUuid = registered.chat_uuid;
        if (proposed !== chatUuid) {
            metadata.echograph.chat_uuid = chatUuid; ctx.saveMetadataDebounced();
        }
        await sendBase(currentEpoch);
        await reconcile(currentEpoch);
        await pollStatus();
        retryDelay = 3000;
        } catch (error) { registrationFailed(error, currentEpoch); }
    }
    const basePayload = ctx => logic.basePayload(ctx, worldInfo);
    async function sendBase(currentEpoch = epoch) {
        if (!settings.enabled || !chatUuid || currentEpoch !== epoch) return;
        const ctx = context(), payload = await basePayload(ctx);
        if (currentEpoch !== epoch) return;
        const digest = logic.hash(payload);
        if (digest === lastBaseHash) return;
        lastBaseHash = digest;
        const owner = String(ctx.groupId || ctx.characters?.[ctx.characterId]?.avatar);
        const result = await post('/timeline/base', { owner, ...payload });
        updateStatus({ state: result.status === 'building' ? 'needs_base' : 'processing', progress: result.progress });
        scheduleReconcile();
    }
    async function reconcile(currentEpoch = epoch) {
        if (!settings.enabled || generation || !chatUuid || currentEpoch !== epoch) return;
        const ctx = context();
        if (`${ctx.groupId || ctx.characters?.[ctx.characterId]?.avatar}:${ctx.chatId}` !== chatKey) return;
        if (logic.stamp(ctx.chat, () => ctx.uuidv4())) scheduleSave();
        const messages = logic.normalize(ctx.chat);
        lastObservedHash = logic.hash(ctx.chat);
        const payload = await basePayload(ctx);
        if (currentEpoch !== epoch) return;
        const books = payload.books.filter(book => ['chat', 'global', 'persona'].includes(book.source));
        const digest = logic.hash({ messages, books });
        if (digest === lastHash) return;
        lastHash = digest;
        try {
            updateStatus(await post('/timeline/sync', { chat_uuid: chatUuid, messages, books }));
        } catch (error) {
            lastHash = null;
            if (error.network) {
                updateStatus({ state: 'disconnected', reason: error.message });
                scheduleRegistrationRetry();
            } else updateStatus({ state: 'inconsistent', reason: error.message });
        }
    }
    function scheduleReconcile() {
        clearTimeout(timer);
        timer = setTimeout(() => void reconcile().catch(error => {
            updateStatus({ state: error.network ? 'disconnected' : 'inconsistent', reason: error.message });
            if (error.network) scheduleRegistrationRetry();
        }), 500);
    }
    async function pollStatus() {
        if (!chatUuid) return;
        const currentUuid = chatUuid, currentEpoch = epoch;
        try {
            const next = await request(`/timeline/status/${encodeURIComponent(currentUuid)}`);
            if (currentEpoch === epoch && currentUuid === chatUuid) updateStatus(next);
        } catch (error) {
            if (currentEpoch === epoch && currentUuid === chatUuid) {
                updateStatus({ state: error.network ? 'disconnected' : 'inconsistent', reason: error.message });
                if (error.network) scheduleRegistrationRetry();
            }
        }
    }
    if (!document.getElementById('eg-timeline-style')) {
        $('head').append(`<style id="eg-timeline-style">
            #echograph-settings-drawer .eg-drawer-header { position: relative; padding-right: 2.25rem; }
            #echograph-settings-drawer .eg-header-content { display: flex; align-items: center; gap: .6rem; min-width: 0; width: 100%; }
            #echograph-settings-drawer .eg-header-status { margin-left: auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: .85em; color: var(--SmartThemeBodyColor); }
            #echograph-settings-drawer .eg-drawer-icon { position: absolute; right: .4rem; top: 50%; transform: translateY(-50%); margin: 0; }
            #echograph-settings-drawer .eg-status-row { display: flex; align-items: center; gap: .5rem; margin-bottom: .5rem; }
            #echograph-settings-drawer .eg-url { width: 100%; color: var(--SmartThemeBodyColor); background: var(--SmartThemeBlurTintColor); border: 1px solid var(--SmartThemeBorderColor); }
        </style>`);
    }
    $('#extensions_settings2').append(`
        <div id="echograph-settings-drawer" class="extension_container">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header eg-drawer-header">
                    <div class="eg-header-content"><b>EchoGraph</b><span id="eg-timeline-header-status" class="eg-header-status">未连接</span></div>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down eg-drawer-icon"></div>
                </div>
                <div class="inline-drawer-content">
                    <div class="eg-status-row">状态：<span id="eg-timeline-status">未连接</span>
                        <button id="eg-timeline-retry" class="menu_button" type="button">重试</button>
                    </div>
                    <label class="checkbox_label"><input id="eg-timeline-enabled" type="checkbox">启用</label>
                    <label for="eg-timeline-url">后端地址</label>
                    <input id="eg-timeline-url" class="text_pole eg-url" type="url">
                    <label class="checkbox_label"><input id="eg-timeline-notifications" type="checkbox">通知</label>
                </div>
            </div>
        </div>`);
    $('#eg-timeline-enabled').prop('checked', settings.enabled).on('change', () => {
        settings.enabled = $('#eg-timeline-enabled').prop('checked');
        context().saveSettingsDebounced();
        if (settings.enabled) void register();
        else {
            ++epoch; clearTimeout(retryTimer); retryTimer = null;
            chatUuid = null; outageNotified = false;
            updateStatus({ state: 'disconnected' });
        }
    });
    $('#eg-timeline-url').val(settings.api_base_url).on('change', () => {
        settings.api_base_url = String($('#eg-timeline-url').val()).trim().replace(/\/$/, '');
        context().saveSettingsDebounced();
        retryDelay = 3000;
        void register();
    });
    $('#eg-timeline-notifications').prop('checked', settings.show_notifications).on('change', () => {
        settings.show_notifications = $('#eg-timeline-notifications').prop('checked');
        context().saveSettingsDebounced();
    });
    $('#eg-timeline-retry').on('click', async () => {
        if (!chatUuid) { void register(); return; }
        try {
            if (status.state === 'needs_base') { lastBaseHash = null; await sendBase(); }
            else updateStatus(await post(`/timeline/retry/${encodeURIComponent(chatUuid)}`, {}));
        } catch (error) {
            updateStatus({ state: error.network ? 'disconnected' : 'inconsistent', reason: error.message });
            if (error.network) scheduleRegistrationRetry();
        }
    });
    renderStatus();
    const { eventSource, eventTypes } = context();
    eventSource.on(eventTypes.CHAT_CHANGED, () => void register());
    eventSource.on(eventTypes.CHAT_RENAMED, () => void register());
    for (const name of ['MESSAGE_SENT', 'MESSAGE_RECEIVED', 'MESSAGE_SWIPED', 'MESSAGE_EDITED',
        'MESSAGE_UPDATED', 'MESSAGE_DELETED', 'MESSAGE_SWIPE_DELETED', 'GENERATION_ENDED']) {
        if (eventTypes[name]) eventSource.on(eventTypes[name], scheduleReconcile);
    }
    for (const name of ['CHARACTER_EDITED', 'WORLDINFO_UPDATED', 'WORLDINFO_SETTINGS_UPDATED']) {
        if (eventTypes[name]) eventSource.on(eventTypes[name], () => void sendBase().catch(console.error));
    }
    eventSource.on(eventTypes.GENERATION_STARTED, (_type, _options, dryRun) => {
        if (!dryRun) { generation = true; generationType = _type; }
    });
    for (const name of ['GENERATION_ENDED', 'GENERATION_STOPPED']) {
        eventSource.on(eventTypes[name], () => { generation = false; generationType = null; scheduleReconcile(); });
    }
    eventSource.on(eventTypes.CHAT_COMPLETION_PROMPT_READY, async prompt => {
        if (prompt?.dryRun || !Array.isArray(prompt?.chat)) return;
        scheduleReconcile();
        if (!chatUuid || !settings.enabled || !generationType ||
            ['quiet', 'impersonate'].includes(generationType) ||
            prompt.chat.some(item => item?.content?.startsWith('[EchoGraph]\n'))) return;
        const promptChatUuid = chatUuid;
        try {
            const result = await request(`/timeline/prompt/${encodeURIComponent(promptChatUuid)}`, {}, 2500);
            if (chatUuid === promptChatUuid && result.content)
                prompt.chat.push({ role: 'system', content: `[EchoGraph]\n${result.content}` });
        } catch (error) { console.warn('EchoGraph prompt:', error); }
    });
    setInterval(() => {
        if (!settings.enabled || document.hidden || generation || !chatUuid) return;
        const ctx = context();
        const digest = logic.hash(ctx.chat);
        if (digest !== lastObservedHash) scheduleReconcile();
    }, 3000);
    setInterval(() => { if (settings.enabled && chatUuid) void pollStatus(); }, 3000);
    setInterval(() => { if (settings.enabled) void heartbeat(); }, 10000);
    if (settings.enabled) void heartbeat();
    if (context().chatId) void register();
});
