import { useEffect, useRef, useState } from 'react';
import { db, putNode, putSession } from '../db';
import { fetchPage } from '../folder';
import { locate, pdfUrlOf } from '../text';
import { WEB_KEY, type TreeNode } from '../types';
import { useWorkspace } from '../workspace';
import { wrapRange, type Mark } from './MessageBody';
import { FRAME_SELECTION, readSelection } from './SelectionPopover';

/** An address as typed: a full one, or a bare site name. */
export function addressOf(typed: string): string {
  const text = typed.trim();
  if (!text || /^https?:\/\//i.test(text)) return text;
  return `${/^localhost(:\d+)?(\/|$)/i.test(text) ? 'http' : 'https'}://${text}`;
}

/** How marks look inside a page, whose own styles know nothing of them. */
const MARK_STYLE = `
mark[data-hl], mark[data-child] { background: #ffe58a; color: inherit; border-radius: 2px; cursor: pointer; }
mark[data-child].detached { background: none; border-bottom: 2px dashed #2f4ac6; border-radius: 0; }
mark[data-child].active { box-shadow: 0 0 0 2px #2f4ac6; }
mark[data-kind] { border-bottom: 2px solid rgba(22, 24, 29, 0.55); }
mark[data-kind='ask'] { border-bottom-color: #2f4ac6; }
html, body { height: auto !important; min-height: 0 !important; overflow: visible !important; }
`;

/**
 * A fetched page made ready to show as it looks on its site, but inert: its
 * own styles and pictures load from the site, nothing of it runs, and its
 * links open in the reader's real browser.
 */
export function framedPage(html: string, url: string): { doc: string; title: string } {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const title = doc.querySelector('title')?.textContent?.trim() || url;
  doc.querySelectorAll('script, iframe, frame, object, embed, base, meta[http-equiv], link[rel~="preload"], link[rel~="modulepreload"], link[rel~="prefetch"]').forEach((el) => el.remove());
  for (const el of doc.querySelectorAll('*')) {
    for (const attr of [...el.attributes]) if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
  }
  // Pictures that a script would have filled in later keep their address in another attribute.
  doc.querySelectorAll('img').forEach((img) => {
    const late = img.getAttribute('data-src') ?? img.getAttribute('data-lazy-src');
    if (late && (!img.getAttribute('src') || img.getAttribute('src')!.startsWith('data:'))) img.setAttribute('src', late);
    img.setAttribute('referrerpolicy', 'no-referrer');
  });
  const base = doc.createElement('base');
  base.href = url;
  base.target = '_blank';
  doc.head.prepend(base);
  const style = doc.createElement('style');
  style.textContent = MARK_STYLE;
  doc.head.append(style);
  return { doc: `<!doctype html>${doc.documentElement.outerHTML}`, title };
}

// Pages already fetched in this tab, so that coming back to one is instant.
const seen = new Map<string, { doc: string; title: string; url: string }>();

interface Props {
  node: TreeNode;
  marks: Mark[];
  onOpen: (childId: string, at: DOMRect) => void;
  onHighlight: (id: string, at: DOMRect) => void;
  onHover: (id: string | null, at?: DOMRect) => void;
}

/**
 * A web page to read, shown as it looks on its site. It can be highlighted,
 * annotated and asked about like a PDF. A link is followed in the panel, with
 * back and forward; once the page has marks it stays, and a link opens as a
 * branch from it. A link to a PDF opens in the PDF reader.
 */
export function WebView({ node, marks, onOpen, onHighlight, onHover }: Props) {
  const ws = useWorkspace();
  const url = node.web?.url ?? '';
  const [typed, setTyped] = useState('');
  const [page, setPage] = useState(url ? seen.get(url) ?? null : null);
  const [status, setStatus] = useState('');
  const frame = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(0);
  // The pick last followed, so that each is followed once.
  const followed = useRef(-1);
  // Read by the frame's listeners, which are set once per page.
  // The pages gone through in this panel by following links, for its back and forward.
  const trail = useRef<{ list: string[]; at: number }>({ list: url ? [url] : [], at: 0 });
  const [, redraw] = useState(0);
  /** Shows another page in this panel. */
  const show = async (next: string, record = true) => {
    const t = trail.current;
    // The page this panel started on is the first step, even if it was given after the panel opened.
    if (!t.list.length && url) t.list = [url];
    if (record) {
      t.list = [...t.list.slice(0, t.at + 1), next];
      t.at = t.list.length - 1;
    }
    redraw((n) => n + 1);
    const now = await db.nodes.get(node.id);
    if (!now) return;
    // A panel named after its page is renamed with it; until the new page's title is known, by its address.
    const named = !now.title || now.title === 'Web page' || now.title === now.web?.title || now.title === now.web?.url;
    await putNode({ ...now, web: { url: next }, title: named ? next : now.title });
    if (named && !now.parentId) {
      const session = await db.sessions.filter((x) => x.rootNodeId === now.id && !x.deleted).first();
      if (session) await putSession({ ...session, title: next });
    }
  };
  /**
   * Follows a link. A page with nothing marked on it is replaced in place. A page with marks stays:
   * the linked page opens as a branch from the link, or, if this session already has it, is gone to.
   */
  const follow = (next: string, link?: { start: number; end: number; quote: string }) => {
    const there = [...ws.idx.byId.values()].find((n) => n.id !== node.id && n.web?.url === next && (n.parentId === node.id || n.id === node.parentId));
    if (there) return ws.select(there.id, { focus: true });
    if (!marks.length) return void show(next);
    if (link) return void ws.branch(node.id, WEB_KEY, link.start, link.end, link.quote, { web: { url: next } });
    window.open(next, '_blank', 'noopener');
  };
  const parent = node.parentId ? ws.idx.byId.get(node.parentId) : undefined;
  const step = (by: number) => {
    const t = trail.current;
    const at = t.at + by;
    // Back from the first page of a branch is the page it was opened from.
    if (at < 0 && parent?.web) return ws.select(parent.id, { focus: true });
    if (at < 0 || at >= t.list.length) return;
    t.at = at;
    void show(t.list[at], false);
  };
  const handlers = useRef({ onOpen, onHighlight, onHover, ws, node, follow });
  handlers.current = { onOpen, onHighlight, onHover, ws, node, follow };

  useEffect(() => {
    if (!url) return;
    const known = seen.get(url);
    if (known) {
      setPage(known);
      setStatus('');
      return;
    }
    let live = true;
    setPage(null);
    setStatus('Loading…');
    void (async () => {
      try {
        const got = await fetchPage(url);
        if (!live) return;
        if (got.kind === 'pdf') {
          // A PDF is read in the PDF reader: this panel becomes one.
          const now = await db.nodes.get(node.id);
          if (now) await putNode({ ...now, web: undefined, title: got.url, doc: { fingerprint: '', title: got.url, url: got.url, pages: 0 } });
          return;
        }
        if (got.kind !== 'html' && got.kind !== 'text') {
          setStatus(got.kind === 'error' ? `This page could not be opened: ${got.error}` : `This address holds ${got.type || 'a file'}, which cannot be shown here.`);
          return;
        }
        const source = got.kind === 'text' ? `<pre>${(got.html ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>` : got.html ?? '';
        const made = { ...framedPage(source, got.url), url: got.url };
        seen.set(url, made);
        seen.set(got.url, made);
        setPage(made);
        setStatus('');
        // The node takes the page's real address (after any redirect) and its title.
        const now = await db.nodes.get(node.id);
        if (now?.web && (now.web.url !== got.url || now.web.title !== made.title)) {
          const named = !now.title || now.title === 'Web page' || now.title === 'Browser' || now.title === now.web.title || now.title === now.web.url;
          await putNode({ ...now, web: { url: got.url, title: made.title }, title: named ? made.title : now.title });
          if (named && !now.parentId) {
            const session = await db.sessions.filter((s) => s.rootNodeId === now.id && !s.deleted).first();
            if (session) await putSession({ ...session, title: made.title });
          }
        }
      } catch (e) {
        if (live) setStatus(`This page could not be opened: ${e instanceof Error ? e.message : String(e)}`);
      }
    })();
    return () => {
      live = false;
    };
  }, [url, node.id]);

  // Once the page is in the frame: make its text markable, and listen to it.
  const onLoad = () => {
    const el = frame.current;
    const doc = el?.contentDocument;
    if (!el || !doc?.body) return;
    const body = doc.body;
    body.dataset.nodeId = node.id;
    body.dataset.msgId = WEB_KEY;
    // The frame is as tall as its page, so the panel scrolls it and nothing scrolls inside.
    const fit = () => {
      el.style.height = `${Math.max(doc.documentElement.scrollHeight, body.scrollHeight, 200)}px`;
    };
    fit();
    new ResizeObserver(fit).observe(body);
    const shifted = (rect: DOMRect) => {
      const at = el.getBoundingClientRect();
      return new DOMRect(rect.x + at.x, rect.y + at.y, rect.width, rect.height);
    };
    let timer = 0;
    doc.addEventListener('selectionchange', () => {
      clearTimeout(timer);
      timer = window.setTimeout(() => {
        const at = el.getBoundingClientRect();
        window.dispatchEvent(new CustomEvent(FRAME_SELECTION, { detail: readSelection(doc, { x: at.x, y: at.y }) }));
      }, 150);
    });
    const markOf = (t: EventTarget | null) => (t as Element | null)?.closest?.<HTMLElement>('mark[data-hl], mark[data-child]') ?? null;
    doc.addEventListener('click', (e) => {
      const h = handlers.current;
      const mark = markOf(e.target);
      if (mark) {
        e.preventDefault();
        if (mark.dataset.child) h.onOpen(mark.dataset.child, shifted(mark.getBoundingClientRect()));
        else if (mark.dataset.hl) h.onHighlight(mark.dataset.hl, shifted(mark.getBoundingClientRect()));
        return;
      }
      const link = (e.target as Element | null)?.closest?.<HTMLAnchorElement>('a[href]');
      if (!link) return;
      const here = (h.node.web?.url ?? '').split('#')[0];
      // A link to another place on this page: moved to by hand, since the frame's address is not the page's.
      if (link.href.split('#')[0] === here && link.hash) {
        e.preventDefault();
        const target = doc.getElementById(decodeURIComponent(link.hash.slice(1))) ?? doc.getElementsByName(link.hash.slice(1))[0];
        target?.scrollIntoView({ block: 'start' });
        return;
      }
      // A link to a PDF opens in the PDF reader, as a branch from the link.
      const pdf = pdfUrlOf(link.href) ?? (/\.pdf($|[?#])/i.test(link.href) ? link.href : null);
      const quote = link.textContent ?? '';
      if (pdf && quote.trim()) {
        e.preventDefault();
        const there = [...h.ws.idx.byId.values()].find((n) => n.parentId === h.node.id && n.doc?.url === pdf);
        if (there) return h.ws.select(there.id, { focus: true });
        const before = doc.createRange();
        before.selectNodeContents(body);
        before.setEndBefore(link);
        const start = before.toString().length;
        void h.ws.branch(h.node.id, WEB_KEY, start, start + quote.length, quote, { doc: { fingerprint: '', title: quote.trim() || pdf, url: pdf, pages: 0 } });
      }
      // Any other link is followed here. With Cmd, Ctrl or Shift held it opens in the reader's own browser, as the page's base says.
      if (pdf || e.metaKey || e.ctrlKey || e.shiftKey || !/^https?:/.test(link.href)) return;
      e.preventDefault();
      const before = doc.createRange();
      before.selectNodeContents(body);
      before.setEndBefore(link);
      const start = before.toString().length;
      h.follow(link.href.split('#')[0] === here ? link.href : link.href, quote.trim() ? { start, end: start + quote.length, quote } : undefined);
    });
    doc.addEventListener('mouseover', (e) => {
      const mark = markOf(e.target);
      if (mark && !mark.classList.contains('detached')) handlers.current.onHover((mark.dataset.hl ?? mark.dataset.child)!, shifted(mark.getBoundingClientRect()));
    });
    doc.addEventListener('mouseout', (e) => {
      if (markOf(e.target)) handlers.current.onHover(null);
    });
    // Kept for the model: a conversation about this page is given its text.
    const text = (body.innerText || body.textContent || '').replace(/\n\s*\n\s*/g, '\n\n').trim();
    if (url) void db.files.put({ fingerprint: `web:${url}`, data: new ArrayBuffer(0), text: [text.slice(0, 400000)] });
    if (text.length < 200) setStatus('Little could be read from this page. It may need a sign-in, or build itself with scripts, which this reader does not run.');
    setReady((n) => n + 1);
  };

  // Marks are put into the page's text, and redone whenever they change.
  const marksKey = marks.map((m) => `${m.id}:${m.start}:${m.end}:${m.active}:${!!m.hidden}:${m.color ?? ''}:${m.tint ?? ''}:${m.kind ?? ''}`).join('|');
  useEffect(() => {
    const body = frame.current?.contentDocument?.body;
    if (!body || !ready) return;
    for (const old of body.querySelectorAll('mark[data-hl], mark[data-child]')) {
      old.querySelectorAll('i.badge').forEach((badge) => badge.remove());
      old.replaceWith(...old.childNodes);
    }
    body.normalize();
    const all = body.textContent ?? '';
    for (const m of marks) {
      // The page may have changed since it was marked: the passage is looked up again by its words.
      const found = m.quote ? locate(all, m.start, m.end, m.quote) : ([m.start, m.end] as const);
      if (found) wrapRange(body, { ...m, start: found[0], end: found[1] });
    }
    // The passage of a branch picked on purpose is brought into view: once per pick, and only if it
    // is not on screen already, so that marking a passage never moves the page under the reader.
    const el = frame.current;
    const scroller = el?.closest<HTMLElement>('.pane-scroll');
    const pick = ws.picked;
    if (!el || !scroller || !pick || pick.n === followed.current || Date.now() - pick.at > 2000) return;
    const mark = body.querySelector<HTMLElement>(`mark[data-child="${pick.id}"]`);
    if (!mark) return;
    followed.current = pick.n;
    const box = scroller.getBoundingClientRect();
    const top = el.getBoundingClientRect().top + mark.getBoundingClientRect().top;
    const bottom = top + mark.getBoundingClientRect().height;
    if (top >= box.top + 8 && bottom <= box.bottom - 8) return;
    scroller.scrollTo({ top: scroller.scrollTop + top - box.top - scroller.clientHeight / 3, behavior: 'auto' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marksKey, ready, ws.picked?.n]);

  return (
    <div className="web">
      {url ? (
        <div className="web-bar">
          <button type="button" className="btn" disabled={trail.current.at <= 0 && !parent?.web} title="Back" aria-label="Back" onClick={() => step(-1)}>‹</button>
          <button type="button" className="btn" disabled={trail.current.at >= trail.current.list.length - 1} title="Forward" aria-label="Forward" onClick={() => step(1)}>›</button>
          <a href={url} target="_blank" rel="noopener noreferrer" title="Open this page in your browser">{url}</a>
        </div>
      ) : (
        <form
          className="web-bar"
          onSubmit={(e) => {
            e.preventDefault();
            const next = addressOf(typed);
            if (next) void putNode({ ...node, web: { url: next } });
          }}
        >
          <input aria-label="Address" value={typed} placeholder="Address of the page to read" spellCheck={false} autoCapitalize="off" autoFocus onChange={(e) => setTyped(e.target.value)} />
          <button type="submit" className="btn primary">Open</button>
        </form>
      )}
      {status && <div className="hint" role="status">{status}</div>}
      {page && (
        <iframe
          ref={frame}
          className="web-frame"
          title={page.title}
          // Nothing in the page may run. Its links may open new tabs, which behave as ordinary ones.
          sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
          srcDoc={page.doc}
          onLoad={onLoad}
        />
      )}
    </div>
  );
}
