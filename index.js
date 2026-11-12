/**
 * EchoGraph RAG Enhancer Plugin for SillyTavern
 * Enhanced with UI integration, configuration management, and debugging capabilities
 * Based on analysis of st-memory-enhancement architecture
 */

const ST = (typeof window !== 'undefined' ? window : globalThis);
const getContext = () => ST.SillyTavern.getContext();

// 插件主逻辑包装在jQuery ready函数中，这是SillyTavern插件的标准做法
jQuery(async () => {
    if (ST.__echoGraphPluginLoaded) return;
    ST.__echoGraphPluginLoaded = true;
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
    let reconnectTimer = null;
    let reconnectAttempt = 0;
    let sessionEpoch = 0;
    const processedMessages = new Map();
    const renderedMessages = new Map();
    const pendingPrompts = new WeakSet();
    const messageIds = new WeakMap();
    let nextMessageId = 0;
    const clientInstanceId = Math.random().toString(36).slice(2);
    let activeChatKey = null;
    let generationType = null;

    function getChatKey(context) {
        const id = context.chatId ?? context.getCurrentChatId?.();
        const owner = context.groupId ? `group:${context.groupId}` : `character:${context.characterId}`;
        return `${owner}:${id ?? 'unknown'}`;
    }

    function messageKey(message) {
        if (!messageIds.has(message)) messageIds.set(message, `${clientInstanceId}-${++nextMessageId}`);
        return messageIds.get(message);
    }

    function switchChat(context) {
        const key = getChatKey(context);
        if (key === activeChatKey) return false;
        activeChatKey = key;
        sessionEpoch++;
        processedMessages.clear();
        seedRenderedMessages(context);
        return true;
    }

    function seedRenderedMessages(context) {
        renderedMessages.clear();
        (context.chat || []).forEach((message) => {
            if (message && !message.is_user) {
                renderedMessages.set(messageKey(message), String(message.mes ?? message.content ?? ''));
            }
        });
    }

    function cancelReconnect() {
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }

    function reconnectDelay(attempt) {
        return Math.min(30000, 1000 * 2 ** Math.min(attempt, 5));
    }

    function scheduleReconnect() {
        if (reconnectTimer || !pluginSettings?.enabled || !lastHealthOk || !currentSessionId) return;
        const delay = reconnectDelay(reconnectAttempt++);
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            if (pluginSettings?.enabled && lastHealthOk && currentSessionId) connectWebSocket(currentSessionId);
        }, delay);
    }


	    // 删除不再需要的事件绑定状态变量，因为使用了直接绑定方式

    /**
     * WebSocket Connection Management
     */
    function connectWebSocket(sessionId) {
        if (!pluginSettings?.enabled || !sessionId) return;
        const encodedId = encodeURIComponent(sessionId || '');
        const wsUrl = `${pluginSettings.api_base_url.replace(/^http/, 'ws')}/ws/tavern/${encodedId}`;
        cancelReconnect();

        // If there's an existing socket, avoid duplicate connects and close mismatched targets
        if (webSocket) {
            const sameTarget = webSocket.url === wsUrl;
            if (webSocket.readyState === WebSocket.OPEN) {
                if (sameTarget) {
                    logDebug(`[WS] WebSocket already connected for session ${sessionId}`);
                    return;
                }
                logDebug(`[WS] Closing open WebSocket to switch target...`);
                const oldSocket = webSocket;
                webSocket = null;
                rejectSocketRequests(oldSocket);
                try { oldSocket.close(1000, 'Switching session'); } catch (e) {}
            } else if (webSocket.readyState === WebSocket.CONNECTING) {
                if (sameTarget) {
                    logDebug(`[WS] Already connecting to target ${wsUrl}, skipping duplicate connect`);
                    return;
                }
                logDebug(`[WS] Closing connecting WebSocket to switch target...`);
                const oldSocket = webSocket;
                webSocket = null;
                rejectSocketRequests(oldSocket);
                try { oldSocket.close(1001, 'Switching during connect'); } catch (e) {}
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
            reconnectAttempt = 0;
            lastHealthOk = true;
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
                    if (entry && entry.socket === thisSocket && entry.epoch === sessionEpoch) {
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
                        if (webSocket !== thisSocket || (currentSessionId && sessionId !== currentSessionId)) return;
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

        thisSocket.onclose = (event) => {
            if (webSocket !== thisSocket) return; // ignore stale close
            if (event?.code === 1008) lastHealthOk = false;
            logDebug(`[WS] WebSocket connection closed.`);
            console.log('[EchoGraph WS] WebSocket connection closed.');
            showNotification('EchoGraph 已断开', 'warning');
            updatePanelStatus('未连接', 'disconnected');
            // reject all pending requests
            rejectSocketRequests(thisSocket);
            webSocket = null;
            scheduleReconnect();
        };

        thisSocket.onerror = (error) => {
            if (webSocket !== thisSocket) return; // ignore stale error
            console.error('[WS] WebSocket error:', error);
            showNotification('EchoGraph 连接错误', 'error');
            updatePanelStatus('错误', 'disconnected');
            try { thisSocket.close(); } catch (e) {}
        };
    }

    function disconnectWebSocket() {
        cancelReconnect();
        if (webSocket) {
            logDebug('[WS] Manually disconnecting WebSocket.');
            rejectSocketRequests(webSocket);
            webSocket.close();
            webSocket = null;
        }
    }
    // --- WS RPC helpers ---
    const pendingRequests = new Map();
    function rejectSocketRequests(socket) {
        for (const [id, entry] of pendingRequests) {
            if (entry.socket !== socket) continue;
            clearTimeout(entry.timer);
            pendingRequests.delete(id);
            entry.reject(new Error('WebSocket closed'));
        }
    }
    function genRequestId() { return `${Date.now()}-${Math.random().toString(36).slice(2,8)}`; }
    function isWsOpen() { return webSocket && webSocket.readyState === WebSocket.OPEN; }
    function sendWsRequest(action, payload = {}, timeoutMs = 20000) {
        return new Promise((resolve, reject) => {
            const epoch = sessionEpoch;
            const doSend = () => {
                if (epoch !== sessionEpoch || !isWsOpen()) return reject(new Error('Session changed'));
                const requestId = genRequestId();
                const socket = webSocket;
                const timer = setTimeout(() => {
                    if (pendingRequests.has(requestId)) {
                        pendingRequests.delete(requestId);
                        reject(new Error(`WS request timeout: ${action}`));
                    }
                }, timeoutMs);
                pendingRequests.set(requestId, { resolve, reject, timer, socket, epoch });
                try {
                    socket.send(JSON.stringify({ type: 'request', action, request_id: requestId, payload }));
                } catch (e) {
                    clearTimeout(timer);
                    pendingRequests.delete(requestId);
                    reject(e);
                }
            };

            if (!webSocket && currentSessionId && lastHealthOk) connectWebSocket(currentSessionId);
            const socket = webSocket;
            if (!socket) return reject(new Error('WebSocket not connected'));
            if (socket.readyState === WebSocket.OPEN) return doSend();
            if (socket.readyState !== WebSocket.CONNECTING) return reject(new Error('WebSocket not connected'));
            const start = Date.now();
            const waitForOpen = () => {
                if (epoch !== sessionEpoch || webSocket !== socket) return reject(new Error('Session changed'));
                if (socket.readyState === WebSocket.OPEN) return doSend();
                if (socket.readyState !== WebSocket.CONNECTING || Date.now() - start >= Math.min(timeoutMs, 10000)) {
                    return reject(new Error('WebSocket not connected'));
                }
                setTimeout(waitForOpen, 100);
            };
            waitForOpen();
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
        pluginSettings = Object.assign({}, DEFAULT_SETTINGS, getContext().extensionSettings[SETTINGS_KEY] || {});
        return pluginSettings;
    }

    function saveSettings() {
        // 使用SillyTavern标准的设置保存方式
        const context = getContext();
        context.extensionSettings[SETTINGS_KEY] = pluginSettings;
        context.saveSettingsDebounced();
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
    function escapeHtml(value) {
        return String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
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
            console.log("[EchoGraph] ========== 开始获取SillyTavern上下文 ==========");

            const context = getContext();
            console.log('[EchoGraph] Character context source: SillyTavern.getContext()', {
                success: true,
                hasContext: !!context
            });

            if (!context) {
                console.error('[EchoGraph] 无法获取SillyTavern上下文');
                return {
                    characterId: null,
                    characters: {},
                    chat: [],
                    worldInfoData: null,
                    extensionSettings: {}
                };
            }

            // 从 SillyTavern 上下文获取当前角色 ID
            let characterId = null;

            // 修复：0是有效的characterId，不应该被排除
            if (context.characterId !== undefined && context.characterId !== null && context.characterId !== -1 && context.characterId !== '') {
                characterId = context.characterId;
                console.log('[EchoGraph] 角色ID来源: context.characterId', characterId);
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
            console.log('[EchoGraph] 上下文信息详细分析', {
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
                console.warn('[EchoGraph] 检测到群聊模式，角色ID可能无效', {
                    groupId: context.groupId,
                    characterId: characterId
                });
            }

            // 如果有有效角色ID，记录角色详细信息
            // 修复：0是有效的characterId，不应该被排除
            if (characterId !== null && characterId !== undefined && characterId !== -1 && characterId !== '') {
                const character = characters[characterId];
                if (character) {
                    console.log('[EchoGraph] 当前角色详细信息', {
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
                        console.log('[EchoGraph] 角色描述预览:', character.description.substring(0, 200) + (character.description.length > 200 ? '...' : ''));
                    }
                    if (character.personality) {
                        console.log('[EchoGraph] 角色个性预览:', character.personality.substring(0, 200) + (character.personality.length > 200) ? '...' : '');
                    }
                    if (character.scenario) {
                        console.log('[EchoGraph] 角色场景预览:', character.scenario.substring(0, 200) + (character.scenario.length > 200 ? '...' : ''));
                    }
                } else {
                    console.warn('[EchoGraph] 警告: 角色ID存在但无角色数据', {
                        characterId: characterId,
                        availableCharacterIds: Object.keys(characters || {}),
                        charactersType: typeof characters
                    });
                }
            } else {
                console.info('[EchoGraph] 当前没有选中有效角色', {
                    characterId: characterId,
                    isGroupChat: !!context.groupId,
                    availableCharacters: Object.keys(characters || {}).length,
                    availableCharacterIds: Object.keys(characters || {})
                });

                // 如果没有角色但有角色列表，显示可用角色
                if (Object.keys(characters || {}).length > 0) {
                    console.log('[EchoGraph] 可用角色列表:');
                    Object.entries(characters).forEach(([id, char]) => {
                        console.log(`- ID: ${id}, 名称: ${char.name || 'Unknown'}`);
                    });
                }
            }

            console.log("[EchoGraph] ========== 上下文获取完成 ==========");

            return {
                characterId: characterId,
                characters: characters,
                chat: context.chat || [],
                worldInfoData: worldInfoData,
                groupId: context.groupId,
                extensionSettings: context.extensionSettings || {},
                ...context
            };
        } catch (error) {
            console.error(`[EchoGraph] Error getting context:`, error);
            console.error('[EchoGraph] 获取上下文失败', {
                error: error.message,
                stack: error.stack
            });
            return {
                characterId: null,
                characters: {},
                chat: [],
                worldInfoData: null,
                extensionSettings: {}
            };
        }
    }

    /**
     * Submit character data to the backend for use by initialization process
     */
    async function submitCharacterDataToBackend(characterId, character) {
        const epoch = sessionEpoch;
        try {
            console.log('[EchoGraph] ========== 开始提交角色数据到后台 ==========');
            console.log('[EchoGraph] 提交参数:', {
                characterId: characterId,
                characterName: character.name || 'Unknown',
                hasData: !!character
            });

            // 获取上下文，包含世界书信息
            const context = getSillyTavernContext();
            const worldInfo = await getEnhancedWorldInfo(context);
            if (epoch !== sessionEpoch) return false;

            // 构建完整的角色数据，包含世界书
            const characterData = {
                name: character.name || 'Unknown Character',
                description: character.description || character.data?.description || '',
                personality: character.personality || character.data?.personality || '',
                scenario: character.scenario || character.data?.scenario || '',
                first_mes: character.first_mes || character.data?.first_mes || '',
                mes_example: character.mes_example || character.data?.mes_example || '',
                avatar: character.avatar || '',
                world_info: worldInfo, //  关键修复：包含世界书信息
                // 包含所有原始数据，以防有遗漏的字段
                raw_character: character,
                raw_data: character.data || {}
            };

            console.log('[EchoGraph] 完整角色数据:', {
                name: characterData.name,
                descriptionLength: characterData.description.length,
                personalityLength: characterData.personality.length,
                scenarioLength: characterData.scenario.length,
                firstMesLength: characterData.first_mes.length,
                exampleLength: characterData.mes_example.length,
                worldInfoLength: characterData.world_info.length, //  添加世界书长度日志
                hasAvatar: !!characterData.avatar,
                rawCharacterKeys: Object.keys(character),
                rawDataKeys: Object.keys(character.data || {})
            });

            // 记录每个重要字段的预览
            if (characterData.description) {
                console.log('[EchoGraph] 描述预览:', characterData.description.substring(0, 200));
            }
            if (characterData.personality) {
                console.log('[EchoGraph] 个性预览:', characterData.personality.substring(0, 200));
            }
            if (characterData.scenario) {
                console.log('[EchoGraph] 场景预览:', characterData.scenario.substring(0, 200));
            }
            if (characterData.world_info && characterData.world_info.length > 0) {
                console.log('[EchoGraph] 世界书预览:', characterData.world_info.substring(0, 200));
            } else {
                console.log('[EchoGraph] 世界书为空或未获取到');
            }

            // 发送到后台API
            const submitRequest = {
                character_id: characterId.toString(),
                character_name: characterData.name,
                character_data: characterData,
                timestamp: Date.now() / 1000
            };

            // 确保先建立WS连接（使用该角色的一致会话ID）
            if (epoch !== sessionEpoch) return false;
            ensureWsForCharacter(characterData.name, {force: true});

            console.log('[EchoGraph] 发送角色数据到后台(WS):', {
                action: 'tavern.submit_character',
                character_id: submitRequest.character_id,
                character_name: submitRequest.character_name,
                timestamp: submitRequest.timestamp
            });

            try {
                const result = await sendWsRequest('tavern.submit_character', submitRequest, 10000);
                console.log('[EchoGraph] 角色数据提交成功:', result);
                logDebug('Character data submitted successfully', {
                    characterId: characterId,
                    characterName: characterData.name,
                    success: result.success,
                    message: result.message
                });
                return true;
            } catch (e) {
                console.error('[EchoGraph] 角色数据提交失败(WS):', e);
                logDebug('Character data submission failed', { error: e?.message });
                return false;
            }

        } catch (error) {
            console.error('[EchoGraph] 角色数据提交异常:', error);
            logDebug('Character data submission exception', error);
            return false;
        } finally {
            console.log('[EchoGraph] ========== 角色数据提交流程结束 ==========');
        }
    }

    /**
     * Enhanced session initialization with better error handling and configuration
     */
    async function initializeSession(caller = 'unknown', forceReinit = false) {
        logDebug(`initializeSession called by: ${caller}, force: ${forceReinit}`);
        const epoch = sessionEpoch;

        // 如果已经在初始化，返回现有的Promise（除非强制重新初始化）
        if (initializationPromise && !forceReinit) {
            logDebug('Initialization already in progress, waiting for existing promise...');
            return await initializationPromise;
        }

        // 创建新的初始化Promise
        initializationPromise = performInitialization(caller, forceReinit);
        const thisPromise = initializationPromise;

        try {
            const result = await thisPromise;
            return epoch === sessionEpoch ? result : false;
        } finally {
            if (initializationPromise === thisPromise) initializationPromise = null;
        }
    }

    async function performInitialization(caller, forceReinit = false) {
        const epoch = sessionEpoch;
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
            const modeResponse = await fetch(`${pluginSettings.api_base_url}/system/tavern_mode`, { signal: AbortSignal.timeout(5000) });
            if (!modeResponse.ok) throw new Error(`Tavern mode check failed: HTTP ${modeResponse.status}`);
            const mode = await modeResponse.json();
            if (!mode.active) {
                lastHealthOk = false;
                addActivityLog('EchoGraph 后台未启用酒馆模式', 'warning');
                return false;
            }
            lastHealthOk = true;
            if (epoch !== sessionEpoch) return false;
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
                if (epoch !== sessionEpoch) return false;
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

                        //  关键修复：向空会话提交角色数据
                        const submitSuccess = await submitCharacterDataToBackend(characterId, character);
                        if (epoch !== sessionEpoch) return false;
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
            if (epoch !== sessionEpoch) return false;

            logDebug('Extracted character data', {
                characterName: characterData.name,
                descriptionLength: characterData.description.length,
                personalityLength: characterData.personality.length,
                scenarioLength: characterData.scenario.length,
                worldInfoLength: worldInfo.length
            });

            //  关键修复：首先向后台提交角色数据，供初始化流程使用
            logDebug('Submitting character data to backend before initialization...');
            const submitSuccess = await submitCharacterDataToBackend(characterId, character);
            if (epoch !== sessionEpoch) return false;

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
                if (epoch !== sessionEpoch) return false;
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
            if (epoch === sessionEpoch) isInitializing = false;
        }
    }

    /**
     * Enhanced world info extraction including lorebook entries with detailed logging
     */
    async function getEnhancedWorldInfo(context) {
        let worldInfo = '';
        let sources = [];

        console.log('[EchoGraph]  开始提取世界书信息');

        try {
            if (context) {
                const stContext = context;

                // 使用官方的getWorldInfoPrompt函数
                if (typeof stContext.getWorldInfoPrompt === 'function') {
                    console.log('[EchoGraph]  调用官方getWorldInfoPrompt函数...');

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
                            console.log('[EchoGraph]  从官方API获取到世界书内容:', worldInfoResult.length, '字符');
                        } else {
                            console.log('[EchoGraph]  getWorldInfoPrompt返回空结果');
                        }

                    } catch (promptError) {
                        console.log('[EchoGraph]  getWorldInfoPrompt调用失败，尝试其他方法:', promptError.message);
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
                                console.log(`[EchoGraph]  从角色 ${field} 获取到世界书内容:`, worldContent.length, '字符');
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
                    console.log(`[EchoGraph]  备用方法：已添加 ${activeEntries.length} 个世界书条目`);
                }
            }

        } catch (error) {
            console.error('[EchoGraph]  世界书信息提取错误:', error);
        }

        const finalStats = {
            总长度: worldInfo.length,
            信息来源: sources,
            来源数量: sources.length
        };

        console.log('[EchoGraph]  世界信息提取完成', finalStats);
        return worldInfo || 'No world information available.';
    }

    /**
     * Enhanced prompt processing with better context management
     */
    async function onChatCompletionPromptReady(eventData) {
        // ST also emits this event for dry runs and quiet/background generations.
        if (!pluginSettings?.enabled || !Array.isArray(eventData?.chat) || eventData.dryRun || !generationType || generationType === 'quiet' || generationType === 'impersonate') return;
        if (pendingPrompts.has(eventData)) return;
        if (eventData.chat.some(msg => msg?.role === 'system' && typeof msg.content === 'string' && msg.content.startsWith('[EchoGraph Enhanced Context]\n'))) return;
        // One foreground chat-completion prompt per generation. Raw/background calls
        // do not emit GENERATION_STARTED and must not inherit this generation type.
        generationType = null;
        pendingPrompts.add(eventData);
        const epoch = sessionEpoch;

        if (!currentSessionId) {
            logDebug('No active session ID, attempting auto-initialization...');
            if (pluginSettings.auto_initialize) {
                void initializeSession('manual_enhance_prompt');
            } else {
                logDebug(`${PLUGIN_NAME}: No active session ID and auto-init disabled. Enhancement skipped.`);
            }
            pendingPrompts.delete(eventData);
            return;
        }
        if (!isWsOpen()) {
            pendingPrompts.delete(eventData);
            return;
        }

        try {
            const userIndex = eventData.chat.findLastIndex(msg => msg?.role === 'user' && msg.content);
            const userMessage = eventData.chat[userIndex];
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
            }, 3000);
            if (epoch !== sessionEpoch) return;
            const enhancedContext = data.enhanced_context;

            if (enhancedContext && enhancedContext.trim().length > 0) {
                // Insert enhanced context as system message before the last user message
                eventData.chat.splice(userIndex, 0, {
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
        } finally {
            pendingPrompts.delete(eventData);
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
    async function onMessageReceived(chat_id, type) {
        if (type === 'first_message') return;
        if (!pluginSettings?.enabled || !currentSessionId) {
            logDebug('对话处理已跳过 - 插件已禁用或无会话');
            return;
        }

        let key;
        try {
            const context = getSillyTavernContext();
            const epoch = sessionEpoch;
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

            key = messageKey(message);
            const previous = renderedMessages.get(key);
            if (previous === llmResponse || processedMessages.get(key) === llmResponse) return;
            renderedMessages.set(key, llmResponse);
            if (previous !== undefined) {
                await syncConversationState();
                return;
            }
            processedMessages.set(key, llmResponse);

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
                tavern_chat_id: getChatKey(context),
                tavern_message_id: key
            }, 25000);
            if (epoch !== sessionEpoch) return;
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
            if (key) {
                processedMessages.delete(key);
                renderedMessages.delete(key);
            }
            console.error(`${PLUGIN_NAME}: 对话处理时发生错误:`, error);
            addActivityLog('对话处理错误: ' + error.message, 'error');
        }
    }

    // --- UI Creation Functions ---
    function createSettingsModal() {
        if ($('#echograph-settings-modal').length) {
            $('#echograph-settings-modal').show();
            loadSettingsToModal();
            return;
        }
        const modalHtml = `
            <div id="echograph-settings-modal" class="eg-style-1">
                <div class="eg-style-2">
                    <div class="eg-style-3">
                        <h3 class="eg-style-4">EchoGraph 设置</h3>
                        <button id="cf-close-settings" class="menu_button eg-style-5">关闭</button>
                    </div>
                    <div>
                        <form id="echograph-settings-form">
                            <div class="eg-style-6">
                                <div>
                                    <h5 class="eg-style-7">基础设置</h5>
                                    <div class="eg-style-7">
                                        <label class="eg-style-8">
                                            <input type="checkbox" id="cf-enabled" class="eg-style-9">
                                            启用 EchoGraph 增强
                                        </label>
                                    </div>
                                    <div class="eg-style-7">
                                        <label class="eg-style-10">EchoGraph API 地址：</label>
                                        <div class="eg-style-11">
                                            <input type="text" id="cf-api-url" placeholder="http://127.0.0.1:9543"
                                                   class="eg-style-12">
                                            <button class="menu_button" type="button" id="cf-test-api-btn">测试连接</button>
                                        </div>
                                        <small class="eg-style-13">EchoGraph 后端服务器地址（默认端口9543）</small>
                                    </div>
                                    <div class="eg-style-7">
                                        <label class="eg-style-8">
                                            <input type="checkbox" id="cf-auto-init" class="eg-style-9">
                                            自动初始化会话
                                        </label>
                                    </div>
                                    <div class="eg-style-7">
                                        <label class="eg-style-8">
                                            <input type="checkbox" id="cf-notifications" class="eg-style-9">
                                            显示通知
                                        </label>
                                    </div>
                                </div>
                                <div>
                                    <h5 class="eg-style-7">记忆系统设置</h5>
                                    <div class="eg-style-7">
                                        <label class="eg-style-10">热记忆轮次：</label>
                                        <input type="number" id="cf-hot-memory" min="1" max="20"
                                               class="eg-style-14">
                                    </div>
                                    <div class="eg-style-7">
                                        <label class="eg-style-10">最大语境长度：</label>
                                        <input type="number" id="cf-max-context" min="1000" max="10000"
                                               class="eg-style-14">
                                    </div>
                                    <div class="eg-style-7">
                                        <label class="eg-style-8">
                                            <input type="checkbox" id="cf-debug" class="eg-style-9">
                                            调试模式
                                        </label>
                                    </div>
                                </div>
                            </div>

                            <div class="eg-style-15">
                                <h5 class="eg-style-7">滑动窗口设置</h5>
                                <div class="eg-style-6">
                                    <div>
                                        <label class="eg-style-10">窗口大小：</label>
                                        <input type="number" id="cf-window-size" min="3" max="10" value="4"
                                               class="eg-style-14">
                                        <small class="eg-style-13">保留最近的对话轮数</small>
                                    </div>
                                    <div>
                                        <label class="eg-style-10">处理延迟：</label>
                                        <input type="number" id="cf-processing-delay" min="1" max="5" value="1"
                                               class="eg-style-14">
                                        <small class="eg-style-13">延迟处理的轮次数</small>
                                    </div>
                                </div>
                                <div class="eg-style-16">
                                    <div>
                                        <label class="eg-style-8">
                                            <input type="checkbox" id="cf-enhanced-agent" checked class="eg-style-9">
                                            启用增强智能体
                                        </label>
                                        <small class="eg-style-13">基于世界观创建丰富的角色节点</small>
                                    </div>
                                    <div>
                                        <label class="eg-style-8">
                                            <input type="checkbox" id="cf-conflict-resolution" checked class="eg-style-9">
                                            启用冲突解决
                                        </label>
                                        <small class="eg-style-13">处理酒馆对话历史修改</small>
                                    </div>
                                </div>
                            </div>
                        </form>
                    </div>
                    <div class="eg-style-17">
                        <button id="cf-cancel-settings" class="menu_button">取消</button>
                        <button id="cf-save-settings" class="menu_button menu_button_icon">保存设置</button>
                    </div>
                </div>
            </div>
        `;

        // 如果在主页面中，添加到主页面容器；否则添加到body
        $('body').append(modalHtml);
        $('#echograph-settings-modal').show();

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
        $('#cf-test-api-btn').on('click', () => testAPIConnection($('#cf-api-url').val() || DEFAULT_API_BASE_URL));
        loadSettingsToModal();
    }

    function createDebugPanel() {
        const panelHtml = `
            <div id="echograph-panel" class="cf-panel eg-style-18">
                <div class="cf-panel-header">
                    <div class="cf-panel-title">
                        <span class="cf-icon">EchoGraph</span>
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
        const wasEnabled = pluginSettings.enabled;
        const oldApiUrl = pluginSettings.api_base_url;
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
        if (!pluginSettings.enabled) {
            stopHeartbeat();
            disconnectWebSocket();
            updatePanelStatus('已禁用', 'disconnected');
        } else {
            startHeartbeat();
            if (!wasEnabled || oldApiUrl !== pluginSettings.api_base_url) {
                disconnectWebSocket();
                lastHealthOk = false;
                if (currentSessionId) testAPIConnection().then(() => {
                    if (lastHealthOk) connectWebSocket(currentSessionId);
                });
            }
        }
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
        updatePanelStatus(isWsOpen() ? '已连接' : (pluginSettings.enabled ? '未连接' : '已禁用'),
                         isWsOpen() ? 'connected' : 'disconnected');

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
            <div id="echograph-main-page" class="eg-style-19">
                <div class="cf-main-header eg-style-20">
                    <h1 class="eg-style-21">
                        EchoGraph 滑动窗口智能增强
                    </h1>
                    <p class="eg-style-22">
                        版本 ${PLUGIN_VERSION} - 智能对话记忆管理系统
                    </p>
                    <button id="cf-close-main-page" class="eg-style-23">× 关闭</button>
                </div>

                <div class="cf-main-content eg-style-24">
                    <div class="cf-dashboard-grid eg-style-25">
                        <!-- 连接状态卡片 -->
                        <div class="cf-card eg-style-26">
                            <h3 class="eg-style-7">连接状态</h3>
                            <div class="cf-connection-status">
                                <div class="eg-style-27">
                                    <span>API 连接:</span>
                                    <span id="cf-main-api-status" class="cf-status-indicator cf-status-disconnected">未连接</span>
                                </div>
                                <div class="eg-style-27">
                                    <span>会话状态:</span>
                                    <span id="cf-main-session-status">未初始化</span>
                                </div>
                                <div class="eg-style-3">
                                    <span>当前角色:</span>
                                    <span id="cf-main-character-status">无</span>
                                </div>
                                <button id="cf-main-test-connection" class="cf-btn cf-btn-primary eg-style-28">测试连接</button>
                                <button id="cf-main-settings" class="cf-btn cf-btn-secondary eg-style-29">打开设置</button>
                            </div>
                        </div>

                        <!-- 滑动窗口状态卡片 -->
                        <div class="cf-card eg-style-26">
                            <h3 class="eg-style-7">滑动窗口状态</h3>
                            <div class="cf-stats-grid eg-style-30">
                                <div class="cf-stat-item eg-style-31">
                                    <div id="cf-main-window-turns" class="eg-style-32">0</div>
                                    <div class="eg-style-13">窗口轮次</div>
                                </div>
                                <div class="cf-stat-item eg-style-31">
                                    <div id="cf-main-processed-turns" class="eg-style-32">0</div>
                                    <div class="eg-style-13">已处理轮次</div>
                                </div>
                                <div class="cf-stat-item eg-style-31">
                                    <div id="cf-main-conflicts-resolved" class="eg-style-32">0</div>
                                    <div class="eg-style-13">解决冲突</div>
                                </div>
                                <div class="cf-stat-item eg-style-31">
                                    <div id="cf-main-window-capacity" class="eg-style-32">4</div>
                                    <div class="eg-style-13">窗口容量</div>
                                </div>
                            </div>
                        </div>

                        <!-- 知识图谱统计卡片 -->
                        <div class="cf-card eg-style-26">
                            <h3 class="eg-style-7">知识图谱</h3>
                            <div class="cf-stats-grid eg-style-30">
                                <div class="cf-stat-item eg-style-31">
                                    <div id="cf-main-graph-nodes" class="eg-style-32">0</div>
                                    <div class="eg-style-13">图谱节点</div>
                                </div>
                                <div class="cf-stat-item eg-style-31">
                                    <div id="cf-main-graph-edges" class="eg-style-32">0</div>
                                    <div class="eg-style-13">关系边</div>
                                </div>
                                <div class="cf-stat-item eg-style-31">
                                    <div id="cf-main-memory-turns" class="eg-style-32">0</div>
                                    <div class="eg-style-13">记忆轮次</div>
                                </div>
                                <div class="cf-stat-item eg-style-31">
                                    <div id="cf-main-last-update" class="eg-style-33">--:--:--</div>
                                    <div class="eg-style-13">最后更新</div>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- 快捷操作区域 -->
                    <div class="cf-card eg-style-34">
                        <h3 class="eg-style-7">快捷操作</h3>
                        <div class="cf-main-buttons eg-style-35">
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
                    <div class="cf-card eg-style-26">
                        <h3 class="eg-style-7">最近活动</h3>
                        <div id="cf-main-activity-log" class="eg-style-36">
                            <div class="eg-style-37">等待活动中...</div>
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
        $('#cf-main-settings, #cf-main-open-settings').on('click', createSettingsModal);
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
                const modeResponse = await fetch(`${pluginSettings.api_base_url}/system/tavern_mode`, { signal: AbortSignal.timeout(5000) });
                if (!modeResponse.ok) throw new Error(`Tavern mode check failed: HTTP ${modeResponse.status}`);
                const mode = await modeResponse.json();
                lastHealthOk = !!mode.active;
                if (!mode.active) {
                    statusElement.removeClass('cf-status-connected cf-status-unknown')
                                 .addClass('cf-status-disconnected').text('酒馆模式未启用');
                    updatePanelStatus('酒馆模式未启用', 'disconnected');
                    return;
                }
                statusElement.removeClass('cf-status-disconnected cf-status-unknown')
                             .addClass(isWsOpen() ? 'cf-status-connected' : 'cf-status-unknown')
                             .text(isWsOpen() ? '已连接' : 'API 可用');
                updatePanelStatus(isWsOpen() ? '已连接' : 'API 可用', isWsOpen() ? 'connected' : 'unknown');
            } else {
                lastHealthOk = false;
                statusElement.removeClass('cf-status-connected cf-status-unknown')
                             .addClass('cf-status-disconnected')
                             .text('连接失败');
                updatePanelStatus('连接异常', 'disconnected');
            }
        } catch (error) {
            lastHealthOk = false;
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

        const logHtml = `
            <div class="eg-log-item eg-log-${type}">
                <div class="eg-log-message">${escapeHtml(message)}</div>
                <div class="eg-log-time">${timestamp}</div>
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
        logDebug('尝试添加菜单项到扩展菜单...');
        const extensionsBlock = $('#extensionsMenu');

        if (extensionsBlock && extensionsBlock.length && !$('#echograph-menu-item').length) {
            const menuItem = $(`
                <div id="echograph-menu-item" class="list-group-item flex-container flexGap5 interactable eg-style-38">
                    <div class="fa-solid fa-brain extensionsMenuExtensionButton eg-style-37"></div>
                    <span class="eg-style-39">EchoGraph 滑动窗口</span>
                </div>
            `);

            menuItem.on('click', () => {
                logDebug('EchoGraph菜单项被点击');
                showEchoGraphMainPage();
            });


            extensionsBlock.append(menuItem);
            logDebug('EchoGraph菜单项已添加到扩展菜单');

        } else {
            logDebug('扩展菜单尚未就绪');
        }
    }

    // 加载插件设置
    if (!document.getElementById('echograph-plugin-styles')) {
        $('head').append(`<style id="echograph-plugin-styles">.eg-style-1 { position: absolute; top: 0; left: 0; width: 100%; height: 100%; z-index: 100; justify-content: center; align-items: center; }
.eg-style-2 { border-radius: 8px; width: 90%; max-width: 700px; max-height: 80%; overflow-y: auto; padding: 16px; position: relative; }
.eg-style-3 { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
.eg-style-4 { margin: 0; }
.eg-style-5 { padding: 8px 8px; }
.eg-style-6 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.eg-style-7 { margin-bottom: 16px; }
.eg-style-8 { display: flex; align-items: center; }
.eg-style-9 { margin-right: 8px; }
.eg-style-10 { display: block; margin-bottom: 8px; }
.eg-style-11 { display: flex; gap: 8px; }
.eg-style-12 { flex: 1; padding: 8px; border-radius: 4px; }
.eg-style-13 { font-size: 12px; }
.eg-style-14 { width: 100%; padding: 8px; border-radius: 4px; }
.eg-style-15 { margin-top: 16px; padding-top: 16px; }
.eg-style-16 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 16px; }
.eg-style-17 { margin-top: 16px; padding-top: 16px; display: flex; justify-content: flex-end; gap: 8px; }
.eg-style-18 { display: none; }
.eg-style-19 { position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; z-index: 10001; overflow-y: auto; }
.eg-style-20 { padding: 16px; text-align: center; }
.eg-style-21 { margin: 0; font-size: 28px; }
.eg-style-22 { margin: 8px 0 0 0; font-size: 16px; }
.eg-style-23 { position: absolute; top: 16px; right: 16px; padding: 8px 12px; border-radius: 6px; cursor: pointer; font-size: 16px; }
.eg-style-24 { padding: 30px; max-width: 1200px; margin: 0 auto; }
.eg-style-25 { display: grid; grid-template-columns: repeat(auto-fit, minmax(350px, 1fr)); gap: 24px; margin-bottom: 30px; }
.eg-style-26 { border-radius: 12px; padding: 24px; }
.eg-style-27 { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
.eg-style-28 { width: 100%; margin-bottom: 8px; }
.eg-style-29 { width: 100%; }
.eg-style-30 { display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; }
.eg-style-31 { text-align: center; }
.eg-style-32 { font-size: 24px; font-weight: bold; }
.eg-style-33 { font-size: 14px; }
.eg-style-34 { border-radius: 12px; padding: 24px; margin-bottom: 30px; }
.eg-style-35 { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; }
.eg-style-36 { border-radius: 6px; padding: 16px; max-height: 300px; overflow-y: auto; font-size: 13px; }
.eg-style-38 { cursor: pointer; padding: 8px 12px; margin: 2px 0; border-radius: 4px; }
.eg-style-39 { margin-left: 8px; font-weight: 500; }
.eg-style-40 { position: fixed; top: 16px; right: 80px; width: 45px; height: 45px; border-radius: 50%; display: flex; align-items: center; justify-content: center; cursor: pointer; z-index: 9998; font-size: 16px; font-weight: bold; }

#echograph-panel, #echograph-main-page, #echograph-settings-modal, #echograph-floating-btn, #echograph-menu-item {
    --eg-fg: var(--SmartThemeBodyColor, #e0e0e0);
    --eg-bg: var(--SmartThemeBlurTintColor, #242424);
    --eg-accent: var(--SmartThemeQuoteColor, #9aaecb);
    --eg-border: var(--SmartThemeBorderColor, #666);
    color: var(--eg-fg);
    font: inherit;
    box-sizing: border-box;
}
#echograph-panel *, #echograph-main-page *, #echograph-settings-modal * { box-sizing: border-box; }
#echograph-panel { position: fixed; top: 8px; right: 8px; width: min(380px, calc(100vw - 16px)); max-height: calc(100dvh - 16px); z-index: 10000; overflow: hidden; background: var(--eg-bg); border: 1px solid var(--eg-border); border-radius: 8px; box-shadow: 0 4px 16px var(--SmartThemeShadowColor, #0005); }
#echograph-panel.minimized { width: min(250px, calc(100vw - 16px)); }
#echograph-panel.minimized .cf-panel-body { display: none; }
.cf-panel-header, .cf-main-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 16px; border-bottom: 1px solid var(--eg-border); background: var(--eg-bg); color: var(--eg-fg); }
.cf-panel-title, .cf-panel-controls, .cf-button-group { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.cf-panel-body { max-height: calc(100dvh - 88px); overflow-y: auto; padding: 16px; }
.cf-panel-body h3, .cf-card h3, #echograph-settings-modal h3, #echograph-settings-modal h5 { color: var(--SmartThemeEmColor, var(--eg-fg)); margin: 0 0 16px; }
.cf-status-section, .cf-controls-section, .cf-memory-section, .cf-card { padding: 16px; margin-bottom: 16px; border: 1px solid var(--eg-border); border-radius: 8px; background: var(--eg-bg); min-width: 0; }
.cf-status-grid, .cf-stats-grid, .cf-dashboard-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr)); gap: 16px; }
.cf-status-item, .cf-stat-card, .cf-stat-item { min-width: 0; overflow-wrap: anywhere; }
.cf-btn, #echograph-main-page button, #echograph-settings-modal button { font: inherit; color: var(--eg-fg); background: transparent; border: 1px solid var(--eg-border); border-radius: 6px; padding: 8px 12px; cursor: pointer; }
.cf-btn:hover, #echograph-main-page button:hover, #echograph-settings-modal button:hover, #echograph-menu-item:hover, #echograph-floating-btn:hover { border-color: var(--eg-accent); color: var(--eg-accent); }
.cf-btn-primary, .cf-btn-info { border-color: var(--eg-accent); }
.cf-stat-number, #echograph-main-page [id^="cf-main-"][id$="turns"], #cf-main-graph-nodes, #cf-main-graph-edges { color: var(--eg-accent); font-weight: 600; }
.cf-status-connected::before, .cf-status-disconnected::before, .cf-status-unknown::before { content: ''; display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 8px; vertical-align: middle; background: var(--eg-accent); }
.cf-status-disconnected::before { background: var(--eg-border); }
.cf-status-unknown::before { background: var(--SmartThemeEmColor, var(--eg-border)); }
#echograph-main-page { position: fixed; inset: 0; width: 100%; height: 100dvh; z-index: 10001; overflow-y: auto; background: var(--eg-bg); color: var(--eg-fg); }
#echograph-main-page .cf-main-content { width: min(1080px, calc(100vw - 16px)); margin: 0 auto; padding: 16px; overflow-x: hidden; }
#echograph-main-page .cf-main-header { position: sticky; top: 0; z-index: 1; }
#echograph-settings-modal { position: fixed; inset: 0; z-index: 10002; display: flex; align-items: center; justify-content: center; padding: 8px; background: color-mix(in srgb, var(--eg-bg) 75%, transparent); }
#echograph-settings-modal > div { width: min(700px, calc(100vw - 16px)); max-height: calc(100dvh - 16px); overflow-y: auto; padding: 16px; background: var(--eg-bg); color: var(--eg-fg); border: 1px solid var(--eg-border); border-radius: 8px; box-shadow: 0 4px 16px var(--SmartThemeShadowColor, #0005); }
#echograph-settings-modal form > div, #echograph-settings-modal .eg-style-1 { min-width: 0; }
#echograph-settings-modal input:not([type="checkbox"]) { width: 100%; min-width: 0; padding: 8px; color: var(--eg-fg); background: var(--eg-bg); border: 1px solid var(--eg-border); border-radius: 6px; }
#echograph-settings-modal label { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
#echograph-settings-modal small, .cf-timestamp, .eg-log-time { color: var(--eg-accent); font-size: 12px; }
#echograph-menu-item { padding: 8px 12px; margin: 2px 0; border-radius: 6px; cursor: pointer; }
#echograph-floating-btn { position: fixed; top: 16px; right: 16px; z-index: 9998; width: 44px; height: 44px; display: flex; align-items: center; justify-content: center; background: var(--eg-bg); border: 1px solid var(--eg-border); border-radius: 8px; cursor: pointer; box-shadow: 0 2px 8px var(--SmartThemeShadowColor, #0005); }
.cf-activity-item, .eg-log-item { padding: 8px; margin-bottom: 8px; border-left: 2px solid var(--eg-accent); overflow-wrap: anywhere; }
.eg-log-time { margin-top: 4px; }
#cf-activity-log, #cf-main-activity-log { max-height: 300px; overflow-y: auto; }
@media (max-width: 640px) {
  #echograph-main-page .cf-main-content { padding: 8px; }
  #echograph-main-page .cf-dashboard-grid, #echograph-main-page .cf-stats-grid, #echograph-settings-modal form > div { grid-template-columns: minmax(0, 1fr); }
  #echograph-settings-modal > div { padding: 8px; }
  #echograph-panel { top: 8px; right: 8px; }
}
</style>`);
    }

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

        // SillyTavern creates the extension menu asynchronously.
        const hasMenuItem = $('#echograph-menu-item').length > 0;

        if (!hasMenuItem && menuRetryCount < maxMenuRetries) {
            logDebug(`菜单项添加失败，${2000 * menuRetryCount}ms后重试...`);
            setTimeout(tryAddMenuItems, 2000 * menuRetryCount); // 递增延迟
        } else {
            logDebug(`菜单项添加完成 - 菜单项: ${hasMenuItem}`);
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
            updatePanelStatus('未连接', 'disconnected');
            refreshPanelStats();
        }

        // 添加心跳检测机制，保持与API的连接
        let heartbeatInterval = null;
        let heartbeatBusy = false;

        function startHeartbeat() {
            if (heartbeatInterval) {
                clearInterval(heartbeatInterval);
            }

            // 每30秒检查一次API连接状态
            heartbeatInterval = setInterval(async () => {
                if (!pluginSettings?.enabled || heartbeatBusy) {
                    return;
                }
                heartbeatBusy = true;

                try {
                    logDebug('执行心跳检测...');
                    const response = await fetch(`${pluginSettings.api_base_url}/health`, {
                        signal: AbortSignal.timeout(5000)
                    });

                    if (response.ok) {
                        const modeResponse = await fetch(`${pluginSettings.api_base_url}/system/tavern_mode`, { signal: AbortSignal.timeout(5000) });
                        if (!modeResponse.ok) throw new Error(`Tavern mode check failed: HTTP ${modeResponse.status}`);
                        const mode = await modeResponse.json();
                        if (!mode.active) {
                            lastHealthOk = false;
                            disconnectWebSocket();
                            updatePanelStatus('酒馆模式未启用', 'disconnected');
                            return;
                        }
                        lastHealthOk = true;
                        const data = await response.json();
                        if (isWsOpen()) {
                            try { await sendWsRequest('ping', {}, 5000); }
                            catch (error) { try { webSocket?.close(); } catch (e) {} }
                        }
                        logDebug(`心跳检测成功 - 活跃会话: ${data.active_sessions}`);

                        // 更新连接状态指示器
                        if (!isWsOpen() && currentSessionId) scheduleReconnect();
                        updatePanelStatus(isWsOpen() ? '已连接' : 'API 可用', isWsOpen() ? 'connected' : 'unknown');

                        // 如果主页面打开，更新API状态
                        const statusElement = $('#cf-main-api-status');
                        if (statusElement.length) {
                            statusElement
                                .removeClass('cf-status-disconnected cf-status-unknown')
                                .addClass('cf-status-connected')
                                .text('已连接');
                        }
                    } else {
                        lastHealthOk = false;
                        cancelReconnect();
                        logDebug(`心跳检测失败 - HTTP ${response.status}`);
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
                    lastHealthOk = false;
                    cancelReconnect();
                    logDebug(`心跳检测异常: ${error.message}`);
                    updatePanelStatus('连接断开', 'disconnected');

                    // 更新主页面状态
                    const statusElement = $('#cf-main-api-status');
                    if (statusElement.length) {
                        statusElement
                            .removeClass('cf-status-connected cf-status-unknown')
                            .addClass('cf-status-disconnected')
                            .text('连接断开');
                    }
                } finally {
                    heartbeatBusy = false;
                }
            }, 30000); // 30秒间隔

            logDebug('心跳检测已启动 (30秒间隔)');
        }

        function stopHeartbeat() {
            if (heartbeatInterval) {
                clearInterval(heartbeatInterval);
                heartbeatInterval = null;
                logDebug('心跳检测已停止');
            }
        }

        // 启动心跳检测
        if (pluginSettings?.enabled) {
            startHeartbeat();
        }

        // CHAT_CHANGED处理逻辑 - 简化版本，参考st-memory-enhancement的直接处理方式
        async function onChatChanged() {
            console.log('[EchoGraph]  onChatChanged 被调用');
            logDebug('onChatChanged 被调用');

            try {
                if (!pluginSettings?.enabled) return;
                // 获取当前上下文以检测角色变化
                const context = getSillyTavernContext();
                const currentCharacterId = context.characterId;
                const changedChat = switchChat(context);
                if (!changedChat) seedRenderedMessages(context);
                if (changedChat) {
                    disconnectWebSocket();
                    currentSessionId = null;
                    lastCharacterId = null;
                    initializationPromise = null;
                    isInitializing = false;
                }

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

                if (changedChat || hasCharacterChanged || !currentSessionId) {
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
            seedRenderedMessages(getSillyTavernContext());
            syncConversationState();
        }

        // 消息滑动处理
        async function onMessageSwiped(chat_id) {
            if (!pluginSettings?.enabled || !currentSessionId) return;
            logDebug('Message swiped, syncing conversation state');
            const context = getSillyTavernContext();
            const message = context.chat?.[chat_id];
            if (message) renderedMessages.set(messageKey(message), String(message.mes ?? message.content ?? ''));
            syncConversationState();
        }

        // 监听主程序事件 - 使用SillyTavern官方推荐的方式
        console.log('[EchoGraph] 开始绑定事件...');

        try {
            // 使用SillyTavern官方推荐的获取方式
            const context = getContext();
            const { eventSource, eventTypes } = context || {};

            console.log('[EchoGraph] 事件系统检查:', {
                hasContext: !!context,
                hasEventSource: !!eventSource,
                hasEventTypes: !!eventTypes,
                eventSourceType: typeof eventSource,
                eventSourceOn: typeof eventSource?.on,
                eventTypesKeys: Object.keys(eventTypes || {}),
                contextKeys: Object.keys(context || {})
            });

            if (eventSource && typeof eventSource.on === 'function' && eventTypes) {
                console.log('[EchoGraph]  使用官方 getContext() 方式绑定事件');

                if (eventTypes.CHARACTER_MESSAGE_RENDERED) eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED, onMessageReceived);
                console.log('[EchoGraph]  已绑定 CHARACTER_MESSAGE_RENDERED');

                if (eventTypes.CHAT_COMPLETION_PROMPT_READY) eventSource.on(eventTypes.CHAT_COMPLETION_PROMPT_READY, onChatCompletionPromptReady);
                console.log('[EchoGraph]  已绑定 CHAT_COMPLETION_PROMPT_READY');

                if (eventTypes.CHAT_CHANGED) eventSource.on(eventTypes.CHAT_CHANGED, onChatChanged);
                console.log('[EchoGraph]  已绑定 CHAT_CHANGED');

                if (eventTypes.MESSAGE_EDITED) eventSource.on(eventTypes.MESSAGE_EDITED, onMessageEdited);
                console.log('[EchoGraph]  已绑定 MESSAGE_EDITED');

                if (eventTypes.MESSAGE_SWIPED) eventSource.on(eventTypes.MESSAGE_SWIPED, onMessageSwiped);
                console.log('[EchoGraph]  已绑定 MESSAGE_SWIPED');

                if (eventTypes.MESSAGE_DELETED) eventSource.on(eventTypes.MESSAGE_DELETED, () => { seedRenderedMessages(getSillyTavernContext()); syncConversationState(); });
                console.log('[EchoGraph]  已绑定 MESSAGE_DELETED');

                if (eventTypes.GENERATION_STARTED) eventSource.on(eventTypes.GENERATION_STARTED, (type, _options, dryRun) => {
                    if (!dryRun) generationType = type;
                });
                if (eventTypes.GENERATE_AFTER_COMBINE_PROMPTS) eventSource.on(eventTypes.GENERATE_AFTER_COMBINE_PROMPTS, (_data) => { generationType = null; });
                if (eventTypes.GENERATION_ENDED) eventSource.on(eventTypes.GENERATION_ENDED, () => { generationType = null; });
                if (eventTypes.GENERATION_STOPPED) eventSource.on(eventTypes.GENERATION_STOPPED, () => { generationType = null; });

                console.log('[EchoGraph]  所有事件绑定完成！');

            } else {
                console.log('[EchoGraph]  SillyTavern.getContext() 事件系统不可用');
            }

        } catch (error) {
            console.error('[EchoGraph] 事件绑定过程中出现异常:', error);
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
        const logKey = `${type}:${message}`;
        if (addActivityLog.lastKey === logKey && Date.now() - addActivityLog.lastAt < 1000) return;
        addActivityLog.lastKey = logKey;
        addActivityLog.lastAt = Date.now();
        const timestamp = new Date().toLocaleTimeString();
        const activityClass = type === 'success' ? 'cf-activity-success' :
                              type === 'warning' ? 'cf-activity-warning' :
                              type === 'error' ? 'cf-activity-error' : 'cf-activity-info';

        const activityHtml = `
            <div class="cf-activity-item ${activityClass}">
                <div>${escapeHtml(message)}</div>
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

    async function testAPIConnection(apiUrl = pluginSettings.api_base_url) {
        if (typeof apiUrl !== 'string') apiUrl = pluginSettings.api_base_url;
        try {
            addActivityLog('正在测试API连接...', 'info');
            updatePanelStatus('测试连接中...', 'unknown');

            const response = await fetch(`${apiUrl}/health`, {
                signal: AbortSignal.timeout(10000) // 10秒超时
            });

            if (response.ok) {
                const modeResponse = await fetch(`${apiUrl}/system/tavern_mode`, { signal: AbortSignal.timeout(5000) });
                if (!modeResponse.ok) throw new Error(`酒馆模式检查失败: HTTP ${modeResponse.status}`);
                const mode = await modeResponse.json();
                if (!mode.active) {
                    lastHealthOk = false;
                    updatePanelStatus('酒馆模式未启用', 'disconnected');
                    $('#cf-main-api-status').removeClass('cf-status-connected cf-status-unknown')
                        .addClass('cf-status-disconnected').text('酒馆模式未启用');
                    addActivityLog('EchoGraph 后台未启用酒馆模式', 'warning');
                    return;
                }
                lastHealthOk = true;
                const data = await response.json();
                updatePanelStatus(isWsOpen() ? '已连接' : 'API 可用', isWsOpen() ? 'connected' : 'unknown');
                addActivityLog(`API连接成功 - 版本: ${data.version || '未知'}`, 'success');
                showNotification(`EchoGraph API 连接成功！\n版本: ${data.version}\n活跃会话: ${data.active_sessions}`, 'success');

                // 同时更新主页面的API状态
                const statusElement = $('#cf-main-api-status');
                if (statusElement.length) {
                    statusElement
                        .removeClass('cf-status-disconnected cf-status-unknown')
                        .addClass(isWsOpen() ? 'cf-status-connected' : 'cf-status-unknown')
                        .text(isWsOpen() ? '已连接' : 'API 可用');
                }
            } else {
                lastHealthOk = false;
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
            lastHealthOk = false;
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

    if (ST.__echoGraphEnableTestHooks) {
        ST.__echoGraphTestHooks = {
            getChatKey, messageKey, switchChat, reconnectDelay, connectWebSocket,
            onMessageReceived, onChatChanged,
            setSession(id) { currentSessionId = id; },
            setLastCharacterId(id) { lastCharacterId = id; },
            setHealth(ok) { lastHealthOk = ok; },
            state() { return { currentSessionId, sessionEpoch, reconnectAttempt, hasReconnect: !!reconnectTimer }; }
        };
    }
    console.log("______________________EchoGraph插件：加载完成______________________");
});
