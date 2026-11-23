// A first test of the desktop app idea: can the web agents be signed in to and used inside a
// browser embedded in the app? One window, one embedded browser, three shortcuts.
const { app, BrowserWindow, session, shell } = require('electron');
const path = require('node:path');

// Sites refuse sign-in from browsers that say they are embedded. The embedded browser is a real
// Chromium, so it says so plainly, without the app's own name tacked on.
const plainAgent = (agent) => agent.replace(/\s(Electron|research-tree-desktop)\/\S+/g, '');

app.whenReady().then(() => {
  // What is signed in to here is remembered between launches, apart from the app's own pages.
  const web = session.fromPartition('persist:web');
  web.setUserAgent(plainAgent(web.getUserAgent()));

  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'Research Tree: sign-in test',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), webviewTag: true, contextIsolation: true },
  });
  win.loadFile('test.html');

  // A page that opens a new window (a sign-in pop-up, say) gets one inside the app, with the same
  // remembered sign-ins, so that the hand-back to the page that asked works.
  app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() !== 'webview') return;
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/.test(url)) return { action: 'allow', overrideBrowserWindowOptions: { width: 560, height: 720, webPreferences: { partition: 'persist:web' } } };
      shell.openExternal(url);
      return { action: 'deny' };
    });
  });
});

app.on('window-all-closed', () => app.quit());
