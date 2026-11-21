import type { ChatTurn, ProviderId } from '../types';

export interface ModelInfo {
  id: string;
  /** Output-token cap reported by the provider, when it reports one. */
  maxOutput?: number;
}

export interface Approval {
  id: string;
  /** One line saying what would be done. */
  summary: string;
  /** The full request, for the user who wants to read it. */
  detail: string;
}

export interface StreamRequest {
  key: string;
  model: ModelInfo;
  system: string;
  turns: ChatTurn[];
  /** Extra fields for the request body, for servers that understand them. */
  extra?: Record<string, unknown>;
  /** A step the server wants the user's yes or no on before it goes ahead. */
  onApproval?: (approval: Approval) => void;
  signal: AbortSignal;
  onText: (delta: string) => void;
}

export interface Provider {
  id: ProviderId;
  label: string;
  /** Page where the user creates a key. */
  keyUrl: string;
  keyHint: string;
  /** Doubles as the key check: throws when the key is rejected. */
  listModels(key: string): Promise<ModelInfo[]>;
  stream(req: StreamRequest): Promise<void>;
}

export async function httpError(res: Response): Promise<Error> {
  let detail = '';
  try {
    const body = await res.json();
    detail = body?.error?.message ?? JSON.stringify(body);
  } catch {
    detail = res.statusText;
  }
  return new Error(`${res.status}: ${detail}`);
}

/** Yields the data payload of each server-sent event. */
export async function* sseData(res: Response): AsyncGenerator<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, '');
      buffer = buffer.slice(nl + 1);
      if (line.startsWith('data:')) yield line.slice(5).trim();
    }
  }
}
