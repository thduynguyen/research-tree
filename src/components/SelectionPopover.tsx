import { useEffect, useState } from 'react';
import { pageOf } from '../types';
import { useWorkspace } from '../workspace';
import { db } from '../db';
import { WEB_AGENTS, isDesktop, webAgent } from './LiveWeb';
import { HIGHLIGHT_COLORS } from './PdfView';

interface Target {
  nodeId: string;
  messageId: string;
  start: number;
  end: number;
  quote: string;
  x: number;
  y: number;
  /** Drops the selection, when it is not in this document. */
  clear?: () => void;
}

// Not `instanceof Element`: a node from a frame belongs to that frame's own Element.
const bodyOf = (n: Node) => (n.nodeType === 1 ? (n as Element) : n.parentElement)?.closest<HTMLElement>('[data-msg-id]') ?? null;

/** How text shown in a frame reports its selection (or null when it is dropped) to the popover. */
export const FRAME_SELECTION = 'rt-frame-selection';

/**
 * The selected passage, as a place in one message's text. `doc` and `shift` are for text shown in a frame:
 * its document, and where the frame sits in the window.
 */
export function readSelection(doc: Document = document, shift = { x: 0, y: 0 }): Target | null {
  const sel = doc.getSelection();
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
  const before = doc.createRange();
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
    x: Math.min(Math.max(shift.x + rect.left + rect.width / 2, 200), window.innerWidth - 200),
    y: Math.min(Math.max(shift.y + rect.bottom + 8, 60), window.innerHeight - 60),
    clear: doc === document ? undefined : () => sel.removeAllRanges(),
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
  const agent = webAgent();
  const toWeb = isDesktop && agent in WEB_AGENTS;

  useEffect(() => {
    let timer = 0;
    const update = () => {
      clearTimeout(timer);
      // Text in the code editor reports its own selection; this document's view of it is left out.
      const node = document.getSelection()?.anchorNode;
      if ((node?.nodeType === 1 ? (node as Element) : node?.parentElement)?.closest('.cm-editor')) return;
      timer = window.setTimeout(() => setTarget(readSelection()), 150);
    };
    const fromFrame = (e: Event) => setTarget((e as CustomEvent<Target | null>).detail);
    document.addEventListener('selectionchange', update);
    window.addEventListener(FRAME_SELECTION, fromFrame);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('selectionchange', update);
      window.removeEventListener(FRAME_SELECTION, fromFrame);
    };
  }, []);

  if (!target) return null;
  const run = (action: () => Promise<void>) => {
    document.getSelection()?.removeAllRanges();
    target.clear?.();
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
      <button
        className="btn primary"
        title={toWeb ? `Open ${WEB_AGENTS[agent].name} beside this and ask it about the passage. Choose the agent in Settings.` : undefined}
        onMouseDown={hold}
        onClick={() =>
          run(async () => {
            // In the desktop app the passage goes to the chosen agent's own page, which is asked about it at once.
            if (!toWeb) return ws.branch(nodeId, messageId, start, end, quote, { color });
            // The agent is given what the passage is from, whole: the PDF itself, or the page's text.
            let source = ws.idx.byId.get(nodeId);
            while (source && !source.doc && !source.web && source.parentId) source = ws.idx.byId.get(source.parentId);
            const title = source?.doc?.title ?? source?.web?.title ?? source?.title ?? '';
            const link = source?.web?.url ?? source?.doc?.url ?? '';
            const kept = source?.doc?.fingerprint ? await db.files.get(source.doc.fingerprint) : source?.web?.url ? await db.files.get(`web:${source.web.url}`) : undefined;
            const safe = (title || 'document').replace(/[^\p{L}\p{N} ._-]/gu, ' ').trim().slice(0, 60) || 'document';
            const file = kept?.data?.byteLength
              ? { name: `${safe}.pdf`, type: 'application/pdf', data: kept.data }
              : kept?.text?.length
                ? { name: `${safe}.txt`, type: 'text/plain', data: new TextEncoder().encode(`${title}\n${link}\n\n${kept.text.join('\n\n')}`).buffer as ArrayBuffer }
                : undefined;
            const about = `${title ? ` from "${title}"` : ''}${/^https?:/.test(link) ? ` (${link})` : ''}`;
            const opening = `${file ? `The attached file is the ${file.type === 'application/pdf' ? 'paper' : 'page'} I am reading. ` : ''}Explain this passage${about}: "${quote.replace(/\s+/g, ' ')}"`;
            return ws.branch(nodeId, messageId, start, end, quote, { color, web: { url: WEB_AGENTS[agent].url }, opening, file });
          })
        }
      >
        Ask AI
      </button>
    </div>
  );
}
