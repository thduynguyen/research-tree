// The right-click menu on links. The toolbar icon's list is in popup.js.
import { read } from './shared.js';

// The right-click menu on a link: the page or PDF the link points to, into the project of the app's tab.
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: 'read-link', title: 'Read link in Research Tree', contexts: ['link'] });
});
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'read-link') read(info.linkUrl, undefined, tab ? tab.index + 1 : undefined);
});
