import { createContext, useContext } from 'react';
import type { TreeIndex } from './tree';
import type { Session, TreeNode } from './types';

/**
 * What is on screen for a session. Every level of the tree along the chosen
 * line is an open column: `choice` remembers which branch was last selected
 * under each node, so the line runs root -> choice[root] -> choice[that] ...
 * `pinned` branches hold fixed slots at the top of their level and stay in
 * view while the other siblings scroll.
 */
export interface View {
  choice: Record<string, string>;
  pinned: string[];
  /**
   * Panels whose scroll position is locked: selecting one of their branches
   * does not scroll them to its highlight.
   */
  locked: string[];
}


/** Pinned panels per level. More than this leaves each too short to read. */
export const MAX_PINNED = 2;

/** One column: the branches of `parent`, with `selected` continuing the line. */
export interface LevelInfo {
  parent: TreeNode;
  nodes: TreeNode[];
  selected: TreeNode | null;
  depth: number;
}

export interface Workspace {
  idx: TreeIndex;
  session: Session;
  sessions: Session[];
  view: View;
  /** The chosen line, session root first. */
  trail: TreeNode[];
  levels: LevelInfo[];
  /** A request to bring a node's column into view; `n` changes on every request. */
  focus: { id: string; n: number } | null;
  /** Puts a node on the chosen line. `focus: false` is for selections made by scrolling to it. */
  select(nodeId: string, opts?: { focus?: boolean }): void;
  togglePin(nodeId: string): void;
  /** Locks or unlocks one panel's scroll position (see View.locked). */
  toggleLock(nodeId: string): void;
  branch(nodeId: string, messageId: string, start: number, end: number, quote: string): Promise<void>;
  /** Takes a branch out of this tree, keeping its data and an underlined highlight. */
  hide(nodeId: string): Promise<void>;
  /** Puts a hidden branch, with everything under it, back in the tree. */
  restore(nodeId: string): Promise<void>;
  makeRoot(nodeId: string): Promise<void>;
  /**
   * For a session whose root is a branch moved out of another tree: the session
   * where that branch's parent is on show, which is where putting it back leads.
   */
  home?: Session;
  /** Undoes makeRoot from inside the split-off session: the branch returns to its tree and this session is removed. */
  undoSplit(): Promise<void>;
  openSession(id: string, nodeId?: string): void;
}

export const WorkspaceCtx = createContext<Workspace | null>(null);

export function useWorkspace(): Workspace {
  const ws = useContext(WorkspaceCtx);
  if (!ws) throw new Error('No workspace');
  return ws;
}

/** Follows the saved choices down from the root, repairing any that no longer exist. */
export function resolveView(idx: TreeIndex, rootId: string, saved?: Partial<View>): { view: View; trail: TreeNode[]; levels: LevelInfo[] } {
  const pinned = (saved?.pinned ?? []).filter((id) => idx.byId.has(id));
  const choice = saved?.choice ?? {};
  const trail: TreeNode[] = [idx.byId.get(rootId)!];
  const levels: LevelInfo[] = [];
  for (let cur = trail[0]; trail.length < 500; ) {
    const nodes = idx.childrenOf.get(cur.id) ?? [];
    if (!nodes.length) break;
    // Without a remembered choice, the first branch that is not pinned continues the line.
    const selected = nodes.find((n) => n.id === choice[cur.id]) ?? nodes.find((n) => !pinned.includes(n.id)) ?? null;
    levels.push({ parent: cur, nodes, selected, depth: trail.length });
    if (!selected) break;
    trail.push(selected);
    cur = selected;
  }
  const locked = (saved?.locked ?? []).filter((id) => idx.byId.has(id));
  return { view: { choice, pinned, locked }, trail, levels };
}

/** The view with the line running through `ids` (a root-to-node path). */
export function choosePath(view: View, ids: string[]): View {
  const choice = { ...view.choice };
  for (let i = 1; i < ids.length; i++) choice[ids[i - 1]] = ids[i];
  return { ...view, choice };
}
