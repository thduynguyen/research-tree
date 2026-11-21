import Dexie, { type Table } from 'dexie';
import type { DbDump, DocRef, Highlight, Message, Project, Session, TreeNode } from './types';

/** A PDF kept on this device only: the bytes, and the text of each page for the model. */
export interface StoredFile {
  fingerprint: string;
  data: ArrayBuffer;
  text?: string[];
}

class ResearchDb extends Dexie {
  sessions!: Table<Session, string>;
  nodes!: Table<TreeNode, string>;
  messages!: Table<Message, string>;
  meta!: Table<{ key: string; value: unknown }, string>;
  projects!: Table<Project, string>;
  highlights!: Table<Highlight, string>;
  files!: Table<StoredFile, string>;

  constructor() {
    super('research-tree');
    this.version(1).stores({
      sessions: 'id',
      nodes: 'id, parentId',
      messages: 'id, nodeId',
      meta: 'key',
    });
    this.version(2).stores({ projects: 'id' });
    this.version(3).stores({ highlights: 'id, nodeId', files: 'fingerprint' });
  }
}

export const db = new ResearchDb();
export const uid = () => crypto.randomUUID();

/** Every local write goes through these helpers so the "unpushed" flag stays right. */
const markDirty = () => db.meta.put({ key: 'dirty', value: true });

export async function putSession(s: Session) {
  await db.sessions.put({ ...s, updatedAt: Date.now() });
  // Not awaited: the record is saved, and the caller should not wait on the "unpushed" flag.
  void markDirty();
}

export async function putProject(p: Project) {
  await db.projects.put({ ...p, updatedAt: Date.now() });
  // Not awaited: the record is saved, and the caller should not wait on the "unpushed" flag.
  void markDirty();
}

export async function putHighlight(h: Highlight) {
  await db.highlights.put({ ...h, updatedAt: Date.now() });
  // Not awaited: the record is saved, and the caller should not wait on the "unpushed" flag.
  void markDirty();
}

export async function putNode(n: TreeNode) {
  await db.nodes.put({ ...n, updatedAt: Date.now() });
  // Not awaited: the record is saved, and the caller should not wait on the "unpushed" flag.
  void markDirty();
}

export async function putMessage(m: Message) {
  await db.messages.put({ ...m, updatedAt: Date.now() });
  // Not awaited: the record is saved, and the caller should not wait on the "unpushed" flag.
  void markDirty();
}

/** A new session; with `doc` its root is a PDF to read, otherwise an empty chat. */
export async function createSession(projectId?: string, doc?: DocRef): Promise<Session> {
  const t = Date.now();
  const title = doc?.title ?? 'New session';
  const root: TreeNode = { id: uid(), parentId: null, title, doc, createdAt: t, updatedAt: t };
  const session: Session = { id: uid(), title, rootNodeId: root.id, projectId, createdAt: t, updatedAt: t };
  await putNode(root);
  await putSession(session);
  return session;
}

export async function dumpDb(): Promise<DbDump> {
  const [projects, highlights, sessions, nodes, messages] = await Promise.all([
    db.projects.toArray(),
    db.highlights.toArray(),
    db.sessions.toArray(),
    db.nodes.toArray(),
    db.messages.toArray(),
  ]);
  return { version: 1, projects, highlights, sessions, nodes, messages };
}

export async function loadDump(dump: DbDump) {
  await db.transaction('rw', [db.projects, db.highlights, db.sessions, db.nodes, db.messages], async () => {
    await db.projects.bulkPut(dump.projects ?? []);
    await db.highlights.bulkPut(dump.highlights ?? []);
    await db.sessions.bulkPut(dump.sessions);
    await db.nodes.bulkPut(dump.nodes);
    await db.messages.bulkPut(dump.messages);
  });
}

/**
 * Deletes branches for good: their text is emptied and the records marked
 * deleted, along with their messages, highlights and any session rooted at them.
 */
export async function removeBranches(nodeIds: string[]) {
  const t = Date.now();
  const gone = new Set(nodeIds);
  await db.transaction('rw', [db.nodes, db.messages, db.highlights, db.sessions, db.meta], async () => {
    await db.nodes.where('id').anyOf(nodeIds).modify((n) => {
      n.deleted = true;
      n.title = '';
      n.updatedAt = t;
      delete n.anchor;
      delete n.doc;
      if (n.note !== undefined) n.note = '';
    });
    await db.messages.where('nodeId').anyOf(nodeIds).modify((m) => {
      m.deleted = true;
      m.content = '';
      m.updatedAt = t;
      delete m.error;
    });
    await db.highlights.where('nodeId').anyOf(nodeIds).modify((h) => {
      h.deleted = true;
      h.quote = '';
      h.updatedAt = t;
    });
    await db.sessions.filter((s) => gone.has(s.rootNodeId)).modify((s) => {
      s.deleted = true;
      s.updatedAt = t;
    });
    await db.meta.put({ key: 'dirty', value: true });
  });
}

export const setDirty = (value: boolean) => db.meta.put({ key: 'dirty', value });
