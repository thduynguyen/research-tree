// Sends the page you are on, or a link you choose, to Research Tree.
// It reads nothing from pages: only the address of the tab or link you act on.

const DEFAULT_APP = 'http://127.0.0.1:8765/';

async function appAddress() {
  const { app } = await chrome.storage.sync.get('app');
  return (app || DEFAULT_APP).replace(/\/?$/, '/');
}

async function read(address, next) {
  if (!/^https?:\/\//i.test(address || '')) return;
  const app = await appAddress();
  const sent = `open=${encodeURIComponent(address)}`;
  // A tab already showing the app is handed the page and brought forward. Only the part of its
  // address after "#" changes, so the app does not reload. The time makes each hand-over distinct.
  let open = [];
  try {
    open = await chrome.tabs.query({ url: `${app}*` });
  } catch {
    // The app is at an address this extension may not look for among tabs: a new tab it is.
  }
  const tab = open.find((t) => t.url && t.url.split(/[?#]/)[0] === app);
  if (tab) {
    await chrome.tabs.update(tab.id, { url: `${app}#${sent}&at=${Date.now()}`, active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    return;
  }
  await chrome.tabs.create({ url: `${app}?${sent}`, index: next });
}

// The toolbar icon: the page in this tab.
chrome.action.onClicked.addListener((tab) => read(tab.url, tab.index + 1));

// The right-click menu on a link: the page or PDF the link points to.
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: 'read-link', title: 'Read link in Research Tree', contexts: ['link'] });
});
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'read-link') read(info.linkUrl, tab ? tab.index + 1 : undefined);
});
