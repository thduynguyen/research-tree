import { useLiveQuery } from 'dexie-react-hooks';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createSession, db, putHighlight, putNode, putProject, putSession, removeBranches, uid } from '../db';
import { getSettings, useSettings } from '../settings';
import { connectToHost, openInVsCode, gitSave, gitState, hasFolder, syncFolder, type GitState } from '../folder';
import { pull, push } from '../sync';
import { pdfUrlOf } from '../text';
import { buildIndex, pathFrom, shorten } from '../tree';
import type { TreeNode } from '../types';
import { MAX_PINNED, WorkspaceCtx, freshNotes, choosePath, resolveView, type View, type Workspace } from '../workspace';
import { Columns } from './Columns';
import { OpenCode } from './OpenCode';
import { OpenPdf } from './OpenPdf';
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

/** Whether this tab is the one on screen. */
function usePageShown(): boolean {
  const [shown, setShown] = useState(() => document.visibilityState === 'visible');
  useEffect(() => {
    const update = () => setShown(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  return shown;
}

/**
 * A live view of a table while `active`; while not, the last value seen, with
 * no database access at all. It catches up as soon as it is active again.
 */
function useTable<T>(read: () => Promise<T>, active: boolean): T | undefined {
  const last = useRef<T | undefined>(undefined);
  const value = useLiveQuery(() => (active ? read() : last.current), [active]);
  if (value !== undefined) last.current = value;
  return value ?? last.current;
}

export function App() {
  // A tab that is not on screen reads nothing from the database. The browser
  // slows such tabs right down, and a read left half-finished there holds a
  // lock that stalls every save and delete in the tab being used.
  const shown = usePageShown();
  const sessions = useTable(() => db.sessions.toArray(), shown);
  const projects = useTable(() => db.projects.toArray(), shown);
  const nodes = useTable(() => db.nodes.toArray(), shown);
  const messages = useTable(() => db.messages.toArray(), shown);
  const highlights = useTable(() => db.highlights.toArray(), shown);
  const dirty = useTable(() => db.meta.get('dirty').then((row) => row?.value === true), shown) === true;
  const settings = useSettings();

  const [sessionId, setSessionId] = useState<string | null>(() => localStorage.getItem(SESSION_KEY));
  // Sessions visited before the current one, most recent last, for the back button.
  const [history, setHistory] = useState<string[]>([]);
  // Sessions stepped back from, nearest last, for the forward button. Going somewhere new clears it.
  const [future, setFuture] = useState<string[]>([]);
  const [views, setViews] = useState<Record<string, Partial<View>>>(() => loadJson(VIEWS_KEY, {}));
  const [focus, setFocus] = useState<{ id: string; n: number } | null>(null);
  const [picked, setPicked] = useState<{ id: string; n: number; at: number } | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  // Open while choosing a PDF for a new session; holds the project it will be filed under.
  const [openingPdf, setOpeningPdf] = useState<{ projectId?: string } | null>(null);
  const [openingCode, setOpeningCode] = useState<{ projectId?: string } | null>(null);
  const [pinned, setPinned] = useState(() => loadJson(PIN_KEY, true));
  const [peek, setPeek] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(() => loadJson(SIDEBAR_KEY, 264));
  const [syncStatus, setSyncStatus] = useState('');

  const idx = useMemo(() => buildIndex(nodes ?? [], messages ?? [], highlights ?? []), [nodes, messages, highlights]);
  const visible = useMemo(() => (sessions ?? []).filter((s) => !s.deleted && idx.byId.has(s.rootNodeId)), [sessions, idx]);
  const session = visible.find((s) => s.id === sessionId) ?? [...visible].sort((a, b) => b.updatedAt - a.updatedAt)[0];

  // First run, or the last session was deleted: there is always one to work in.
  const creating = useRef(false);
  useEffect(() => {
    if (!sessions || !nodes || session || creating.current) return;
    creating.current = true;
    void (async () => {
      // An empty browser may still have sessions waiting in the folder of a local server: look there first.
      if (sessions.length === 0) {
        await connectToHost();
        if (hasFolder()) await syncFolder().catch(() => undefined);
        if (await db.sessions.filter((s) => !s.deleted).count()) {
          creating.current = false;
          return;
        }
      }
      const s = await createSession();
      setSessionId(s.id);
      creating.current = false;
    })();
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

  // Served by a local server that pairs with the app: connect to it, once, with nothing to type.
  useEffect(() => {
    void connectToHost();
  }, []);

  // With a local server that keeps a folder, every change is written there shortly after it is made.
  const folder = !!settings.custom?.folder;
  const unsaved = useTable(() => db.meta.get('unsaved').then((row) => row?.value === true), shown) === true;
  const [git, setGit] = useState<GitState | null>(null);
  const [folderStatus, setFolderStatus] = useState('');
  const saveToFolder = useCallback(async () => {
    try {
      await syncFolder();
      setGit(await gitState());
      setFolderStatus('');
    } catch (e) {
      setFolderStatus(`Not saved to the folder: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);
  useEffect(() => {
    if (folder && shown) void saveToFolder();
  }, [folder, shown, saveToFolder]);
  useEffect(() => {
    if (!folder || !shown || !unsaved) return;
    const timer = setTimeout(() => void saveToFolder(), 2000);
    return () => clearTimeout(timer);
  }, [folder, shown, unsaved, saveToFolder]);
  const commitFolder = useCallback(async () => {
    setFolderStatus('Committing…');
    try {
      await syncFolder();
      const state = await gitSave();
      setGit(state);
      const did = (state.done ?? []).join(' and ');
      setFolderStatus(did ? `${did[0].toUpperCase()}${did.slice(1)} at ${new Date().toLocaleTimeString()}.` : 'Nothing new to commit.');
    } catch (e) {
      setFolderStatus(`Commit failed: ${e instanceof Error ? e.message : String(e)}`);
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
      picked,
      home,
      select(nodeId, opts) {
        const ids = idsTo(nodeId);
        if (!ids.length) return;
        setView((cur) => choosePath(cur, ids));
        if (opts?.focus !== false) ask(nodeId);
        if (opts?.follow !== false) setPicked((p) => ({ id: nodeId, n: (p?.n ?? 0) + 1, at: Date.now() }));
      },
      toggleMinimized: (nodeId) =>
        setView((cur) => ({
          ...cur,
          minimized: cur.minimized.includes(nodeId) ? cur.minimized.filter((id) => id !== nodeId) : [...cur.minimized, nodeId],
          // Minimizing closes its branches too.
          expanded: cur.expanded.filter((id) => id !== nodeId),
        })),
      toggleExpanded: (nodeId) =>
        setView((cur) => {
          if (cur.expanded.includes(nodeId)) return { ...cur, expanded: cur.expanded.filter((id) => id !== nodeId) };
          // Opening a branch's subtree puts the line through it, and un-minimizes it.
          const next = choosePath(cur, idsTo(nodeId));
          return { ...next, expanded: [...next.expanded, nodeId], minimized: next.minimized.filter((id) => id !== nodeId) };
        }),
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
      async branch(nodeId, messageId, start, end, quote, extra) {
        const t = Date.now();
        const node: TreeNode = {
          id: uid(),
          parentId: nodeId,
          anchor: { messageId, start, end, quote, color: extra?.color },
          title: extra?.doc ? extra.doc.title : shorten(quote),
          doc: extra?.doc,
          web: extra?.web,
          note: extra?.note ? '' : undefined,
          createdAt: t,
          updatedAt: t,
        };
        if (extra?.note) freshNotes.add(node.id);
        await putNode(node);
        const ids = [...idsTo(nodeId), node.id];
        setView((cur) => choosePath(cur, ids));
        ask(node.id);
      },
      async highlight(nodeId, messageId, start, end, quote, color) {
        const t = Date.now();
        await putHighlight({ id: uid(), nodeId, messageId, start, end, quote, color, createdAt: t, updatedAt: t });
      },
      async setNote(nodeId, text) {
        const node = idx.byId.get(nodeId);
        if (node && node.note !== text) await putNode({ ...node, note: text });
      },
      async setAccess(nodeId, access) {
        const node = await db.nodes.get(nodeId);
        if (node) await putNode({ ...node, access });
      },
      async setScope(nodeId, scope) {
        const node = idx.byId.get(nodeId);
        if (node) await putNode({ ...node, scope });
      },
      async setColor(nodeId, color) {
        const node = idx.byId.get(nodeId);
        if (node?.anchor) await putNode({ ...node, anchor: { ...node.anchor, color } });
      },
      async updateHighlight(id, patch) {
        const found = (highlights ?? []).find((h) => h.id === id);
        if (found) await putHighlight({ ...found, ...patch });
      },
      async setDoc(nodeId, doc) {
        const node = idx.byId.get(nodeId);
        if (!node) return;
        // The node was named after its link or file until the PDF gave its real title.
        const rename = node.title === node.doc?.title;
        await putNode({ ...node, doc, title: rename ? doc.title : node.title });
        if (!rename) return;
        for (const s of sessions ?? []) {
          if (s.rootNodeId === nodeId && s.title === node.title) await putSession({ ...s, title: doc.title });
        }
      },
      async remove(nodeId) {
        if (nodeId === rootId) return;
        // If the line ran through it, move the line to the branch next to it, not back to the first one.
        const parentId = idx.byId.get(nodeId)?.parentId;
        const siblings = parentId ? idx.childrenOf.get(parentId) ?? [] : [];
        const at = siblings.findIndex((n) => n.id === nodeId);
        const neighbour = siblings[at + 1] ?? siblings[at - 1];
        if (parentId && neighbour && trail.some((n) => n.id === nodeId)) {
          setView((cur) => ({ ...cur, choice: { ...cur.choice, [parentId]: neighbour.id } }));
        }
        // Everything under it goes too, including branches that were moved out to their own sessions.
        const ids = [nodeId];
        for (let i = 0; i < ids.length; i++) {
          for (const n of nodes ?? []) if (n.parentId === ids[i] && !n.deleted) ids.push(n.id);
        }
        await removeBranches(ids);
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
  }, [session, sessions, nodes, visible, highlights, idx, views, focus, picked]);

  // A page sent from the reader's browser ("?open=<address>") opens as a session: a PDF in the PDF
  // reader, anything else as a web page to read.
  const sent = useRef(false);
  useEffect(() => {
    if (!workspace || sent.current) return;
    const address = new URLSearchParams(location.search).get('open');
    if (!address) return;
    sent.current = true;
    window.history.replaceState(null, '', location.pathname);
    if (!/^https?:\/\//i.test(address)) return;
    const pdf = pdfUrlOf(address) ?? (/\.pdf($|[?#])/i.test(address) ? address : null);
    void createSession(session?.projectId, pdf ? { fingerprint: '', title: pdf, url: pdf, pages: 0 } : undefined, pdf ? undefined : { title: 'Web page', web: { url: address } }).then((s) =>
      workspace.openSession(s.id),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace]);


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
            dirty={folder ? !!git && git.changed + git.ahead > 0 : dirty}
            syncStatus={folder ? folderStatus || (git ? `Saved in ${git.workspace.replace(/^\/(Users|home)\/[^/]+/, '~')}.${git.changed ? ` ${git.changed} files not committed.` : git.ahead ? ' Not pushed yet.' : ''}` : 'Saving to the folder…') : syncStatus}
            gitReady={folder || !!settings.github}
            pushLabel={folder ? (git?.remote === false ? 'Commit' : 'Commit and push') : 'Push to git'}
            projects={(projects ?? []).filter((p) => !p.deleted)}
            onNew={(projectId) => void createSession(projectId).then((s) => workspace.openSession(s.id))}
            onOpenPdf={(projectId) => setOpeningPdf({ projectId })}
            onBrowser={folder ? (projectId) => void createSession(projectId, undefined, { title: 'Web page', web: { url: '' } }).then((s) => workspace.openSession(s.id)) : undefined}
            onVsCode={folder ? (projectId) => void openInVsCode((projects ?? []).find((p) => p.id === projectId && !p.deleted)?.name ?? 'Inbox').catch((e) => setFolderStatus(String(e instanceof Error ? e.message : e))) : undefined}
            onCode={folder ? (projectId) => setOpeningCode({ projectId }) : undefined}
            onTerminal={folder ? (projectId) => void createSession(projectId, undefined, { title: 'Terminal', terminal: '' }).then((s) => workspace.openSession(s.id)) : undefined}
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
            onRename={(id, title) => {
              const s = visible.find((x) => x.id === id);
              if (!s) return;
              // The root panel shows the session's title, so its node is renamed with it.
              const rootNode = idx.byId.get(s.rootNodeId);
              if (rootNode && rootNode.title === s.title) void putNode({ ...rootNode, title });
              void putSession({ ...s, title });
            }}
            onDeleteProject={(id) => {
              const p = (projects ?? []).find((x) => x.id === id);
              if (p) void putProject({ ...p, deleted: true });
            }}
            onDelete={(id) => {
              const s = visible.find((x) => x.id === id);
              if (s) void putSession({ ...s, deleted: true });
            }}
            onPush={() => void (folder ? commitFolder() : runSync('push'))}
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
        {openingCode && (
          <OpenCode
            projectId={openingCode.projectId}
            onClose={() => setOpeningCode(null)}
            onOpen={(id) => {
              setOpeningCode(null);
              workspace.openSession(id);
            }}
          />
        )}
        {openingPdf && (
          <OpenPdf
            folder={folder ? (projects ?? []).find((p) => p.id === openingPdf.projectId && !p.deleted)?.name ?? 'Inbox' : undefined}
            onClose={() => setOpeningPdf(null)}
            onOpen={(doc) => {
              setOpeningPdf(null);
              void createSession(openingPdf.projectId, doc).then((s) => workspace.openSession(s.id));
            }}
          />
        )}
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
