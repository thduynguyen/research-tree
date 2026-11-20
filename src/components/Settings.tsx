import { useState } from 'react';
import { keyedProviders, type Provider } from '../providers';
import { updateSettings, useSettings, type GithubConfig } from '../settings';

function ProviderCard({ provider }: { provider: Provider }) {
  const settings = useSettings();
  const saved = settings.keys[provider.id] ?? '';
  const [key, setKey] = useState(saved);
  const [status, setStatus] = useState(saved ? `Saved · ${settings.models[provider.id]?.length ?? 0} models` : '');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const value = key.trim();
    if (!value) {
      const keys = { ...settings.keys };
      delete keys[provider.id];
      updateSettings({ keys, models: { ...settings.models, [provider.id]: [] } });
      setStatus('Removed');
      return;
    }
    setBusy(true);
    setStatus('Checking…');
    try {
      const models = await provider.listModels(value);
      updateSettings({
        keys: { ...settings.keys, [provider.id]: value },
        models: { ...settings.models, [provider.id]: models },
      });
      setStatus(`Works · ${models.length} models`);
    } catch (e) {
      setStatus(`Not accepted: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const inputId = `key-${provider.id}`;
  return (
    <div className="card-static">
      <div className="card-head">
        <label htmlFor={inputId}><strong>{provider.label}</strong></label>
        <a href={provider.keyUrl} target="_blank" rel="noopener noreferrer">Get a key</a>
      </div>
      <div className="field-row">
        <input
          id={inputId}
          type="password"
          autoComplete="off"
          value={key}
          placeholder={provider.keyHint}
          onChange={(e) => setKey(e.target.value)}
        />
        <button className="btn primary" disabled={busy} onClick={() => void save()}>Check and save</button>
      </div>
      <div className="status" role="status">{status}</div>
    </div>
  );
}

interface Props {
  onClose: () => void;
  onPull: () => void;
  onPush: () => void;
  syncStatus: string;
}

export function Settings({ onClose, onPull, onPush, syncStatus }: Props) {
  const settings = useSettings();
  const [gh, setGh] = useState<GithubConfig>(settings.github ?? { repo: '', branch: 'main', token: '' });
  const ready = /^[^/\s]+\/[^/\s]+$/.test(gh.repo.trim()) && !!gh.token.trim() && !!gh.branch.trim();

  const saveGh = () => {
    const clean = { repo: gh.repo.trim(), branch: gh.branch.trim(), token: gh.token.trim() };
    updateSettings({ github: ready ? clean : undefined });
    return ready;
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label="Settings">
        <div className="dialog-head">
          <h2>Settings</h2>
          <button className="btn" onClick={onClose}>Close</button>
        </div>

        <h3>AI keys</h3>
        <p className="hint">
          One provider is enough. Keys stay in this browser and are sent only to that provider; they are never pushed to git.
          Gemini has a free tier, so it is the quickest to start with.
        </p>
        {keyedProviders.map((p) => <ProviderCard key={p.id} provider={p} />)}

        <h3>Git sync</h3>
        <p className="hint">
          Pushes all sessions to a private GitHub repository of yours as <code>research-tree/db.json</code> plus one
          readable Markdown file per session. Create a{' '}
          <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener noreferrer">
            fine-grained token
          </a>{' '}
          limited to that repository, with Contents set to read and write.
        </p>
        <div className="card-static">
          <div className="field-grid">
            <label htmlFor="gh-repo">Repository</label>
            <input id="gh-repo" value={gh.repo} placeholder="owner/name" onChange={(e) => setGh({ ...gh, repo: e.target.value })} />
            <label htmlFor="gh-branch">Branch</label>
            <input id="gh-branch" value={gh.branch} onChange={(e) => setGh({ ...gh, branch: e.target.value })} />
            <label htmlFor="gh-token">Token</label>
            <input id="gh-token" type="password" autoComplete="off" value={gh.token} placeholder="github_pat_…" onChange={(e) => setGh({ ...gh, token: e.target.value })} />
          </div>
          <div className="field-row">
            <button className="btn" onClick={saveGh}>Save</button>
            <button className="btn" disabled={!ready} onClick={() => saveGh() && onPull()}>Pull</button>
            <button className="btn primary" disabled={!ready} onClick={() => saveGh() && onPush()}>Push</button>
          </div>
          <div className="status" role="status">{syncStatus}</div>
        </div>
      </div>
    </div>
  );
}
