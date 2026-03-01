import { UIManager } from './ui.js';

export class Game {
    constructor() {
        this.config = {
            apiKey: localStorage.getItem('apiKey') || '',
            apiUrl: localStorage.getItem('apiUrl') || 'https://api.deepseek.com',
            modelName: localStorage.getItem('modelName') || 'deepseek-chat'
        };

        this.playerProfile = {
            name: localStorage.getItem('playerName') || 'V',
            role: localStorage.getItem('playerRole') || '黑客',
            personality: localStorage.getItem('playerPersonality') || '机智, 谨慎, 善于伪装'
        };

        this.sessionId = null;
        this.npcs = {};
        this.battlefield = { enemies: [], allies: [] };
        this.turnCount = 0;
        this.currentNpcId = null;
        this.connectedNpcId = null;
        this.npc = null;
        this.lastNpcResponse = '';
        this.pendingAllyProposal = null;
        this.match = { maxRounds: 0, roundDurationSec: 0 };
        this.score = { player: 0, enemy: 0 };
        this.round = null;
        this.chatRoomRules = { maxMessagesPerSpeaker: 10 };
        this.chatRooms = {};
        this.pairChatRooms = {};
        this.selectedRoomId = null;
        this.preferredInviteTargetId = null;
        this.liveIntel = {
            thought: { text: '', timestamp: 0 },
            action: { text: '', timestamp: 0 }
        };
        this.gameOver = false;
        this.winner = null;

        this.directorProgressInterval = null;
        this.roundTimerInterval = null;
        this.sessionSyncInFlight = false;
        this.isRunningDirector = false;
        this.lastRoomRenderDigest = '';
        this.setupStep = 'api';
        this.isIntroEnded = false;
        this.isFlowEnded = false;

        this.ui = new UIManager(this);
        this.isLobbyPage = !!this.ui.elements['config-panel'];
        this.isBattlePage = !!this.ui.elements['game-interface'] && !this.ui.elements['config-panel'];

        if (this.ui.elements['api-key']) this.ui.elements['api-key'].value = this.config.apiKey;
        if (this.ui.elements['api-url']) this.ui.elements['api-url'].value = this.config.apiUrl;
        if (this.ui.elements['model-name']) this.ui.elements['model-name'].value = this.config.modelName;
        if (this.ui.elements['player-name']) this.ui.elements['player-name'].value = this.playerProfile.name;
        if (this.ui.elements['player-role']) this.ui.elements['player-role'].value = this.playerProfile.role;
        if (this.ui.elements['player-personality']) this.ui.elements['player-personality'].value = this.playerProfile.personality;
        if (this.isLobbyPage) this.showSetupStep('api');

        if (this.isLobbyPage) {
            this.startIntro();
        } else if (this.isBattlePage) {
            this.bootstrapBattlePage();
        }
    }

    async requestBackend(path, method = 'GET', body = null) {
        const options = { method, headers: {} };
        if (body !== null) {
            options.headers['Content-Type'] = 'application/json';
            options.body = JSON.stringify(body);
        }

        const response = await fetch(`/api${path}`, options);
        let data = {};
        try {
            data = await response.json();
        } catch {
            data = {};
        }

        if (!response.ok) {
            const error = new Error(data.error || `Request failed (${response.status})`);
            error.status = response.status;
            error.data = data;
            throw error;
        }
        return data;
    }

    startIntro() {
        const introScreen = this.ui.elements['intro-screen'];
        const skipIntroBtn = this.ui.elements['skip-intro-btn'];
        if (!introScreen) return;

        this.isIntroEnded = false;

        introScreen.classList.remove('hidden');
        introScreen.style.display = 'flex';
        introScreen.classList.remove('pending');
        introScreen.style.animation = 'fadeInIntro 1.2s ease-in-out forwards';
        if (skipIntroBtn) {
            skipIntroBtn.disabled = false;
            skipIntroBtn.textContent = '跳过 >>';
        }
    }

    getSessionIdFromUrl() {
        const p = new URLSearchParams(window.location.search);
        return p.get('session') || '';
    }

    async bootstrapBattlePage() {
        try {
            const sessionFromUrl = this.getSessionIdFromUrl();
            const sessionFromStorage = localStorage.getItem('activeSessionId') || '';
            this.sessionId = sessionFromUrl || sessionFromStorage;

            if (!this.sessionId) {
                this.ui.notify('未找到有效会话，请先在大厅页创建对局。', 'warn', { duration: 1200 });
                setTimeout(() => {
                    window.location.href = '/';
                }, 700);
                return;
            }

            localStorage.setItem('activeSessionId', this.sessionId);
            this.ui.switchToLobby();

            const data = await this.requestBackend(`/session/${this.sessionId}`, 'GET');
            this.applyServerState(data.state);
            this.updateFactionPanels();
            this.ui.appendLog('system', `>>> 已接入会话 ${this.sessionId}`);
            this.showEntryBriefing();
        } catch (e) {
            this.ui.appendLog('system', `会话接入失败: ${e.message}`);
            this.ui.notify(`会话接入失败: ${e.message}`, 'danger', { duration: 1500 });
            setTimeout(() => {
                window.location.href = '/';
            }, 900);
        }
    }

    endIntro() {
        if (this.isIntroEnded) return;
        this.isIntroEnded = true;

        const introScreen = this.ui.elements['intro-screen'];
        if (introScreen) introScreen.style.animation = 'fadeOutIntro 0.8s ease-in-out forwards';
        setTimeout(() => {
            if (introScreen) {
                introScreen.style.display = 'none';
                introScreen.classList.add('hidden');
            }
            this.startFlowBriefing();
        }, 800);
    }

    startFlowBriefing() {
        const flowScreen = this.ui.elements['flow-screen'];
        const skipFlowBtn = this.ui.elements['skip-flow-btn'];
        if (!flowScreen) {
            this.endFlowBriefing();
            return;
        }

        this.isFlowEnded = false;

        flowScreen.classList.remove('hidden');
        flowScreen.style.display = 'flex';
        flowScreen.classList.remove('pending');
        flowScreen.style.animation = 'fadeInIntro 1.2s ease-in-out forwards';
        if (skipFlowBtn) {
            skipFlowBtn.disabled = false;
            skipFlowBtn.textContent = '跳过 >>';
        }
    }

    endFlowBriefing() {
        if (this.isFlowEnded) return;
        this.isFlowEnded = true;

        const flowScreen = this.ui.elements['flow-screen'];
        const configPanel = this.ui.elements['config-panel'];
        if (!flowScreen) {
            if (configPanel) configPanel.classList.remove('hidden');
            this.showSetupStep('api');
            return;
        }

        flowScreen.style.animation = 'fadeOutIntro 0.8s ease-in-out forwards';
        setTimeout(() => {
            flowScreen.style.display = 'none';
            flowScreen.classList.add('hidden');
            if (configPanel) configPanel.classList.remove('hidden');
            this.showSetupStep('api');
        }, 800);
    }

    showSetupStep(step = 'api') {
        if (!this.isLobbyPage) return;
        const safeStep = step === 'role' ? 'role' : 'api';
        this.setupStep = safeStep;

        const apiPage = this.ui.elements['setup-api-page'];
        const rolePage = this.ui.elements['setup-role-page'];
        const apiChip = this.ui.elements['setup-step-api'];
        const roleChip = this.ui.elements['setup-step-role'];

        if (apiPage) apiPage.classList.toggle('hidden', safeStep !== 'api');
        if (rolePage) rolePage.classList.toggle('hidden', safeStep !== 'role');
        if (apiChip) apiChip.classList.toggle('active', safeStep === 'api');
        if (roleChip) roleChip.classList.toggle('active', safeStep === 'role');
    }

    goToApiSetup() {
        this.showSetupStep('api');
    }

    goToRoleSetup(force = false) {
        const key = this.ui.elements['api-key']?.value.trim() || '';
        if (!force && !key) {
            this.ui.notify('请先填写 API Key 再进入角色设定', 'warn');
            return;
        }
        this.showSetupStep('role');
    }

    showEntryBriefing() {
        const key = `entryBriefingShown_${this.sessionId}`;
        if (sessionStorage.getItem(key) === '1') return;
        sessionStorage.setItem(key, '1');

        const lines = [
            '【入场讲解】本对局为 10 回合制：邀请阶段 -> 聊天室阶段 -> Director 推演。',
            '【入场讲解】邀请阶段中，玩家优先发起邀请；若同一目标被多人邀请，目标只接受一人，其余会被拒绝并重试。',
            '【入场讲解】每个角色每回合只能参与一次通话，玩家也只有一次，并且只能接入本回合分配对象。',
            '【入场讲解】每次对话都会按关键词倾向、好感变化等更新双方分数与战局维度。',
            '【入场讲解】详细规则可随时点击顶部“规则页”或展开“入场规则与计分说明”查看。'
        ];
        lines.forEach((line) => this.ui.appendLog('system', line));
    }

    async startGame() {
        try {
            this.config.apiKey = this.ui.elements['api-key'].value.trim();
            this.config.apiUrl = this.ui.elements['api-url'].value.trim() || 'https://api.openai.com/v1';
            this.config.modelName = this.ui.elements['model-name'].value.trim() || 'gpt-4o-mini';

            this.playerProfile.name = this.ui.elements['player-name'].value.trim() || 'V';
            this.playerProfile.role = this.ui.elements['player-role'].value;
            this.playerProfile.personality = this.ui.elements['player-personality'].value.trim() || '机智, 谨慎';

            if (!this.config.apiKey) {
                this.ui.notify('请输入 API Key', 'warn');
                return;
            }

            localStorage.setItem('apiKey', this.config.apiKey);
            localStorage.setItem('apiUrl', this.config.apiUrl);
            localStorage.setItem('modelName', this.config.modelName);
            localStorage.setItem('playerName', this.playerProfile.name);
            localStorage.setItem('playerRole', this.playerProfile.role);
            localStorage.setItem('playerPersonality', this.playerProfile.personality);

            this.ui.showLoadingScreen();
            await this.simulateInitialization();

            const initData = await this.requestBackend('/session/init', 'POST', {
                config: this.config,
                playerProfile: this.playerProfile
            });

            this.sessionId = initData.sessionId;
            localStorage.setItem('activeSessionId', this.sessionId);
            this.ui.updateLoadingProgress(100, '正在进入战局界面...');
            window.location.href = `/pages/battle.html?session=${encodeURIComponent(this.sessionId)}`;
        } catch (e) {
            this.ui.hideLoadingScreen();
            this.ui.notify(`启动游戏失败: ${e.message}`, 'danger', { sticky: true });
        }
    }

    async simulateInitialization() {
        const steps = [
            { p: 10, msg: '正在建立安全连接...' },
            { p: 30, msg: '初始化比赛规则...' },
            { p: 50, msg: '加载阵营策略引擎...' },
            { p: 70, msg: '同步回合状态...' },
            { p: 90, msg: '准备邀请流程...' },
            { p: 100, msg: '就绪。' }
        ];

        for (const step of steps) {
            this.ui.updateLoadingProgress(step.p, step.msg);
            // eslint-disable-next-line no-await-in-loop
            await new Promise((r) => setTimeout(r, 280));
        }
    }

    applyServerState(state) {
        if (!state) return;
        const previousRoundNumber = Number(this.round?.number || 0);
        this.npcs = state.npcs || {};
        this.battlefield = state.battlefield || { enemies: [], allies: [] };
        this.turnCount = state.turnCount || 0;
        this.currentNpcId = state.currentNpcId || null;
        this.lastNpcResponse = state.lastNpcResponse || '';
        this.pendingAllyProposal = state.pendingAllyProposal || null;
        this.match = state.match || this.match;
        this.score = state.score || this.score;
        this.round = state.round || this.round;
        this.chatRoomRules = state.chatRoomRules || this.chatRoomRules;
        this.chatRooms = state.chatRooms || this.chatRooms;
        this.pairChatRooms = state.pairChatRooms || this.pairChatRooms;
        this.liveIntel = state.liveIntel || this.liveIntel;
        this.gameOver = Boolean(state.gameOver);
        this.winner = state.winner || null;

        const nextRoundNumber = Number(this.round?.number || 0);
        if (nextRoundNumber !== previousRoundNumber) {
            this.preferredInviteTargetId = null;
        }

        if (this.preferredInviteTargetId && !this.npcs[this.preferredInviteTargetId]) {
            this.preferredInviteTargetId = null;
        }
        if (
            this.preferredInviteTargetId
            && (!Array.isArray(this.battlefield?.enemies) || !this.battlefield.enemies.includes(this.preferredInviteTargetId))
        ) {
            this.preferredInviteTargetId = null;
        }
        if (this.round?.status !== 'pending_invites') {
            this.preferredInviteTargetId = null;
        }

        if (this.connectedNpcId && !this.npcs[this.connectedNpcId]) {
            this.connectedNpcId = null;
        }

        if (!this.isRoundActive() && this.connectedNpcId) {
            this.connectedNpcId = null;
            this.npc = null;
        }

        this.npc = this.connectedNpcId ? this.npcs[this.connectedNpcId] : null;
        if (this.npc) this.ui.updateNPCPanel(this.npc);

        this.syncRoundTimer();
        this.updateRoundControlButton();
        this.updateHUDStatus();
        this.updateRoomPeek();
        const roomDigest = this.buildRoomRenderDigest();
        if (roomDigest !== this.lastRoomRenderDigest) {
            this.renderRoomBoards();
        }
        this.ui.renderLiveIntel(this.liveIntel);
        this.ui.updateRoomActionButtons();
    }

    getCurrentRoundRooms() {
        const roundNo = Number(this.round?.number || 0);
        return Object.values(this.pairChatRooms || {})
            .filter((room) => Number(room?.round || 0) === roundNo)
            .sort((a, b) => {
                const rank = (side) => (side === 'enemy' ? 0 : (side === 'ally' ? 1 : 2));
                const sideDiff = rank(a?.side) - rank(b?.side);
                if (sideDiff !== 0) return sideDiff;
                return String(a?.title || '').localeCompare(String(b?.title || ''), 'zh-CN');
            });
    }

    getSelectedRoom() {
        if (!this.selectedRoomId) return null;
        const room = this.pairChatRooms?.[this.selectedRoomId] || null;
        if (!room) return null;
        const roundNo = Number(this.round?.number || 0);
        return Number(room?.round || 0) === roundNo ? room : null;
    }

    resolvePreferredRoomId() {
        const rooms = this.getCurrentRoundRooms();
        if (!rooms.length) return null;

        if (this.selectedRoomId && rooms.some((room) => room.id === this.selectedRoomId)) {
            return this.selectedRoomId;
        }

        const playerRoomId = String(this.round?.playerRoomId || '');
        if (playerRoomId && rooms.some((room) => room.id === playerRoomId)) {
            return playerRoomId;
        }

        return rooms[0].id;
    }

    buildRoomRenderDigest() {
        const roundNo = Number(this.round?.number || 0);
        const roomFinishedEntries = Object.entries(this.round?.roomFinished || {})
            .sort((a, b) => String(a[0]).localeCompare(String(b[0]), 'zh-CN'))
            .map(([roomId, finished]) => `${roomId}:${finished ? 1 : 0}`);
        const rooms = this.getCurrentRoundRooms().map((room) => {
            const participants = (room?.participants || [])
                .map((p) => `${String(p?.id || '')}:${String(p?.name || '')}`)
                .join(',');
            const speakerCounts = Object.entries(room?.speakerCounts || {})
                .sort((a, b) => String(a[0]).localeCompare(String(b[0]), 'zh-CN'))
                .map(([speakerId, count]) => `${speakerId}:${Number(count || 0)}`)
                .join(',');
            const messages = Array.isArray(room?.messages) ? room.messages : [];
            const lastMsg = messages.length ? messages[messages.length - 1] : null;
            const lastMsgDigest = lastMsg
                ? `${String(lastMsg.id || '')}|${Number(lastMsg.timestamp || 0)}|${String(lastMsg.speakerId || '')}|${String(lastMsg.text || '')}`
                : '';

            return [
                String(room?.id || ''),
                String(room?.side || ''),
                String(room?.title || ''),
                participants,
                speakerCounts,
                String(messages.length),
                lastMsgDigest
            ].join('~');
        });

        return JSON.stringify({
            roundNo,
            roundStatus: String(this.round?.status || ''),
            playerRoomId: String(this.round?.playerRoomId || ''),
            playerChannelOpened: this.round?.playerChannelOpened ? 1 : 0,
            selectedRoomId: String(this.selectedRoomId || ''),
            roomFinishedEntries,
            rooms
        });
    }

    renderRoomBoards() {
        const maxMessagesPerSpeaker = Number(this.chatRoomRules?.maxMessagesPerSpeaker || 10);
        this.selectedRoomId = this.resolvePreferredRoomId();
        this.ui.renderChatRoomNavigator(
            this.pairChatRooms,
            this.round,
            this.selectedRoomId,
            maxMessagesPerSpeaker
        );

        const selectedRoom = this.getSelectedRoom();
        this.ui.renderActiveRoom(
            selectedRoom,
            this.round,
            this.playerProfile,
            maxMessagesPerSpeaker
        );
        this.lastRoomRenderDigest = this.buildRoomRenderDigest();
    }

    selectRoom(roomId) {
        const targetId = String(roomId || '');
        if (!targetId) return;
        const rooms = this.getCurrentRoundRooms();
        if (!rooms.some((room) => room.id === targetId)) {
            this.ui.appendLog('system', '>>> 该聊天室不在当前回合。');
            return;
        }
        this.selectedRoomId = targetId;
        this.renderRoomBoards();
    }

    resolvePreferredInviteTargetId() {
        if (this.preferredInviteTargetId && this.npcs[this.preferredInviteTargetId]) {
            return this.preferredInviteTargetId;
        }
        const enemyIds = (this.battlefield?.enemies || []).filter((id) => this.npcs[id]);
        return enemyIds[0] || '';
    }

    selectInviteTarget(npcId) {
        const target = String(npcId || '');
        if (!target || !this.npcs[target]) return;
        const isEnemyTarget = Array.isArray(this.battlefield?.enemies) && this.battlefield.enemies.includes(target);
        if (!isEnemyTarget) {
            this.ui.appendLog('system', '>>> 邀请规则：玩家只能邀请敌对阵营角色。');
            return;
        }
        if (!this.round || this.round.status !== 'pending_invites') {
            this.ui.appendLog('system', '>>> 当前不在邀请阶段，无法更改玩家邀请目标。');
            return;
        }
        this.preferredInviteTargetId = target;
        this.updateFactionPanels();
        this.updateRoundControlButton();
        this.ui.appendLog('system', `>>> 玩家主动邀请目标已锁定：${this.npcs[target].name}`);
    }

    focusRoomByNpc(npcId) {
        const target = String(npcId || '');
        if (!target) return;
        if (this.round?.status === 'pending_invites') {
            this.selectInviteTarget(target);
            return;
        }
        const rooms = this.getCurrentRoundRooms();
        if (!rooms.length) return;

        const room = rooms.find((r) => {
            const ids = (r.participants || []).map((p) => String(p.id));
            return ids.includes('__player__') && ids.includes(target);
        }) || rooms.find((r) => (r.participants || []).some((p) => String(p?.id || '') === target));
        if (!room) {
            this.ui.appendLog('system', `>>> [${this.npcs[target]?.name || '目标'}] 本回合未进入聊天室。`);
            return;
        }
        this.selectRoom(room.id);
    }

    getPlayerNpcIdFromRoom(room) {
        if (!room) return '';
        const participants = Array.isArray(room.participants) ? room.participants : [];
        const npc = participants.find((p) => p?.id && p.id !== '__player__');
        return String(npc?.id || '');
    }

    canConnectSelectedRoom() {
        if (!this.sessionId || !this.round || this.gameOver) return false;
        if (this.round.status !== 'active') return false;
        if (this.round.playerChannelOpened) return false;
        if (this.connectedNpcId) return false;

        const room = this.getSelectedRoom();
        if (!room) return false;
        if (String(this.round.playerRoomId || '') !== String(room.id || '')) return false;
        if (this.round.roomFinished?.[room.id]) return false;
        const npcId = this.getPlayerNpcIdFromRoom(room);
        return Boolean(npcId && this.npcs[npcId]);
    }

    canDisconnectSelectedRoom() {
        if (!this.sessionId || !this.round || this.gameOver) return false;
        if (this.round.status !== 'active') return false;
        if (!this.connectedNpcId) return false;
        const room = this.getSelectedRoom();
        if (!room) return false;
        const participantIds = (room.participants || []).map((p) => String(p.id));
        if (!participantIds.includes('__player__') || !participantIds.includes(String(this.connectedNpcId))) return false;
        if (this.round.roomFinished?.[room.id]) return false;
        return true;
    }

    async connectSelectedRoom() {
        const room = this.getSelectedRoom();
        if (!room) {
            this.ui.appendLog('system', '>>> 请先在左侧选择一个聊天室。');
            return;
        }
        if (!this.canConnectSelectedRoom()) {
            this.ui.appendLog('system', '>>> 当前聊天室不可接入，请检查回合状态或是否已消耗本轮通话机会。');
            return;
        }
        const npcId = this.getPlayerNpcIdFromRoom(room);
        if (!npcId || !this.npcs[npcId]) {
            this.ui.appendLog('system', '>>> 当前聊天室为旁观频道，无法发起玩家连接。');
            return;
        }
        await this.requestConnection(npcId);
    }

    findNpcIdBySpeaker(speaker) {
        if (!speaker) return '';
        for (const [npcId, npc] of Object.entries(this.npcs)) {
            if (npc?.name === speaker) return npcId;
        }
        return '';
    }

    getNpcIntelChannel(npcId) {
        if (!npcId) return 'system';
        if (Array.isArray(this.battlefield.enemies) && this.battlefield.enemies.includes(npcId)) return 'enemy';
        if (Array.isArray(this.battlefield.allies) && this.battlefield.allies.includes(npcId)) return 'ally';
        return 'system';
    }

    applyEvents(events) {
        if (!Array.isArray(events) || events.length === 0) return;
        for (const event of events) {
            const type = event.type || 'system';
            const text = event.text || '';
            if (!text) continue;
            if (type === 'npc') {
                const speaker = event.speaker || 'NPC';
                this.lastNpcResponse = text;
                const npcId = this.findNpcIdBySpeaker(speaker);
                this.ui.appendIntelLog(this.getNpcIntelChannel(npcId), `${speaker}: ${text}`, 'npc');
            } else {
                this.ui.appendLog(type, text);
            }
        }
        this.ui.updateRoomActionButtons();
    }

    updateFactionPanels() {
        const used = this.round?.callInviteUsed || {};
        const finished = this.round?.chatFinished || {};
        this.ui.renderFactionPanels(
            this.npcs,
            this.battlefield,
            this.connectedNpcId,
            this.playerProfile,
            used,
            finished,
            this.preferredInviteTargetId
        );
    }

    updateRoomPeek() {
        this.ui.renderPairRoomSummary(
            this.pairChatRooms,
            this.round,
            Number(this.chatRoomRules?.maxMessagesPerSpeaker || 10)
        );
    }

    formatRemainingSec(msLeft) {
        const sec = Math.max(0, Math.ceil(msLeft / 1000));
        return `${sec}s`;
    }

    updateRoundProgress() {
        const textEl = this.ui.elements['round-progress-text'];
        const percentEl = this.ui.elements['round-progress-percent'];
        const fillEl = this.ui.elements['round-progress-fill'];
        if (!textEl || !percentEl || !fillEl) return;

        const maxRounds = Math.max(1, Number(this.match?.maxRounds || 10));
        if (!this.round) {
            textEl.textContent = `回合进度：0/${maxRounds}`;
            percentEl.textContent = '0%';
            fillEl.style.width = '0%';
            return;
        }

        const currentRound = Math.min(maxRounds, Math.max(1, Number(this.round.number || 1)));
        const percent = Math.max(0, Math.min(100, Math.round((currentRound / maxRounds) * 100)));
        textEl.textContent = `回合进度：第 ${currentRound}/${maxRounds} 回合`;
        percentEl.textContent = `${percent}%`;
        fillEl.style.width = `${percent}%`;
    }

    updateHUDStatus() {
        const el = this.ui.elements['player-status'];
        if (!this.round) {
            this.updateRoundProgress();
            return;
        }

        const base = `回合 ${this.round.number}/${this.match.maxRounds} | 总分 ${this.score.player}:${this.score.enemy} | 本轮 ${this.round.score.player}:${this.round.score.enemy}`;

        if (this.gameOver) {
            const winnerText = this.winner === 'draw' ? '平局' : (this.winner === 'player' ? '我方胜利' : '敌方胜利');
            if (el) el.textContent = `${base} | 对局结束：${winnerText}`;
            this.updateRoundProgress();
            return;
        }

        if (this.round.status === 'active') {
            if (el) el.textContent = `${base} | 通话进行中：全部聊天室结束聊天后回合结束`;
            this.updateRoundProgress();
            return;
        }

        const map = {
            pending_invites: `等待邀请确认${this.preferredInviteTargetId && this.npcs[this.preferredInviteTargetId] ? `（玩家目标：${this.npcs[this.preferredInviteTargetId].name}）` : ''}`,
            ended: '回合已结束，待Director推演',
            director_done: '推演完成，等待下一轮决策'
        };
        if (el) el.textContent = `${base} | ${map[this.round.status] || '状态同步中'}`;
        this.updateRoundProgress();
    }

    updateRoundControlButton() {
        const btn = this.ui.elements['auto-play-btn'];
        if (!btn || !this.round) return;

        btn.disabled = false;
        if (this.gameOver) {
            btn.textContent = '对局已结束';
            btn.disabled = true;
            return;
        }

        if (this.round.status === 'pending_invites') {
            const targetName = this.preferredInviteTargetId && this.npcs[this.preferredInviteTargetId]
                ? this.npcs[this.preferredInviteTargetId].name
                : '';
            btn.textContent = targetName
                ? `发起第 ${this.round.number} 回合邀请（${targetName}）`
                : `发起第 ${this.round.number} 回合邀请`;
            return;
        }
        if (this.round.status === 'active') {
            btn.textContent = `第 ${this.round.number} 回合进行中`;
            return;
        }
        if (this.round.status === 'ended') {
            btn.textContent = `执行第 ${this.round.number} 回合 Director 推演`;
            return;
        }
        if (this.round.status === 'director_done') {
            btn.textContent = `开始第 ${this.round.number + 1} 回合`;
            return;
        }
        btn.textContent = '同步中...';
    }

    syncRoundTimer() {
        const shouldSync = Boolean(
            this.sessionId
            && this.round
            && this.round.status === 'active'
            && !this.gameOver
        );

        if (!shouldSync) {
            if (this.roundTimerInterval) {
                clearInterval(this.roundTimerInterval);
                this.roundTimerInterval = null;
            }
            return;
        }

        if (this.roundTimerInterval) return;
        this.roundTimerInterval = setInterval(() => {
            this.pollActiveRoundState();
        }, 1400);
        this.pollActiveRoundState();
    }

    async pollActiveRoundState() {
        if (!this.sessionId || !this.round || this.round.status !== 'active' || this.gameOver) return;
        if (this.isRunningDirector || this.sessionSyncInFlight) return;
        this.sessionSyncInFlight = true;
        const previousStatus = this.round.status;

        try {
            const data = await this.requestBackend(`/session/${this.sessionId}`, 'GET');
            this.applyServerState(data.state);
            this.applyEvents(data.events || []);
            this.updateFactionPanels();

            if (previousStatus === 'active' && this.round?.status === 'ended' && !this.isRunningDirector) {
                await this.runDirectorStep();
            }
        } catch {
            // keep silent; next poll will retry.
        } finally {
            this.sessionSyncInFlight = false;
        }
    }

    isRoundActive() {
        return Boolean(this.round && this.round.status === 'active');
    }

    canUseInput() {
        if (!this.isRoundActive() || !this.connectedNpcId || !this.npc || this.gameOver) return false;
        const room = this.getSelectedRoom();
        if (!room) return false;
        const participantIds = (room.participants || []).map((p) => String(p.id));
        return participantIds.includes('__player__') && participantIds.includes(String(this.connectedNpcId));
    }

    disconnectAllChannels(withLog = true) {
        this.connectedNpcId = null;
        this.npc = null;
        this.ui.switchToLobby();
        this.renderRoomBoards();
        this.updateFactionPanels();
        if (withLog) this.ui.appendLog('system', '>>> 通话已全部断开。');
    }

    async requestConnection(npcId) {
        if (!this.sessionId) return;
        if (!this.isRoundActive()) {
            this.ui.appendLog('system', '>>> 当前回合尚未开启通话，请先完成邀请。');
            return;
        }
        if (this.connectedNpcId && this.connectedNpcId !== npcId) {
            this.ui.appendLog('system', '>>> 请先结束当前聊天室，再发起新的通话邀请。');
            return;
        }
        if (this.connectedNpcId === npcId) return;
        const target = this.npcs[npcId];
        if (!target) return;
        const playerRoomId = this.round?.playerRoomId || '';
        const playerRoom = playerRoomId ? this.pairChatRooms?.[playerRoomId] : null;
        if (!playerRoom || !(playerRoom.participants || []).some((p) => p.id === npcId)) {
            this.ui.appendLog('system', `>>> [${target.name}] 不是你本回合分配的聊天对象。`);
            return;
        }

        const approved = await this.ui.confirmAction({
            title: '建立加密连接',
            message: `请求与 [${target.name}] 建立加密连接？`,
            confirmText: '连接',
            cancelText: '取消'
        });
        if (!approved) return;
        this.ui.setLoading(true, '建立通话链路中...');
        this.ui.appendLog('system', `>>> 正在呼叫 ${target.name}...`);
        try {
            const result = await this.requestBackend(`/session/${this.sessionId}/connect`, 'POST', { npcId });
            this.applyServerState(result.state);
            this.applyEvents(result.events || []);
            this.updateFactionPanels();
            this.ui.setLoading(false);
            this.openChannel(npcId);
            this.ui.appendLog('system', '>>> 通道已建立。');
        } catch (e) {
            if (e.data?.state) {
                this.applyServerState(e.data.state);
                this.applyEvents(e.data.events || []);
                this.updateFactionPanels();
            }
            this.ui.appendLog('system', `>>> 通话邀请失败：${e.message}`);
            this.ui.setLoading(false);
        }
    }

    openChannel(npcId) {
        this.connectedNpcId = npcId;
        this.npc = this.npcs[npcId] || null;
        if (!this.npc) return;

        const playerRoomId = String(this.round?.playerRoomId || '');
        if (playerRoomId && this.pairChatRooms?.[playerRoomId]) {
            this.selectedRoomId = playerRoomId;
        } else {
            const room = this.getCurrentRoundRooms().find((r) => (r.participants || []).some((p) => p?.id === String(npcId)));
            if (room) this.selectedRoomId = room.id;
        }
        this.ui.switchToChat();
        this.renderRoomBoards();
        this.updateFactionPanels();
    }

    async disconnectChannel() {
        if (!this.connectedNpcId) return;
        const npcId = this.connectedNpcId;
        const approved = await this.ui.confirmAction({
            title: '断开连接',
            message: '确定要断开当前加密连接吗？',
            confirmText: '断开',
            cancelText: '继续保持',
            tone: 'danger'
        });
        if (!approved) return;
        try {
            const result = await this.requestBackend(`/session/${this.sessionId}/disconnect`, 'POST', { npcId });
            this.applyServerState(result.state);
            this.applyEvents(result.events || []);
            this.connectedNpcId = null;
            this.npc = null;
            this.ui.switchToLobby();
            this.renderRoomBoards();
            this.updateFactionPanels();
            this.ui.appendLog('system', '>>> 连接已断开。');
            if (result.roundEnded && !this.isRunningDirector) {
                await this.runDirectorStep();
            }
        } catch (e) {
            if (e.data?.state) {
                this.applyServerState(e.data.state);
                this.applyEvents(e.data.events || []);
                this.updateFactionPanels();
            }
            this.ui.appendLog('system', `断开失败: ${e.message}`);
        }
    }

    async handlePlayerAction() {
        const input = this.ui.elements['player-input'].value.trim();
        if (!input) return;
        if (!this.sessionId) {
            this.ui.appendLog('system', '>>> 会话未初始化，请重新开始游戏。');
            return;
        }
        if (!this.isRoundActive()) {
            this.ui.appendLog('system', '>>> 当前回合未开启通话，请先发起邀请。');
            return;
        }
        if (!this.connectedNpcId || !this.npc) {
            this.ui.appendLog('system', '>>> 请先选择一个已接入频道再发送消息。');
            this.ui.elements['player-input'].value = '';
            return;
        }

        this.ui.elements['player-input'].value = '';
        this.ui.setLoading(true, '敌方 AI 回合处理中...');

        try {
            const result = await this.requestBackend(`/session/${this.sessionId}/player-action`, 'POST', {
                input,
                currentNpcId: this.connectedNpcId
            });

            this.applyServerState(result.state);
            this.updateFactionPanels();
            this.applyEvents(result.events || []);

            if (result.roundEnded && !this.isRunningDirector) {
                await this.runDirectorStep();
            }
        } catch (e) {
            if (e.status === 409 && e.data?.roundEnded) {
                this.applyServerState(e.data.state);
                this.applyEvents(e.data.events || []);
                await this.runDirectorStep();
            } else {
                this.ui.appendLog('system', `连接中断: ${e.message}`);
            }
        } finally {
            this.ui.setLoading(false);
        }
    }

    startDirectorProgressTicker() {
        const steps = [
            '正在读取本轮对局记录...',
            '正在执行我方战略建模...',
            '正在汇总可执行战术建议...'
        ];
        let i = 0;
        this.directorProgressInterval = setInterval(() => {
            const text = steps[i % steps.length];
            this.ui.appendLog('system', `[Director] ${text}`);
            this.ui.updateThinkingLabel(`Director AI 推演中：${text}`);
            i += 1;
        }, 1400);
    }

    stopDirectorProgressTicker() {
        if (this.directorProgressInterval) {
            clearInterval(this.directorProgressInterval);
            this.directorProgressInterval = null;
        }
    }

    async runDirectorStep() {
        if (!this.sessionId || this.isRunningDirector) return;
        this.isRunningDirector = true;
        this.ui.appendLog('system', `>>> 第 ${this.round.number} 回合结束，Director AI 开始推演。`);
        this.ui.setLoading(true, 'Director AI 推演中...');
        this.startDirectorProgressTicker();

        try {
            const result = await this.requestBackend(`/session/${this.sessionId}/director-step`, 'POST', {});
            this.applyServerState(result.state);
            this.updateFactionPanels();
            this.applyEvents(result.events || []);

            const allyTrace = Array.isArray(result.allyDirectorTrace) ? result.allyDirectorTrace : [];
            allyTrace.forEach((line) => this.ui.appendLog('system', line));

            if (result.pendingAllyProposal) {
                await this.handlePendingAllyProposal(result.pendingAllyProposal);
            }

            if (result.enemyDirectorReveal && this.gameOver) {
                this.ui.appendLog('system', '>>> 敌方 Director 全量推演日志已解锁：');
                result.enemyDirectorReveal.forEach((item) => {
                    this.ui.appendLog('system', `【敌方第 ${item.round} 回合推演】`);
                    (item.trace || []).forEach((line) => this.ui.appendLog('system', line));
                });
                this.ui.appendLog('system', '>>> 查看完整战报：请点击顶部“战报页”按钮。');
            }

            if (!this.gameOver && result.canStartNextRound) {
                const nextRoundNo = Number(this.round?.number || 0) + 1;
                this.ui.appendLog('system', `>>> Director 推演完成，系统自动进入第 ${nextRoundNo} 回合。`);
                await this.startNextRound();
            }
        } catch (e) {
            this.ui.appendLog('system', `Director 推演失败: ${e.message}`);
        } finally {
            this.stopDirectorProgressTicker();
            this.ui.setLoading(false);
            this.updateHUDStatus();
            this.updateRoundControlButton();
            this.isRunningDirector = false;
        }
    }

    async startRoundInvites() {
        if (!this.sessionId || !this.round || this.gameOver) return;
        const playerInviteTargetId = this.resolvePreferredInviteTargetId();
        if (!playerInviteTargetId || !this.npcs[playerInviteTargetId]) {
            this.ui.appendLog('system', '>>> 当前无可用邀请目标，请等待阵营更新后重试。');
            return;
        }

        const targetName = this.npcs[playerInviteTargetId].name;
        this.preferredInviteTargetId = playerInviteTargetId;
        this.ui.appendLog('system', `>>> 玩家主动邀请：${targetName}`);
        this.ui.setLoading(true, `第 ${this.round.number} 回合邀请发送中...`);
        try {
            const result = await this.requestBackend(`/session/${this.sessionId}/round/invite`, 'POST', {
                playerInviteTargetId
            });
            this.applyServerState(result.state);
            this.applyEvents(result.events || []);
            this.updateFactionPanels();

            if (result.allAccepted) {
                this.ui.appendLog('system', '>>> 邀请阶段完成，已进入聊天室阶段。');
            } else {
                this.ui.appendLog('system', '>>> 本回合未形成有效配对。');
            }
            if (result.roundEnded && !this.isRunningDirector) {
                await this.runDirectorStep();
            }
        } catch (e) {
            this.ui.appendLog('system', `邀请失败: ${e.message}`);
        } finally {
            this.ui.setLoading(false);
        }
    }

    async startNextRound() {
        if (!this.sessionId || this.gameOver) return;
        this.ui.setLoading(true, '开启下一回合...');
        try {
            const result = await this.requestBackend(`/session/${this.sessionId}/round/next`, 'POST', {});
            this.applyServerState(result.state);
            this.applyEvents(result.events || []);
            this.disconnectAllChannels(false);
            this.updateFactionPanels();
        } catch (e) {
            this.ui.appendLog('system', `开启下一回合失败: ${e.message}`);
        } finally {
            this.ui.setLoading(false);
        }
    }

    async handlePendingAllyProposal(profile) {
        const accepted = await this.ui.confirmAction({
            title: '总部通讯 · 支援接入',
            message: `检测到战局压力上升，特工 [${profile.name}] (${profile.role}) 请求接入支援。`,
            confirmText: '批准接入',
            cancelText: '拒绝',
            tone: 'primary'
        });

        try {
            const result = await this.requestBackend(`/session/${this.sessionId}/ally-decision`, 'POST', {
                accept: accepted
            });
            this.applyServerState(result.state);
            this.updateFactionPanels();
            this.applyEvents(result.events || []);
        } catch (e) {
            this.ui.appendLog('system', `支援接入失败: ${e.message}`);
        }
    }

    async toggleAutoPlay() {
        if (!this.sessionId) {
            this.ui.appendLog('system', '>>> 请先启动游戏。');
            return;
        }
        if (!this.round) return;
        if (this.gameOver) {
            this.ui.appendLog('system', '>>> 对局已结束，无法继续开启回合。');
            return;
        }
        if (this.round.status === 'pending_invites') {
            await this.startRoundInvites();
            return;
        }
        if (this.round.status === 'active') {
            this.ui.appendLog('system', `>>> 第 ${this.round.number} 回合进行中，需完成全部聊天室聊天后才能结束回合。`);
            return;
        }
        if (this.round.status === 'ended') {
            await this.runDirectorStep();
            return;
        }
        if (this.round.status === 'director_done') {
            await this.startNextRound();
            return;
        }
        this.ui.appendLog('system', '>>> 当前状态下无法执行该操作。');
    }

    openRulesPage() {
        this.ui.openPagePanel('/pages/rules.html', '规则页');
    }

    openReportPage() {
        const suffix = this.sessionId ? `?session=${encodeURIComponent(this.sessionId)}` : '';
        this.ui.openPagePanel(`/pages/report.html${suffix}`, '战报页');
    }

    openChatroomsPage() {
        const params = new URLSearchParams();
        if (this.sessionId) params.set('session', this.sessionId);
        if (this.round?.number) params.set('round', String(this.round.number));
        const qs = params.toString();
        this.ui.openPagePanel(`/pages/chatrooms.html${qs ? `?${qs}` : ''}`, '回合聊天室');
    }

    async resetGame() {
        const approved = await this.ui.confirmAction({
            title: '重置对局',
            message: '确定要重置游戏进度吗？(API Key 将保留)',
            confirmText: '确认重置',
            cancelText: '取消',
            tone: 'danger'
        });
        if (!approved) return;
        localStorage.removeItem('playerHistory');
        localStorage.removeItem('activeSessionId');
        Object.keys(sessionStorage)
            .filter((k) => k.startsWith('entryBriefingShown_'))
            .forEach((k) => sessionStorage.removeItem(k));
        window.location.href = `/?replayIntro=1&t=${Date.now()}`;
    }
}
