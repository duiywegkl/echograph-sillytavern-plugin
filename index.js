/**
 * EchoGraph RAG Enhancer Plugin for SillyTavern
 * Enhanced with UI integration, configuration management, and debugging capabilities
 * Based on analysis of st-memory-enhancement architecture
 */

// 兼容性导入：优先使用全局对象，避免在不同SillyTavern版本/路径下模块导入失败导致插件整体无法加载
const ST = (typeof window !== 'undefined' ? window : globalThis);
const APP = ST.SillyTavern || ST.APP || {};
// Robust event bus/type getters to adapt to different SillyTavern builds
function getEventBus() {
    // 优先尝试各种可能的事件源，包括SillyTavern的内部事件系统
    if (ST.eventSource && typeof ST.eventSource.on === 'function') return ST.eventSource;
    if (ST.SillyTavern?.eventSource && typeof ST.SillyTavern.eventSource.on === 'function') return ST.SillyTavern.eventSource;
    if (APP?.eventSource && typeof APP.eventSource.on === 'function') return APP.eventSource;
    // 尝试全局的eventSource
    if (typeof window !== 'undefined' && window.eventSource && typeof window.eventSource.on === 'function') return window.eventSource;
    // 最后回退到jQuery作为事件总线（SillyTavern经常使用jQuery事件）
    return (typeof jQuery !== 'undefined' ? jQuery(document) : null);
}
function getEventTypes() {
    return ST.event_types || APP?.event_types || ST.SillyTavern?.event_types || {};
}
const event_types = getEventTypes();
const saveSettingsDebounced = ST?.saveSettingsDebounced || (() => {});
const getRequestHeaders = ST?.getRequestHeaders || (() => ({}));
const extension_settings = ST?.extension_settings || {};
const getContext = ST?.getContext || (() => ({}));
const renderExtensionTemplateAsync = ST?.renderExtensionTemplateAsync || (async () => '');
const callGenericPopup = ST?.callGenericPopup || (() => {});
const POPUP_TYPE = ST?.POPUP_TYPE || {};
const power_user = ST?.power_user || {};

// 插件主逻辑包装在jQuery ready函数中，这是SillyTavern插件的标准做法
jQuery(async () => {
    console.log("______________________EchoGraph插件：开始加载______________________");

    // --- Plugin Configuration ---
    const PLUGIN_NAME = 'EchoGraph';
    const PLUGIN_VERSION = '1.0.0';
    const DEFAULT_API_BASE_URL = 'http://127.0.0.1:9543';

    // --- Extension Settings Key ---
    const SETTINGS_KEY = 'echograph_settings';

    // --- Default Settings ---
    const DEFAULT_SETTINGS = {
        enabled: true,
        api_base_url: DEFAULT_API_BASE_URL,
        auto_initialize: true,
        show_notifications: true,
        debug_mode: false,
        max_context_length: 4000,
        sliding_window: {
            window_size: 4,
            processing_delay: 1,
            enable_enhanced_agent: true,
            enable_conflict_resolution: true
        },
        memory_enhancement: {
            hot_memory_turns: 5,
            enable_world_book_integration: true,
            enable_character_card_enhancement: true
        }
    };

    // --- Session State ---
    let currentSessionId = null;
    let isInitializing = false;
    let lastCharacterId = null;
    let pluginSettings = null;
    let initializationPromise = null; // 用于防止重复初始化
    let webSocket = null; // WebSocket 连接实例

    let lastHealthOk = false; // 最近一次/当前健康检查是否成功，用于抑制在本地模式下的WS自动连接


	    // 删除不再需要的事件绑定状态变量，因为使用了直接绑定方式

    /**
     * WebSocket Connection Management
     */
    function connectWebSocket(sessionId) {
        const encodedId = encodeURIComponent(sessionId || '');
        const wsUrl = `${pluginSettings.api_base_url.replace(/^http/, 'ws')}/ws/tavern/${encodedId}`;

        // If there's an existing socket, avoid duplicate connects and close mismatched targets
        if (webSocket) {
            const sameTarget = typeof webSocket.url === 'string' && webSocket.url.includes(encodedId);
            if (webSocket.readyState === WebSocket.OPEN) {
                if (sameTarget) {
                    logDebug(`[WS] WebSocket already connected for session ${sessionId}`);
                    return;
                }
                logDebug(`[WS] Closing open WebSocket to switch target...`);
                try { webSocket.close(1000, 'Switching session'); } catch (e) {}
            } else if (webSocket.readyState === WebSocket.CONNECTING) {
                if (sameTarget) {
                    logDebug(`[WS] Already connecting to target ${wsUrl}, skipping duplicate connect`);
                    return;
                }
                logDebug(`[WS] Closing connecting WebSocket to switch target...`);
                try { webSocket.close(1001, 'Switching during connect'); } catch (e) {}
            } else if (webSocket.readyState === WebSocket.CLOSING) {
                logDebug(`[WS] Previous socket is closing; proceeding to open new to ${wsUrl}`);
            }
        }

        logDebug(`[WS] Connecting to ${wsUrl}`);
        console.log(`[EchoGraph WS] Connecting to ${wsUrl}`);

        webSocket = new WebSocket(wsUrl);
        const thisSocket = webSocket;

        thisSocket.onopen = () => {
            if (webSocket !== thisSocket) return; // ignore stale
            logDebug(`[WS] WebSocket connection established for session ${sessionId}`);
            console.log(`[EchoGraph WS] WebSocket connection established for session ${sessionId}`);
            showNotification('EchoGraph 已连接', 'success');
            updatePanelStatus('已连接', 'connected');
        };

        thisSocket.onmessage = (event) => {
            if (webSocket !== thisSocket) return; // ignore stale
            try {
                const data = JSON.parse(event.data);
                logDebug('[WS] Received message from backend:', data);

                // Handle WS RPC responses first
                if (data.type === 'response' && data.request_id) {
                    const entry = pendingRequests.get(data.request_id);
                    if (entry) {
                        clearTimeout(entry.timer);
                        pendingRequests.delete(data.request_id);
                        if (data.ok) entry.resolve(data.data);
                        else entry.reject(new Error(data.error?.message || 'WS error'));
                    }
                    return;
                }

                // Server push events
                if (data.type === 'initialization_complete') {
                    addActivityLog(`知识图谱初始化完成 (节点: ${data.stats?.nodes_added || 0})`, 'success');
                    refreshPanelStats();
                } else if (data.type === 'graph_updated') {
                    if (data.source === 'manual_edit') {
                        const actions = {
                            node_created: '新增节点',
                            node_updated: '编辑节点',
                            node_deleted: '删除节点',
                            relationship_created: '新增关系',
                            relationship_updated: '编辑关系',
                            relationship_deleted: '删除关系'
                        };
                        const label = actions[data.action];
                        const target = String(data.target || '').replace('->', ' → ');
                        addActivityLog(label ? `手动编辑：${label} ${target}` :
                            `知识图谱已更新 (总节点: ${data.total_nodes})`, 'info');
                    } else {
                        addActivityLog(`知识图谱已更新 (总节点: ${data.total_nodes})`, 'info');
                    }
                    refreshPanelStats();
                } else if (data.type === 'connection_established') {
                    // no-op
                } else if (data.type === 'request_character_submission') {
                    // 服务器请求提交当前角色数据
                    logDebug('[WS] Received character submission request from backend');
                    addActivityLog('收到角色数据提交请求', 'info');

                    // 自动提交当前角色数据
                    setTimeout(async () => {
                        try {
                            logDebug('[WS] Auto-submitting current character data...');
                            const context = getSillyTavernContext();
                            const characterId = context.characterId;
                            const character = context.characters?.[characterId];

                            if (character) {
                                logDebug(`[WS] Submitting character: ${character.name} (ID: ${characterId})`);
                                const submitSuccess = await submitCharacterDataToBackend(characterId, character);
                                if (submitSuccess) {
                                    addActivityLog(`已自动提交角色数据: ${character.name}`, 'success');
                                } else {
                                    addActivityLog(`角色数据提交失败: ${character.name}`, 'error');
                                }
                            } else {
                                logDebug('[WS] No character found to submit');
                                addActivityLog('未找到当前角色，无法提交数据', 'warning');
                            }
                        } catch (error) {
                            logDebug('[WS] Error during auto character submission:', error);
                            addActivityLog(`自动提交角色数据失败: ${error.message}`, 'error');
                        }
                    }, 100); // 短延迟确保上下文获取正确
                } else if (data.type === 'auto_reinitialization_complete') {
                    // 自动重新初始化完成通知
                    addActivityLog(`知识图谱重新初始化完成: ${data.character_name || '未知角色'}`, 'success');
                    refreshPanelStats();
                } else if (data.type === 'auto_reinitialization_failed') {
                    // 自动重新初始化失败通知
                    addActivityLog(`知识图谱重新初始化失败: ${data.error || '未知错误'}`, 'error');
                } else {
                    addActivityLog(`收到未知消息: ${data.type}`, 'info');
                }
            } catch (error) {
                console.error('[WS] Error processing message:', error);
            }
        };

        thisSocket.onclose = () => {
            if (webSocket !== thisSocket) return; // ignore stale close
            logDebug(`[WS] WebSocket connection closed.`);
            console.log('[EchoGraph WS] WebSocket connection closed.');
            showNotification('EchoGraph 已断开', 'warning');
            updatePanelStatus('未连接', 'disconnected');
            // reject all pending requests
            try {
                pendingRequests.forEach(({ reject, timer }, id) => {
                    clearTimeout(timer);
                    reject(new Error('WebSocket closed'));
                });
            } finally {
                pendingRequests.clear();
            }
            webSocket = null;
        };

        thisSocket.onerror = (error) => {
            if (webSocket !== thisSocket) return; // ignore stale error
            console.error('[WS] WebSocket error:', error);
            showNotification('EchoGraph 连接错误', 'error');
            updatePanelStatus('错误', 'disconnected');
            webSocket = null;
        };
    }

    function disconnectWebSocket() {
        if (webSocket) {
            logDebug('[WS] Manually disconnecting WebSocket.');
            webSocket.close();
            webSocket = null;
        }
    }
    // --- WS RPC helpers ---
    const pendingRequests = new Map();
    function genRequestId() { return `${Date.now()}-${Math.random().toString(36).slice(2,8)}`; }
    function isWsOpen() { return webSocket && webSocket.readyState === WebSocket.OPEN; }
    function sendWsRequest(action, payload = {}, timeoutMs = 20000) {
        return new Promise((resolve, reject) => {
            const doSend = () => {
                const requestId = genRequestId();
                const timer = setTimeout(() => {
                    if (pendingRequests.has(requestId)) {
                        pendingRequests.delete(requestId);
                        reject(new Error(`WS request timeout: ${action}`));
                    }
                }, timeoutMs);
                pendingRequests.set(requestId, { resolve, reject, timer });
                try {
                    webSocket.send(JSON.stringify({ type: 'request', action, request_id: requestId, payload }));
                } catch (e) {
                    clearTimeout(timer);
                    pendingRequests.delete(requestId);
                    reject(e);
                }
            };

            // Auto-connect if possible
            if ((!webSocket || webSocket.readyState === WebSocket.CLOSED) && currentSessionId) {
                if (lastHealthOk) { try { connectWebSocket(currentSessionId); } catch (e) {} }
            }

            if (isWsOpen()) {
                return doSend();
            }
            // If the socket is connecting, wait for it to open
            if (webSocket && webSocket.readyState === WebSocket.CONNECTING) {
                console.log('[EchoGraph WS] Waiting for WebSocket to open before sending request:', action);
                const start = Date.now();
                const maxWait = Math.min(timeoutMs - 1000, 10000);
                const waitForOpen = () => {
                    if (isWsOpen()) return doSend();
                    if (Date.now() - start > maxWait) {
                        return reject(new Error('WebSocket not connected'));
                    }
                    setTimeout(waitForOpen, 100);
                };
                return waitForOpen();
            }

            // As a last attempt, try to connect if we have a session id
            if (currentSessionId) {
                if (lastHealthOk) { try { connectWebSocket(currentSessionId); } catch (e) {} }
                // brief delay then attempt to wait again
                const start = Date.now();
                const maxWait = Math.min(timeoutMs - 1000, 8000);
                const waitForOpen2 = () => {
                    if (isWsOpen()) return doSend();
                    if (Date.now() - start > maxWait) {
                        return reject(new Error('WebSocket not connected'));
                    }
                    setTimeout(waitForOpen2, 100);
                };
                return waitForOpen2();
            }

            return reject(new Error('WebSocket not connected'));
        });
    }



    // --- Minimal MD5 implementation (UTF-8) to match Python hashlib.md5()[:8] ---
    // Public-domain style adaptation based on common JS MD5 references
    function md5Hex(input) {
        function toUtf8(str) {
            return unescape(encodeURIComponent(str));
        }
        function rhex(n) {
            var s = '', j;
            for (j = 0; j < 4; j++)
                s += ('0' + ((n >> (j * 8 + 4)) & 0x0F).toString(16)).slice(-2) +
                     ((n >> (j * 8)) & 0x0F).toString(16);
            return s;
        }
        function add32(a, b) { return (a + b) & 0xFFFFFFFF; }
        function cmn(q, a, b, x, s, t) { a = add32(add32(a, q), add32(x, t)); return add32((a << s) | (a >>> (32 - s)), b); }
        function ff(a, b, c, d, x, s, t) { return cmn((b & c) | ((~b) & d), a, b, x, s, t); }
        function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & (~d)), a, b, x, s, t); }
        function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
        function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | (~d)), a, b, x, s, t); }
        function md5blk(s) {
            var md5blks = new Array(16);
            for (var i = 0; i < 64; i += 4) {
                md5blks[i >> 2] = s.charCodeAt(i) + (s.charCodeAt(i + 1) << 8) + (s.charCodeAt(i + 2) << 16) + (s.charCodeAt(i + 3) << 24);
            }
            return md5blks;
        }
        function md51(s) {
            var n = s.length,
                state = [1732584193, -271733879, -1732584194, 271733878],
                i;
            var tail;
            for (i = 64; i <= n; i += 64) {
                md5cycle(state, md5blk(s.substring(i - 64, i)));
            }
            s = s.substring(i - 64);
            tail = new Array(16).fill(0);
            for (i = 0; i < s.length; i++) tail[i >> 2] |= s.charCodeAt(i) << ((i % 4) << 3);
            tail[i >> 2] |= 0x80 << ((i % 4) << 3);
            if (i > 55) { md5cycle(state, tail); tail = new Array(16).fill(0); }
            tail[14] = n * 8;
            md5cycle(state, tail);
            return state;
        }
        function md5cycle(x, k) {
            var a = x[0], b = x[1], c = x[2], d = x[3];

            a = ff(a, b, c, d, k[0], 7, -680876936);
            d = ff(d, a, b, c, k[1], 12, -389564586);
            c = ff(c, d, a, b, k[2], 17, 606105819);
            b = ff(b, c, d, a, k[3], 22, -1044525330);
            a = ff(a, b, c, d, k[4], 7, -176418897);
            d = ff(d, a, b, c, k[5], 12, 1200080426);
            c = ff(c, d, a, b, k[6], 17, -1473231341);
            b = ff(b, c, d, a, k[7], 22, -45705983);
            a = ff(a, b, c, d, k[8], 7, 1770035416);
            d = ff(d, a, b, c, k[9], 12, -1958414417);
            c = ff(c, d, a, b, k[10], 17, -42063);
            b = ff(b, c, d, a, k[11], 22, -1990404162);
            a = ff(a, b, c, d, k[12], 7, 1804603682);
            d = ff(d, a, b, c, k[13], 12, -40341101);
            c = ff(c, d, a, b, k[14], 17, -1502002290);
            b = ff(b, c, d, a, k[15], 22, 1236535329);

            a = gg(a, b, c, d, k[1], 5, -165796510);
            d = gg(d, a, b, c, k[6], 9, -1069501632);
            c = gg(c, d, a, b, k[11], 14, 643717713);
            b = gg(b, c, d, a, k[0], 20, -373897302);
            a = gg(a, b, c, d, k[5], 5, -701558691);
            d = gg(d, a, b, c, k[10], 9, 38016083);
            c = gg(c, d, a, b, k[15], 14, -660478335);
            b = gg(b, c, d, a, k[4], 20, -405537848);
            a = gg(a, b, c, d, k[9], 5, 568446438);
            d = gg(d, a, b, c, k[14], 9, -1019803690);
            c = gg(c, d, a, b, k[3], 14, -187363961);
            b = gg(b, c, d, a, k[8], 20, 1163531501);
            a = gg(a, b, c, d, k[13], 5, -1444681467);
            d = gg(d, a, b, c, k[2], 9, -51403784);
            c = gg(c, d, a, b, k[7], 14, 1735328473);
            b = gg(b, c, d, a, k[12], 20, -1926607734);

            a = hh(a, b, c, d, k[5], 4, -378558);
            d = hh(d, a, b, c, k[8], 11, -2022574463);
            c = hh(c, d, a, b, k[11], 16, 1839030562);
            b = hh(b, c, d, a, k[14], 23, -35309556);
            a = hh(a, b, c, d, k[1], 4, -1530992060);
            d = hh(d, a, b, c, k[4], 11, 1272893353);
            c = hh(c, d, a, b, k[7], 16, -155497632);
            b = hh(b, c, d, a, k[10], 23, -1094730640);
            a = hh(a, b, c, d, k[13], 4, 681279174);
            d = hh(d, a, b, c, k[0], 11, -358537222);
            c = hh(c, d, a, b, k[3], 16, -722521979);
            b = hh(b, c, d, a, k[6], 23, 76029189);
            a = hh(a, b, c, d, k[9], 4, -640364487);
            d = hh(d, a, b, c, k[12], 11, -421815835);
            c = hh(c, d, a, b, k[15], 16, 530742520);
            b = hh(b, c, d, a, k[2], 23, -995338651);

            a = ii(a, b, c, d, k[0], 6, -198630844);
            d = ii(d, a, b, c, k[7], 10, 1126891415);
            c = ii(c, d, a, b, k[14], 15, -1416354905);
            b = ii(b, c, d, a, k[5], 21, -57434055);
            a = ii(a, b, c, d, k[12], 6, 1700485571);
            d = ii(d, a, b, c, k[3], 10, -1894986606);
            c = ii(c, d, a, b, k[10], 15, -1051523);
            b = ii(b, c, d, a, k[1], 21, -2054922799);
            a = ii(a, b, c, d, k[8], 6, 1873313359);
            d = ii(d, a, b, c, k[15], 10, -30611744);
            c = ii(c, d, a, b, k[6], 15, -1560198380);
            b = ii(b, c, d, a, k[13], 21, 1309151649);
            a = ii(a, b, c, d, k[4], 6, -145523070);
            d = ii(d, a, b, c, k[11], 10, -1120210379);
            c = ii(c, d, a, b, k[2], 15, 718787259);
            b = ii(b, c, d, a, k[9], 21, -343485551);

            x[0] = add32(a, x[0]);
            x[1] = add32(b, x[1]);
            x[2] = add32(c, x[2]);
            x[3] = add32(d, x[3]);
        }
        var utf = toUtf8(input);
        var state = md51(utf);
        return rhex(state[0]) + rhex(state[1]) + rhex(state[2]) + rhex(state[3]);
    }

    /**
     * Generate a consistent session ID based on character name
     * This matches the logic in tavern_connector.py to ensure UI and plugin use same session ID
     */
    function generateConsistentSessionId(characterName) {
        const digest = md5Hex(String(characterName || ''));
        const characterHash = digest.slice(0, 8);
        return `tavern_${characterName}_${characterHash}`;
    }

	    /**
	     * Ensure WS connection exists for a given character by precomputing its session id
	     */
	    function ensureWsForCharacter(characterName, options = {}) {
	        const force = options.force === true;
	        if (!characterName) return null;
        if (!force && !lastHealthOk) return null;
	        const prelimSessionId = generateConsistentSessionId(characterName);
	        if (!isWsOpen() || !webSocket.url.includes(prelimSessionId)) {
	            connectWebSocket(prelimSessionId);
	        }
	        return prelimSessionId;
	    }


    // --- UI Elements ---
    let settingsModal = null;
    let debugPanel = null;
    let memoryViewer = null;

    // --- Utility Functions ---
    function loadSettings() {
        // 使用标准的SillyTavern扩展设置系统
        pluginSettings = Object.assign({}, DEFAULT_SETTINGS, extension_settings[SETTINGS_KEY] || {});
        return pluginSettings;
    }

    function saveSettings() {
        // 使用SillyTavern标准的设置保存方式
        extension_settings[SETTINGS_KEY] = pluginSettings;
        saveSettingsDebounced();
    }

    function truncateValue(val, maxLen = 200) {
        try {
            if (val == null) return String(val);
            if (typeof val === 'string') return val.length > maxLen ? val.slice(0, maxLen) + '…' : val;
            const text = JSON.stringify(val);
            return text.length > maxLen ? text.slice(0, maxLen) + '…' : text;
        } catch (e) { return String(val).slice(0, maxLen) + '…'; }
    }
    function logDebug(message, ...args) {
        if (pluginSettings?.debug_mode) {
            const truncated = args.map(a => truncateValue(a, 400));
            console.log(`[${PLUGIN_NAME} Debug]`, truncateValue(message, 200), ...truncated, '（详细见服务器日志 logs/api_server_YYYY-MM-DD.log / logs/llm_YYYY-MM-DD.log）');
        }
    }

    function showNotification(message, type = 'info') {
        if (pluginSettings?.show_notifications) {
            toastr[type](message, PLUGIN_NAME);
        }
    }

    /**
     * Get SillyTavern context information using standard methods with enhanced character detection
     */
    function getSillyTavernContext() {
        try {
            console.log("🔍 [EchoGraph] ========== 开始获取SillyTavern上下文 ==========");

            // 优先使用 APP.getContext，其次是 SillyTavern.getContext，最后回退到全局 getContext
            let context = null;

            // 方法1: 使用 APP.getContext()（参考 st-memory-enhancement 的做法）
            if (APP && typeof APP.getContext === 'function') {
                context = APP.getContext();
                console.log('✅ [EchoGraph] 角色上下文来源: APP.getContext()', {
                    success: true,
                    hasContext: !!context
                });
            }
            // 方法2: 使用 SillyTavern.getContext()
            else if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) {
                context = SillyTavern.getContext();
                console.log('✅ [EchoGraph] 角色上下文来源: SillyTavern.getContext()', {
                    success: true,
                    hasContext: !!context
                });
            }
            // 方法3: 回退到全局 getContext（老版本兼容）
            else if (typeof getContext !== 'undefined') {
                context = getContext();
                console.log('✅ [EchoGraph] 角色上下文来源: 全局getContext()', {
                    success: true,
                    hasContext: !!context
                });
            }

            if (!context) {
                console.error('❌ [EchoGraph] 无法获取SillyTavern上下文');
                return {
                    characterId: null,
                    characters: {},
                    chat: [],
                    worldInfoData: null,
                    extensionSettings: extension_settings || {}
                };
            }

            // 多种方式获取当前角色ID，参考最新文档
            let characterId = null;

            // 方法1: 从context.characterId获取（标准方式）
            // 修复：0是有效的characterId，不应该被排除
            if (context.characterId !== undefined && context.characterId !== null && context.characterId !== -1 && context.characterId !== '') {
                characterId = context.characterId;
                console.log('✅ [EchoGraph] 角色ID来源: context.characterId', characterId);
            }
            // 方法2: 从全局变量this_chid获取（备用方式）
            // 修复：0是有效的this_chid，不应该被排除
            else if (typeof this_chid !== 'undefined' && this_chid !== null && this_chid !== -1 && this_chid !== '') {
                characterId = this_chid;
                console.log('✅ [EchoGraph] 角色ID来源: 全局this_chid', characterId);
            }

            // 获取角色数据，支持多种数据结构
            let characters = {};
            if (context.characters && typeof context.characters === 'object') {
                characters = context.characters;
            }

            // 获取世界书数据
            let worldInfoData = null;
            if (context.worldInfoData) {
                worldInfoData = context.worldInfoData;
            } else if (context.world_info_data) {
                worldInfoData = context.world_info_data;
            }

            // 详细日志记录
            console.log('📊 [EchoGraph] 上下文信息详细分析', {
                characterId: characterId,
                characterIdType: typeof characterId,
                hasValidCharacterId: characterId !== null && characterId !== undefined && characterId !== -1 && characterId !== '',
                hasCharacters: !!characters,
                charactersType: typeof characters,
                characterCount: Object.keys(characters || {}).length,
                characterKeys: Object.keys(characters || {}),
                hasChat: !!context.chat,
                chatLength: context.chat ? context.chat.length : 0,
                hasWorldInfo: !!worldInfoData,
                worldInfoType: typeof worldInfoData,
                worldInfoEntries: worldInfoData?.entries?.length || 0,
                contextKeys: Object.keys(context || {}),
                isGroupChat: !!context.groupId,
                groupId: context.groupId
            });

            // 检查是否在群聊模式（群聊时characterId会是undefined）
            if (context.groupId !== undefined && context.groupId !== null) {
                console.warn('⚠️ [EchoGraph] 检测到群聊模式，角色ID可能无效', {
                    groupId: context.groupId,
                    characterId: characterId
                });
            }

            // 如果有有效角色ID，记录角色详细信息
            // 修复：0是有效的characterId，不应该被排除
            if (characterId !== null && characterId !== undefined && characterId !== -1 && characterId !== '') {
                const character = characters[characterId];
                if (character) {
                    console.log('🎭 [EchoGraph] 当前角色详细信息', {
                        id: characterId,
                        name: character.name || 'Unknown',
                        hasDescription: !!character.description,
                        descriptionLength: character.description?.length || 0,
                        hasPersonality: !!character.personality,
                        personalityLength: character.personality?.length || 0,
                        hasScenario: !!character.scenario,
                        scenarioLength: character.scenario?.length || 0,
                        hasFirstMessage: !!character.first_mes,
                        firstMessageLength: character.first_mes?.length || 0,
                        hasExampleDialogue: !!character.mes_example,
                        exampleDialogueLength: character.mes_example?.length || 0,
                        hasAvatar: !!character.avatar,
                        hasData: !!character.data,
                        characterKeys: Object.keys(character),
                        dataKeys: character.data ? Object.keys(character.data) : []
                    });

                    // 显示角色描述预览
                    if (character.description) {
                        console.log('📝 [EchoGraph] 角色描述预览:', character.description.substring(0, 200) + (character.description.length > 200 ? '...' : ''));
                    }
                    if (character.personality) {
                        console.log('🧠 [EchoGraph] 角色个性预览:', character.personality.substring(0, 200) + (character.personality.length > 200) ? '...' : '');
                    }
                    if (character.scenario) {
                        console.log('🎬 [EchoGraph] 角色场景预览:', character.scenario.substring(0, 200) + (character.scenario.length > 200 ? '...' : ''));
                    }
                } else {
                    console.warn('⚠️ [EchoGraph] 警告: 角色ID存在但无角色数据', {
                        characterId: characterId,
                        availableCharacterIds: Object.keys(characters || {}),
                        charactersType: typeof characters
                    });
                }
            } else {
                console.info('ℹ️ [EchoGraph] 当前没有选中有效角色', {
                    characterId: characterId,
                    isGroupChat: !!context.groupId,
                    availableCharacters: Object.keys(characters || {}).length,
                    availableCharacterIds: Object.keys(characters || {})
                });

                // 如果没有角色但有角色列表，显示可用角色
                if (Object.keys(characters || {}).length > 0) {
                    console.log('📋 [EchoGraph] 可用角色列表:');
                    Object.entries(characters).forEach(([id, char]) => {
                        console.log(`  - ID: ${id}, 名称: ${char.name || 'Unknown'}`);
                    });
                }
            }

            console.log("✅ [EchoGraph] ========== 上下文获取完成 ==========");

            return {
                characterId: characterId,
                characters: characters,
                chat: context.chat || [],
                worldInfoData: worldInfoData,
                groupId: context.groupId,
                extensionSettings: extension_settings || {},
                ...context
            };
        } catch (error) {
            console.error(`❌ [EchoGraph] Error getting context:`, error);
            console.error('💥 [EchoGraph] 获取上下文失败', {
                error: error.message,
                stack: error.stack
            });
            return {
                characterId: null,
                characters: {},
                chat: [],
                worldInfoData: null,
                extensionSettings: extension_settings || {}
            };
        }
    }

    /**
     * Submit character data to the backend for use by initialization process
     */
    async function submitCharacterDataToBackend(characterId, character) {
        try {
            console.log('🎭 [EchoGraph] ========== 开始提交角色数据到后台 ==========');
            console.log('🎭 [EchoGraph] 提交参数:', {
                characterId: characterId,
                characterName: character.name || 'Unknown',
                hasData: !!character
            });

            // 获取上下文，包含世界书信息
            const context = getSillyTavernContext();
            const worldInfo = await getEnhancedWorldInfo(context);

            // 构建完整的角色数据，包含世界书
            const characterData = {
                name: character.name || 'Unknown Character',
                description: character.description || character.data?.description || '',
                personality: character.personality || character.data?.personality || '',
                scenario: character.scenario || character.data?.scenario || '',
                first_mes: character.first_mes || character.data?.first_mes || '',
                mes_example: character.mes_example || character.data?.mes_example || '',
                avatar: character.avatar || '',
                world_info: worldInfo, // 🔥 关键修复：包含世界书信息
                // 包含所有原始数据，以防有遗漏的字段
                raw_character: character,
                raw_data: character.data || {}
            };

            console.log('🎭 [EchoGraph] 完整角色数据:', {
                name: characterData.name,
                descriptionLength: characterData.description.length,
                personalityLength: characterData.personality.length,
                scenarioLength: characterData.scenario.length,
                firstMesLength: characterData.first_mes.length,
                exampleLength: characterData.mes_example.length,
                worldInfoLength: characterData.world_info.length, // 🔥 添加世界书长度日志
                hasAvatar: !!characterData.avatar,
                rawCharacterKeys: Object.keys(character),
                rawDataKeys: Object.keys(character.data || {})
            });

            // 记录每个重要字段的预览
            if (characterData.description) {
                console.log('📝 [EchoGraph] 描述预览:', characterData.description.substring(0, 200));
            }
            if (characterData.personality) {
                console.log('🧠 [EchoGraph] 个性预览:', characterData.personality.substring(0, 200));
            }
            if (characterData.scenario) {
                console.log('🎬 [EchoGraph] 场景预览:', characterData.scenario.substring(0, 200));
            }
            if (characterData.world_info && characterData.world_info.length > 0) {
                console.log('🌍 [EchoGraph] 世界书预览:', characterData.world_info.substring(0, 200));
            } else {
                console.log('⚠️ [EchoGraph] 世界书为空或未获取到');
            }

            // 发送到后台API
            const submitRequest = {
                character_id: characterId.toString(),
                character_name: characterData.name,
                character_data: characterData,
                timestamp: Date.now() / 1000
            };

            // 确保先建立WS连接（使用该角色的一致会话ID）
            ensureWsForCharacter(characterData.name, {force: true});

            console.log('🚀 [EchoGraph] 发送角色数据到后台(WS):', {
                action: 'tavern.submit_character',
                character_id: submitRequest.character_id,
                character_name: submitRequest.character_name,
                timestamp: submitRequest.timestamp
            });

            try {
                const result = await sendWsRequest('tavern.submit_character', submitRequest, 10000);
                console.log('✅ [EchoGraph] 角色数据提交成功:', result);
                logDebug('Character data submitted successfully', {
                    characterId: characterId,
                    characterName: characterData.name,
                    success: result.success,
                    message: result.message
                });
                return true;
            } catch (e) {
                console.error('❌ [EchoGraph] 角色数据提交失败(WS):', e);
                logDebug('Character data submission failed', { error: e?.message });
                return false;
            }

        } catch (error) {
            console.error('💥 [EchoGraph] 角色数据提交异常:', error);
            logDebug('Character data submission exception', error);
            return false;
        } finally {
            console.log('🎭 [EchoGraph] ========== 角色数据提交流程结束 ==========');
        }
    }

    /**
     * Enhanced session initialization with better error handling and configuration
     */
    async function initializeSession(caller = 'unknown', forceReinit = false) {
        logDebug(`initializeSession called by: ${caller}, force: ${forceReinit}`);

        // 如果已经在初始化，返回现有的Promise（除非强制重新初始化）
        if (initializationPromise && !forceReinit) {
            logDebug('Initialization already in progress, waiting for existing promise...');
            return await initializationPromise;
        }

        // 创建新的初始化Promise
        initializationPromise = performInitialization(caller, forceReinit);

        try {
            const result = await initializationPromise;
            return result;
        } finally {
            initializationPromise = null; // 清除Promise，允许后续初始化
        }
    }

    async function performInitialization(caller, forceReinit = false) {
        if (isInitializing && !forceReinit) {
            logDebug('Session initialization already in progress, skipping...');
            return false;
        }

        const context = getSillyTavernContext();
        logDebug('Attempting to initialize session...', {
            characterId: context.characterId,
            hasCharacters: !!context.characters,
            characterCount: Object.keys(context.characters || {}).length,
            forceReinit: forceReinit
        });

        // More robust character checking
        const characterId = context.characterId;
        const character = context.characters?.[characterId];

        // Check if we have a valid character
        // 修复：0是有效的characterId，不应该被排除
        if (characterId === null || characterId === undefined || characterId === -1 || characterId === '') {
            logDebug(`No valid character selected (characterId: ${characterId}), caller: ${caller}`);

            // 清除之前的会话状态，因为没有有效角色
            if (currentSessionId || lastCharacterId !== null) {
                logDebug('Clearing session state due to no valid character');
                currentSessionId = null;
                lastCharacterId = null;
                updateDebugPanel();
            }
            return false; // 返回false表示没有初始化
        }

        if (!context.characters || Object.keys(context.characters).length === 0) {
            logDebug(`Characters data not available, caller: ${caller}`);
            return false;
        }

        if (!character) {
            logDebug(`Character data not found for ID: ${characterId}, caller: ${caller}`);
            return false;
        }

        // Check if character changed or force reinit
        if (lastCharacterId === characterId && currentSessionId && !forceReinit) {
            logDebug('Same character, keeping existing session', {
                characterName: character.name,
                sessionId: currentSessionId,
                caller: caller
            });
            // 确保WebSocket连接仍然有效
            if (webSocket && webSocket.readyState === WebSocket.OPEN && webSocket.url.includes(currentSessionId)) {
                logDebug('[WS] Existing WebSocket connection is active.');
            } else {
                logDebug('[WS] Existing WebSocket connection is not active or session changed, reconnecting...');
                connectWebSocket(currentSessionId);
            }
            return true; // 返回true表示已经有有效会话
        }

        // 如果角色改变，断开旧的WebSocket连接
        if (lastCharacterId !== characterId && webSocket) {
            logDebug('[WS] Character changed, disconnecting old WebSocket.');


            disconnectWebSocket();
        }

        isInitializing = true;
        lastCharacterId = characterId;

        try {
            logDebug('Initializing new session...', {
                characterId: characterId,
                characterName: character.name || 'Unnamed'
            });

            // Reset session for new character
            currentSessionId = null;

            // 首先查询是否有活跃的酒馆会话（WS）
            // 预先为该角色确保WS连接已建立，用于后续WS请求
            ensureWsForCharacter(character.name || '', {force: true});

            logDebug('Checking for existing tavern session via WS...');
            try {
                const tavernSessionData = await sendWsRequest('tavern.current_session', {}, 10000);
                if (tavernSessionData && tavernSessionData.has_session) {
                    currentSessionId = tavernSessionData.session_id;
                    const hasNodes = (tavernSessionData.graph_nodes || 0) > 0;
                    const hasEdges = (tavernSessionData.graph_edges || 0) > 0;

                    logDebug('Found existing tavern session', {
                        sessionId: currentSessionId,
                        nodes: tavernSessionData.graph_nodes,
                        edges: tavernSessionData.graph_edges,
                        hasNodes: hasNodes,
                        hasEdges: hasEdges
                    });

                    // 如果会话存在但没有节点，说明会话是空的，需要提交角色数据进行初始化
                    if (!hasNodes) {
                        logDebug('Existing session found but empty (no nodes), submitting character data...');

                        // 💡 关键修复：向空会话提交角色数据
                        const submitSuccess = await submitCharacterDataToBackend(characterId, character);
                        if (submitSuccess) {
                            logDebug('Character data submitted to existing empty session');
                            addActivityLog(`角色数据已提交到现有会话: ${character.name}`, 'success');
                        } else {
                            logDebug('Failed to submit character data to existing session');
                        }
                    }

                    showNotification(`连接到现有酒馆会话: ${character.name}`, 'success');
                    addActivityLog(`连接到现有酒馆会话: ${currentSessionId.substring(0, 8)}... (${caller})`, 'success');
                    // 连接WebSocket
                    connectWebSocket(currentSessionId);
                    // Update UI if debug panel is open
                    updateDebugPanel();
                    return true;
                }
            } catch (error) {
                logDebug('Failed to check for existing tavern session via WS, will create new one', error);
            }

            // 如果没有找到现有会话，使用完整初始化模式创建新会话
            logDebug('Creating new tavern session with full character data...');

            // 提取角色卡和世界书数据
            const characterData = {
                name: character.name || 'Unknown Character',
                description: character.description || character.data?.description || '',
                personality: character.personality || character.data?.personality || '',
                scenario: character.scenario || character.data?.scenario || '',
                first_mes: character.first_mes || character.data?.first_mes || '',
                mes_example: character.mes_example || character.data?.mes_example || '',
                avatar: character.avatar || ''
            };

            // 获取增强的世界书信息
            const worldInfo = await getEnhancedWorldInfo(context);

            logDebug('Extracted character data', {
                characterName: characterData.name,
                descriptionLength: characterData.description.length,
                personalityLength: characterData.personality.length,
                scenarioLength: characterData.scenario.length,
                worldInfoLength: worldInfo.length
            });

            // 💡 关键修复：首先向后台提交角色数据，供初始化流程使用
            logDebug('Submitting character data to backend before initialization...');
            const submitSuccess = await submitCharacterDataToBackend(characterId, character);

            if (!submitSuccess) {
                logDebug('Character data submission failed, but continuing with initialization...');
                // 不要因为提交失败就阻止初始化，可能后台可以通过其他方式获取数据
            } else {
                logDebug('Character data submitted successfully, backend can now use it');
                addActivityLog(`角色数据已提交: ${character.name}`, 'success');
            }

            // 使用 /initialize 端点而不是 process_message
            const requestBody = {
                session_id: generateConsistentSessionId(character.name),
                character_card: characterData,
                world_info: worldInfo,
                session_config: {
                    sliding_window: pluginSettings.sliding_window
                },
                is_test: false,
                enable_agent: pluginSettings.sliding_window.enable_enhanced_agent
            };

            logDebug('Sending full initialization request', {
                url: `${pluginSettings.api_base_url}/initialize`,
                characterDataKeys: Object.keys(characterData),
                worldInfoPreview: worldInfo.substring(0, 200)
            });

            try {
                const responseData = await sendWsRequest('initialize', requestBody, 60000); // 增加到60秒超时
                logDebug('Initialization response received (WS)', {
                    sessionId: responseData.session_id,
                    message: responseData.message,
                    graphStats: responseData.graph_stats
                });

                currentSessionId = responseData.session_id;

                // 连接WebSocket
                connectWebSocket(currentSessionId);

                logDebug('Session initialization successful', {
                    sessionId: currentSessionId,
                    characterName: character.name,
                    nodesCreated: responseData.graph_stats?.nodes_created || 0,
                    edgesCreated: responseData.graph_stats?.edges_created || 0,
                    caller: caller
                });

                showNotification(`为 ${character.name} 初始化会话成功 (节点: ${responseData.graph_stats?.nodes_created || 0}, 关系: ${responseData.graph_stats?.edges_created || 0})`, 'success');
                addActivityLog(`为 ${character.name} 初始化会话成功 (${caller})`, 'success');

                // Update UI if debug panel is open
                updateDebugPanel();

                return true;

            } catch (initError) {
                console.error(`${PLUGIN_NAME}: Network error during session initialization:`, initError);

                // 提供更详细的错误信息
                let errorMessage = '会话初始化失败';
                let detailMessage = '后端无法访问，请检查Python服务器是否正在运行。';

                if (initError.name === 'TimeoutError') {
                    errorMessage = '会话初始化超时';
                    detailMessage = '初始化耗时过长（超过15秒）。这可能是因为：\n1. 后端服务器响应慢\n2. 网络连接问题\n3. 请求被拦截或阻止';
                    console.error(`${PLUGIN_NAME}: [NEW VERSION] Initialization timeout after 15 seconds - 代码已更新`);
                } else if (initError.name === 'AbortError') {
                    errorMessage = '会话初始化被中止';
                    detailMessage = '请求被取消或中止';
                    console.error(`${PLUGIN_NAME}: Initialization request was aborted`);
                } else if (initError.message.includes('fetch')) {
                    errorMessage = '网络连接失败';
                    detailMessage = `无法连接到EchoGraph API (${pluginSettings.api_base_url})`;
                    console.error(`${PLUGIN_NAME}: Network connection failed:`, initError.message);
                }

                showNotification(`${errorMessage}: ${detailMessage}`, 'error');
                addActivityLog(`${errorMessage} (${caller}): ${initError.message}`, 'error');
                return false;
            }
        } catch (error) {
            console.error(`${PLUGIN_NAME}: Unexpected error during initialization:`, error);
            addActivityLog(`初始化意外错误 (${caller}): ${error.message}`, 'error');
            return false;
        } finally {
            isInitializing = false;
        }
    }

    /**
     * Enhanced world info extraction including lorebook entries with detailed logging
     */
    async function getEnhancedWorldInfo(context) {
        let worldInfo = '';
        let sources = [];

        console.log('[EchoGraph] 🌍 开始提取世界书信息');

        try {
            if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) {
                const stContext = SillyTavern.getContext();

                // 使用官方的getWorldInfoPrompt函数
                if (typeof stContext.getWorldInfoPrompt === 'function') {
                    console.log('[EchoGraph] 🔧 调用官方getWorldInfoPrompt函数...');

                    try {
                        // getWorldInfoPrompt需要正确格式的消息数组
                        // 确保每个消息都是字符串格式
                        const currentChat = (stContext.chat || []).map(msg => {
                            if (typeof msg === 'string') {
                                return msg;
                            } else if (msg && typeof msg === 'object') {
                                return msg.mes || msg.content || msg.message || '';
                            }
                            return '';
                        }).filter(msg => msg.trim().length > 0);

                        const maxContext = 4000;

                        // 调用getWorldInfoPrompt
                        const worldInfoResult = await stContext.getWorldInfoPrompt(currentChat, maxContext, false);

                        if (worldInfoResult && typeof worldInfoResult === 'string' && worldInfoResult.trim()) {
                            worldInfo += worldInfoResult;
                            sources.push('official_getWorldInfoPrompt');
                            console.log('[EchoGraph] ✅ 从官方API获取到世界书内容:', worldInfoResult.length, '字符');
                        } else {
                            console.log('[EchoGraph] ⚠️ getWorldInfoPrompt返回空结果');
                        }

                    } catch (promptError) {
                        console.log('[EchoGraph] ⚠️ getWorldInfoPrompt调用失败，尝试其他方法:', promptError.message);
                    }
                }

                // 检查角色专属的lorebook/世界书绑定
                const character = context.characters?.[context.characterId];
                if (character) {
                    const characterWorldInfoFields = ['world_info', 'worldinfo', 'lorebook', 'world_book', 'character_book', 'lore'];

                    characterWorldInfoFields.forEach(field => {
                        const fieldValue = character[field] || character.data?.[field];
                        if (fieldValue && typeof fieldValue === 'object' && fieldValue.entries && Array.isArray(fieldValue.entries)) {
                            const entries = fieldValue.entries.filter(entry =>
                                entry && entry.content && entry.content.trim() &&
                                !entry.disabled && !entry.disable
                            );

                            if (entries.length > 0) {
                                const worldContent = entries.map(entry => {
                                    const keys = entry.keys || entry.key || [];
                                    const keyStr = Array.isArray(keys) ? keys.join(', ') : String(keys || '');
                                    return keyStr ? `[${keyStr}]: ${entry.content}` : entry.content;
                                }).join('\n\n');

                                worldInfo += worldInfo ? '\n\n' + worldContent : worldContent;
                                sources.push(`character_${field}: ${entries.length} entries`);
                                console.log(`[EchoGraph] ✅ 从角色 ${field} 获取到世界书内容:`, worldContent.length, '字符');
                            }
                        }
                    });
                }
            }

            // 备用方法 - 从context.worldInfoData获取
            if (worldInfo.length === 0 && context.worldInfoData && context.worldInfoData.entries) {
                const allEntries = context.worldInfoData.entries;
                const activeEntries = allEntries
                    .filter(entry => entry && entry.content && entry.content.trim() && !entry.disable && !entry.disabled)
                    .map(entry => {
                        const keys = Array.isArray(entry.key) ? entry.key :
                                     Array.isArray(entry.keys) ? entry.keys :
                                     entry.key ? [entry.key] :
                                     entry.keys ? [entry.keys] : [];
                        const content = entry.content || entry.comment || '';
                        return keys.length > 0 ? `[${keys.join(', ')}]: ${content}` : content;
                    })
                    .filter(entry => entry.length > 10);

                if (activeEntries.length > 0) {
                    worldInfo += activeEntries.join('\n\n');
                    sources.push(`context_world_info_entries: ${activeEntries.length}`);
                    console.log(`[EchoGraph] ✅ 备用方法：已添加 ${activeEntries.length} 个世界书条目`);
                }
            }

        } catch (error) {
            console.error('[EchoGraph] ❌ 世界书信息提取错误:', error);
        }

        const finalStats = {
            总长度: worldInfo.length,
            信息来源: sources,
            来源数量: sources.length
        };

        console.log('[EchoGraph] 🎯 世界信息提取完成', finalStats);
        return worldInfo || 'No world information available.';
    }

    /**
     * Enhanced prompt processing with better context management
     */
    async function onChatCompletionPromptReady(eventData) {
        if (!pluginSettings?.enabled || eventData.dryRun) return;

        if (!currentSessionId) {
            logDebug('No active session ID, attempting auto-initialization...');
            if (pluginSettings.auto_initialize) {
                const initResult = await initializeSession('manual_enhance_prompt');
                if (!initResult) {
                    logDebug('Failed to initialize session for prompt enhancement');
                    return;
                }
            } else {
                logDebug(`${PLUGIN_NAME}: No active session ID and auto-init disabled. Enhancement skipped.`);
                return;
            }
        }

        try {
            const userMessage = eventData.chat.slice().reverse().find(msg => msg.role === 'user');
            if (!userMessage || !userMessage.content) {
                logDebug('No user message found in chat');
                return;
            }

            const userInput = userMessage.content;
            logDebug('Processing user input for enhancement', { length: userInput.length });

            // Get recent conversation history for better context
            const recentHistory = eventData.chat
                .slice(-pluginSettings.memory_enhancement.hot_memory_turns * 2) // user + AI pairs
                .map(msg => ({
                    role: msg.role,
                    content: msg.content || msg.mes || ''
                }));

            const data = await sendWsRequest('enhance_prompt', {
                session_id: currentSessionId,
                user_input: userInput,
                recent_history: recentHistory,
                max_context_length: pluginSettings.max_context_length
            }, 20000);
            const enhancedContext = data.enhanced_context;

            if (enhancedContext && enhancedContext.trim().length > 0) {
                // Insert enhanced context as system message before the last user message
                eventData.chat.splice(-1, 0, {
                    role: 'system',
                    content: `[EchoGraph Enhanced Context]\n${enhancedContext}`
                });

                logDebug('Successfully injected enhanced context', {
                    contextLength: enhancedContext.length,
                    sessionId: currentSessionId
                });

                showNotification('语境增强成功', 'info');
                updateDebugPanel();
            } else {
                logDebug('No enhanced context received');
            }
        } catch (error) {
            console.error(`${PLUGIN_NAME}: Error during prompt enhancement:`, error);
            showNotification('增强失败：' + error.message, 'error');
        }
    }

    /**
     * Sync conversation state with SillyTavern for conflict resolution
     */
    async function syncConversationState() {
        if (!pluginSettings?.enabled || !currentSessionId || !pluginSettings.sliding_window.enable_conflict_resolution) {
            return;
        }

        try {
            const context = getSillyTavernContext();
            if (!context.chat || context.chat.length === 0) {
                logDebug('空聊天历史，跳过冲突同步');
                return;
            }

            // Extract conversation history in the format expected by conflict resolver
            const tavernHistory = context.chat.map((msg, index) => ({
                sequence: index + 1,
                message_id: msg.message_id || index,
                user_input: msg.is_user ? (msg.mes || msg.content || '') : '',
                llm_response: !msg.is_user ? (msg.mes || msg.content || '') : '',
                timestamp: msg.timestamp || new Date().toISOString(),
                is_user: msg.is_user,
                content_hash: btoa(unescape(encodeURIComponent(msg.mes || msg.content || '')))
            }));

            logDebug('同步对话状态到冲突解决器', {
                totalMessages: tavernHistory.length,
                sessionId: currentSessionId
            });

            const data = await sendWsRequest('sync_conversation', {
                session_id: currentSessionId,
                tavern_history: tavernHistory
            }, 15000);
            logDebug('对话状态同步成功', {
                conflictsDetected: data.conflicts_detected,
                conflictsResolved: data.conflicts_resolved
            });

            if (data.conflicts_resolved > 0) {
                addActivityLog(`检测并解决了 ${data.conflicts_resolved} 个对话冲突`, 'warning');
                showNotification(`已解决 ${data.conflicts_resolved} 个对话冲突`, 'info');
            }

        } catch (error) {
            console.error(`${PLUGIN_NAME}: 对话状态同步时发生错误:`, error);
            addActivityLog('对话状态同步错误: ' + error.message, 'error');
        }
    }

    /**
     * Enhanced conversation processing with sliding window system
     */
    async function onMessageReceived(chat_id) {
        if (!pluginSettings?.enabled || !currentSessionId) {
            logDebug('对话处理已跳过 - 插件已禁用或无会话');
            return;
        }

        try {
            const context = getSillyTavernContext();
            const message = context.chat[chat_id];

            if (!message || message.is_user) {
                logDebug('跳过用户消息或无效消息');
                return;
            }

            const llmResponse = message.mes || message.content || '';
            const userMessage = context.chat[chat_id - 1];
            const userInput = userMessage ? (userMessage.mes || userMessage.content || '') : '';

            if (!llmResponse.trim()) {
                logDebug('LLM响应为空，跳过对话处理');
                return;
            }

            logDebug('处理新对话轮次 - 滑动窗口系统', {
                userInputLength: userInput.length,
                llmResponseLength: llmResponse.length
            });

            // Use sliding window conversation processing instead of direct memory update (WS)
            const data = await sendWsRequest('process_conversation', {
                session_id: currentSessionId,
                user_input: userInput,
                llm_response: llmResponse,
                timestamp: new Date().toISOString(),
                chat_id: chat_id,
                tavern_message_id: String(message.message_id || chat_id || 'unknown')
            }, 25000);
            logDebug('滑动窗口对话处理成功', {
                turnProcessed: data.turn_processed,
                targetProcessed: data.target_processed,
                windowSize: data.window_size
            });

            // Create activity log message based on processing results
            let activityMsg = `对话已添加到滑动窗口 (第${data.turn_sequence}轮)`;
            if (data.target_processed) {
                activityMsg += ` | 已处理目标轮次: +${data.nodes_updated || 0}节点, +${data.edges_added || 0}关系`;
                if (data.conflicts_resolved) {
                    activityMsg += ` | 已解决${data.conflicts_resolved}个冲突`;
                }
            } else {
                activityMsg += ' | 延迟处理中...';
            }

            addActivityLog(activityMsg, 'success');

            // Update UI if visible
            updateDebugPanel();

        } catch (error) {
            console.error(`${PLUGIN_NAME}: 对话处理时发生错误:`, error);
            addActivityLog('对话处理错误: ' + error.message, 'error');
        }
    }

    // --- UI Creation Functions ---
    function createSettingsModal() {
        const modalHtml = `
            <div id="echograph-settings-modal" style="
                position: absolute;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: rgba(0,0,0,0.8);
                display: none;
                z-index: 100;
                justify-content: center;
                align-items: center;
            ">
                <div style="
                    background: var(--SmartThemeBodyColor);
                    border: 1px solid var(--SmartThemeBorderColor);
                    border-radius: 10px;
                    width: 90%;
                    max-width: 700px;
                    max-height: 80%;
                    overflow-y: auto;
                    padding: 20px;
                    box-shadow: 0 4px 20px rgba(0,0,0,0.3);
                    position: relative;
                ">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
                        <h3 style="margin: 0; color: var(--SmartThemeEmColor);">EchoGraph 设置</h3>
                        <button id="cf-close-settings" class="menu_button" style="padding: 5px 10px;">✕</button>
                    </div>
                    <div>
                        <form id="echograph-settings-form">
                            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px;">
                                <div>
                                    <h5 style="color: var(--SmartThemeEmColor); margin-bottom: 15px;">基础设置</h5>
                                    <div style="margin-bottom: 15px;">
                                        <label style="display: flex; align-items: center;">
                                            <input type="checkbox" id="cf-enabled" style="margin-right: 8px;">
                                            启用 EchoGraph 增强
                                        </label>
                                    </div>
                                    <div style="margin-bottom: 15px;">
                                        <label style="display: block; margin-bottom: 5px;">EchoGraph API 地址：</label>
                                        <div style="display: flex; gap: 10px;">
                                            <input type="text" id="cf-api-url" placeholder="http://127.0.0.1:9543"
                                                   style="flex: 1; padding: 8px; border: 1px solid var(--SmartThemeBorderColor); border-radius: 4px; background: var(--SmartThemeBodyColor); color: var(--SmartThemeEmColor);">
                                            <button class="menu_button" type="button" id="cf-test-api-btn">测试连接</button>
                                        </div>
                                        <small style="color: var(--SmartThemeQuoteColor); font-size: 12px;">EchoGraph 后端服务器地址（默认端口9543）</small>
                                    </div>
                                    <div style="margin-bottom: 15px;">
                                        <label style="display: flex; align-items: center;">
                                            <input type="checkbox" id="cf-auto-init" style="margin-right: 8px;">
                                            自动初始化会话
                                        </label>
                                    </div>
                                    <div style="margin-bottom: 15px;">
                                        <label style="display: flex; align-items: center;">
                                            <input type="checkbox" id="cf-notifications" style="margin-right: 8px;">
                                            显示通知
                                        </label>
                                    </div>
                                </div>
                                <div>
                                    <h5 style="color: var(--SmartThemeEmColor); margin-bottom: 15px;">记忆系统设置</h5>
                                    <div style="margin-bottom: 15px;">
                                        <label style="display: block; margin-bottom: 5px;">热记忆轮次：</label>
                                        <input type="number" id="cf-hot-memory" min="1" max="20"
                                               style="width: 100%; padding: 8px; border: 1px solid var(--SmartThemeBorderColor); border-radius: 4px; background: var(--SmartThemeBodyColor); color: var(--SmartThemeEmColor);">
                                    </div>
                                    <div style="margin-bottom: 15px;">
                                        <label style="display: block; margin-bottom: 5px;">最大语境长度：</label>
                                        <input type="number" id="cf-max-context" min="1000" max="10000"
                                               style="width: 100%; padding: 8px; border: 1px solid var(--SmartThemeBorderColor); border-radius: 4px; background: var(--SmartThemeBodyColor); color: var(--SmartThemeEmColor);">
                                    </div>
                                    <div style="margin-bottom: 15px;">
                                        <label style="display: flex; align-items: center;">
                                            <input type="checkbox" id="cf-debug" style="margin-right: 8px;">
                                            调试模式
                                        </label>
                                    </div>
                                </div>
                            </div>

                            <div style="margin-top: 20px; padding-top: 20px; border-top: 1px solid var(--SmartThemeBorderColor);">
                                <h5 style="color: var(--SmartThemeEmColor); margin-bottom: 15px;">滑动窗口设置</h5>
                                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px;">
                                    <div>
                                        <label style="display: block; margin-bottom: 5px;">窗口大小：</label>
                                        <input type="number" id="cf-window-size" min="3" max="10" value="4"
                                               style="width: 100%; padding: 8px; border: 1px solid var(--SmartThemeBorderColor); border-radius: 4px; background: var(--SmartThemeBodyColor); color: var(--SmartThemeEmColor);">
                                        <small style="color: var(--SmartThemeQuoteColor); font-size: 12px;">保留最近的对话轮数</small>
                                    </div>
                                    <div>
                                        <label style="display: block; margin-bottom: 5px;">处理延迟：</label>
                                        <input type="number" id="cf-processing-delay" min="1" max="5" value="1"
                                               style="width: 100%; padding: 8px; border: 1px solid var(--SmartThemeBorderColor); border-radius: 4px; background: var(--SmartThemeBodyColor); color: var(--SmartThemeEmColor);">
                                        <small style="color: var(--SmartThemeQuoteColor); font-size: 12px;">延迟处理的轮次数</small>
                                    </div>
                                </div>
                                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-top: 15px;">
                                    <div>
                                        <label style="display: flex; align-items: center;">
                                            <input type="checkbox" id="cf-enhanced-agent" checked style="margin-right: 8px;">
                                            启用增强智能体
                                        </label>
                                        <small style="color: var(--SmartThemeQuoteColor); font-size: 12px;">基于世界观创建丰富的角色节点</small>
                                    </div>
                                    <div>
                                        <label style="display: flex; align-items: center;">
                                            <input type="checkbox" id="cf-conflict-resolution" checked style="margin-right: 8px;">
                                            启用冲突解决
                                        </label>
                                        <small style="color: var(--SmartThemeQuoteColor); font-size: 12px;">处理酒馆对话历史修改</small>
                                    </div>
                                </div>
                            </div>
                        </form>
                    </div>
                    <div style="margin-top: 20px; padding-top: 20px; border-top: 1px solid var(--SmartThemeBorderColor); display: flex; justify-content: flex-end; gap: 10px;">
                        <button id="cf-cancel-settings" class="menu_button">取消</button>
                        <button id="cf-save-settings" class="menu_button menu_button_icon">保存设置</button>
                    </div>
                </div>
            </div>
        `;

        // 如果在主页面中，添加到主页面容器；否则添加到body
        const targetContainer = $('#echograph-main-page').length ? $('#echograph-main-page') : $('body');
        targetContainer.append(modalHtml);

        // 绑定关闭事件
        $('#cf-close-settings, #cf-cancel-settings').on('click', () => {
            $('#echograph-settings-modal').hide();
        });

        // 点击背景关闭
        $('#echograph-settings-modal').on('click', (e) => {
            if (e.target.id === 'echograph-settings-modal') {
                $('#echograph-settings-modal').hide();
            }
        });

        // 绑定保存事件
        $('#cf-save-settings').on('click', saveSettingsFromModal);

        // Bind test API connection
        $('#cf-test-api-btn').on('click', async () => {
            const apiUrl = $('#cf-api-url').val() || DEFAULT_API_BASE_URL;
            // 简单检查WebSocket状态，因为HTTP健康检查已被移除
            if (webSocket && webSocket.readyState === WebSocket.OPEN) {
                alert(`✅ WebSocket已连接到 ${webSocket.url}`);
            } else {
                alert(`❌ WebSocket未连接。请确保EchoGraph后端服务器正在运行，并且已在SillyTavern中选择了角色以尝试连接。`);
            }
        });
    }

    function createDebugPanel() {
        const panelHtml = `
            <div id="echograph-panel" class="cf-panel" style="display: none;">
                <div class="cf-panel-header">
                    <div class="cf-panel-title">
                        <span class="cf-icon">🔮</span>
                        EchoGraph 滑动窗口状态
                    </div>
                    <div class="cf-panel-controls">
                        <button id="cf-minimize" class="cf-btn cf-btn-sm">−</button>
                        <button id="cf-close" class="cf-btn cf-btn-sm">×</button>
                    </div>
                </div>
                <div id="cf-panel-body" class="cf-panel-body">
                    <div class="cf-status-section">
                        <h3>系统状态</h3>
                        <div class="cf-status-grid">
                            <div class="cf-status-item">
                                <span class="cf-label">API连接：</span>
                                <span id="cf-api-status" class="cf-status-indicator cf-status-unknown">未知</span>
                            </div>
                            <div class="cf-status-item">
                                <span class="cf-label">会话：</span>
                                <span id="cf-session-status" class="cf-value">未初始化</span>
                            </div>
                            <div class="cf-status-item">
                                <span class="cf-label">角色：</span>
                                <span id="cf-character-status" class="cf-value">无</span>
                            </div>
                        </div>
                    </div>

                    <div class="cf-sliding-window-section">
                        <h3>滑动窗口系统</h3>
                        <div class="cf-stats-grid">
                            <div class="cf-stat-card">
                                <div class="cf-stat-number" id="cf-window-turns">0</div>
                                <div class="cf-stat-label">窗口轮次</div>
                            </div>
                            <div class="cf-stat-card">
                                <div class="cf-stat-number" id="cf-processed-turns">0</div>
                                <div class="cf-stat-label">已处理轮次</div>
                            </div>
                            <div class="cf-stat-card">
                                <div class="cf-stat-number" id="cf-conflicts-resolved">0</div>
                                <div class="cf-stat-label">已解决冲突</div>
                            </div>
                        </div>
                    </div>

                    <div class="cf-memory-section">
                        <h3>知识图谱</h3>
                        <div class="cf-stats-grid">
                            <div class="cf-stat-card">
                                <div class="cf-stat-number" id="cf-graph-nodes">0</div>
                                <div class="cf-stat-label">图谱节点</div>
                            </div>
                            <div class="cf-stat-card">
                                <div class="cf-stat-number" id="cf-graph-edges">0</div>
                                <div class="cf-stat-label">关系边</div>
                            </div>
                            <div class="cf-stat-card">
                                <div class="cf-stat-number" id="cf-memory-turns">0</div>
                                <div class="cf-stat-label">记忆轮次</div>
                            </div>
                        </div>
                    </div>

                    <div class="cf-activity-section">
                        <h3>最近活动</h3>
                        <div id="cf-activity-log" class="cf-activity-log">
                            <div class="cf-activity-item cf-activity-info">
                                <span class="cf-timestamp">等待活动中...</span>
                            </div>
                        </div>
                    </div>

                    <div class="cf-controls-section">
                        <h3>快捷操作</h3>
                        <div class="cf-button-group">
                            <button id="cf-refresh-stats" class="cf-btn cf-btn-primary">刷新统计</button>
                            <button id="cf-test-connection" class="cf-btn cf-btn-info">测试连接</button>
                            <button id="cf-sync-conversation" class="cf-btn cf-btn-info">同步对话</button>
                            <button id="cf-clear-memory" class="cf-btn cf-btn-warning">清除记忆</button>
                            <button id="cf-quick-reset" class="cf-btn cf-btn-danger" title="快速清理所有会话和连接">快速清理</button>
                            <button id="cf-export-graph" class="cf-btn cf-btn-secondary">导出图谱</button>
                        </div>
                    </div>
                </div>
            </div>

            <style>
            .cf-panel {
                position: fixed;
                top: 20px;
                right: 20px;
                width: 380px;
                max-height: 80vh;
                background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
                border: 1px solid #4a90e2;
                border-radius: 12px;
                box-shadow: 0 8px 32px rgba(0,0,0,0.3);
                font-family: 'Segoe UI', 'Arial', sans-serif;
                z-index: 10000;
                overflow: hidden;
                transition: all 0.3s ease;
            }

            .cf-panel-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                background: linear-gradient(90deg, #4a90e2 0%, #357abd 100%);
                color: white;
                padding: 12px 16px;
                font-weight: 600;
                font-size: 14px;
            }

            .cf-panel-title {
                display: flex;
                align-items: center;
                gap: 8px;
            }

            .cf-icon {
                font-size: 16px;
            }

            .cf-panel-controls {
                display: flex;
                gap: 4px;
            }

            .cf-btn {
                background: rgba(255,255,255,0.2);
                border: none;
                color: white;
                padding: 4px 8px;
                border-radius: 4px;
                cursor: pointer;
                transition: background 0.2s;
            }

            .cf-btn:hover {
                background: rgba(255,255,255,0.3);
            }

            .cf-btn-sm {
                padding: 2px 6px;
                font-size: 12px;
            }

            .cf-panel-body {
                padding: 16px;
                color: #e0e6ed;
                max-height: 70vh;
                overflow-y: auto;
            }

            .cf-panel-body::-webkit-scrollbar {
                width: 6px;
            }

            .cf-panel-body::-webkit-scrollbar-track {
                background: #2a2a3e;
                border-radius: 3px;
            }

            .cf-panel-body::-webkit-scrollbar-thumb {
                background: #4a90e2;
                border-radius: 3px;
            }

            .cf-panel-body h3 {
                color: #4a90e2;
                font-size: 13px;
                margin: 0 0 12px 0;
                padding-bottom: 6px;
                border-bottom: 1px solid #333;
                text-transform: uppercase;
                letter-spacing: 0.5px;
            }

            .cf-status-grid, .cf-stats-grid {
                display: grid;
                gap: 8px;
                margin-bottom: 20px;
            }

            .cf-status-grid {
                grid-template-columns: 1fr;
            }

            .cf-stats-grid {
                grid-template-columns: repeat(3, 1fr);
            }

            .cf-status-item {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 8px 12px;
                background: rgba(255,255,255,0.05);
                border-radius: 6px;
                font-size: 12px;
            }

            .cf-label {
                font-weight: 500;
                color: #b0b8c4;
            }

            .cf-value {
                color: #4a90e2;
                font-weight: 500;
            }

            .cf-status-indicator {
                padding: 2px 8px;
                border-radius: 12px;
                font-size: 11px;
                font-weight: 600;
                text-transform: uppercase;
            }

            .cf-status-connected {
                background: #27ae60;
                color: white;
            }

            .cf-status-disconnected {
                background: #e74c3c;
                color: white;
            }

            .cf-status-unknown {
                background: #f39c12;
                color: white;
            }

            .cf-stat-card {
                background: rgba(255,255,255,0.08);
                border-radius: 8px;
                padding: 12px;
                text-align: center;
                border: 1px solid rgba(74,144,226,0.3);
            }

            .cf-stat-number {
                font-size: 20px;
                font-weight: 700;
                color: #4a90e2;
                margin-bottom: 4px;
            }

            .cf-stat-label {
                font-size: 11px;
                color: #b0b8c4;
                text-transform: uppercase;
                letter-spacing: 0.5px;
            }

            .cf-activity-log {
                background: rgba(0,0,0,0.3);
                border-radius: 6px;
                padding: 8px;
                max-height: 120px;
                overflow-y: auto;
                margin-bottom: 20px;
            }

            .cf-activity-item {
                padding: 6px 8px;
                border-left: 3px solid #4a90e2;
                margin-bottom: 4px;
                background: rgba(255,255,255,0.02);
                font-size: 11px;
                border-radius: 0 4px 4px 0;
            }

            .cf-activity-success {
                border-left-color: #27ae60;
                background: rgba(39,174,96,0.1);
            }

            .cf-activity-warning {
                border-left-color: #f39c12;
                background: rgba(243,156,18,0.1);
            }

            .cf-activity-error {
                border-left-color: #e74c3c;
                background: rgba(231,76,60,0.1);
            }

            .cf-timestamp {
                color: #7f8c8d;
                font-size: 10px;
            }

            .cf-button-group {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: 8px;
            }

            .cf-btn-primary {
                background: #4a90e2;
                border: none;
                color: white;
                padding: 8px 12px;
                border-radius: 6px;
                cursor: pointer;
                font-size: 12px;
                font-weight: 500;
                transition: all 0.2s;
                grid-column: 1 / -1;
            }

            .cf-btn-primary:hover {
                background: #357abd;
                transform: translateY(-1px);
            }

            .cf-btn-info {
                background: #17a2b8;
                border: none;
                color: white;
                padding: 8px 12px;
                border-radius: 6px;
                cursor: pointer;
                font-size: 12px;
                font-weight: 500;
                transition: all 0.2s;
            }

            .cf-btn-info:hover {
                background: #138496;
                transform: translateY(-1px);
            }

            .cf-btn-warning {
                background: #f39c12;
                border: none;
                color: white;
                padding: 8px 12px;
                border-radius: 6px;
                cursor: pointer;
                font-size: 12px;
                font-weight: 500;
                transition: all 0.2s;
            }

            .cf-btn-warning:hover {
                background: #d68910;
                transform: translateY(-1px);
            }

            .cf-btn-secondary {
                background: #6c757d;
                border: none;
                color: white;
                padding: 8px 12px;
                border-radius: 6px;
                cursor: pointer;
                font-size: 12px;
                font-weight: 500;
                transition: all 0.2s;
            }

            .cf-btn-secondary:hover {
                background: #545b62;
                transform: translateY(-1px);
            }

            .cf-btn-danger {
                background: #dc3545;
                border: none;
                color: white;
                padding: 8px 12px;
                border-radius: 6px;
                cursor: pointer;
                font-size: 12px;
                font-weight: 500;
                transition: all 0.2s;
            }

            .cf-btn-danger:hover {
                background: #c82333;
                transform: translateY(-1px);
            }

            .cf-panel.minimized .cf-panel-body {
                display: none;
            }

            .cf-panel.minimized {
                width: 250px;
            }
            </style>
        `;

        $('body').append(panelHtml);

        // Bind events
        $('#cf-close').on('click', () => $('#echograph-panel').hide());
        $('#cf-minimize').on('click', () => {
            $('#echograph-panel').toggleClass('minimized');
            $('#cf-minimize').text($('#echograph-panel').hasClass('minimized') ? '+' : '−');
        });

        // Quick action buttons
        $('#cf-refresh-stats').on('click', refreshPanelStats);
        $('#cf-sync-conversation').on('click', () => {
            syncConversationState();
            addActivityLog('手动同步对话状态', 'info');
        });
        $('#cf-clear-memory').on('click', () => {
            if (confirm('确定要清除记忆吗？此操作不可撤销。')) {
                clearMemory();
            }
        });
        $('#cf-export-graph').on('click', exportKnowledgeGraph);
        $('#cf-quick-reset').on('click', () => {
            if (confirm('确定要执行快速清理吗？\n\n这将清除：\n• 所有活跃会话\n• WebSocket连接\n• 缓存数据\n\n此操作不可撤销，清理后需要重新选择角色。')) {
                performQuickReset();
            }
        });

        // API连接测试按钮
        $('#cf-test-connection').on('click', testAPIConnection);
    }

    function loadSettingsToModal() {
        $('#cf-enabled').prop('checked', pluginSettings.enabled);
        $('#cf-api-url').val(pluginSettings.api_base_url);
        $('#cf-auto-init').prop('checked', pluginSettings.auto_initialize);
        $('#cf-notifications').prop('checked', pluginSettings.show_notifications);
        $('#cf-hot-memory').val(pluginSettings.memory_enhancement.hot_memory_turns);
        $('#cf-max-context').val(pluginSettings.max_context_length);
        $('#cf-world-book').prop('checked', pluginSettings.memory_enhancement.enable_world_book_integration);
        $('#cf-debug').prop('checked', pluginSettings.debug_mode);

        // Sliding window settings
        $('#cf-window-size').val(pluginSettings.sliding_window.window_size);
        $('#cf-processing-delay').val(pluginSettings.sliding_window.processing_delay);
        $('#cf-enhanced-agent').prop('checked', pluginSettings.sliding_window.enable_enhanced_agent);
        $('#cf-conflict-resolution').prop('checked', pluginSettings.sliding_window.enable_conflict_resolution);
    }

    function saveSettingsFromModal() {
        pluginSettings.enabled = $('#cf-enabled').prop('checked');
        pluginSettings.api_base_url = $('#cf-api-url').val();
        pluginSettings.auto_initialize = $('#cf-auto-init').prop('checked');
        pluginSettings.show_notifications = $('#cf-notifications').prop('checked');
        pluginSettings.memory_enhancement.hot_memory_turns = parseInt($('#cf-hot-memory').val());
        pluginSettings.max_context_length = parseInt($('#cf-max-context').val());
        pluginSettings.memory_enhancement.enable_world_book_integration = $('#cf-world-book').prop('checked');
        pluginSettings.debug_mode = $('#cf-debug').prop('checked');

        // Sliding window settings
        pluginSettings.sliding_window.window_size = parseInt($('#cf-window-size').val());
        pluginSettings.sliding_window.processing_delay = parseInt($('#cf-processing-delay').val());
        pluginSettings.sliding_window.enable_enhanced_agent = $('#cf-enhanced-agent').prop('checked');
        pluginSettings.sliding_window.enable_conflict_resolution = $('#cf-conflict-resolution').prop('checked');

        saveSettings();
        $('#echograph-settings-modal').hide();
        showNotification('设置已成功保存', 'success');

        // Update debug panel visibility
        if (pluginSettings.debug_mode) {
            $('#echograph-panel').show();
        } else {
            $('#echograph-panel').hide();
        }
    }

    function updateDebugPanel() {
        if (!pluginSettings?.debug_mode) return;

        const context = getSillyTavernContext();
        const character = context.characters?.[context.characterId];

        // Update new panel
        updatePanelStatus(pluginSettings.enabled ? '激活' : '已禁用',
                         pluginSettings.enabled ? 'connected' : 'disconnected');

        // Update session and character status in both panels
        const sessionText = currentSessionId ? currentSessionId.substring(0, 8) + '...' : '未初始化';
        const characterText = character?.name || '无';

        // Update main page status if visible
        $('#cf-main-session-status').text(sessionText);
        $('#cf-main-character-status').text(characterText);

        // Legacy debug panel compatibility
        $('#cf-status').text(pluginSettings.enabled ? '已启用' : '已禁用');
        $('#cf-session').text(currentSessionId ? currentSessionId.substring(0, 8) + '...' : '无');
        $('#cf-character').text(characterText);
        $('#cf-last-enhancement').text(new Date().toLocaleTimeString());

        // Log status for debugging
        logDebug('Debug panel updated', {
            enabled: pluginSettings.enabled,
            session: sessionText,
            character: characterText,
            characterId: context.characterId
        });
    }

    function showEchoGraphMainPage() {
        // Create a full-page overlay for EchoGraph
        if ($('#echograph-main-page').length) {
            $('#echograph-main-page').show();
            // 检查API状态
            if (currentSessionId) {
                connectWebSocket(currentSessionId);
            }
            return;
        }

        const mainPageHtml = `
            <div id="echograph-main-page" style="
                position: fixed;
                top: 0;
                left: 0;
                width: 100vw;
                height: 100vh;
                background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
                z-index: 10001;
                color: #e0e6ed;
                overflow-y: auto;
                font-family: 'Segoe UI', Arial, sans-serif;
            ">
                <div class="cf-main-header" style="
                    background: linear-gradient(90deg, #4a90e2 0%, #357abd 100%);
                    padding: 20px;
                    text-align: center;
                    box-shadow: 0 2px 10px rgba(0,0,0,0.3);
                ">
                    <h1 style="margin: 0; color: white; font-size: 28px;">
                        EchoGraph 滑动窗口智能增强
                    </h1>
                    <p style="margin: 10px 0 0 0; color: rgba(255,255,255,0.9); font-size: 16px;">
                        版本 ${PLUGIN_VERSION} - 智能对话记忆管理系统
                    </p>
                    <button id="cf-close-main-page" style="
                        position: absolute;
                        top: 15px;
                        right: 20px;
                        background: rgba(255,255,255,0.2);
                        border: none;
                        color: white;
                        padding: 8px 12px;
                        border-radius: 6px;
                        cursor: pointer;
                        font-size: 16px;
                    ">× 关闭</button>
                </div>

                <div class="cf-main-content" style="
                    padding: 30px;
                    max-width: 1200px;
                    margin: 0 auto;
                ">
                    <div class="cf-dashboard-grid" style="
                        display: grid;
                        grid-template-columns: repeat(auto-fit, minmax(350px, 1fr));
                        gap: 25px;
                        margin-bottom: 30px;
                    ">
                        <!-- 连接状态卡片 -->
                        <div class="cf-card" style="
                            background: rgba(255,255,255,0.08);
                            border-radius: 12px;
                            padding: 25px;
                            border: 1px solid rgba(74,144,226,0.3);
                        ">
                            <h3 style="color: #4a90e2; margin-bottom: 20px;">连接状态</h3>
                            <div class="cf-connection-status">
                                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                                    <span>API 连接:</span>
                                    <span id="cf-main-api-status" class="cf-status-indicator cf-status-disconnected">未连接</span>
                                </div>
                                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                                    <span>会话状态:</span>
                                    <span id="cf-main-session-status">未初始化</span>
                                </div>
                                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
                                    <span>当前角色:</span>
                                    <span id="cf-main-character-status">无</span>
                                </div>
                                <button id="cf-main-test-connection" class="cf-btn cf-btn-primary" style="width: 100%; margin-bottom: 10px;">测试连接</button>
                                <button id="cf-main-settings" class="cf-btn cf-btn-secondary" style="width: 100%;">打开设置</button>
                            </div>
                        </div>

                        <!-- 滑动窗口状态卡片 -->
                        <div class="cf-card" style="
                            background: rgba(255,255,255,0.08);
                            border-radius: 12px;
                            padding: 25px;
                            border: 1px solid rgba(74,144,226,0.3);
                        ">
                            <h3 style="color: #4a90e2; margin-bottom: 20px;">滑动窗口状态</h3>
                            <div class="cf-stats-grid" style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 15px;">
                                <div class="cf-stat-item" style="text-align: center;">
                                    <div id="cf-main-window-turns" style="font-size: 24px; font-weight: bold; color: #4a90e2;">0</div>
                                    <div style="font-size: 12px; color: #b0b8c4;">窗口轮次</div>
                                </div>
                                <div class="cf-stat-item" style="text-align: center;">
                                    <div id="cf-main-processed-turns" style="font-size: 24px; font-weight: bold; color: #27ae60;">0</div>
                                    <div style="font-size: 12px; color: #b0b8c4;">已处理轮次</div>
                                </div>
                                <div class="cf-stat-item" style="text-align: center;">
                                    <div id="cf-main-conflicts-resolved" style="font-size: 24px; font-weight: bold; color: #f39c12;">0</div>
                                    <div style="font-size: 12px; color: #b0b8c4;">解决冲突</div>
                                </div>
                                <div class="cf-stat-item" style="text-align: center;">
                                    <div id="cf-main-window-capacity" style="font-size: 24px; font-weight: bold; color: #9b59b6;">4</div>
                                    <div style="font-size: 12px; color: #b0b8c4;">窗口容量</div>
                                </div>
                            </div>
                        </div>

                        <!-- 知识图谱统计卡片 -->
                        <div class="cf-card" style="
                            background: rgba(255,255,255,0.08);
                            border-radius: 12px;
                            padding: 25px;
                            border: 1px solid rgba(74,144,226,0.3);
                        ">
                            <h3 style="color: #4a90e2; margin-bottom: 20px;">知识图谱</h3>
                            <div class="cf-stats-grid" style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 15px;">
                                <div class="cf-stat-item" style="text-align: center;">
                                    <div id="cf-main-graph-nodes" style="font-size: 24px; font-weight: bold; color: #4a90e2;">0</div>
                                    <div style="font-size: 12px; color: #b0b8c4;">图谱节点</div>
                                </div>
                                <div class="cf-stat-item" style="text-align: center;">
                                    <div id="cf-main-graph-edges" style="font-size: 24px; font-weight: bold; color: #27ae60;">0</div>
                                    <div style="font-size: 12px; color: #b0b8c4;">关系边</div>
                                </div>
                                <div class="cf-stat-item" style="text-align: center;">
                                    <div id="cf-main-memory-turns" style="font-size: 24px; font-weight: bold; color: #f39c12;">0</div>
                                    <div style="font-size: 12px; color: #b0b8c4;">记忆轮次</div>
                                </div>
                                <div class="cf-stat-item" style="text-align: center;">
                                    <div id="cf-main-last-update" style="font-size: 14px; color: #b0b8c4;">--:--:--</div>
                                    <div style="font-size: 12px; color: #b0b8c4;">最后更新</div>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- 快捷操作区域 -->
                    <div class="cf-card" style="
                        background: rgba(255,255,255,0.08);
                        border-radius: 12px;
                        padding: 25px;
                        border: 1px solid rgba(74,144,226,0.3);
                        margin-bottom: 30px;
                    ">
                        <h3 style="color: #4a90e2; margin-bottom: 20px;">快捷操作</h3>
                        <div class="cf-main-buttons" style="
                            display: grid;
                            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
                            gap: 15px;
                        ">
                            <button id="cf-main-refresh-stats" class="cf-btn cf-btn-primary">刷新统计</button>
                            <button id="cf-main-sync-conversation" class="cf-btn cf-btn-info">同步对话</button>
                            <button id="cf-main-clear-memory" class="cf-btn cf-btn-warning">清除记忆</button>
                            <button id="cf-main-quick-reset" class="cf-btn cf-btn-danger" title="快速清理所有会话和连接">快速清理</button>
                            <button id="cf-main-export-graph" class="cf-btn cf-btn-secondary">导出图谱</button>
                            <button id="cf-main-toggle-panel" class="cf-btn cf-btn-info">状态面板</button>
                            <button id="cf-main-open-settings" class="cf-btn cf-btn-secondary">插件设置</button>
                        </div>
                    </div>

                    <!-- 活动日志区域 -->
                    <div class="cf-card" style="
                        background: rgba(255,255,255,0.08);
                        border-radius: 12px;
                        padding: 25px;
                        border: 1px solid rgba(74,144,226,0.3);
                    ">
                        <h3 style="color: #4a90e2; margin-bottom: 20px;">最近活动</h3>
                        <div id="cf-main-activity-log" style="
                            background: rgba(0,0,0,0.3);
                            border-radius: 6px;
                            padding: 15px;
                            max-height: 300px;
                            overflow-y: auto;
                            font-size: 13px;
                        ">
                            <div style="color: #7f8c8d;">等待活动中...</div>
                        </div>
                    </div>
                </div>
            </div>
        `;

        $('body').append(mainPageHtml);

        // 绑定事件
        bindMainPageEvents();

        // 初始化数据
        updateMainPageStatus();
        refreshMainPageStats();

        // 延迟检查API状态，避免立即显示"检查中"
        setTimeout(() => {
            checkAPIStatus();
        }, 1000);
    }

    function bindMainPageEvents() {
        $('#cf-close-main-page').on('click', () => {
            $('#echograph-main-page').hide();
        });

        $('#cf-main-test-connection').on('click', async () => {
            // 先更新状态为测试中
            const statusElement = $('#cf-main-api-status');
            statusElement.removeClass('cf-status-connected cf-status-disconnected')
                        .addClass('cf-status-unknown')
                        .text('测试中...');

            // 然后调用测试连接
            await testAPIConnection();
        });
        $('#cf-main-settings, #cf-main-open-settings').on('click', () => {
            // 移除旧的设置模态框
            $('#echograph-settings-modal').remove();

            // 在主页面中创建设置模态框
            const modalHtml = `
                <div id="echograph-settings-modal" style="
                    position: fixed;
                    top: 0;
                    left: 0;
                    width: 100vw;
                    height: 100vh;
                    background: rgba(0,0,0,0.8);
                    display: flex;
                    z-index: 10002;
                    justify-content: center;
                    align-items: center;
                ">
                    <div style="
                        background: var(--SmartThemeBodyColor, #1a1a2e);
                        border: 1px solid var(--SmartThemeBorderColor, #4a90e2);
                        border-radius: 10px;
                        width: 90%;
                        max-width: 700px;
                        max-height: 85vh;
                        overflow-y: auto;
                        padding: 20px;
                        box-shadow: 0 4px 20px rgba(0,0,0,0.5);
                        position: relative;
                        color: var(--SmartThemeEmColor, #e0e6ed);
                    ">
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
                            <h3 style="margin: 0; color: var(--SmartThemeEmColor);">EchoGraph 设置</h3>
                            <button id="cf-close-settings" class="menu_button" style="padding: 5px 10px;">✕</button>
                        </div>
                        <div>
                            <form id="echograph-settings-form">
                                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px;">
                                    <div>
                                        <h5 style="color: var(--SmartThemeEmColor); margin-bottom: 15px;">基础设置</h5>
                                        <div style="margin-bottom: 15px;">
                                            <label style="display: flex; align-items: center;">
                                                <input type="checkbox" id="cf-enabled" style="margin-right: 8px;">
                                                启用 EchoGraph 增强
                                            </label>
                                        </div>
                                        <div style="margin-bottom: 15px;">
                                            <label style="display: block; margin-bottom: 5px;">EchoGraph API 地址：</label>
                                            <div style="display: flex; gap: 10px;">
                                                <input type="text" id="cf-api-url" placeholder="http://127.0.0.1:9543"
                                                       style="flex: 1; padding: 8px; border: 1px solid var(--SmartThemeBorderColor); border-radius: 4px; background: var(--SmartThemeBodyColor); color: var(--SmartThemeEmColor);">
                                                <button class="menu_button" type="button" id="cf-test-api-btn">测试连接</button>
                                            </div>
                                            <small style="color: var(--SmartThemeQuoteColor); font-size: 12px;">EchoGraph 后端服务器地址（默认端口9543）</small>
                                        </div>
                                        <div style="margin-bottom: 15px;">
                                            <label style="display: flex; align-items: center;">
                                                <input type="checkbox" id="cf-auto-init" style="margin-right: 8px;">
                                                自动初始化会话
                                            </label>
                                        </div>
                                        <div style="margin-bottom: 15px;">
                                            <label style="display: flex; align-items: center;">
                                                <input type="checkbox" id="cf-notifications" style="margin-right: 8px;">
                                                显示通知
                                            </label>
                                        </div>
                                    </div>
                                    <div>
                                        <h5 style="color: var(--SmartThemeEmColor); margin-bottom: 15px;">记忆系统设置</h5>
                                        <div style="margin-bottom: 15px;">
                                            <label style="display: block; margin-bottom: 5px;">热记忆轮次：</label>
                                            <input type="number" id="cf-hot-memory" min="1" max="20"
                                                   style="width: 100%; padding: 8px; border: 1px solid var(--SmartThemeBorderColor); border-radius: 4px; background: var(--SmartThemeBodyColor); color: var(--SmartThemeEmColor);">
                                        </div>
                                        <div style="margin-bottom: 15px;">
                                            <label style="display: block; margin-bottom: 5px;">最大语境长度：</label>
                                            <input type="number" id="cf-max-context" min="1000" max="10000"
                                                   style="width: 100%; padding: 8px; border: 1px solid var(--SmartThemeBorderColor); border-radius: 4px; background: var(--SmartThemeBodyColor); color: var(--SmartThemeEmColor);">
                                        </div>
                                        <div style="margin-bottom: 15px;">
                                            <label style="display: flex; align-items: center;">
                                                <input type="checkbox" id="cf-debug" style="margin-right: 8px;">
                                                调试模式
                                            </label>
                                        </div>
                                    </div>
                                </div>

                                <div style="margin-top: 20px; padding-top: 20px; border-top: 1px solid var(--SmartThemeBorderColor);">
                                    <h5 style="color: var(--SmartThemeEmColor); margin-bottom: 15px;">滑动窗口设置</h5>
                                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px;">
                                        <div>
                                            <label style="display: block; margin-bottom: 5px;">窗口大小：</label>
                                            <input type="number" id="cf-window-size" min="3" max="10" value="4"
                                                   style="width: 100%; padding: 8px; border: 1px solid var(--SmartThemeBorderColor); border-radius: 4px; background: var(--SmartThemeBodyColor); color: var(--SmartThemeEmColor);">
                                            <small style="color: var(--SmartThemeQuoteColor); font-size: 12px;">保留最近的对话轮数</small>
                                        </div>
                                        <div>
                                            <label style="display: block; margin-bottom: 5px;">处理延迟：</label>
                                            <input type="number" id="cf-processing-delay" min="1" max="5" value="1"
                                                   style="width: 100%; padding: 8px; border: 1px solid var(--SmartThemeBorderColor); border-radius: 4px; background: var(--SmartThemeBodyColor); color: var(--SmartThemeEmColor);">
                                            <small style="color: var(--SmartThemeQuoteColor); font-size: 12px;">延迟处理的轮次数</small>
                                        </div>
                                    </div>
                                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-top: 15px;">
                                        <div>
                                            <label style="display: flex; align-items: center;">
                                                <input type="checkbox" id="cf-enhanced-agent" checked style="margin-right: 8px;">
                                                启用增强智能体
                                            </label>
                                            <small style="color: var(--SmartThemeQuoteColor); font-size: 12px;">基于世界观创建丰富的角色节点</small>
                                        </div>
                                        <div>
                                            <label style="display: flex; align-items: center;">
                                                <input type="checkbox" id="cf-conflict-resolution" checked style="margin-right: 8px;">
                                                启用冲突解决
                                            </label>
                                            <small style="color: var(--SmartThemeQuoteColor); font-size: 12px;">处理酒馆对话历史修改</small>
                                        </div>
                                    </div>
                                </div>
                            </form>
                        </div>
                        <div style="margin-top: 20px; padding-top: 20px; border-top: 1px solid var(--SmartThemeBorderColor); display: flex; justify-content: flex-end; gap: 10px;">
                            <button id="cf-cancel-settings" class="menu_button">取消</button>
                            <button id="cf-save-settings" class="menu_button menu_button_icon">保存设置</button>
                        </div>
                    </div>
                </div>
            `;

            $('body').append(modalHtml);

            // 绑定事件
            $('#cf-close-settings, #cf-cancel-settings').on('click', () => {
                $('#echograph-settings-modal').remove();
            });

            // 点击背景关闭
            $('#echograph-settings-modal').on('click', (e) => {
                if (e.target.id === 'echograph-settings-modal') {
                    $('#echograph-settings-modal').remove();
                }
            });

            $('#cf-save-settings').on('click', saveSettingsFromModal);

            // 绑定测试API连接事件
            $('#cf-test-api-btn').on('click', async () => {
                const apiUrl = $('#cf-api-url').val() || DEFAULT_API_BASE_URL;
                try {
                    $('#cf-test-api-btn').prop('disabled', true).text('测试中...');

                    const response = await fetch(`${apiUrl}/health`);
                    if (response.ok) {
                        const data = await response.json();
                        alert(`✅ 连接成功！\n\n服务器信息：\n• 版本: ${data.version}\n• 活跃会话: ${data.active_sessions}\n• 已注册角色: ${data.total_characters}`);
                    } else {
                        alert(`❌ 连接失败\n\nHTTP状态: ${response.status}\n请检查服务器地址和端口是否正确`);
                    }
                } catch (error) {
                    alert(`❌ 无法连接到API服务器\n\n错误信息: ${error.message}\n\n请确认：\n1. EchoGraph服务器正在运行\n2. API地址格式正确\n3. 防火墙未阻止连接`);
                } finally {
                    $('#cf-test-api-btn').prop('disabled', false).text('测试连接');
                }
            });

            // 加载设置到模态框
            loadSettingsToModal();
        });
        $('#cf-main-refresh-stats').on('click', refreshMainPageStats);
        $('#cf-main-sync-conversation').on('click', () => {
            syncConversationState();
            addMainPageLog('手动同步对话状态', 'info');
        });
        $('#cf-main-clear-memory').on('click', () => {
            if (confirm('确定要清除记忆吗？此操作不可撤销。')) {
                clearMemory();
            }
        });
        $('#cf-main-export-graph').on('click', exportKnowledgeGraph);
        $('#cf-main-quick-reset').on('click', () => {
            if (confirm('确定要执行快速清理吗？\n\n这将清除：\n• 所有活跃会话\n• WebSocket连接\n• 缓存数据\n\n此操作不可撤销，清理后需要重新选择角色。')) {
                performQuickReset();
            }
        });
        $('#cf-main-toggle-panel').on('click', () => {
            if ($('#echograph-panel').is(':visible')) {
                $('#echograph-panel').hide();
            } else {
                $('#echograph-panel').show();
                refreshPanelStats();
            }
        });
    }

    // 轻量级API状态检查：用于主页面打开后延迟检查一次，不弹窗，只更新状态指示
    async function checkAPIStatus() {
        try {
            const response = await fetch(`${pluginSettings.api_base_url}/health`, {
                signal: AbortSignal.timeout(5000)
            });
            const statusElement = $('#cf-main-api-status');
            if (response.ok) {
                // 更新主页面与面板状态
                statusElement.removeClass('cf-status-disconnected cf-status-unknown')
                             .addClass('cf-status-connected')
                             .text('已连接');
                updatePanelStatus('连接正常', 'connected');
            } else {
                statusElement.removeClass('cf-status-connected cf-status-unknown')
                             .addClass('cf-status-disconnected')
                             .text('连接失败');
                updatePanelStatus('连接异常', 'disconnected');
            }
        } catch (error) {
            const statusElement = $('#cf-main-api-status');
            statusElement.removeClass('cf-status-connected cf-status-unknown')
                         .addClass('cf-status-disconnected')
                         .text('连接断开');
            updatePanelStatus('连接断开', 'disconnected');
            logDebug('轻量API状态检查异常', error?.message || String(error));
        }
    }


    function updateMainPageStatus() {
        const context = getSillyTavernContext();
        const character = context.characters?.[context.characterId];

        // Initialize connection status as disconnected, don't auto-set to connected
        const statusElement = $('#cf-main-api-status');
        if (statusElement.length && !statusElement.hasClass('cf-status-connected')) {
            statusElement.removeClass('cf-status-connected cf-status-unknown')
                        .addClass('cf-status-disconnected')
                        .text('未连接');
        }

        // Update session and character info
        $('#cf-main-session-status').text(currentSessionId ? currentSessionId.substring(0, 8) + '...' : '未初始化');
        $('#cf-main-character-status').text(character?.name || '无');

        // Update window capacity
        $('#cf-main-window-capacity').text(pluginSettings?.sliding_window?.window_size || 4);

        // Update last update time
        $('#cf-main-last-update').text(new Date().toLocaleTimeString());
    }

    async function refreshMainPageStats() {
        try {
            if (!currentSessionId) {
                $('#cf-main-window-turns, #cf-main-processed-turns, #cf-main-conflicts-resolved').text('0');
                $('#cf-main-graph-nodes, #cf-main-graph-edges, #cf-main-memory-turns').text('0');
                return;
            }

            const stats = await sendWsRequest('sessions.stats', { session_id: currentSessionId }, 10000);
            if (stats) {
                $('#cf-main-graph-nodes').text(stats.graph_nodes || 0);
                $('#cf-main-graph-edges').text(stats.graph_edges || 0);
                $('#cf-main-memory-turns').text(stats.hot_memory_size || 0);

                // Update sliding window specific stats if available
                if (stats.sliding_window_size !== undefined) {
                    $('#cf-main-window-turns').text(stats.sliding_window_size);
                    $('#cf-main-processed-turns').text(stats.processed_turns || 0);
                }

                addMainPageLog('统计数据已刷新', 'success');
            } else {
                addMainPageLog('刷新统计失败', 'error');
            }
        } catch (error) {
            addMainPageLog('刷新统计错误: ' + error.message, 'error');
        }
    }

    function addMainPageLog(message, type = 'info') {
        // Only add to main page log if it's open
        const logContainer = $('#cf-main-activity-log');
        if (!logContainer.length) return;

        const timestamp = new Date().toLocaleTimeString();

        const typeColors = {
            success: '#27ae60',
            warning: '#f39c12',
            error: '#e74c3c',
            info: '#4a90e2'
        };

        const color = typeColors[type] || typeColors.info;

        const logHtml = `
            <div style="margin-bottom: 8px; padding: 6px; border-left: 3px solid ${color}; background: rgba(255,255,255,0.02);">
                <div style="color: ${color}; font-weight: 500;">${message}</div>
                <div style="color: #7f8c8d; font-size: 11px; margin-top: 2px;">${timestamp}</div>
            </div>
        `;

        logContainer.prepend(logHtml);

        // Keep only the last 20 log entries
        const items = logContainer.children();
        if (items.length > 20) {
            items.slice(20).remove();
        }
    }

    function addMenuItems() {
        // Add standalone plugin page to extensions menu - try multiple selectors for compatibility
        logDebug('尝试添加菜单项到扩展菜单...');

        // 尝试多种可能的扩展菜单选择器
        const possibleSelectors = [
            '#rm_extensions_block .extensions_block',  // 原选择器
            '#extensions_block',                       // 简化选择器
            '.extensions_block',                       // 通用类选择器
            '#rm_extensions_block',                    // 父容器
            '[data-extension-menu]',                   // 数据属性选择器
            '.extension-settings'                      // 设置相关选择器
        ];

        let extensionsBlock = null;
        for (const selector of possibleSelectors) {
            extensionsBlock = $(selector);
            if (extensionsBlock.length > 0) {
                logDebug(`找到扩展菜单容器: ${selector}`);
                break;
            }
        }

        // 如果还是找不到，尝试查找任何包含"extension"的元素
        if (!extensionsBlock || extensionsBlock.length === 0) {
            logDebug('尝试查找包含extension的元素...');
            $('[class*="extension"], [id*="extension"]').each(function() {
                logDebug(`发现可能的扩展元素: ${this.className} (ID: ${this.id})`);
            });

            // 作为最后的备选方案，添加到主菜单或导航栏
            extensionsBlock = $('#nav_menu, .navbar, .main-menu, body');
            logDebug('使用备选容器添加菜单项');
        }

        if (extensionsBlock && extensionsBlock.length && !$('#echograph-menu-item').length) {
            const menuItem = $(`
                <div id="echograph-menu-item" class="list-group-item flex-container flexGap5 interactable" style="
                    cursor: pointer;
                    padding: 8px 12px;
                    margin: 2px 0;
                    border: 1px solid #dee2e6;
                    border-radius: 4px;
                    background: #f8f9fa;
                    transition: background-color 0.2s;
                ">
                    <div class="fa-solid fa-brain extensionsMenuExtensionButton" style="color: #4a90e2;"></div>
                    <span style="margin-left: 8px; font-weight: 500;">EchoGraph 滑动窗口</span>
                </div>
            `);

            menuItem.on('click', () => {
                logDebug('EchoGraph菜单项被点击');
                showEchoGraphMainPage();
            });

            menuItem.on('mouseenter', function() {
                $(this).css('background-color', '#e9ecef');
            }).on('mouseleave', function() {
                $(this).css('background-color', '#f8f9fa');
            });

            extensionsBlock.append(menuItem);
            logDebug('EchoGraph菜单项已添加到扩展菜单');

            // 同时添加一个浮动按钮作为备用入口
            addFloatingButton();
        } else {
            logDebug('无法找到合适的扩展菜单容器，仅添加浮动按钮');
            addFloatingButton();
        }
    }

    function addFloatingButton() {
        // 添加浮动按钮作为备用UI入口
        if (!$('#echograph-floating-btn').length) {
            const floatingBtn = $(`
                <div id="echograph-floating-btn" style="
                    position: fixed;
                    top: 20px;
                    right: 80px;
                    width: 45px;
                    height: 45px;
                    background: linear-gradient(135deg, #4a90e2 0%, #357abd 100%);
                    border-radius: 50%;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    cursor: pointer;
                    box-shadow: 0 4px 20px rgba(74,144,226,0.3);
                    z-index: 9998;
                    transition: all 0.3s ease;
                    color: white;
                    font-size: 16px;
                    font-weight: bold;
                " title="打开 EchoGraph 界面">
                    CF
                </div>
            `);

            floatingBtn.on('click', () => {
                logDebug('EchoGraph浮动按钮被点击');
                showEchoGraphMainPage();
            });

            floatingBtn.on('mouseenter', function() {
                $(this).css('transform', 'scale(1.1)');
            }).on('mouseleave', function() {
                $(this).css('transform', 'scale(1)');
            });

            $('body').append(floatingBtn);
            logDebug('EchoGraph浮动按钮已添加');
        }
    }

    // 加载插件设置
    loadSettings();

    // Create UI elements
    createDebugPanel();

    // Add menu items with multiple retry attempts to ensure SillyTavern UI is ready
    let menuRetryCount = 0;
    const maxMenuRetries = 5;

    function tryAddMenuItems() {
        menuRetryCount++;
        logDebug(`尝试添加菜单项 (第${menuRetryCount}次尝试)`);

        addMenuItems();

        // 检查是否成功添加了菜单项或浮动按钮
        const hasMenuItem = $('#echograph-menu-item').length > 0;
        const hasFloatingBtn = $('#echograph-floating-btn').length > 0;

        if (!hasMenuItem && !hasFloatingBtn && menuRetryCount < maxMenuRetries) {
            logDebug(`菜单项添加失败，${2000 * menuRetryCount}ms后重试...`);
            setTimeout(tryAddMenuItems, 2000 * menuRetryCount); // 递增延迟
        } else {
            logDebug(`菜单项添加完成 - 菜单项: ${hasMenuItem}, 浮动按钮: ${hasFloatingBtn}`);
        }
    }

    // 立即尝试一次，然后延迟重试
    tryAddMenuItems();
    setTimeout(tryAddMenuItems, 1000);
    setTimeout(tryAddMenuItems, 3000);
    setTimeout(tryAddMenuItems, 5000);

        // Show debug panel if enabled
        if (pluginSettings.debug_mode) {
            $('#echograph-panel').show();
            updatePanelStatus('System initialized', 'connected');
            refreshPanelStats();
        }

        // 添加心跳检测机制，保持与API的连接
        let heartbeatInterval = null;

        function startHeartbeat() {
            if (heartbeatInterval) {
                clearInterval(heartbeatInterval);
            }

            // 每30秒检查一次API连接状态
            heartbeatInterval = setInterval(async () => {
                if (!pluginSettings?.enabled) {
                    return;
                }

                try {
                    logDebug('💗 执行心跳检测...');
                    const response = await fetch(`${pluginSettings.api_base_url}/health`, {
                        signal: AbortSignal.timeout(5000)
                    });

                    if (response.ok) {
                        lastHealthOk = true;
                        const data = await response.json();
                        logDebug(`💗 心跳检测成功 - 活跃会话: ${data.active_sessions}`);

                        // 更新连接状态指示器
                        updatePanelStatus('连接正常', 'connected');

                        // 如果主页面打开，更新API状态
                        const statusElement = $('#cf-main-api-status');
                        if (statusElement.length) {
                            statusElement
                                .removeClass('cf-status-disconnected cf-status-unknown')
                                .addClass('cf-status-connected')
                                .text('已连接');
                        }
                    } else {
                        logDebug(`💔 心跳检测失败 - HTTP ${response.status}`);
                        updatePanelStatus('连接异常', 'disconnected');

                        // 更新主页面状态
                        const statusElement = $('#cf-main-api-status');
                        if (statusElement.length) {
                            statusElement
                                .removeClass('cf-status-connected cf-status-unknown')
                                .addClass('cf-status-disconnected')
                                .text('连接异常');
                        }
                    }
                } catch (error) {
                    logDebug(`💔 心跳检测异常: ${error.message}`);
                    updatePanelStatus('连接断开', 'disconnected');

                    // 更新主页面状态
                    const statusElement = $('#cf-main-api-status');
                    if (statusElement.length) {
                        statusElement
                            .removeClass('cf-status-connected cf-status-unknown')
                            .addClass('cf-status-disconnected')
                            .text('连接断开');
                    }
                }
            }, 30000); // 30秒间隔

            logDebug('💗 心跳检测已启动 (30秒间隔)');
        }

        function stopHeartbeat() {
            if (heartbeatInterval) {
                clearInterval(heartbeatInterval);
                heartbeatInterval = null;
                logDebug('💔 心跳检测已停止');
            }
        }

        // 启动心跳检测
        if (pluginSettings?.enabled) {
            startHeartbeat();
        }

        // CHAT_CHANGED处理逻辑 - 简化版本，参考st-memory-enhancement的直接处理方式
        async function onChatChanged() {
            console.log('[EchoGraph] 🔄 onChatChanged 被调用');
            logDebug('🔄 onChatChanged 被调用');

            try {
                // 获取当前上下文以检测角色变化
                const context = getSillyTavernContext();
                const currentCharacterId = context.characterId;

                console.log('[EchoGraph] onChatChanged - 角色信息:', {
                    characterId: currentCharacterId,
                    characterIdType: typeof currentCharacterId,
                    hasCharacters: !!context.characters,
                    charactersCount: Object.keys(context.characters || {}).length,
                    characterKeys: Object.keys(context.characters || {}),
                    availableCharacterIds: Object.keys(context.characters || {})
                });

                // 如果没有选择角色，直接返回，不执行后续逻辑
                if (currentCharacterId === null || currentCharacterId === undefined || currentCharacterId === -1 || currentCharacterId === '') {
                    console.log('[EchoGraph] CHAT_CHANGED: 没有选择角色，跳过处理');
                    logDebug('CHAT_CHANGED: 没有选择角色，跳过处理');
                    return;
                }

                logDebug('CHAT_CHANGED: 检测到有效角色，开始处理', {
                    characterId: currentCharacterId,
                    characterName: context.characters?.[currentCharacterId]?.name
                });

                // 检查是否需要初始化
                const hasCharacterChanged = (lastCharacterId !== currentCharacterId);
                console.log('[EchoGraph] 角色变化检查:', {
                    hasCharacterChanged,
                    currentCharacterId,
                    lastCharacterId,
                    currentSessionId
                });

                if (hasCharacterChanged || !currentSessionId) {
                    console.log('[EchoGraph] 开始初始化会话...');
                    const initResult = await initializeSession('CHAT_CHANGED');
                    if (initResult) {
                        console.log('[EchoGraph] 会话初始化成功');
                        addActivityLog(`角色切换成功: ${context.characters?.[currentCharacterId]?.name}`, 'success');
                    } else {
                        console.log('[EchoGraph] 会话初始化失败');
                        addActivityLog('角色切换失败', 'error');
                    }
                } else {
                    console.log('[EchoGraph] 无需初始化（相同角色且有会话）');
                }

            } catch (error) {
                console.error(`${PLUGIN_NAME}: Error in CHAT_CHANGED handler:`, error);
                addActivityLog(`CHAT_CHANGED处理错误: ${error.message}`, 'error');
            }
        }

        // 消息编辑处理
        async function onMessageEdited(this_edit_mes_id) {
            if (!pluginSettings?.enabled || !currentSessionId) return;
            logDebug('Message edited, syncing conversation state');
            syncConversationState();
        }

        // 消息滑动处理
        async function onMessageSwiped(chat_id) {
            if (!pluginSettings?.enabled || !currentSessionId) return;
            logDebug('Message swiped, syncing conversation state');
            syncConversationState();
        }

        // 监听主程序事件 - 使用SillyTavern官方推荐的方式
        console.log('[EchoGraph] 开始绑定事件...');

        try {
            // 使用SillyTavern官方推荐的获取方式
            const context = getContext();
            const { eventSource, event_types } = context || {};

            console.log('[EchoGraph] 事件系统检查:', {
                hasContext: !!context,
                hasEventSource: !!eventSource,
                hasEventTypes: !!event_types,
                eventSourceType: typeof eventSource,
                eventSourceOn: typeof eventSource?.on,
                eventTypesKeys: Object.keys(event_types || {}),
                contextKeys: Object.keys(context || {})
            });

            if (eventSource && typeof eventSource.on === 'function' && event_types) {
                console.log('[EchoGraph] ✅ 使用官方 getContext() 方式绑定事件');

                eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onMessageReceived);
                console.log('[EchoGraph] ✅ 已绑定 CHARACTER_MESSAGE_RENDERED');

                eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, onChatCompletionPromptReady);
                console.log('[EchoGraph] ✅ 已绑定 CHAT_COMPLETION_PROMPT_READY');

                eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
                console.log('[EchoGraph] ✅ 已绑定 CHAT_CHANGED');

                eventSource.on(event_types.MESSAGE_EDITED, onMessageEdited);
                console.log('[EchoGraph] ✅ 已绑定 MESSAGE_EDITED');

                eventSource.on(event_types.MESSAGE_SWIPED, onMessageSwiped);
                console.log('[EchoGraph] ✅ 已绑定 MESSAGE_SWIPED');

                eventSource.on(event_types.MESSAGE_DELETED, onChatChanged);
                console.log('[EchoGraph] ✅ 已绑定 MESSAGE_DELETED');

                console.log('[EchoGraph] 🎉 所有事件绑定完成！');

            } else {
                console.log('[EchoGraph] ⚠️ SillyTavern.getContext() 事件系统不可用');
            }

        } catch (error) {
            console.error('[EchoGraph] 事件绑定过程中出现异常:', error);
        }

        // 正确的SillyTavern事件绑定方式（根据官方文档）
        console.log('[EchoGraph] 使用官方推荐的 SillyTavern.getContext() 方式绑定事件');

        try {
            // 使用官方推荐的方式获取事件源
            const { eventSource, event_types } = SillyTavern.getContext();

            console.log('[EchoGraph] SillyTavern.getContext() 返回:', {
                hasEventSource: !!eventSource,
                hasEventTypes: !!event_types,
                eventSourceType: typeof eventSource,
                eventSourceOn: typeof eventSource?.on,
                eventTypes: event_types ? Object.keys(event_types) : 'undefined'
            });

            if (eventSource && typeof eventSource.on === 'function' && event_types) {
                // 绑定CHAT_CHANGED事件
                eventSource.on(event_types.CHAT_CHANGED, function(data) {
                    console.log('[EchoGraph] 🎉 官方 CHAT_CHANGED 事件触发!', data);

                    // 给SillyTavern时间完成切换
                    setTimeout(() => {
                        console.log('[EchoGraph] 延迟执行 onChatChanged...');
                        onChatChanged();
                    }, 200);
                });

                // 绑定其他相关事件
                if (event_types.CHARACTER_MESSAGE_RENDERED) {
                    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onMessageReceived);
                    console.log('[EchoGraph] ✅ 已绑定 CHARACTER_MESSAGE_RENDERED');
                }

                if (event_types.CHAT_COMPLETION_PROMPT_READY) {
                    eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, onChatCompletionPromptReady);
                    console.log('[EchoGraph] ✅ 已绑定 CHAT_COMPLETION_PROMPT_READY');
                }

                if (event_types.MESSAGE_EDITED) {
                    eventSource.on(event_types.MESSAGE_EDITED, onMessageEdited);
                    console.log('[EchoGraph] ✅ 已绑定 MESSAGE_EDITED');
                }

                if (event_types.MESSAGE_SWIPED) {
                    eventSource.on(event_types.MESSAGE_SWIPED, onMessageSwiped);
                    console.log('[EchoGraph] ✅ 已绑定 MESSAGE_SWIPED');
                }

                console.log('[EchoGraph] 🎉 所有官方事件绑定完成！现在等待角色切换...');

            } else {
                console.error('[EchoGraph] ❌ SillyTavern.getContext() 没有提供有效的事件系统');
                console.log('[EchoGraph] 调试信息:', {
                    SillyTavernExists: typeof SillyTavern !== 'undefined',
                    getContextExists: typeof SillyTavern?.getContext === 'function',
                    contextResult: SillyTavern ? SillyTavern.getContext() : 'SillyTavern undefined'
                });
            }

        } catch (error) {
            console.error('[EchoGraph] 官方事件绑定失败:', error);

            // 降级：尝试直接从全局获取
            console.log('[EchoGraph] 尝试直接访问全局 eventSource...');

            if (typeof window !== 'undefined' && window.eventSource && window.event_types) {
                try {
                    window.eventSource.on(window.event_types.CHAT_CHANGED, function(data) {
                        console.log('[EchoGraph] 🎉 全局 CHAT_CHANGED 事件触发!', data);
                        setTimeout(() => onChatChanged(), 200);
                    });
                    console.log('[EchoGraph] ✅ 成功使用全局 eventSource 绑定');
                } catch (e) {
                    console.error('[EchoGraph] 全局 eventSource 绑定也失败:', e);
                }
            }
        }

        // 初始化session（如果设置允许且有角色）
        if (pluginSettings.auto_initialize) {
            setTimeout(async () => {
                console.log('[EchoGraph] 自动初始化开始...');
                try {
                    await onChatChanged(); // 直接调用聊天变更处理函数
                } catch (e) {
                    console.error('[EchoGraph] Auto-initialization failed:', e);
                    logDebug('Auto-initialization failed:', e?.message);
                }
            }, 1000); // 简化延迟时间
        }

        // 添加全局测试函数，方便手动调试
        window.testEchoGraphOnChatChanged = async () => {
            console.log('[EchoGraph] 手动测试 onChatChanged...');
            await onChatChanged();
        };

        console.log('[EchoGraph] 提示: 可以在浏览器控制台运行 testEchoGraphOnChatChanged() 来手动测试事件处理');

        // 不要自动检测API连接状态 - 只有在用户明确需要时才连接
        // 这样避免在未使用EchoGraph时过早建立连接

        updateDebugPanel();

        console.log(`${PLUGIN_NAME}: RAG Enhancer plugin v${PLUGIN_VERSION} successfully loaded.`);
        showNotification(`${PLUGIN_NAME} v${PLUGIN_VERSION} loaded successfully`, 'success');

        // Show panel toggle for easy access
        showPanelToggle();

    // --- Panel Management Functions ---

    function updatePanelStatus(status, connectionState) {
        const statusIndicator = $('#cf-api-status');
        statusIndicator.removeClass('cf-status-connected cf-status-disconnected cf-status-unknown');

        switch (connectionState) {
            case 'connected':
                statusIndicator.addClass('cf-status-connected').text('已连接');
                break;
            case 'disconnected':
                statusIndicator.addClass('cf-status-disconnected').text('已断开');
                break;
            default:
                statusIndicator.addClass('cf-status-unknown').text('未知');
        }

        // Update session and character info
        $('#cf-session-status').text(currentSessionId || '未初始化');

        // 安全获取当前角色信息
        const context = getSillyTavernContext();
        const currentCharacter = context.characters?.[context.characterId];
        $('#cf-character-status').text(currentCharacter?.name || '无');
    }

    function addActivityLog(message, type = 'info') {
        const timestamp = new Date().toLocaleTimeString();
        const activityClass = type === 'success' ? 'cf-activity-success' :
                              type === 'warning' ? 'cf-activity-warning' :
                              type === 'error' ? 'cf-activity-error' : 'cf-activity-info';

        const activityHtml = `
            <div class="cf-activity-item ${activityClass}">
                <div>${message}</div>
                <span class="cf-timestamp">${timestamp}</span>
            </div>
        `;

        const logContainer = $('#cf-activity-log');
        if (logContainer.length) {
            logContainer.prepend(activityHtml);

            // Keep only the last 20 log entries
            const items = logContainer.children();
            if (items.length > 20) {
                items.slice(20).remove();
            }
        }

        // Also update main page log if it exists
        addMainPageLog(message, type);
    }

    async function refreshPanelStats() {
        if (!currentSessionId) {
            $('#cf-graph-nodes').text('0');
            $('#cf-graph-edges').text('0');
            $('#cf-memory-turns').text('0');
            return;
        }

        try {
            try {
                const stats = await sendWsRequest('sessions.stats', { session_id: currentSessionId }, 10000);
                $('#cf-graph-nodes').text(stats.graph_nodes || 0);
                $('#cf-graph-edges').text(stats.graph_edges || 0);
                $('#cf-memory-turns').text(stats.conversation_turns || 0);
                addActivityLog('统计刷新成功', 'success');
            } catch (e) {
                addActivityLog('统计刷新失败', 'error');
            }
        } catch (error) {
            logDebug('Error refreshing panel stats', error);
            addActivityLog('统计刷新错误: ' + error.message, 'error');
        }
    }

    async function clearMemory() {
        if (!currentSessionId) {
            addActivityLog('没有活动的会话可清除', 'warning');
            return;
        }

        try {
            const response = await fetch(`${pluginSettings.api_base_url}/ui_test/clear_data`, {
                method: 'POST'
            });

            if (response.ok) {
                addActivityLog('记忆清除成功', 'success');
                refreshPanelStats();
            } else {
                addActivityLog('记忆清除失败', 'error');
            }
        } catch (error) {
            logDebug('Error clearing memory', error);
            addActivityLog('记忆清除错误: ' + error.message, 'error');
        }
    }

    async function performQuickReset() {
        try {
            addActivityLog('开始执行快速清理...', 'info');

            // 先断开WebSocket连接
            if (webSocket) {
                logDebug('[Reset] Disconnecting WebSocket before system reset...');
                disconnectWebSocket();
            }

            // 调用服务器的快速清理端点
            const response = await fetch(`${pluginSettings.api_base_url}/system/quick_reset`, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json'
                }
            });

            if (response.ok) {
                const result = await response.json();

                if (result.success) {
                    // 清理客户端状态
                    currentSessionId = null;
                    lastCharacterId = null;
                    isInitializing = false;
                    initializationPromise = null;

                    addActivityLog(`快速清理完成！清理了 ${result.cleared_counts.total} 个对象`, 'success');
                    addActivityLog('服务器状态已重置，可以重新选择角色', 'info');

                    // 刷新统计面板
                    setTimeout(() => {
                        refreshPanelStats();
                        if (typeof refreshMainPageStats === 'function') {
                            refreshMainPageStats();
                        }
                    }, 1000);
                } else {
                    addActivityLog('快速清理失败: ' + (result.message || '未知错误'), 'error');
                }
            } else {
                const errorText = await response.text();
                addActivityLog('快速清理请求失败: ' + response.status + ' ' + errorText, 'error');
            }
        } catch (error) {
            logDebug('Error performing quick reset', error);
            addActivityLog('快速清理错误: ' + error.message, 'error');
        }
    }

    async function exportKnowledgeGraph() {
        if (!currentSessionId) {
            addActivityLog('没有活动的会话可导出', 'warning');
            return;
        }

        try {
            const response = await fetch(`${pluginSettings.api_base_url}/sessions/${currentSessionId}/export`);
            if (response.ok) {
                const data = await response.blob();
                const url = window.URL.createObjectURL(data);
                const a = document.createElement('a');
                a.href = url;
                a.download = `echograph-graph-${currentSessionId.slice(0,8)}.json`;
                document.body.appendChild(a);
                a.click();
                window.URL.revokeObjectURL(url);
                document.body.removeChild(a);

                addActivityLog('图谱导出成功', 'success');
            } else {
                addActivityLog('图谱导出失败', 'error');
            }
        } catch (error) {
            logDebug('Error exporting graph', error);
            addActivityLog('图谱导出错误: ' + error.message, 'error');
        }
    }

    async function testAPIConnection() {
        try {
            addActivityLog('正在测试API连接...', 'info');
            updatePanelStatus('测试连接中...', 'unknown');

            const response = await fetch(`${pluginSettings.api_base_url}/health`, {
                signal: AbortSignal.timeout(10000) // 10秒超时
            });

            if (response.ok) {
                lastHealthOk = true;
                const data = await response.json();
                updatePanelStatus('连接成功', 'connected');
                addActivityLog(`API连接成功 - 版本: ${data.version || '未知'}`, 'success');
                showNotification(`EchoGraph API 连接成功！\n版本: ${data.version}\n活跃会话: ${data.active_sessions}`, 'success');

                // 同时更新主页面的API状态
                const statusElement = $('#cf-main-api-status');
                if (statusElement.length) {
                    statusElement
                        .removeClass('cf-status-disconnected cf-status-unknown')
                        .addClass('cf-status-connected')
                        .text('已连接');
                }
            } else {
                updatePanelStatus('连接失败', 'disconnected');
                addActivityLog(`API连接失败 - HTTP ${response.status}`, 'error');
                showNotification(`API连接失败 (${response.status})\n请检查服务器地址和端口`, 'error');

                // 同时更新主页面的API状态
                const statusElement = $('#cf-main-api-status');
                if (statusElement.length) {
                    statusElement
                        .removeClass('cf-status-connected cf-status-unknown')
                        .addClass('cf-status-disconnected')
                        .text('连接失败');
                }
            }
        } catch (error) {
            updatePanelStatus('连接错误', 'disconnected');
            addActivityLog('API连接错误: ' + error.message, 'error');
            showNotification(`无法连接到EchoGraph API\n错误: ${error.message}\n\n请确认：\n1. EchoGraph服务器正在运行\n2. API地址正确 (当前: ${pluginSettings.api_base_url})`, 'error');

            // 同时更新主页面的API状态
            const statusElement = $('#cf-main-api-status');
            if (statusElement.length) {
                statusElement
                    .removeClass('cf-status-connected cf-status-unknown')
                    .addClass('cf-status-disconnected')
                    .text('未连接');
            }
        }
    }

    function showPanelToggle() {
        // Add a floating toggle button to show/hide the panel
        const toggleHtml = `
            <div id="cf-panel-toggle" style="
                position: fixed;
                bottom: 20px;
                right: 20px;
                width: 50px;
                height: 50px;
                background: linear-gradient(135deg, #4a90e2 0%, #357abd 100%);
                border-radius: 50%;
                display: flex;
                align-items: center;
                justify-content: center;
                cursor: pointer;
                box-shadow: 0 4px 20px rgba(74,144,226,0.3);
                z-index: 9999;
                transition: all 0.3s ease;
                color: white;
                font-size: 18px;
            " title="切换 EchoGraph 面板">
                CF
            </div>
        `;

        $('body').append(toggleHtml);

        $('#cf-panel-toggle').on('click', () => {
            if ($('#echograph-panel').is(':visible')) {
                $('#echograph-panel').hide();
            } else {
                $('#echograph-panel').show();
                refreshPanelStats();
            }
        });

        // Hover effects
        $('#cf-panel-toggle').on('mouseenter', function() {
            $(this).css('transform', 'scale(1.1)');
        }).on('mouseleave', function() {
            $(this).css('transform', 'scale(1)');
        });
    }

    console.log("______________________EchoGraph插件：加载完成______________________");
});
