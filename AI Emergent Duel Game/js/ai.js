export class AICore {
    constructor(config) {
        this.apiKey = config.apiKey;
        this.apiUrl = config.apiUrl;
        this.modelName = config.modelName;
    }

    updateConfig(config) {
        this.apiKey = config.apiKey;
        this.apiUrl = config.apiUrl;
        this.modelName = config.modelName;
    }

    async generateResponse(messages, temperature = 0.7, maxTokens) {
        const body = {
            model: this.modelName,
            messages: messages,
            temperature: temperature
        };
        if (maxTokens) body.max_tokens = maxTokens;

        const response = await fetch(`${this.apiUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`
            },
            body: JSON.stringify(body)
        });

        if (!response.ok) throw new Error('API Error');
        const data = await response.json();
        return data.choices[0].message.content;
    }

    async generateJSON(messages, temperature = 0.7) {
        const content = await this.generateResponse(messages, temperature);
        return this.parseJSON(content);
    }

    parseJSON(content) {
        let jsonStr = content;
        // Try to extract JSON from markdown code blocks
        const jsonMatch = content.match(/```json\s*([\s\S]*?)\s*```/) || content.match(/\{[\s\S]*\}/);
        if (jsonMatch) jsonStr = jsonMatch[1] || jsonMatch[0];

        try {
            return JSON.parse(jsonStr);
        } catch (e) {
            console.warn("JSON Parse Failed, attempting aggressive fix", e);
            // Basic fix for unquoted keys or trailing commas if needed (simplified here)
            // For now, re-throw or return null, but the main logic handles fallback
            throw e;
        }
    }
}
