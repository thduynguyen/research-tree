import { indentWithTab } from '@codemirror/commands';
import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { Compartment, EditorState } from '@codemirror/state';
import { oneDark } from '@codemirror/theme-one-dark';
import { EditorView, keymap } from '@codemirror/view';
import { Vim, vim } from '@replit/codemirror-vim';
import { basicSetup } from 'codemirror';
import { useEffect, useMemo, useRef, useState } from 'react';
import { putNode } from '../db';
import { listRoot, readWorkspaceFile, saveWorkspaceFile, type WorkspaceFile } from '../folder';
import type { TreeNode } from '../types';

const VIM_KEY = 'rt.vim';
const IMAGE = /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i;

/**
 * How well a file's path matches what was typed, or -1 when it does not: every
 * typed letter must appear in order; letters in the file's own name, at the
 * start of a word, and next to each other count for more.
 */
export function fuzzyScore(path: string, typed: string): number {
  const text = path.toLowerCase();
  const query = typed.toLowerCase().replace(/\s+/g, '');
  if (!query) return 0;
  const nameAt = text.lastIndexOf('/') + 1;
  let score = 0;
  let from = 0;
  let last = -2;
  for (const ch of query) {
    const at = text.indexOf(ch, from);
    if (at < 0) return -1;
    score += 1;
    if (at === last + 1) score += 3;
    if (at >= nameAt) score += 2;
    if (at === 0 || '/._-'.includes(text[at - 1])) score += 3;
    last = at;
    from = at + 1;
  }
  return score - text.length / 200;
}

/** Finds a file by a few letters of its name, as editors do with their "go to file" box. */
function Palette({ files, onPick, onClose }: { files: WorkspaceFile[]; onPick: (file: WorkspaceFile) => void; onClose: () => void }) {
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
            } else if (e.key === 'Enter' && found[pick]) onPick(found[pick].file);
          }}
        />
        <ul role="listbox">
          {found.map(({ file }, i) => {
            const cut = file.name.lastIndexOf('/') + 1;
            return (
              <li key={file.path} role="option" aria-selected={i === pick}>
                <button type="button" className={i === pick ? 'on' : ''} onMouseDown={(e) => e.preventDefault()} onClick={() => onPick(file)}>
                  <strong>{file.name.slice(cut)}</strong>
                  <span>{file.name.slice(0, cut)}</span>
                </button>
              </li>
            );
          })}
          {!found.length && <li className="hint">No file matches.</li>}
        </ul>
      </div>
    </div>
  );
}

/**
 * A folder of source code: one file shown at a time in an editor, with syntax
 * colours by language, a "go to file" box, optional vim keys, and saving.
 */
export function CodeView({ node }: { node: TreeNode }) {
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

  useEffect(() => {
    void listRoot(root).then(setFiles, (e) => setStatus(`The folder could not be read: ${e instanceof Error ? e.message : String(e)}`));
  }, [root]);

  const open = (file: WorkspaceFile) => {
    setFinding(false);
    if (file.path !== path) void putNode({ ...node, code: { root, file: file.path } });
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
              ...(dark ? [oneDark] : []),
              EditorView.updateListener.of((update) => {
                if (update.docChanged) {
                  setDirty(true);
                  setStatus('');
                }
              }),
            ],
          }),
        });
        view.current = made;
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
      {!path && (
        <p className="hint">
          {files ? `${files.length} files in ${root}. ` : ''}Choose a file with the button above, or press Cmd+P (Ctrl+P) with the pointer in this panel.
        </p>
      )}
      {image && <div className="code-image"><img src={image} alt={shown} /></div>}
      <div className="code-host" ref={host} hidden={!!image || !path} />
      {finding && files && <Palette files={files} onPick={open} onClose={() => setFinding(false)} />}
    </div>
  );
}
