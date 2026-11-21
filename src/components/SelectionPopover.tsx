import { useEffect, useState } from 'react';
import { pageOf } from '../types';
import { useWorkspace } from '../workspace';
import { HIGHLIGHT_COLORS } from './PdfView';

interface Target {
  nodeId: string;
  messageId: string;
  start: number;
  end: number;
  quote: string;
  x: number;
  y: number;
}

const bodyOf = (n: Node) => (n instanceof Element ? n : n.parentElement)?.closest<HTMLElement>('[data-msg-id]') ?? null;

function readSelection(): Target | null {
  const sel = document.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  const body = bodyOf(range.startContainer);
  // One finished message only: a reply still streaming has no stable offsets.
  if (!body || body !== bodyOf(range.endContainer) || body.dataset.streaming) return null;

  const raw = range.toString();
  const page = pageOf(body.dataset.msgId!);
  // A PDF's text layer has no spaces where lines break, so there the quote is
  // taken as the reader sees it; the offsets still count the raw text.
  const quote = page ? sel.toString().replace(/\s+/g, ' ').trim() : raw.trim();
  if (!quote || !raw.trim()) return null;
  const before = document.createRange();
  before.selectNodeContents(body);
  before.setEnd(range.startContainer, range.startOffset);
  const start = before.toString().length + (raw.length - raw.trimStart().length);

  const rect = range.getBoundingClientRect();
  return {
    nodeId: body.dataset.nodeId!,
    messageId: body.dataset.msgId!,
    start,
    end: start + raw.trim().length,
    quote,
    x: Math.min(Math.max(rect.left + rect.width / 2, 200), window.innerWidth - 200),
    y: Math.min(rect.bottom + 8, window.innerHeight - 60),
  };
}

const COLOR_KEY = 'rt.color';

/**
 * Appears on a text selection. One click does each thing: a colour dot
 * highlights the passage in that colour, Note opens a written note on it, and
 * Ask AI opens a conversation about it. Note and Ask AI use the colour last
 * highlighted with (the ringed dot).
 */
export function SelectionPopover() {
  const ws = useWorkspace();
  const [target, setTarget] = useState<Target | null>(null);
  const [color, setColor] = useState(() => localStorage.getItem(COLOR_KEY) ?? HIGHLIGHT_COLORS[0].value);

  useEffect(() => {
    let timer = 0;
    const update = () => {
      clearTimeout(timer);
      timer = window.setTimeout(() => setTarget(readSelection()), 150);
    };
    document.addEventListener('selectionchange', update);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('selectionchange', update);
    };
  }, []);

  if (!target) return null;
  const run = (action: () => Promise<void>) => {
    document.getSelection()?.removeAllRanges();
    setTarget(null);
    void action();
  };
  const { nodeId, messageId, start, end, quote } = target;
  // Keep the text selected while a button is pressed.
  const hold = (e: React.MouseEvent) => e.preventDefault();

  const remember = (value: string) => {
    setColor(value);
    try {
      localStorage.setItem(COLOR_KEY, value);
    } catch {
      // The colour then lasts for this tab only.
    }
  };

  return (
    <div className="popover select" style={{ left: target.x, top: target.y }}>
      <div className="swatches" role="group" aria-label="Highlight in">
        {HIGHLIGHT_COLORS.map((c) => (
          <button
            key={c.value}
            className={color === c.value ? 'swatch last' : 'swatch'}
            style={{ background: c.value }}
            aria-label={`Highlight in ${c.name.toLowerCase()}`}
            title={`Highlight in ${c.name.toLowerCase()}`}
            onMouseDown={hold}
            onClick={() => {
              remember(c.value);
              run(() => ws.highlight(nodeId, messageId, start, end, quote, c.value));
            }}
          />
        ))}
      </div>
      <button className="btn" onMouseDown={hold} onClick={() => run(() => ws.branch(nodeId, messageId, start, end, quote, { color, note: true }))}>
        Note
      </button>
      <button className="btn primary" onMouseDown={hold} onClick={() => run(() => ws.branch(nodeId, messageId, start, end, quote, { color }))}>
        Ask AI
      </button>
    </div>
  );
}
