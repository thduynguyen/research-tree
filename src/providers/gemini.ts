import { httpError, sseData, type Provider } from './types';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

interface GeminiModel {
  name: string;
  supportedGenerationMethods?: string[];
  outputTokenLimit?: number;
}

export const gemini: Provider = {
  id: 'gemini',
  label: 'Gemini',
  keyUrl: 'https://aistudio.google.com/apikey',
  keyHint: 'AIza…',

  async listModels(key) {
    const res = await fetch(`${BASE}/models?pageSize=1000`, { headers: { 'x-goog-api-key': key } });
    if (!res.ok) throw await httpError(res);
    const body = (await res.json()) as { models?: GeminiModel[] };
    return (body.models ?? [])
      .filter((m) => m.supportedGenerationMethods?.includes('generateContent') && /gemini/.test(m.name))
      .map((m) => ({ id: m.name.replace(/^models\//, ''), maxOutput: m.outputTokenLimit }))
      .sort((a, b) => b.id.localeCompare(a.id));
  },

  async stream({ key, model, system, turns, signal, onText }) {
    const res = await fetch(`${BASE}/models/${model.id}:streamGenerateContent?alt=sse`, {
      method: 'POST',
      signal,
      headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: turns.map((t) => ({
          role: t.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: t.content }],
        })),
      }),
    });
    if (!res.ok) throw await httpError(res);
    for await (const data of sseData(res)) {
      const parts = JSON.parse(data)?.candidates?.[0]?.content?.parts as { text?: string; thought?: boolean }[] | undefined;
      for (const p of parts ?? []) if (p.text && !p.thought) onText(p.text);
    }
  },
};
