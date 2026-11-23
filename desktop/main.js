// Research Tree as a desktop app: the same interface in a window of its own, with real browser
// panels inside it. The local helper, which gives the interface its terminal, files and git, is
// started along with the app when it is not already running.
const { app, BrowserWindow, session, shell } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = Number(process.env.RT_BRIDGE_PORT ?? 8765);
const APP_URL = `http://127.0.0.1:${PORT}/`;
const HELPER = process.env.RT_HELPER ?? path.join(os.homedir(), '.config', 'research-tree', 'bridge.mjs');

// Sites refuse sign-in from browsers that say they are embedded. The browser in the panels is a
// real Chromium, so it says so plainly, without the app's own name tacked on.
const plainAgent = (agent) => agent.replace(/\s(Electron|research-tree-desktop)\/\S+/g, '');

const answering = async () => {
  try {
    await fetch(`${APP_URL}v1/research-tree`, { signal: AbortSignal.timeout(1500) });
    return true; // any answer, even "not allowed", means the helper is there
  } catch {
    return false;
  }
};

let helper = null;
async function startHelper() {
  if (await answering()) return true;
  if (!fs.existsSync(HELPER)) return false;
  // The app's own program doubles as the Node that runs the helper, so nothing else need be installed.
  helper = spawn(process.execPath, [HELPER], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'ignore' });
  for (let i = 0; i < 40; i++) {
    if (await answering()) return true;
    await new Promise((done) => setTimeout(done, 250));
  }
  return false;
}

app.whenReady().then(async () => {
  // Sites opened in panels keep their sign-ins between launches, apart from the app's own storage.
  const web = session.fromPartition('persist:web');
  web.setUserAgent(plainAgent(web.getUserAgent()));

  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    title: 'Research Tree',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), webviewTag: true, contextIsolation: true },
  });
  if (await startHelper()) win.loadURL(APP_URL);
  else win.loadFile('missing.html');

  // A link that asks for a new window opens in the user's own browser. Inside a browser panel a
  // new window (a sign-in pop-up, say) opens within the app, with the same sign-ins.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() !== 'webview') return;
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/.test(url)) return { action: 'allow', overrideBrowserWindowOptions: { width: 560, height: 720, webPreferences: { partition: 'persist:web' } } };
      return { action: 'deny' };
    });
  });
});

app.on('window-all-closed', () => app.quit());
// A helper this app started ends with it; one that was already running is left alone.
app.on('quit', () => helper?.kill());
