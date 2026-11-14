const test = require('node:test');
const assert = require('node:assert/strict');
const { stamp, normalize, hash, registrationPayload, basePayload } = require('./timeline_logic.js');

test('group base payload includes every member and character book in avatar order', async () => {
    const alice = { avatar: 'a.png', data: { name: 'Alice', description: 'Scout',
        extensions: { world: 'Alice main' }, character_book: { entries: [{ content: 'Alice embedded' }] } } };
    const bob = { avatar: 'b.png', data: { name: 'Bob', description: 'Healer',
        extensions: { world: 'Bob main' }, character_book: { entries: [{ content: 'Bob embedded' }] } } };
    const ctx = { groupId: 'group-1', groups: [{ id: 'group-1', members: ['b.png', 'a.png'] }],
        characters: [bob, alice], chatMetadata: { world_info: 'Chat' },
        loadWorldInfo: async name => ({ entries: [{ content: name }] }) };
    const world = { world_info: { charLore: [
        { name: 'a', extraBooks: ['Alice extra'] }, { name: 'b', extraBooks: ['Bob extra'] },
    ] }, selected_world_info: ['Global'] };
    const payload = await basePayload(ctx, world);
    assert.equal('card' in payload, false);
    assert.deepEqual(payload.cards.map(card => card.name), ['Alice', 'Bob']);
    assert.deepEqual(payload.books.map(book => book.source), [
        'character', 'character_extra', 'character', 'character_extra',
        'chat', 'global', 'embedded', 'embedded',
    ]);
    assert.deepEqual(payload.books.filter(book => book.source === 'embedded')
        .map(book => book.entries[0].content), ['Alice embedded', 'Bob embedded']);
    const reversed = { ...ctx, groups: [{ id: 'group-1', members: ['a.png', 'b.png'] }] };
    assert.equal(hash(await basePayload(reversed, world)), hash(payload));
    bob.data.description = 'Changed';
    assert.notEqual(hash(await basePayload(ctx, world)), hash(payload));
    bob.data.description = 'Healer';
    bob.data.extensions.world = 'Changed book';
    assert.notEqual(hash(await basePayload(ctx, world)), hash(payload));
    bob.data.extensions.world = 'Bob main';
    alice.data.character_book.entries[0].content = 'Changed embedded';
    assert.notEqual(hash(await basePayload(ctx, world)), hash(payload));
});

test('single base payload keeps legacy card shape and hash', async () => {
    const character = { avatar: 'a.png', data: { name: 'Alice', description: 'Scout' } };
    const ctx = { characterId: 0, characters: [character], chatMetadata: {},
        loadWorldInfo: async () => null };
    const payload = await basePayload(ctx, { world_info: {} });
    assert.deepEqual(payload, { card: { name: 'Alice', description: 'Scout',
        personality: '', scenario: '', mes_example: '' }, books: [] });
    assert.equal(hash(payload), hash({ card: payload.card, books: [] }));
});

let next = 0;
const id = () => `id-${++next}`;
const greeting = () => ({ mes: '开局 A', is_user: false, extra: {}, swipe_id: 0,
    swipe_info: [{ extra: {}, send_date: 1 }, { extra: {}, send_date: 2 }] });

test('greeting swipes retain one message id and distinct version ids across extra swap', () => {
    const message = greeting();
    assert.equal(stamp([message], id), true);
    const [a, b] = message.swipe_info.map(s => s.extra);
    assert.equal(a.eg_msg_id, b.eg_msg_id);
    assert.notEqual(a.eg_version_id, b.eg_version_id);
    message.swipe_id = 1; message.extra = { ...b }; message.mes = '开局 B';
    stamp([message], id);
    assert.equal(normalize([message])[0].version_id, b.eg_version_id);
    message.swipe_id = 0; message.extra = { ...a }; message.mes = '开局 A';
    stamp([message], id);
    assert.equal(normalize([message])[0].version_id, a.eg_version_id);
});

test('editing changes normalized hash but keeps ids', () => {
    const message = greeting(); stamp([message], id);
    const before = normalize([message]);
    message.mes = '改过的开局';
    const after = normalize([message]);
    assert.equal(before[0].version_id, after[0].version_id);
    assert.notEqual(hash(before), hash(after));
});

test('hide, unhide, narrator, comment, tool call and system notice', () => {
    const normal = { mes: '你好', is_user: true, extra: {} };
    const narrator = { mes: '旁白', is_system: false, extra: { type: 'narrator' } };
    const comment = { mes: '注释', is_system: true, extra: { type: 'comment' } };
    const tool = { mes: '工具', is_system: true, extra: { tool_invocations: [{}] } };
    const notice = { mes: '通知', name: 'SillyTavern System', force_avatar: 'img/five.png',
        is_system: true, extra: { type: 'generic', swipeable: false } };
    const chat = [normal, narrator, comment, tool, notice];
    stamp(chat, id);
    assert.deepEqual(normalize(chat).map(x => x.included), [true, true, false, false, false]);
    normal.is_system = true; stamp(chat, id);
    assert.equal(normal.extra.eg_hidden, true);
    assert.equal(normalize(chat)[0].included, false);
    normal.is_system = false; stamp(chat, id);
    assert.equal('eg_hidden' in normal.extra, false);
    assert.equal(notice.extra.eg_hidden, undefined);
});

test('active extra classifies edits before swipe_info is refreshed', () => {
    const message = greeting();
    stamp([message], id);
    message.extra.type = 'narrator';
    message.extra.display_text = 'fresh text';
    message.swipe_info[0].extra.type = 'comment';
    assert.equal(normalize([message])[0].role, 'narrator');
    assert.equal(normalize([message])[0].included, true);
    message.extra.type = 'comment';
    message.swipe_info[0].extra.type = 'narrator';
    assert.equal(normalize([message])[0].included, false);
    delete message.extra.type;
    message.extra.tool_invocations = [{ name: 'tool' }];
    delete message.swipe_info[0].extra.type;
    assert.equal(normalize([message])[0].included, false);
    delete message.extra.tool_invocations;
    message.extra.type = 'generic';
    assert.equal(normalize([message])[0].included, false);
    assert.equal(message.extra.eg_version_id, message.swipe_info[0].extra.eg_version_id);
    message.extra.eg_version_id = 'fresh-active-version';
    stamp([message], id);
    assert.equal(message.swipe_info[0].extra.eg_version_id, 'fresh-active-version');
});

test('copied messages are restamped, copied chat identity stays available for backend', () => {
    const original = greeting(); stamp([original], id);
    const copy = structuredClone(original);
    stamp([original, copy], id);
    assert.notEqual(original.extra.eg_msg_id, copy.extra.eg_msg_id);
    assert.notEqual(original.swipe_info[0].extra.eg_version_id,
        copy.swipe_info[0].extra.eg_version_id);
    const parent = { echograph: { chat_uuid: 'parent' }, integrity: 'i1', file_name: 'main' };
    const branch = { ...structuredClone(parent), integrity: 'i2', file_name: 'branch' };
    const rename = { ...structuredClone(parent), file_name: 'renamed' };
    assert.equal(branch.echograph.chat_uuid, parent.echograph.chat_uuid);
    assert.notEqual(branch.integrity, parent.integrity);
    assert.equal(rename.integrity, parent.integrity);
    assert.deepEqual(registrationPayload(branch, 'group-1', branch.file_name, true), {
        chat_uuid: 'parent', integrity: 'i2', owner: 'group-1',
        file_name: 'branch', previous_file_exists: true });
    assert.equal(registrationPayload(rename, 'avatar.png', rename.file_name, false).previous_file_exists, false);
});
