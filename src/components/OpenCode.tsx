import { useState } from 'react';
import { createSession, db, dumpDb, putNode } from '../db';
import { cloneRepo, sessionFolder } from '../folder';

interface Props {
  projectId?: string;
  onClose: () => void;
  onOpen: (sessionId: string) => void;
}

/** Starts a session on a git repository: clones it into the session's own folder and opens its code. */
export function OpenCode({ projectId, onClose, onOpen }: Props) {
  const [url, setUrl] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const clone = async () => {
    const address = url.trim();
    const name = address.replace(/\/+$/, '').replace(/\.git$/, '').split(/[/:]/).pop() ?? '';
    if (!name) return setStatus('Give the address of a git repository.');
    setBusy(true);
    setStatus('Cloning…');
    // The session comes first, because the code goes into its folder.
    const session = await createSession(projectId, undefined, { title: name, code: { root: '' } });
    try {
      const root = await cloneRepo(address, `${sessionFolder(session, await dumpDb())}/${name}`);
      const node = await db.nodes.get(session.rootNodeId);
      if (node) await putNode({ ...node, code: { root } });
      onOpen(session.id);
    } catch (e) {
      // Nothing was cloned: the session made for it is taken back.
      await db.sessions.delete(session.id);
      await db.nodes.delete(session.rootNodeId);
      setStatus(`The repository could not be cloned: ${e instanceof Error ? e.message : String(e)}`);
      setBusy(false);
    }
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label="Open code">
        <div className="dialog-head">
          <h2>Open code</h2>
          <button className="btn" disabled={busy} onClick={onClose}>Close</button>
        </div>
        <p className="hint">
          Clones a git repository into a new session's folder in the workspace and opens its files. The clone keeps its
          own history and remote; the workspace's repository leaves it out.
        </p>
        <div className="card-static">
          <label htmlFor="code-url"><strong>Repository address</strong></label>
          <form
            className="field-row"
            onSubmit={(e) => {
              e.preventDefault();
              if (!busy) void clone();
            }}
          >
            <input id="code-url" value={url} placeholder="https://github.com/owner/name" spellCheck={false} autoFocus onChange={(e) => setUrl(e.target.value)} />
            <button className="btn primary" type="submit" disabled={busy}>Clone</button>
          </form>
        </div>
        <div className="status" role="status">{status}</div>
      </div>
    </div>
  );
}
