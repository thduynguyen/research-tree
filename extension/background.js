// Sends the page you are on, or a link you choose, to Research Tree.
// It reads nothing from pages: only the address of the tab or link you act on.

const DEFAULT_APP = 'http://127.0.0.1:8765/';

async function appAddress() {
  const { app } = await chrome.storage.sync.get('app');
  return (app || DEFAULT_APP).replace(/\/?$/, '/');
}

async function read(address, next) {
  if (!/^https?:\/\//i.test(address || '')) return;
  await chrome.tabs.create({ url: `${await appAddress()}?open=${encodeURIComponent(address)}`, index: next });
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
