import { httpError, sseData, type Provider } from './types';

const BASE = 'https://api.openai.com/v1';
const NOT_CHAT = /embedding|audio|realtime|tts|transcribe|whisper|image|dall-e|moderation|search|instruct|codex|sora|computer-use/;

export const openai: Provider = {
  id: 'openai',
  label: 'ChatGPT (OpenAI)',
  keyUrl: 'https://platform.openai.com/api-keys',
  keyHint: 'sk-…',

  async listModels(key) {
    const res = await fetch(`${BASE}/models`, { headers: { Authorization: `Bearer ${key}` } });
    if (!res.ok) throw await httpError(res);
    const body = (await res.json()) as { data: { id: string; created?: number }[] };
    return body.data
      .filter((m) => /^(gpt-|o\d|chatgpt-)/.test(m.id) && !NOT_CHAT.test(m.id))
      .sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
      .map((m) => ({ id: m.id }));
  },

  async stream({ key, model, system, turns, signal, onText }) {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      signal,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model.id,
        stream: true,
        messages: [{ role: 'system', content: system }, ...turns],
      }),
    });
    if (!res.ok) throw await httpError(res);
    for await (const data of sseData(res)) {
      if (data === '[DONE]') break;
      const delta = JSON.parse(data)?.choices?.[0]?.delta?.content;
      if (typeof delta === 'string' && delta) onText(delta);
    }
  },
};
