import DOMPurify from 'dompurify';
import { marked } from 'marked';
import markedKatex from 'marked-katex-extension';
import { locate } from '../text';
import { useLayoutEffect, useMemo, useRef } from 'react';

// LaTeX between $...$ and $$...$$ renders as math; a formula that fails to parse is shown as written.
marked.use(markedKatex({ throwOnError: false, nonStandard: true }));

/** Models often write \\( ... \\) and \\[ ... \\]; turn those into the dollar forms the renderer reads. */
const dollars = (text: string) =>
  text.replace(/\\\[([\s\S]+?)\\\]/g, (_, m) => `$$${m}$$`).replace(/\\\(([\s\S]+?)\\\)/g, (_, m) => `$${m}$`);

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

export interface Mark {
  id: string;
  start: number;
  end: number;
  active: boolean;
  /** The branch was removed from the tree: underline only. */
  hidden?: boolean;
  /** Set for a plain highlight, which has a colour and no branch; `id` is then the highlight's id. */
  color?: string;
  /** The colour of a branch's passage. */
  tint?: string;
  /** The marked text, used to find the range again if the text around it has changed. */
  quote?: string;
  /** What hangs off a branch's passage: a written note or a conversation with the model. Shown as a small badge. */
  kind?: 'note' | 'ask';
  /** Tooltip, for example the text of the note. */
  hint?: string;
  /** A search result, not something the reader marked: one of the hits, or the one being shown. */
  found?: 'hit' | 'current';
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Wraps the characters [start, end) of the element's text in <mark>. Offsets
 * count the concatenated text nodes, the same measure Range.toString() uses, so
 * they match what was recorded when the text was selected.
 */
export function wrapRange(el: HTMLElement, mark: Mark) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const hits: { node: Text; from: number; to: number }[] = [];
  let pos = 0;
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    const len = n.data.length;
    const from = Math.max(mark.start - pos, 0);
    const to = Math.min(mark.end - pos, len);
    if (from < to && n.data.slice(from, to).trim()) hits.push({ node: n, from, to });
    pos += len;
    if (pos >= mark.end) break;
  }
  let last = true;
  for (const h of hits.reverse()) {
    const mid = h.from > 0 ? h.node.splitText(h.from) : h.node;
    if (h.to - h.from < mid.data.length) mid.splitText(h.to - h.from);
    const span = document.createElement('mark');
    if (mark.found) {
      span.dataset.find = mark.found;
      mid.replaceWith(span);
      span.appendChild(mid);
      continue;
    }
    span.tabIndex = 0;
    span.setAttribute('role', 'button');
    if (mark.color) {
      span.dataset.hl = mark.id;
      span.style.backgroundColor = mark.color;
      span.title = 'Highlight. Select to change or remove it';
    } else {
      span.dataset.child = mark.id;
      span.title = mark.hidden ? 'A branch removed from this tree. Select to bring it back' : mark.hint ?? 'Open this branch';
      if (mark.hidden) span.classList.add('detached');
      else {
        if (mark.tint) span.style.backgroundColor = mark.tint;
        if (mark.active) span.classList.add('active');
        if (mark.kind) span.dataset.kind = mark.kind;
      }
    }
    // The badge sits at the end of the passage. It holds no text, so it does not shift any offsets.
    if (last && mark.kind && !mark.hidden) {
      const badge = document.createElement('i');
      badge.className = `badge ${mark.kind}`;
      badge.setAttribute('aria-hidden', 'true');
      span.appendChild(badge);
    }
    last = false;
    mid.replaceWith(span);
    span.insertBefore(mid, span.firstChild);
  }
}

/**
 * Pointer handlers that report when the pointer is on a highlight: a plain one,
 * or the passage of a note or conversation. Shared with PDF pages.
 */
export function hoverProps(onHover?: (id: string | null, at?: DOMRect) => void) {
  const markOf = (t: EventTarget) => (t as HTMLElement).closest<HTMLElement>('mark[data-hl], mark[data-child]:not(.detached)');
  return {
    onMouseOver: (e: React.MouseEvent) => {
      const mark = markOf(e.target);
      if (mark) onHover?.((mark.dataset.hl ?? mark.dataset.child)!, mark.getBoundingClientRect());
    },
    onMouseOut: (e: React.MouseEvent) => {
      if (markOf(e.target)) onHover?.(null);
    },
  };
}

interface Props {
  nodeId: string;
  messageId: string;
  role: 'user' | 'assistant';
  content: string;
  streaming: boolean;
  marks: Mark[];
  onOpen: (childId: string, at: DOMRect) => void;
  /** A click on a plain highlight. */
  onHighlight?: (id: string, at: DOMRect) => void;
  /** The pointer came onto a plain highlight (with its place), or left it (null). */
  onHover?: (id: string | null, at?: DOMRect) => void;
  /** Called for a click on a link to a PDF or paper; return true to keep the browser from following it. */
  onLink?: (url: string, link: HTMLAnchorElement) => boolean;
}

export function MessageBody({ nodeId, messageId, role, content, streaming, marks, onOpen, onHighlight, onHover, onLink }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const html = useMemo(
    () => (role === 'user' ? escapeHtml(content) : DOMPurify.sanitize(marked.parse(dollars(content), { async: false }) as string)),
    [role, content],
  );
  const marksKey = marks.map((m) => `${m.id}:${m.start}:${m.end}:${m.active}:${!!m.hidden}:${m.color ?? ''}:${m.tint ?? ''}:${m.kind ?? ''}:${m.hint ?? ''}`).join('|');

  // React does not manage this element's children, so the marks can be
  // inserted with plain DOM calls after each render of the HTML.
  useLayoutEffect(() => {
    const el = ref.current!;
    el.innerHTML = html;
    const all = el.textContent ?? '';
    for (const m of marks) {
      // A note can be edited after it was marked, so look the passage up again when it has moved.
      const found = m.quote ? locate(all, m.start, m.end, m.quote) : ([m.start, m.end] as const);
      if (found) wrapRange(el, { ...m, start: found[0], end: found[1] });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html, marksKey]);

  const open = (target: EventTarget) => {
    const mark = (target as HTMLElement).closest<HTMLElement>('mark');
    if (mark?.dataset.child) onOpen(mark.dataset.child, mark.getBoundingClientRect());
    else if (mark?.dataset.hl) onHighlight?.(mark.dataset.hl, mark.getBoundingClientRect());
  };

  return (
    <div
      ref={ref}
      className={`body ${role}`}
      data-node-id={nodeId}
      data-msg-id={messageId}
      data-streaming={streaming ? 'true' : undefined}
      onClick={(e) => {
        const link = (e.target as HTMLElement).closest<HTMLAnchorElement>('a[href]');
        if (link && !(e.target as HTMLElement).closest('mark') && onLink?.(link.href, link)) e.preventDefault();
        else open(e.target);
      }}
      onKeyDown={(e) => e.key === 'Enter' && open(e.target)}
      {...hoverProps(onHover)}
    />
  );
}
