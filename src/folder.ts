// Storage in a folder on the user's computer, through a local server that
// offers one. Each session is a folder inside its project's folder, holding
// session.json (what the app reads back) and session.md (a readable copy).
// The browser's own database stays as the working copy.

import { dumpDb, loadDump, db } from './db';
import { mergeDumps, sessionMarkdown, slug } from './export';
import { cleanUrl, providers, serverExtras } from './providers';
import { getSettings, updateSettings } from './settings';
import { buildIndex } from './tree';
import type { DbDump, Highlight, Message, Session, TreeNode } from './types';

const INDEX = '.research-tree/index.json';

interface SessionFile {
  nodes: TreeNode[];
  messages: Message[];
  highlights: Highlight[];
}

/** Folder names keep their capitals and spaces; only what a file system refuses is replaced. */
const folderName = (name: string) => name.replace(/[^\p{L}\p{N} ._-]/gu, '-').replace(/^[ .]+|[ .]+$/g, '').slice(0, 80);

/** The folder a session's files live in. */
export function sessionFolder(session: Session, dump: DbDump): string {
  const project = dump.projects?.find((p) => p.id === session.projectId && !p.deleted);
  return `${(project && folderName(project.name)) || 'Inbox'}/${slug(session.title)}-${session.id.slice(0, 8)}`;
}

/** Splits the database into files: one pair per live session, and an index for everything else. */
export function folderFiles(dump: DbDump): Record<string, string> {
  const live = dump.sessions.filter((s) => !s.deleted);
  const rootOf = new Map(live.map((s) => [s.rootNodeId, s]));
  const byId = new Map(dump.nodes.map((n) => [n.id, n]));

  // A node belongs to the nearest session at or above it.
  const owner = new Map<string, Session | undefined>();
  const ownerOf = (id: string): Session | undefined => {
    if (owner.has(id)) return owner.get(id);
    owner.set(id, undefined); // guards against a loop in damaged data
    const node = byId.get(id);
    const found = rootOf.get(id) ?? (node?.parentId ? ownerOf(node.parentId) : undefined);
    owner.set(id, found);
    return found;
  };

  const parts = new Map<string, SessionFile>(live.map((s) => [s.id, { nodes: [], messages: [], highlights: [] }]));
  const rest: SessionFile = { nodes: [], messages: [], highlights: [] };
  const part = (nodeId: string) => parts.get(ownerOf(nodeId)?.id ?? '') ?? rest;
  for (const n of dump.nodes) part(n.id).nodes.push(n);
  for (const m of dump.messages) part(m.nodeId).messages.push(m);
  for (const h of dump.highlights ?? []) part(h.nodeId).highlights.push(h);

  // Records are sorted so that the same data always gives the same file, which keeps git diffs small.
  const sorted = (file: SessionFile): SessionFile => ({
    nodes: [...file.nodes].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)),
    messages: [...file.messages].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)),
    highlights: [...file.highlights].sort((a, b) => a.id.localeCompare(b.id)),
  });
  const byIdOrder = <T extends { id: string }>(list: T[]) => [...list].sort((a, b) => a.id.localeCompare(b.id));

  const idx = buildIndex(dump.nodes, dump.messages, dump.highlights);
  const files: Record<string, string> = {
    [INDEX]: JSON.stringify({ version: 1, projects: byIdOrder(dump.projects ?? []), sessions: byIdOrder(dump.sessions), rest: sorted(rest) }, null, 1),
  };
  for (const s of live) {
    const folder = sessionFolder(s, dump);
    files[`${folder}/session.json`] = JSON.stringify(sorted(parts.get(s.id)!), null, 1);
    const root = idx.byId.get(s.rootNodeId);
    if (root) files[`${folder}/session.md`] = sessionMarkdown(idx, s, root);
  }
  return files;
}

/** Puts the files back together. Returns null when the folder holds no records yet. */
export function dumpFromFiles(files: Record<string, string>): DbDump | null {
  if (!files[INDEX]) return null;
  const index = JSON.parse(files[INDEX]) as { projects?: DbDump['projects']; sessions?: Session[]; rest?: Partial<SessionFile> };
  const dump: DbDump = { version: 1, projects: index.projects ?? [], sessions: index.sessions ?? [], nodes: [], messages: [], highlights: [] };
  const add = (file: Partial<SessionFile>) => {
    dump.nodes.push(...(file.nodes ?? []));
    dump.messages.push(...(file.messages ?? []));
    dump.highlights!.push(...(file.highlights ?? []));
  };
  add(index.rest ?? {});
  for (const [path, content] of Object.entries(files)) if (path.endsWith('/session.json')) add(JSON.parse(content));
  return dump;
}

export interface GitState {
  changed: number;
  ahead: number;
  remote: boolean;
  workspace: string;
  done?: string[];
}

async function call<T>(path: string, body?: unknown): Promise<T> {
  const s = getSettings();
  const key = s.keys.custom;
  const res = await fetch(`${cleanUrl(s.custom?.url ?? '')}/research-tree/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error ?? `${res.status} from the local server`);
  return data as T;
}

/** Whether the connected local server offers a folder to keep records in. */
export const hasFolder = () => !!getSettings().custom?.folder;

let running: Promise<void> | null = null;

/**
 * Brings in what the folder holds (another computer's work, arriving through
 * git), then writes the merged result back. For a record in both, the newer edit wins.
 */
export function syncFolder(): Promise<void> {
  running ??= (async () => {
    try {
      await db.meta.put({ key: 'unsaved', value: false });
      const { files: found } = await call<{ files: Record<string, string> }>('files');
      const remote = dumpFromFiles(found);
      const local = await dumpDb();
      const merged = remote ? mergeDumps(local, remote) : local;
      if (remote) await loadDump(merged);
      const files = folderFiles(merged);
      // A session that was renamed, moved or deleted leaves its old files behind; they are removed.
      const remove = Object.keys(found)
        .flatMap((path) => (path.endsWith('/session.json') ? [path, path.replace(/json$/, 'md')] : []))
        .filter((path) => !(path in files));
      await call('files', { files, remove });
    } catch (e) {
      await db.meta.put({ key: 'unsaved', value: true });
      throw e;
    } finally {
      running = null;
    }
  })();
  return running;
}

let commandList: Promise<string[]> | null = null;

/** The slash commands the local server's tool accepts. Asked for once; an empty list when it cannot say. */
export function slashCommands(): Promise<string[]> {
  commandList ??= call<{ commands?: string[] }>('commands').then(
    (body) => (Array.isArray(body.commands) ? body.commands : []),
    () => {
      commandList = null;
      return [];
    },
  );
  return commandList;
}

/** Runs a shell command in a project's folder on the local server, passing on its output as it comes. */
export async function runCommand(folder: string, command: string, signal: AbortSignal, onOutput: (text: string) => void): Promise<void> {
  const s = getSettings();
  const key = s.keys.custom;
  const res = await fetch(`${cleanUrl(s.custom?.url ?? '')}/research-tree/run`, {
    method: 'POST',
    signal,
    headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), 'Content-Type': 'application/json' },
    body: JSON.stringify({ folder, command }),
  });
  if (!res.ok || !res.body) throw new Error((await res.json().catch(() => null))?.error ?? `${res.status} from the local server`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    onOutput(decoder.decode(value, { stream: true }));
  }
}

/**
 * When the app is served by a local server that pairs with it, connects to that
 * server without the user typing an address or key. Any other host answers this
 * with something else, and nothing happens.
 */
export async function pairWithHost(): Promise<{ url: string; key: string } | null> {
  try {
    const res = await fetch('/v1/research-tree/pair');
    const body = res.ok && res.headers.get('content-type')?.includes('json') ? await res.json() : null;
    return typeof body?.token === 'string' ? { url: `${location.origin}/v1`, key: body.token } : null;
  } catch {
    return null;
  }
}

let connecting: Promise<void> | null = null;

/** Sets up the server that serves the app as the custom server, unless one is set up already. */
export function connectToHost(): Promise<void> {
  connecting ??= (async () => {
    if (getSettings().custom?.url) return;
    const host = await pairWithHost();
    if (!host || getSettings().custom?.url) return;
    updateSettings({ keys: { ...getSettings().keys, custom: host.key }, custom: { url: host.url } });
    const [models, extras] = await Promise.all([providers.custom.listModels(host.key).catch(() => []), serverExtras(host.url, host.key)]);
    updateSettings({ custom: { url: host.url, ...extras }, models: { ...getSettings().models, custom: models } });
  })();
  return connecting;
}

/** Answers a step the server asked about. */
export const answerStep = (id: string, allow: boolean) => call<{ ok: boolean }>('approve', { id, allow });

export const gitState = () => call<GitState>('git');
export const gitSave = (message?: string) => call<GitState>('git', { message });
