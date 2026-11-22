import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef, useState } from 'react';
import { projectFolderOf, shell } from '../folder';
import type { TreeNode } from '../types';

/**
 * A full terminal: a shell running on the user's computer, in the project's
 * folder, shown as it is. The shell belongs to this panel and keeps running
 * while the panel is out of view; coming back shows what it printed meanwhile.
 * Nothing typed or printed here is saved with the session.
 */
export function LiveTerminal({ node }: { node: TreeNode }) {
  const host = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState('Starting the shell…');
  // Raised to start a new shell after the last one ended.
  const [round, setRound] = useState(0);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const dark = matchMedia('(prefers-color-scheme: dark)').matches;
    const term = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      theme: dark ? { background: '#16181d', foreground: '#e6e8ec' } : { background: '#ffffff', foreground: '#16181d', cursor: '#16181d', selectionBackground: '#b5d0ff' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // Addresses printed in the terminal open in the browser when clicked.
    term.loadAddon(new WebLinksAddon((_event, uri) => window.open(uri, '_blank', 'noopener')));
    term.open(el);
    const stop = new AbortController();
    let alive = true;

    // Keys go out one after another, in the order typed.
    let sending: Promise<unknown> = Promise.resolve();
    const typed = term.onData((data) => {
      sending = sending.then(() => shell.input(node.id, data)).catch(() => undefined);
    });
    const size = () => {
      if (!el.clientWidth || !el.clientHeight) return;
      fit.fit();
      void shell.resize(node.id, term.cols, term.rows).catch(() => undefined);
    };
    const watcher = new ResizeObserver(size);

    void (async () => {
      try {
        fit.fit();
        await shell.open(node.id, await projectFolderOf(node.id), term.cols, term.rows);
        if (!alive) return;
        setStatus('');
        watcher.observe(el);
        term.focus();
        await shell.output(node.id, stop.signal, (bytes) => term.write(bytes));
        if (alive) setStatus('The shell ended.');
      } catch (e) {
        if (alive && !stop.signal.aborted) setStatus(`The terminal could not start: ${e instanceof Error ? e.message : String(e)}`);
      }
    })();

    return () => {
      alive = false;
      stop.abort();
      watcher.disconnect();
      typed.dispose();
      term.dispose();
    };
  }, [node.id, round]);

  return (
    <div className="live-terminal">
      <div className="xterm-host" ref={host} />
      {status && (
        <div className="live-status" role="status">
          {status}
          {status === 'The shell ended.' && <button className="btn" onClick={() => setRound(round + 1)}>Start a new one</button>}
        </div>
      )}
    </div>
  );
}
