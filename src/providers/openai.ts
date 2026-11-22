import { getSettings } from '../settings';
import { httpError, sseData, type ModelInfo, type Provider, type StreamRequest } from './types';

const NOT_CHAT = /embedding|audio|realtime|tts|transcribe|whisper|image|dall-e|moderation|search|instruct|codex|sora|computer-use/;

const auth = (key: string): Record<string, string> => (key ? { Authorization: `Bearer ${key}` } : {});

/** Lists models and streams a chat in the OpenAI format, which many other servers also speak. */
function client(base: () => string, keep: (id: string) => boolean) {
  return {
    async listModels(key: string): Promise<ModelInfo[]> {
      const res = await fetch(`${base()}/models`, { headers: auth(key) });
      if (!res.ok) throw await httpError(res);
      const body = (await res.json()) as { data?: { id: string; created?: number }[] };
      if (!Array.isArray(body.data)) throw new Error('The server did not return a list of models.');
      return body.data
        .filter((m) => keep(m.id))
        .sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
        .map((m) => ({ id: m.id }));
    },

    async stream({ key, model, system, turns, extra, signal, onText, onApproval, onStatus }: StreamRequest): Promise<void> {
      const res = await fetch(`${base()}/chat/completions`, {
        method: 'POST',
        signal,
        headers: { ...auth(key), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...extra,
          model: model.id,
          stream: true,
          // The paper comes first and unchanged in every conversation, which is what automatic prompt caching keys on.
          messages: [{ role: 'system', content: system }, ...turns.map((t) => ({ role: t.role, content: t.doc ? `${t.doc}\n\n${t.content}` : t.content }))],
        }),
      });
      if (!res.ok) throw await httpError(res);
      for await (const data of sseData(res)) {
        if (data === '[DONE]') break;
        const event = JSON.parse(data);
        if (event?.error) throw new Error(String(event.error.message ?? event.error));
        if (typeof event?.research_tree?.status === 'string') {
          onStatus?.(event.research_tree.status);
          continue;
        }
        const approval = event?.research_tree?.approval;
        if (approval?.id) {
          onApproval?.({
            id: String(approval.id),
            summary: String(approval.summary ?? ''),
            detail: String(approval.detail ?? ''),
            tool: typeof approval.tool === 'string' ? approval.tool : undefined,
            input: approval.input && typeof approval.input === 'object' ? approval.input : undefined,
            folder: typeof approval.folder === 'string' ? approval.folder : undefined,
          });
          continue;
        }
        const delta = event?.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta) onText(delta);
      }
    },
  };
}

export const openai: Provider = {
  id: 'openai',
  label: 'ChatGPT (OpenAI)',
  keyUrl: 'https://platform.openai.com/api-keys',
  keyHint: 'sk-…',
  ...client(() => 'https://api.openai.com/v1', (id) => /^(gpt-|o\d|chatgpt-)/.test(id) && !NOT_CHAT.test(id)),
};

/** The address as typed, without a trailing slash. */
export const cleanUrl = (url: string) => url.trim().replace(/\/+$/, '');

/**
 * A server the user points the app at: a model running on their own computer
 * (Ollama, LM Studio, llama.cpp) or any other service with OpenAI-format endpoints.
 */
/**
 * Some local servers can do more than answer: read a project folder, or change
 * files and run commands, and keep the app's records in a folder. Such a server
 * says what it offers; others do not answer this.
 */
export async function serverExtras(url: string, key: string): Promise<{ levels: string[]; folder: boolean }> {
  try {
    const res = await fetch(`${cleanUrl(url)}/research-tree`, { headers: auth(key) });
    const body = res.ok ? await res.json() : null;
    return { levels: Array.isArray(body?.levels) ? body.levels.filter((l: unknown) => typeof l === 'string') : [], folder: body?.folder === true };
  } catch {
    return { levels: [], folder: false };
  }
}

export const custom: Provider = {
  id: 'custom',
  label: 'Local or custom server',
  keyUrl: '',
  keyHint: 'only if the server asks for one',
  ...client(() => cleanUrl(getSettings().custom?.url ?? ''), () => true),
};
