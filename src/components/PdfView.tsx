import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { db } from '../db';
import { docRefOf, fetchPdf, openPdf, pdfjs, storeFile, type PdfDocument } from '../pdf';
import { findAll, locate } from '../text';
import { pageKey, type TreeNode } from '../types';
import { useWorkspace } from '../workspace';
import { hoverProps, wrapRange, type Mark } from './MessageBody';

export const HIGHLIGHT_COLORS = [
  { name: 'Yellow', value: '#ffd84d' },
  { name: 'Green', value: '#8fe3a0' },
  { name: 'Blue', value: '#9cc8ff' },
  { name: 'Pink', value: '#ffa8c8' },
];

interface PageMark extends Mark {
  quote: string;
}

interface PageProps {
  pdf: PdfDocument;
  number: number;
  nodeId: string;
  /** Page size at scale 1, used until this page's own size is known. */
  base: { w: number; h: number };
  /** Width in CSS pixels to render the bitmap for. Changes only after resizing settles. */
  renderWidth: number;
  marks: PageMark[];
  onMark: (mark: HTMLElement) => void;
  onHover: (id: string | null, at?: DOMRect) => void;
}

/**
 * One page: a bitmap with an invisible, selectable copy of its text on top.
 * The text layer scales with a CSS variable, so the page follows the column's
 * width at once and the bitmap is redrawn only when the width settles.
 */
function Page({ pdf, number, nodeId, base, renderWidth, marks, onMark, onHover }: PageProps) {
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  const [size, setSize] = useState(base);
  const [text, setText] = useState<{ content: unknown; viewport: unknown } | null>(null);

  useEffect(() => {
    const el = host.current!;
    const observer = new IntersectionObserver(([entry]) => setNear(entry.isIntersecting), { rootMargin: '120% 0px' });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Draw the page while it is near the viewport; free the bitmap when it is far.
  useEffect(() => {
    const target = canvas.current!;
    if (!near) {
      target.width = 0;
      target.height = 0;
      return;
    }
    let cancelled = false;
    let task: { cancel(): void; promise: Promise<unknown> } | undefined;
    void (async () => {
      const page = await pdf.getPage(number);
      if (cancelled) return;
      const natural = page.getViewport({ scale: 1 });
      setSize({ w: natural.width, h: natural.height });
      const scale = Math.min(4, (renderWidth / natural.width) * (window.devicePixelRatio || 1));
      const viewport = page.getViewport({ scale });
      // Draw on a canvas of its own and copy the finished page across. Two
      // drawings of one page can overlap in time (while zooming, say), and on a
      // shared canvas they would be painted over each other.
      const sheet = document.createElement('canvas');
      sheet.width = Math.floor(viewport.width);
      sheet.height = Math.floor(viewport.height);
      task = page.render({ canvas: sheet, canvasContext: sheet.getContext('2d')!, viewport });
      const drawn = await task.promise.then(() => true, () => false);
      if (cancelled) return;
      if (drawn) {
        target.width = sheet.width;
        target.height = sheet.height;
        target.getContext('2d')!.drawImage(sheet, 0, 0);
      }
      if (!text) {
        const content = await page.getTextContent();
        if (!cancelled) setText({ content, viewport: natural });
      }
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [near, renderWidth, pdf, number]);

  // The text layer is built once per page. It is slow to build and is empty
  // while that happens, so it is not rebuilt when the marks change.
  const [built, setBuilt] = useState(0);
  useEffect(() => {
    const el = layer.current;
    if (!el || !text) return;
    let cancelled = false;
    el.replaceChildren();
    const textLayer = new pdfjs.TextLayer({
      textContentSource: text.content as never,
      container: el,
      viewport: text.viewport as never,
    });
    void textLayer.render().then(() => {
      if (cancelled) return;
      const end = document.createElement('div');
      end.className = 'endOfContent';
      el.append(end);
      setBuilt((n) => n + 1);
    });
    return () => {
      cancelled = true;
      textLayer.cancel();
    };
  }, [text]);

  // Marks are redrawn in place, in one step: the old ones are unwrapped and
  // the current ones wrapped again, so the page never shows without them and a
  // panel looking for a passage always finds it.
  const marksKey = marks.map((m) => `${m.id}:${m.start}:${m.end}:${m.active}:${!!m.hidden}:${m.color ?? ''}:${m.tint ?? ''}:${m.kind ?? ''}:${m.hint ?? ''}:${m.found ?? ''}`).join('|');
  useLayoutEffect(() => {
    const el = layer.current;
    if (!el || !built) return;
    el.querySelectorAll('i.badge').forEach((badge) => badge.remove());
    el.querySelectorAll('mark').forEach((mark) => mark.replaceWith(...mark.childNodes));
    el.normalize();
    const all = el.textContent ?? '';
    for (const mark of marks) {
      const found = locate(all, mark.start, mark.end, mark.quote);
      if (found) wrapRange(el, { ...mark, start: found[0], end: found[1] });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [built, marksKey]);

  return (
    <div
      className="pdf-page"
      ref={host}
      style={{ width: `calc(var(--total-scale-factor) * ${size.w}px)`, height: `calc(var(--total-scale-factor) * ${size.h}px)` }}
    >
      <canvas ref={canvas} aria-hidden="true" />
      <div
        className="textLayer"
        ref={layer}
        data-node-id={nodeId}
        data-msg-id={pageKey(number)}
        onClick={(e) => {
          // A search hit can sit inside a highlight; the click belongs to the highlight.
          const mark = (e.target as HTMLElement).closest<HTMLElement>('mark[data-child], mark[data-hl]');
          if (mark) onMark(mark);
        }}
        {...hoverProps(onHover)}
      />
      <span className="pdf-page-no">{number}</span>
    </div>
  );
}

/**
 * Keeps a text selection steady while it is being dragged. A page's text is
 * many separately placed pieces, and when the pointer passes over the gaps
 * between them the browser would otherwise extend the selection to pieces far
 * away, so that unrelated lines light up. As the PDF library's own viewer
 * does, each text layer ends in an empty block that is moved next to the
 * selection's moving end while the button is down, giving the browser
 * something nearby to hit instead.
 */
function steadySelection() {
  let previous: Range | null = null;
  const endOf = (layer: Element | null | undefined) => layer?.querySelector<HTMLElement>(':scope > .endOfContent, .endOfContent');
  const settle = () => {
    document.querySelectorAll<HTMLElement>('.textLayer.selecting').forEach((layer) => {
      layer.classList.remove('selecting');
      const end = endOf(layer);
      if (end) {
        layer.append(end);
        end.style.width = '';
        end.style.height = '';
        end.style.userSelect = '';
      }
    });
    previous = null;
  };
  const onDown = (e: PointerEvent) => (e.target as Element).closest?.('.textLayer')?.classList.add('selecting');
  const onChange = () => {
    const selection = document.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    // Which end is moving: the start, if the other end has not changed since last time.
    const movingStart =
      !!previous &&
      (range.compareBoundaryPoints(Range.END_TO_END, previous) === 0 || range.compareBoundaryPoints(Range.START_TO_END, previous) === 0);
    let anchor: Node | null = movingStart ? range.startContainer : range.endContainer;
    if (anchor.nodeType === Node.TEXT_NODE) anchor = anchor.parentNode;
    if (!movingStart && range.endOffset === 0) {
      do {
        while (anchor && !anchor.previousSibling) anchor = anchor.parentNode;
        anchor = anchor?.previousSibling ?? null;
      } while (anchor && !anchor.childNodes.length);
    }
    const layer = (anchor as Element | null)?.parentElement?.closest<HTMLElement>('.textLayer');
    const end = endOf(layer);
    if (layer?.classList.contains('selecting') && end && anchor?.parentElement) {
      end.style.width = layer.style.width;
      end.style.height = layer.style.height;
      end.style.userSelect = 'text';
      anchor.parentElement.insertBefore(end, movingStart ? anchor : anchor.nextSibling);
    }
    previous = range.cloneRange();
  };
  document.addEventListener('pointerdown', onDown);
  document.addEventListener('pointerup', settle);
  window.addEventListener('blur', settle);
  document.addEventListener('selectionchange', onChange);
}
let steadied = false;

type Status =
  | { kind: 'loading' }
  | { kind: 'ready'; pdf: PdfDocument; base: { w: number; h: number } }
  | { kind: 'missing'; reason: string };

interface Props {
  node: TreeNode;
  /** Magnification on top of fitting the column's width. */
  zoom: number;
  onZoom: (zoom: number) => void;
  /** A click on a branch's highlight (shared with chat panes, which handle hidden branches too). */
  onOpen: (childId: string, at: DOMRect) => void;
  /** A click on a plain highlight. */
  onHighlight: (id: string, at: DOMRect) => void;
  onHover: (id: string | null, at?: DOMRect) => void;
  /** The marks to draw on one page, worked out by the panel so that all kinds of text share the rules. */
  marksIn: (key: string) => (Mark & { quote: string })[];
  /** Whether the search bar is open, and the place in the panel where it is drawn. */
  finding: boolean;
  findSlot: HTMLElement | null;
  onFinding: (open: boolean) => void;
}

/** A PDF node: the pages, its highlights and the anchors of its branches. */
export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 4;

export function PdfView({ node, zoom, onZoom, onOpen, onHighlight, onHover, marksIn, finding, findSlot, onFinding }: Props) {
  const ws = useWorkspace();
  const doc = node.doc!;
  const frame = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<Status>({ kind: 'loading' });
  const [width, setWidth] = useState(0);
  const [renderWidth, setRenderWidth] = useState(0);

  const load = async (given?: ArrayBuffer) => {
    setStatus({ kind: 'loading' });
    try {
      let data = given ?? (doc.fingerprint ? (await db.files.get(doc.fingerprint))?.data : undefined);
      if (!data && doc.url) {
        try {
          data = await fetchPdf(doc.url);
        } catch {
          return setStatus({
            kind: 'missing',
            reason: 'This site does not let other pages load its PDFs. Download the PDF, then choose the file here.',
          });
        }
      }
      if (!data) return setStatus({ kind: 'missing', reason: 'This PDF is not on this device yet. Choose the file to read it here.' });
      const opened = await openPdf(data, doc.url);
      if (given && doc.fingerprint && opened.fingerprint !== doc.fingerprint) {
        return setStatus({ kind: 'missing', reason: 'That is a different PDF from the one these notes belong to. Choose the original file.' });
      }
      const first = (await opened.pdf.getPage(1)).getViewport({ scale: 1 });
      setStatus({ kind: 'ready', pdf: opened.pdf, base: { w: first.width, h: first.height } });
      void storeFile(opened, data);
      if (doc.fingerprint !== opened.fingerprint || doc.pages !== opened.pages) {
        await ws.setDoc(node.id, docRefOf(opened, doc.title, doc.url));
      }
    } catch (e) {
      setStatus({ kind: 'missing', reason: `This file could not be read as a PDF (${e instanceof Error ? e.message : String(e)}).` });
    }
  };
  useEffect(() => {
    if (!steadied) {
      steadied = true;
      steadySelection();
    }
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id]);

  // Fit the pages to the column. The bitmap resolution follows a moment later.
  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, [status.kind]);
  useEffect(() => {
    const wanted = width * zoom;
    const timer = window.setTimeout(() => setRenderWidth((cur) => (Math.abs(cur - wanted) > 24 ? wanted : cur)), 250);
    return () => clearTimeout(timer);
  }, [width, zoom]);

  // Pinch to zoom. A trackpad pinch reaches the page as a wheel event with the
  // Ctrl flag set (Chrome, Firefox, Edge) or as gesture events (Safari); on a
  // touch screen it is two fingers moving apart. The point under the fingers
  // stays where it is: `keep` records it so the scroll position can be
  // corrected once the pages have been laid out at the new size.
  const live = useRef({ zoom, onZoom });
  live.current = { zoom, onZoom };
  const keep = useRef<{ x: number; y: number; ratio: number } | null>(null);
  const ready = status.kind === 'ready';
  useEffect(() => {
    const scroller = frame.current?.closest<HTMLElement>('.pane-scroll');
    if (!scroller || !ready) return;
    const zoomTo = (next: number, clientX: number, clientY: number) => {
      const from = live.current.zoom;
      const to = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
      if (Math.abs(to - from) < 0.001) return;
      const box = scroller.getBoundingClientRect();
      keep.current = { x: clientX - box.left, y: clientY - box.top, ratio: to / from };
      live.current.zoom = to;
      live.current.onZoom(to);
    };

    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      zoomTo(live.current.zoom * Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY);
    };

    let gestureStart = 1;
    type GestureEvent = Event & { scale: number; clientX: number; clientY: number };
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      gestureStart = live.current.zoom;
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      const g = e as GestureEvent;
      zoomTo(gestureStart * g.scale, g.clientX, g.clientY);
    };

    let pinch: { distance: number; zoom: number } | null = null;
    const spread = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const onTouchStart = (e: TouchEvent) => {
      pinch = e.touches.length === 2 ? { distance: spread(e.touches), zoom: live.current.zoom } : null;
    };
    const onTouchMove = (e: TouchEvent) => {
      if (!pinch || e.touches.length !== 2) return;
      e.preventDefault();
      const [a, b] = [e.touches[0], e.touches[1]];
      zoomTo((pinch.zoom * spread(e.touches)) / pinch.distance, (a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2);
    };

    // These must be able to cancel the browser's own page zoom, so they cannot be passive listeners.
    const active = { passive: false } as const;
    scroller.addEventListener('wheel', onWheel, active);
    scroller.addEventListener('gesturestart', onGestureStart, active);
    scroller.addEventListener('gesturechange', onGestureChange, active);
    scroller.addEventListener('touchstart', onTouchStart, { passive: true });
    scroller.addEventListener('touchmove', onTouchMove, active);
    return () => {
      scroller.removeEventListener('wheel', onWheel);
      scroller.removeEventListener('gesturestart', onGestureStart);
      scroller.removeEventListener('gesturechange', onGestureChange);
      scroller.removeEventListener('touchstart', onTouchStart);
      scroller.removeEventListener('touchmove', onTouchMove);
    };
  }, [ready]);

  useLayoutEffect(() => {
    const scroller = frame.current?.closest<HTMLElement>('.pane-scroll');
    const k = keep.current;
    keep.current = null;
    if (!scroller || !k) return;
    scroller.scrollLeft = (scroller.scrollLeft + k.x) * k.ratio - k.x;
    scroller.scrollTop = (scroller.scrollTop + k.y) * k.ratio - k.y;
  }, [zoom]);

  // Search within the document. The whole PDF is searched, not only the pages
  // drawn so far, using each page's text as its text layer will have it.
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<{ page: number; start: number; end: number; quote: string }[]>([]);
  const [hitAt, setHitAt] = useState(0);
  // True until the search for the current words has finished (the first one reads every page).
  const [searching, setSearching] = useState(false);
  // Every page's text, read once (starting when the search bar opens) and shared by all searches.
  const pageTexts = useRef<Promise<string[]> | null>(null);
  const findInput = useRef<HTMLInputElement>(null);
  const pdfReady = status.kind === 'ready' ? status.pdf : null;
  const readPages = () => {
    pageTexts.current ??= (async () => {
      const texts: string[] = [];
      for (let n = 1; n <= pdfReady!.numPages; n++) {
        const content = await (await pdfReady!.getPage(n)).getTextContent();
        texts.push(content.items.map((item) => ('str' in item ? item.str : '')).join(''));
      }
      return texts;
    })();
    return pageTexts.current;
  };
  useEffect(() => {
    if (!finding) return;
    findInput.current?.focus();
    findInput.current?.select();
    if (pdfReady) void readPages();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finding, findSlot, pdfReady]);
  useEffect(() => {
    if (!finding || !pdfReady || !query.trim()) {
      setHits([]);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    // Wait for a pause in typing before searching.
    const timer = window.setTimeout(async () => {
      const texts = await readPages();
      if (cancelled) return;
      const found = texts.flatMap((text, i) =>
        findAll(text, query).map(([start, end]) => ({ page: i + 1, start, end, quote: text.slice(start, end) })),
      );
      // Start from the first hit on or after the page being read.
      const scroller = frame.current?.closest<HTMLElement>('.pane-scroll');
      const top = scroller?.getBoundingClientRect().top ?? 0;
      const reading = [...(scroller?.querySelectorAll('.pdf-page') ?? [])].findIndex((p) => p.getBoundingClientRect().bottom > top + 40) + 1;
      const from = found.findIndex((h) => h.page >= reading);
      setHits(found);
      setHitAt(from < 0 ? 0 : from);
      setSearching(false);
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finding, query, pdfReady]);

  // Bring the current hit into view: to its page if that has not been drawn yet, then to the hit.
  useEffect(() => {
    const hit = hits[hitAt];
    const scroller = frame.current?.closest<HTMLElement>('.pane-scroll');
    if (!hit || !scroller) return;
    let timer = 0;
    let tries = 0;
    const go = () => {
      const box = scroller.getBoundingClientRect();
      const mark = scroller.querySelector<HTMLElement>('mark[data-find="current"]');
      if (mark) {
        const at = mark.getBoundingClientRect();
        if (at.top < box.top + 8 || at.bottom > box.bottom - 8) scroller.scrollTop += at.top - box.top - scroller.clientHeight / 3;
        if (at.left < box.left + 8 || at.right > box.right - 8) scroller.scrollLeft += at.left - box.left - scroller.clientWidth / 3;
        return;
      }
      const sheet = scroller.querySelectorAll<HTMLElement>('.pdf-page')[hit.page - 1];
      const place = sheet?.getBoundingClientRect();
      if (place && tries === 0 && (place.bottom < box.top || place.top > box.bottom)) scroller.scrollTop += place.top - box.top;
      if (tries++ < 30) timer = window.setTimeout(go, 150);
    };
    go();
    return () => clearTimeout(timer);
  }, [hits, hitAt]);

  const step = (by: number) => hits.length && setHitAt((i) => (i + by + hits.length) % hits.length);
  const closeFind = () => {
    setHits([]);
    onFinding(false);
  };
  const findBar =
    finding && findSlot
      ? createPortal(
          <div className="find-bar" role="search">
            <input
              ref={findInput}
              type="search"
              aria-label="Find in this PDF"
              placeholder="Find in this PDF"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') step(e.shiftKey ? -1 : 1);
                if (e.key === 'Escape') closeFind();
              }}
            />
            <span className="find-count" role="status">
              {!query.trim() ? '' : hits.length ? `${hitAt + 1} of ${hits.length}` : searching ? 'Searching…' : 'No matches'}
            </span>
            <button className="btn" disabled={!hits.length} onClick={() => step(-1)} title="Previous match (Shift+Enter)">Previous</button>
            <button className="btn" disabled={!hits.length} onClick={() => step(1)} title="Next match (Enter)">Next</button>
            <button className="btn" onClick={closeFind} title="Close search (Escape)">Close</button>
          </div>,
          findSlot,
        )
      : null;

  if (status.kind === 'loading') return <p className="hint">Loading the PDF…</p>;
  if (status.kind === 'missing') {
    return (
      <div className="pdf-missing">
        <p>{status.reason}</p>
        {doc.url && /^https?:/.test(doc.url) && (
          <p>
            <a href={doc.url} target="_blank" rel="noopener noreferrer">Open the PDF in a new tab</a>
          </p>
        )}
        <label className="btn primary">
          Choose the PDF file
          <input
            type="file"
            accept="application/pdf,.pdf"
            hidden
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (file) void load(await file.arrayBuffer());
            }}
          />
        </label>
      </div>
    );
  }

  // Zoomed in, the pages are wider than the column and the panel scrolls sideways.
  const pageWidth = Math.max(0, width) * zoom;

  return (
    <div className="pdf" ref={frame} style={{ '--total-scale-factor': pageWidth ? pageWidth / status.base.w : 1 } as React.CSSProperties}>
      {findBar}
      {pageWidth > 0 &&
        Array.from({ length: status.pdf.numPages }, (_, i) => (
          <Page
            key={i}
            pdf={status.pdf}
            number={i + 1}
            nodeId={node.id}
            base={status.base}
            renderWidth={renderWidth || pageWidth}
            marks={[
              ...marksIn(pageKey(i + 1)),
              ...hits.flatMap((h, n) =>
                h.page === i + 1
                  ? [{ id: `find${n}`, start: h.start, end: h.end, quote: h.quote, active: false, found: n === hitAt ? ('current' as const) : ('hit' as const) }]
                  : [],
              ),
            ]}
            onHover={onHover}
            onMark={(mark) => {
              const at = mark.getBoundingClientRect();
              if (mark.dataset.child) onOpen(mark.dataset.child, at);
              else if (mark.dataset.hl) onHighlight(mark.dataset.hl, at);
            }}
          />
        ))}

    </div>
  );
}
