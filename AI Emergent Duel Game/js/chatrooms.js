const statusEl = document.getElementById("status-text");
const metaGridEl = document.getElementById("meta-grid");
const roomsGridEl = document.getElementById("rooms-grid");
const refreshBtn = document.getElementById("refresh-btn");

const params = new URLSearchParams(window.location.search);
const sessionId = params.get("session") || localStorage.getItem("activeSessionId") || "";
const expectedRound = Number(params.get("round") || 0);

let pollTimer = null;

function isRoomFinished(roundState, roomId) {
    return Boolean(roundState?.roomFinished?.[String(roomId || "")]);
}

function setStatus(text, isError = false) {
    statusEl.textContent = String(text || "");
    statusEl.style.color = isError ? "#ffb2b6" : "#9ecfe2";
}

function formatTime(ts) {
    const n = Number(ts || 0);
    if (!n) return "--:--:--";
    return new Date(n).toLocaleTimeString("zh-CN", {
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
    });
}

function roundStatusText(status) {
    const map = {
        pending_invites: "等待邀请",
        active: "进行中",
        ended: "已结束，待推演",
        director_done: "推演完成"
    };
    return map[String(status || "")] || "未知";
}

function sideText(side) {
    if (side === "enemy") return "敌方频道";
    if (side === "ally") return "我方频道";
    return "系统频道";
}

function appendMeta(label, value) {
    const box = document.createElement("div");
    box.className = "meta-item";
    const l = document.createElement("div");
    l.className = "meta-label";
    l.textContent = label;
    const v = document.createElement("div");
    v.className = "meta-value";
    v.textContent = value;
    box.appendChild(l);
    box.appendChild(v);
    metaGridEl.appendChild(box);
}

function renderMeta(payload) {
    metaGridEl.innerHTML = "";
    const round = payload?.round || {};
    const maxPerSpeaker = Number(payload?.chatRoomRules?.maxMessagesPerSpeaker || 10);
    const rooms = Array.isArray(payload?.currentRoundPairRooms) ? payload.currentRoundPairRooms : [];
    appendMeta("会话ID", sessionId || "-");
    appendMeta("当前回合", String(round.number || "-"));
    appendMeta("回合状态", roundStatusText(round.status));
    appendMeta("聊天室数量", String(rooms.length));
    appendMeta("每人发言上限", `${maxPerSpeaker} 次`);
}

function createMessageNode(msg) {
    const side = msg?.side === "enemy" ? "enemy" : (msg?.side === "ally" ? "ally" : "system");
    const row = document.createElement("div");
    row.className = `msg ${side}`;

    const head = document.createElement("div");
    head.className = "msg-head";
    const speaker = document.createElement("div");
    speaker.className = "msg-speaker";
    speaker.textContent = String(msg?.speakerName || "未知");
    const time = document.createElement("div");
    time.className = "msg-time";
    time.textContent = formatTime(msg?.timestamp);
    head.appendChild(speaker);
    head.appendChild(time);

    const text = document.createElement("div");
    text.className = "msg-text";
    text.textContent = String(msg?.text || "");

    row.appendChild(head);
    row.appendChild(text);
    return row;
}

function renderRoomCard(room, maxPerSpeaker) {
    const side = room?.side === "enemy" ? "enemy" : (room?.side === "ally" ? "ally" : "system");
    const card = document.createElement("article");
    card.className = `room-card ${side}`;

    const head = document.createElement("div");
    head.className = "room-head";
    const title = document.createElement("div");
    title.className = "room-title";
    title.textContent = String(room?.title || room?.id || "聊天室");
    const badge = document.createElement("span");
    badge.className = "side-badge";
    badge.textContent = sideText(side);
    head.appendChild(title);
    head.appendChild(badge);

    const metas = document.createElement("div");
    metas.className = "room-metas";
    const participants = Array.isArray(room?.participants) ? room.participants : [];
    const counts = room?.speakerCounts || {};
    const usage = participants.map((p) => {
        const pid = String(p?.speakerId || p?.id || "");
        const used = Number(counts[pid] || 0);
        return `${p?.name || "未知"} ${used}/${maxPerSpeaker}`;
    }).join(" | ");
    const roomState = isRoomFinished(window.__roundStateCache, room?.id);
    const hasPlayer = (participants || []).some((p) => p?.id === "__player__");
    const stateText = roomState
        ? "已结束"
        : (hasPlayer
            ? (window.__roundStateCache?.playerChannelOpened ? "进行中" : "待玩家阶段")
            : "自动对话中");
    metas.textContent = `${room?.id || ""} | 状态: ${stateText} | 发言额度: ${usage || "暂无"}`;

    const feed = document.createElement("div");
    feed.className = "room-feed";
    const messages = Array.isArray(room?.messages) ? room.messages.slice(-60) : [];
    if (messages.length === 0) {
        const empty = document.createElement("div");
        empty.className = "empty-card";
        empty.textContent = "暂无消息，等待双方发言。";
        feed.appendChild(empty);
    } else {
        messages.forEach((msg) => feed.appendChild(createMessageNode(msg)));
        feed.scrollTop = feed.scrollHeight;
    }

    card.appendChild(head);
    card.appendChild(metas);
    card.appendChild(feed);
    return card;
}

function renderRooms(payload) {
    roomsGridEl.innerHTML = "";
    const round = payload?.round || {};
    window.__roundStateCache = round;
    const rooms = Array.isArray(payload?.currentRoundPairRooms) ? payload.currentRoundPairRooms : [];
    const maxPerSpeaker = Number(payload?.chatRoomRules?.maxMessagesPerSpeaker || 10);

    if (rooms.length === 0) {
        const empty = document.createElement("div");
        empty.className = "empty-card";
        empty.textContent =
            round.status === "active"
                ? "本回合聊天室尚在初始化，请稍后刷新。"
                : "当前回合未开启一对一聊天室。请先完成本轮邀请并进入 active 状态。";
        roomsGridEl.appendChild(empty);
        return;
    }

    rooms.forEach((room) => {
        roomsGridEl.appendChild(renderRoomCard(room, maxPerSpeaker));
    });
}

async function loadChatrooms() {
    if (!sessionId) {
        setStatus("缺少 session 参数，无法加载聊天室。", true);
        metaGridEl.innerHTML = "";
        roomsGridEl.innerHTML = "";
        return;
    }

    try {
        const res = await fetch(`/api/session/${encodeURIComponent(sessionId)}/chatrooms`);
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || `加载失败 (${res.status})`);

        renderMeta(data);
        renderRooms(data);

        const currentRound = Number(data?.round?.number || 0);
        const status = roundStatusText(data?.round?.status);
        const expectedLabel = expectedRound ? ` | 打开时回合: ${expectedRound}` : "";
        setStatus(`已同步：第 ${currentRound} 回合 (${status})${expectedLabel}`);
    } catch (e) {
        setStatus(`聊天室加载失败: ${e.message}`, true);
    }
}

if (refreshBtn) {
    refreshBtn.addEventListener("click", () => loadChatrooms());
}

loadChatrooms();
pollTimer = setInterval(loadChatrooms, 1500);
window.addEventListener("beforeunload", () => {
    if (pollTimer) clearInterval(pollTimer);
});
