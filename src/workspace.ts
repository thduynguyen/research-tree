import { createContext, useContext } from 'react';
import type { TreeIndex } from './tree';
import type { DocRef, DocScope, Highlight, Session, TreeNode } from './types';

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
  /** Conversations shrunk to a few lines, like a note, until expanded again. */
  minimized: string[];
  /**
   * Branches whose own branches are on show in the next column. A branch's
   * subtree stays closed until it is opened on purpose: selecting a panel only
   * selects it. The root's branches are always on show.
   */
  expanded: string[];
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
  /**
   * The branch the reader last picked on purpose, and when. Its parent scrolls
   * to its passage. Selections the app makes by itself (after a delete, or when
   * a column of panels comes to rest) are not picks and move nothing.
   */
  picked: { id: string; n: number; at: number } | null;
  /**
   * Puts a node on the chosen line. `focus: false` keeps the columns where they
   * are; `follow: false` also leaves the parent's text where it is.
   */
  select(nodeId: string, opts?: { focus?: boolean; follow?: boolean }): void;
  togglePin(nodeId: string): void;
  /** Locks or unlocks one panel's scroll position (see View.locked). */
  toggleLock(nodeId: string): void;
  toggleMinimized(nodeId: string): void;
  /** Opens or closes the column of a branch's own branches. */
  toggleExpanded(nodeId: string): void;
  /**
   * Opens a branch on a text range: a chat with the model by default, a PDF to
   * read with `doc`, or a written annotation with `note`.
   */
  branch(nodeId: string, messageId: string, start: number, end: number, quote: string, extra?: { doc?: DocRef; color?: string; note?: boolean }): Promise<void>;
  highlight(nodeId: string, messageId: string, start: number, end: number, quote: string, color: string): Promise<void>;
  updateHighlight(id: string, patch: Partial<Pick<Highlight, 'color' | 'deleted'>>): Promise<void>;
  setNote(nodeId: string, text: string): Promise<void>;
  setColor(nodeId: string, color: string): Promise<void>;
  /** Sets how much of the paper this conversation sends with each message. */
  setScope(nodeId: string, scope: DocScope): Promise<void>;
  /** Records what a PDF node turned out to be once its file has been loaded. */
  setDoc(nodeId: string, doc: DocRef): Promise<void>;
  /** Deletes a branch for good, with every branch, message and highlight under it. */
  remove(nodeId: string): Promise<void>;
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

/**
 * Notes created in this tab that have not been written yet. Their panels open
 * with the editor ready. This is kept outside React state so that it is
 * already set whenever the new note's panel first appears, and it is local to
 * the tab, so another tab showing the same empty note does not open an editor.
 */
export const freshNotes = new Set<string>();

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
  const minimized = (saved?.minimized ?? []).filter((id) => idx.byId.has(id));
  const expanded = (saved?.expanded ?? []).filter((id) => idx.byId.has(id));
  for (let cur = trail[0]; trail.length < 500; ) {
    const nodes = idx.childrenOf.get(cur.id) ?? [];
    if (!nodes.length) break;
    // Without a remembered choice, the first branch that is not pinned continues the line.
    const selected = nodes.find((n) => n.id === choice[cur.id]) ?? nodes.find((n) => !pinned.includes(n.id)) ?? null;
    levels.push({ parent: cur, nodes, selected, depth: trail.length });
    if (!selected) break;
    trail.push(selected);
    // The line goes on into a branch's own branches only once that branch has been opened up.
    if (!expanded.includes(selected.id) || minimized.includes(selected.id)) break;
    cur = selected;
  }
  const locked = (saved?.locked ?? []).filter((id) => idx.byId.has(id));
  return { view: { choice, pinned, locked, minimized, expanded }, trail, levels };
}

/**
 * The view with the line running through `ids` (a root-to-node path). Going to
 * a node opens up every branch on the way to it, so that it is on show; the
 * node itself stays closed.
 */
export function choosePath(view: View, ids: string[]): View {
  const choice = { ...view.choice };
  for (let i = 1; i < ids.length; i++) choice[ids[i - 1]] = ids[i];
  const onTheWay = ids.slice(1, -1);
  const expanded = [...new Set([...view.expanded, ...onTheWay])];
  return { ...view, choice, expanded, minimized: view.minimized.filter((id) => !onTheWay.includes(id)) };
}
