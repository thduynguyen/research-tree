import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Project, Session, TreeNode } from '../types';
import { useWorkspace } from '../workspace';
import { IconButton } from './Icon';

const FOLDS_KEY = 'rt.folds';
/** The value standing for "sessions that are in no project". */
const NONE = '';

/** Which rows the user has opened or closed by hand; other rows use their default. */
function useFolds() {
  const [folds, setFolds] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem(FOLDS_KEY) ?? '{}');
    } catch {
      return {};
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(FOLDS_KEY, JSON.stringify(folds));
    } catch {
      // Folding then lasts for this tab only.
    }
  }, [folds]);
  return {
    isOpen: (id: string, fallback: boolean) => folds[id] ?? fallback,
    set: (id: string, open: boolean) => setFolds((all) => ({ ...all, [id]: open })),
  };
}
type Folds = ReturnType<typeof useFolds>;

function Twisty({ open, label, onToggle }: { open: boolean; label: string; onToggle: () => void }) {
  return (
    <button className="twisty" aria-expanded={open} aria-label={`${open ? 'Collapse' : 'Expand'} ${label}`} onClick={onToggle}>
      <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4.5 2.5L8 6l-3.5 3.5" />
      </svg>
    </button>
  );
}

/**
 * A branch and, when unfolded, the branches under it. Unfolding only shows
 * what is there; it selects nothing. Clicking the name goes to the branch,
 * opening its session first when that is not the one on screen.
 */
function Branch({ node, depth, session, folds }: { node: TreeNode; depth: number; session: Session; folds: Folds }) {
  const ws = useWorkspace();
  const inOpenSession = session.id === ws.session.id;
  const kids = ws.idx.childrenOf.get(node.id) ?? [];
  const onLine = inOpenSession && ws.trail.some((n) => n.id === node.id);
  const current = inOpenSession && ws.focus?.id === node.id;
  // Unless folded by hand, the line being read is open and the rest is closed.
  const open = folds.isOpen(`${session.id}:${node.id}`, onLine);
  // Questions asked in a conversation. A note or a PDF has no number.
  const asked = node.note !== undefined || node.doc ? null : (ws.idx.messagesOf.get(node.id) ?? []).filter((m) => m.role === 'user').length;
  return (
    <>
      <div className={`tree-row${onLine ? ' on-line' : ''}${current ? ' current' : ''}`} style={{ paddingLeft: depth * 14 }}>
        {kids.length > 0 ? (
          <Twisty open={open} label={node.title} onToggle={() => folds.set(`${session.id}:${node.id}`, !open)} />
        ) : (
          <span className="twisty-gap" />
        )}
        <button
          className="tree-label"
          aria-current={current ? 'true' : undefined}
          onClick={() => (inOpenSession ? ws.select(node.id) : ws.openSession(session.id, node.id))}
        >
          <span className="name">“{node.title}”</span>
          {asked !== null && (
            <span className="count" title={asked === 1 ? '1 question asked' : `${asked} questions asked`}>{asked}</span>
          )}
        </button>
      </div>
      {open && kids.map((k) => <Branch key={k.id} node={k} depth={depth + 1} session={session} folds={folds} />)}
    </>
  );
}

interface Props {
  pinned: boolean;
  peek: boolean;
  dirty: boolean;
  syncStatus: string;
  pushLabel: string;
  gitReady: boolean;
  projects: Project[];
  onPin: (pinned: boolean) => void;
  onPeek: (peek: boolean) => void;
  onNew: (projectId?: string) => void;
  onOpenPdf: (projectId?: string) => void;
  /** Opens a terminal in the project's folder; absent when no local server offers one. */
  onTerminal?: (projectId?: string) => void;
  /** Creates the project and returns its id. */
  onNewProject: (name: string) => string;
  onMoveSession: (sessionId: string, projectId?: string) => void;
  onRename: (sessionId: string, title: string) => void;
  onDeleteProject: (id: string) => void;
  onDelete: (id: string) => void;
  onPush: () => void;
  onSettings: () => void;
}

/**
 * One project at a time: its sessions, each unfolding into its branches. The
 * header names the project and switches between projects. Pinned, the panel
 * is a normal column. Unpinned, it shrinks to a rail and slides out over the
 * panes while the pointer is on it.
 */
export function Sidebar(p: Props) {
  const ws = useWorkspace();
  const folds = useFolds();
  const leave = useRef(0);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [naming, setNaming] = useState<string | null>(null);
  // The session whose title is being typed over, after a double click on it.
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  // The "move to project" menu: which session's is open, and whether it is on its new-project field.
  const [movingId, setMovingId] = useState<string | null>(null);
  const [moving, setMovingMode] = useState<'closed' | 'list' | 'new'>('closed');
  const setMoving = (mode: 'closed' | 'list' | 'new', id?: string) => {
    setMovingMode(mode);
    setMovingId(mode === 'closed' ? null : id ?? movingId);
  };
  const [moveName, setMoveName] = useState('');
  const moveRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (moving === 'closed') return;
    const dismiss = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !moveRef.current?.contains(e.target as Node)) setMoving('closed');
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', dismiss);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', dismiss);
    };
  }, [moving]);
  const shown = p.pinned || p.peek;

  const projects = [...p.projects].sort((a, b) => a.name.localeCompare(b.name));
  const projectOf = (s: Session) => (projects.some((pr) => pr.id === s.projectId) ? s.projectId! : NONE);

  // The panel shows the project of the session on screen, and follows it when
  // that changes. Picking another project in the header only changes the list.
  const [projectId, setProjectId] = useState(() => projectOf(ws.session));
  const home = projectOf(ws.session);
  useEffect(() => setProjectId(home), [ws.session.id, home]);
  const project = projects.find((pr) => pr.id === projectId);
  const shownId = project ? project.id : NONE;
  const projectName = project?.name ?? 'No project';

  const sessions = ws.sessions
    .filter((s) => !s.deleted && projectOf(s) === shownId)
    .sort((a, b) => b.updatedAt - a.updatedAt);

  const confirm = (id: string, what: string, onYes: () => void): ReactNode =>
    confirming === id ? (
      <span className="confirm">
        Delete?
        <button className="link danger" onClick={() => { setConfirming(null); onYes(); }}>Yes</button>
        <button className="link" onClick={() => setConfirming(null)}>No</button>
      </span>
    ) : (
      <IconButton icon="close" label={`Delete ${what}`} onClick={() => setConfirming(id)} />
    );

  const sessionRow = (s: Session) => {
    const current = s.id === ws.session.id;
    const kids = ws.idx.childrenOf.get(s.rootNodeId) ?? [];
    const open = folds.isOpen(s.id, current);
    return (
      <div key={s.id}>
        <div className={`tree-row session${current ? ' current' : ''}${movingId === s.id || confirming === s.id ? ' busy' : ''}`}>
          {kids.length > 0 ? (
            <Twisty open={open} label={s.title} onToggle={() => folds.set(s.id, !open)} />
          ) : (
            <span className="twisty-gap" />
          )}
          {renaming?.id === s.id ? (
            <form
              className="rename"
              onSubmit={(e) => {
                e.preventDefault();
                if (renaming.value.trim()) p.onRename(s.id, renaming.value.trim());
                setRenaming(null);
              }}
            >
              <input
                autoFocus
                aria-label="Session title"
                value={renaming.value}
                onChange={(e) => setRenaming({ id: s.id, value: e.target.value })}
                onBlur={() => setRenaming(null)}
                onKeyDown={(e) => e.key === 'Escape' && setRenaming(null)}
              />
            </form>
          ) : (
            <button
              className="tree-label"
              aria-current={current ? 'true' : undefined}
              title={`${s.title}\nDouble-click to rename`}
              onClick={() => (current ? ws.select(s.rootNodeId) : ws.openSession(s.id))}
              onDoubleClick={() => setRenaming({ id: s.id, value: s.title })}
            >
              <span className="name">{s.title}</span>
            </button>
          )}
          <span className="row-actions">
          {confirming !== s.id && (
            <div className="move" ref={movingId === s.id ? moveRef : undefined}>
              <IconButton
                icon="popout"
                pressed={movingId === s.id}
                label="Move this session to a project"
                onClick={() => {
                  setMoveName('');
                  setMoving(movingId === s.id ? 'closed' : 'list', s.id);
                }}
              />
              {movingId === s.id && moving !== 'closed' && (
                <div className="move-menu" role="menu" aria-label="Move this session to">
                  {moving === 'new' ? (
                    <form
                      className="new-project"
                      onSubmit={(e) => {
                        e.preventDefault();
                        if (moveName.trim()) p.onMoveSession(s.id, p.onNewProject(moveName.trim()));
                        setMoving('closed');
                      }}
                    >
                      <input
                        autoFocus
                        aria-label="New project name"
                        placeholder="New project name"
                        value={moveName}
                        onChange={(e) => setMoveName(e.target.value)}
                      />
                      <button className="btn primary" type="submit">Move</button>
                    </form>
                  ) : (
                    <>
                      <button role="menuitem" className="move-item new" onClick={() => setMoving('new')}>
                        New project…
                      </button>
                      {projects
                        .filter((pr) => pr.id !== projectOf(s))
                        .map((pr) => (
                          <button
                            key={pr.id}
                            role="menuitem"
                            className="move-item"
                            onClick={() => {
                              setMoving('closed');
                              p.onMoveSession(s.id, pr.id);
                            }}
                          >
                            {pr.name}
                          </button>
                        ))}
                      {projectOf(s) !== NONE && (
                        <button
                          role="menuitem"
                          className="move-item"
                          onClick={() => {
                            setMoving('closed');
                            p.onMoveSession(s.id, undefined);
                          }}
                        >
                          No project
                        </button>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          )}
          {confirm(s.id, 'this session', () => p.onDelete(s.id))}
          </span>
        </div>
        {open && kids.map((k) => <Branch key={k.id} node={k} depth={1} session={s} folds={folds} />)}
      </div>
    );
  };

  return (
    <aside
      className={`sidebar${shown ? '' : ' rail-only'}${!p.pinned && p.peek ? ' floating' : ''}`}
      onMouseEnter={() => {
        clearTimeout(leave.current);
        if (!p.pinned) p.onPeek(true);
      }}
      onMouseLeave={() => {
        if (!p.pinned) leave.current = window.setTimeout(() => p.onPeek(false), 250);
      }}
    >
      {!shown && (
        <button className="rail" aria-label={`Show the sessions of ${projectName}`} onClick={() => p.onPeek(true)}>
          <span>{projectName}</span>
        </button>
      )}
      {shown && (
        <>
          <div className="sidebar-head">
            {naming === null ? (
              <>
                <select
                  className="project-select"
                  aria-label="Project"
                  title="Switch project"
                  value={shownId}
                  onChange={(e) => {
                    setConfirming(null);
                    setProjectId(e.target.value);
                  }}
                >
                  {projects.map((pr) => (
                    <option key={pr.id} value={pr.id}>{pr.name}</option>
                  ))}
                  <option value={NONE}>No project</option>
                </select>
                {confirming !== shownId && <IconButton icon="plus" label="New project" onClick={() => setNaming('')} />}
                {project && confirm(project.id, `the project ${project.name}. Its sessions are kept, under No project`, () => p.onDeleteProject(project.id))}
                <IconButton
                  icon="pin"
                  pressed={p.pinned}
                  label={p.pinned ? 'Unpin: hide this panel until the pointer is on its edge' : 'Pin: keep this panel open'}
                  onClick={() => p.onPin(!p.pinned)}
                />
              </>
            ) : (
              <form
                className="new-project"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (naming.trim()) setProjectId(p.onNewProject(naming.trim()));
                  setNaming(null);
                }}
              >
                <input
                  autoFocus
                  aria-label="New project name"
                  placeholder="New project name"
                  value={naming}
                  onChange={(e) => setNaming(e.target.value)}
                  onKeyDown={(e) => e.key === 'Escape' && setNaming(null)}
                />
                <button className="btn primary" type="submit">Add</button>
              </form>
            )}
          </div>

          <nav className="sidebar-scroll" aria-label={`Sessions in ${projectName}`}>
            {sessions.map(sessionRow)}
            <button className="tree-row new-session" onClick={() => p.onNew(project?.id)}>
              <span className="twisty-gap" aria-hidden="true">+</span>
              <span className="tree-label">New session</span>
            </button>
            <button className="tree-row new-session" onClick={() => p.onOpenPdf(project?.id)}>
              <span className="twisty-gap" aria-hidden="true">+</span>
              <span className="tree-label">Open a PDF</span>
            </button>
            {p.onTerminal && (
              <button className="tree-row new-session" onClick={() => p.onTerminal!(project?.id)}>
                <span className="twisty-gap" aria-hidden="true">+</span>
                <span className="tree-label">Terminal</span>
              </button>
            )}
          </nav>

          <div className="sidebar-foot">
            {p.gitReady ? (
              <button className="btn" onClick={p.onPush}>
                {p.pushLabel}{p.dirty && <span className="dot" aria-label="unpushed changes" />}
              </button>
            ) : (
              <button className="btn" onClick={p.onSettings}>Set up git sync</button>
            )}
            <button className="btn" onClick={p.onSettings}>Settings</button>
            <div className="status" role="status">
              {p.syncStatus || (p.dirty ? 'Saved on this device. Not pushed yet.' : 'Saved on this device.')}
            </div>
          </div>
        </>
      )}
    </aside>
  );
}
