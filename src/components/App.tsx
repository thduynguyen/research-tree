import { useLiveQuery } from 'dexie-react-hooks';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createSession, db, putNode, putProject, putSession, uid } from '../db';
import { getSettings, useSettings } from '../settings';
import { pull, push } from '../sync';
import { buildIndex, pathFrom, shorten } from '../tree';
import type { TreeNode } from '../types';
import { MAX_PINNED, WorkspaceCtx, choosePath, resolveView, type View, type Workspace } from '../workspace';
import { Columns } from './Columns';
import { Handle } from './Handle';
import { IconButton } from './Icon';
import { SelectionPopover } from './SelectionPopover';
import { Settings } from './Settings';
import { Sidebar } from './Sidebar';

const VIEWS_KEY = 'rt.views.v2';
const SESSION_KEY = 'rt.session';
const PIN_KEY = 'rt.sidebarPinned';
const SIDEBAR_KEY = 'rt.sidebarWidth';

function loadJson<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) ?? '') as T;
  } catch {
    return fallback;
  }
}

function saveLocal(key: string, value: unknown) {
  try {
    localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
  } catch {
    // Remembering the layout is a convenience; the app works without it.
  }
}

export function App() {
  const sessions = useLiveQuery(() => db.sessions.toArray(), []);
  const projects = useLiveQuery(() => db.projects.toArray(), []);
  const nodes = useLiveQuery(() => db.nodes.toArray(), []);
  const messages = useLiveQuery(() => db.messages.toArray(), []);
  const dirty = useLiveQuery(() => db.meta.get('dirty'), [])?.value === true;
  const settings = useSettings();

  const [sessionId, setSessionId] = useState<string | null>(() => localStorage.getItem(SESSION_KEY));
  // Sessions visited before the current one, most recent last, for the back button.
  const [history, setHistory] = useState<string[]>([]);
  // Sessions stepped back from, nearest last, for the forward button. Going somewhere new clears it.
  const [future, setFuture] = useState<string[]>([]);
  const [views, setViews] = useState<Record<string, Partial<View>>>(() => loadJson(VIEWS_KEY, {}));
  const [focus, setFocus] = useState<{ id: string; n: number } | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [pinned, setPinned] = useState(() => loadJson(PIN_KEY, true));
  const [peek, setPeek] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(() => loadJson(SIDEBAR_KEY, 264));
  const [syncStatus, setSyncStatus] = useState('');

  const idx = useMemo(() => buildIndex(nodes ?? [], messages ?? []), [nodes, messages]);
  const visible = useMemo(() => (sessions ?? []).filter((s) => !s.deleted && idx.byId.has(s.rootNodeId)), [sessions, idx]);
  const session = visible.find((s) => s.id === sessionId) ?? [...visible].sort((a, b) => b.updatedAt - a.updatedAt)[0];

  // First run, or the last session was deleted: there is always one to work in.
  const creating = useRef(false);
  useEffect(() => {
    if (!sessions || !nodes || session || creating.current) return;
    creating.current = true;
    void createSession().then((s) => {
      setSessionId(s.id);
      creating.current = false;
    });
  }, [sessions, nodes, session]);

  useEffect(() => {
    if (session) saveLocal(SESSION_KEY, session.id);
  }, [session?.id]);
  useEffect(() => saveLocal(VIEWS_KEY, views), [views]);
  useEffect(() => saveLocal(PIN_KEY, pinned), [pinned]);
  useEffect(() => saveLocal(SIDEBAR_KEY, sidebarWidth), [sidebarWidth]);

  const runSync = useCallback(async (kind: 'pull' | 'push') => {
    const cfg = getSettings().github;
    if (!cfg) return;
    setSyncStatus(kind === 'push' ? 'Pushing…' : 'Pulling…');
    try {
      if (kind === 'push') {
        await push(cfg);
        setSyncStatus(`Pushed to ${cfg.repo} at ${new Date().toLocaleTimeString()}`);
      } else {
        const found = await pull(cfg);
        setSyncStatus(found ? `Pulled from ${cfg.repo}` : `Nothing in ${cfg.repo} yet`);
      }
    } catch (e) {
      setSyncStatus(`Sync failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  // Pick up work pushed from another device when the app opens.
  useEffect(() => {
    void runSync('pull');
  }, [runSync]);

  const workspace = useMemo<Workspace | null>(() => {
    if (!session) return null;
    const rootId = session.rootNodeId;
    const go = (id: string) => {
      if (id !== session.id) {
        setHistory((h) => [...h, session.id]);
        setFuture([]);
      }
      setSessionId(id);
    };
    const { view, trail, levels } = resolveView(idx, rootId, views[session.id]);
    // Updates start from the repaired view, never from a stale saved one.
    const setView = (change: (cur: View) => View) =>
      setViews((all) => ({ ...all, [session.id]: change(resolveView(idx, rootId, all[session.id]).view) }));
    const ask = (id: string) => setFocus((f) => ({ id, n: (f?.n ?? 0) + 1 }));
    const idsTo = (nodeId: string) => pathFrom(idx, rootId, nodeId).map((n) => n.id);

    // Where this session's root would reappear if put back: a session that shows
    // its parent. The one it was moved out of comes first; failing that (that
    // tree has since lost the parent too), the session rooted nearest to it.
    const rootNode = idx.byId.get(rootId)!;
    const showsParent = (s: (typeof visible)[number]) => {
      if (!rootNode.parentId || s.id === session.id) return 0;
      const path = pathFrom(idx, s.rootNodeId, rootNode.parentId);
      return path.length && path.slice(1).every((n) => !n.hidden) ? path.length : 0;
    };
    const candidates = visible.filter((s) => showsParent(s) > 0).sort((a, b) => showsParent(a) - showsParent(b));
    const home = candidates.find((s) => s.id === session.originSessionId) ?? candidates[0];

    return {
      idx,
      session,
      sessions: sessions ?? [],
      view,
      trail,
      levels,
      focus,
      home,
      select(nodeId, opts) {
        const ids = idsTo(nodeId);
        if (!ids.length) return;
        setView((cur) => choosePath(cur, ids));
        if (opts?.focus !== false) ask(nodeId);
      },
      toggleLock: (nodeId) =>
        setView((cur) => ({
          ...cur,
          locked: cur.locked.includes(nodeId) ? cur.locked.filter((id) => id !== nodeId) : [...cur.locked, nodeId],
        })),
      togglePin: (nodeId) =>
        setView((cur) => {
          if (cur.pinned.includes(nodeId)) return { ...cur, pinned: cur.pinned.filter((id) => id !== nodeId) };
          const parentId = idx.byId.get(nodeId)?.parentId;
          if (!parentId) return cur;
          const siblings = idx.childrenOf.get(parentId) ?? [];
          if (siblings.filter((n) => cur.pinned.includes(n.id)).length >= MAX_PINNED) return cur;
          // Pinning the branch the line runs through moves the line to its neighbour,
          // so the scrolling column still has a selected panel.
          const free = siblings.filter((n) => n.id === nodeId || !cur.pinned.includes(n.id));
          const at = free.findIndex((n) => n.id === nodeId);
          const neighbour = free[at + 1] ?? free[at - 1];
          const onLine = trail.some((n) => n.id === nodeId);
          const choice = onLine && neighbour ? { ...cur.choice, [parentId]: neighbour.id } : cur.choice;
          return { ...cur, choice, pinned: [...cur.pinned, nodeId] };
        }),
      async branch(nodeId, messageId, start, end, quote) {
        const t = Date.now();
        const node: TreeNode = {
          id: uid(),
          parentId: nodeId,
          anchor: { messageId, start, end, quote },
          title: shorten(quote),
          createdAt: t,
          updatedAt: t,
        };
        await putNode(node);
        const ids = [...idsTo(nodeId), node.id];
        setView((cur) => choosePath(cur, ids));
        ask(node.id);
      },
      async hide(nodeId) {
        const node = idx.byId.get(nodeId);
        if (!node?.parentId) return;
        await putNode({ ...node, hidden: true });
      },
      async restore(nodeId) {
        const node = idx.byId.get(nodeId);
        if (!node?.parentId) return;
        await putNode({ ...node, hidden: false });
        const ids = [...idsTo(node.parentId), nodeId];
        setView((cur) => choosePath(cur, ids));
        ask(nodeId);
      },
      // The branch moves out: it becomes the root of its own session and leaves
      // this tree, where only its underlined highlight remains.
      async makeRoot(nodeId) {
        const node = idx.byId.get(nodeId);
        if (!node || nodeId === rootId) return;
        let target = (sessions ?? []).find((s) => !s.deleted && s.rootNodeId === nodeId);
        if (!target) {
          const t = Date.now();
          target = { id: uid(), title: node.title, rootNodeId: nodeId, originSessionId: session.id, projectId: session.projectId, createdAt: t, updatedAt: t };
          await putSession(target);
        } else if (target.originSessionId !== session.id) {
          // An existing session for this branch: record where it was moved from this time.
          target = { ...target, originSessionId: session.id };
          await putSession(target);
        }
        await putNode({ ...node, hidden: true });
        go(target.id);
      },
      async undoSplit() {
        if (!home || !rootNode.parentId) return;
        await putNode({ ...rootNode, hidden: false });
        await putSession({ ...session, deleted: true });
        const ids = pathFrom(idx, home.rootNodeId, rootNode.parentId).map((n) => n.id);
        setViews((all) => ({ ...all, [home.id]: choosePath(resolveView(idx, home.rootNodeId, all[home.id]).view, [...ids, rootId]) }));
        ask(rootId);
        // This session no longer exists, so it does not go on the back stack.
        setHistory((h) => h.filter((id) => id !== session.id && id !== home.id));
        setFuture((f) => f.filter((id) => id !== session.id));
        setSessionId(home.id);
      },
      openSession(id, nodeId) {
        const target = (sessions ?? []).find((s) => s.id === id);
        if (target && nodeId) {
          const ids = pathFrom(idx, target.rootNodeId, nodeId).map((n) => n.id);
          if (ids.length) {
            setViews((all) => ({ ...all, [id]: choosePath(resolveView(idx, target.rootNodeId, all[id]).view, ids) }));
            ask(nodeId);
          }
        }
        go(id);
        setPeek(false);
      },
    };
  }, [session, sessions, visible, idx, views, focus]);

  if (!workspace) return <div className="loading">Loading…</div>;

  const previous = [...history].reverse().find((id) => id !== workspace.session.id && visible.some((s) => s.id === id));
  const previousTitle = visible.find((s) => s.id === previous)?.title;
  const goBack = () => {
    if (!previous) return;
    setHistory((h) => h.slice(0, h.lastIndexOf(previous)));
    setFuture((f) => [...f, workspace.session.id]);
    setSessionId(previous);
  };
  const next = [...future].reverse().find((id) => id !== workspace.session.id && visible.some((s) => s.id === id));
  const nextTitle = visible.find((s) => s.id === next)?.title;
  const goForward = () => {
    if (!next) return;
    setFuture((f) => f.slice(0, f.lastIndexOf(next)));
    setHistory((h) => [...h, workspace.session.id]);
    setSessionId(next);
  };

  return (
    <WorkspaceCtx.Provider value={workspace}>
      <div className={pinned ? 'app pinned' : 'app'} style={{ '--sidebar-w': `${sidebarWidth}px` } as React.CSSProperties}>
        <div className="sidebar-slot">
          <Sidebar
            pinned={pinned}
            peek={peek}
            onPin={(v) => {
              setPinned(v);
              setPeek(false);
            }}
            onPeek={setPeek}
            dirty={dirty}
            syncStatus={syncStatus}
            gitReady={!!settings.github}
            projects={(projects ?? []).filter((p) => !p.deleted)}
            onNew={(projectId) => void createSession(projectId).then((s) => workspace.openSession(s.id))}
            onNewProject={(name) => {
              const t = Date.now();
              const id = uid();
              void putProject({ id, name, createdAt: t, updatedAt: t });
              return id;
            }}
            onMoveSession={(id, projectId) => {
              const s = visible.find((x) => x.id === id);
              if (s) void putSession({ ...s, projectId });
            }}
            onDeleteProject={(id) => {
              const p = (projects ?? []).find((x) => x.id === id);
              if (p) void putProject({ ...p, deleted: true });
            }}
            onDelete={(id) => {
              const s = visible.find((x) => x.id === id);
              if (s) void putSession({ ...s, deleted: true });
            }}
            onPush={() => void runSync('push')}
            onSettings={() => setShowSettings(true)}
          />
        </div>
        {pinned && <Handle label="Resize sidebar" min={200} max={480} onChange={setSidebarWidth} />}
        <main className="main">
          <header className="topbar">
            <button className="btn menu" aria-expanded={peek} onClick={() => setPeek((v) => !v)}>
              Sessions
            </button>
            <IconButton
              icon="back"
              disabled={!previous}
              label={previous ? `Back to the previous session: “${previousTitle}”` : 'No previous session'}
              onClick={goBack}
            />
            <IconButton
              icon="forward"
              disabled={!next}
              label={next ? `Forward to the session you came back from: “${nextTitle}”` : 'No session to go forward to'}
              onClick={goForward}
            />
            <nav className="crumbs" aria-label="Chosen line">
              {workspace.trail.map((n, i) => (
                <span key={n.id} className="crumb">
                  {i > 0 && <span aria-hidden="true">/</span>}
                  <button className={workspace.focus?.id === n.id ? 'link current' : 'link'} onClick={() => workspace.select(n.id)}>
                    {i === 0 ? workspace.session.title : `“${n.title}”`}
                  </button>
                </span>
              ))}
            </nav>
          </header>
          <Columns />
        </main>
        <SelectionPopover />
        {showSettings && (
          <Settings
            onClose={() => setShowSettings(false)}
            onPull={() => void runSync('pull')}
            onPush={() => void runSync('push')}
            syncStatus={syncStatus}
          />
        )}
      </div>
    </WorkspaceCtx.Provider>
  );
}
