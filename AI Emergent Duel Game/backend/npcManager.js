import { createInitialAyla, createNpcFromProfile } from "./npcFactory.js";
import { getContextStats } from "./context/contextManager.js";

function createRoom(id, title, side) {
    return {
        id,
        title,
        side,
        messages: [],
        speakerCounts: {}
    };
}

class NPCManager {
    constructor() {
        this.sessions = new Map();
        this.sessionCounter = 1;
        this.npcCounter = 1;
    }

    nextSessionId() {
        const id = `session_${Date.now()}_${this.sessionCounter}`;
        this.sessionCounter += 1;
        return id;
    }

    nextNpcId() {
        const id = `npc_${Date.now()}_${this.npcCounter}`;
        this.npcCounter += 1;
        return id;
    }

    createSession(config, playerProfile) {
        const sessionId = this.nextSessionId();
        const aylaId = this.nextNpcId();
        const ayla = createInitialAyla(aylaId);
        const match = {
            maxRounds: 10,
            roundDurationSec: 75
        };

        const session = {
            id: sessionId,
            createdAt: Date.now(),
            config,
            playerProfile,
            match,
            npcs: { [aylaId]: ayla },
            battlefield: {
                enemies: [aylaId],
                allies: []
            },
            turnCount: 0,
            currentNpcId: aylaId,
            lastNpcResponse: "",
            pendingAllyProposal: null,
            score: {
                player: 0,
                enemy: 0
            },
            victory: {
                tracks: {
                    player: { momentum: 0, intel: 0, command: 0 },
                    enemy: { momentum: 0, intel: 0, command: 0 }
                },
                settlement: null
            },
            round: {
                number: 1,
                status: "pending_invites",
                durationSec: match.roundDurationSec,
                startedAt: null,
                endedAt: null,
                score: { player: 0, enemy: 0 },
                inviteResults: [],
                inviteRecords: [],
                callInviteUsed: {},
                chatFinished: {},
                roomFinished: {},
                pairRoomIds: [],
                pairRoomMap: {},
                playerRoomId: null,
                playerChannelOpened: false
            },
            chatRoomRules: {
                maxMessagesPerSpeaker: 10
            },
            chatRooms: {
                enemy_room: createRoom("enemy_room", "敌方聊天室", "enemy"),
                ally_room: createRoom("ally_room", "我方聊天室", "ally")
            },
            pairChatRooms: {},
            liveIntel: {
                thought: { text: "", timestamp: 0 },
                action: { text: "", timestamp: 0 }
            },
            lastRoundPairs: [],
            lastRoundInviterByPair: {},
            gameOver: false,
            winner: null,
            enemyDirectorHistory: [],
            allyDirectorHistory: [],
            timeline: []
        };

        this.sessions.set(sessionId, session);
        return session;
    }

    getSession(sessionId) {
        return this.sessions.get(sessionId);
    }

    addNpc(session, side, profile) {
        const id = this.nextNpcId();
        const npc = createNpcFromProfile(id, profile, side);
        session.npcs[id] = npc;

        if (side === "enemy") {
            session.battlefield.enemies.push(id);
        } else {
            session.battlefield.allies.push(id);
        }

        return npc;
    }

    appendTimeline(session, event) {
        session.timeline.push({
            ...event,
            timestamp: Date.now()
        });
        if (session.timeline.length > 120) {
            session.timeline = session.timeline.slice(-120);
        }
    }

    setCurrentNpc(session, npcId) {
        if (npcId && session.npcs[npcId]) {
            session.currentNpcId = npcId;
        }
    }

    serialize(session) {
        return {
            sessionId: session.id,
            playerProfile: session.playerProfile,
            match: session.match,
            npcs: session.npcs,
            battlefield: session.battlefield,
            turnCount: session.turnCount,
            currentNpcId: session.currentNpcId,
            lastNpcResponse: session.lastNpcResponse,
            pendingAllyProposal: session.pendingAllyProposal,
            score: session.score,
            victory: session.victory,
            round: session.round,
            chatRoomRules: session.chatRoomRules,
            chatRooms: session.chatRooms,
            pairChatRooms: session.pairChatRooms,
            liveIntel: session.liveIntel,
            contextStats: getContextStats(session),
            gameOver: session.gameOver,
            winner: session.winner
        };
    }
}

export const npcManager = new NPCManager();
