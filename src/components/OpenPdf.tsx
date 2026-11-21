import { useEffect, useState } from 'react';
import { hasFolder, listWorkspace, readWorkspaceFile, WORKSPACE, type WorkspaceFile } from '../folder';
import { docRefOf, openPdf, pdfUrlOf, storeFile } from '../pdf';
import type { DocRef } from '../types';

interface Props {
  onClose: () => void;
  onOpen: (doc: DocRef) => void;
  /** The project's folder in the workspace, when a local server keeps one. */
  folder?: string;
}

/** Chooses the PDF a new session starts from: a file on this device, or a link. */
export function OpenPdf({ onClose, onOpen, folder }: Props) {
  const [url, setUrl] = useState('');
  const [status, setStatus] = useState('');

  const fromFile = async (file: File) => {
    setStatus('Reading the file…');
    try {
      const data = await file.arrayBuffer();
      const opened = await openPdf(data);
      await storeFile(opened, data);
      onOpen(docRefOf(opened, file.name.replace(/\.pdf$/i, '')));
    } catch (e) {
      setStatus(`That file could not be read as a PDF (${e instanceof Error ? e.message : String(e)}).`);
    }
  };

  // PDFs already in the project's folder, when there is one.
  const [inFolder, setInFolder] = useState<WorkspaceFile[] | null>(null);
  useEffect(() => {
    if (folder && hasFolder()) void listWorkspace(folder).then((files) => setInFolder(files.filter((f) => /\.pdf$/i.test(f.name))), () => setInFolder([]));
  }, [folder]);

  const fromWorkspace = async (file: WorkspaceFile) => {
    setStatus('Reading the file…');
    try {
      const data = await readWorkspaceFile(file.path);
      const opened = await openPdf(data.slice(0));
      await storeFile(opened, data);
      onOpen(docRefOf(opened, file.name.replace(/\.pdf$/i, ''), WORKSPACE + file.path));
    } catch (e) {
      setStatus(`That file could not be read as a PDF (${e instanceof Error ? e.message : String(e)}).`);
    }
  };

  const fromUrl = () => {
    const pdfUrl = pdfUrlOf(url.trim()) ?? (/^https?:\/\//.test(url.trim()) ? url.trim() : null);
    if (!pdfUrl) return setStatus('Enter a full link, starting with https://');
    // The reader loads it, and asks for the file if the site will not allow that.
    onOpen({ fingerprint: '', title: pdfUrl, url: pdfUrl, pages: 0 });
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label="Open a PDF">
        <div className="dialog-head">
          <h2>Open a PDF</h2>
          <button className="btn" onClick={onClose}>Close</button>
        </div>
        <p className="hint">
          Only the link, your highlights, notes and discussions are saved and synced. The PDF itself is kept on this
          device so it opens quickly.
        </p>

        <div className="card-static">
          <label htmlFor="pdf-url"><strong>From a link</strong></label>
          <form
            className="field-row"
            onSubmit={(e) => {
              e.preventDefault();
              fromUrl();
            }}
          >
            <input id="pdf-url" value={url} placeholder="https://arxiv.org/abs/1706.03762" onChange={(e) => setUrl(e.target.value)} />
            <button className="btn primary" type="submit">Open</button>
          </form>
          <div className="hint">arXiv links work directly. For other sites you may be asked for the downloaded file.</div>
        </div>

        <div className="card-static">
          <strong>From a file</strong>
          <label className="btn file">
            Choose a PDF file
            <input
              type="file"
              accept="application/pdf,.pdf"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void fromFile(file);
              }}
            />
          </label>
          <div className="hint">A file has no link, so to read it on another device you choose the same file there.</div>
        </div>

        {inFolder && (
          <div className="card-static">
            <strong>From the project folder</strong>
            {inFolder.length ? (
              <ul className="file-list">
                {inFolder.map((f) => (
                  <li key={f.path}>
                    <button type="button" className="link" onClick={() => void fromWorkspace(f)}>{f.name}</button>
                    <span className="hint">{f.size > 1048576 ? `${(f.size / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(f.size / 1024))} KB`}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="hint">No PDFs in {folder} yet. Put one in that folder of the workspace and it is listed here.</div>
            )}
            <div className="hint">A PDF kept in the workspace opens on every computer that has the workspace.</div>
          </div>
        )}

        <div className="status" role="status">{status}</div>
      </div>
    </div>
  );
}
