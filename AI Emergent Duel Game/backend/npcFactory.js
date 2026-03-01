function sanitizeText(input, fallback) {
    const text = typeof input === "string" ? input.trim() : "";
    return text || fallback;
}

export function createInitialAyla(id) {
    return {
        id,
        name: "艾拉 (Ayla)",
        role: "敌对阵营的战术分析师",
        personality: "冷静、多疑、注重逻辑，但内心渴望真正的理解。",
        favorability: 0,
        mood: "警惕",
        intent: "观察",
        memory: [],
        avatarSeed: "Ayla"
    };
}

export function normalizeCharacterProfile(profile, side) {
    const fallbackName = side === "enemy" ? "未知敌方特工" : "友方支援特工";
    const fallbackRole = side === "enemy" ? "敌方作战单元" : "我方支援单元";
    const fallbackPersonality = side === "enemy" ? "谨慎、强硬、服从命令" : "冷静、专业、忠诚";

    return {
        name: sanitizeText(profile?.name, fallbackName),
        role: sanitizeText(profile?.role, fallbackRole),
        personality: sanitizeText(profile?.personality, fallbackPersonality),
        intro_dialogue: sanitizeText(
            profile?.intro_dialogue,
            side === "enemy" ? "收到信号，已进入战区。" : "总部支援已就位，等待指令。"
        ),
        seed: sanitizeText(profile?.seed, sanitizeText(profile?.name, fallbackName))
    };
}

export function createNpcFromProfile(id, profile, side) {
    const normalized = normalizeCharacterProfile(profile, side);
    const isEnemy = side === "enemy";

    return {
        id,
        name: normalized.name,
        role: normalized.role,
        personality: normalized.personality,
        favorability: isEnemy ? -20 : 50,
        mood: isEnemy ? "敌对" : "忠诚",
        intent: isEnemy ? "压制" : "协助",
        memory: [],
        avatarSeed: normalized.seed
    };
}
