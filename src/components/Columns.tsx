import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useLive } from '../chat';
import { kindLabel, preview } from '../tree';
import type { TreeNode } from '../types';
import { useWorkspace, type LevelInfo } from '../workspace';
import { Handle } from './Handle';
import { IconButton } from './Icon';
import { Pane } from './Pane';

const WIDTHS_KEY = 'rt.colWidths';
const SHARE_KEY = 'rt.parentShare';
const ROOT_PIN_KEY = 'rt.rootPinned';
/** Below this width the strip shows one column at a time. */
const NARROW = 640;

/** Widths the user has dragged, by column depth. Other columns use the CSS default. */
function loadWidths(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(WIDTHS_KEY) ?? '{}');
  } catch {
    return {};
  }
}

const calm = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const Chevrons = ({ up }: { up: boolean }) => (
  <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d={up ? 'M4 8l4-4 4 4M4 12l4-4 4 4' : 'M4 4l4 4 4-4M4 8l4 4 4-4'} />
  </svg>
);

/**
 * One level of the tree. Its unpinned branches are panels in a column that
 * scrolls and snaps vertically, so scrolling moves across siblings. Scrolling
 * only looks: the selected branch, which the levels to the right follow,
 * changes when a panel is clicked. Pinned branches sit above, out of the scroll.
 */
function Level({ info, width }: { info: LevelInfo; width?: number }) {
  const ws = useWorkspace();
  const snap = useRef<HTMLDivElement>(null);
  const first = useRef(true);
  const [heights, setHeights] = useState<Record<string, number>>({});
  const [menu, setMenu] = useState(false);

  useEffect(() => {
    if (!menu) return;
    const dismiss = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !(e.target as Element).closest('.jump, .counter')) setMenu(false);
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', dismiss);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', dismiss);
    };
  }, [menu]);

  const pinned = info.nodes.filter((n) => ws.view.pinned.includes(n.id));
  const browse = info.nodes.filter((n) => !ws.view.pinned.includes(n.id));
  const at = browse.findIndex((n) => n.id === info.selected?.id);
  const position = (n: TreeNode) => `${info.nodes.indexOf(n) + 1} of ${info.nodes.length}`;

  // Panels are not all one height: a chat or a PDF fills the column, a note is
  // only as tall as its text, so several notes can be in view together.
  const slotAt = (i: number) => snap.current?.children[i] as HTMLElement | undefined;
  const inView = (slot: HTMLElement) => {
    const el = snap.current!;
    return slot.offsetTop >= el.scrollTop - 2 && slot.offsetTop + slot.offsetHeight <= el.scrollTop + el.clientHeight + 2;
  };

  // A selection made elsewhere (a highlight, the tree, the list): glide to it unless it is already in view.
  useEffect(() => {
    const el = snap.current;
    const slot = slotAt(at);
    if (!el || !slot) return;
    if (!inView(slot)) el.scrollTo({ top: slot.offsetTop, behavior: first.current || calm() ? 'auto' : 'smooth' });
    first.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [at, browse.length]);

  // Scrolling the column never changes what is selected. If it did, the columns
  // to the right would come and go as panels with and without open branches
  // passed by. Only a click, an arrow tab or the list picks a panel.

  // Each panel's header carries its place among its siblings; the pill opens the list of all of them.
  const pill = (n: TreeNode) =>
    info.nodes.length > 1 ? (
      <button
        className="btn counter"
        aria-expanded={menu}
        aria-haspopup="menu"
        title="List all branches at this level"
        onClick={() => setMenu((v) => !v)}
      >
        {position(n)}
      </button>
    ) : null;

  const prev = at > 0 ? browse[at - 1] : undefined;
  const next = at >= 0 ? browse[at + 1] : browse[0];
  const nudge = (n: TreeNode, up: boolean) => {
    const label = `${up ? 'Previous' : 'Next'} branch, ${position(n)}: “${n.title}”`;
    return (
      <button className={up ? 'nudge up' : 'nudge down'} aria-label={label} title={label} onClick={() => ws.select(n.id, { focus: false })}>
        <Chevrons up={up} />
      </button>
    );
  };

  return (
    <div className="level" style={{ width }}>
      {menu && (
        <div className="jump" role="menu">
          {info.nodes.map((n) => {
            const messages = ws.idx.messagesOf.get(n.id) ?? [];
            return (
              <button
                key={n.id}
                role="menuitem"
                className={n.id === info.selected?.id ? 'jump-item shown' : 'jump-item'}
                onClick={() => {
                  setMenu(false);
                  ws.select(n.id, { focus: false });
                }}
              >
                <strong>“{n.title}”</strong> · {kindLabel(ws.idx, n)}
                {pinned.includes(n) && ' · pinned'}
                <span>{preview(ws.idx, n)}</span>
              </button>
            );
          })}
        </div>
      )}

      {pinned.map((n) => (
        <Fragment key={n.id}>
          <Pane nodeId={n.id} variant="aside" headExtra={pill(n)} style={{ flex: 'none', height: heights[n.id] ?? (n.note !== undefined || ws.view.minimized.includes(n.id) ? undefined : '30%') }} />
          <Handle axis="y" min={120} label={`Resize height of ${n.title}`} onChange={(h) => setHeights((all) => ({ ...all, [n.id]: h }))} />
        </Fragment>
      ))}

      {browse.length > 0 && (
        <div className="browse">
          <div className="snap" ref={snap}>
            {browse.map((n) => (
              <div
                className={n.note !== undefined || ws.view.minimized.includes(n.id) ? 'slot compact' : 'slot'}
                key={n.id}
                // With several panels in view, clicking in one selects it. This waits for the
                // click to finish: selecting on the press could scroll the column and move
                // the button out from under the pointer before the click landed.
                onClickCapture={(e) => {
                  // Every click picks the panel, selected already or not, so that the parent's
                  // text goes to its passage. Typing a message or finishing a text selection
                  // is not a pick.
                  const busy = (e.target as Element).closest('.composer, textarea, input, select') || !document.getSelection()?.isCollapsed;
                  if (n.id !== info.selected?.id || !busy) ws.select(n.id, { focus: false });
                }}
              >
                <Pane nodeId={n.id} variant="branch" headExtra={pill(n)} />
              </div>
            ))}
          </div>
          {prev && nudge(prev, true)}
          {next && nudge(next, false)}
        </div>
      )}
    </div>
  );
}

/**
 * Curves from each highlighted passage to the panel of its branch, drawn over
 * the columns and redrawn as anything scrolls.
 */
function Links({ stage }: { stage: RefObject<HTMLDivElement | null> }) {
  const ws = useWorkspace();
  useLive(); // a streaming reply moves the text, and the curves with it
  const [paths, setPaths] = useState<{ d: string; x: number; y: number }[]>([]);
  const levels = useRef(ws.levels);
  levels.current = ws.levels;
  const frame = useRef(0);
  const key = useRef('');

  const schedule = useRef(() => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const host = stage.current;
      if (!host) return;
      const base = host.getBoundingClientRect();
      const strip = host.querySelector('.columns')?.getBoundingClientRect();
      const out: { d: string; x: number; y: number }[] = [];
      for (const level of levels.current) {
        if (!level.selected) continue;
        const from = host.querySelector(`[data-pane-id="${level.parent.id}"]`);
        const to = host.querySelector(`[data-pane-id="${level.selected.id}"]`);
        const marks = from?.querySelectorAll(`mark[data-child="${level.selected.id}"]`);
        const view = from?.querySelector('.pane-scroll')?.getBoundingClientRect();
        if (!from || !to || !marks?.length || !view) continue;
        const parked = (el: Element) => el.closest<HTMLElement>('.cell')?.style.visibility === 'hidden';
        if (parked(from) || parked(to)) continue;
        const mark = marks[marks.length - 1].getBoundingClientRect();
        const target = to.getBoundingClientRect();
        // Skip an end that is scrolled out of its pane or out of the strip of columns.
        const y1 = mark.top + mark.height / 2;
        if (y1 < view.top || y1 > view.bottom) continue;
        if (strip && from.closest('.columns') && (mark.right < strip.left || mark.right > strip.right)) continue;
        if (strip && to.closest('.columns') && (target.left < strip.left - 2 || target.left > strip.right)) continue;
        const x1 = mark.right - base.left;
        const x2 = target.left - base.left;
        const y2 = Math.min(Math.max(target.top + 26, base.top + 8), base.bottom - 8) - base.top;
        if (x2 <= x1 + 6) continue;
        const bend = Math.max(28, (x2 - x1) / 2);
        out.push({ d: `M${x1} ${y1 - base.top}C${x1 + bend} ${y1 - base.top} ${x2 - bend} ${y2} ${x2} ${y2}`, x: x1, y: y1 - base.top });
      }
      const next = out.map((p) => p.d).join('|');
      if (next !== key.current) {
        key.current = next;
        setPaths(out);
      }
    });
  }).current;

  useEffect(() => {
    const host = stage.current;
    if (!host) return;
    host.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
    const observer = new ResizeObserver(schedule);
    observer.observe(host);
    return () => {
      host.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
      observer.disconnect();
      cancelAnimationFrame(frame.current);
    };
  }, [stage, schedule]);

  // After every render, and once more when entrance animations have finished.
  useEffect(() => {
    schedule();
    const later = window.setTimeout(schedule, 320);
    return () => clearTimeout(later);
  });

  return (
    <svg className="links" aria-hidden="true">
      {paths.map((p) => (
        <g key={p.d}>
          <path d={p.d} />
          <circle cx={p.x} cy={p.y} r="3" />
        </g>
      ))}
    </svg>
  );
}

const Arrows = ({ left }: { left: boolean }) => (
  <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d={left ? 'M8 4L4 8l4 4M12 4L8 8l4 4' : 'M4 4l4 4-4 4M8 4l4 4-4 4'} />
  </svg>
);

interface StripProps {
  depths: number[];
  keyOf: (depth: number) => string;
  render: (depth: number) => ReactNode;
  /** The parent column's share of the width, the rest going to the focused column. */
  share: number;
  onShare: (share: number) => void;
}

/**
 * The unpinned columns, two at a time: the focused level and its parent to the
 * left. It scrolls sideways natively and snaps one level per step. The columns
 * are not laid out in the scrolling content: they sit in a view that stays put
 * and are positioned from the scroll offset, so that as a level slides from the
 * focused place to the parent place it narrows smoothly from one width to the
 * other. An invisible track of snap stops gives the scroller its length.
 */
function Strip({ depths, keyOf, render, share, onShare }: StripProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const cells = useRef<(HTMLDivElement | null)[]>([]);
  const [width, setWidth] = useState(0);
  const [more, setMore] = useState({ left: false, right: false });

  const count = depths.length;
  const single = count === 1 || (width > 0 && width < NARROW);
  const step = single ? width : share * width;
  const stops = single ? count : count - 1;

  const layout = () => {
    const el = scroller.current;
    if (!el || !width) return;
    const offset = el.scrollLeft;
    // Fractional index of the focused column: column `focus - 1` is the parent.
    const focus = single ? offset / step : 1 + offset / step;
    let x = 0;
    for (let i = 0; i < count; i++) {
      const cell = cells.current[i];
      if (!cell) continue;
      const grown = Math.min(1, Math.max(0, i - focus + 1));
      const w = single ? width : width * (share + (1 - 2 * share) * grown);
      const left = x - offset;
      cell.style.width = `${w}px`;
      cell.style.transform = `translateX(${left}px)`;
      // Parked columns stay mounted (their scroll positions survive) but out of sight.
      cell.style.visibility = left < width - 1 && left + w > 1 ? 'visible' : 'hidden';
      x += w;
    }
    const left = offset > 4;
    const right = offset < (stops - 1) * step - 4;
    setMore((cur) => (cur.left === left && cur.right === right ? cur : { left, right }));
  };
  useLayoutEffect(layout);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const scrollBy = (dir: -1 | 1) => scroller.current?.scrollBy({ left: dir * step, behavior: calm() ? 'auto' : 'smooth' });

  const dragShare = (e: React.PointerEvent) => {
    e.preventDefault();
    const box = scroller.current!.getBoundingClientRect();
    const move = (ev: PointerEvent) => onShare(Math.min(0.6, Math.max(0.2, (ev.clientX - box.left) / box.width)));
    const end = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      document.body.classList.remove('resizing-x');
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    document.body.classList.add('resizing-x');
  };

  return (
    <div className="strip">
      <div className="columns" ref={scroller} onScroll={layout}>
        <div className="view" style={{ width }}>
          {depths.map((depth, i) => (
            <div className="cell" key={keyOf(depth)} data-index={i} ref={(el) => { cells.current[i] = el; }}>
              {render(depth)}
            </div>
          ))}
          {!single && (
            <div
              className="handle x share"
              style={{ left: share * width }}
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize the parent and focused columns"
              tabIndex={0}
              onPointerDown={dragShare}
              onKeyDown={(e) => {
                if (e.key === 'ArrowLeft') onShare(Math.max(0.2, share - 0.03));
                if (e.key === 'ArrowRight') onShare(Math.min(0.6, share + 0.03));
              }}
            />
          )}
        </div>
        <div className="track" aria-hidden="true">
          {Array.from({ length: stops }, (_, i) => (
            <span key={i} className="stop" style={{ width: step }} />
          ))}
          <span style={{ width: Math.max(0, width - step) }} />
        </div>
      </div>
      {more.left && (
        <button className="nudge left" aria-label="Go to the level above" title="Level above" onClick={() => scrollBy(-1)}>
          <Arrows left />
        </button>
      )}
      {more.right && (
        <button className="nudge right" aria-label="Go to the level below" title="Level below" onClick={() => scrollBy(1)}>
          <Arrows left={false} />
        </button>
      )}
    </div>
  );
}

function useNarrowWindow() {
  const query = '(max-width: 820px)';
  const [narrow, setNarrow] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setNarrow(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return narrow;
}

/**
 * The tree as columns. The root is on the left: pinned, it is a normal column;
 * unpinned, it shrinks to a rail and slides out over the levels while the
 * pointer is on it. Beside it the levels show two at a time, the focused one
 * and its parent; scrolling sideways moves in depth and scrolling a level
 * moves across its siblings.
 */
export function Columns() {
  const ws = useWorkspace();
  const stage = useRef<HTMLDivElement>(null);
  const handled = useRef(0);
  const leave = useRef(0);
  const narrowWindow = useNarrowWindow();
  const [widths, setWidths] = useState(loadWidths);
  const [share, setShare] = useState(() => Number(localStorage.getItem(SHARE_KEY)) || 1 / 3);
  const [rootPinned, setRootPinned] = useState(() => localStorage.getItem(ROOT_PIN_KEY) !== 'false');
  const [rootPeek, setRootPeek] = useState(false);
  useEffect(() => {
    try {
      localStorage.setItem(WIDTHS_KEY, JSON.stringify(widths));
      localStorage.setItem(SHARE_KEY, String(share));
      localStorage.setItem(ROOT_PIN_KEY, String(rootPinned));
    } catch {
      // Sizes then last for this tab only.
    }
  }, [widths, share, rootPinned]);

  // Make a requested node's level the focused column. Its panel may not be
  // rendered yet (a branch just created), so the request stays open until it is.
  useEffect(() => {
    const request = ws.focus;
    if (!request || handled.current === request.n) return;
    // Asking for the root while it is tucked away slides it out.
    if (request.id === ws.trail[0].id && !rootPinned && !narrowWindow) {
      handled.current = request.n;
      setRootPeek(true);
      return;
    }
    const pane = stage.current?.querySelector(`[data-pane-id="${request.id}"]`);
    if (!pane) return;
    handled.current = request.n;
    const cell = pane.closest<HTMLElement>('.cell');
    const strip = cell?.closest<HTMLElement>('.columns');
    if (!cell || !strip) return;
    const index = Number(cell.dataset.index);
    const single = strip.clientWidth < NARROW;
    const left = single ? index * strip.clientWidth : Math.max(0, index - 1) * share * strip.clientWidth;
    strip.scrollTo({ left, behavior: calm() ? 'auto' : 'smooth' });
  });

  const root = ws.trail[0];
  // The level at depth 1 has the root as its parent, so the id alone would clash with the root column.
  const keyOf = (depth: number) => (depth === 0 ? 'root' : `level:${ws.levels[depth - 1].parent.id}`);
  const rootColumn = (pin: boolean, width?: number | string) => (
    // A width saved on a wide window must not crowd out the next column on a narrower one:
    // the first column takes at most about three fifths of the window.
    <div className="level" style={width ? { width: typeof width === 'number' ? `min(${width}px, 62vw)` : width } : undefined}>
      <Pane
        nodeId={root.id}
        variant="root"
        headExtra={
          pin && (
            <IconButton
              icon="pin"
              pressed={rootPinned}
              label={rootPinned ? 'Unpin the root: hide it until the pointer is on its edge' : 'Pin the root: keep it open beside the levels'}
              onClick={() => {
                setRootPinned(!rootPinned);
                setRootPeek(false);
              }}
            />
          )
        }
      />
    </div>
  );
  const column = (depth: number) => (depth === 0 ? rootColumn(false) : <Level info={ws.levels[depth - 1]} />);

  // A phone has room for one column, so there the root is simply the first of them.
  const depths = [...(narrowWindow ? [0] : []), ...ws.levels.map((l) => l.depth)];
  const rootShown = rootPinned || rootPeek;
  // A PDF needs room to be read: its root column starts at 60% of the width, and keeps its own size.
  // Something to read (a PDF, a web page, code) gets the wider share by default; a conversation does not.
  const reading = !!(root.doc || root.web || root.code);
  const rootKey = reading ? 'pdfRoot' : '0';
  const rootWidth: number | string | undefined = widths[rootKey] ?? (reading ? '60vw' : undefined);

  return (
    <div className="stage" ref={stage}>
      {!narrowWindow && (
        <div className={rootPinned ? 'root-slot pinned' : 'root-slot'}>
          <div
            className={`root-col${rootShown ? '' : ' rail-only'}${!rootPinned && rootPeek ? ' floating' : ''}`}
            onMouseEnter={() => {
              clearTimeout(leave.current);
              if (!rootPinned) setRootPeek(true);
            }}
            onMouseLeave={() => {
              if (!rootPinned) leave.current = window.setTimeout(() => setRootPeek(false), 250);
            }}
          >
            {rootShown ? (
              rootColumn(true, rootWidth)
            ) : (
              <button className="rail" aria-label={`Show the root: ${ws.session.title}`} onClick={() => setRootPeek(true)}>
                <span>Root · {ws.session.title}</span>
              </button>
            )}
          </div>
          {rootPinned && <Handle label="Resize the root column" min={280} onChange={(w) => setWidths((all) => ({ ...all, [rootKey]: w }))} />}
        </div>
      )}
      {depths.length > 0 ? (
        <Strip depths={depths} keyOf={keyOf} render={column} share={share} onShare={setShare} />
      ) : (
        <div className="empty">
          <p>Branches open here.</p>
          <p>Select any text on the left, then choose “Ask in a new branch”.</p>
        </div>
      )}
      <Links stage={stage} />
    </div>
  );
}
