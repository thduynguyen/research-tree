import { describe, expect, it } from 'vitest';
import { mergeDumps, exportFiles } from './export';
import { findAll, locate, paperLabel, pdfUrlOf, whenAndWhere } from './text';
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

  it('shows the root\'s branches and keeps every subtree closed by default', () => {
    const { trail, levels } = resolveView(wide, 'root');
    expect(trail.map((n) => n.id)).toEqual(['root', 'b']);
    expect(levels.map((l) => [l.parent.id, l.selected?.id, l.nodes.length])).toEqual([['root', 'b', 2]]);
  });

  it('goes on into a branch only once it has been opened up', () => {
    const { trail, levels } = resolveView(wide, 'root', { expanded: ['b'] });
    expect(trail.map((n) => n.id)).toEqual(['root', 'b', 'c']);
    expect(levels.map((l) => l.parent.id)).toEqual(['root', 'b']);
  });

  it('selecting a branch does not open it, but going to a deeper one opens the way to it', () => {
    const start = resolveView(wide, 'root').view;
    const picked = choosePath(start, ['root', 'b']);
    expect(picked.expanded).toEqual([]);
    const deep = choosePath(start, ['root', 'b', 'c']);
    expect(deep.expanded).toEqual(['b']);
    expect(resolveView(wide, 'root', deep).trail.map((n) => n.id)).toEqual(['root', 'b', 'c']);
  });

  it('remembers choices under other branches', () => {
    let view = choosePath(resolveView(wide, 'root', { expanded: ['b'] }).view, ['root', 'b2']);
    expect(resolveView(wide, 'root', view).trail.map((n) => n.id)).toEqual(['root', 'b2']);
    view = choosePath(view, ['root', 'b']);
    expect(resolveView(wide, 'root', view).trail.map((n) => n.id)).toEqual(['root', 'b', 'c']);
  });

  it('stops at a minimized conversation, so its branches get no column', () => {
    const { trail, levels } = resolveView(wide, 'root', { expanded: ['b'], minimized: ['b'] });
    expect(trail.map((n) => n.id)).toEqual(['root', 'b']);
    expect(levels.map((l) => l.parent.id)).toEqual(['root']);
  });

  it('skips pinned branches by default and ignores choices that no longer exist', () => {
    expect(resolveView(wide, 'root', { pinned: ['b'] }).trail.map((n) => n.id)).toEqual(['root', 'b2']);
    expect(resolveView(wide, 'root', { choice: { root: 'gone' } }).trail.map((n) => n.id)).toEqual(['root', 'b']);
  });
});

describe('PDF nodes', () => {
  const paper: TreeNode = { ...node('paper', null), doc: { fingerprint: 'f1', title: 'A Paper', pages: 2 } };
  const ask: TreeNode = { ...node('ask', 'paper'), anchor: { messageId: 'pdf2', start: 0, end: 5, quote: 'the claim' } };
  const pdfIdx = buildIndex([paper, ask], [msg('m1', 'ask', 'user', 'is this right?', 1)]);

  const three = (print: string) => (print === 'f1' ? ['first page', 'second page', 'third page'] : undefined);

  it('put the whole paper first and apart, identical for every conversation under it', () => {
    const other: TreeNode = { ...node('ask2', 'paper'), anchor: { messageId: 'pdf3', start: 0, end: 5, quote: 'another claim' } };
    const both = buildIndex([paper, ask, other], [msg('m1', 'ask', 'user', 'is this right?', 1), msg('m2', 'ask2', 'user', 'and this?', 2)]);
    const a = buildContext(both, 'ask', three);
    const b = buildContext(both, 'ask2', three);
    expect(a).toHaveLength(1);
    expect(a[0].doc).toContain('[Document: "A Paper"]');
    expect(a[0].doc).toContain('--- Page 3 ---\nthird page');
    // The shared part is byte for byte the same, which is what lets a prompt cache serve it.
    expect(b[0].doc).toBe(a[0].doc);
    expect(a[0].content).toBe('[Side branch on the passage on page 2: "the claim"]\n\nis this right?');
    expect(b[0].content).toBe('[Side branch on the passage on page 3: "another claim"]\n\nand this?');
  });

  it('send only the passage\'s page and the first page when asked to', () => {
    const turns = buildContext(pdfIdx, 'ask', three, 'page');
    expect(turns[0].doc).toBeUndefined();
    expect(turns[0].content).toContain('Only pages 1 and 2 are included below');
    expect(turns[0].content).toContain('--- Page 2 ---\nsecond page');
    expect(turns[0].content).not.toContain('third page');
    expect(turns[0].content.endsWith('is this right?')).toBe(true);
  });

  it('send only the passage when asked to', () => {
    const text = buildContext(pdfIdx, 'ask', three, 'none')[0].content;
    expect(text).not.toContain('first page');
    expect(text).toContain('Its text is not included');
    expect(text).toContain('"the claim"');
  });

  it('say so when the text is not on this device', () => {
    expect(buildContext(pdfIdx, 'ask')[0].content).toContain('not available on this device');
  });
});

describe('locate', () => {
  // As in a PDF text layer: no space where the line broke between "dot" and "products".
  const page = 'We suspect the dotproducts grow large in magnitude.';

  it('trusts stored offsets when the text still matches, ignoring whitespace', () => {
    expect(locate(page, 15, 26, 'dot products')).toEqual([15, 26]);
  });
  it('finds the quote again when the offsets are stale', () => {
    expect(locate(page, 0, 5, 'dot products grow')).toEqual([15, 31]);
  });
  it('gives up when the quote is not on the page', () => {
    expect(locate(page, 0, 5, 'not here')).toBeNull();
  });
});

describe('findAll', () => {
  // No space where the line broke between "attention" and "mechanism".
  const page = 'An attentionmechanism relates positions. Self-Attention is an Attention mechanism.';

  it('finds every occurrence, whatever the case', () => {
    const hits = findAll(page, 'attention');
    expect(hits).toHaveLength(3);
    expect(hits.map(([s, e]) => page.slice(s, e))).toEqual(['attention', 'Attention', 'Attention']);
  });
  it('matches across a line break that left no space, and across spaces in the query', () => {
    expect(findAll(page, 'attention mechanism').map(([s, e]) => page.slice(s, e))).toEqual(['attentionmechanism', 'Attention mechanism']);
  });
  it('returns nothing for an empty or absent query', () => {
    expect(findAll(page, '   ')).toEqual([]);
    expect(findAll(page, 'transformer')).toEqual([]);
  });
});

describe('pdfUrlOf', () => {
  it('maps arXiv pages to their PDF and keeps direct PDF links', () => {
    expect(pdfUrlOf('https://arxiv.org/abs/1706.03762')).toBe('https://arxiv.org/pdf/1706.03762');
    expect(pdfUrlOf('https://arxiv.org/pdf/1706.03762v7.pdf')).toBe('https://arxiv.org/pdf/1706.03762v7');
    expect(pdfUrlOf('https://example.org/papers/x.PDF')).toBe('https://example.org/papers/x.PDF');
  });
  it('leaves other links alone', () => {
    expect(pdfUrlOf('https://example.org/blog/post')).toBeNull();
    expect(pdfUrlOf('not a url')).toBeNull();
  });
});

describe('paper labels', () => {
  it('reads the venue and year printed on the first page', () => {
    expect(whenAndWhere('31st Conference on Neural Information Processing Systems (NIPS 2017), Long Beach')).toEqual({ venue: 'neurips', year: '17' });
    expect(whenAndWhere('Published as a conference paper at ICLR 2015')).toEqual({ venue: 'iclr', year: '15' });
  });
  it('falls back to the year in an arXiv identifier', () => {
    expect(whenAndWhere('arXiv:1503.02531v1 [stat.ML] 9 Mar 2015')).toEqual({ venue: 'arxiv', year: '15' });
    expect(whenAndWhere('no clues here', 'https://arxiv.org/pdf/2106.09685')).toEqual({ venue: 'arxiv', year: '21' });
    expect(whenAndWhere('no clues here')).toEqual({});
  });
  it('builds LastNameYYvenue - Title from whatever is known', () => {
    expect(paperLabel({ title: 'Attention Is All You Need', author: 'Ashish Vaswani', year: '17', venue: 'neurips' }, 'x')).toBe('Vaswani17neurips - Attention Is All You Need');
    expect(paperLabel({ title: 'A Paper', author: 'Ada Lovelace' }, 'x')).toBe('Lovelace - A Paper');
    expect(paperLabel({ title: 'A Paper' }, 'x')).toBe('A Paper');
    expect(paperLabel({}, 'file-name')).toBe('file-name');
  });
});

describe('notes', () => {
  it('are passed to the model as the user\'s own words on the passage', () => {
    const noteNode: TreeNode = { ...node('n', 'root', 'a1'), note: 'I think this is $O(n^2)$.' };
    const ask = node('q', 'n');
    ask.anchor = { messageId: 'note', start: 0, end: 5, quote: 'I think' };
    const withNote = buildIndex([...nodes, noteNode, ask], [...messages, msg('nq', 'q', 'user', 'am I right?', 9)]);
    const text = buildContext(withNote, 'q').map((t) => t.content).join('\n');
    expect(text).toContain("[The user's own note on that passage: I think this is $O(n^2)$.]");
    expect(text).toContain('[Side branch on the passage: "I think"]');
  });
});

describe('order of branches', () => {
  it('follows the text: by page in a PDF, then by position, whatever the order of creation', () => {
    const paper: TreeNode = { ...node('paper', null), doc: { fingerprint: 'f', title: 'P', pages: 3 } };
    const at = (id: string, page: number, start: number, createdAt: number): TreeNode => ({
      ...node(id, 'paper'), createdAt, anchor: { messageId: `pdf${page}`, start, end: start + 3, quote: 'x' },
    });
    const made = buildIndex([paper, at('p2', 2, 10, 1), at('p1late', 1, 400, 2), at('p1early', 1, 20, 3), { ...node('loose', 'paper'), createdAt: 0 }], []);
    expect(made.childrenOf.get('paper')!.map((n) => n.id)).toEqual(['p1early', 'p1late', 'p2', 'loose']);
  });

  it('follows the messages in a chat', () => {
    const late = { ...node('onA2', 'root', 'a2'), createdAt: 1 };
    const early = { ...node('onA1', 'root', 'a1'), createdAt: 2 };
    expect(buildIndex([...nodes.filter((n) => n.id === 'root'), late, early], messages).childrenOf.get('root')!.map((n) => n.id)).toEqual(['onA1', 'onA2']);
  });
});

describe('deleted branches', () => {
  it('and their messages are left out entirely', () => {
    const gone = buildIndex(
      nodes.map((n) => (n.id === 'b' || n.id === 'c' ? { ...n, deleted: true } : n)),
      messages.map((m) => (m.nodeId === 'b' || m.nodeId === 'c' ? { ...m, deleted: true, content: '' } : m)),
    );
    expect(gone.byId.has('b')).toBe(false);
    expect(gone.childrenOf.get('root')).toBeUndefined();
    expect(gone.hiddenOf.get('root')).toBeUndefined();
    expect(gone.messagesOf.has('b')).toBe(false);
    expect(buildContext(gone, 'root')).toHaveLength(4);
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

import { dumpFromFiles, folderFiles } from './folder';

describe('folder storage', () => {
  const at = (n: number) => ({ createdAt: n, updatedAt: n });
  const dump: DbDump = {
    version: 1,
    projects: [{ id: 'p1', name: 'Vision: papers', ...at(1) }],
    sessions: [
      { id: 'sess-aaaa-1', title: 'Attention Is All You Need', rootNodeId: 'n1', projectId: 'p1', ...at(1) },
      { id: 'sess-bbbb-2', title: 'Loose ideas', rootNodeId: 'n3', ...at(2) },
      { id: 'sess-cccc-3', title: 'Gone', rootNodeId: 'n4', deleted: true, ...at(3) },
    ] as DbDump['sessions'],
    nodes: [
      { id: 'n1', parentId: null, title: 'root', ...at(1) },
      { id: 'n2', parentId: 'n1', title: 'branch', ...at(2) },
      { id: 'n3', parentId: null, title: 'ideas', ...at(3) },
      { id: 'n4', parentId: null, title: 'gone', deleted: true, ...at(4) },
    ] as DbDump['nodes'],
    messages: [
      { id: 'm1', nodeId: 'n2', role: 'user', content: 'why?', ...at(5) },
      { id: 'm2', nodeId: 'n4', role: 'user', content: '', deleted: true, ...at(6) },
    ] as DbDump['messages'],
    highlights: [],
  };

  it('writes one folder per session inside its project, and Inbox without one', () => {
    const paths = Object.keys(folderFiles(dump)).sort();
    expect(paths).toEqual([
      '.research-tree/index.json',
      'Inbox/loose-ideas-sess-bbb/session.json',
      'Inbox/loose-ideas-sess-bbb/session.md',
      'Vision- papers/attention-is-all-you-need-sess-aaa/session.json',
      'Vision- papers/attention-is-all-you-need-sess-aaa/session.md',
    ]);
  });

  it('puts a branch in its session and keeps deleted records in the index', () => {
    const files = folderFiles(dump);
    const session = JSON.parse(files['Vision- papers/attention-is-all-you-need-sess-aaa/session.json']);
    expect(session.nodes.map((n: { id: string }) => n.id)).toEqual(['n1', 'n2']);
    expect(session.messages.map((m: { id: string }) => m.id)).toEqual(['m1']);
    const index = JSON.parse(files['.research-tree/index.json']);
    expect(index.rest.nodes.map((n: { id: string }) => n.id)).toEqual(['n4']);
    expect(index.sessions).toHaveLength(3);
  });

  it('reads back exactly what it wrote', () => {
    const back = dumpFromFiles(folderFiles(dump))!;
    const ids = (list: { id: string }[]) => list.map((x) => x.id).sort();
    expect(ids(back.nodes)).toEqual(ids(dump.nodes));
    expect(ids(back.messages)).toEqual(ids(dump.messages));
    expect(ids(back.sessions)).toEqual(ids(dump.sessions));
    expect(back.nodes.find((n) => n.id === 'n2')).toEqual(dump.nodes.find((n) => n.id === 'n2'));
    expect(dumpFromFiles({})).toBeNull();
  });
});

import { fuzzyScore } from './text';

describe('go to file', () => {
  const rank = (typed: string, paths: string[]) => paths.filter((p) => fuzzyScore(p, typed) >= 0).sort((a, b) => fuzzyScore(b, typed) - fuzzyScore(a, typed));
  it('needs every typed letter, in order', () => {
    expect(fuzzyScore('src/chat.ts', 'chts')).toBeGreaterThan(0);
    expect(fuzzyScore('src/chat.ts', 'tsch')).toBe(-1);
  });
  it('puts a match in the file name ahead of one spread over folders', () => {
    expect(rank('pane', ['src/components/Handle.tsx', 'src/components/Pane.tsx', 'spa/new/e.ts'])[0]).toBe('src/components/Pane.tsx');
    expect(rank('wkspc', ['src/workspace.ts', 'src/components/WebView.tsx'])[0]).toBe('src/workspace.ts');
  });
});
