import { useEffect, useState } from 'react';
import { useWorkspace } from '../workspace';

interface Target {
  nodeId: string;
  messageId: string;
  start: number;
  end: number;
  quote: string;
  x: number;
  y: number;
}

const bodyOf = (n: Node) => (n instanceof Element ? n : n.parentElement)?.closest<HTMLElement>('.body[data-msg-id]') ?? null;

function readSelection(): Target | null {
  const sel = document.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  const body = bodyOf(range.startContainer);
  // One finished message only: a reply still streaming has no stable offsets.
  if (!body || body !== bodyOf(range.endContainer) || body.dataset.streaming) return null;

  const raw = range.toString();
  const quote = raw.trim();
  if (!quote) return null;
  const before = document.createRange();
  before.selectNodeContents(body);
  before.setEnd(range.startContainer, range.startOffset);
  const start = before.toString().length + (raw.length - raw.trimStart().length);

  const rect = range.getBoundingClientRect();
  return {
    nodeId: body.dataset.nodeId!,
    messageId: body.dataset.msgId!,
    start,
    end: start + quote.length,
    quote,
    x: Math.min(Math.max(rect.left + rect.width / 2, 110), window.innerWidth - 110),
    y: Math.min(rect.bottom + 8, window.innerHeight - 60),
  };
}

export function SelectionPopover() {
  const ws = useWorkspace();
  const [target, setTarget] = useState<Target | null>(null);

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
  return (
    <div className="popover" style={{ left: target.x, top: target.y }}>
      <button
        className="btn primary"
        // Keep the text selected while the button is pressed.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          document.getSelection()?.removeAllRanges();
          setTarget(null);
          void ws.branch(target.nodeId, target.messageId, target.start, target.end, target.quote);
        }}
      >
        Ask in a new branch
      </button>
    </div>
  );
}
