import { describe, expect, it } from 'vitest';
import { mergeDumps, exportFiles } from './export';
import { buildContext, buildIndex, pathFrom, summarize } from './tree';
import type { DbDump, Message, TreeNode } from './types';
import { choosePath, resolveView } from './workspace';

const node = (id: string, parentId: string | null, anchorMsg?: string): TreeNode => ({
  id,
  parentId,
  title: id,
  anchor: anchorMsg ? { messageId: anchorMsg, start: 0, end: 5, quote: `quote-${id}` } : undefined,
  createdAt: 0,
  updatedAt: 0,
});
const msg = (id: string, nodeId: string, role: Message['role'], content: string, t: number): Message => ({
  id, nodeId, role, content, createdAt: t, updatedAt: t,
});

// root: q1 a1 q2 a2; branch b anchored to a1; branch c anchored to b's answer.
const nodes = [node('root', null), node('b', 'root', 'a1'), node('c', 'b', 'ba1')];
const messages = [
  msg('q1', 'root', 'user', 'first question', 1),
  msg('a1', 'root', 'assistant', 'first answer', 2),
  msg('q2', 'root', 'user', 'second question', 3),
  msg('a2', 'root', 'assistant', 'second answer', 4),
  msg('bq1', 'b', 'user', 'branch question', 5),
  msg('ba1', 'b', 'assistant', 'branch answer', 6),
  msg('cq1', 'c', 'user', 'deep question', 7),
];
const idx = buildIndex(nodes, messages);

describe('buildContext', () => {
  it('sends the whole thread for the root', () => {
    expect(buildContext(idx, 'root').map((t) => t.content)).toEqual([
      'first question', 'first answer', 'second question', 'second answer',
    ]);
  });

  it('cuts each ancestor at the anchored message and names the passage', () => {
    expect(buildContext(idx, 'c')).toEqual([
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: '[Side branch on the passage: "quote-b"]\n\nbranch question' },
      { role: 'assistant', content: 'branch answer' },
      { role: 'user', content: '[Side branch on the passage: "quote-c"]\n\ndeep question' },
    ]);
  });

  it('always alternates roles, starting with the user', () => {
    const turns = buildContext(idx, 'c');
    turns.forEach((t, i) => expect(t.role).toBe(i % 2 === 0 ? 'user' : 'assistant'));
  });
});

describe('pathFrom', () => {
  it('walks from the session root to the node', () => {
    expect(pathFrom(idx, 'root', 'c').map((n) => n.id)).toEqual(['root', 'b', 'c']);
  });
  it('stops at a re-rooted session root', () => {
    expect(pathFrom(idx, 'b', 'c').map((n) => n.id)).toEqual(['b', 'c']);
  });
  it('is empty for a node outside the session', () => {
    expect(pathFrom(idx, 'c', 'root')).toEqual([]);
  });
});

describe('hidden branches', () => {
  it('leave the tree but keep their data and context', () => {
    const hiddenIdx = buildIndex(nodes.map((n) => (n.id === 'b' ? { ...n, hidden: true } : n)), messages);
    expect(hiddenIdx.childrenOf.get('root')).toBeUndefined();
    expect(hiddenIdx.hiddenOf.get('root')!.map((n) => n.id)).toEqual(['b']);
    // A session rooted at the hidden branch still works, with full context.
    expect(pathFrom(hiddenIdx, 'b', 'c').map((n) => n.id)).toEqual(['b', 'c']);
    expect(buildContext(hiddenIdx, 'c')).toEqual(buildContext(idx, 'c'));
  });
});

describe('the chosen line', () => {
  const wide = buildIndex([...nodes, node('b2', 'root', 'a2')], messages);

  it('defaults to the first branch at each level and runs to a leaf', () => {
    const { trail, levels } = resolveView(wide, 'root');
    expect(trail.map((n) => n.id)).toEqual(['root', 'b', 'c']);
    expect(levels.map((l) => [l.parent.id, l.selected?.id, l.nodes.length])).toEqual([['root', 'b', 2], ['b', 'c', 1]]);
  });

  it('follows a chosen path and remembers choices under other branches', () => {
    let view = choosePath(resolveView(wide, 'root').view, ['root', 'b2']);
    expect(resolveView(wide, 'root', view).trail.map((n) => n.id)).toEqual(['root', 'b2']);
    view = choosePath(view, ['root', 'b']);
    expect(resolveView(wide, 'root', view).trail.map((n) => n.id)).toEqual(['root', 'b', 'c']);
  });

  it('skips pinned branches by default and ignores choices that no longer exist', () => {
    expect(resolveView(wide, 'root', { pinned: ['b'] }).trail.map((n) => n.id)).toEqual(['root', 'b2']);
    expect(resolveView(wide, 'root', { choice: { root: 'gone' } }).trail.map((n) => n.id)).toEqual(['root', 'b', 'c']);
  });
});

describe('summarize', () => {
  it('uses the first sentence of the last answer', () => {
    const m = [msg('1', 'n', 'user', 'why?', 1), msg('2', 'n', 'assistant', 'Because the variance grows with the dimension. More detail follows.', 2)];
    expect(summarize(m)).toBe('Because the variance grows with the dimension.');
  });
});

describe('sync files', () => {
  const dump = (m: Message[]): DbDump => ({
    version: 1,
    sessions: [{ id: 'sess-0001', title: 'My Session', rootNodeId: 'root', createdAt: 0, updatedAt: 0 }],
    nodes,
    messages: m,
  });

  it('keeps the newer copy of a record and the union of both sides', () => {
    const local = dump([msg('q1', 'root', 'user', 'old', 1)]);
    const remote = dump([msg('q1', 'root', 'user', 'new', 9), msg('x', 'root', 'user', 'only remote', 2)]);
    const merged = mergeDumps(local, remote);
    expect(merged.messages.find((m) => m.id === 'q1')!.content).toBe('new');
    expect(merged.messages).toHaveLength(2);
    expect(mergeDumps(remote, local).messages.find((m) => m.id === 'q1')!.content).toBe('new');
  });

  it('writes db.json and a nested Markdown file per session', () => {
    const files = exportFiles(dump(messages));
    expect(JSON.parse(files['research-tree/db.json']).messages).toHaveLength(messages.length);
    const md = files['research-tree/sessions/my-session-sess-000.md'];
    expect(md).toContain('# My Session');
    expect(md).toContain('## Branch: b');
    expect(md).toContain('### Branch: c');
    expect(md).toContain('> Anchored to: “quote-c”');
  });
});
