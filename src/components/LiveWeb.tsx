import { createElement, useEffect, useRef, useState } from 'react';
import { db, putNode, putSession } from '../db';
import type { TreeNode } from '../types';
import { addressOf } from './WebView';

/** Whether the interface runs in the desktop app, where a web panel is a real browser. */
export const isDesktop = typeof window !== 'undefined' && 'researchTreeDesktop' in window;

/** The part of an embedded browser this panel uses. */
interface Browser extends HTMLElement {
  loadURL(url: string): Promise<void>;
  getURL(): string;
  getTitle(): string;
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
}

const STARTS = [
  ['Claude', 'https://claude.ai/'],
  ['ChatGPT', 'https://chatgpt.com/'],
  ['Gemini', 'https://gemini.google.com/'],
  ['Google', 'https://www.google.com/'],
];

/** Words typed where an address goes are searched for. */
const destination = (typed: string) => {
  const text = typed.trim();
  return /^https?:\/\//i.test(text) || /^[^\s/]+\.[a-z]{2,}(\/\S*)?$/i.test(text) || /^localhost(:\d+)?/i.test(text) ? addressOf(text) : `https://www.google.com/search?q=${encodeURIComponent(text)}`;
};

/**
 * A real browser in a panel, in the desktop app: any site, signed in, with its scripts running.
 * The panel remembers the page it is on, and takes the page's title as its own.
 */
export function LiveWeb({ node }: { node: TreeNode }) {
  const view = useRef<Browser | null>(null);
  // The address the browser starts at. Later moves happen inside it and are only recorded.
  const [start] = useState(node.web?.url ?? '');
  const [begun, setBegun] = useState(!!start);
  const [typed, setTyped] = useState(start);
  const [, redraw] = useState(0);
  const latest = useRef(node);
  latest.current = node;

  useEffect(() => {
    const el = view.current;
    if (!el) return;
    const moved = () => {
      const url = el.getURL();
      setTyped(url);
      redraw((n) => n + 1);
      void record(url, undefined);
    };
    const named = (e: Event) => void record(el.getURL(), (e as Event & { title?: string }).title);
    // The node follows the browser: its address, and its title while it is still named after its page.
    const record = async (url: string, title?: string) => {
      const now = await db.nodes.get(latest.current.id);
      if (!now?.web || !/^https?:/.test(url)) return;
      const wasNamed = !now.title || now.title === 'Web page' || now.title === now.web.title || now.title === now.web.url;
      const nextTitle = title ?? (now.web.url === url ? now.web.title : undefined);
      if (now.web.url === url && now.web.title === nextTitle) return;
      const shown = wasNamed ? nextTitle ?? url : now.title;
      await putNode({ ...now, web: { url, title: nextTitle }, title: shown });
      if (wasNamed && !now.parentId) {
        const session = await db.sessions.filter((s) => s.rootNodeId === now.id && !s.deleted).first();
        if (session && session.title !== shown) await putSession({ ...session, title: shown });
      }
    };
    // Whether there is a page to go back or forward to is known once the page has settled.
    const settled = () => redraw((n) => n + 1);
    el.addEventListener('did-stop-loading', settled);
    el.addEventListener('did-navigate', moved);
    el.addEventListener('did-navigate-in-page', moved);
    el.addEventListener('page-title-updated', named);
    return () => {
      el.removeEventListener('did-stop-loading', settled);
      el.removeEventListener('did-navigate', moved);
      el.removeEventListener('did-navigate-in-page', moved);
      el.removeEventListener('page-title-updated', named);
    };
  }, [begun]);

  const go = (url: string) => {
    if (!url) return;
    setTyped(url);
    if (!begun) {
      void putNode({ ...latest.current, web: { url } });
      setBegun(true);
    } else void view.current?.loadURL(url);
  };
  const can = (what: 'canGoBack' | 'canGoForward') => {
    try {
      return !!view.current?.[what]();
    } catch {
      return false; // the browser is not ready yet
    }
  };

  return (
    <div className="live-web">
      <form
        className="web-bar"
        onSubmit={(e) => {
          e.preventDefault();
          go(destination(typed));
        }}
      >
        <button type="button" className="btn" disabled={!can('canGoBack')} title="Back" aria-label="Back" onClick={() => view.current?.goBack()}>‹</button>
        <button type="button" className="btn" disabled={!can('canGoForward')} title="Forward" aria-label="Forward" onClick={() => view.current?.goForward()}>›</button>
        <button type="button" className="btn" disabled={!begun} title="Reload" aria-label="Reload" onClick={() => view.current?.reload()}>⟳</button>
        <input aria-label="Address or search" value={typed} placeholder="Search, or type an address" spellCheck={false} autoCapitalize="off" autoFocus={!begun} onFocus={(e) => e.target.select()} onChange={(e) => setTyped(e.target.value)} />
      </form>
      {begun ? (
        // The browser's sign-ins are kept in a store of their own, shared by all web panels.
        createElement('webview', { ref: view, className: 'live-web-view', src: latest.current.web?.url || start, partition: 'persist:web', allowpopups: 'true' })
      ) : (
        <div className="live-web-start">
          <p className="hint">Type an address or a search above, or start from one of these.</p>
          <div className="field-row">
            {STARTS.map(([name, url]) => (
              <button key={url} type="button" className="btn" onClick={() => go(url)}>{name}</button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
