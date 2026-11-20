import { dumpDb, loadDump, setDirty } from './db';
import { exportFiles, mergeDumps } from './export';
import type { GithubConfig } from './settings';
import type { DbDump } from './types';

const DB_PATH = 'research-tree/db.json';

function gh(cfg: GithubConfig, path: string, init: RequestInit = {}) {
  return fetch(`https://api.github.com/repos/${cfg.repo}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });
}

async function ghJson<T>(cfg: GithubConfig, path: string, init: RequestInit = {}): Promise<T> {
  const res = await gh(cfg, path, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`GitHub ${res.status} on ${path.split('?')[0]}: ${body.message ?? res.statusText}`);
  }
  return res.json();
}

const post = (body: unknown, method = 'POST'): RequestInit => ({ method, body: JSON.stringify(body) });

function toBase64(text: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function fetchRemote(cfg: GithubConfig): Promise<DbDump | null> {
  const res = await gh(cfg, `/contents/${DB_PATH}?ref=${encodeURIComponent(cfg.branch)}`, {
    headers: { Accept: 'application/vnd.github.raw+json' },
  });
  if (res.status === 404) return null; // first push, or an empty repo
  if (!res.ok) throw new Error(`GitHub ${res.status} reading ${DB_PATH}`);
  return res.json();
}

/** Brings in whatever another device pushed. Local unpushed work is kept. */
export async function pull(cfg: GithubConfig): Promise<boolean> {
  const remote = await fetchRemote(cfg);
  if (!remote) return false;
  await loadDump(mergeDumps(await dumpDb(), remote));
  return true;
}

/** Merges the remote copy in, then writes the result to the repo as one commit. */
export async function push(cfg: GithubConfig): Promise<void> {
  const remote = await fetchRemote(cfg);
  const local = await dumpDb();
  const merged = remote ? mergeDumps(local, remote) : local;
  if (remote) await loadDump(merged);

  const refPath = `/git/ref/heads/${encodeURIComponent(cfg.branch)}`;
  let refRes = await gh(cfg, refPath);
  if (refRes.status === 404 || refRes.status === 409) {
    // A repo with no commits has no branch to build on: create the first commit.
    await ghJson(cfg, '/contents/research-tree/README.md', post({
      message: 'Start Research Tree data',
      content: toBase64('Data written by Research Tree. db.json is the source; sessions/ is a readable copy.\n'),
    }, 'PUT'));
    refRes = await gh(cfg, refPath);
  }
  if (!refRes.ok) throw new Error(`Branch "${cfg.branch}" was not found in ${cfg.repo}.`);
  const head = ((await refRes.json()) as { object: { sha: string } }).object.sha;

  const commit = await ghJson<{ tree: { sha: string } }>(cfg, `/git/commits/${head}`);
  const tree = await ghJson<{ sha: string }>(cfg, '/git/trees', post({
    base_tree: commit.tree.sha,
    tree: Object.entries(exportFiles(merged)).map(([path, content]) => ({
      path, mode: '100644', type: 'blob', content,
    })),
  }));
  const next = await ghJson<{ sha: string }>(cfg, '/git/commits', post({
    message: `Research Tree sync ${new Date().toISOString()}`,
    tree: tree.sha,
    parents: [head],
  }));
  await ghJson(cfg, `/git/refs/heads/${encodeURIComponent(cfg.branch)}`, post({ sha: next.sha }, 'PATCH'));
  await setDirty(false);
}
