import type { ChatTurn, Message, TreeNode } from './types';

export interface TreeIndex {
  byId: Map<string, TreeNode>;
  /** Visible branches of each node. */
  childrenOf: Map<string, TreeNode[]>;
  /** Branches of each node that were removed from the tree but kept. */
  hiddenOf: Map<string, TreeNode[]>;
  messagesOf: Map<string, Message[]>;
}

export function buildIndex(nodes: TreeNode[], messages: Message[]): TreeIndex {
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
  for (const list of childrenOf.values()) list.sort((a, b) => a.createdAt - b.createdAt);
  const messagesOf = new Map<string, Message[]>();
  for (const m of messages) {
    const list = messagesOf.get(m.nodeId) ?? [];
    list.push(m);
    messagesOf.set(m.nodeId, list);
  }
  for (const list of messagesOf.values()) list.sort((a, b) => a.createdAt - b.createdAt);
  return { byId, childrenOf, hiddenOf, messagesOf };
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
  'In a side branch the user is asking about that specific passage from the message just before it; ' +
  'answer in that context. Be precise and concise, and use Markdown.';

/**
 * The turns sent to the model for a reply in `nodeId`: each ancestor's messages
 * up to the message the next branch is anchored to, a marker naming the quoted
 * passage, then the node's own messages.
 */
export function buildContext(idx: TreeIndex, nodeId: string): ChatTurn[] {
  const chain: TreeNode[] = [];
  let cur = idx.byId.get(nodeId);
  while (cur) {
    chain.unshift(cur);
    cur = cur.parentId ? idx.byId.get(cur.parentId) : undefined;
  }

  const raw: ChatTurn[] = [];
  chain.forEach((node, i) => {
    if (node.anchor && i > 0) {
      raw.push({ role: 'user', content: `[Side branch on the passage: "${node.anchor.quote}"]` });
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
    if (last && last.role === t.role) last.content += '\n\n' + t.content;
    else turns.push({ ...t });
  }
  if (turns[0]?.role === 'assistant') turns.unshift({ role: 'user', content: '(conversation start)' });
  return turns;
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
