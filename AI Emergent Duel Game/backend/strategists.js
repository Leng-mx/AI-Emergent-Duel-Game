import { getContextDigest } from "./context/contextManager.js";

function formatCamp(npcs, idList) {
    if (!idList?.length) return "无";
    return idList
        .map((id) => {
            const npc = npcs[id];
            if (!npc) return null;
            return `- [${npc.name}](${npc.role}) 性格:${npc.personality} 状态:${npc.mood}/${npc.intent} 好感:${npc.favorability}`;
        })
        .filter(Boolean)
        .join("\n");
}

function getNpcCampSide(session, npcId) {
    if (!session || !npcId) return "system";
    if (Array.isArray(session?.battlefield?.enemies) && session.battlefield.enemies.includes(npcId)) return "enemy";
    if (Array.isArray(session?.battlefield?.allies) && session.battlefield.allies.includes(npcId)) return "ally";
    return "system";
}

function resolveNpcRelation(session, speakerId, listenerId) {
    const speakerSide = getNpcCampSide(session, speakerId);
    const listenerSide = getNpcCampSide(session, listenerId);
    const hostile = speakerSide !== "system" && listenerSide !== "system" && speakerSide !== listenerSide;
    return {
        speakerSide,
        listenerSide,
        hostile
    };
}

function isHostileLineTooFriendly(text) {
    const source = String(text || "");
    const friendlyWords = [
        "合作",
        "联手",
        "同盟",
        "共赢",
        "同频",
        "并肩",
        "协同",
        "支援",
        "配合"
    ];
    return friendlyWords.some((word) => source.includes(word));
}

function buildAutoNpcFallbackReply(speaker, listener, relation) {
    if (!speaker || !listener) return "保持当前战术推进。";
    if (relation?.hostile) {
        if (relation.speakerSide === "enemy") {
            return `${listener.name}，你的试探无效；我方将持续施压并在下一节点切断你的行动窗口。`;
        }
        if (relation.speakerSide === "ally") {
            return `${listener.name}，你的误导已失效；我方会按反制预案推进并锁定你的下一步动作。`;
        }
        return `${listener.name}，我已锁定你的话术路径，接下来将直接执行反制。`;
    }
    return `${listener.name}，我已同步当前态势，按既定策略继续推进。`;
}

export async function generateEnemyTurn(session, llmClient, playerInput, connectedNpcId) {
    const enemies = formatCamp(session.npcs, session.battlefield.enemies);
    const allies = formatCamp(session.npcs, session.battlefield.allies);
    const focusNpcId = connectedNpcId && session.npcs[connectedNpcId]
        ? connectedNpcId
        : session.currentNpcId;
    const focusNpc = session.npcs[focusNpcId];
    const context = getContextDigest(session, {
        focusNpcId,
        focusRoomId: session?.round?.playerRoomId || "",
        globalLimit: 32,
        roomLimit: 24,
        npcLimit: 20
    });

    const prompt = `
你是敌方阵营总控 AI，控制敌方所有 NPC。
目标：在“全局上下文”下生成一次敌方回应。

【玩家资料】
- 代号: ${session.playerProfile.name}
- 职业: ${session.playerProfile.role}
- 性格: ${session.playerProfile.personality}

【敌方阵营】
${enemies}

【玩家阵营】
- 玩家本人: ${session.playerProfile.name}
- 我方支援:
${allies}

【当前战局】
- 回合数: ${session.turnCount}
- 玩家当前连接目标NPC: ${focusNpc ? `${focusNpc.name} (${focusNpc.id})` : "无"}
- 当前回合上下文:
${context.roundContext}
- 全局上下文:
${context.globalContext}
- 当前回合房间总览:
${context.roomsOverview}
- 当前玩家房间对话上下文:
${context.roomContext}
- 当前目标NPC私有上下文:
${context.npcContext}

【玩家输入】
${playerInput}

请输出 JSON，不要带 markdown：
{
  "reply": "敌方主回应文本（不要重复说话人前缀）",
  "action": "可选，动作描述",
  "internal_thought": "可选，敌方战术思考",
  "active_npc_id": "本次主要发言NPC ID，必须是敌方阵营中存在的ID",
  "state_update": {
    "favorability_change": 0,
    "mood": "可选",
    "intent": "可选"
  }
}
`;

    try {
        const parsed = await llmClient.generateJSON([{ role: "user", content: prompt }], 0.7);
        return parsed;
    } catch {
        const fallbackId = focusNpc?.id || session.currentNpcId;
        const fallbackNpc = session.npcs[fallbackId];
        return {
            reply: "收到你的消息。我在评估你的真实意图。",
            action: `${fallbackNpc?.name || "敌方单位"}短暂沉默，重新校准了战术频道。`,
            internal_thought: "模型异常，使用降级回复维持战局连续性。",
            active_npc_id: fallbackId,
            state_update: {
                favorability_change: 0
            }
        };
    }
}

export async function analyzeEnemyReinforcement(session, llmClient) {
    if (session.battlefield.enemies.length >= 5) {
        return { action: "none", reason: "enemy cap reached" };
    }

    const context = getContextDigest(session, {
        globalLimit: 30,
        roomLimit: 16,
        npcLimit: 14
    });

    const prompt = `
你是敌方战略分析AI，请基于全局上下文判断是否需要敌方增援。
只返回JSON：
{
  "action": "none" | "spawn_enemy",
  "reason": "简短理由",
  "character_profile": {
    "name": "...",
    "role": "...",
    "personality": "...",
    "intro_dialogue": "...",
    "seed": "..."
  }
}

全局信息：
- 回合数: ${session.turnCount}
- 敌方人数: ${session.battlefield.enemies.length}
- 我方支援人数: ${session.battlefield.allies.length}
- 当前回合上下文:
${context.roundContext}
- 全局上下文:
${context.globalContext}
- 当前回合房间总览:
${context.roomsOverview}
`;

    try {
        const parsed = await llmClient.generateJSON([{ role: "user", content: prompt }], 0.6);
        if (parsed?.action === "spawn_enemy" && parsed?.character_profile) return parsed;
        return { action: "none", reason: "no valid spawn decision" };
    } catch {
        return { action: "none", reason: "enemy strategist unavailable" };
    }
}

export async function analyzeAllySupport(session, llmClient) {
    if (session.pendingAllyProposal || session.battlefield.allies.length >= 4) {
        return { action: "none", reason: "ally channel busy or cap reached" };
    }

    const context = getContextDigest(session, {
        globalLimit: 30,
        roomLimit: 16,
        npcLimit: 14
    });

    const prompt = `
你是玩家阵营的战略分析AI，请基于全局上下文判断是否建议接入我方NPC支援。
注意：你只能提出建议，不能直接加入，玩家需确认。

只返回JSON：
{
  "action": "none" | "propose_ally",
  "reason": "简短理由",
  "character_profile": {
    "name": "...",
    "role": "...",
    "personality": "...",
    "intro_dialogue": "...",
    "seed": "..."
  }
}

全局信息：
- 回合数: ${session.turnCount}
- 敌方人数: ${session.battlefield.enemies.length}
- 我方支援人数: ${session.battlefield.allies.length}
- 当前回合上下文:
${context.roundContext}
- 全局上下文:
${context.globalContext}
- 当前回合房间总览:
${context.roomsOverview}
`;

    try {
        const parsed = await llmClient.generateJSON([{ role: "user", content: prompt }], 0.6);
        if (parsed?.action === "propose_ally" && parsed?.character_profile) return parsed;
        return { action: "none", reason: "no valid ally proposal" };
    } catch {
        if (session.turnCount >= 3 && session.battlefield.enemies.length > session.battlefield.allies.length + 1) {
            return {
                action: "propose_ally",
                reason: "fallback proposal due battlefield disadvantage",
                character_profile: {
                    name: "林鸦",
                    role: "电子战与掩护专家",
                    personality: "冷静、守纪、执行力强",
                    intro_dialogue: "已接入我方频道，我将负责干扰与侧翼保护。",
                    seed: "linya"
                }
            };
        }
        return { action: "none", reason: "ally strategist unavailable" };
    }
}

export async function generateNpcAutoTurn(session, llmClient, payload = {}) {
    const roomId = String(payload.roomId || "");
    const speakerId = String(payload.speakerId || "");
    const listenerId = String(payload.listenerId || "");
    const side = String(payload.side || "system");
    const roomTitle = String(payload.roomTitle || roomId || "聊天室");
    const recentMessages = Array.isArray(payload.recentMessages) ? payload.recentMessages : [];
    const recentContext = recentMessages.length ? recentMessages.join("\n") : "无";

    const speaker = session?.npcs?.[speakerId];
    const listener = session?.npcs?.[listenerId];
    const relation = resolveNpcRelation(session, speakerId, listenerId);
    if (!speaker || !listener) {
        return {
            reply: "保持当前战术推进。",
            state_update: { favorability_change: 0 }
        };
    }

    const effectiveSide = relation.speakerSide === "system" ? side : relation.speakerSide;
    const objective = relation.hostile
        ? (effectiveSide === "enemy"
            ? "对敌方施压、诱导其暴露情报并压缩其行动窗口"
            : "反制敌方误导、保护我方链路并削弱其渗透节奏")
        : (effectiveSide === "enemy"
            ? "压制玩家阵营节奏并扩大敌方信息优势"
            : (effectiveSide === "ally"
                ? "巩固我方协同并保障玩家行动链路"
                : "争夺中立信息优势并保持可持续联络"));

    const context = getContextDigest(session, {
        focusNpcId: speakerId,
        focusRoomId: roomId,
        globalLimit: 26,
        roomLimit: 20,
        npcLimit: 18
    });

    const prompt = `
你正在扮演战局中的 NPC，并在双人聊天室中发言。
请你只输出 JSON，不要输出 markdown。

【当前发言者】
- id: ${speaker.id}
- 名称: ${speaker.name}
- 职业: ${speaker.role}
- 性格: ${speaker.personality}
- 情绪/意图: ${speaker.mood}/${speaker.intent}

【对方角色】
- id: ${listener.id}
- 名称: ${listener.name}
- 职业: ${listener.role}

【阵营关系】
- 发言者阵营: ${relation.speakerSide}
- 对方阵营: ${relation.listenerSide}
- 关系: ${relation.hostile ? "敌对" : "非敌对"}

【房间信息】
- 房间: ${roomTitle} (${roomId})
- 阵营侧: ${effectiveSide}
- 本轮目标: ${objective}

【上下文】
- 当前回合:
${context.roundContext}
- 当前房间:
${context.roomContext}
- 发言者私有上下文:
${context.npcContext}
- 全局上下文:
${context.globalContext}

约束:
1) 发言必须是 ${speaker.name} 对 ${listener.name} 的一句话，不要带说话人前缀。
2) 发言简洁自然，建议 18-60 字。
3) 必须包含可执行推进信息（状态更新/行动安排/下一步），禁止空洞哲学辩论。
4) 禁止复读或近似复述最近发言；禁止连续使用反问句。
5) 禁止输出以下元逻辑循环词或同类表达：递归、终结、证明、无意义、静默、载体、归零、湮灭、循环、"那么...是否..."。
6) 若最近消息出现逻辑循环，你必须立即转为战术收束语句，例如同步节点、分配任务、确认下一步。
7) 若关系为敌对，语气必须保持施压/试探/反制，不得出现握手言和。
8) 若关系为敌对，禁止使用“合作、联手、同盟、共赢、同频、并肩、协同、支援、配合”等友好词。

【最近消息（避免复读）】
${recentContext}

返回 JSON:
{
  "reply": "本次发言文本",
  "state_update": {
    "favorability_change": 0,
    "mood": "可选",
    "intent": "可选"
  }
}
`;

    try {
        const parsed = await llmClient.generateJSON([{ role: "user", content: prompt }], 0.35);
        let reply = String(parsed?.reply || "").trim();
        if (!reply) throw new Error("empty auto npc reply");
        if (relation.hostile && isHostileLineTooFriendly(reply)) {
            reply = buildAutoNpcFallbackReply(speaker, listener, relation);
        }
        return {
            reply,
            state_update: {
                favorability_change: Number(parsed?.state_update?.favorability_change || 0),
                mood: parsed?.state_update?.mood ? String(parsed.state_update.mood) : undefined,
                intent: parsed?.state_update?.intent ? String(parsed.state_update.intent) : undefined
            }
        };
    } catch {
        return {
            reply: buildAutoNpcFallbackReply(speaker, listener, relation),
            state_update: { favorability_change: 0 }
        };
    }
}
