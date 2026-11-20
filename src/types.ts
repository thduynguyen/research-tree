export type ProviderId = 'anthropic' | 'openai' | 'gemini' | 'demo';

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

/** Where a branch hangs off its parent: a text range inside one message. */
export interface Anchor {
  messageId: string;
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
  /**
   * Removed from its parent's tree without deleting anything: the branch and
   * its descendants are not listed, and its highlight shows as an underline
   * that can bring it back. A session rooted at the node still shows it.
   */
  hidden?: boolean;
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
  createdAt: number;
  updatedAt: number;
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface DbDump {
  version: 1;
  /** Absent in dumps written before projects existed. */
  projects?: Project[];
  sessions: Session[];
  nodes: TreeNode[];
  messages: Message[];
}
