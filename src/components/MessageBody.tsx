import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { useLayoutEffect, useMemo, useRef } from 'react';

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
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Wraps the characters [start, end) of the element's text in <mark>. Offsets
 * count the concatenated text nodes, the same measure Range.toString() uses, so
 * they match what was recorded when the text was selected.
 */
function wrapRange(el: HTMLElement, mark: Mark) {
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
  for (const h of hits.reverse()) {
    const mid = h.from > 0 ? h.node.splitText(h.from) : h.node;
    if (h.to - h.from < mid.data.length) mid.splitText(h.to - h.from);
    const span = document.createElement('mark');
    span.dataset.child = mark.id;
    span.tabIndex = 0;
    span.setAttribute('role', 'button');
    span.title = mark.hidden ? 'A branch removed from this tree. Select to bring it back' : 'Open this branch';
    if (mark.hidden) span.classList.add('detached');
    else if (mark.active) span.classList.add('active');
    mid.replaceWith(span);
    span.appendChild(mid);
  }
}

interface Props {
  nodeId: string;
  messageId: string;
  role: 'user' | 'assistant';
  content: string;
  streaming: boolean;
  marks: Mark[];
  onOpen: (childId: string, at: DOMRect) => void;
}

export function MessageBody({ nodeId, messageId, role, content, streaming, marks, onOpen }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const html = useMemo(
    () => (role === 'user' ? escapeHtml(content) : DOMPurify.sanitize(marked.parse(content, { async: false }) as string)),
    [role, content],
  );
  const marksKey = marks.map((m) => `${m.id}:${m.start}:${m.end}:${m.active}:${!!m.hidden}`).join('|');

  // React does not manage this element's children, so the marks can be
  // inserted with plain DOM calls after each render of the HTML.
  useLayoutEffect(() => {
    const el = ref.current!;
    el.innerHTML = html;
    for (const m of marks) wrapRange(el, m);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html, marksKey]);

  const open = (target: EventTarget) => {
    const mark = (target as HTMLElement).closest<HTMLElement>('mark[data-child]');
    if (mark) onOpen(mark.dataset.child!, mark.getBoundingClientRect());
  };

  return (
    <div
      ref={ref}
      className={`body ${role}`}
      data-node-id={nodeId}
      data-msg-id={messageId}
      data-streaming={streaming ? 'true' : undefined}
      onClick={(e) => open(e.target)}
      onKeyDown={(e) => e.key === 'Enter' && open(e.target)}
    />
  );
}
