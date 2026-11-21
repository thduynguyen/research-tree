import { useEffect, useRef, useState } from 'react';
import { isBusy, sendMessage, stop, useLive } from '../chat';
import { slashCommands } from '../folder';
import { realProviders } from '../providers';
import { DEMO_MODEL, defaultModel, isReady, useSettings } from '../settings';
import type { DocScope, ModelRef, ProviderId, TreeNode } from '../types';
import { useWorkspace } from '../workspace';

const encode = (m: ModelRef) => `${m.provider}|${m.model}`;
const decode = (v: string): ModelRef => {
  const i = v.indexOf('|');
  return { provider: v.slice(0, i) as ProviderId, model: v.slice(i + 1) };
};

const ACCESS: Record<string, string> = {
  ask: 'answer only',
  read: 'may read the project folder',
  auto: 'may change files and run commands, without asking',
};

export function Composer({ node, autoFocus }: { node: TreeNode; autoFocus: boolean }) {
  const settings = useSettings();
  const ws = useWorkspace();
  // The paper this conversation is about, if any: the nearest PDF above it in the tree.
  let paper: TreeNode | undefined;
  for (let cur = node.parentId ? ws.idx.byId.get(node.parentId) : undefined; cur && !paper; cur = cur.parentId ? ws.idx.byId.get(cur.parentId) : undefined) {
    if (cur.doc) paper = cur;
  }
  useLive();
  const busy = isBusy(node.id);
  const [text, setText] = useState('');
  const [picked, setPicked] = useState<ModelRef | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (autoFocus) input.current?.focus();
  }, [autoFocus]);

  const usable = (m?: ModelRef | null) => !!m && isReady(settings, m.provider);
  const model = (usable(picked) ? picked : usable(node.model) ? node.model : defaultModel())!;

  // A local server may offer to work in the project's folder; the choice is per conversation.
  const levels = model.provider === 'custom' ? settings.custom?.levels ?? [] : [];
  const access = node.access && levels.includes(node.access) ? node.access : 'ask';

  // At the full level the server's tool takes slash commands; typing "/" lists them.
  const [commands, setCommands] = useState<string[]>([]);
  const [choice, setChoice] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    if (access === 'auto') void slashCommands().then(setCommands);
  }, [access]);
  const typed = access === 'auto' && !dismissed && /^\/[^\s]*$/.test(text) ? text.slice(1).toLowerCase() : null;
  const matches = typed === null ? [] : commands.filter((c) => c.toLowerCase().includes(typed)).sort((a, b) => Number(b.toLowerCase().startsWith(typed)) - Number(a.toLowerCase().startsWith(typed))).slice(0, 8);
  const pick = Math.min(choice, matches.length - 1);
  const complete = (name: string) => {
    setText(`/${name} `);
    input.current?.focus();
  };

  const send = () => {
    const value = text.trim();
    if (!value || busy) return;
    setText('');
    void sendMessage(node.id, value, model);
  };

  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      {matches.length > 0 && (
        <ul className="commands" role="listbox" aria-label="Commands">
          {matches.map((name, i) => (
            <li key={name} role="option" aria-selected={i === pick}>
              <button type="button" tabIndex={-1} className={i === pick ? 'on' : ''} onMouseDown={(e) => e.preventDefault()} onClick={() => complete(name)}>
                /{name}
              </button>
            </li>
          ))}
        </ul>
      )}
      <textarea
        ref={input}
        aria-label="Message"
        rows={2}
        value={text}
        placeholder={node.parentId ? 'Ask in this branch' : 'Ask anything'}
        onChange={(e) => {
          setText(e.target.value);
          setChoice(0);
          setDismissed(false);
        }}
        onKeyDown={(e) => {
          if (matches.length && !e.nativeEvent.isComposing) {
            const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
            if (step) {
              e.preventDefault();
              setChoice((pick + step + matches.length) % matches.length);
              return;
            }
            // Enter sends a command typed in full; otherwise it, like Tab, fills in the chosen one.
            if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && matches[pick] !== text.slice(1))) {
              e.preventDefault();
              complete(matches[pick]);
              return;
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              setDismissed(true);
              return;
            }
          }
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            send();
          }
        }}
      />
      {paper && (
        <label className="scope">
          Paper context
          <select
            value={node.scope ?? 'paper'}
            title="How much of the paper the model is given with each message"
            onChange={(e) => void ws.setScope(node.id, e.target.value as DocScope)}
          >
            <option value="paper">the whole paper, cached{paper.doc!.pages ? ` (${paper.doc!.pages} pages)` : ''}</option>
            <option value="page">only the passage's page and page 1</option>
            <option value="none">only the passage</option>
          </select>
        </label>
      )}
      {levels.length > 1 && (
        <label className={`scope${access === 'auto' ? ' danger' : ''}`}>
          On this computer
          <select
            value={access}
            title="What the model may do in this project's folder on your computer"
            onChange={(e) => void ws.setAccess(node.id, e.target.value)}
          >
            {levels.map((l) => <option key={l} value={l}>{ACCESS[l] ?? l}</option>)}
          </select>
        </label>
      )}
      <div className="composer-row">
        <select aria-label="Model" value={encode(model)} onChange={(e) => setPicked(decode(e.target.value))}>
          {realProviders.map((p) =>
            isReady(settings, p.id) ? (
              <optgroup key={p.id} label={p.label}>
                {(settings.models[p.id] ?? []).map((m) => (
                  <option key={m.id} value={encode({ provider: p.id, model: m.id })}>
                    {m.id}
                  </option>
                ))}
              </optgroup>
            ) : null,
          )}
          <option value={encode(DEMO_MODEL)}>Demo (no AI)</option>
        </select>
        {busy ? (
          <button type="button" className="btn" onClick={() => stop(node.id)}>
            Stop
          </button>
        ) : (
          <button type="submit" className="btn primary" disabled={!text.trim()}>
            Send
          </button>
        )}
      </div>
    </form>
  );
}
