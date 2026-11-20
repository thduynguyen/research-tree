import Dexie, { type Table } from 'dexie';
import type { DbDump, Message, Project, Session, TreeNode } from './types';

class ResearchDb extends Dexie {
  sessions!: Table<Session, string>;
  nodes!: Table<TreeNode, string>;
  messages!: Table<Message, string>;
  meta!: Table<{ key: string; value: unknown }, string>;
  projects!: Table<Project, string>;

  constructor() {
    super('research-tree');
    this.version(1).stores({
      sessions: 'id',
      nodes: 'id, parentId',
      messages: 'id, nodeId',
      meta: 'key',
    });
    this.version(2).stores({ projects: 'id' });
  }
}

export const db = new ResearchDb();
export const uid = () => crypto.randomUUID();

/** Every local write goes through these helpers so the "unpushed" flag stays right. */
const markDirty = () => db.meta.put({ key: 'dirty', value: true });

export async function putSession(s: Session) {
  await db.sessions.put({ ...s, updatedAt: Date.now() });
  await markDirty();
}

export async function putProject(p: Project) {
  await db.projects.put({ ...p, updatedAt: Date.now() });
  await markDirty();
}

export async function putNode(n: TreeNode) {
  await db.nodes.put({ ...n, updatedAt: Date.now() });
  await markDirty();
}

export async function putMessage(m: Message) {
  await db.messages.put({ ...m, updatedAt: Date.now() });
  await markDirty();
}

export async function createSession(projectId?: string): Promise<Session> {
  const t = Date.now();
  const root: TreeNode = { id: uid(), parentId: null, title: 'New session', createdAt: t, updatedAt: t };
  const session: Session = { id: uid(), title: 'New session', rootNodeId: root.id, projectId, createdAt: t, updatedAt: t };
  await putNode(root);
  await putSession(session);
  return session;
}

export async function dumpDb(): Promise<DbDump> {
  const [projects, sessions, nodes, messages] = await Promise.all([
    db.projects.toArray(),
    db.sessions.toArray(),
    db.nodes.toArray(),
    db.messages.toArray(),
  ]);
  return { version: 1, projects, sessions, nodes, messages };
}

export async function loadDump(dump: DbDump) {
  await db.transaction('rw', db.projects, db.sessions, db.nodes, db.messages, async () => {
    await db.projects.bulkPut(dump.projects ?? []);
    await db.sessions.bulkPut(dump.sessions);
    await db.nodes.bulkPut(dump.nodes);
    await db.messages.bulkPut(dump.messages);
  });
}

export const setDirty = (value: boolean) => db.meta.put({ key: 'dirty', value });
