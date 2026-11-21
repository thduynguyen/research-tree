import { useSyncExternalStore } from 'react';
import { db, putMessage, putNode, putSession, uid } from './db';
import { answerStep, hasFolder, runCommand } from './folder';
import { providers, type Approval } from './providers';
import { findModel, getSettings, isReady, updateSettings } from './settings';
import { SYSTEM_PROMPT, buildContext, buildIndex, shorten } from './tree';
import type { Message, ModelRef } from './types';

/** Replies being streamed right now, by message id. Kept out of the database until done. */
interface LiveReply {
  nodeId: string;
  text: string;
  approval?: Approval;
  /** Steps the user has said need no more asking, for the rest of this reply. */
  allowAll?: boolean;
  allowFiles?: Set<string>;
}
const live = new Map<string, LiveReply>();
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

/** Announced on the window when files in the workspace may have changed. */
export const FILES_CHANGED = 'rt-files-changed';

/** What a reply from the shell is labelled with, in place of a model. */
const SHELL: ModelRef = { provider: 'custom', model: 'shell' };

/** The step waiting for a yes or no in this conversation, if any. */
export function pendingApproval(nodeId: string): Approval | undefined {
  for (const entry of live.values()) if (entry.nodeId === nodeId && entry.approval) return entry.approval;
  return undefined;
}

/** The file a step would change, if it is a change to a file. */
export const fileOf = (approval: Approval): string | undefined => {
  const path = approval.input?.file_path ?? approval.input?.notebook_path;
  return /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(approval.tool ?? '') && typeof path === 'string' ? path : undefined;
};

/**
 * Sends the user's answer and takes the question off the screen. With a scope, the same answer is
 * given without asking to the rest of this reply's changes to that file, or to all of its steps.
 */
export async function answerApproval(nodeId: string, allow: boolean, scope?: 'file' | 'all') {
  for (const entry of live.values()) {
    if (entry.nodeId !== nodeId || !entry.approval) continue;
    const { id } = entry.approval;
    const file = fileOf(entry.approval);
    if (allow && scope === 'all') entry.allowAll = true;
    if (allow && scope === 'file' && file) (entry.allowFiles ??= new Set()).add(file);
    entry.approval = undefined;
    notify();
    await answerStep(id, allow).catch(() => undefined);
  }
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
  // A "!command" is answered by the shell, not by a model, and is labelled so.
  const terminal = node.terminal !== undefined;
  const shell = terminal || (text.startsWith('!') && hasFolder());
  const reply: Message = { id: uid(), nodeId, role: 'assistant', content: '', model: shell ? SHELL : model, createdAt: t + 1, updatedAt: t };
  await putMessage(userMsg);
  await putMessage(reply);
  if (!shell) {
    await putNode({ ...node, model });
    updateSettings({ lastModel: model });
  }

  // A root takes its name from the first question asked in it.
  if (!hadMessages && !node.parentId && !terminal) {
    const title = shorten(text);
    await putNode({ ...node, model, title });
    const sessions = await db.sessions.filter((s) => s.rootNodeId === nodeId).toArray();
    for (const s of sessions) await putSession({ ...s, title });
  }

  const controller = new AbortController();
  aborters.set(nodeId, controller);
  const entry: LiveReply = { nodeId, text: '' };
  live.set(reply.id, entry);
  notify();

  let error: string | undefined;
  try {
    const [nodes, messages] = await Promise.all([db.nodes.toArray(), db.messages.toArray()]);
    const index = buildIndex(nodes, messages.filter((m) => m.id !== reply.id));
    // The text of any PDF above this node, from this device's copy of the file.
    const texts = new Map<string, string[]>();
    for (let cur = index.byId.get(nodeId); cur; cur = cur.parentId ? index.byId.get(cur.parentId) : undefined) {
      const print = cur.doc?.fingerprint ?? (cur.web?.url ? `web:${cur.web.url}` : undefined);
      const text = print ? (await db.files.get(print))?.text : undefined;
      if (print && text) texts.set(print, text);
    }
    const turns = buildContext(index, nodeId, (print) => texts.get(print), node.scope ?? 'paper');
    const provider = providers[model.provider];
    const key = getSettings().keys[model.provider] ?? '';
    if (!shell && !isReady(getSettings(), model.provider)) throw new Error(`${provider.label} is not set up. Add it in Settings.`);
    // The project's folder on the local server, for the levels that work in one and for shell commands.
    const folderOf = async () => {
      let root = node;
      for (let up = root.parentId ? index.byId.get(root.parentId) : undefined; up; up = up.parentId ? index.byId.get(up.parentId) : undefined) root = up;
      const session = (await db.sessions.filter((s) => s.rootNodeId === root.id && !s.deleted).first()) ?? undefined;
      const project = session?.projectId ? await db.projects.get(session.projectId) : undefined;
      return project?.name ?? 'Inbox';
    };
    // "!command" runs the command itself in the project's folder, with no model involved.
    if (shell) {
      if (!hasFolder()) throw new Error('A terminal needs the local helper. Start it, then connect it in Settings.');
      entry.text = '```\n';
      const ended = await runCommand(await folderOf(), terminal ? text : text.slice(1).trim(), controller.signal, (out) => {
        entry.text += out;
        notify();
      }, node.terminal);
      // A command that printed nothing says so, in place of an empty box.
      entry.text = entry.text.trim() === '```' ? '*(no output)*' : `${entry.text.replace(/\n?$/, '\n')}\`\`\``;
      // A terminal's next command starts where this one ended.
      if (terminal && ended.cwd) {
        const now = await db.nodes.get(nodeId);
        if (now && now.terminal !== ended.cwd) await putNode({ ...now, terminal: ended.cwd });
      }
      return;
    }
    // A local server that can work in a folder is told how far it may go, and in which project's folder.
    let extra: Record<string, unknown> | undefined;
    const levels = model.provider === 'custom' ? getSettings().custom?.levels ?? [] : [];
    if (node.access && node.access !== 'ask' && levels.includes(node.access)) {
      // A server that keeps one running session per conversation needs only the new message:
      // exactly as typed, with the passage ahead of a branch's first question.
      // Shell commands run since the model last answered here are not in its session yet: they go in with this message.
      const earlier = messages.filter((m) => m.nodeId === nodeId && m.id !== userMsg.id && m.id !== reply.id && !m.deleted).sort((a, b) => a.createdAt - b.createdAt);
      const ran: string[] = [];
      for (let i = earlier.length - 1; i > 0 && earlier[i].role === 'assistant' && earlier[i].model?.model === SHELL.model; i -= 2) {
        ran.unshift(`[I ran this shell command in the project folder: ${earlier[i - 1].content.slice(1).trim()}]\n${earlier[i].content}`);
      }
      const shellNotes = ran.length ? `${ran.join('\n\n')}\n\n` : '';
      const passage = !hadMessages && node.anchor && !text.startsWith('/') ? `[Side branch on the passage: "${node.anchor.quote}"]\n\n` : '';
      extra = {
        research_tree: { level: node.access, folder: await folderOf(), session: node.id, parent: node.parentId ?? undefined, message: text.startsWith('/') ? text : shellNotes + passage + text },
      };
    }
    await provider.stream({
      key,
      model: findModel(model),
      system: SYSTEM_PROMPT,
      turns,
      extra,
      signal: controller.signal,
      onApproval: (approval) => {
        // Already allowed for the rest of this reply: answered without asking again.
        const file = fileOf(approval);
        if (entry.allowAll || (file && entry.allowFiles?.has(file))) return void answerStep(approval.id, true).catch(() => undefined);
        entry.approval = approval;
        notify();
      },
      onText: (delta) => {
        entry.text += delta;
        notify();
      },
    });
  } catch (e) {
    if (!controller.signal.aborted) error = e instanceof Error ? e.message : String(e);
  } finally {
    // A command or a model working in the folder may have changed files that are open in a panel.
    if (shell || (node.access && node.access !== 'ask' && node.access !== 'read')) window.dispatchEvent(new Event(FILES_CHANGED));
    await putMessage({ ...reply, content: entry.text, error });
    live.delete(reply.id);
    aborters.delete(nodeId);
    notify();
  }
}
