import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useLive } from '../chat';
import { pathFrom, summarize } from '../tree';
import { MAX_PINNED, useWorkspace } from '../workspace';
import { Composer } from './Composer';
import { IconButton } from './Icon';
import { MessageBody } from './MessageBody';

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
  const detachedSession = detached && ws.sessions.find((s) => !s.deleted && s.rootNodeId === detached.id);
  useEffect(() => {
    if (!detached) return;
    const dismiss = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !(e.target as Element).closest('.popover')) setDetached(null);
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', dismiss);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', dismiss);
    };
  }, [detached]);

  const lastId = messages[messages.length - 1]?.id;
  const liveLength = lastId ? live.get(lastId)?.text.length : undefined;
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, liveLength]);

  // Bring the highlight of the branch shown in the next column into view.
  // Declared after the scroll-to-bottom effect so that it wins when both run.
  useEffect(() => {
    const el = scroller.current;
    if (!el || !chosenChild || locked) return;
    const mark = el.querySelector<HTMLElement>(`mark[data-child="${chosenChild}"]`);
    if (!mark) return;
    const top = el.scrollTop + mark.getBoundingClientRect().top - el.getBoundingClientRect().top - el.clientHeight / 3;
    const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollTo({ top, behavior: calm ? 'auto' : 'smooth' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chosenChild]);

  const label = isBranch ? `Branch, depth ${depth}` : 'Root';

  return (
    <section
      className={`pane ${variant}${onTrail ? ' selected' : ''}`}
      aria-label={`${label}: ${node.title}`}
      data-pane-id={nodeId}
      style={style}
    >
      <header className="pane-head">
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
          {headExtra}
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
          {isBranch && (
            <IconButton
              icon="close"
              label="Remove from this tree. Nothing is deleted: its highlight stays underlined and can bring it back"
              onClick={() => void ws.hide(node.id)}
            />
          )}
        </div>
      </header>

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
        {node.anchor && <blockquote className="anchor">“{node.anchor.quote}”</blockquote>}

        {messages.length === 0 && (
          <p className="hint">
            {node.parentId
              ? 'Ask about the selected passage.'
              : 'Ask a question to start. Then select any text in a reply to open a branch on it.'}
          </p>
        )}

        {messages.map((m) => {
          const streaming = live.has(m.id);
          const content = live.get(m.id)?.text ?? m.content;
          const anchored = kids.filter((k) => k.anchor?.messageId === m.id);
          const anchoredHidden = hiddenKids.filter((k) => k.anchor?.messageId === m.id);
          return (
            <div key={m.id} className={`msg ${m.role}`}>
              {m.role === 'assistant' && <div className="who">{m.model?.model ?? 'Assistant'}</div>}
              <MessageBody
                nodeId={nodeId}
                messageId={m.id}
                role={m.role}
                content={content}
                streaming={streaming}
                marks={[
                  ...anchored.map((k) => ({ id: k.id, start: k.anchor!.start, end: k.anchor!.end, active: k.id === chosenChild })),
                  ...anchoredHidden.map((k) => ({ id: k.id, start: k.anchor!.start, end: k.anchor!.end, active: false, hidden: true })),
                ]}
                onOpen={(childId, at) => {
                  if (!ws.idx.byId.get(childId)?.hidden) return ws.select(childId);
                  setDetached({
                    id: childId,
                    x: Math.min(Math.max(at.left + at.width / 2, 150), window.innerWidth - 150),
                    y: Math.min(at.bottom + 8, window.innerHeight - 60),
                  });
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
                      <strong>“{k.title}”</strong> · {km.length} {km.length === 1 ? 'message' : 'messages'}
                      <span>{summarize(km)}</span>
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

      {detached && (
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

      <Composer node={node} autoFocus={ws.focus?.id === node.id && messages.length === 0} />
    </section>
  );
}
