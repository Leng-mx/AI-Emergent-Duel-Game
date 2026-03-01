export class UIManager {
    constructor(game) {
        this.game = game;
        this.elements = {};
        this.noticeTimer = null;
        this.decisionResolver = null;
        this.decisionOpen = false;
        this.expandedIntelLaneId = '';
        this.activeIntelTab = 'system';
        this.liveIntelCache = {
            thought: { text: '等待敌方思维信号...', timestamp: 0 },
            action: { text: '等待敌方动作信号...', timestamp: 0 }
        };
        this.ensureInlineLayer();
        this.bindElements();
        this.bindEvents();
        this.initIntelTabs();
        this.initIntelLaneExpanders();
        this.renderLiveIntel(this.liveIntelCache);
    }

    ensureInlineLayer() {
        if (document.getElementById('ui-inline-layer')) return;

        const layer = document.createElement('div');
        layer.id = 'ui-inline-layer';
        layer.innerHTML = `
            <div id="ui-notice" class="ui-notice hidden"></div>
            <div id="ui-decision" class="ui-decision hidden">
                <div class="ui-decision-card">
                    <div id="ui-decision-title" class="ui-decision-title">确认操作</div>
                    <div id="ui-decision-message" class="ui-decision-message"></div>
                    <div class="ui-decision-actions">
                        <button id="ui-decision-cancel" type="button" class="ui-btn ui-btn-secondary">取消</button>
                        <button id="ui-decision-confirm" type="button" class="ui-btn ui-btn-primary">确认</button>
                    </div>
                </div>
            </div>
            <div id="ui-page-panel" class="ui-page-panel hidden">
                <div class="ui-page-shell">
                    <div class="ui-page-header">
                        <span id="ui-page-title">页面</span>
                        <button id="ui-page-close" type="button" class="ui-btn ui-btn-secondary">关闭</button>
                    </div>
                    <iframe id="ui-page-frame" title="embedded-page"></iframe>
                </div>
            </div>
        `;
        document.body.appendChild(layer);
    }

    bindElements() {
        const ids = [
            'api-key', 'api-url', 'model-name',
            'player-name', 'player-role', 'player-personality',
            'start-btn', 'skip-intro-btn', 'config-panel',
            'flow-screen', 'skip-flow-btn',
            'setup-api-page', 'setup-role-page', 'setup-step-api', 'setup-step-role', 'setup-next-btn', 'setup-back-btn',
            'game-interface', 'player-status', 'scene-log', 'player-input',
            'send-btn', 'reset-btn', 'auto-play-btn', 'rules-btn', 'report-btn', 'chatrooms-btn',
            'lobby-view', 'chat-view', 'chat-content', 'chat-target-name', 'chat-target-status',
            'hangup-btn', 'room-connect-btn', 'chat-nav-list',
            'intel-panel', 'intel-system-feed', 'intel-ally-feed', 'intel-enemy-feed',
            'intel-tabs-lane', 'intel-tab-system', 'intel-tab-ally', 'intel-tab-enemy',
            'live-thought-text', 'live-thought-time', 'live-action-text', 'live-action-time',
            'pair-room-meta', 'pair-room-summary', 'room-open-btn',
            'round-progress', 'round-progress-text', 'round-progress-percent', 'round-progress-fill',
            'enemy-list', 'ally-list',
            'typing-indicator', 'voice-btn',
            'loading-screen', 'loading-progress', 'loading-log',
            'thinking-progress-bar', 'thinking-timer', 'thinking-label',
            'intro-screen',
            'ui-inline-layer', 'ui-notice', 'ui-decision',
            'ui-decision-title', 'ui-decision-message', 'ui-decision-cancel', 'ui-decision-confirm',
            'ui-page-panel', 'ui-page-title', 'ui-page-frame', 'ui-page-close'
        ];

        ids.forEach((id) => {
            this.elements[id] = document.getElementById(id);
        });
    }

    bindEvents() {
        if (this.elements['start-btn']) this.elements['start-btn'].addEventListener('click', () => this.game.startGame());
        if (this.elements['setup-next-btn']) this.elements['setup-next-btn'].addEventListener('click', () => this.game.goToRoleSetup());
        if (this.elements['setup-back-btn']) this.elements['setup-back-btn'].addEventListener('click', () => this.game.goToApiSetup());
        if (this.elements['setup-step-api']) this.elements['setup-step-api'].addEventListener('click', () => this.game.showSetupStep('api'));
        if (this.elements['setup-step-role']) this.elements['setup-step-role'].addEventListener('click', () => this.game.goToRoleSetup(true));
        if (this.elements['send-btn']) this.elements['send-btn'].addEventListener('click', () => this.game.handlePlayerAction());
        if (this.elements['reset-btn']) this.elements['reset-btn'].addEventListener('click', () => this.game.resetGame());
        if (this.elements['auto-play-btn']) this.elements['auto-play-btn'].addEventListener('click', () => this.game.toggleAutoPlay());
        if (this.elements['rules-btn']) this.elements['rules-btn'].addEventListener('click', () => this.game.openRulesPage());
        if (this.elements['report-btn']) this.elements['report-btn'].addEventListener('click', () => this.game.openReportPage());
        if (this.elements['chatrooms-btn']) this.elements['chatrooms-btn'].addEventListener('click', () => this.game.openChatroomsPage());
        if (this.elements['room-open-btn']) this.elements['room-open-btn'].addEventListener('click', () => this.game.openChatroomsPage());
        if (this.elements['voice-btn']) this.elements['voice-btn'].addEventListener('click', () => this.toggleVoiceInput());
        if (this.elements['hangup-btn']) this.elements['hangup-btn'].addEventListener('click', () => this.game.disconnectChannel());
        if (this.elements['room-connect-btn']) this.elements['room-connect-btn'].addEventListener('click', () => this.game.connectSelectedRoom());
        if (this.elements['skip-intro-btn']) this.elements['skip-intro-btn'].addEventListener('click', () => this.game.endIntro());
        if (this.elements['skip-flow-btn']) this.elements['skip-flow-btn'].addEventListener('click', () => this.game.endFlowBriefing());

        if (this.elements['chat-nav-list']) {
            this.elements['chat-nav-list'].addEventListener('click', (e) => {
                const target = e.target?.closest?.('.chat-nav-item');
                if (!target) return;
                const roomId = String(target.getAttribute('data-room-id') || '');
                if (!roomId) return;
                this.game.selectRoom(roomId);
            });
        }

        if (this.elements['intro-screen']) {
            this.elements['intro-screen'].addEventListener('click', (e) => {
                if (e.target && e.target.id === 'skip-intro-btn') return;
                this.game.endIntro();
            });
        }
        if (this.elements['flow-screen']) {
            this.elements['flow-screen'].addEventListener('click', (e) => {
                if (e.target && e.target.id === 'skip-flow-btn') return;
                this.game.endFlowBriefing();
            });
        }
        if (this.elements['ui-decision-confirm']) this.elements['ui-decision-confirm'].addEventListener('click', () => this.closeDecision(true));
        if (this.elements['ui-decision-cancel']) this.elements['ui-decision-cancel'].addEventListener('click', () => this.closeDecision(false));
        if (this.elements['ui-decision']) {
            this.elements['ui-decision'].addEventListener('click', (e) => {
                if (e.target === this.elements['ui-decision']) this.closeDecision(false);
            });
        }
        if (this.elements['ui-page-close']) this.elements['ui-page-close'].addEventListener('click', () => this.closePagePanel());

        if (this.elements['player-input']) {
            this.elements['player-input'].addEventListener('keypress', (e) => {
                if (e.key === 'Enter') this.game.handlePlayerAction();
            });
        }

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                if (this.expandedIntelLaneId) this.toggleIntelLaneExpand('');
                if (this.decisionOpen) this.closeDecision(false);
                if (this.elements['ui-page-panel'] && !this.elements['ui-page-panel'].classList.contains('hidden')) {
                    this.closePagePanel();
                }
            }
        });
    }

    initIntelTabs() {
        const panel = this.elements['intel-panel'];
        if (!panel) return;
        if (panel.dataset.intelTabsBound === '1') {
            this.setIntelTab(this.activeIntelTab);
            return;
        }

        panel.addEventListener('click', (e) => {
            const tabBtn = e.target?.closest?.('.intel-tab-btn');
            if (!tabBtn) return;
            const channel = String(tabBtn.dataset.channel || 'system');
            this.setIntelTab(channel);
        });

        panel.dataset.intelTabsBound = '1';
        this.setIntelTab(this.activeIntelTab);
    }

    setIntelTab(channel = 'system') {
        const safeChannel = ['system', 'ally', 'enemy'].includes(channel) ? channel : 'system';
        this.activeIntelTab = safeChannel;

        const panel = this.elements['intel-panel'];
        if (!panel) return;
        const tabButtons = [...panel.querySelectorAll('.intel-tab-btn')];
        const tabPanels = [...panel.querySelectorAll('.intel-tab-panel')];
        if (!tabButtons.length || !tabPanels.length) return;

        tabButtons.forEach((btn) => {
            const active = String(btn.dataset.channel || '') === safeChannel;
            btn.classList.toggle('active', active);
        });
        tabPanels.forEach((pane) => {
            const active = String(pane.dataset.channel || '') === safeChannel;
            pane.classList.toggle('active', active);
        });

        const activeFeed = this.getIntelContainer(safeChannel);
        if (activeFeed) activeFeed.scrollTop = activeFeed.scrollHeight;
    }

    initIntelLaneExpanders() {
        const panel = this.elements['intel-panel'];
        if (!panel) return;

        const lanes = [...panel.querySelectorAll('.intel-lane')];
        lanes.forEach((lane, index) => {
            const laneId = lane.id || `intel-lane-${index + 1}`;
            lane.setAttribute('data-lane-id', laneId);

            if (lane.classList.contains('intel-always-visible')) return;
            const title = lane.querySelector('.intel-lane-title');
            if (!title) return;
            if (title.querySelector('.lane-expand-btn')) return;

            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'lane-expand-btn';
            btn.textContent = '展开';
            btn.setAttribute('title', '展开查看该区块');
            title.appendChild(btn);
        });

        panel.addEventListener('click', (e) => {
            const btn = e.target?.closest?.('.lane-expand-btn');
            if (!btn) return;
            const lane = btn.closest('.intel-lane');
            if (!lane) return;
            if (lane.classList.contains('intel-always-visible')) return;
            const laneId = String(lane.getAttribute('data-lane-id') || '');
            this.toggleIntelLaneExpand(laneId);
        });
    }

    toggleIntelLaneExpand(laneId) {
        const panel = this.elements['intel-panel'];
        if (!panel) return;
        const nextId = String(laneId || '');
        const targetId = this.expandedIntelLaneId === nextId ? '' : nextId;
        this.expandedIntelLaneId = targetId;

        const lanes = [...panel.querySelectorAll('.intel-lane')];
        panel.classList.toggle('focus-mode', Boolean(targetId));

        lanes.forEach((lane) => {
            const id = String(lane.getAttribute('data-lane-id') || '');
            const active = Boolean(targetId && id === targetId);
            lane.classList.toggle('expanded', active);
            const btn = lane.querySelector('.lane-expand-btn');
            if (btn) {
                btn.textContent = active ? '收起' : '展开';
                btn.classList.toggle('active', active);
            }
        });
    }

    notify(message, level = 'info', options = {}) {
        const notice = this.elements['ui-notice'];
        if (!notice) return;
        const { sticky = false, duration = 2400 } = options;
        if (this.noticeTimer) clearTimeout(this.noticeTimer);

        notice.textContent = String(message || '');
        notice.className = `ui-notice ${level}`;
        notice.classList.remove('hidden');

        if (!sticky) {
            this.noticeTimer = setTimeout(() => {
                notice.classList.add('hidden');
            }, Math.max(600, Number(duration) || 2400));
        }
    }

    async confirmAction({
        title = '确认操作',
        message = '',
        confirmText = '确认',
        cancelText = '取消',
        tone = 'primary'
    } = {}) {
        const panel = this.elements['ui-decision'];
        const titleEl = this.elements['ui-decision-title'];
        const messageEl = this.elements['ui-decision-message'];
        const confirmBtn = this.elements['ui-decision-confirm'];
        const cancelBtn = this.elements['ui-decision-cancel'];
        if (!panel || !titleEl || !messageEl || !confirmBtn || !cancelBtn) return false;

        if (this.decisionResolver) {
            this.decisionResolver(false);
            this.decisionResolver = null;
        }

        titleEl.textContent = String(title || '确认操作');
        messageEl.textContent = String(message || '');
        confirmBtn.textContent = String(confirmText || '确认');
        cancelBtn.textContent = String(cancelText || '取消');
        confirmBtn.className = `ui-btn ${tone === 'danger' ? 'ui-btn-danger' : 'ui-btn-primary'}`;

        panel.classList.remove('hidden');
        this.decisionOpen = true;

        return new Promise((resolve) => {
            this.decisionResolver = resolve;
        });
    }

    closeDecision(result) {
        const panel = this.elements['ui-decision'];
        if (panel) panel.classList.add('hidden');
        this.decisionOpen = false;
        if (this.decisionResolver) {
            this.decisionResolver(Boolean(result));
            this.decisionResolver = null;
        }
    }

    openPagePanel(url, title = '页面') {
        const panel = this.elements['ui-page-panel'];
        const frame = this.elements['ui-page-frame'];
        const titleEl = this.elements['ui-page-title'];
        if (!panel || !frame || !titleEl) return;
        titleEl.textContent = title;
        frame.src = url;
        panel.classList.remove('hidden');
    }

    closePagePanel() {
        const panel = this.elements['ui-page-panel'];
        const frame = this.elements['ui-page-frame'];
        if (!panel || !frame) return;
        panel.classList.add('hidden');
        frame.src = 'about:blank';
    }

    toggleVoiceInput() {
        const btn = this.elements['voice-btn'];
        const input = this.elements['player-input'];
        if (!btn || !input) return;

        btn.classList.toggle('recording');
        if (btn.classList.contains('recording')) {
            btn.style.color = '#ff5252';
            btn.style.animation = 'pulse 1s infinite';
            input.placeholder = '正在聆听... (模拟)';

            setTimeout(() => {
                input.value = '我没有恶意，只是想交换情报。';
                this.toggleVoiceInput();
                input.focus();
            }, 2000);
        } else {
            btn.style.color = '';
            btn.style.animation = '';
            input.placeholder = '输入你的行动或对话...';
        }
    }

    showLoadingScreen() {
        document.body.classList.add('loading-active');
        if (!this.elements['loading-screen']) return;
        this.elements['loading-screen'].classList.remove('hidden');
        if (this.elements['loading-progress']) this.elements['loading-progress'].style.width = '0%';
        if (this.elements['loading-log']) this.elements['loading-log'].innerHTML = '<div>> 系统初始化...</div>';
    }

    hideLoadingScreen() {
        document.body.classList.remove('loading-active');
        if (!this.elements['loading-screen']) return;
        this.elements['loading-screen'].classList.add('hidden');
    }

    updateLoadingProgress(percent, log) {
        if (this.elements['loading-progress']) this.elements['loading-progress'].style.width = `${percent}%`;
        if (this.elements['loading-log']) {
            const div = document.createElement('div');
            div.textContent = `> ${log}`;
            const logEl = this.elements['loading-log'];
            logEl.appendChild(div);
            if (logEl.children.length > 3) logEl.removeChild(logEl.children[0]);
        }
    }

    setLoading(isLoading, thinkingLabel = '系统处理中...') {
        if (!this.elements['send-btn'] || !this.elements['player-input']) return;

        const canInput = this.game && typeof this.game.canUseInput === 'function'
            ? this.game.canUseInput()
            : true;

        this.elements['send-btn'].disabled = isLoading || !canInput;
        this.elements['player-input'].disabled = isLoading || !canInput;

        if (isLoading) {
            this.elements['send-btn'].innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
            if (this.elements['typing-indicator']) this.elements['typing-indicator'].classList.remove('hidden');

            if (this.elements['thinking-progress-bar']) {
                if (this.elements['thinking-label']) this.elements['thinking-label'].textContent = thinkingLabel;
                this.elements['thinking-progress-bar'].classList.remove('hidden');
                this.startThinkingTimer();
            }
        } else {
            this.elements['send-btn'].innerHTML = '<i class="fas fa-paper-plane"></i> 发送';
            if (this.elements['typing-indicator']) this.elements['typing-indicator'].classList.add('hidden');

            if (this.elements['thinking-progress-bar']) {
                this.elements['thinking-progress-bar'].classList.add('hidden');
                this.stopThinkingTimer();
            }

            if (canInput) this.elements['player-input'].focus();
        }

        this.updateRoomActionButtons();
    }

    updateThinkingLabel(label) {
        if (this.elements['thinking-label']) this.elements['thinking-label'].textContent = label;
    }

    startThinkingTimer() {
        this.startTime = Date.now();
        if (this.thinkingTimerInterval) clearInterval(this.thinkingTimerInterval);
        this.thinkingTimerInterval = setInterval(() => {
            if (this.startTime && this.elements['thinking-timer']) {
                const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
                this.elements['thinking-timer'].textContent = `${elapsed}s`;
            }
        }, 100);
    }

    stopThinkingTimer() {
        if (this.thinkingTimerInterval) clearInterval(this.thinkingTimerInterval);
    }

    isChatVisible() {
        const chatContent = this.elements['chat-content'];
        return Boolean(chatContent && !chatContent.classList.contains('hidden'));
    }

    getChatContainer() {
        return this.elements['chat-content'] || null;
    }

    getIntelContainer(channel) {
        const safe = ['system', 'ally', 'enemy'].includes(channel) ? channel : 'system';
        const map = {
            system: this.elements['intel-system-feed'],
            ally: this.elements['intel-ally-feed'],
            enemy: this.elements['intel-enemy-feed']
        };
        return map[safe] || this.elements['intel-system-feed'] || null;
    }

    formatContent(text) {
        let content = String(text ?? '');
        content = content.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
        content = content.replace(/`(.*?)`/g, '<code>$1</code>');
        return content;
    }

    getTimestamp() {
        return new Date().toLocaleTimeString('zh-CN', {
            hour12: false,
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
    }

    formatTimeFromEpoch(ts) {
        const n = Number(ts || 0);
        if (!n) return this.getTimestamp();
        return new Date(n).toLocaleTimeString('zh-CN', {
            hour12: false,
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
    }

    normalizeLiveIntel(payload) {
        const source = payload && typeof payload === 'object' ? payload : {};
        const thought = source.thought && typeof source.thought === 'object' ? source.thought : {};
        const action = source.action && typeof source.action === 'object' ? source.action : {};
        return {
            thought: {
                text: String(thought.text || '').trim() || '等待敌方思维信号...',
                timestamp: Number(thought.timestamp || 0)
            },
            action: {
                text: String(action.text || '').trim() || '等待敌方动作信号...',
                timestamp: Number(action.timestamp || 0)
            }
        };
    }

    renderLiveIntel(payload = null) {
        if (payload) {
            this.liveIntelCache = this.normalizeLiveIntel(payload);
        }
        const thoughtText = this.elements['live-thought-text'];
        const thoughtTime = this.elements['live-thought-time'];
        const actionText = this.elements['live-action-text'];
        const actionTime = this.elements['live-action-time'];
        if (!thoughtText || !thoughtTime || !actionText || !actionTime) return;

        const thought = this.liveIntelCache?.thought || {};
        const action = this.liveIntelCache?.action || {};
        thoughtText.textContent = String(thought.text || '等待敌方思维信号...');
        thoughtTime.textContent = this.formatTimeFromEpoch(thought.timestamp);
        actionText.textContent = String(action.text || '等待敌方动作信号...');
        actionTime.textContent = this.formatTimeFromEpoch(action.timestamp);
    }

    updateLiveIntelFromEvent(type, text, timestamp = Date.now()) {
        if (type !== 'thought' && type !== 'action') return;
        const content = String(text || '').trim()
            .replace(/^内心独白[:：]\s*/u, '')
            .replace(/^动作[:：]\s*/u, '');
        if (!content) return;

        const next = this.normalizeLiveIntel(this.liveIntelCache);
        next[type] = {
            text: content,
            timestamp: Number(timestamp || Date.now())
        };
        this.renderLiveIntel(next);
    }

    detectNpcSideInText(text) {
        const game = this.game;
        if (!game || !game.npcs || !game.battlefield) return '';

        for (const [npcId, npc] of Object.entries(game.npcs)) {
            if (!npc || !npc.name || !text.includes(npc.name)) continue;
            if (Array.isArray(game.battlefield.enemies) && game.battlefield.enemies.includes(npcId)) return 'enemy';
            if (Array.isArray(game.battlefield.allies) && game.battlefield.allies.includes(npcId)) return 'ally';
        }
        return '';
    }

    resolveIntelChannel(type, text) {
        const content = String(text || '');
        const npcSide = this.detectNpcSideInText(content);
        if (npcSide) return npcSide;

        if (/\[敌方 Director\]|敌方|增援|压制|遭遇/.test(content)) return 'enemy';
        if (/\[我方 Director\]|我方|总部|支援|批准|拒绝/.test(content)) return 'ally';
        if (type === 'thought' || type === 'action') return 'enemy';
        return 'system';
    }

    appendIntelLog(channel, text, type = 'system') {
        const safeChannel = ['system', 'ally', 'enemy'].includes(channel) ? channel : 'system';
        const intelContainer = this.getIntelContainer(safeChannel);
        if (!intelContainer) return;

        const now = Date.now();
        const time = this.formatTimeFromEpoch(now);
        const content = this.formatContent(text);
        const rawText = String(text || '');
        const rawType = String(type || 'system');
        let prefix = '';
        if (type === 'thought') prefix = '<strong>内心独白:</strong> ';
        if (type === 'action') prefix = '<strong>动作:</strong> ';

        const lastEntry = intelContainer.lastElementChild;
        if (
            lastEntry
            && lastEntry.classList?.contains('intel-entry')
            && lastEntry.dataset.rawText === rawText
            && lastEntry.dataset.rawType === rawType
        ) {
            const repeat = Number(lastEntry.dataset.repeat || 1) + 1;
            lastEntry.dataset.repeat = String(repeat);
            const contentEl = lastEntry.querySelector('.intel-content');
            const timeEl = lastEntry.querySelector('.intel-time');
            if (contentEl) {
                contentEl.innerHTML = `<span class="intel-repeat">x${repeat}</span>${prefix}${content}`;
            }
            if (timeEl) timeEl.textContent = time;
            this.updateLiveIntelFromEvent(type, text, now);
            return;
        }

        const div = document.createElement('div');
        div.className = `intel-entry ${safeChannel}`;
        div.dataset.rawText = rawText;
        div.dataset.rawType = rawType;
        div.dataset.repeat = '1';

        div.innerHTML = `
            <div class="intel-content">${prefix}${content}</div>
            <div class="intel-time">${time}</div>
        `;
        intelContainer.appendChild(div);
        while (intelContainer.children.length > 80) {
            intelContainer.removeChild(intelContainer.children[0]);
        }
        intelContainer.scrollTop = intelContainer.scrollHeight;
        this.updateLiveIntelFromEvent(type, text, now);
    }

    appendLog(type, text) {
        const channel = this.resolveIntelChannel(type, text);
        this.appendIntelLog(channel, text, type);
    }

    typewriterEffect(type, prefix, content) {
        const channel = type === 'player' ? 'ally' : this.resolveIntelChannel(type, content);
        this.appendIntelLog(channel, `${prefix}${content}`, type);
    }

    renderFactionPanels(npcs, battlefield, currentNpcId, playerProfile, callInviteUsed = {}, chatFinished = {}, selectedInviteTargetId = '') {
        this.renderCharacterList(
            this.elements['ally-list'],
            battlefield.allies,
            'ally',
            npcs,
            currentNpcId,
            playerProfile,
            callInviteUsed,
            chatFinished,
            selectedInviteTargetId
        );
        this.renderCharacterList(
            this.elements['enemy-list'],
            battlefield.enemies,
            'enemy',
            npcs,
            currentNpcId,
            playerProfile,
            callInviteUsed,
            chatFinished,
            selectedInviteTargetId
        );
    }

    renderCharacterList(
        container,
        idList,
        type,
        npcs,
        currentNpcId,
        playerProfile,
        callInviteUsed = {},
        chatFinished = {},
        selectedInviteTargetId = ''
    ) {
        if (!container) return;
        container.innerHTML = '';

        if (type === 'ally') {
            const playerCard = this.createCharCard({
                id: '__player__',
                name: playerProfile.name,
                role: playerProfile.role,
                status: '在线',
                isPlayer: true,
                inviteText: callInviteUsed.__player__ ? '本回合聊天：已参与' : '本回合聊天：待分配',
                isActive: false
            });
            container.appendChild(playerCard);
        }

        idList.forEach((id) => {
            const npc = npcs[id];
            if (!npc) return;
            const isInviteSelected = String(id) === String(selectedInviteTargetId || '');
            const card = this.createCharCard({
                id,
                name: npc.name,
                role: npc.role,
                status: `${npc.mood} | ${npc.intent}`,
                inviteText: isInviteSelected
                    ? '本回合聊天：玩家邀请目标'
                    : (chatFinished[id]
                        ? '本回合聊天：已结束'
                        : (callInviteUsed[id] ? '本回合聊天：已配对' : '本回合聊天：未配对')),
                seed: npc.avatarSeed || npc.name,
                isActive: id === currentNpcId || isInviteSelected,
                isBusy: false
            });
            card.addEventListener('click', () => this.game.focusRoomByNpc(id));
            container.appendChild(card);
        });
    }

    createCharCard(data) {
        const div = document.createElement('div');
        div.className = `char-card ${data.isActive ? 'active' : ''}`;
        if (data.isBusy) div.classList.add('busy');

        const avatarUrl = data.isPlayer
            ? `https://api.dicebear.com/7.x/adventurer/svg?seed=${encodeURIComponent(data.name)}`
            : `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(data.seed || data.name)}`;

        div.innerHTML = `
            <div class="char-avatar">
                <img src="${avatarUrl}" alt="${data.name}">
            </div>
            <div class="char-info">
                <div class="char-name">${data.name}</div>
                <div class="char-role">${data.role}</div>
                <div class="char-meta">${data.status || ''}</div>
                ${data.inviteText ? `<div class="char-meta">${data.inviteText}</div>` : ''}
                <div class="char-status ${data.isActive ? 'online' : ''}">
                    <i class="fas fa-signal"></i> ${data.isActive ? '连接中' : '待机'}
                </div>
            </div>
        `;
        return div;
    }

    renderChatRoomNavigator(pairChatRooms, round, selectedRoomId, maxMessagesPerSpeaker = 10) {
        const list = this.elements['chat-nav-list'];
        if (!list) return;

        const roundNo = Number(round?.number || 0);
        const rooms = Object.values(pairChatRooms || {})
            .filter((room) => Number(room?.round || 0) === roundNo)
            .sort((a, b) => {
                const rank = (side) => (side === 'enemy' ? 0 : (side === 'ally' ? 1 : 2));
                const sideDiff = rank(a?.side) - rank(b?.side);
                if (sideDiff !== 0) return sideDiff;
                return String(a?.title || '').localeCompare(String(b?.title || ''), 'zh-CN');
            });

        list.innerHTML = '';
        if (!rooms.length) {
            const empty = document.createElement('div');
            empty.className = 'chat-nav-empty';
            empty.textContent = '本回合暂无聊天室，先点击顶部按钮发起邀请。';
            list.appendChild(empty);
            return;
        }

        rooms.forEach((room) => {
            const participants = Array.isArray(room?.participants) ? room.participants : [];
            const counts = room?.speakerCounts || {};
            const hasPlayer = participants.some((p) => p?.id === '__player__');
            const isFinished = Boolean(round?.roomFinished?.[room?.id]);
            const side = room?.side || 'system';
            const sideLabel = side === 'enemy' ? '敌方' : (side === 'ally' ? '我方' : '混合');
            const lastMsg = Array.isArray(room?.messages) && room.messages.length
                ? room.messages[room.messages.length - 1]
                : null;
            const usage = participants.map((p) => {
                const pid = String(p?.speakerId || p?.id || '');
                return `${p?.name || '未知'} ${Number(counts[pid] || 0)}/${maxMessagesPerSpeaker}`;
            }).join(' | ');
            const state = isFinished
                ? '已结束'
                : (hasPlayer ? (round?.playerChannelOpened ? '玩家通话中' : '待玩家接入') : '自动对话');

            const item = document.createElement('button');
            item.type = 'button';
            item.className = `chat-nav-item ${side} ${room.id === selectedRoomId ? 'active' : ''}`;
            item.setAttribute('data-room-id', String(room.id || ''));
            item.innerHTML = `
                <div class="chat-nav-item-head">
                    <span class="chat-nav-room-title">${room?.title || room?.id || '聊天室'}</span>
                    <span class="chat-nav-side">${sideLabel}</span>
                </div>
                <div class="chat-nav-room-meta">${state}</div>
                <div class="chat-nav-room-usage">${usage || '暂无发言'}</div>
                <div class="chat-nav-room-last">${lastMsg ? `${lastMsg.speakerName}: ${lastMsg.text}` : '暂无消息'}</div>
            `;
            list.appendChild(item);
        });
    }

    renderActiveRoom(room, round, playerProfile, maxMessagesPerSpeaker = 10) {
        const lobby = this.elements['lobby-view'];
        const chatContent = this.elements['chat-content'];
        const targetName = this.elements['chat-target-name'];
        const targetStatus = this.elements['chat-target-status'];
        if (!chatContent || !lobby || !targetName || !targetStatus) return;

        if (!room) {
            targetName.textContent = '请选择聊天室';
            targetStatus.textContent = '邀请阶段未完成';
            targetStatus.style.color = '#8dd3ea';
            lobby.classList.remove('hidden');
            chatContent.classList.add('hidden');
            chatContent.innerHTML = '';
            this.updateRoomActionButtons();
            return;
        }

        const participants = Array.isArray(room?.participants) ? room.participants : [];
        const counts = room?.speakerCounts || {};
        const hasPlayer = participants.some((p) => p?.id === '__player__');
        const side = room?.side || 'system';
        const sideLabel = side === 'enemy' ? '敌方频道' : (side === 'ally' ? '我方频道' : '混合频道');
        const isFinished = Boolean(round?.roomFinished?.[room?.id]);
        const state = isFinished
            ? '已结束'
            : (hasPlayer ? (round?.playerChannelOpened ? '玩家通话中' : '待玩家接入') : 'NPC 自动对话');
        const usage = participants.map((p) => {
            const pid = String(p?.speakerId || p?.id || '');
            return `${p?.name || '未知'} ${Number(counts[pid] || 0)}/${maxMessagesPerSpeaker}`;
        }).join(' | ');

        targetName.textContent = room?.title || room?.id || '聊天室';
        targetStatus.textContent = `${sideLabel} | ${state} | ${usage}`;
        targetStatus.style.color = side === 'enemy' ? '#ff9188' : (side === 'ally' ? '#7ee89f' : '#9adcf2');

        lobby.classList.add('hidden');
        chatContent.classList.remove('hidden');
        chatContent.innerHTML = '';

        const messages = Array.isArray(room?.messages) ? room.messages : [];
        if (!messages.length) {
            const empty = document.createElement('div');
            empty.className = 'room-feed-empty';
            empty.textContent = '聊天室已建立，等待双方发言。';
            chatContent.appendChild(empty);
        } else {
            messages.forEach((msg) => chatContent.appendChild(this.createRoomMessageNode(msg, playerProfile)));
        }

        chatContent.scrollTop = chatContent.scrollHeight;
        this.updateRoomActionButtons();
    }

    createRoomMessageNode(msg, playerProfile) {
        const row = document.createElement('div');
        const side = msg?.side === 'enemy' ? 'enemy' : (msg?.side === 'ally' ? 'ally' : 'system');
        const playerName = String(playerProfile?.name || '玩家');
        const isPlayer = msg?.type === 'player'
            || String(msg?.speakerId || '').startsWith('player_')
            || String(msg?.speakerName || '') === playerName;
        const roleClass = msg?.type === 'system' ? 'system' : (isPlayer ? 'player' : side);
        row.className = `room-msg ${roleClass}`;

        const head = document.createElement('div');
        head.className = 'room-msg-head';
        const speaker = document.createElement('span');
        speaker.className = 'room-msg-speaker';
        speaker.textContent = String(msg?.speakerName || '未知');
        const time = document.createElement('span');
        time.className = 'room-msg-time';
        time.textContent = this.formatTimeFromEpoch(msg?.timestamp);
        head.appendChild(speaker);
        head.appendChild(time);

        const body = document.createElement('div');
        body.className = 'room-msg-body';
        body.innerHTML = this.formatContent(msg?.text || '');

        row.appendChild(head);
        row.appendChild(body);
        return row;
    }

    updateRoomActionButtons() {
        const connectBtn = this.elements['room-connect-btn'];
        const hangupBtn = this.elements['hangup-btn'];
        const sendBtn = this.elements['send-btn'];
        const input = this.elements['player-input'];
        if (!connectBtn || !hangupBtn || !this.game) return;

        const canConnect = typeof this.game.canConnectSelectedRoom === 'function'
            ? this.game.canConnectSelectedRoom()
            : false;
        const canDisconnect = typeof this.game.canDisconnectSelectedRoom === 'function'
            ? this.game.canDisconnectSelectedRoom()
            : false;
        const selectedRoom = typeof this.game.getSelectedRoom === 'function'
            ? this.game.getSelectedRoom()
            : null;
        const hasPlayerRoom = Boolean(selectedRoom && (selectedRoom.participants || []).some((p) => p?.id === '__player__'));
        const isFinished = Boolean(this.game.round?.roomFinished?.[selectedRoom?.id]);
        const isLoading = Boolean(this.elements['send-btn']?.innerHTML.includes('fa-spinner'));
        const canInput = typeof this.game.canUseInput === 'function'
            ? this.game.canUseInput()
            : true;

        if (!isLoading && sendBtn && input) {
            sendBtn.disabled = !canInput;
            input.disabled = !canInput;
        }

        connectBtn.disabled = !canConnect || isLoading;
        hangupBtn.disabled = !canDisconnect || isLoading;

        if (!selectedRoom) {
            connectBtn.textContent = '接入聊天室';
            return;
        }
        if (!hasPlayerRoom) {
            connectBtn.textContent = '旁观模式';
            connectBtn.disabled = true;
            return;
        }
        if (isFinished) {
            connectBtn.textContent = '已结束';
            connectBtn.disabled = true;
            return;
        }
        if (this.game.round?.playerChannelOpened) {
            connectBtn.textContent = '已接入';
            connectBtn.disabled = true;
            return;
        }
        connectBtn.textContent = '接入本聊天室';
    }

    renderPairRoomSummary(pairChatRooms, round, maxMessagesPerSpeaker = 10) {
        const meta = this.elements['pair-room-meta'];
        const box = this.elements['pair-room-summary'];
        if (!meta || !box) return;

        const roundNo = Number(round?.number || 0);
        const roomList = Object.values(pairChatRooms || {})
            .filter((room) => Number(room?.round || 0) === roundNo)
            .sort((a, b) => {
                const rank = (side) => (side === 'enemy' ? 0 : (side === 'ally' ? 1 : 2));
                const sideA = rank(a?.side);
                const sideB = rank(b?.side);
                if (sideA !== sideB) return sideA - sideB;
                return String(a?.title || '').localeCompare(String(b?.title || ''), 'zh-CN');
            });

        if (!roomList.length) {
            meta.textContent = `第 ${roundNo || '-'} 回合暂无双人聊天室。每名成员上限 ${maxMessagesPerSpeaker} 次`;
            box.innerHTML = '';
            return;
        }

        meta.textContent = `第 ${roundNo} 回合 · ${roomList.length} 间双人聊天室 · 每名成员上限 ${maxMessagesPerSpeaker} 次`;
        box.innerHTML = '';

        const groups = [
            { side: 'enemy', label: '敌方聊天室', className: 'enemy' },
            { side: 'ally', label: '我方聊天室', className: 'ally' },
            { side: 'system', label: '混合聊天室', className: 'system' }
        ];

        groups.forEach((g) => {
            const rooms = roomList.filter((room) => (room?.side || 'enemy') === g.side);
            if (!rooms.length) return;

            const block = document.createElement('div');
            block.className = `pair-side-block ${g.className}`;
            const title = document.createElement('div');
            title.className = 'pair-side-title';
            title.textContent = `${g.label} (${rooms.length})`;
            block.appendChild(title);

            rooms.forEach((room) => {
                const item = document.createElement('div');
                item.className = 'pair-room-item';
                const counts = room?.speakerCounts || {};
                const participants = Array.isArray(room?.participants) ? room.participants : [];
                const usage = participants.map((p) => {
                    const pid = String(p?.speakerId || p?.id || '');
                    return `${p?.name || '未知'} ${Number(counts[pid] || 0)}/${maxMessagesPerSpeaker}`;
                }).join(' | ');
                const isFinished = Boolean(round?.roomFinished?.[room?.id]);
                const hasPlayer = participants.some((p) => p?.id === '__player__');
                const state = isFinished
                    ? '已结束'
                    : (hasPlayer ? (round?.playerChannelOpened ? '进行中' : '待玩家接入') : '自动对话中');

                item.innerHTML = `
                    <div class="pair-room-title">${room?.title || room?.id || '聊天室'}</div>
                    <div class="pair-room-count">${usage || '暂无发言'}</div>
                    <div class="pair-room-state">${state}</div>
                `;
                block.appendChild(item);
            });

            box.appendChild(block);
        });
    }

    updateNPCPanel(npc) {
        if (!npc) return;
        if (this.elements['chat-target-name']) this.elements['chat-target-name'].textContent = npc.name;
        if (this.elements['chat-target-status']) {
            this.elements['chat-target-status'].textContent = `${npc.mood} | ${npc.intent}`;
            if (npc.favorability > 50) this.elements['chat-target-status'].style.color = '#4caf50';
            else if (npc.favorability < -50) this.elements['chat-target-status'].style.color = '#f44336';
            else this.elements['chat-target-status'].style.color = '#00bcd4';
        }
    }

    switchToChat() {
        this.updateRoomActionButtons();
    }

    switchToLobby() {
        this.updateRoomActionButtons();
    }
}
