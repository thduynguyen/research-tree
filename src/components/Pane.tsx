import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useLive } from '../chat';
import { kindLabel, pathFrom, preview, summarize } from '../tree';
import { MAX_PINNED, freshNotes, useWorkspace } from '../workspace';
import { Composer } from './Composer';
import { IconButton } from './Icon';
import { MessageBody } from './MessageBody';
import { HIGHLIGHT_COLORS, MAX_ZOOM, MIN_ZOOM, PdfView } from './PdfView';
import { NOTE_KEY, highlightKey, pageOf } from '../types';
import { pdfUrlOf } from '../pdf';

/**
 * One discussion thread. `root`: the thread the session starts from. `branch`:
 * a sibling in a level's scrolling column. `aside`: a pinned sibling, held in
 * view above that column.
 */
export type PaneVariant = 'root' | 'branch' | 'aside';

interface PaneProps {
  nodeId: string;
  variant: PaneVariant;
  style?: CSSProperties;
  /** Controls the column adds to the header, shown just after the title. */
  headExtra?: ReactNode;
}

export function Pane({ nodeId, variant, style, headExtra }: PaneProps) {
  const ws = useWorkspace();
  const live = useLive();
  const scroller = useRef<HTMLDivElement>(null);
  const node = ws.idx.byId.get(nodeId)!;
  const messages = ws.idx.messagesOf.get(nodeId) ?? [];
  const kids = ws.idx.childrenOf.get(nodeId) ?? [];
  const hiddenKids = ws.idx.hiddenOf.get(nodeId) ?? [];
  const depth = pathFrom(ws.idx, ws.session.rootNodeId, nodeId).length - 1;
  const isSessionRoot = nodeId === ws.session.rootNodeId;
  const isBranch = variant === 'branch' || variant === 'aside';
  const onTrail = ws.trail.some((n) => n.id === nodeId);
  // The branch of this pane that the next column continues with.
  const chosenChild = onTrail ? ws.levels.find((l) => l.parent.id === nodeId)?.selected?.id ?? null : null;
  const pinned = ws.view.pinned.includes(nodeId);
  const locked = ws.view.locked.includes(nodeId);
  const siblings = node.parentId ? ws.idx.childrenOf.get(node.parentId) ?? [] : [];
  const pinFull = !pinned && siblings.filter((n) => ws.view.pinned.includes(n.id)).length >= MAX_PINNED;
  const home = isSessionRoot ? ws.home : undefined;

  const [detached, setDetached] = useState<{ id: string; x: number; y: number } | null>(null);
  // The menu for a link to a paper: where it points, and the link's place in its message.
  const [paper, setPaper] = useState<{ url: string; pdfUrl: string; messageId: string; start: number; end: number; quote: string; x: number; y: number } | null>(null);
  // The menu of a plain highlight, and a branch's colour menu (opened from its header).
  const [marked, setMarked] = useState<{ id: string; x: number; y: number; hover?: boolean } | null>(null);
  const hoverTimer = useRef(0);
  // The menu follows the pointer onto a highlight after a moment, and leaves a moment after the pointer does.
  const hoverHighlight = (id: string | null, rect?: DOMRect) => {
    clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(() => {
      if (id && rect) setMarked((cur) => (cur && !cur.hover ? cur : { id, ...at(rect, 70), hover: true }));
      else setMarked((cur) => (cur?.hover ? null : cur));
    }, id ? 250 : 350);
  };
  useEffect(() => () => clearTimeout(hoverTimer.current), []);
  const highlights = ws.idx.highlightsOf.get(nodeId) ?? [];
  const markedHighlight = marked && highlights.find((h) => h.id === marked.id);
  // The same menu serves the passage of a note or conversation, where the X deletes the whole branch.
  const markedBranch = marked && kids.find((k) => k.id === marked.id);
  // Which branch is waiting for a yes or no before it is deleted: one under the pointer, or this panel's own.
  const [doomed, setDoomed] = useState<string | null>(null);
  /** What deleting a branch would take with it, to decide whether to ask first and what to say. */
  const weigh = (id: string) => {
    let branches = 0;
    let messages = 0;
    for (const stack = [id]; stack.length; ) {
      const cur = stack.pop()!;
      messages += (ws.idx.messagesOf.get(cur) ?? []).length;
      for (const k of [...(ws.idx.childrenOf.get(cur) ?? []), ...(ws.idx.hiddenOf.get(cur) ?? [])]) {
        branches++;
        stack.push(k.id);
      }
    }
    const written = !!ws.idx.byId.get(id)?.note?.trim();
    return { branches, messages, empty: branches === 0 && messages === 0 && !written };
  };
  const describe = (id: string) => {
    const { branches, messages } = weigh(id);
    const parts = [messages && `${messages} ${messages === 1 ? 'message' : 'messages'}`, branches && `${branches} ${branches === 1 ? 'branch' : 'branches'} under it`].filter(Boolean);
    return parts.length ? `Delete it with ${parts.join(' and ')}?` : 'Delete this note?';
  };
  /** Deletes at once when there is nothing to lose; otherwise asks first. */
  const askDelete = (id: string) => {
    if (weigh(id).empty) {
      setMarked(null);
      void ws.remove(id);
    } else setDoomed(id);
  };
  const isNote = node.note !== undefined;
  // A conversation can be shrunk to a few lines, like a note, and expanded again.
  const isChat = !isNote && !node.doc;
  const mini = isChat && isBranch && ws.view.minimized.includes(nodeId);
  // A note opens ready to type in only where it was just created. Another tab
  // or device also sees the new, still empty note, and must not open an editor
  // of its own that could later save its blank text over the real one.
  const [editingNote, setEditingNote] = useState(() => freshNotes.has(nodeId));
  const [draft, setDraft] = useState(node.note ?? '');
  // The text the editor started from. Only a change made in this editor is saved.
  const opened = useRef(node.note ?? '');
  const startNote = () => {
    opened.current = node.note ?? '';
    setDraft(opened.current);
    setEditingNote(true);
  };
  const finishNote = () => {
    freshNotes.delete(nodeId);
    if (draft !== opened.current) void ws.setNote(nodeId, draft);
    setEditingNote(false);
  };
  // How far a PDF is magnified beyond fitting the panel's width, remembered per PDF.
  const zoomKey = `rt.zoom.${nodeId}`;
  const [zoom, setZoomState] = useState(() => Number(localStorage.getItem(zoomKey)) || 1);
  const setZoom = (z: number) => {
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
    setZoomState(next);
    try {
      localStorage.setItem(zoomKey, String(next));
    } catch {
      // The zoom then lasts for this tab only.
    }
  };
  // Search within a PDF. The find shortcut opens it while the pointer or the
  // keyboard focus is in this panel; elsewhere the browser's own find is left alone.
  const [finding, setFinding] = useState(false);
  const [findSlot, setFindSlot] = useState<HTMLElement | null>(null);
  const hovering = useRef(false);
  const section = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!node.doc) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'f' || !(e.metaKey || e.ctrlKey) || e.altKey) return;
      if (!hovering.current && !section.current?.contains(document.activeElement)) return;
      e.preventDefault();
      setFinding(true);
      section.current?.querySelector<HTMLInputElement>('.find-bar input')?.select();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [node.doc]);

  const at = (r: DOMRect, lift = 60) => ({
    x: Math.min(Math.max(r.left + r.width / 2, 170), window.innerWidth - 170),
    y: Math.min(r.bottom + 8, window.innerHeight - lift),
  });
  /** The marks to draw in one stretch of text: plain highlights, then the passages of branches. */
  const marksIn = (key: string) => [
    ...highlights
      .filter((h) => highlightKey(h) === key)
      .map((h) => ({ id: h.id, start: h.start, end: h.end, quote: h.quote, active: false, color: h.color })),
    ...kids
      .filter((k) => k.anchor?.messageId === key)
      .map((k) => ({
        id: k.id,
        start: k.anchor!.start,
        end: k.anchor!.end,
        quote: k.anchor!.quote,
        active: k.id === chosenChild,
        tint: k.anchor!.color,
        kind: k.note !== undefined ? ('note' as const) : k.doc ? undefined : ('ask' as const),
        hint: k.note !== undefined ? `Note: ${k.note.trim() || '(empty)'}` : k.doc ? 'Open this paper' : 'Open this conversation',
      })),
    ...hiddenKids
      .filter((k) => k.anchor?.messageId === key)
      .map((k) => ({ id: k.id, start: k.anchor!.start, end: k.anchor!.end, quote: k.anchor!.quote, active: false, hidden: true })),
  ];
  const detachedSession = detached && ws.sessions.find((s) => !s.deleted && s.rootNodeId === detached.id);
  useEffect(() => {
    if (!detached && !paper && !marked) return;
    const dismiss = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !(e.target as Element).closest('.popover')) {
        setDetached(null);
        setPaper(null);
        setMarked(null);
        setDoomed(null);
      }
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', dismiss);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', dismiss);
    };
  }, [detached, paper, marked]);

  const openMark = (childId: string, rect: DOMRect) => {
    if (!ws.idx.byId.get(childId)?.hidden) return ws.select(childId);
    setDetached({ id: childId, ...at(rect) });
  };
  const openHighlight = (id: string, rect: DOMRect) => setMarked({ id, ...at(rect, 110) });

  const lastId = messages[messages.length - 1]?.id;
  const liveLength = lastId ? live.get(lastId)?.text.length : undefined;
  useEffect(() => {
    const el = scroller.current;
    // A chat follows its newest message; a PDF opens at its first page.
    if (el && !node.doc) el.scrollTop = el.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length, liveLength]);

  // When the reader picks one of this panel's branches, bring its passage
  // into view. Only a deliberate pick does this, and only a fresh one: a panel
  // that is drawn again later must not jump back to an old pick.
  // Declared after the scroll-to-bottom effect so that it wins when both run.
  // In a PDF the passage may be on a page whose text has not been drawn yet:
  // go to that page first, then to the passage once it exists.
  const pickedChild = ws.picked && Date.now() - ws.picked.at < 2000 && kids.some((k) => k.id === ws.picked!.id) ? ws.picked.id : null;
  useEffect(() => {
    const el = scroller.current;
    const chosenChild = pickedChild;
    if (!el || !chosenChild || locked) return;
    const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const page = pageOf(ws.idx.byId.get(chosenChild)?.anchor?.messageId ?? '');
    let timer = 0;
    let tries = 0;
    const go = () => {
      const mark = el.querySelector<HTMLElement>(`mark[data-child="${chosenChild}"]`);
      const box = el.getBoundingClientRect();
      if (mark) {
        const at = mark.getBoundingClientRect();
        // Already on screen: leave the reader where they are.
        if (at.top >= box.top + 8 && at.bottom <= box.bottom - 8) return;
        // One move. In a PDF it is an instant jump: gliding past whole pages is hard on the eyes.
        el.scrollTo({ top: el.scrollTop + at.top - box.top - el.clientHeight / 3, behavior: node.doc || calm ? 'auto' : 'smooth' });
        return;
      }
      const sheet = page ? el.querySelectorAll<HTMLElement>('.pdf-page')[page - 1] : undefined;
      // Go to the page only if none of it is on screen yet.
      const away = sheet && (sheet.getBoundingClientRect().bottom < box.top || sheet.getBoundingClientRect().top > box.bottom);
      if (sheet && away && tries === 0) el.scrollTo({ top: el.scrollTop + sheet.getBoundingClientRect().top - box.top, behavior: 'auto' });
      if (tries++ < 25) timer = window.setTimeout(go, 200);
    };
    go();
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws.picked?.n]);

  // Put the cursor in a note that is being written. A new note's column can
  // still be sliding into view, and a field that is not yet shown cannot take
  // (or keep) the cursor, so wait until it is.
  const noteInput = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!editingNote) return;
    let frame = 0;
    let tries = 0;
    const attempt = () => {
      const input = noteInput.current;
      if (!input) return;
      if (input.closest<HTMLElement>('.cell')?.style.visibility === 'hidden' && tries++ < 180) {
        frame = requestAnimationFrame(attempt);
        return;
      }
      input.focus({ preventScroll: true });
      input.setSelectionRange(input.value.length, input.value.length);
    };
    frame = requestAnimationFrame(attempt);
    return () => cancelAnimationFrame(frame);
  }, [editingNote]);

  // Menus that float over the text are drawn outside the panel. Inside it they
  // would be placed relative to the panel and cut off at its edges.
  const float = (menu: ReactNode) => createPortal(menu, document.body);

  const confirmingHere = doomed === node.id && !marked;

  const label = isBranch ? `Branch, depth ${depth}` : 'Root';

  return (
    <section
      className={`pane ${variant}${onTrail ? ' selected' : ''}${isNote || mini ? ' note' : ''}`}
      aria-label={`${label}: ${node.title}`}
      data-pane-id={nodeId}
      style={style}
      ref={section}
      onMouseEnter={() => { hovering.current = true; }}
      onMouseLeave={() => { hovering.current = false; }}
    >
      <header className={confirmingHere ? 'pane-head confirming' : 'pane-head'}>
        {isBranch ? (
          <div className="pane-name">
            <span className="depth">{depth}</span>
            <span className="text">“{node.title}”</span>
          </div>
        ) : (
          <div className="pane-name">
            <span className="text">{ws.session.title}</span>
          </div>
        )}
        <div className="pane-actions">
          {node.doc && (
            <IconButton icon="search" pressed={finding} label="Find in this PDF (Ctrl+F or ⌘F with the pointer over it)" onClick={() => setFinding(!finding)} />
          )}
          {node.doc && (
            <span className="zoom" role="group" aria-label="Zoom">
              <button className="icon-btn" aria-label="Zoom out" title="Zoom out" onClick={() => setZoom(zoom - 0.25)}>−</button>
              <button className="zoom-level" title="Back to fitting the panel's width" onClick={() => setZoom(1)}>
                {Math.round(zoom * 100)}%
              </button>
              <button className="icon-btn" aria-label="Zoom in" title="Zoom in" onClick={() => setZoom(zoom + 0.25)}>+</button>
            </span>
          )}
          {isNote && !editingNote && (
            <button className="btn small" onClick={startNote}>Edit</button>
          )}
          {headExtra}
          {isBranch && node.anchor && !node.doc && (
            <span className="swatches tiny" role="group" aria-label="Colour of this branch's passage">
              {HIGHLIGHT_COLORS.map((c) => (
                <button
                  key={c.value}
                  className="swatch"
                  style={{ background: c.value }}
                  aria-label={c.name}
                  aria-pressed={node.anchor!.color === c.value}
                  title={`${c.name} highlight`}
                  onClick={() => void ws.setColor(node.id, c.value)}
                />
              ))}
            </span>
          )}
          {isBranch && (
            <IconButton
              icon="pin"
              pressed={pinned}
              disabled={pinFull}
              label={
                pinned ? 'Unpin: return this branch to the ones you scroll through'
                : pinFull ? `${MAX_PINNED} branches are already pinned at this level`
                : 'Pin: keep this branch in view while you scroll through the others'
              }
              onClick={() => ws.togglePin(node.id)}
            />
          )}
          {!isSessionRoot && (
            <IconButton
              icon="popout"
              label="Move this branch out to its own session. It can be put back from there"
              onClick={() => void ws.makeRoot(node.id)}
            />
          )}
          {isBranch && kids.length > 0 && (
            <button
              className="btn subtree"
              aria-expanded={ws.view.expanded.includes(nodeId)}
              title={
                ws.view.expanded.includes(nodeId)
                  ? 'Close the column of its branches'
                  : `Open its ${kids.length === 1 ? 'branch' : `${kids.length} branches`} in the next column`
              }
              onClick={() => ws.toggleExpanded(node.id)}
            >
              {kids.length}
              <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d={ws.view.expanded.includes(nodeId) ? 'M7 2.5L3.5 6 7 9.5M10 2.5L6.5 6 10 9.5' : 'M2 2.5L5.5 6 2 9.5M5 2.5L8.5 6 5 9.5'} />
              </svg>
            </button>
          )}
          {isChat && isBranch && (
            <IconButton
              icon={mini ? 'maximize' : 'minimize'}
              label={mini ? 'Expand this conversation' : 'Minimize this conversation to a few lines'}
              onClick={() => ws.toggleMinimized(node.id)}
            />
          )}
          {isBranch && <IconButton icon="close" label="Delete this branch and everything under it" onClick={() => askDelete(node.id)} />}
        </div>
        {/* The question takes the whole header, so that both answers are always in reach in a narrow panel. */}
        {confirmingHere && (
          <div className="confirm-row" role="alertdialog" aria-label="Confirm deleting this branch">
            <span>{describe(node.id)}</span>
            <button className="btn danger" onClick={() => void ws.remove(node.id)}>Delete</button>
            <button className="btn" onClick={() => setDoomed(null)}>Keep</button>
          </div>
        )}
      </header>

      {node.doc && <div className="find-slot" ref={setFindSlot} />}
      <div className="pane-body">
      <div className="pane-scroll" ref={scroller}>
        {home && node.parentId && (
          <div className="origin">
            <span>This branch was moved out of “{home.title}”.</span>
            <span className="origin-actions">
              <button className="btn primary" onClick={() => void ws.undoSplit()}>Put it back</button>
              <button className="btn" onClick={() => ws.openSession(home.id, node.parentId!)}>Go to that session</button>
            </span>
          </div>
        )}
        {node.anchor && !isNote && !mini && (
          <blockquote className="anchor" style={node.anchor.color ? { background: `${node.anchor.color}55` } : undefined}>
            “{node.anchor.quote}”
          </blockquote>
        )}

        {node.doc && <PdfView
            node={node}
            zoom={zoom}
            onZoom={setZoom}
            onOpen={openMark}
            onHighlight={openHighlight}
            onHover={hoverHighlight}
            marksIn={marksIn}
            finding={finding}
            findSlot={findSlot}
            onFinding={setFinding}
          />}

        {isNote &&
          (editingNote ? (
            <textarea
              className="note-edit"
              ref={noteInput}
              aria-label="Note"
              rows={Math.min(12, Math.max(2, draft.split('\n').length + 1))}
              placeholder="Write a note, then press Enter. Shift+Enter for a new line. Math goes between dollar signs."
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={finishNote}
              onKeyDown={(e) => {
                // Enter finishes the note; with Shift or Alt it is a line break.
                if (e.key === 'Enter' && e.altKey) {
                  e.preventDefault();
                  const el = e.currentTarget;
                  const next = `${draft.slice(0, el.selectionStart)}\n${draft.slice(el.selectionEnd)}`;
                  const caret = el.selectionStart + 1;
                  setDraft(next);
                  requestAnimationFrame(() => el.setSelectionRange(caret, caret));
                } else if ((e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) || e.key === 'Escape') {
                  e.preventDefault();
                  e.currentTarget.blur();
                }
              }}
            />
          ) : node.note?.trim() ? (
            <div className="msg assistant note-text">
              <MessageBody
                nodeId={nodeId}
                messageId={NOTE_KEY}
                role="assistant"
                content={node.note}
                streaming={false}
                marks={marksIn(NOTE_KEY)}
                onOpen={openMark}
                onHighlight={openHighlight}
                onHover={hoverHighlight}
              />
            </div>
          ) : (
            <button className="note-empty" onClick={startNote}>Write a note</button>
          ))}

        {mini && (
          <button className="mini-chat" title="Expand this conversation" onClick={() => ws.toggleMinimized(node.id)}>
            <strong>{messages.find((m) => m.role === 'user')?.content ?? 'No question yet'}</strong>
            {messages.some((m) => m.role === 'assistant') && <span>{summarize(messages)}</span>}
          </button>
        )}

        {!node.doc && !isNote && !mini && messages.length === 0 && (
          <p className="hint">
            {node.parentId
              ? 'Ask about the selected passage.'
              : 'Ask a question to start. Then select any text in a reply to open a branch on it.'}
          </p>
        )}

        {!mini && messages.map((m) => {
          const streaming = live.has(m.id);
          const content = live.get(m.id)?.text ?? m.content;
          const anchored = kids.filter((k) => k.anchor?.messageId === m.id);
          return (
            <div key={m.id} className={`msg ${m.role}`}>
              {m.role === 'assistant' && <div className="who">{m.model?.model ?? 'Assistant'}</div>}
              <MessageBody
                nodeId={nodeId}
                messageId={m.id}
                role={m.role}
                content={content}
                streaming={streaming}
                marks={marksIn(m.id)}
                onHighlight={openHighlight}
                onHover={hoverHighlight}
                onOpen={openMark}
                onLink={(url, link) => {
                  const pdfUrl = pdfUrlOf(url);
                  const body = link.closest('.body');
                  if (!pdfUrl || !body || streaming) return false;
                  const before = document.createRange();
                  before.selectNodeContents(body);
                  before.setEndBefore(link);
                  const start = before.toString().length;
                  const quote = link.textContent ?? '';
                  setPaper({ url, pdfUrl, messageId: m.id, start, end: start + quote.length, quote, ...at(link.getBoundingClientRect()) });
                  return true;
                }}
              />
              {streaming && !content && <div className="hint">Waiting for the model…</div>}
              {m.error && <div className="error" role="alert">{m.error}</div>}
              {/* Off the chosen line, the next column is not this pane's, so list its branches here. */}
              {!onTrail &&
                anchored.map((k) => {
                  const km = ws.idx.messagesOf.get(k.id) ?? [];
                  return (
                    <button key={k.id} className="chip" onClick={() => ws.select(k.id)}>
                      <strong>“{k.title}”</strong> · {kindLabel(ws.idx, k)}
                      <span>{preview(ws.idx, k)}</span>
                    </button>
                  );
                })}
            </div>
          );
        })}
      </div>
      {/* Tucked in the corner and dimmed until the pointer reaches it; stronger while locked. */}
      {kids.length > 0 && (
        <span className={locked ? 'lock-corner on' : 'lock-corner'}>
          <IconButton
            icon="lock"
            pressed={locked}
            label={
              locked
                ? 'Scroll is locked here. Select to follow the highlight of the selected branch again'
                : 'Lock scroll: stop this panel jumping to the highlight when one of its branches is selected'
            }
            onClick={() => ws.toggleLock(node.id)}
          />
        </span>
      )}
      </div>

      {detached && float(
        <div className="popover" style={{ left: detached.x, top: detached.y }}>
          <button
            className="btn primary"
            onClick={() => {
              setDetached(null);
              void ws.restore(detached.id);
            }}
          >
            Highlight again and show its branches
          </button>
          {detachedSession && (
            <button
              className="btn"
              onClick={() => {
                setDetached(null);
                ws.openSession(detachedSession.id);
              }}
            >
              Open its session
            </button>
          )}
        </div>
      )}

      {marked && markedBranch && float(
        <div
          className="popover select"
          style={{ left: marked.x, top: marked.y }}
          onMouseEnter={() => clearTimeout(hoverTimer.current)}
          onMouseLeave={() => doomed !== markedBranch.id && hoverHighlight(null)}
        >
          {doomed === markedBranch.id ? (
            <span className="confirm">
              {describe(markedBranch.id)}
              <button
                className="link danger"
                onClick={() => {
                  setMarked(null);
                  setDoomed(null);
                  void ws.remove(markedBranch.id);
                }}
              >
                Delete
              </button>
              <button className="link" onClick={() => setDoomed(null)}>Keep</button>
            </span>
          ) : (
            <div className="swatches" role="group" aria-label="Colour">
              {HIGHLIGHT_COLORS.map((c) =>
                // A branch made before colours has none: its first dot stands in as the one to X out.
                (markedBranch.anchor?.color ?? HIGHLIGHT_COLORS[0].value) === c.value ? (
                  <button
                    key={c.value}
                    className="swatch remove"
                    style={{ background: c.value }}
                    aria-label={markedBranch.note !== undefined ? 'Delete this note' : 'Delete this conversation'}
                    title={markedBranch.note !== undefined ? 'Delete this note' : 'Delete this conversation'}
                    onClick={() => askDelete(markedBranch.id)}
                  >
                    <svg aria-hidden="true" width="10" height="10" viewBox="0 0 10 10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                      <path d="M2 2l6 6M8 2l-6 6" />
                    </svg>
                  </button>
                ) : (
                  <button
                    key={c.value}
                    className="swatch"
                    style={{ background: c.value }}
                    aria-label={`Change to ${c.name.toLowerCase()}`}
                    title={`Change to ${c.name.toLowerCase()}`}
                    onClick={() => void ws.setColor(markedBranch.id, c.value)}
                  />
                ),
              )}
            </div>
          )}
        </div>
      )}

      {marked && markedHighlight && float(
        <div
          className="popover select"
          style={{ left: marked.x, top: marked.y }}
          onMouseEnter={() => clearTimeout(hoverTimer.current)}
          onMouseLeave={() => hoverHighlight(null)}
        >
          <div className="swatches" role="group" aria-label="Highlight colour">
            {HIGHLIGHT_COLORS.map((c) =>
              markedHighlight.color === c.value ? (
                <button
                  key={c.value}
                  className="swatch remove"
                  style={{ background: c.value }}
                  aria-label="Remove this highlight"
                  title="Remove this highlight"
                  onClick={() => {
                    setMarked(null);
                    void ws.updateHighlight(markedHighlight.id, { deleted: true });
                  }}
                >
                  <svg aria-hidden="true" width="10" height="10" viewBox="0 0 10 10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                    <path d="M2 2l6 6M8 2l-6 6" />
                  </svg>
                </button>
              ) : (
                <button
                  key={c.value}
                  className="swatch"
                  style={{ background: c.value }}
                  aria-label={`Change to ${c.name.toLowerCase()}`}
                  title={`Change to ${c.name.toLowerCase()}`}
                  onClick={() => void ws.updateHighlight(markedHighlight.id, { color: c.value })}
                />
              ),
            )}
          </div>
          {/* A highlight can grow into a note or a question; the branch takes over its passage and colour. */}
          {(['Note', 'Ask AI'] as const).map((kind) => (
            <button
              key={kind}
              className={kind === 'Ask AI' ? 'btn primary' : 'btn'}
              onClick={() => {
                const h = markedHighlight;
                setMarked(null);
                void ws.updateHighlight(h.id, { deleted: true });
                void ws.branch(nodeId, highlightKey(h), h.start, h.end, h.quote, { color: h.color, note: kind === 'Note' });
              }}
            >
              {kind}
            </button>
          ))}
        </div>
      )}

      {paper && float(
        <div className="popover" style={{ left: paper.x, top: paper.y }}>
          <button
            className="btn primary"
            onClick={() => {
              setPaper(null);
              const doc = { fingerprint: '', title: paper.quote || paper.pdfUrl, url: paper.pdfUrl, pages: 0 };
              void ws.branch(nodeId, paper.messageId, paper.start, paper.end, paper.quote, { doc });
            }}
          >
            Open as a branch
          </button>
          <a className="btn" href={paper.url} target="_blank" rel="noopener noreferrer" onClick={() => setPaper(null)}>
            Open in a new tab
          </a>
        </div>
      )}

      {isChat && !mini && <Composer node={node} autoFocus={ws.focus?.id === node.id && messages.length === 0} />}
    </section>
  );
}
