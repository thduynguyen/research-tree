import { useEffect, useRef, useState } from 'react';
import { isBusy, sendMessage, stop, useLive } from '../chat';
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
      <textarea
        ref={input}
        aria-label="Message"
        rows={2}
        value={text}
        placeholder={node.parentId ? 'Ask in this branch' : 'Ask anything'}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
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
