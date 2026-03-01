export class LLMClient {
    constructor(config) {
        this.apiKey = config.apiKey;
        this.apiUrl = config.apiUrl;
        this.modelName = config.modelName;
    }

    async generateResponse(messages, temperature = 0.7, maxTokens) {
        if (!this.apiKey) {
            throw new Error("Missing API key");
        }
        if (typeof fetch !== "function") {
            throw new Error("This Node.js runtime does not support fetch");
        }

        const body = {
            model: this.modelName,
            messages,
            temperature
        };

        if (maxTokens) body.max_tokens = maxTokens;

        const response = await fetch(`${this.apiUrl}/chat/completions`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${this.apiKey}`
            },
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            let detail = "";
            try {
                detail = await response.text();
            } catch {
                detail = "";
            }
            throw new Error(`LLM API Error (${response.status}): ${detail || "request failed"}`);
        }

        const data = await response.json();
        const content = data?.choices?.[0]?.message?.content;
        if (!content) {
            throw new Error("LLM API Error: empty response");
        }

        return content;
    }

    async generateJSON(messages, temperature = 0.7, maxTokens) {
        const content = await this.generateResponse(messages, temperature, maxTokens);
        return this.parseJSON(content);
    }

    parseJSON(content) {
        let jsonStr = content;
        const jsonMatch =
            content.match(/```json\s*([\s\S]*?)\s*```/i) ||
            content.match(/```[\s\S]*?```/i) ||
            content.match(/\{[\s\S]*\}/);

        if (jsonMatch) {
            jsonStr = jsonMatch[1] || jsonMatch[0].replace(/```/g, "");
        }

        return JSON.parse(jsonStr.trim());
    }
}
