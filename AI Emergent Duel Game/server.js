import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LLMClient } from "./backend/llmClient.js";
import { npcManager } from "./backend/npcManager.js";
import { analyzeAllySupport, analyzeEnemyReinforcement, generateEnemyTurn, generateNpcAutoTurn } from "./backend/strategists.js";
import {
    ensureSessionContext,
    getContextSnapshot,
    getContextStats,
    recordCampRoomMessage,
    recordNpcStateUpdate,
    recordPairRoomCreated,
    recordPairRoomMessage,
    recordTimelineEvent
} from "./backend/context/contextManager.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = __dirname;
const PORT = Number(process.env.PORT || 8787);
const PLAYER_ENTITY_ID = "__player__";

const MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".ico": "image/x-icon"
};

const HTML_ENTRY_ALIASES = new Map([
    ["/", "/pages/index.html"],
    ["/index.html", "/pages/index.html"],
    ["/battle.html", "/pages/battle.html"],
    ["/chatrooms.html", "/pages/chatrooms.html"],
    ["/report.html", "/pages/report.html"],
    ["/rules.html", "/pages/rules.html"]
]);

function sendJSON(res, statusCode, payload) {
    res.writeHead(statusCode, {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
    });
    res.end(JSON.stringify(payload));
}

function safeResolvePath(urlPathname) {
    const normalizedPath = decodeURIComponent(urlPathname.split("?")[0] || "/");
    const target = HTML_ENTRY_ALIASES.get(normalizedPath) || normalizedPath;
    const resolved = path.normalize(path.join(ROOT, target));
    if (!resolved.startsWith(ROOT)) return null;
    return resolved;
}

async function readJsonBody(req) {
    let raw = "";
    for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 1_000_000) {
            throw new Error("Request body too large");
        }
    }
    if (!raw) return {};
    return JSON.parse(raw);
}

function pushEvent(session, events, event) {
    events.push(event);
    npcManager.appendTimeline(session, event);
    recordTimelineEvent(session, event);
}

function applyNpcStateUpdate(session, npc, stateUpdate) {
    if (!npc || !stateUpdate) return;
    const delta = Number(stateUpdate.favorability_change || 0);
    npc.favorability = Math.max(-100, Math.min(100, npc.favorability + delta));
    if (stateUpdate.mood) npc.mood = String(stateUpdate.mood);
    if (stateUpdate.intent) npc.intent = String(stateUpdate.intent);
    recordNpcStateUpdate(session, npc.id, stateUpdate);
}

function getNpcSide(session, npcId) {
    if (session.battlefield.enemies.includes(npcId)) return "enemy";
    if (session.battlefield.allies.includes(npcId)) return "ally";
    return "unknown";
}

function isPlayerEntity(id) {
    return String(id || "") === PLAYER_ENTITY_ID;
}

function getCharacterName(session, id) {
    if (isPlayerEntity(id)) return String(session.playerProfile?.name || "玩家");
    const npc = session.npcs[id];
    return npc ? String(npc.name || "未知") : "未知";
}

function getCharacterSide(session, id) {
    if (isPlayerEntity(id)) return "ally";
    const side = getNpcSide(session, id);
    return side === "unknown" ? "system" : side;
}

function isCrossCampPair(session, aId, bId) {
    const aSide = getCharacterSide(session, aId);
    const bSide = getCharacterSide(session, bId);
    if (aSide === "system" || bSide === "system") return false;
    return aSide !== bSide;
}

function getRoomIdBySide(side) {
    if (side === "enemy") return "enemy_room";
    if (side === "ally") return "ally_room";
    return "";
}

function canSpeakerSendInRoom(session, roomId, speakerId) {
    if (!roomId || !speakerId || !session.chatRooms || !session.chatRooms[roomId]) return false;
    const room = session.chatRooms[roomId];
    const limit = Math.max(1, Number(session.chatRoomRules?.maxMessagesPerSpeaker || 10));
    return Number(room.speakerCounts[String(speakerId)] || 0) < limit;
}

function appendRoomMessage(session, { roomId, speakerId, speakerName, side = "system", type = "npc", text }) {
    if (!roomId || !text || !session.chatRooms || !session.chatRooms[roomId]) return false;
    const room = session.chatRooms[roomId];
    const limit = Math.max(1, Number(session.chatRoomRules?.maxMessagesPerSpeaker || 10));
    const key = String(speakerId || speakerName || "unknown");
    const shouldCount = type !== "system";

    if (shouldCount) {
        const used = Number(room.speakerCounts[key] || 0);
        if (used >= limit) return false;
        room.speakerCounts[key] = used + 1;
    }

    const message = {
        id: `roommsg_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
        speakerId: key,
        speakerName: String(speakerName || "未知"),
        side,
        type,
        text: String(text),
        timestamp: Date.now()
    };
    room.messages.push(message);
    if (room.messages.length > 220) {
        room.messages = room.messages.slice(-220);
    }
    recordCampRoomMessage(session, {
        roomId,
        speakerId: key,
        speakerName: message.speakerName,
        side,
        type,
        text: message.text
    });
    return true;
}

function appendNpcRoomMessage(session, npcId, text, type = "npc") {
    const npc = session.npcs[npcId];
    if (!npc) return false;
    const side = getNpcSide(session, npcId);
    const roomId = getRoomIdBySide(side);
    if (!roomId) return false;
    return appendRoomMessage(session, {
        roomId,
        speakerId: npcId,
        speakerName: npc.name,
        side,
        type,
        text
    });
}

function getPlayerSpeakerId(session) {
    return `player_${String(session.playerProfile?.name || "player")}`;
}

function getSpeakerIdByEntity(session, entityId) {
    return isPlayerEntity(entityId) ? getPlayerSpeakerId(session) : String(entityId || "");
}

function getRoomPairKey(aId, bId) {
    const [a, b] = [String(aId || ""), String(bId || "")].sort();
    return `${a}::${b}`;
}

function getAllCharacterIds(session) {
    const ids = [PLAYER_ENTITY_ID, ...session.battlefield.enemies, ...session.battlefield.allies];
    return [...new Set(ids)].filter((id) => isPlayerEntity(id) || Boolean(session.npcs[id]));
}

function resolvePairRoomSide(session, aId, bId) {
    if (isPlayerEntity(aId) || isPlayerEntity(bId)) {
        const npcId = isPlayerEntity(aId) ? bId : aId;
        const npcSide = getNpcSide(session, npcId);
        return npcSide === "ally" ? "ally" : (npcSide === "enemy" ? "enemy" : "system");
    }
    const aSide = getNpcSide(session, aId);
    const bSide = getNpcSide(session, bId);
    if (aSide === "enemy" && bSide === "enemy") return "enemy";
    if (aSide === "ally" && bSide === "ally") return "ally";
    return "system";
}

function createPairRoom(session, roundNumber, inviterId, inviteeId) {
    if (!inviterId || !inviteeId || inviterId === inviteeId) return null;
    if (!isPlayerEntity(inviterId) && !session.npcs[inviterId]) return null;
    if (!isPlayerEntity(inviteeId) && !session.npcs[inviteeId]) return null;

    const roomId = `pair_r${roundNumber}_${String(inviterId)}_${String(inviteeId)}`;
    const side = resolvePairRoomSide(session, inviterId, inviteeId);
    const participants = [inviterId, inviteeId].map((id) => ({
        id: String(id),
        name: getCharacterName(session, id),
        side: getCharacterSide(session, id),
        speakerId: getSpeakerIdByEntity(session, id)
    }));
    const npcId = [inviterId, inviteeId].find((id) => !isPlayerEntity(id)) || null;

    const room = {
        id: roomId,
        round: roundNumber,
        npcId: npcId ? String(npcId) : null,
        side,
        title: `${getCharacterName(session, inviterId)} ⇄ ${getCharacterName(session, inviteeId)}`,
        inviterId: String(inviterId),
        inviteeId: String(inviteeId),
        participants,
        messages: [],
        speakerCounts: {},
        autoSpeakerIndex: 0,
        autoTurn: 0,
        autoDegenerateStreak: 0,
        nextAutoAt: 0
    };
    session.pairChatRooms[roomId] = room;
    recordPairRoomCreated(session, room);
    return room;
}

function getNpcOnlyRoomParticipants(session, room) {
    const participants = Array.isArray(room?.participants) ? room.participants : [];
    if (participants.some((p) => isPlayerEntity(p?.id))) return [];
    const npcs = participants
        .map((p) => ({ id: String(p?.id || ""), name: String(p?.name || "") }))
        .filter((p) => p.id && session.npcs[p.id]);
    return npcs.length === 2 ? npcs : [];
}

function getPairRoomByNpc(session, npcId, roundNumber = session.round?.number) {
    const key = String(npcId || "");
    if (!key || !roundNumber) return null;
    const map = session.round?.pairRoomMap || {};
    const roomId = map[key];
    if (!roomId) return null;
    const room = session.pairChatRooms?.[roomId] || null;
    return Number(room?.round || 0) === Number(roundNumber) ? room : null;
}

function canSpeakerSendInPairRoom(session, roomId, speakerId) {
    if (!roomId || !speakerId || !session.pairChatRooms || !session.pairChatRooms[roomId]) return false;
    const room = session.pairChatRooms[roomId];
    const limit = Math.max(1, Number(session.chatRoomRules?.maxMessagesPerSpeaker || 10));
    return Number(room.speakerCounts[String(speakerId)] || 0) < limit;
}

function appendPairRoomMessage(session, { roomId, speakerId, speakerName, side = "system", type = "npc", text }) {
    if (!roomId || !text || !session.pairChatRooms || !session.pairChatRooms[roomId]) return false;
    const room = session.pairChatRooms[roomId];
    const limit = Math.max(1, Number(session.chatRoomRules?.maxMessagesPerSpeaker || 10));
    const key = String(speakerId || speakerName || "unknown");
    const shouldCount = type !== "system";

    if (shouldCount) {
        const used = Number(room.speakerCounts[key] || 0);
        if (used >= limit) return false;
        room.speakerCounts[key] = used + 1;
    }

    const message = {
        id: `pairmsg_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
        speakerId: key,
        speakerName: String(speakerName || "未知"),
        side,
        type,
        text: String(text),
        timestamp: Date.now()
    };
    room.messages.push(message);
    if (room.messages.length > 220) {
        room.messages = room.messages.slice(-220);
    }
    recordPairRoomMessage(session, {
        roomId,
        speakerId: key,
        speakerName: message.speakerName,
        side,
        type,
        text: message.text
    });
    return true;
}

function isAllChatRoomsEndedForRound(session) {
    const roomIds = session.round?.pairRoomIds || [];
    if (!roomIds.length) return true;
    const finished = session.round?.roomFinished || {};
    return roomIds.every((roomId) => Boolean(finished[roomId]));
}

function getRoundPairedEntitySet(session) {
    const set = new Set();
    const roomIds = session.round?.pairRoomIds || [];
    roomIds.forEach((roomId) => {
        const room = session.pairChatRooms?.[roomId];
        (room?.participants || []).forEach((p) => {
            const id = String(p?.id || "");
            if (id) set.add(id);
        });
    });
    return set;
}

function getFactionParticipantIds(session, side) {
    if (side === "enemy") {
        return [...new Set((session.battlefield?.enemies || []).map((id) => String(id || "")))]
            .filter((id) => id && session.npcs[id]);
    }
    if (side === "ally") {
        const ids = [PLAYER_ENTITY_ID, ...(session.battlefield?.allies || []).map((id) => String(id || ""))];
        return [...new Set(ids)]
            .filter((id) => isPlayerEntity(id) || Boolean(session.npcs[id]));
    }
    return [];
}

function isFactionFullyConnectedInRound(session, side, pairedSet = null) {
    const ids = getFactionParticipantIds(session, side);
    if (!ids.length) return false;
    const set = pairedSet || getRoundPairedEntitySet(session);
    return ids.every((id) => set.has(id));
}

function getFullyConnectedFaction(session) {
    const pairedSet = getRoundPairedEntitySet(session);
    const enemyFull = isFactionFullyConnectedInRound(session, "enemy", pairedSet);
    const allyFull = isFactionFullyConnectedInRound(session, "ally", pairedSet);
    if (enemyFull && allyFull) return "both";
    if (enemyFull) return "enemy";
    if (allyFull) return "ally";
    return "";
}

function getRoundParticipants(session) {
    const merged = [...session.battlefield.enemies, ...session.battlefield.allies];
    const unique = [...new Set(merged)].filter((id) => session.npcs[id]);
    if (!unique.length && session.currentNpcId && session.npcs[session.currentNpcId]) {
        return [session.currentNpcId];
    }
    return unique;
}

function isRoundTimedOut(session) {
    const round = session.round;
    if (!round || round.status !== "active" || !round.endedAt) return false;
    return Date.now() >= round.endedAt;
}

function forceRoundEnd(session, reason = "timeout") {
    if (!session.round || session.round.status !== "active") return false;
    session.round.status = "ended";
    session.round.endedAt = Date.now();
    session.connectedNpcId = null;
    if (reason) {
        const event = { type: "system", text: `第 ${session.round.number} 回合已结束。` };
        npcManager.appendTimeline(session, event);
        recordTimelineEvent(session, event);
    }
    return true;
}

function shuffleArray(items) {
    const arr = items.slice();
    for (let i = arr.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

function pickInviteTarget(session, inviterId, unmatched, triedMap) {
    const tried = triedMap.get(inviterId) || new Set();
    const candidates = [...unmatched].filter((id) => (
        id !== inviterId
        && !tried.has(id)
        && isCrossCampPair(session, inviterId, id)
    ));
    if (!candidates.length) return "";

    const lastPairs = new Set(session.lastRoundPairs || []);
    const inviterSide = getCharacterSide(session, inviterId);

    const scored = candidates.map((targetId) => {
        let score = Math.random() * 0.45;
        const pairKey = getRoomPairKey(inviterId, targetId);
        const targetSide = getCharacterSide(session, targetId);
        const lastInviter = session.lastRoundInviterByPair?.[pairKey] || "";

        if (isPlayerEntity(inviterId)) {
            if (targetSide === "enemy") score += 2.2;
            else score += 0.9;
        } else if (isPlayerEntity(targetId)) {
            score += 1.6;
        }

        if (inviterSide !== targetSide) score += 0.35;
        if (lastPairs.has(pairKey)) score -= 0.7;
        if (lastInviter && lastInviter === inviterId) score -= 0.8;
        if (lastInviter && lastInviter !== inviterId) score += 0.8;

        return { targetId, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored[0]?.targetId || "";
}

function chooseInviteWinner(session, targetId, records) {
    if (!records.length) return null;
    const scored = records.map((record) => {
        const pairKey = getRoomPairKey(record.fromId, targetId);
        const lastInviter = session.lastRoundInviterByPair?.[pairKey] || "";
        let score = Math.random() * 0.35;

        if (isPlayerEntity(record.fromId)) score += 2.8;
        if (lastInviter && lastInviter === record.fromId) score -= 1.2;
        if (lastInviter && lastInviter !== record.fromId) score += 1.0;
        if (getCharacterSide(session, record.fromId) !== getCharacterSide(session, targetId)) score += 0.2;

        return { record, score };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored[0]?.record || null;
}

function resolveRoundInvitations(session, options = {}) {
    const preferredPlayerTargetId = String(options?.playerInviteTargetId || "").trim();
    const ids = getAllCharacterIds(session);
    const unmatched = new Set(ids);
    const triedMap = new Map(ids.map((id) => [id, new Set()]));
    const inviteRecords = [];
    const acceptedPairs = [];
    let cycle = 1;
    let guard = 0;

    while (unmatched.size >= 2 && guard < 12) {
        guard += 1;
        const current = [...unmatched];
        const first = current.includes(PLAYER_ENTITY_ID) ? [PLAYER_ENTITY_ID] : [];
        const others = shuffleArray(current.filter((id) => id !== PLAYER_ENTITY_ID));
        const order = [...first, ...others];
        const byTarget = new Map();

        order.forEach((inviterId) => {
            if (!unmatched.has(inviterId)) return;
            let targetId = "";
            const tried = triedMap.get(inviterId) || new Set();
            if (
                isPlayerEntity(inviterId)
                && preferredPlayerTargetId
                && preferredPlayerTargetId !== PLAYER_ENTITY_ID
                && unmatched.has(preferredPlayerTargetId)
                && !tried.has(preferredPlayerTargetId)
                && isCrossCampPair(session, inviterId, preferredPlayerTargetId)
            ) {
                targetId = preferredPlayerTargetId;
            }
            if (!targetId) {
                targetId = pickInviteTarget(session, inviterId, unmatched, triedMap);
            }
            if (!targetId) return;
            triedMap.get(inviterId).add(targetId);
            const record = {
                id: `invite_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
                cycle,
                fromId: inviterId,
                fromName: getCharacterName(session, inviterId),
                toId: targetId,
                toName: getCharacterName(session, targetId),
                status: "pending",
                reason: ""
            };
            inviteRecords.push(record);
            if (!byTarget.has(targetId)) byTarget.set(targetId, []);
            byTarget.get(targetId).push(record);
        });

        if (byTarget.size === 0) break;
        let acceptedCount = 0;

        // 玩家在邀请阶段优先作为邀请方：其邀请会先被仲裁。
        const playerInvite = [...byTarget.values()]
            .flat()
            .find((r) => r.fromId === PLAYER_ENTITY_ID && r.status === "pending");
        if (playerInvite && unmatched.has(PLAYER_ENTITY_ID) && unmatched.has(playerInvite.toId)) {
            playerInvite.status = "accepted";
            playerInvite.reason = "玩家优先邀请生效";
            acceptedPairs.push({
                inviterId: playerInvite.fromId,
                inviteeId: playerInvite.toId
            });
            unmatched.delete(playerInvite.fromId);
            unmatched.delete(playerInvite.toId);
            acceptedCount += 1;

            [...byTarget.values()].flat().forEach((r) => {
                if (r === playerInvite || r.status !== "pending") return;
                if (r.toId === playerInvite.toId) {
                    r.status = "rejected";
                    r.reason = "目标选择了玩家邀请";
                    return;
                }
                if (r.fromId === playerInvite.toId || r.toId === playerInvite.fromId || r.fromId === playerInvite.fromId) {
                    r.status = "rejected";
                    r.reason = "邀请方已锁定通话";
                }
            });
        }

        const targets = [...byTarget.keys()];
        targets.sort((a, b) => (isPlayerEntity(a) ? -1 : (isPlayerEntity(b) ? 1 : 0)));

        targets.forEach((targetId) => {
            const group = byTarget.get(targetId) || [];
            if (!group.length) return;

            const available = group.filter((r) => unmatched.has(r.fromId) && unmatched.has(targetId) && r.fromId !== targetId);
            if (!available.length) {
                group.forEach((r) => {
                    if (r.status === "pending") {
                        r.status = "rejected";
                        r.reason = "目标已锁定其他通话";
                    }
                });
                return;
            }

            const winner = chooseInviteWinner(session, targetId, available);
            if (!winner || !unmatched.has(winner.fromId) || !unmatched.has(targetId)) {
                group.forEach((r) => {
                    if (r.status === "pending") {
                        r.status = "rejected";
                        r.reason = "目标拒绝本次邀请";
                    }
                });
                return;
            }

            winner.status = "accepted";
            winner.reason = "目标接受该邀请";
            acceptedPairs.push({
                inviterId: winner.fromId,
                inviteeId: targetId
            });
            unmatched.delete(winner.fromId);
            unmatched.delete(targetId);
            acceptedCount += 1;

            group.forEach((r) => {
                if (r !== winner && r.status === "pending") {
                    r.status = "rejected";
                    r.reason = "目标选择了其他邀请方";
                }
            });
        });

        inviteRecords.forEach((r) => {
            if (r.status === "pending") {
                r.status = "rejected";
                r.reason = "目标拒绝本次邀请";
            }
        });

        if (acceptedCount === 0) break;
        cycle += 1;
    }

    return {
        inviteRecords,
        acceptedPairs,
        unmatchedIds: [...unmatched]
    };
}

function markRoomFinished(session, roomId, value) {
    const map = session.round.roomFinished || {};
    map[roomId] = Boolean(value);
    session.round.roomFinished = map;
}

function syncNpcChatFinishedByRoom(session, room, value) {
    const map = session.round.chatFinished || {};
    session.round.chatFinished = map;
    (room?.participants || []).forEach((p) => {
        if (isPlayerEntity(p.id)) return;
        map[p.id] = Boolean(value);
    });
}

function getNpcRelationByIds(session, speakerId, listenerId) {
    const speakerSide = getCharacterSide(session, speakerId);
    const listenerSide = getCharacterSide(session, listenerId);
    const hostile = speakerSide !== "system" && listenerSide !== "system" && speakerSide !== listenerSide;
    return {
        speakerSide,
        listenerSide,
        hostile
    };
}

function buildNpcAutoRoomLineFallback(session, room, speakerId, listenerId) {
    const speaker = session.npcs[speakerId];
    const listener = session.npcs[listenerId];
    if (!speaker || !listener) return "保持当前战术推进。";

    const relation = getNpcRelationByIds(session, speakerId, listenerId);
    const side = relation.speakerSide === "system"
        ? resolvePairRoomSide(session, speakerId, listenerId)
        : relation.speakerSide;
    const hostile = relation.hostile;
    const progress = Number(room?.autoTurn || 0);
    const phase = progress % 6;

    if (hostile && side === "enemy") {
        const goals = ["压缩你方行动窗口", "诱导你暴露情报节点", "切断你方下一轮邀请链"];
        const goal = goals[progress % goals.length];
        if (phase === 0) return `${listener.name}，你方窗口已被压缩，${goal}从现在开始执行。`;
        if (phase === 1) return `别再试探了，我已锁定你的通信习惯，下一条链路会被我反制。`;
        if (phase === 2) return `你只剩两个选择：交出关键坐标，或在下一轮被彻底封锁。`;
        if (phase === 3) return `你的拖延话术没用，我会在下一节点前完成诱导并收割信息。`;
        if (phase === 4) return `倒计时开始，我将优先切断你与玩家的联络窗口。`;
        return `结论不变：持续施压并放大你方失误，你的下一步会被提前拦截。`;
    }

    if (hostile && side === "ally") {
        const goals = ["拆解你的误导链路", "反制你方渗透尝试", "保护我方下一轮行动窗口"];
        const goal = goals[progress % goals.length];
        if (phase === 0) return `${listener.name}，你方话术已失效，我将优先 ${goal}。`;
        if (phase === 1) return `我已经标记你的关键节点，下一步会先封住你最常用的突破口。`;
        if (phase === 2) return `继续虚张声势没有意义，我会按反制预案逐段回收主动权。`;
        if (phase === 3) return `你每多说一句，我就多拿一条信号特征，下一轮你会更被动。`;
        if (phase === 4) return `我会先稳住我方链路，再反推你的落点与节奏。`;
        return `结论很明确：我方继续反制推进，你的下一节点会被直接钉死。`;
    }

    const goals = side === "enemy"
        ? ["压制玩家节奏", "扩大敌方情报优势", "制造话题误导"]
        : (side === "ally"
            ? ["巩固我方协同", "保护玩家行动链路", "提升指挥稳定性"]
            : ["争夺中立信息优势", "拆分双方注意力", "锁定下一轮关键邀请"]);
    const goal = goals[progress % goals.length];
    if (phase === 0) return `${listener.name}，我更新本线结论：优先 ${goal}。`;
    if (phase === 1) return `收到。我会按 ${listener.role} 能力配合，先完成链路校验与节点对齐。`;
    if (phase === 2) return `我已整理两条可执行路径，先跑低风险分支并回传中间结果。`;
    if (phase === 3) return `同意。我补充反制预案并同步触发条件，避免关键窗口被打断。`;
    if (phase === 4) return `下一步锁定高价值联系人，提前准备下一回合邀请目标与切入点。`;
    return `已同步。当前链路稳定，我会持续回传进展并保持与你同频。`;
}

function normalizeAutoLine(text) {
    return String(text || "")
        .toLowerCase()
        .replace(/\s+/g, "")
        .replace(/[，。！？、,.!?;:："'“”‘’`~!@#$%^&*()_\-+=<>{}\[\]|\\/]/g, "");
}

function buildRecentRoomLines(room, limit = 6) {
    const messages = Array.isArray(room?.messages) ? room.messages : [];
    return messages
        .slice(-Math.max(1, Number(limit || 6)))
        .map((m) => `${m?.speakerName || "未知"}: ${String(m?.text || "")}`);
}

function isDegenerateAutoLine(room, line) {
    const text = String(line || "");
    const normalized = normalizeAutoLine(text);
    if (!normalized) return true;

    const recent = (room?.messages || [])
        .slice(-8)
        .map((m) => normalizeAutoLine(m?.text || ""))
        .filter(Boolean);
    if (!recent.length) return false;

    const duplicateCount = recent.filter((msg) => (
        msg === normalized
        || (msg.length >= 8 && normalized.includes(msg))
        || (normalized.length >= 8 && msg.includes(normalized))
    )).length;

    const loopWords = ["递归", "终结", "证明", "无意义", "静默", "载体", "归零", "湮灭", "循环"];
    const loopHits = loopWords.reduce((acc, word) => (text.includes(word) ? acc + 1 : acc), 0);
    const rhetorical = text.includes("那么") && text.includes("是否");

    return duplicateCount >= 2 || loopHits >= 3 || rhetorical;
}

function isHostileLineTooFriendly(session, speakerId, listenerId, line) {
    const relation = getNpcRelationByIds(session, speakerId, listenerId);
    if (!relation.hostile) return false;
    const text = String(line || "");
    const friendlyWords = ["合作", "联手", "同盟", "共赢", "同频", "并肩", "协同", "支援", "配合"];
    return friendlyWords.some((word) => text.includes(word));
}

async function advanceNpcAutoPairRooms(session, maxLinesPerRoom = 1) {
    if (!session.round || session.round.status !== "active") return [];
    if (session.autoNpcDialogueBusy) return [];
    session.autoNpcDialogueBusy = true;

    const events = [];
    try {
        const roomIds = session.round.pairRoomIds || [];
        const llmClient = new LLMClient(session.config);
        const now = Date.now();
        const autoScoreDelta = { player: 0, enemy: 0 };

        for (const roomId of roomIds) {
            const room = session.pairChatRooms?.[roomId];
            if (!room) continue;
            if (session.round.roomFinished?.[roomId]) continue;

            const participants = getNpcOnlyRoomParticipants(session, room);
            if (participants.length !== 2) continue;
            if (Number(room.nextAutoAt || 0) > now) continue;

            for (let i = 0; i < Math.max(1, Number(maxLinesPerRoom || 1)); i += 1) {
                const allQuotaUsed = participants.every((p) => !canSpeakerSendInPairRoom(session, roomId, p.id));
                if (allQuotaUsed) {
                    markRoomFinished(session, roomId, true);
                    syncNpcChatFinishedByRoom(session, room, true);
                    appendPairRoomMessage(session, {
                        roomId,
                        speakerId: "system_pair_room",
                        speakerName: "系统",
                        side: "system",
                        type: "system",
                        text: "该聊天室已完成自动对话。"
                    });
                    pushEvent(session, events, {
                        type: "system",
                        text: `>>> [${room.title}] 自动对话已完成。`
                    });
                    break;
                }

                let idx = Number(room.autoSpeakerIndex || 0) % participants.length;
                let speaker = participants[idx];
                if (!canSpeakerSendInPairRoom(session, roomId, speaker.id)) {
                    idx = (idx + 1) % participants.length;
                    speaker = participants[idx];
                    if (!canSpeakerSendInPairRoom(session, roomId, speaker.id)) break;
                }
                const listener = participants[(idx + 1) % participants.length];
                const side = getCharacterSide(session, speaker.id);

                let line = "";
                let stateUpdate = null;
                try {
                    const generated = await generateNpcAutoTurn(session, llmClient, {
                        roomId,
                        roomTitle: room.title,
                        side,
                        speakerId: speaker.id,
                        listenerId: listener.id,
                        recentMessages: buildRecentRoomLines(room, 6)
                    });
                    line = String(generated?.reply || "").trim();
                    stateUpdate = generated?.state_update || null;
                } catch {
                    line = "";
                }
                if (!line) {
                    line = buildNpcAutoRoomLineFallback(session, room, speaker.id, listener.id);
                }
                const hasDegeneratePattern = isDegenerateAutoLine(room, line);
                const hasHostileToneError = isHostileLineTooFriendly(session, speaker.id, listener.id, line);
                if (hasDegeneratePattern || hasHostileToneError) {
                    line = buildNpcAutoRoomLineFallback(session, room, speaker.id, listener.id);
                    room.autoDegenerateStreak = Number(room.autoDegenerateStreak || 0) + 1;
                } else {
                    room.autoDegenerateStreak = 0;
                }

                appendPairRoomMessage(session, {
                    roomId,
                    speakerId: speaker.id,
                    speakerName: session.npcs[speaker.id].name,
                    side,
                    type: "npc",
                    text: line
                });
                appendNpcRoomMessage(session, speaker.id, line);
                applyNpcStateUpdate(session, session.npcs[speaker.id], stateUpdate);
                const lineDelta = applyAutoNpcLineScore(session, speaker.id, line);
                autoScoreDelta.player += Number(lineDelta?.player || 0);
                autoScoreDelta.enemy += Number(lineDelta?.enemy || 0);
                room.autoTurn = Number(room.autoTurn || 0) + 1;
                room.autoSpeakerIndex = (idx + 1) % participants.length;
                room.nextAutoAt = Date.now() + 1800;

                if (Number(room.autoDegenerateStreak || 0) >= 3) {
                    appendPairRoomMessage(session, {
                        roomId,
                        speakerId: "system_pair_room",
                        speakerName: "系统",
                        side: "system",
                        type: "system",
                        text: "检测到语义循环，系统已对该聊天室执行收束归档。"
                    });
                    markRoomFinished(session, roomId, true);
                    syncNpcChatFinishedByRoom(session, room, true);
                    pushEvent(session, events, {
                        type: "system",
                        text: `>>> [${room.title}] 触发语义循环保护，已自动收束。`
                    });
                    break;
                }
            }
        }

        if (autoScoreDelta.player > 0 || autoScoreDelta.enemy > 0) {
            pushEvent(session, events, {
                type: "system",
                text:
                    `自动聊天室积分变化：我方 +${autoScoreDelta.player} / 敌方 +${autoScoreDelta.enemy}。` +
                    ` 总分：${session.score.player} : ${session.score.enemy}`
            });
        }

        if (session.round.status === "active" && isAllChatRoomsEndedForRound(session)) {
            session.round.status = "ended";
            session.round.endedAt = Date.now();
            pushEvent(session, events, {
                type: "system",
                text: `第 ${session.round.number} 回合已满足结束条件：全部聊天室结束聊天，等待 Director AI 推演。`
            });
        }

        return events;
    } finally {
        session.autoNpcDialogueBusy = false;
    }
}

function scoreTurnFromReply(enemyReply) {
    let player = 1;
    let enemy = 1;
    const text = `${enemyReply?.reply || ""} ${enemyReply?.action || ""} ${enemyReply?.internal_thought || ""}`;

    const playerSignals = ["合作", "交易", "停火", "情报", "让步", "信任", "谈判"];
    const enemySignals = ["压制", "锁定", "歼灭", "背叛", "威胁", "清除", "伏击"];

    if (playerSignals.some((w) => text.includes(w))) player += 2;
    if (enemySignals.some((w) => text.includes(w))) enemy += 2;

    const favorabilityDelta = Number(enemyReply?.state_update?.favorability_change || 0);
    if (favorabilityDelta > 0) player += 1;
    if (favorabilityDelta < 0) enemy += 1;

    return { player, enemy };
}

function countKeywords(text, words) {
    const source = String(text || "");
    return words.reduce((acc, w) => (source.includes(w) ? acc + 1 : acc), 0);
}

function updateVictoryTracks(session, delta) {
    if (!session.victory) return;
    const tracks = session.victory.tracks || {};
    const player = tracks.player || { momentum: 0, intel: 0, command: 0 };
    const enemy = tracks.enemy || { momentum: 0, intel: 0, command: 0 };
    tracks.player = player;
    tracks.enemy = enemy;
    session.victory.tracks = tracks;

    const p = delta?.player || {};
    const e = delta?.enemy || {};
    ["momentum", "intel", "command"].forEach((k) => {
        player[k] = Math.max(0, Number(player[k] || 0) + Number(p[k] || 0));
        enemy[k] = Math.max(0, Number(enemy[k] || 0) + Number(e[k] || 0));
    });
}

function calcIntelTrackDelta(playerInput, npcOutput = "") {
    const text = `${playerInput || ""} ${npcOutput || ""}`;
    const playerIntelWords = ["情报", "交换", "合作", "停火", "协议", "漏洞", "后门", "信任", "线索", "坐标", "渗透"];
    const enemyIntelWords = ["误导", "伏击", "压制", "清除", "锁定", "背叛", "欺骗", "反制", "封锁", "歼灭"];
    const player = countKeywords(text, playerIntelWords);
    const enemy = countKeywords(text, enemyIntelWords);
    return { player, enemy };
}

function applyAutoNpcLineScore(session, speakerId, line) {
    if (!session?.round || session.round.status !== "active") return { player: 0, enemy: 0 };
    const side = getCharacterSide(session, speakerId);
    if (side !== "ally" && side !== "enemy") return { player: 0, enemy: 0 };

    const delta = side === "ally"
        ? { player: 1, enemy: 0 }
        : { player: 0, enemy: 1 };
    session.round.score.player += delta.player;
    session.round.score.enemy += delta.enemy;
    session.score.player += delta.player;
    session.score.enemy += delta.enemy;

    const intelDelta = calcIntelTrackDelta("", line);
    updateVictoryTracks(session, {
        player: {
            momentum: delta.player,
            intel: intelDelta.player,
            command: side === "ally" ? 1 : 0
        },
        enemy: {
            momentum: delta.enemy,
            intel: intelDelta.enemy,
            command: side === "enemy" ? 1 : 0
        }
    });
    return delta;
}

function settleMatchAfterTenRounds(session) {
    const tracks = session.victory?.tracks || {
        player: { momentum: 0, intel: 0, command: 0 },
        enemy: { momentum: 0, intel: 0, command: 0 }
    };
    const score = session.score || { player: 0, enemy: 0 };
    const categories = [
        { key: "momentum", label: "战术动量", weight: 3 },
        { key: "intel", label: "情报渗透", weight: 3 },
        { key: "command", label: "阵营协同", weight: 2 }
    ];

    const victoryPoints = { player: 0, enemy: 0 };
    const breakdown = [];

    categories.forEach((item) => {
        const p = Number(tracks.player?.[item.key] || 0);
        const e = Number(tracks.enemy?.[item.key] || 0);
        let winner = "draw";
        if (p > e) {
            victoryPoints.player += item.weight;
            winner = "player";
        } else if (e > p) {
            victoryPoints.enemy += item.weight;
            winner = "enemy";
        } else {
            victoryPoints.player += 1;
            victoryPoints.enemy += 1;
        }
        breakdown.push({ ...item, player: p, enemy: e, winner });
    });

    const scoreWeight = 4;
    let scoreWinner = "draw";
    if (score.player > score.enemy) {
        victoryPoints.player += scoreWeight;
        scoreWinner = "player";
    } else if (score.enemy > score.player) {
        victoryPoints.enemy += scoreWeight;
        scoreWinner = "enemy";
    } else {
        victoryPoints.player += 2;
        victoryPoints.enemy += 2;
    }
    breakdown.push({
        key: "score",
        label: "总积分",
        weight: scoreWeight,
        player: score.player,
        enemy: score.enemy,
        winner: scoreWinner
    });

    let winner = "draw";
    if (victoryPoints.player > victoryPoints.enemy) winner = "player";
    else if (victoryPoints.enemy > victoryPoints.player) winner = "enemy";
    else if (score.player > score.enemy) winner = "player";
    else if (score.enemy > score.player) winner = "enemy";

    return {
        maxRounds: session.match.maxRounds,
        finalRound: session.round.number,
        victoryPoints,
        breakdown,
        totalScore: score,
        winner
    };
}

function newRoundState(session, roundNumber) {
    return {
        number: roundNumber,
        status: "pending_invites",
        durationSec: session.match.roundDurationSec,
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
    };
}

async function handleInitSession(body, res) {
    const config = body?.config || {};
    const playerProfile = body?.playerProfile || {};

    if (!config.apiKey) {
        return sendJSON(res, 400, { error: "API Key is required" });
    }

    const session = npcManager.createSession(
        {
            apiKey: String(config.apiKey || ""),
            apiUrl: String(config.apiUrl || "https://api.openai.com/v1"),
            modelName: String(config.modelName || "gpt-4o-mini")
        },
        {
            name: String(playerProfile.name || "V"),
            role: String(playerProfile.role || "黑客"),
            personality: String(playerProfile.personality || "机智, 谨慎")
        }
    );
    ensureSessionContext(session);

    const events = [
        { type: "system", text: `你遭遇了 ${session.npcs[session.currentNpcId].name}，战局开始。` },
        { type: "system", text: "初始角色仅有玩家与艾拉。每轮先进行邀请阶段，再进入聊天室阶段。" },
        { type: "system", text: `胜利条件：固定进行 ${session.match.maxRounds} 回合，回合结束后统一清算（战术动量/情报渗透/阵营协同 + 总积分）。` }
    ];
    events.forEach((event) => {
        npcManager.appendTimeline(session, event);
        recordTimelineEvent(session, event);
    });
    appendRoomMessage(session, {
        roomId: "enemy_room",
        speakerId: "system_enemy_room",
        speakerName: "系统",
        side: "system",
        type: "system",
        text: "你正在窥探敌方聊天室。规则：每名成员最多发言 10 次。"
    });
    appendRoomMessage(session, {
        roomId: "ally_room",
        speakerId: "system_ally_room",
        speakerName: "系统",
        side: "system",
        type: "system",
        text: "你正在窥探我方聊天室。规则：每名成员最多发言 10 次。"
    });
    appendNpcRoomMessage(session, session.currentNpcId, "目标已就位，等待通话窗口开启。");

    return sendJSON(res, 200, {
        sessionId: session.id,
        state: npcManager.serialize(session),
        events
    });
}

async function handleRoundInvite(sessionId, body, res) {
    const session = npcManager.getSession(sessionId);
    if (!session) return sendJSON(res, 404, { error: "Session not found" });
    if (session.gameOver) return sendJSON(res, 400, { error: "Game is over" });
    if (!session.round || session.round.status !== "pending_invites") {
        return sendJSON(res, 400, { error: "Round is not ready for invitations" });
    }

    const events = [];
    const requestedTargetId = String(body?.playerInviteTargetId || "").trim();
    const playerInviteTargetId = (
        requestedTargetId
        && session.npcs[requestedTargetId]
        && isCrossCampPair(session, PLAYER_ENTITY_ID, requestedTargetId)
    ) ? requestedTargetId : "";

    if (requestedTargetId && !playerInviteTargetId) {
        pushEvent(session, events, {
            type: "system",
            text: ">>> 玩家指定邀请目标无效（仅可邀请敌方角色），已切换为自动邀请策略。"
        });
    }
    if (playerInviteTargetId) {
        pushEvent(session, events, {
            type: "system",
            text: `>>> 玩家主动邀请目标：${getCharacterName(session, playerInviteTargetId)}`
        });
    }
    pushEvent(session, events, {
        type: "system",
        text: `>>> 第 ${session.round.number} 回合邀请阶段开始（玩家优先发起）。`
    });

    const inviteOutcome = resolveRoundInvitations(session, { playerInviteTargetId });
    const inviteRecords = inviteOutcome.inviteRecords || [];
    const rawAcceptedPairs = inviteOutcome.acceptedPairs || [];
    const acceptedPairs = rawAcceptedPairs
        .filter((pair) => isCrossCampPair(session, pair.inviterId, pair.inviteeId))
        .map((pair) => {
            const key = getRoomPairKey(pair.inviterId, pair.inviteeId);
            const lastInviter = session.lastRoundInviterByPair?.[key] || "";
            if (lastInviter && lastInviter === pair.inviterId) {
                return {
                    inviterId: pair.inviteeId,
                    inviteeId: pair.inviterId,
                    roleSwapped: true,
                    originalInviterId: pair.inviterId
                };
            }
            return { ...pair, roleSwapped: false, originalInviterId: pair.inviterId };
        });
    const unmatchedIds = inviteOutcome.unmatchedIds || [];

    session.round.inviteRecords = inviteRecords;
    session.round.inviteResults = acceptedPairs.map((p) => ({
        inviterId: p.inviterId,
        inviterName: getCharacterName(session, p.inviterId),
        inviteeId: p.inviteeId,
        inviteeName: getCharacterName(session, p.inviteeId),
        accepted: true
    }));

    const now = Date.now();
    session.round.status = "active";
    session.round.startedAt = now;
    session.round.endedAt = null;
    session.round.callInviteUsed = {};
    session.round.chatFinished = {};
    session.round.roomFinished = {};
    session.round.pairRoomIds = [];
    session.round.pairRoomMap = {};
    session.round.playerRoomId = null;
    session.round.playerChannelOpened = false;

    inviteRecords.forEach((record) => {
        pushEvent(session, events, {
            type: "system",
            text:
                `[邀请阶段][第${record.cycle}轮] ${record.fromName} -> ${record.toName}: ` +
                `${record.status === "accepted" ? "接受" : "拒绝"}${record.reason ? `（${record.reason}）` : ""}`
        });
    });
    acceptedPairs
        .filter((p) => p.roleSwapped)
        .forEach((pair) => {
            pushEvent(session, events, {
                type: "system",
                text:
                    `>>> 邀请方轮换规则生效：本回合由 ${getCharacterName(session, pair.inviterId)} ` +
                    `作为邀请方（对 ${getCharacterName(session, pair.inviteeId)}）。`
            });
        });

    acceptedPairs.forEach((pair) => {
        const room = createPairRoom(session, session.round.number, pair.inviterId, pair.inviteeId);
        if (!room) return;

        session.round.pairRoomIds.push(room.id);
        session.round.pairRoomMap[pair.inviterId] = room.id;
        session.round.pairRoomMap[pair.inviteeId] = room.id;
        session.round.callInviteUsed[pair.inviterId] = now;
        session.round.callInviteUsed[pair.inviteeId] = now;

        appendPairRoomMessage(session, {
            roomId: room.id,
            speakerId: "system_pair_room",
            speakerName: "系统",
            side: "system",
            type: "system",
            text:
                `邀请阶段完成：${getCharacterName(session, pair.inviterId)} 邀请 ` +
                `${getCharacterName(session, pair.inviteeId)}。聊天室开启（每人 ${session.chatRoomRules.maxMessagesPerSpeaker} 次）。`
        });

        if (isPlayerEntity(pair.inviterId) || isPlayerEntity(pair.inviteeId)) {
            session.round.playerRoomId = room.id;
            markRoomFinished(session, room.id, false);
            syncNpcChatFinishedByRoom(session, room, false);
        } else {
            markRoomFinished(session, room.id, false);
            syncNpcChatFinishedByRoom(session, room, false);
        }
    });

    if (session.round.status === "active") {
        const autoEvents = await advanceNpcAutoPairRooms(session, 1);
        events.push(...autoEvents);
    }

    if (!acceptedPairs.length) {
        session.round.status = "ended";
        session.round.endedAt = Date.now();
        pushEvent(session, events, {
            type: "system",
            text: `第 ${session.round.number} 回合邀请阶段结束：未形成有效通话配对，回合直接结束。`
        });
    } else {
        const fullFaction = getFullyConnectedFaction(session);
        if (fullFaction === "both") {
            pushEvent(session, events, {
                type: "system",
                text: "对话阶段启动条件满足：敌我双方均已全员接入本回合聊天室。"
            });
        } else if (fullFaction === "enemy") {
            pushEvent(session, events, {
                type: "system",
                text: "对话阶段启动条件满足：敌方阵营已全员接入本回合聊天室。"
            });
        } else if (fullFaction === "ally") {
            pushEvent(session, events, {
                type: "system",
                text: "对话阶段启动条件满足：我方阵营已全员接入本回合聊天室。"
            });
        }

        const hasPlayerRoom = Boolean(session.round.playerRoomId);
        if (hasPlayerRoom) {
            const room = session.pairChatRooms[session.round.playerRoomId];
            const other = (room?.participants || []).find((p) => !isPlayerEntity(p.id));
            pushEvent(session, events, {
                type: "system",
                text: `第 ${session.round.number} 回合聊天室阶段开始：你可与 ${other?.name || "目标"} 进行一次通话。`
            });
        } else {
            pushEvent(session, events, {
                type: "system",
                text: `第 ${session.round.number} 回合你未进入配对，本回合仅可旁观其他聊天室。`
            });
        }
    }

    if (unmatchedIds.length) {
        const names = unmatchedIds.map((id) => getCharacterName(session, id)).join("、");
        pushEvent(session, events, {
            type: "system",
            text: `邀请阶段结束：未配对角色 ${names}（本回合无通话）。`
        });
    }

    let roundEnded = false;
    if (session.round.status === "active" && isAllChatRoomsEndedForRound(session)) {
        session.round.status = "ended";
        session.round.endedAt = Date.now();
        roundEnded = true;
        pushEvent(session, events, {
            type: "system",
            text: `第 ${session.round.number} 回合已满足结束条件：全部聊天室结束聊天，等待 Director AI 推演。`
        });
    }

    const inviterMap = {};
    const pairKeys = [];
    acceptedPairs.forEach((pair) => {
        const key = getRoomPairKey(pair.inviterId, pair.inviteeId);
        pairKeys.push(key);
        inviterMap[key] = pair.inviterId;
    });
    session.lastRoundPairs = pairKeys;
    session.lastRoundInviterByPair = inviterMap;

    return sendJSON(res, 200, {
        state: npcManager.serialize(session),
        events,
        inviteResults: session.round.inviteResults,
        inviteRecords,
        allAccepted: acceptedPairs.length > 0,
        roundEnded
    });
}

async function handleRoundEnd(sessionId, body, res) {
    const session = npcManager.getSession(sessionId);
    if (!session) return sendJSON(res, 404, { error: "Session not found" });

    const reason = String(body?.reason || "manual");
    const events = [];

    if (session.round.status === "active") {
        forceRoundEnd(session, reason);
        pushEvent(session, events, {
            type: "system",
            text: `第 ${session.round.number} 回合已结束，等待 Director AI 推演。`
        });
    }

    return sendJSON(res, 200, {
        state: npcManager.serialize(session),
        events
    });
}

async function handleConnect(sessionId, body, res) {
    const session = npcManager.getSession(sessionId);
    if (!session) return sendJSON(res, 404, { error: "Session not found" });
    if (session.gameOver) return sendJSON(res, 400, { error: "Game is over" });
    if (!session.round || session.round.status !== "active") {
        return sendJSON(res, 400, { error: "Round is not active" });
    }

    const npcId = String(body?.npcId || "").trim();
    if (!npcId || !session.npcs[npcId]) {
        return sendJSON(res, 400, { error: "npcId is invalid" });
    }
    const side = getNpcSide(session, npcId);
    if (side === "unknown") {
        return sendJSON(res, 400, { error: "npc side is unknown" });
    }

    const events = [];
    const playerRoomId = session.round.playerRoomId;
    if (!playerRoomId || !session.pairChatRooms[playerRoomId]) {
        pushEvent(session, events, {
            type: "system",
            text: ">>> 你本回合没有可接入的聊天室。"
        });
        return sendJSON(res, 409, { error: "Player has no room in this round", state: npcManager.serialize(session), events });
    }

    const room = session.pairChatRooms[playerRoomId];
    const participantIds = (room.participants || []).map((p) => String(p.id));
    if (!participantIds.includes(PLAYER_ENTITY_ID) || !participantIds.includes(npcId)) {
        pushEvent(session, events, {
            type: "system",
            text: `>>> [${session.npcs[npcId].name}] 不在你本回合分配的聊天室中。`
        });
        return sendJSON(res, 409, { error: "Target npc is not paired with player this round", state: npcManager.serialize(session), events });
    }

    if (session.round.playerChannelOpened) {
        pushEvent(session, events, {
            type: "system",
            text: ">>> 你本回合通话机会已消耗，无法再次建立连接。"
        });
        return sendJSON(res, 409, { error: "Player call chance already used this round", state: npcManager.serialize(session), events });
    }
    if (session.round.roomFinished?.[room.id]) {
        pushEvent(session, events, {
            type: "system",
            text: `>>> 与 [${session.npcs[npcId].name}] 的聊天室已结束。`
        });
        return sendJSON(res, 409, { error: "Room already finished", state: npcManager.serialize(session), events });
    }

    session.round.playerChannelOpened = true;
    session.round.callInviteUsed[PLAYER_ENTITY_ID] = Date.now();
    session.round.chatFinished[npcId] = false;
    pushEvent(session, events, {
        type: "system",
        text: `>>> 本回合通话接入成功：${session.npcs[npcId].name}`
    });
    appendPairRoomMessage(session, {
        roomId: room.id,
        speakerId: "system_pair_room",
        speakerName: "系统",
        side: "system",
        type: "system",
        text: `[${session.npcs[npcId].name}] 已连接本回合聊天室。`
    });

    return sendJSON(res, 200, {
        state: npcManager.serialize(session),
        events,
        granted: true
    });
}

async function handleDisconnect(sessionId, body, res) {
    const session = npcManager.getSession(sessionId);
    if (!session) return sendJSON(res, 404, { error: "Session not found" });
    if (session.gameOver) return sendJSON(res, 400, { error: "Game is over" });
    if (!session.round || session.round.status !== "active") {
        return sendJSON(res, 400, { error: "Round is not active" });
    }

    const npcId = String(body?.npcId || "").trim();
    if (!npcId || !session.npcs[npcId]) {
        return sendJSON(res, 400, { error: "npcId is invalid" });
    }

    const events = [];
    const playerRoomId = session.round.playerRoomId;
    if (!playerRoomId || !session.pairChatRooms[playerRoomId]) {
        pushEvent(session, events, {
            type: "system",
            text: ">>> 你本回合没有可结束的聊天室。"
        });
        return sendJSON(res, 409, { error: "Player has no room in this round", state: npcManager.serialize(session), events });
    }

    const room = session.pairChatRooms[playerRoomId];
    const participantIds = (room.participants || []).map((p) => String(p.id));
    if (!participantIds.includes(PLAYER_ENTITY_ID) || !participantIds.includes(npcId)) {
        return sendJSON(res, 409, {
            error: "Target npc is not paired with player this round",
            state: npcManager.serialize(session),
            events
        });
    }
    if (session.round.roomFinished?.[room.id]) {
        return sendJSON(res, 409, {
            error: "Room already finished",
            state: npcManager.serialize(session),
            events
        });
    }

    markRoomFinished(session, room.id, true);
    syncNpcChatFinishedByRoom(session, room, true);
    appendNpcRoomMessage(session, npcId, "本回合聊天室已结束聊天。", "system");
    appendPairRoomMessage(session, {
        roomId: room.id,
        speakerId: "system_pair_room",
        speakerName: "系统",
        side: "system",
        type: "system",
        text: "聊天室已结束。"
    });
    pushEvent(session, events, {
        type: "system",
        text: `>>> [${session.npcs[npcId].name}] 聊天已结束。`
    });

    let roundEnded = false;
    if (isAllChatRoomsEndedForRound(session)) {
        session.round.status = "ended";
        session.round.endedAt = Date.now();
        roundEnded = true;
        pushEvent(session, events, {
            type: "system",
            text: `第 ${session.round.number} 回合已满足结束条件：全部聊天室结束聊天，等待 Director AI 推演。`
        });
    }

    return sendJSON(res, 200, {
        state: npcManager.serialize(session),
        events,
        roundEnded
    });
}

async function handlePlayerAction(sessionId, body, res) {
    const session = npcManager.getSession(sessionId);
    if (!session) return sendJSON(res, 404, { error: "Session not found" });
    if (session.gameOver) return sendJSON(res, 400, { error: "Game is over" });

    const input = String(body?.input || "").trim();
    const connectedNpcId = body?.currentNpcId ? String(body.currentNpcId) : "";

    if (!input) return sendJSON(res, 400, { error: "input is required" });
    if (!connectedNpcId || !session.npcs[connectedNpcId]) {
        return sendJSON(res, 400, { error: "currentNpcId is invalid" });
    }
    if (!session.round || session.round.status !== "active") {
        return sendJSON(res, 400, { error: "Round is not active" });
    }

    const events = [];
    if (!session.round.playerChannelOpened) {
        pushEvent(session, events, {
            type: "system",
            text: ">>> 当前回合尚未建立玩家通话连接，请先发起连接。"
        });
        return sendJSON(res, 409, {
            error: "Player channel is not connected for this round",
            state: npcManager.serialize(session),
            events,
            roundEnded: false
        });
    }
    const side = getNpcSide(session, connectedNpcId);
    const roomId = getRoomIdBySide(side);
    if (!roomId || side === "unknown") {
        return sendJSON(res, 400, { error: "current npc room is invalid" });
    }
    const pairRoom = getPairRoomByNpc(session, connectedNpcId);
    if (!pairRoom) {
        return sendJSON(res, 409, { error: "pair chat room not found for current round", state: npcManager.serialize(session) });
    }
    const participantIds = (pairRoom.participants || []).map((p) => String(p.id));
    if (!participantIds.includes(PLAYER_ENTITY_ID)) {
        return sendJSON(res, 409, { error: "current room is not a player room", state: npcManager.serialize(session) });
    }
    if (session.round.roomFinished?.[pairRoom.id]) {
        return sendJSON(res, 409, { error: "current room is finished", state: npcManager.serialize(session), roundEnded: true });
    }

    const playerSpeakerId = getPlayerSpeakerId(session);
    const canPlayerSpeak = canSpeakerSendInPairRoom(session, pairRoom.id, playerSpeakerId);
    if (!canPlayerSpeak) {
        pushEvent(session, events, {
            type: "system",
            text: `>>> 你在聊天室 [${pairRoom.title}] 发言已达上限（${session.chatRoomRules.maxMessagesPerSpeaker}次），请结束当前聊天。`
        });
        return sendJSON(res, 409, {
            error: "Player speaker quota reached in this chat room",
            state: npcManager.serialize(session),
            events,
            roundEnded: false
        });
    }

    if (!canSpeakerSendInPairRoom(session, pairRoom.id, connectedNpcId)) {
        pushEvent(session, events, {
            type: "system",
            text: `>>> [${session.npcs[connectedNpcId].name}] 在聊天室 [${pairRoom.title}] 发言已达上限，请结束当前聊天。`
        });
        return sendJSON(res, 409, {
            error: "NPC speaker quota reached in this chat room",
            state: npcManager.serialize(session),
            events,
            roundEnded: false
        });
    }

    appendPairRoomMessage(session, {
        roomId: pairRoom.id,
        speakerId: playerSpeakerId,
        speakerName: String(session.playerProfile?.name || "玩家"),
        side: "ally",
        type: "player",
        text: input
    });
    appendRoomMessage(session, {
        roomId,
        speakerId: playerSpeakerId,
        speakerName: String(session.playerProfile?.name || "玩家"),
        side: "ally",
        type: "player",
        text: input
    });
    const playerEvent = { type: "player", text: input };
    npcManager.appendTimeline(session, playerEvent);
    recordTimelineEvent(session, playerEvent);

    if (side === "ally") {
        const allyNpc = session.npcs[connectedNpcId];
        const allyReply = `收到，${session.playerProfile?.name || "指挥官"}。我方已记录并执行你的指令。`;
        session.lastNpcResponse = allyReply;
        pushEvent(session, events, { type: "npc", speaker: allyNpc.name, text: allyReply });
        appendNpcRoomMessage(session, connectedNpcId, allyReply);
        appendPairRoomMessage(session, {
            roomId: pairRoom.id,
            speakerId: connectedNpcId,
            speakerName: allyNpc.name,
            side,
            type: "npc",
            text: allyReply
        });

        session.turnCount += 1;
        const delta = { player: 1, enemy: 0 };
        session.round.score.player += delta.player;
        session.round.score.enemy += delta.enemy;
        session.score.player += delta.player;
        session.score.enemy += delta.enemy;
        const intelDelta = calcIntelTrackDelta(input, allyReply);
        updateVictoryTracks(session, {
            player: {
                momentum: delta.player,
                intel: intelDelta.player,
                command: 2
            },
            enemy: {
                momentum: delta.enemy,
                intel: intelDelta.enemy,
                command: 0
            }
        });

        pushEvent(session, events, {
            type: "system",
            text: `本轮积分变化：我方 +${delta.player} / 敌方 +${delta.enemy}。总分：${session.score.player} : ${session.score.enemy}`
        });

        return sendJSON(res, 200, {
            state: npcManager.serialize(session),
            events,
            roundEnded: false
        });
    }

    const preferredEnemyId = connectedNpcId;
    npcManager.setCurrentNpc(session, preferredEnemyId);

    const llm = new LLMClient(session.config);
    let enemyReply;
    try {
        enemyReply = await generateEnemyTurn(session, llm, input, preferredEnemyId);
    } catch (e) {
        return sendJSON(res, 500, { error: `enemy turn failed: ${e.message}` });
    }

    // Pair chat is strictly player <-> connected NPC in the current round.
    const activeNpcId = preferredEnemyId;

    npcManager.setCurrentNpc(session, activeNpcId);
    const activeNpc = session.npcs[activeNpcId];
    applyNpcStateUpdate(session, activeNpc, enemyReply?.state_update);

    if (enemyReply?.internal_thought) {
        const thoughtText = String(enemyReply.internal_thought);
        pushEvent(session, events, { type: "thought", text: thoughtText });
        session.liveIntel = session.liveIntel || {
            thought: { text: "", timestamp: 0 },
            action: { text: "", timestamp: 0 }
        };
        session.liveIntel.thought = { text: thoughtText, timestamp: Date.now() };
    }
    if (enemyReply?.action) {
        const actionText = String(enemyReply.action);
        pushEvent(session, events, { type: "action", text: actionText });
        session.liveIntel = session.liveIntel || {
            thought: { text: "", timestamp: 0 },
            action: { text: "", timestamp: 0 }
        };
        session.liveIntel.action = { text: actionText, timestamp: Date.now() };
    }
    if (enemyReply?.reply) {
        const replyText = String(enemyReply.reply);
        session.lastNpcResponse = replyText;
        activeNpc.memory.push({
            role: "assistant",
            content: JSON.stringify(enemyReply)
        });
        pushEvent(session, events, { type: "npc", speaker: activeNpc.name, text: replyText });
        appendNpcRoomMessage(session, activeNpcId, replyText);
        const replyPairRoom = getPairRoomByNpc(session, activeNpcId) || pairRoom;
        if (replyPairRoom) {
            appendPairRoomMessage(session, {
                roomId: replyPairRoom.id,
                speakerId: activeNpcId,
                speakerName: activeNpc.name,
                side: getNpcSide(session, activeNpcId),
                type: "npc",
                text: replyText
            });
        }
    }

    session.turnCount += 1;
    const delta = scoreTurnFromReply(enemyReply);
    session.round.score.player += delta.player;
    session.round.score.enemy += delta.enemy;
    session.score.player += delta.player;
    session.score.enemy += delta.enemy;
    const intelDelta = calcIntelTrackDelta(input, session.lastNpcResponse || "");
    updateVictoryTracks(session, {
        player: {
            momentum: delta.player,
            intel: intelDelta.player,
            command: 0
        },
        enemy: {
            momentum: delta.enemy,
            intel: intelDelta.enemy,
            command: 1
        }
    });

    pushEvent(session, events, {
        type: "system",
        text: `本轮积分变化：我方 +${delta.player} / 敌方 +${delta.enemy}。总分：${session.score.player} : ${session.score.enemy}`
    });

    return sendJSON(res, 200, {
        state: npcManager.serialize(session),
        events,
        roundEnded: false
    });
}

async function handleDirectorStep(sessionId, res) {
    const session = npcManager.getSession(sessionId);
    if (!session) return sendJSON(res, 404, { error: "Session not found" });
    if (session.round.status !== "ended") {
        return sendJSON(res, 400, { error: "Round must be ended before director analysis" });
    }

    const llm = new LLMClient(session.config);
    const events = [];
    const allyTrace = [];
    const enemyTrace = [];
    const round = session.round.number;
    const startAt = Date.now();

    const allyLog = (text) => allyTrace.push(text);
    const enemyLog = (text) => enemyTrace.push(text);

    allyLog(`[我方 Director] 第 ${round} 回合推演开始`);
    allyLog("[我方 Director] Step 1/3: 汇总我方态势与全局上下文");
    enemyLog(`[敌方 Director] 第 ${round} 回合推演开始`);
    enemyLog("[敌方 Director] Step 1/3: 汇总敌方态势与全局上下文");

    enemyLog("[敌方 Director] Step 2/3: 评估是否需要敌方增援");
    try {
        const enemyStart = Date.now();
        const enemyDecision = await analyzeEnemyReinforcement(session, llm);
        const enemyCost = Date.now() - enemyStart;
        enemyLog(`[敌方 Director] 结论: ${enemyDecision.action || "none"} (${enemyCost}ms)`);

        if (enemyDecision?.action === "spawn_enemy" && enemyDecision.character_profile) {
            const newNpc = npcManager.addNpc(session, "enemy", enemyDecision.character_profile);
            updateVictoryTracks(session, {
                player: { momentum: 0, intel: 0, command: 0 },
                enemy: { momentum: 0, intel: 0, command: 3 }
            });
            pushEvent(session, events, {
                type: "system",
                text: `⚠️ 检测到敌方增援：[${newNpc.name}] 已加入敌方阵营。`
            });
            pushEvent(session, events, {
                type: "npc",
                speaker: newNpc.name,
                text: enemyDecision.character_profile.intro_dialogue || "敌方增援已到位。"
            });
            appendNpcRoomMessage(
                session,
                newNpc.id,
                enemyDecision.character_profile.intro_dialogue || "敌方增援已到位。"
            );
            enemyLog(`[敌方 Director] 增援执行: ${newNpc.name} 已接入`);
        } else {
            enemyLog("[敌方 Director] 本轮未触发增援");
        }
    } catch (e) {
        pushEvent(session, events, { type: "system", text: "敌方战略分析暂时中断。" });
        enemyLog(`[敌方 Director] 分析异常: ${e.message || "unknown error"}`);
    }

    allyLog("[我方 Director] Step 2/3: 评估我方支援提案");
    try {
        const allyStart = Date.now();
        const allyDecision = await analyzeAllySupport(session, llm);
        const allyCost = Date.now() - allyStart;
        allyLog(`[我方 Director] 结论: ${allyDecision.action || "none"} (${allyCost}ms)`);

        if (allyDecision?.action === "propose_ally" && allyDecision.character_profile && !session.pendingAllyProposal) {
            session.pendingAllyProposal = allyDecision.character_profile;
            pushEvent(session, events, {
                type: "system",
                text: `总部建议接入我方支援：[${allyDecision.character_profile.name}]，等待玩家确认。`
            });
            allyLog(`[我方 Director] 已生成支援提案: ${allyDecision.character_profile.name}`);
        } else if (session.pendingAllyProposal) {
            allyLog("[我方 Director] 支援提案仍待玩家确认");
        } else {
            allyLog("[我方 Director] 本轮不发起支援提案");
        }
    } catch (e) {
        pushEvent(session, events, { type: "system", text: "我方战略分析暂时中断。" });
        allyLog(`[我方 Director] 分析异常: ${e.message || "unknown error"}`);
    }

    allyLog("[我方 Director] Step 3/3: 输出我方推演结论");
    allyLog(`[我方 Director] 第 ${round} 回合推演完成，耗时 ${Date.now() - startAt}ms`);
    enemyLog("[敌方 Director] Step 3/3: 输出敌方推演结论");
    enemyLog(`[敌方 Director] 第 ${round} 回合推演完成，耗时 ${Date.now() - startAt}ms`);

    session.allyDirectorHistory.push({ round, trace: allyTrace });
    session.enemyDirectorHistory.push({ round, trace: enemyTrace });
    session.round.status = "director_done";

    if (session.round.number >= session.match.maxRounds) {
        const settlement = settleMatchAfterTenRounds(session);
        session.victory.settlement = settlement;
        session.gameOver = true;
        session.winner = settlement.winner;

        pushEvent(session, events, {
            type: "system",
            text: `=== 十轮清算开始（共 ${session.match.maxRounds} 回合） ===`
        });
        settlement.breakdown.forEach((row) => {
            const winnerText = row.winner === "draw" ? "平" : (row.winner === "player" ? "我方" : "敌方");
            pushEvent(session, events, {
                type: "system",
                text: `[清算] ${row.label}: 我方 ${row.player} / 敌方 ${row.enemy} -> ${winnerText}`
            });
        });
        pushEvent(session, events, {
            type: "system",
            text: `[清算] 胜点: 我方 ${settlement.victoryPoints.player} / 敌方 ${settlement.victoryPoints.enemy}`
        });
        pushEvent(session, events, {
            type: "system",
            text:
                settlement.winner === "draw"
                    ? `对局结束：平局。最终积分 ${session.score.player} : ${session.score.enemy}`
                    : `对局结束：${settlement.winner === "player" ? "玩家阵营胜利" : "敌方阵营胜利"}。最终积分 ${session.score.player} : ${session.score.enemy}`
        });
    }

    return sendJSON(res, 200, {
        state: npcManager.serialize(session),
        events,
        allyDirectorTrace: allyTrace,
        canStartNextRound: !session.gameOver,
        enemyDirectorReveal: session.gameOver ? session.enemyDirectorHistory : null,
        pendingAllyProposal: session.pendingAllyProposal
    });
}

async function handleRoundNext(sessionId, res) {
    const session = npcManager.getSession(sessionId);
    if (!session) return sendJSON(res, 404, { error: "Session not found" });
    if (session.gameOver) return sendJSON(res, 400, { error: "Game is over" });
    if (session.round.status !== "director_done") {
        return sendJSON(res, 400, { error: "Current round analysis is not finished" });
    }
    if (session.round.number >= session.match.maxRounds) {
        return sendJSON(res, 400, { error: "Max rounds reached, waiting final settlement" });
    }

    const nextNo = session.round.number + 1;
    session.round = newRoundState(session, nextNo);

    const events = [];
    pushEvent(session, events, {
        type: "system",
        text: `第 ${nextNo} 回合准备开始：请先发起邀请，全部同意后方可通话。`
    });

    return sendJSON(res, 200, {
        state: npcManager.serialize(session),
        events
    });
}

async function handleAllyDecision(sessionId, body, res) {
    const session = npcManager.getSession(sessionId);
    if (!session) return sendJSON(res, 404, { error: "Session not found" });

    const profile = session.pendingAllyProposal;
    if (!profile) return sendJSON(res, 400, { error: "No pending ally proposal" });

    const accept = Boolean(body?.accept);
    const events = [];

    if (accept) {
        const ally = npcManager.addNpc(session, "ally", profile);
        const introText = profile.intro_dialogue || "我方支援已上线，等待你的下一步指令。";
        updateVictoryTracks(session, {
            player: { momentum: 0, intel: 0, command: 3 },
            enemy: { momentum: 0, intel: 0, command: 0 }
        });
        pushEvent(session, events, { type: "system", text: `✅ 你已批准我方支援：[${ally.name}] 已接入。` });
        pushEvent(session, events, {
            type: "npc",
            speaker: ally.name,
            text: introText
        });
        appendNpcRoomMessage(session, ally.id, introText);
    } else {
        updateVictoryTracks(session, {
            player: { momentum: 0, intel: 0, command: 0 },
            enemy: { momentum: 0, intel: 0, command: 1 }
        });
        pushEvent(session, events, { type: "system", text: ">>> 你拒绝了本次我方支援接入提案。" });
    }

    session.pendingAllyProposal = null;

    return sendJSON(res, 200, {
        state: npcManager.serialize(session),
        events
    });
}

async function handleGetSession(sessionId, res) {
    const session = npcManager.getSession(sessionId);
    if (!session) return sendJSON(res, 404, { error: "Session not found" });
    const events = await advanceNpcAutoPairRooms(session, 2);
    return sendJSON(res, 200, {
        state: npcManager.serialize(session),
        contextStats: getContextStats(session),
        events
    });
}

async function handleGetContext(sessionId, res) {
    const session = npcManager.getSession(sessionId);
    if (!session) return sendJSON(res, 404, { error: "Session not found" });
    const events = await advanceNpcAutoPairRooms(session, 2);
    return sendJSON(res, 200, {
        sessionId: session.id,
        snapshot: getContextSnapshot(session),
        events
    });
}

async function handleGetChatRooms(sessionId, res) {
    const session = npcManager.getSession(sessionId);
    if (!session) return sendJSON(res, 404, { error: "Session not found" });
    const events = await advanceNpcAutoPairRooms(session, 2);
    const currentRound = Number(session.round?.number || 0);
    const pairRooms = Object.values(session.pairChatRooms || {});
    const sideRank = (side) => {
        if (side === "enemy") return 0;
        if (side === "ally") return 1;
        return 2;
    };
    const currentRoundPairRooms = pairRooms
        .filter((room) => Number(room?.round || 0) === currentRound)
        .sort((a, b) => {
            const sideDiff = sideRank(a?.side) - sideRank(b?.side);
            if (sideDiff !== 0) return sideDiff;
            return String(a?.title || "").localeCompare(String(b?.title || ""), "zh-CN");
        });

    return sendJSON(res, 200, {
        round: session.round,
        chatRoomRules: session.chatRoomRules,
        chatRooms: session.chatRooms,
        pairChatRooms: session.pairChatRooms,
        currentRoundPairRooms,
        contextStats: getContextStats(session),
        inviteRecords: session.round?.inviteRecords || [],
        events
    });
}

async function handlePostgameReport(sessionId, res) {
    const session = npcManager.getSession(sessionId);
    if (!session) return sendJSON(res, 404, { error: "Session not found" });
    if (!session.gameOver) {
        return sendJSON(res, 409, { error: "Game is not over yet" });
    }

    return sendJSON(res, 200, {
        sessionId: session.id,
        playerProfile: session.playerProfile,
        match: session.match,
        score: session.score,
        victory: session.victory,
        winner: session.winner,
        totalRounds: session.round.number,
        allyDirectorHistory: session.allyDirectorHistory,
        enemyDirectorHistory: session.enemyDirectorHistory,
        timeline: session.timeline.slice(-200)
    });
}

const server = createServer(async (req, res) => {
    try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const { pathname } = url;

        if (req.method === "OPTIONS") {
            res.writeHead(204, {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
                "Access-Control-Allow-Headers": "Content-Type"
            });
            return res.end();
        }

        if (req.method === "POST" && pathname === "/api/session/init") {
            const body = await readJsonBody(req);
            return handleInitSession(body, res);
        }

        const inviteMatch = pathname.match(/^\/api\/session\/([^/]+)\/round\/invite$/);
        if (req.method === "POST" && inviteMatch) {
            const body = await readJsonBody(req);
            return handleRoundInvite(inviteMatch[1], body, res);
        }

        const roundEndMatch = pathname.match(/^\/api\/session\/([^/]+)\/round\/end$/);
        if (req.method === "POST" && roundEndMatch) {
            const body = await readJsonBody(req);
            return handleRoundEnd(roundEndMatch[1], body, res);
        }

        const playerActionMatch = pathname.match(/^\/api\/session\/([^/]+)\/player-action$/);
        if (req.method === "POST" && playerActionMatch) {
            const body = await readJsonBody(req);
            return handlePlayerAction(playerActionMatch[1], body, res);
        }

        const connectMatch = pathname.match(/^\/api\/session\/([^/]+)\/connect$/);
        if (req.method === "POST" && connectMatch) {
            const body = await readJsonBody(req);
            return handleConnect(connectMatch[1], body, res);
        }

        const disconnectMatch = pathname.match(/^\/api\/session\/([^/]+)\/disconnect$/);
        if (req.method === "POST" && disconnectMatch) {
            const body = await readJsonBody(req);
            return handleDisconnect(disconnectMatch[1], body, res);
        }

        const directorStepMatch = pathname.match(/^\/api\/session\/([^/]+)\/director-step$/);
        if (req.method === "POST" && directorStepMatch) {
            return handleDirectorStep(directorStepMatch[1], res);
        }

        const roundNextMatch = pathname.match(/^\/api\/session\/([^/]+)\/round\/next$/);
        if (req.method === "POST" && roundNextMatch) {
            return handleRoundNext(roundNextMatch[1], res);
        }

        const allyDecisionMatch = pathname.match(/^\/api\/session\/([^/]+)\/ally-decision$/);
        if (req.method === "POST" && allyDecisionMatch) {
            const body = await readJsonBody(req);
            return handleAllyDecision(allyDecisionMatch[1], body, res);
        }

        const getSessionMatch = pathname.match(/^\/api\/session\/([^/]+)$/);
        if (req.method === "GET" && getSessionMatch) {
            return handleGetSession(getSessionMatch[1], res);
        }

        const getContextMatch = pathname.match(/^\/api\/session\/([^/]+)\/context$/);
        if (req.method === "GET" && getContextMatch) {
            return handleGetContext(getContextMatch[1], res);
        }

        const chatRoomsMatch = pathname.match(/^\/api\/session\/([^/]+)\/chatrooms$/);
        if (req.method === "GET" && chatRoomsMatch) {
            return handleGetChatRooms(chatRoomsMatch[1], res);
        }

        const reportMatch = pathname.match(/^\/api\/session\/([^/]+)\/report$/);
        if (req.method === "GET" && reportMatch) {
            return handlePostgameReport(reportMatch[1], res);
        }

        const filePath = safeResolvePath(pathname);
        if (!filePath) return sendJSON(res, 403, { error: "Forbidden" });

        try {
            const content = await readFile(filePath);
            const ext = path.extname(filePath).toLowerCase();
            res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
            return res.end(content);
        } catch {
            return sendJSON(res, 404, { error: "Not found" });
        }
    } catch (e) {
        return sendJSON(res, 500, { error: e.message || "Server error" });
    }
});

server.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`Server running at http://localhost:${PORT}`);
});
