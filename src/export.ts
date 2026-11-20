import { buildIndex, type TreeIndex } from './tree';
import type { DbDump, Session, TreeNode } from './types';

function mergeById<T extends { id: string; updatedAt: number }>(a: T[], b: T[]): T[] {
  const out = new Map(a.map((x) => [x.id, x]));
  for (const x of b) {
    const mine = out.get(x.id);
    if (!mine || x.updatedAt > mine.updatedAt) out.set(x.id, x);
  }
  return [...out.values()];
}

/** Union of two copies of the database; for a record in both, the newer edit wins. */
export function mergeDumps(a: DbDump, b: DbDump): DbDump {
  return {
    version: 1,
    projects: mergeById(a.projects ?? [], b.projects ?? []),
    sessions: mergeById(a.sessions, b.sessions),
    nodes: mergeById(a.nodes, b.nodes),
    messages: mergeById(a.messages, b.messages),
  };
}

function nodeMarkdown(idx: TreeIndex, node: TreeNode, depth: number): string {
  const lines: string[] = [];
  if (depth > 0) {
    lines.push(`${'#'.repeat(Math.min(depth + 1, 6))} Branch: ${node.title}`, '');
    if (node.anchor) lines.push(`> Anchored to: “${node.anchor.quote.replace(/\s+/g, ' ')}”`, '');
  }
  for (const m of idx.messagesOf.get(node.id) ?? []) {
    const who = m.role === 'user' ? 'You' : `Assistant${m.model ? ` (${m.model.model})` : ''}`;
    lines.push(`**${who}:**`, '', m.content.trim(), '');
  }
  for (const child of idx.childrenOf.get(node.id) ?? []) lines.push(nodeMarkdown(idx, child, depth + 1));
  return lines.join('\n');
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'session';

/**
 * The files written to git: db.json is what the app reads back; the Markdown
 * files are a readable copy of each session, in a folder per project.
 */
export function exportFiles(dump: DbDump): Record<string, string> {
  const idx = buildIndex(dump.nodes, dump.messages);
  const files: Record<string, string> = { 'research-tree/db.json': JSON.stringify(dump, null, 1) };
  for (const s of dump.sessions as Session[]) {
    if (s.deleted) continue;
    const root = idx.byId.get(s.rootNodeId);
    if (!root) continue;
    const project = dump.projects?.find((p) => p.id === s.projectId && !p.deleted);
    const folder = project ? `${slug(project.name)}/` : '';
    files[`research-tree/sessions/${folder}${slug(s.title)}-${s.id.slice(0, 8)}.md`] =
      `# ${s.title}\n\n${nodeMarkdown(idx, root, 0)}`;
  }
  return files;
}
