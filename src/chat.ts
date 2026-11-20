import { useSyncExternalStore } from 'react';
import { db, putMessage, putNode, putSession, uid } from './db';
import { providers } from './providers';
import { findModel, getSettings, updateSettings } from './settings';
import { SYSTEM_PROMPT, buildContext, buildIndex, shorten } from './tree';
import type { Message, ModelRef } from './types';

/** Replies being streamed right now, by message id. Kept out of the database until done. */
const live = new Map<string, { nodeId: string; text: string }>();
const aborters = new Map<string, AbortController>();
const listeners = new Set<() => void>();
let version = 0;
let scheduled = false;

function notify() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    version++;
    listeners.forEach((l) => l());
  });
}

export function useLive() {
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => version,
  );
  return live;
}

export const isBusy = (nodeId: string) => aborters.has(nodeId);
export const stop = (nodeId: string) => aborters.get(nodeId)?.abort();

export async function sendMessage(nodeId: string, text: string, model: ModelRef) {
  if (aborters.has(nodeId)) return;
  const node = await db.nodes.get(nodeId);
  if (!node) return;

  const t = Date.now();
  const hadMessages = (await db.messages.where('nodeId').equals(nodeId).count()) > 0;
  const userMsg: Message = { id: uid(), nodeId, role: 'user', content: text, createdAt: t, updatedAt: t };
  const reply: Message = { id: uid(), nodeId, role: 'assistant', content: '', model, createdAt: t + 1, updatedAt: t };
  await putMessage(userMsg);
  await putMessage(reply);
  await putNode({ ...node, model });
  updateSettings({ lastModel: model });

  // A root takes its name from the first question asked in it.
  if (!hadMessages && !node.parentId) {
    const title = shorten(text);
    await putNode({ ...node, model, title });
    const sessions = await db.sessions.filter((s) => s.rootNodeId === nodeId).toArray();
    for (const s of sessions) await putSession({ ...s, title });
  }

  const controller = new AbortController();
  aborters.set(nodeId, controller);
  const entry = { nodeId, text: '' };
  live.set(reply.id, entry);
  notify();

  let error: string | undefined;
  try {
    const [nodes, messages] = await Promise.all([db.nodes.toArray(), db.messages.toArray()]);
    const turns = buildContext(buildIndex(nodes, messages.filter((m) => m.id !== reply.id)), nodeId);
    const provider = providers[model.provider];
    const key = getSettings().keys[model.provider] ?? '';
    if (model.provider !== 'demo' && !key) throw new Error(`No ${provider.label} key. Add one in Settings.`);
    await provider.stream({
      key,
      model: findModel(model),
      system: SYSTEM_PROMPT,
      turns,
      signal: controller.signal,
      onText: (delta) => {
        entry.text += delta;
        notify();
      },
    });
  } catch (e) {
    if (!controller.signal.aborted) error = e instanceof Error ? e.message : String(e);
  } finally {
    await putMessage({ ...reply, content: entry.text, error });
    live.delete(reply.id);
    aborters.delete(nodeId);
    notify();
  }
}
