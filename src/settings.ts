import { useSyncExternalStore } from 'react';
import type { ModelInfo } from './providers';
import type { ModelRef, ProviderId } from './types';

export interface GithubConfig {
  repo: string; // "owner/name"
  branch: string;
  token: string;
}

export interface Settings {
  keys: Partial<Record<ProviderId, string>>;
  models: Partial<Record<ProviderId, ModelInfo[]>>;
  lastModel?: ModelRef;
  github?: GithubConfig;
}

// Keys and tokens live only in this browser's localStorage. They are never
// written to the database dump that gets pushed to git.
const STORAGE_KEY = 'rt.settings';
const listeners = new Set<() => void>();

function read(): Settings {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    return { keys: {}, models: {}, ...parsed };
  } catch {
    return { keys: {}, models: {} };
  }
}

let current = read();

export const getSettings = () => current;

export function updateSettings(patch: Partial<Settings>) {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    // Storage can be unavailable (private window); settings then last for the tab only.
  }
  listeners.forEach((l) => l());
}

export function useSettings(): Settings {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    getSettings,
  );
}

export function findModel(ref: ModelRef): ModelInfo {
  return current.models[ref.provider]?.find((m) => m.id === ref.model) ?? { id: ref.model };
}

export const DEMO_MODEL: ModelRef = { provider: 'demo', model: 'demo' };

/** The model a new message uses when the pane has no explicit choice. */
export function defaultModel(): ModelRef {
  const s = current;
  if (s.lastModel && (s.lastModel.provider === 'demo' || s.keys[s.lastModel.provider])) return s.lastModel;
  for (const p of ['anthropic', 'gemini', 'openai'] as ProviderId[]) {
    const first = s.keys[p] && s.models[p]?.[0];
    if (first) return { provider: p, model: first.id };
  }
  return DEMO_MODEL;
}
