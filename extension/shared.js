// What the toolbar popup and the right-click menu share: finding the app's tabs and handing a page to one.
// Sends the page you are on, or a link you choose, to Research Tree.
// It reads nothing from the pages you browse: only the address of the tab or link you act on.
// From tabs showing the app (on this computer's own addresses) it reads the list of projects.

const DEFAULT_APP = 'http://127.0.0.1:8765/';

export async function appAddress() {
  const { app } = await chrome.storage.sync.get('app');
  return (app || DEFAULT_APP).replace(/\/?$/, '/');
}

/** The tabs showing the app, each with the project it is on, and the projects the app has. */
export async function appTabs() {
  const app = await appAddress();
  let tabs = [];
  try {
    tabs = (await chrome.tabs.query({ url: `${app}*` })).filter((t) => t.url && t.url.split(/[?#]/)[0] === app);
  } catch {
    // The app is at an address this extension may not look for among tabs.
  }
  let projects = null;
  const open = [];
  for (const tab of tabs) {
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => ({ projects: localStorage.getItem('rt.projects'), current: sessionStorage.getItem('rt.project') }),
      });
      projects ??= JSON.parse(result.projects || 'null');
      open.push({ tab, project: result.current || 'none' });
    } catch {
      open.push({ tab, project: null });
    }
  }
  // Remembered, to offer the list when no tab shows the app.
  if (projects) await chrome.storage.local.set({ projects });
  else projects = (await chrome.storage.local.get('projects')).projects ?? [];
  return { app, open, projects };
}

/**
 * Opens an address in the app, in the named project ('none' for the sessions outside any; left out
 * for whichever project the receiving tab is on). A tab already on that project is used first, then
 * any tab showing the app, then a new one. A tab in use is handed the page through the part of its
 * address after "#", so the app does not reload; the time makes each hand-over distinct.
 */
export async function read(address, project, next) {
  if (!/^https?:\/\//i.test(address || '')) return;
  const { app, open } = await appTabs();
  const sent = `open=${encodeURIComponent(address)}${project ? `&project=${encodeURIComponent(project)}` : ''}`;
  const target = (project && open.find((o) => o.project === project)) || open[0];
  if (target) {
    await chrome.tabs.update(target.tab.id, { url: `${app}#${sent}&at=${Date.now()}`, active: true });
    await chrome.windows.update(target.tab.windowId, { focused: true });
    return;
  }
  await chrome.tabs.create({ url: `${app}?${sent}`, index: next });
}
