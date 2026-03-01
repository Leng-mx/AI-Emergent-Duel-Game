const CONTEXT_LIMITS = {
    global: 480,
    roundEvents: 260,
    roomMessages: 220,
    npcEvents: 180,
    npcMessages: 220
};

function safeRoundNo(session) {
    return Math.max(0, Number(session?.round?.number || 0));
}

function asText(value, fallback = "") {
    const text = String(value ?? "").trim();
    return text || fallback;
}

function pushCapped(arr, item, max) {
    arr.push(item);
    if (arr.length > max) {
        arr.splice(0, arr.length - max);
    }
}

function resolveNpcIdByName(session, speakerName) {
    const target = asText(speakerName, "");
    if (!target || !session?.npcs) return "";
    for (const [npcId, npc] of Object.entries(session.npcs)) {
        if (String(npc?.name || "") === target) return npcId;
    }
    return "";
}

function ensureRoundBucket(hub, roundNo) {
    const key = String(Math.max(0, Number(roundNo || 0)));
    if (!hub.rounds[key]) {
        hub.rounds[key] = {
            number: Number(key),
            events: [],
            roomIds: []
        };
    }
    return hub.rounds[key];
}

function ensureRoomBucket(hub, roomId, base = {}) {
    const key = asText(roomId, "");
    if (!key) return null;
    if (!hub.rooms[key]) {
        hub.rooms[key] = {
            id: key,
            round: Number(base.round || 0),
            side: asText(base.side, "system"),
            title: asText(base.title, key),
            participants: Array.isArray(base.participants) ? base.participants.map((p) => ({
                id: asText(p?.id, ""),
                name: asText(p?.name, "未知"),
                side: asText(p?.side, "system")
            })) : [],
            messages: [],
            updatedAt: Date.now()
        };
    } else {
        const room = hub.rooms[key];
        if (base.round !== undefined) room.round = Number(base.round || room.round || 0);
        if (base.side) room.side = asText(base.side, room.side || "system");
        if (base.title) room.title = asText(base.title, room.title || key);
        if (Array.isArray(base.participants) && base.participants.length) {
            room.participants = base.participants.map((p) => ({
                id: asText(p?.id, ""),
                name: asText(p?.name, "未知"),
                side: asText(p?.side, "system")
            }));
        }
        room.updatedAt = Date.now();
    }
    return hub.rooms[key];
}

function ensureNpcBucket(hub, session, npcId) {
    const key = asText(npcId, "");
    if (!key) return null;
    const npc = session?.npcs?.[key];
    const side = Array.isArray(session?.battlefield?.enemies) && session.battlefield.enemies.includes(key)
        ? "enemy"
        : (Array.isArray(session?.battlefield?.allies) && session.battlefield.allies.includes(key) ? "ally" : "system");
    if (!hub.npcs[key]) {
        hub.npcs[key] = {
            id: key,
            name: asText(npc?.name, key),
            side,
            events: [],
            messages: [],
            updatedAt: Date.now()
        };
    } else {
        hub.npcs[key].name = asText(npc?.name, hub.npcs[key].name || key);
        hub.npcs[key].side = side;
        hub.npcs[key].updatedAt = Date.now();
    }
    return hub.npcs[key];
}

function appendGlobalAndRound(session, entry) {
    const hub = ensureSessionContext(session);
    const roundNo = Number(entry.round || safeRoundNo(session));
    const roundBucket = ensureRoundBucket(hub, roundNo);
    pushCapped(hub.global, entry, CONTEXT_LIMITS.global);
    pushCapped(roundBucket.events, entry, CONTEXT_LIMITS.roundEvents);
    hub.updatedAt = Number(entry.timestamp || Date.now());
}

export function ensureSessionContext(session) {
    if (!session || typeof session !== "object") return null;
    if (!session.contextHub || typeof session.contextHub !== "object") {
        session.contextHub = {
            version: 1,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            global: [],
            rounds: {},
            rooms: {},
            npcs: {}
        };
    }
    return session.contextHub;
}

export function getContextStats(session) {
    const hub = ensureSessionContext(session);
    if (!hub) return null;
    return {
        version: hub.version,
        updatedAt: hub.updatedAt,
        globalEvents: hub.global.length,
        rounds: Object.keys(hub.rounds).length,
        rooms: Object.keys(hub.rooms).length,
        npcs: Object.keys(hub.npcs).length
    };
}

export function recordTimelineEvent(session, event) {
    if (!session || !event) return;
    const roundNo = safeRoundNo(session);
    const timestamp = Date.now();
    const entry = {
        kind: "timeline",
        round: roundNo,
        type: asText(event.type, "system"),
        speaker: asText(event.speaker, ""),
        text: asText(event.text, ""),
        timestamp
    };
    appendGlobalAndRound(session, entry);

    const npcId = resolveNpcIdByName(session, entry.speaker);
    if (npcId) {
        const hub = ensureSessionContext(session);
        const bucket = ensureNpcBucket(hub, session, npcId);
        if (bucket) {
            pushCapped(bucket.events, entry, CONTEXT_LIMITS.npcEvents);
            bucket.updatedAt = timestamp;
        }
    }
}

export function recordPairRoomCreated(session, room) {
    if (!session || !room?.id) return;
    const hub = ensureSessionContext(session);
    const bucket = ensureRoomBucket(hub, room.id, {
        round: Number(room.round || safeRoundNo(session)),
        side: room.side,
        title: room.title,
        participants: room.participants || []
    });
    if (!bucket) return;
    const roundBucket = ensureRoundBucket(hub, bucket.round || safeRoundNo(session));
    if (!roundBucket.roomIds.includes(bucket.id)) {
        roundBucket.roomIds.push(bucket.id);
    }
    hub.updatedAt = Date.now();
}

function recordRoomMessageCommon(session, payload, kind) {
    if (!session || !payload?.roomId || !payload?.text) return;
    const roundNo = safeRoundNo(session);
    const timestamp = Date.now();
    const entry = {
        kind,
        round: roundNo,
        roomId: asText(payload.roomId, ""),
        speakerId: asText(payload.speakerId, ""),
        speakerName: asText(payload.speakerName, "未知"),
        side: asText(payload.side, "system"),
        type: asText(payload.type, "npc"),
        text: asText(payload.text, ""),
        timestamp
    };
    appendGlobalAndRound(session, entry);

    const hub = ensureSessionContext(session);
    const roundRoom = session?.pairChatRooms?.[entry.roomId] || session?.chatRooms?.[entry.roomId];
    const room = ensureRoomBucket(hub, entry.roomId, {
        round: Number(roundRoom?.round || roundNo),
        side: roundRoom?.side || entry.side,
        title: roundRoom?.title || entry.roomId,
        participants: roundRoom?.participants || []
    });
    if (room) {
        pushCapped(room.messages, entry, CONTEXT_LIMITS.roomMessages);
        room.updatedAt = timestamp;
        const rb = ensureRoundBucket(hub, room.round || roundNo);
        if (!rb.roomIds.includes(room.id)) rb.roomIds.push(room.id);
    }

    const npcId = entry.speakerId && session?.npcs?.[entry.speakerId]
        ? entry.speakerId
        : resolveNpcIdByName(session, entry.speakerName);
    if (npcId) {
        const npcBucket = ensureNpcBucket(hub, session, npcId);
        if (npcBucket) {
            pushCapped(npcBucket.messages, entry, CONTEXT_LIMITS.npcMessages);
            npcBucket.updatedAt = timestamp;
        }
    }
}

export function recordCampRoomMessage(session, payload) {
    recordRoomMessageCommon(session, payload, "camp_room");
}

export function recordPairRoomMessage(session, payload) {
    recordRoomMessageCommon(session, payload, "pair_room");
}

export function recordNpcStateUpdate(session, npcId, stateUpdate) {
    if (!session || !npcId || !stateUpdate) return;
    const hub = ensureSessionContext(session);
    const bucket = ensureNpcBucket(hub, session, npcId);
    if (!bucket) return;
    const npc = session.npcs?.[npcId];
    const entry = {
        kind: "npc_state",
        round: safeRoundNo(session),
        npcId: asText(npcId, ""),
        speakerName: asText(npc?.name, ""),
        favorability: Number(npc?.favorability || 0),
        mood: asText(npc?.mood, ""),
        intent: asText(npc?.intent, ""),
        delta: Number(stateUpdate?.favorability_change || 0),
        timestamp: Date.now()
    };
    pushCapped(bucket.events, entry, CONTEXT_LIMITS.npcEvents);
    appendGlobalAndRound(session, entry);
}

function formatTime(timestamp) {
    const t = Number(timestamp || 0);
    if (!t) return "--:--:--";
    return new Date(t).toLocaleTimeString("zh-CN", {
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
    });
}

function formatEntry(entry) {
    const time = formatTime(entry.timestamp);
    if (entry.kind === "timeline") {
        if (entry.type === "npc") return `[${time}] NPC(${entry.speaker || "未知"}): ${entry.text}`;
        if (entry.type === "player") return `[${time}] 玩家: ${entry.text}`;
        if (entry.type === "action") return `[${time}] 动作: ${entry.text}`;
        if (entry.type === "thought") return `[${time}] 内心: ${entry.text}`;
        return `[${time}] 系统: ${entry.text}`;
    }
    if (entry.kind === "npc_state") {
        return `[${time}] 状态(${entry.speakerName || entry.npcId}): 好感=${entry.favorability} 心态=${entry.mood} 意图=${entry.intent}`;
    }
    const roomTag = entry.roomId ? `[${entry.roomId}]` : "";
    return `[${time}]${roomTag}${entry.speakerName || "未知"}: ${entry.text}`;
}

function formatRoomContext(roomBucket, limit = 16) {
    if (!roomBucket) return "无";
    const lines = roomBucket.messages.slice(-Math.max(1, Number(limit || 16))).map(formatEntry);
    if (!lines.length) return "无";
    return lines.join("\n");
}

function formatNpcContext(npcBucket, limit = 16) {
    if (!npcBucket) return "无";
    const merged = [...npcBucket.events, ...npcBucket.messages]
        .sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0))
        .slice(-Math.max(1, Number(limit || 16)));
    if (!merged.length) return "无";
    return merged.map(formatEntry).join("\n");
}

export function getContextDigest(session, options = {}) {
    const hub = ensureSessionContext(session);
    const focusNpcId = asText(options.focusNpcId, "");
    const explicitRoomId = asText(options.focusRoomId, "");
    const roomId = explicitRoomId || asText(session?.round?.playerRoomId, "");
    const globalLimit = Math.max(8, Number(options.globalLimit || 28));
    const roomLimit = Math.max(6, Number(options.roomLimit || 18));
    const npcLimit = Math.max(6, Number(options.npcLimit || 18));

    const globalLines = hub.global.slice(-globalLimit).map(formatEntry);
    const roundNo = safeRoundNo(session);
    const roundBucket = hub.rounds[String(roundNo)] || { events: [], roomIds: [] };
    const roundLines = roundBucket.events.slice(-24).map(formatEntry);
    const focusRoom = roomId ? hub.rooms?.[roomId] : null;
    const focusNpc = focusNpcId ? hub.npcs?.[focusNpcId] : null;

    const roundRooms = (roundBucket.roomIds || [])
        .map((id) => hub.rooms?.[id])
        .filter(Boolean)
        .map((room) => {
            const names = (room.participants || []).map((p) => p.name || p.id).join(" / ");
            const msgCount = Array.isArray(room.messages) ? room.messages.length : 0;
            return `- ${room.title || room.id} [${room.side}] 参与者: ${names || "未知"} 消息:${msgCount}`;
        });

    return {
        globalContext: globalLines.length ? globalLines.join("\n") : "无",
        roundContext: roundLines.length ? roundLines.join("\n") : "无",
        roomContext: formatRoomContext(focusRoom, roomLimit),
        npcContext: formatNpcContext(focusNpc, npcLimit),
        roomsOverview: roundRooms.length ? roundRooms.join("\n") : "无"
    };
}

export function getContextSnapshot(session, options = {}) {
    const hub = ensureSessionContext(session);
    const roundNo = safeRoundNo(session);
    const globalLimit = Math.max(12, Number(options.globalLimit || 90));
    const roomLimit = Math.max(8, Number(options.roomLimit || 30));
    const npcLimit = Math.max(8, Number(options.npcLimit || 26));
    const digest = getContextDigest(session, {
        globalLimit: Math.min(globalLimit, 40),
        roomLimit: Math.min(roomLimit, 20),
        npcLimit: Math.min(npcLimit, 20)
    });
    const roundBucket = hub.rounds[String(roundNo)] || { events: [], roomIds: [] };
    const recentGlobal = hub.global.slice(-globalLimit).map(formatEntry);
    const rooms = (roundBucket.roomIds || [])
        .map((id) => hub.rooms?.[id])
        .filter(Boolean)
        .map((room) => ({
            id: room.id,
            side: room.side,
            title: room.title,
            round: room.round,
            participants: room.participants || [],
            recent: room.messages.slice(-roomLimit).map(formatEntry)
        }));
    const npcs = Object.values(hub.npcs || {}).map((npc) => ({
        id: npc.id,
        name: npc.name,
        side: npc.side,
        recent: [...(npc.events || []), ...(npc.messages || [])]
            .sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0))
            .slice(-npcLimit)
            .map(formatEntry)
    }));

    return {
        stats: getContextStats(session),
        digest,
        round: roundNo,
        recentGlobal,
        rooms,
        npcs
    };
}
