import DOMPurify from 'dompurify';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createSession, db, putNode, putSession } from '../db';
import { fetchPage, projectIdOf, type FetchedPage } from '../folder';
import { pdfUrlOf } from '../text';
import { WEB_KEY, type TreeNode } from '../types';
import { useWorkspace } from '../workspace';
import { MessageBody, type Mark } from './MessageBody';

/** Where a search typed into the address bar goes: an engine whose results can be read without running its scripts. */
const SEARCH = 'https://search.brave.com/search?q=';

/** An address as typed: a full one, a bare site name, or words to search for. */
export function addressOf(typed: string): string {
  const text = typed.trim();
  if (/^https?:\/\//i.test(text)) return text;
  if (/^[^\s/]+\.[a-z]{2,}(\/\S*)?$/i.test(text) || /^localhost(:\d+)?(\/\S*)?$/i.test(text)) return `${text.startsWith('localhost') ? 'http' : 'https'}://${text}`;
  return SEARCH + encodeURIComponent(text);
}

interface Cleaned {
  url: string;
  title: string;
  html: string;
  text: string;
}

/**
 * Reduces a fetched page to what is read: its main content, with links and
 * images pointing at the real site, and nothing that runs or styles.
 */
export function cleanPage(page: FetchedPage): Cleaned {
  const base = page.url;
  if (page.kind === 'text') {
    const text = page.html ?? '';
    return { url: base, title: base, text, html: `<pre>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>` };
  }
  const doc = new DOMParser().parseFromString(page.html ?? '', 'text/html');
  const title = doc.querySelector('title')?.textContent?.trim() || base;
  doc.querySelectorAll('script, style, noscript, iframe, template, link, meta, svg, canvas, form, input, button, select, textarea, dialog').forEach((el) => el.remove());
  // The article itself, when the page marks one that holds most of its text; otherwise everything.
  const all = doc.body?.textContent?.length ?? 0;
  const main = [...doc.querySelectorAll<HTMLElement>('main, article, [role="main"]')].sort((a, b) => (b.textContent?.length ?? 0) - (a.textContent?.length ?? 0))[0];
  const root = main && (main.textContent?.length ?? 0) > Math.max(400, all * 0.4) ? main : doc.body;
  if (!root) return { url: base, title, html: '', text: '' };
  root.querySelectorAll('nav, [aria-hidden="true"], [hidden]').forEach((el) => el.remove());

  const absolute = (value: string | null) => {
    try {
      return value ? new URL(value, base).href : null;
    } catch {
      return null;
    }
  };
  root.querySelectorAll('a[href]').forEach((a) => {
    const href = absolute(a.getAttribute('href'));
    if (href && /^https?:/.test(href)) a.setAttribute('href', href);
    else a.removeAttribute('href');
  });
  root.querySelectorAll('img').forEach((img) => {
    // Pages that load pictures late keep the real address in another attribute.
    const src = absolute(img.getAttribute('src')) ?? absolute(img.getAttribute('data-src')) ?? absolute(img.getAttribute('data-lazy-src'));
    if (src && /^https?:/.test(src) && !src.includes('data:image/gif')) img.setAttribute('src', src);
    else img.remove();
    img.setAttribute('loading', 'lazy');
    img.setAttribute('referrerpolicy', 'no-referrer');
  });
  const html = DOMPurify.sanitize(root.innerHTML, {
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'iframe', 'object', 'embed', 'video', 'audio', 'source', 'picture'],
    FORBID_ATTR: ['style', 'class', 'id', 'srcset', 'sizes', 'width', 'height', 'onclick'],
  });
  const holder = document.createElement('div');
  holder.innerHTML = html;
  return { url: base, title, html, text: (holder.textContent ?? '').replace(/\n\s*\n\s*/g, '\n\n').trim() };
}

// Pages already read in this tab, so that coming back to one is instant and keeps its text in place.
const seen = new Map<string, Cleaned>();

interface Props {
  node: TreeNode;
  marks: Mark[];
  onOpen: (childId: string, at: DOMRect) => void;
  onHighlight: (id: string, at: DOMRect) => void;
  onHover: (id: string | null, at?: DOMRect) => void;
}

/**
 * A web page read inside a panel. Following a link changes the page in place
 * while nothing on it is marked. Once it has highlights, notes or
 * conversations it stays, and a link opens the next page as a branch from it.
 */
export function WebView({ node, marks, onOpen, onHighlight, onHover }: Props) {
  const ws = useWorkspace();
  const url = node.web?.url ?? '';
  const [typed, setTyped] = useState(url);
  const [page, setPage] = useState<Cleaned | null>(url ? seen.get(url) ?? null : null);
  const [status, setStatus] = useState('');
  // The pages gone through in this panel while it held nothing marked, for its own back and forward.
  const trail = useRef<{ list: string[]; at: number }>({ list: url ? [url] : [], at: 0 });
  const kept = marks.length > 0;

  useEffect(() => setTyped(url), [url]);

  useEffect(() => {
    if (!url) return;
    const ready = seen.get(url);
    if (ready) {
      setPage(ready);
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
        if (got.kind === 'error' || got.kind === 'other') {
          setStatus(got.kind === 'error' ? `This page could not be opened: ${got.error}` : `This address holds ${got.type || 'a file'}, which cannot be shown here.`);
          return;
        }
        const clean = cleanPage(got);
        seen.set(url, clean);
        seen.set(clean.url, clean);
        // Kept for the model: a conversation about this page is given its text.
        await db.files.put({ fingerprint: `web:${clean.url}`, data: new ArrayBuffer(0), text: [clean.text.slice(0, 400000)] });
        setPage(clean);
        setStatus(clean.text.length < 200 ? 'Little could be read from this page. It may need a sign-in, or build itself with scripts, which this reader does not run.' : '');
        // The node takes the page's real address (after any redirect) and its title.
        const now = await db.nodes.get(node.id);
        if (now?.web && (now.web.url !== clean.url || now.web.title !== clean.title)) {
          const named = !now.title || now.title === 'Browser' || now.title === now.web.title || now.title === now.web.url;
          await putNode({ ...now, web: { url: clean.url, title: clean.title }, title: named ? clean.title : now.title });
          if (named && !now.parentId) {
            const session = await db.sessions.filter((s) => s.rootNodeId === now.id && !s.deleted).first();
            if (session) await putSession({ ...session, title: clean.title });
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

  /** Shows another page in this panel, which holds nothing marked. */
  const show = async (next: string, record = true) => {
    if (record) {
      const t = trail.current;
      t.list = [...t.list.slice(0, t.at + 1), next];
      t.at = t.list.length - 1;
    }
    const now = await db.nodes.get(node.id);
    if (!now) return;
    // A panel named after its page is renamed with it; until the new page's title is known, by its address.
    const named = !now.title || now.title === 'Browser' || now.title === now.web?.title || now.title === now.web?.url;
    await putNode({ ...now, web: { url: next }, title: named ? next : now.title });
    if (named && !now.parentId) {
      const session = await db.sessions.filter((x) => x.rootNodeId === now.id && !x.deleted).first();
      if (session) await putSession({ ...session, title: next });
    }
  };

  /** Goes to an address: to its branch if this session already has one, else by the rule above. */
  const go = async (next: string, link?: { start: number; end: number; quote: string }) => {
    if (!next || next === url) return;
    const rootOf = (n: TreeNode | undefined) => {
      let cur = n;
      while (cur?.parentId) cur = ws.idx.byId.get(cur.parentId);
      return cur?.id;
    };
    const mine = rootOf(node);
    const pdf = pdfUrlOf(next) ?? (/\.pdf($|[?#])/i.test(next) ? next : null);
    const there = [...ws.idx.byId.values()].find((n) => n.id !== node.id && rootOf(n) === mine && (n.web?.url === next || (pdf && n.doc?.url === pdf)));
    if (there) return ws.select(there.id, { focus: true });
    if (!kept) return show(next);
    const extra = pdf ? { doc: { fingerprint: '', title: link?.quote || pdf, url: pdf, pages: 0 } } : { web: { url: next } };
    if (link) return ws.branch(node.id, WEB_KEY, link.start, link.end, link.quote, extra);
    // An address typed on a page that is being kept starts a browser of its own, beside this one.
    const session = await createSession(await projectIdOf(node.id), pdf ? extra.doc : undefined, pdf ? undefined : { title: 'Browser', web: { url: next } });
    ws.openSession(session.id);
  };

  const step = (by: number) => {
    const t = trail.current;
    const at = t.at + by;
    if (at < 0 || at >= t.list.length) return;
    t.at = at;
    void show(t.list[at], false);
  };
  const t = trail.current;
  const html = useMemo(() => page?.html ?? '', [page]);

  return (
    <div className="web">
      <form
        className="web-bar"
        onSubmit={(e) => {
          e.preventDefault();
          void go(addressOf(typed));
        }}
      >
        {!kept && (
          <>
            <button type="button" className="btn" disabled={t.at <= 0} title="Back" aria-label="Back" onClick={() => step(-1)}>‹</button>
            <button type="button" className="btn" disabled={t.at >= t.list.length - 1} title="Forward" aria-label="Forward" onClick={() => step(1)}>›</button>
          </>
        )}
        <input
          aria-label="Address or search"
          value={typed}
          placeholder="Search, or type an address"
          spellCheck={false}
          autoCapitalize="off"
          autoFocus={!url}
          onFocus={(e) => e.target.select()}
          onChange={(e) => setTyped(e.target.value)}
        />
        {url && <a className="btn" href={url} target="_blank" rel="noopener noreferrer" title="Open this page in your browser">↗</a>}
      </form>
      {kept && <div className="hint">This page has marks, so it stays: a link opens as a branch from it.</div>}
      {status && <div className="hint" role="status">{status}</div>}
      {!url && <p className="hint">Type an address or a search. Highlight anything on a page to keep the page in the tree.</p>}
      {page && (
        <div className="msg assistant web-page">
          <MessageBody
            nodeId={node.id}
            messageId={WEB_KEY}
            role="assistant"
            content=""
            html={html}
            streaming={false}
            marks={marks}
            onOpen={onOpen}
            onHighlight={onHighlight}
            onHover={onHover}
            onLink={(href, link) => {
              const body = link.closest('.body');
              if (!body || !/^https?:/.test(href)) return false;
              // A link to another place on the same page is left to the browser.
              if (href.split('#')[0] === url.split('#')[0]) return true;
              const before = document.createRange();
              before.selectNodeContents(body);
              before.setEndBefore(link);
              const start = before.toString().length;
              const quote = link.textContent ?? '';
              void go(href, quote.trim() ? { start, end: start + quote.length, quote } : undefined);
              return true;
            }}
          />
        </div>
      )}
    </div>
  );
}
