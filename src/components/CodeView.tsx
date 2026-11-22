import { indentWithTab } from '@codemirror/commands';
import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { Compartment, EditorState } from '@codemirror/state';
import { oneDark } from '@codemirror/theme-one-dark';
import { Decoration, EditorView, keymap } from '@codemirror/view';
import { Vim, vim } from '@replit/codemirror-vim';
import { basicSetup } from 'codemirror';
import { useEffect, useMemo, useRef, useState } from 'react';
import { FILES_CHANGED } from '../chat';
import { putNode } from '../db';
import { listRoot, readWorkspaceFile, saveWorkspaceFile, type WorkspaceFile } from '../folder';
import { fuzzyScore, locate } from '../text';
import type { TreeNode } from '../types';
import { useWorkspace } from '../workspace';
import type { Mark } from './MessageBody';
import { FRAME_SELECTION } from './SelectionPopover';

const VIM_KEY = 'rt.vim';

/** Marks on a file's text are filed under this key, one per file. */
export const codeKey = (path: string) => `code:${path}`;
const IMAGE = /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i;

/** Finds a file by a few letters of its name, as editors do with their "go to file" box. */
function Palette({ files, onPick, onClose }: { files: WorkspaceFile[]; onPick: (file: WorkspaceFile, where: 'beside' | 'below') => void; onClose: () => void }) {
  const [typed, setTyped] = useState('');
  const [choice, setChoice] = useState(0);
  const found = useMemo(
    () =>
      files
        .map((file) => ({ file, score: fuzzyScore(file.name, typed) }))
        .filter((x) => x.score >= 0)
        .sort((a, b) => b.score - a.score || a.file.name.localeCompare(b.file.name))
        .slice(0, 50),
    [files, typed],
  );
  const pick = Math.min(choice, found.length - 1);
  return (
    <div className="palette" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette-box" role="dialog" aria-label="Go to file">
        <input
          autoFocus
          aria-label="File name"
          placeholder="Go to file: type part of its name"
          value={typed}
          spellCheck={false}
          onChange={(e) => {
            setTyped(e.target.value);
            setChoice(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              if (found.length) setChoice((pick + (e.key === 'ArrowDown' ? 1 : -1) + found.length) % found.length);
            } else if (e.key === 'Enter' && found[pick]) onPick(found[pick].file, e.shiftKey || e.altKey ? 'below' : 'beside');
          }}
        />
        <ul role="listbox">
          {found.map(({ file }, i) => {
            const cut = file.name.lastIndexOf('/') + 1;
            return (
              <li key={file.path} role="option" aria-selected={i === pick}>
                <button type="button" className={i === pick ? 'on' : ''} title="Open beside this file, as its branch" onMouseDown={(e) => e.preventDefault()} onClick={() => onPick(file, 'beside')}>
                  <strong>{file.name.slice(cut)}</strong>
                  <span>{file.name.slice(0, cut)}</span>
                </button>
                <button type="button" className="below" title="Open in the same column as this file, pinned next to it" onMouseDown={(e) => e.preventDefault()} onClick={() => onPick(file, 'below')}>
                  same column
                </button>
              </li>
            );
          })}
          {!found.length && <li className="hint">No file matches.</li>}
        </ul>
        <div className="palette-foot">Enter opens beside this file · Shift+Enter opens in the same column</div>
      </div>
    </div>
  );
}

interface Dir {
  dirs: Map<string, Dir>;
  files: WorkspaceFile[];
}

/** The folder's files as a tree that folds: folders first, then files, each by name. */
function FileTree({ files, current, onPick }: { files: WorkspaceFile[]; current?: string; onPick: (file: WorkspaceFile) => void }) {
  const top = useMemo(() => {
    const made: Dir = { dirs: new Map(), files: [] };
    for (const file of files) {
      const parts = file.name.split('/');
      let dir = made;
      for (const part of parts.slice(0, -1)) {
        if (!dir.dirs.has(part)) dir.dirs.set(part, { dirs: new Map(), files: [] });
        dir = dir.dirs.get(part)!;
      }
      dir.files.push(file);
    }
    return made;
  }, [files]);
  // Folders start folded, apart from the ones leading to the file being shown.
  const [open, setOpen] = useState<Set<string>>(new Set());
  const onPath = (path: string) => !!current && files.find((f) => f.path === current)?.name.startsWith(`${path}/`);
  const level = (dir: Dir, prefix: string, depth: number): React.ReactNode => (
    <>
      {[...dir.dirs.keys()].sort().map((name) => {
        const path = prefix + name;
        const shown = open.has(path) || (!open.has(`-${path}`) && onPath(path));
        return (
          <div key={path}>
            <button
              type="button"
              className="code-row"
              style={{ paddingLeft: 8 + depth * 12 }}
              aria-expanded={!!shown}
              onClick={() => {
                const next = new Set(open);
                // A folder on the way to the open file is shown unless folded by hand, which is noted with a dash.
                if (shown) {
                  next.delete(path);
                  next.add(`-${path}`);
                } else {
                  next.add(path);
                  next.delete(`-${path}`);
                }
                setOpen(next);
              }}
            >
              <span className="code-twisty" aria-hidden="true">{shown ? '▾' : '▸'}</span>
              {name}
            </button>
            {shown && level(dir.dirs.get(name)!, `${path}/`, depth + 1)}
          </div>
        );
      })}
      {[...dir.files]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((file) => (
          <button key={file.path} type="button" className={`code-row file${file.path === current ? ' on' : ''}`} style={{ paddingLeft: 8 + depth * 12 + 14 }} onClick={() => onPick(file)}>
            {file.name.slice(prefix.length)}
          </button>
        ))}
    </>
  );
  return <nav className="code-tree-list" aria-label="Files">{level(top, '', 0)}</nav>;
}

interface Props {
  node: TreeNode;
  /** The highlights and branches filed under a key: here, one file's. */
  marksIn: (key: string) => Mark[];
  onOpen: (childId: string, at: DOMRect) => void;
  onHighlight: (id: string, at: DOMRect) => void;
  onHover: (id: string | null, at?: DOMRect) => void;
}

/** Marks as the editor draws them: each a stretch of the file's text, found again by its words if the file has changed. */
function decorate(text: string, marks: Mark[]) {
  const ranges = [];
  for (const m of marks) {
    const found = m.quote ? locate(text, m.start, m.end, m.quote) : ([m.start, m.end] as const);
    if (!found || found[0] >= found[1] || found[1] > text.length) continue;
    const plain = !!m.color;
    ranges.push(
      Decoration.mark({
        tagName: 'mark',
        class: m.hidden ? 'detached' : m.active ? 'active' : '',
        attributes: {
          [plain ? 'data-hl' : 'data-child']: m.id,
          ...(m.kind && !m.hidden ? { 'data-kind': m.kind } : {}),
          ...(m.hidden ? {} : { style: `background-color: ${m.color ?? m.tint ?? 'var(--mark)'}` }),
          title: plain ? 'Highlight. Select to change or remove it' : m.hint ?? 'Open this branch',
        },
      }).range(found[0], found[1]),
    );
  }
  return Decoration.set(ranges, true);
}

/**
 * A folder of source code: one file shown at a time in an editor, with syntax
 * colours by language, a "go to file" box, optional vim keys, and saving.
 */
export function CodeView({ node, marksIn, onOpen, onHighlight, onHover }: Props) {
  const root = node.code!.root;
  const path = node.code!.file;
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const [files, setFiles] = useState<WorkspaceFile[] | null>(null);
  const [finding, setFinding] = useState(false);
  const [status, setStatus] = useState('');
  const [dirty, setDirty] = useState(false);
  const [image, setImage] = useState('');
  const [vimOn, setVimOn] = useState(() => localStorage.getItem(VIM_KEY) === '1');
  const save = useRef<() => void>(() => undefined);
  const markSlot = useRef<Compartment | null>(null);
  const [made, setMade] = useState(0);
  const marks = path ? marksIn(codeKey(path)) : [];
  const marksKey = marks.map((m) => `${m.id}:${m.start}:${m.end}:${m.active}:${!!m.hidden}:${m.color ?? ''}:${m.tint ?? ''}:${m.kind ?? ''}`).join('|');
  const latest = useRef({ marks, node });
  latest.current = { marks, node };

  useEffect(() => {
    void listRoot(root).then(setFiles, (e) => setStatus(`The folder could not be read: ${e instanceof Error ? e.message : String(e)}`));
  }, [root]);

  const ws = useWorkspace();
  /** Opens another file from this one: beside it, as its branch, or below it, as its sibling with this one kept in view. */
  const open = (file: WorkspaceFile, where: 'beside' | 'below') => {
    setFinding(false);
    const parentId = where === 'beside' ? node.id : node.parentId ?? node.id;
    const there = [...ws.idx.byId.values()].find((n) => n.parentId === parentId && n.code?.file === file.path);
    const fields = { title: file.name.split('/').pop() ?? file.name, code: { root, file: file.path } };
    if (where === 'beside') return there ? ws.select(there.id, { focus: true }) : void ws.attach(parentId, fields);
    // In the same column the new file is pinned next to this one, which stays the one the next column
    // belongs to: whatever is open beside this file stays open.
    if (!there) return void ws.attach(parentId, fields, { aside: true });
    if (there.id !== node.id && !ws.view.pinned.includes(there.id)) ws.togglePin(there.id);
  };

  // The editor is rebuilt for each file; the keys choice is part of it.
  useEffect(() => {
    const el = host.current;
    setImage('');
    if (!el || !path) return;
    let live = true;
    let made: EditorView | null = null;
    let blob = '';
    setStatus('Opening…');
    void (async () => {
      try {
        const bytes = await readWorkspaceFile(path);
        if (!live) return;
        if (IMAGE.test(path)) {
          blob = URL.createObjectURL(new Blob([bytes], { type: path.toLowerCase().endsWith('.svg') ? 'image/svg+xml' : 'image/*' }));
          setImage(blob);
          setStatus('');
          return;
        }
        if (bytes.byteLength > 3_000_000) return setStatus('This file is too large to show.');
        if (new Uint8Array(bytes.slice(0, 4000)).includes(0)) return setStatus('This is not a text file.');
        const text = new TextDecoder().decode(bytes);
        const language = new Compartment();
        const slot = new Compartment();
        markSlot.current = slot;
        let selecting = 0;
        const dark = matchMedia('(prefers-color-scheme: dark)').matches;
        save.current = () => {
          if (!made) return;
          setStatus('Saving…');
          saveWorkspaceFile(path, made.state.doc.toString()).then(
            () => {
              setDirty(false);
              setStatus('Saved.');
            },
            (e) => setStatus(`Not saved: ${e instanceof Error ? e.message : String(e)}`),
          );
        };
        made = new EditorView({
          parent: el,
          state: EditorState.create({
            doc: text,
            extensions: [
              // Vim keys come first so that they take the keys before the ordinary ones.
              ...(vimOn ? [vim()] : []),
              basicSetup,
              keymap.of([indentWithTab, { key: 'Mod-s', preventDefault: true, run: () => (save.current(), true) }]),
              language.of([]),
              slot.of(EditorView.decorations.of(decorate(text, latest.current.marks))),
              ...(dark ? [oneDark] : []),
              EditorView.updateListener.of((update) => {
                if (update.docChanged) {
                  setDirty(true);
                  setStatus('');
                }
                // A selection is offered to the popover as a place in this file's text.
                if (update.selectionSet || update.focusChanged) {
                  clearTimeout(selecting);
                  selecting = window.setTimeout(() => {
                    const editor = update.view;
                    const { from, to } = editor.state.selection.main;
                    const raw = editor.state.sliceDoc(from, to);
                    const at = from < to && raw.trim() ? editor.coordsAtPos(to) : null;
                    const start = from + (raw.length - raw.trimStart().length);
                    window.dispatchEvent(
                      new CustomEvent(FRAME_SELECTION, {
                        detail: at && {
                          nodeId: latest.current.node.id,
                          messageId: codeKey(path),
                          start,
                          end: start + raw.trim().length,
                          quote: raw.trim(),
                          x: Math.min(Math.max(at.left, 200), window.innerWidth - 200),
                          y: Math.min(Math.max(at.bottom + 8, 60), window.innerHeight - 60),
                          clear: () => editor.dispatch({ selection: { anchor: to } }),
                        },
                      }),
                    );
                  }, 200);
                }
              }),
            ],
          }),
        });
        view.current = made;
        setMade((n) => n + 1);
        setDirty(false);
        setStatus('');
        const found = LanguageDescription.matchFilename(languages, path.split('/').pop() ?? '');
        if (found) void found.load().then((support) => live && made?.dispatch({ effects: language.reconfigure(support) }));
      } catch (e) {
        if (live) setStatus(`This file could not be opened: ${e instanceof Error ? e.message : String(e)}`);
      }
    })();
    return () => {
      live = false;
      made?.destroy();
      view.current = null;
      if (blob) URL.revokeObjectURL(blob);
    };
  }, [path, vimOn]);

  // A command or a model may have changed the open file on disk: it is read again, unless there are unsaved edits here.
  const dirtyNow = useRef(dirty);
  dirtyNow.current = dirty;
  useEffect(() => {
    const refresh = async () => {
      const editor = view.current;
      if (!editor || !path || dirtyNow.current) return;
      try {
        const text = new TextDecoder().decode(await readWorkspaceFile(path));
        if (view.current !== editor || text === editor.state.doc.toString()) return;
        editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: text } });
        setDirty(false);
        setStatus('Reloaded: the file changed on disk.');
      } catch {
        // The file may be gone; what is shown stays.
      }
    };
    window.addEventListener(FILES_CHANGED, refresh);
    return () => window.removeEventListener(FILES_CHANGED, refresh);
  }, [path]);

  // Marks are redrawn when they change.
  useEffect(() => {
    const editor = view.current;
    if (editor && markSlot.current) editor.dispatch({ effects: markSlot.current.reconfigure(EditorView.decorations.of(decorate(editor.state.doc.toString(), latest.current.marks))) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marksKey, made]);

  // ":w" saves, as vim users expect.
  useEffect(() => {
    Vim.defineEx('write', 'w', () => save.current());
  }, []);

  const shown = path ? path.slice(root.length + 1) : '';
  return (
    <div
      className="code"
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'p') {
          e.preventDefault();
          setFinding(true);
        }
      }}
    >
      <div className="code-bar">
        <button type="button" className="btn code-file" title="Go to file (Cmd+P or Ctrl+P)" onClick={() => setFinding(true)}>
          {shown || 'Go to file…'}
          {dirty && <span className="dot" aria-label="unsaved changes" />}
        </button>
        <span className="hint" role="status">{status}</span>
        {path && !image && <button type="button" className="btn" disabled={!dirty} onClick={() => save.current()}>Save</button>}
        <label className="code-vim" title="Use vim keys in the editor">
          <input
            type="checkbox"
            checked={vimOn}
            onChange={(e) => {
              setVimOn(e.target.checked);
              localStorage.setItem(VIM_KEY, e.target.checked ? '1' : '0');
            }}
          />
          vim
        </label>
      </div>
      <div className="code-main">
      <div className="code-pane">
      {!path && (
        <p className="hint">
          {files ? `${files.length} files in ${root}. ` : ''}Press Cmd+P (Ctrl+P) with the pointer in this panel.
        </p>
      )}
      {image && <div className="code-image"><img src={image} alt={shown} /></div>}
      <div
        className="code-host"
        ref={host}
        hidden={!!image || !path}
        onClick={(e) => {
          const mark = (e.target as HTMLElement).closest<HTMLElement>('mark[data-hl], mark[data-child]');
          if (mark?.dataset.child) onOpen(mark.dataset.child, mark.getBoundingClientRect());
          else if (mark?.dataset.hl) onHighlight(mark.dataset.hl, mark.getBoundingClientRect());
        }}
        onMouseOver={(e) => {
          const mark = (e.target as HTMLElement).closest<HTMLElement>('mark[data-hl], mark[data-child]:not(.detached)');
          if (mark) onHover((mark.dataset.hl ?? mark.dataset.child)!, mark.getBoundingClientRect());
        }}
        onMouseOut={(e) => {
          if ((e.target as HTMLElement).closest('mark[data-hl], mark[data-child]')) onHover(null);
        }}
      />
      </div>
      </div>
      {finding && files && <Palette files={files} onPick={open} onClose={() => setFinding(false)} />}
    </div>
  );
}

/**
 * The first column of a code session: the repository's files as a folding tree.
 * Choosing a file opens it in the next column, as a panel of its own.
 */
export function CodeFolder({ node }: { node: TreeNode }) {
  const ws = useWorkspace();
  const root = node.code!.root;
  const [files, setFiles] = useState<WorkspaceFile[] | null>(null);
  const [status, setStatus] = useState('');
  useEffect(() => {
    if (!root) return;
    const read = () => void listRoot(root).then(setFiles, (e) => setStatus(`The folder could not be read: ${e instanceof Error ? e.message : String(e)}`));
    read();
    // A command or the model may have added or removed files.
    window.addEventListener(FILES_CHANGED, read);
    return () => window.removeEventListener(FILES_CHANGED, read);
  }, [root]);
  // The file shown in the next column is marked in the list.
  const shown = ws.trail[1]?.parentId === node.id ? ws.trail[1].code?.file : undefined;
  const open = (file: WorkspaceFile) => {
    const there = [...ws.idx.byId.values()].find((n) => n.parentId === node.id && n.code?.file === file.path);
    if (there) return ws.select(there.id, { focus: true });
    void ws.attach(node.id, { title: file.name.split('/').pop() ?? file.name, code: { root, file: file.path } });
  };
  return (
    <div className="code-folder">
      {status && <p className="hint">{status}</p>}
      {files ? <FileTree files={files} current={shown} onPick={open} /> : !status && <p className="hint">Reading the folder…</p>}
    </div>
  );
}
