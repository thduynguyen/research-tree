import { pageOf, type ChatTurn, type DocScope, type Highlight, type Message, type TreeNode } from './types';

export interface TreeIndex {
  byId: Map<string, TreeNode>;
  /** Visible branches of each node. */
  childrenOf: Map<string, TreeNode[]>;
  /** Branches of each node that were removed from the tree but kept. */
  hiddenOf: Map<string, TreeNode[]>;
  messagesOf: Map<string, Message[]>;
  /** Live highlights of each PDF node. */
  highlightsOf: Map<string, Highlight[]>;
}

export function buildIndex(allNodes: TreeNode[], allMessages: Message[], highlights: Highlight[] = []): TreeIndex {
  // Deleted branches are gone as far as the app is concerned.
  const nodes = allNodes.filter((n) => !n.deleted);
  const messages = allMessages.filter((m) => !m.deleted);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const childrenOf = new Map<string, TreeNode[]>();
  const hiddenOf = new Map<string, TreeNode[]>();
  for (const n of nodes) {
    if (!n.parentId) continue;
    const map = n.hidden ? hiddenOf : childrenOf;
    const list = map.get(n.parentId) ?? [];
    list.push(n);
    map.set(n.parentId, list);
  }
  const messagesOf = new Map<string, Message[]>();
  for (const m of messages) {
    const list = messagesOf.get(m.nodeId) ?? [];
    list.push(m);
    messagesOf.set(m.nodeId, list);
  }
  for (const list of messagesOf.values()) list.sort((a, b) => a.createdAt - b.createdAt);

  // Branches are listed in the order their passages appear in the parent's
  // text: by page in a PDF, by message in a chat, then by position within it.
  // Branches without a passage come last, oldest first.
  const place = (n: TreeNode): number[] => {
    if (!n.anchor) return [Infinity, 0];
    const page = pageOf(n.anchor.messageId);
    if (page !== undefined) return [page, n.anchor.start];
    const at = (messagesOf.get(n.parentId!) ?? []).findIndex((m) => m.id === n.anchor!.messageId);
    return [at < 0 ? 0 : at, n.anchor.start];
  };
  for (const list of childrenOf.values()) {
    const key = new Map(list.map((n) => [n.id, place(n)]));
    list.sort((a, b) => {
      const [ka, kb] = [key.get(a.id)!, key.get(b.id)!];
      return ka[0] - kb[0] || ka[1] - kb[1] || a.createdAt - b.createdAt;
    });
  }
  const highlightsOf = new Map<string, Highlight[]>();
  for (const h of highlights) {
    if (h.deleted) continue;
    const list = highlightsOf.get(h.nodeId) ?? [];
    list.push(h);
    highlightsOf.set(h.nodeId, list);
  }
  return { byId, childrenOf, hiddenOf, messagesOf, highlightsOf };
}

/**
 * Nodes from `rootId` down to `nodeId`, inclusive. Stops at `rootId` even when
 * that node has a parent (a re-rooted session). Returns [] if nodeId is not
 * under rootId.
 */
export function pathFrom(idx: TreeIndex, rootId: string, nodeId: string): TreeNode[] {
  const path: TreeNode[] = [];
  let cur = idx.byId.get(nodeId);
  while (cur) {
    path.unshift(cur);
    if (cur.id === rootId) return path;
    cur = cur.parentId ? idx.byId.get(cur.parentId) : undefined;
  }
  return [];
}

export const SYSTEM_PROMPT =
  'You are a research assistant inside a branching discussion tool. ' +
  'The conversation can contain side branches, marked "[Side branch on the passage: ...]". ' +
  'In a side branch the user is asking about that specific passage from the message or document just before it; ' +
  'A document the user is reading appears as "[Document: ...]" followed by its text, page by page. ' +
  'Sometimes only some of its pages, or none, are included, to keep requests small. If an answer needs text you were not given, ' +
  'say so, and that the user can switch this conversation to send the whole paper. ' +
  'answer in that context. Be precise and concise, and use Markdown.';

/**
 * The turns sent to the model for a reply in `nodeId`: each ancestor's messages
 * up to the message the next branch is anchored to, a marker naming the quoted
 * passage, then the node's own messages. A PDF on the way contributes text,
 * which `docText` supplies per fingerprint when this device has it. By default
 * that is the whole paper, placed first and identical for every conversation
 * under it, so that the provider's prompt cache bills it at a fraction after
 * the first request. `scope` can cut it to the passage's page plus the first
 * page, or to nothing.
 */
export function buildContext(
  idx: TreeIndex,
  nodeId: string,
  docText: (fingerprint: string) => string[] | undefined = () => undefined,
  scope: DocScope = 'paper',
): ChatTurn[] {
  const chain: TreeNode[] = [];
  let cur = idx.byId.get(nodeId);
  while (cur) {
    chain.unshift(cur);
    cur = cur.parentId ? idx.byId.get(cur.parentId) : undefined;
  }

  const raw: (ChatTurn & { shared?: boolean })[] = [];
  chain.forEach((node, i) => {
    if (node.anchor && i > 0) {
      const page = pageOf(node.anchor.messageId);
      const where = page ? ` on page ${page}` : '';
      raw.push({ role: 'user', content: `[Side branch on the passage${where}: "${node.anchor.quote}"]` });
    }
    if (node.note !== undefined && node.note.trim()) {
      raw.push({ role: 'user', content: `[The user's own note on that passage: ${node.note.trim()}]` });
    }
    if (node.doc) {
      const pages = scope === 'none' ? undefined : docText(node.doc.fingerprint);
      if (scope === 'none') {
        raw.push({ role: 'user', content: `[Document: "${node.doc.title}". Its text is not included; only the passage below is.]` });
      } else if (!pages) {
        raw.push({ role: 'user', content: `[Document: "${node.doc.title}"]\n\n(The text of this document is not available on this device.)` });
      } else {
        const anchor = chain[i + 1]?.anchor;
        const passagePage = anchor ? pageOf(anchor.messageId) : undefined;
        const wanted =
          scope === 'paper'
            ? pages.map((_, p) => p + 1)
            : [...new Set([1, ...(passagePage ? [passagePage] : [])])].filter((p) => p <= pages.length);
        const body = wanted.map((p) => `--- Page ${p} ---\n${pages[p - 1]}`).join('\n\n');
        const partial = wanted.length < pages.length;
        const header = partial
          ? `[Document: "${node.doc.title}", ${pages.length} pages. Only page${wanted.length === 1 ? '' : 's'} ${wanted.join(' and ')} ${wanted.length === 1 ? 'is' : 'are'} included below.]`
          : `[Document: "${node.doc.title}"]`;
        // The whole paper at the very start is the same in every conversation, and is kept apart for caching.
        raw.push({ role: 'user', content: `${header}\n\n${body}`, shared: !partial && raw.length === 0 });
      }
    }
    let msgs = idx.messagesOf.get(node.id) ?? [];
    const next = chain[i + 1];
    if (next?.anchor) {
      const cut = msgs.findIndex((m) => m.id === next.anchor!.messageId);
      if (cut >= 0) msgs = msgs.slice(0, cut + 1);
    }
    for (const m of msgs) {
      if (m.content.trim()) raw.push({ role: m.role, content: m.content });
    }
  });

  // Providers require alternating roles starting with the user.
  const turns: ChatTurn[] = [];
  for (const t of raw) {
    const last = turns[turns.length - 1];
    if (t.shared) turns.push({ role: 'user', content: '', doc: t.content });
    else if (last && last.role === t.role) last.content = last.content ? `${last.content}\n\n${t.content}` : t.content;
    else turns.push({ role: t.role, content: t.content });
  }
  if (turns[0]?.role === 'assistant') turns.unshift({ role: 'user', content: '(conversation start)' });
  return turns;
}

/** One line describing a node of any kind, for lists of branches. */
export function preview(idx: TreeIndex, node: TreeNode): string {
  if (node.note !== undefined) return node.note.trim() ? shorten(node.note, 160) : 'Empty note';
  if (node.doc) return node.doc.pages ? `PDF · ${node.doc.pages} pages` : 'PDF';
  return summarize(idx.messagesOf.get(node.id) ?? []);
}

/** What a branch holds, in a word or two: "note", "PDF · 15 pages", "2 questions". */
export function kindLabel(idx: TreeIndex, node: TreeNode): string {
  if (node.note !== undefined) return 'note';
  if (node.doc) return node.doc.pages ? `PDF · ${node.doc.pages} pages` : 'PDF';
  const asked = (idx.messagesOf.get(node.id) ?? []).filter((m) => m.role === 'user').length;
  return asked === 1 ? '1 question' : `${asked} questions`;
}

/** One line shown on a collapsed branch. No model call: the start of the last answer. */
export function summarize(messages: Message[]): string {
  const lastAnswer = [...messages].reverse().find((m) => m.role === 'assistant' && m.content.trim());
  const source = lastAnswer ?? messages.find((m) => m.content.trim());
  if (!source) return 'No messages yet';
  const flat = source.content.replace(/[#*_`>]/g, '').replace(/\s+/g, ' ').trim();
  const sentence = flat.match(/^.{20,}?[.!?](?=\s|$)/)?.[0] ?? flat;
  return sentence.length > 160 ? sentence.slice(0, 157) + '…' : sentence;
}

export function shorten(text: string, max = 60): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}
