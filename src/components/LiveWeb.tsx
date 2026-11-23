import { createElement, useEffect, useRef, useState } from 'react';
import { db, putNode, putSession } from '../db';
import { WEB_KEY, type TreeNode } from '../types';
import type { Mark } from './MessageBody';
import { FRAME_SELECTION } from './SelectionPopover';
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
  executeJavaScript<T = unknown>(code: string): Promise<T>;
  /** Types text at the cursor, as the keyboard would. */
  insertText(text: string): Promise<void>;
}

/**
 * Put into each page shown: it reports the reader's selection and clicks on marks, and draws the
 * marks. Marks are painted over the text without changing the page itself, which a site that
 * redraws itself (a chat, say) would not survive; they are found again by their words whenever the
 * page changes. What it has to say goes out through the page's console, which the panel listens to.
 */
const IN_PAGE = `(() => {
  if (window.__rt) return;
  const rt = (window.__rt = { marks: [], ranges: [] });
  const say = (kind, data) => console.debug('__rt__' + JSON.stringify({ kind, ...data }));
  let selecting;
  document.addEventListener('selectionchange', () => {
    clearTimeout(selecting);
    selecting = setTimeout(() => {
      const sel = getSelection();
      const range = sel && !sel.isCollapsed && sel.rangeCount ? sel.getRangeAt(0) : null;
      const raw = range ? range.toString() : '';
      if (!range || !raw.trim()) return say('selection', { none: true });
      const before = document.createRange();
      before.selectNodeContents(document.body);
      before.setEnd(range.startContainer, range.startOffset);
      const start = before.toString().length + (raw.length - raw.trimStart().length);
      const box = range.getBoundingClientRect();
      say('selection', { start, end: start + raw.trim().length, quote: raw.trim(), x: box.left + box.width / 2, y: box.bottom });
    }, 200);
  });
  const style = document.createElement('style');
  document.documentElement.appendChild(style);
  const paint = () => {
    if (!window.CSS || !CSS.highlights) return;
    for (const name of [...CSS.highlights.keys()]) if (name.startsWith('rt-')) CSS.highlights.delete(name);
    rt.ranges = [];
    if (!rt.marks.length) return (style.textContent = '');
    const nodes = [];
    let all = '';
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      nodes.push({ n, at: all.length });
      all += n.data;
    }
    const place = (offset) => {
      let lo = 0;
      let hi = nodes.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (nodes[mid].at <= offset) lo = mid;
        else hi = mid - 1;
      }
      return [nodes[lo].n, Math.min(offset - nodes[lo].at, nodes[lo].n.data.length)];
    };
    let css = '';
    for (const mark of rt.marks) {
      // Near where it was first; failing that, anywhere its words are.
      let at = all.indexOf(mark.quote, Math.max(0, mark.start - 300));
      if (at < 0 || at > mark.start + 300) {
        const first = all.indexOf(mark.quote);
        if (first >= 0) at = first;
      }
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(...place(at));
      range.setEnd(...place(at + mark.quote.length));
      const name = 'rt-' + mark.id.replace(/[^a-zA-Z0-9]/g, '');
      CSS.highlights.set(name, new Highlight(range));
      css += '::highlight(' + name + '){background-color:' + mark.color + ';color:inherit;' + (mark.branch ? 'text-decoration:underline;text-decoration-color:#2f4ac6;text-decoration-thickness:2px;' : '') + '}';
      rt.ranges.push({ id: mark.id, branch: mark.branch, range });
    }
    style.textContent = css;
  };
  rt.draw = (marks) => {
    rt.marks = marks;
    paint();
  };
  let repaint;
  new MutationObserver(() => {
    clearTimeout(repaint);
    repaint = setTimeout(paint, 400);
  }).observe(document.body, { childList: true, subtree: true, characterData: true });
  document.addEventListener(
    'click',
    (e) => {
      if (!rt.ranges.length || !getSelection().isCollapsed) return;
      const spot = document.caretRangeFromPoint(e.clientX, e.clientY);
      if (!spot) return;
      for (const mark of rt.ranges) {
        if (!mark.range.isPointInRange(spot.startContainer, spot.startOffset)) continue;
        const box = mark.range.getBoundingClientRect();
        say('mark', { id: mark.id, branch: mark.branch, x: box.left, y: box.top, w: box.width, h: box.height });
        break;
      }
    },
    true,
  );
})()`;

/**
 * On the web agents' sites, folds away the list of past conversations when a page is first shown,
 * so the panel holds the conversation itself. It presses the site's own control, once the list has
 * appeared; the user can open the list again and it stays open.
 */
const AGENT_SITE = /^https:\/\/(claude\.ai|chatgpt\.com|chat\.openai\.com|gemini\.google\.com)\//;
const FOLD_LIST = `(() => {
  let tries = 0;
  const go = () => {
    const open = [...document.querySelectorAll('[data-testid="sidebar"], aside, mat-sidenav, nav')].find((el) => {
      const box = el.getBoundingClientRect();
      return box.width > 150 && box.width < 500 && box.x > -2 && box.x < 5 && box.height > 300;
    });
    const control =
      document.querySelector('button[aria-label="Hide sidebar"], button[aria-label="Close sidebar"], [data-testid="close-sidebar-button"]') ||
      (open && open.tagName === 'MAT-SIDENAV' ? document.querySelector('button[aria-label="Main menu"]') : null);
    if (open && control) return control.click();
    if (++tries < 14) setTimeout(go, 500);
  };
  go();
})()`;

/** The web agents a passage can be taken to. The passage is typed into the agent's box once its page is up. */
export const WEB_AGENTS: Record<string, { name: string; url: string }> = {
  claude: { name: 'Claude', url: 'https://claude.ai/new' },
  chatgpt: { name: 'ChatGPT', url: 'https://chatgpt.com/' },
  gemini: { name: 'Gemini', url: 'https://gemini.google.com/app' },
};
const AGENT_KEY = 'rt.webAgent';
export const webAgent = () => {
  const saved = localStorage.getItem(AGENT_KEY) ?? 'claude';
  return saved in WEB_AGENTS ? saved : 'claude';
};
export const setWebAgent = (id: string) => localStorage.setItem(AGENT_KEY, id);

// Text waiting to be put into an agent's box when its panel's page is up, by panel.
const openingText = new Map<string, string>();
/** Notes the text a new agent panel should start with. It is also put on the clipboard, in case the box cannot be filled. */
export function startWith(nodeId: string, text: string) {
  openingText.set(nodeId, text);
  void navigator.clipboard?.writeText(text).catch(() => undefined);
}
/** Puts the cursor in the page's message box, if it is there and empty, and says whether it did. */
const FOCUS_BOX = `(() => {
  const seen = (el) => el.getBoundingClientRect().width > 20 && el.getBoundingClientRect().height > 10;
  const box =
    [...document.querySelectorAll('div.ProseMirror[contenteditable="true"], rich-textarea .ql-editor, div[contenteditable="true"][role="textbox"], div[contenteditable="true"]')].find(seen) ||
    [...document.querySelectorAll('textarea')].find(seen);
  if (!box || (box.value ?? box.innerText).trim()) return false;
  box.focus();
  return true;
})()`;

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
interface Props {
  node: TreeNode;
  marks: Mark[];
  onOpen: (childId: string, at: DOMRect) => void;
  onHighlight: (id: string, at: DOMRect) => void;
}

export function LiveWeb({ node, marks, onOpen, onHighlight }: Props) {
  const view = useRef<Browser | null>(null);
  // The address the browser starts at. Later moves happen inside it and are only recorded.
  const [start] = useState(node.web?.url ?? '');
  const [begun, setBegun] = useState(!!start);
  const [typed, setTyped] = useState(start);
  const [, redraw] = useState(0);
  const latest = useRef(node);
  latest.current = node;
  // The marks belong to the page they were made on. With marks, the panel stays that page's even
  // when the browser moves on, and says so.
  const [away, setAway] = useState(false);
  const gone = useRef(false);
  const pageReady = useRef(false);
  const kept = marks.filter((m) => !m.hidden);
  const talk = useRef({ kept, onOpen, onHighlight });
  talk.current = { kept, onOpen, onHighlight };
  const drawn = kept.map((m) => `${m.id}:${m.start}:${m.color ?? m.tint ?? ''}`).join('|');
  const draw = () => {
    const list = talk.current.kept.map((m) => ({ id: m.id, start: m.start, quote: m.quote ?? '', color: m.color ?? m.tint ?? '#ffe58a', branch: !m.color })).filter((m) => m.quote);
    // The browser refuses outright until its first page is ready; the marks are drawn then.
    if (!pageReady.current) return;
    try {
      void view.current?.executeJavaScript(`window.__rt && window.__rt.draw(${JSON.stringify(list)})`).catch(() => undefined);
    } catch {
      // Not ready after all.
    }
  };
  useEffect(draw, [drawn]);

  useEffect(() => {
    const el = view.current;
    if (!el) return;
    const same = (a: string, b: string) => a.split('#')[0] === b.split('#')[0];
    const moved = () => {
      const url = el.getURL();
      setTyped(url);
      redraw((n) => n + 1);
      const home = latest.current.web?.url ?? '';
      // A panel with marks keeps the page they are on as its own.
      const left = talk.current.kept.length > 0 && !!home && !same(home, url);
      gone.current = left;
      setAway(left);
      if (!left) void record(url, undefined);
    };
    // Each page is given the script that reports selections and draws marks, then its marks.
    const ready = () => {
      pageReady.current = true;
      void el
        .executeJavaScript(IN_PAGE)
        .then(draw)
        .catch(() => undefined);
      if (AGENT_SITE.test(el.getURL())) void el.executeJavaScript(FOLD_LIST).catch(() => undefined);
      // A panel opened to ask about a passage starts with the passage in the agent's box, ready for the question.
      const opening = openingText.get(latest.current.id);
      if (opening && AGENT_SITE.test(el.getURL())) {
        openingText.delete(latest.current.id);
        // The box appears a moment after the page: it is looked for until found, then typed into, not sent.
        void (async () => {
          for (let tries = 0; tries < 24; tries++) {
            await new Promise((done) => setTimeout(done, 500));
            try {
              if (!(await el.executeJavaScript<boolean>(FOCUS_BOX))) continue;
              el.focus();
              await el.insertText(opening);
              return;
            } catch {
              return; // the page went away
            }
          }
        })();
      }
    };
    // The page's text is kept for the model: a conversation about this page is given it.
    const keepText = async () => {
      const url = latest.current.web?.url;
      if (!url || !same(url, el.getURL())) return;
      try {
        const text = await el.executeJavaScript<string>('document.body ? document.body.innerText.slice(0, 400000) : ""');
        if (text) await db.files.put({ fingerprint: `web:${url}`, data: new ArrayBuffer(0), text: [text] });
      } catch {
        // The page was gone before it could be read.
      }
    };
    const heard = (e: Event) => {
      const message = (e as Event & { message?: string }).message ?? '';
      if (!message.startsWith('__rt__')) return;
      const said = JSON.parse(message.slice(6));
      const at = el.getBoundingClientRect();
      if (said.kind === 'selection') {
        if (said.none) return void window.dispatchEvent(new CustomEvent(FRAME_SELECTION, { detail: null }));
        void keepText();
        window.dispatchEvent(
          new CustomEvent(FRAME_SELECTION, {
            detail: {
              nodeId: latest.current.id,
              messageId: WEB_KEY,
              start: said.start,
              end: said.end,
              quote: said.quote,
              x: Math.min(Math.max(at.x + said.x, 200), window.innerWidth - 200),
              y: Math.min(Math.max(at.y + said.y + 8, 60), window.innerHeight - 60),
              clear: () => void el.executeJavaScript('getSelection().removeAllRanges()').catch(() => undefined),
            },
          }),
        );
      }
      if (said.kind === 'mark') {
        const box = new DOMRect(at.x + said.x, at.y + said.y, said.w, said.h);
        if (said.branch) talk.current.onOpen(said.id, box);
        else talk.current.onHighlight(said.id, box);
      }
    };
    // A title belongs to the page shown, which is this panel's own page only while it has not been left.
    const named = (e: Event) => {
      if (!gone.current) void record(el.getURL(), (e as Event & { title?: string }).title);
    };
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
    const settled = () => {
      redraw((n) => n + 1);
      void keepText();
    };
    el.addEventListener('dom-ready', ready);
    el.addEventListener('console-message', heard);
    el.addEventListener('did-stop-loading', settled);
    el.addEventListener('did-navigate', moved);
    el.addEventListener('did-navigate-in-page', moved);
    el.addEventListener('page-title-updated', named);
    return () => {
      el.removeEventListener('did-stop-loading', settled);
      el.removeEventListener('dom-ready', ready);
      el.removeEventListener('console-message', heard);
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
      {away && (
        <div className="live-web-away" role="status">
          This panel's highlights are on another page.
          <button type="button" className="btn" onClick={() => void view.current?.loadURL(latest.current.web?.url ?? '')}>Back to that page</button>
        </div>
      )}
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
