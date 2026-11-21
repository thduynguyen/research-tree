export type ProviderId = 'anthropic' | 'openai' | 'gemini' | 'custom' | 'demo';

export interface ModelRef {
  provider: ProviderId;
  model: string;
}

/** A folder of sessions: the ideas, papers and experiments that belong to one piece of work. */
export interface Project {
  id: string;
  name: string;
  deleted?: boolean;
  createdAt: number;
  updatedAt: number;
}

/** A session is a view onto the node forest, starting at rootNodeId. */
export interface Session {
  id: string;
  title: string;
  rootNodeId: string;
  /** The project it is filed under, if any. */
  projectId?: string;
  /** Set when this session was made by re-rooting a pane of another session. */
  originSessionId?: string;
  deleted?: boolean;
  createdAt: number;
  updatedAt: number;
}

/**
 * A PDF a node shows. Only this reference is stored and synced, never the file:
 * `fingerprint` identifies the PDF (empty until it has first been loaded) and
 * `url`, when known, is where to fetch it again on another device.
 */
export interface DocRef {
  fingerprint: string;
  title: string;
  url?: string;
  pages: number;
}

/**
 * A coloured highlight with nothing attached: on a PDF page, in a chat
 * message or in a note. `messageId` names the text it is in, as for an Anchor.
 */
export interface Highlight {
  id: string;
  nodeId: string;
  messageId?: string;
  /** How highlights were first stored, on PDF pages only; read through highlightKey. */
  page?: number;
  start: number;
  end: number;
  quote: string;
  color: string;
  deleted?: boolean;
  createdAt: number;
  updatedAt: number;
}

/**
 * Where a branch hangs off its parent: a text range inside one message, inside
 * one page of a PDF (`messageId` is "pdf" plus the page number), or inside a
 * note (`messageId` is "note").
 */
export interface Anchor {
  messageId: string;
  /** The highlight colour of the passage; absent on branches made before colours. */
  color?: string;
  start: number;
  end: number;
  quote: string;
}

export interface TreeNode {
  id: string;
  parentId: string | null;
  anchor?: Anchor;
  title: string;
  model?: ModelRef;
  /** Present when the node is a PDF to read rather than a chat thread. */
  doc?: DocRef;
  /**
   * For a conversation about a PDF: how much of the paper each request
   * carries. Absent means 'paper': all of it, as a shared, cacheable start.
   */
  scope?: DocScope;
  /**
   * What the model may do on the user's computer in this conversation, when the
   * server offers a choice. Absent means the least: answer only.
   */
  access?: string;
  /** Present when the node is a web page read in the app. An empty address is a browser not yet pointed anywhere. */
  web?: { url: string; title?: string };
  /**
   * Present when the node is a terminal: every message is a shell command run
   * on the user's computer, and the reply is its output. Holds the folder the
   * last command ended in ('' before the first), where the next one starts.
   */
  terminal?: string;
  /**
   * Present (possibly empty) when the node is a written annotation rather than
   * a chat thread: Markdown with LaTeX math, and no model involved.
   */
  note?: string;
  /**
   * Removed from its parent's tree without deleting anything: the branch and
   * its descendants are not listed, and its highlight shows as an underline
   * that can bring it back. A session rooted at the node still shows it.
   */
  hidden?: boolean;
  /**
   * Deleted for good, with everything under it. The record stays, emptied of
   * its content, so that another device learns of the deletion when it syncs.
   */
  deleted?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface Message {
  id: string;
  nodeId: string;
  role: 'user' | 'assistant';
  content: string;
  model?: ModelRef;
  error?: string;
  /** Its branch was deleted; the content has been emptied. */
  deleted?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
  /**
   * On the first turn only: the text of the paper the tree is rooted at. It is
   * kept apart from `content` and is word for word the same in every
   * conversation of the tree, so that a provider's prompt cache can serve it
   * to all of them after the first request.
   */
  doc?: string;
}

export interface DbDump {
  version: 1;
  /** Absent in dumps written before projects existed. */
  projects?: Project[];
  /** Absent in dumps written before the PDF reader existed. */
  highlights?: Highlight[];
  sessions: Session[];
  nodes: TreeNode[];
  messages: Message[];
}

/** The text range id used for page `n` of a PDF, and its inverse. */
export const pageKey = (n: number) => `pdf${n}`;
export const pageOf = (messageId: string) => (messageId.startsWith('pdf') ? Number(messageId.slice(3)) : undefined);
export const NOTE_KEY = 'note';
/** Marks on a web page are filed under this key, as a note's are under NOTE_KEY. */
export const WEB_KEY = 'web';
/** The text a highlight is in, whichever way it was stored. */
export const highlightKey = (h: Highlight) => h.messageId ?? pageKey(h.page ?? 1);

/**
 * How much of a paper goes to the model with each message: all of it (as a
 * start shared by every conversation in the tree, which providers cache), the
 * passage's page and the first page, or nothing beyond the passage itself.
 */
export type DocScope = 'paper' | 'page' | 'none';
