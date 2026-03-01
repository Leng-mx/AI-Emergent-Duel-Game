export class DirectorAI {
    constructor(aiCore) {
        this.aiCore = aiCore;
        this.cooldown = 0;
    }

    async analyze(gameState) {
        if (this.cooldown > 0) {
            this.cooldown--;
            return null;
        }

        const { turnCount, playerProfile, battlefield, currentNpc, lastNpcResponse } = gameState;

        const prompt = `
你现在是战局导演 (Director AI)。请分析当前战局，判断是否需要引入新角色。

【当前战局】
- 回合数: ${turnCount}
- 我方阵容: 玩家 (${playerProfile.name}) + ${battlefield.allies.length} 名队友
- 敌方阵容: ${battlefield.enemies.length} 名敌人
- 当前对手: ${currentNpc ? `${currentNpc.name} (${currentNpc.role})` : '无'}
- 最近对话上下文: "${lastNpcResponse ? lastNpcResponse.substring(0, 100) : ''}..."

【决策逻辑】
1. 如果敌方处于劣势（例如被玩家压制），且场上敌人少于 2 人，有 40% 概率生成敌方援军。
2. 如果玩家处于劣势（例如被围攻），且场上无队友，有 40% 概率生成我方援军提案。
3. 其他情况保持现状。

请只返回 JSON 格式：
{
  "action": "none" | "spawn_enemy" | "propose_ally",
  "reason": "简短的决策理由",
  "character_profile": { ... } // 如果生成角色，请包含 name, role, personality, intro_dialogue, seed
}
`;

        try {
            const decision = await this.aiCore.generateJSON([{ role: "user", content: prompt }], 0.7);
            console.log("Director Decision:", decision);

            if (decision.action === 'spawn_enemy' || decision.action === 'propose_ally') {
                this.cooldown = 3; // Cooldown 3 turns
            }

            return decision;

        } catch (e) {
            console.error("Director AI Error:", e);
            return null;
        }
    }
}
