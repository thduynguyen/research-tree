import { appTabs, read } from './shared.js';

const list = document.getElementById('list');
const note = document.getElementById('note');
const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

if (!/^https?:\/\//i.test(tab?.url ?? '')) {
  document.querySelector('h1').hidden = true;
  note.hidden = false;
  note.textContent = 'This tab is not a web page that can be read in Research Tree.';
} else {
  const { open, projects } = await appTabs();
  const shown = new Set(open.map((o) => o.project));
  // Projects a tab is showing come first: the page appears in that tab.
  const choices = [...projects.map((p) => ({ id: p.id, name: p.name })), { id: 'none', name: 'No project' }].sort((a, b) => Number(shown.has(b.id)) - Number(shown.has(a.id)));
  for (const choice of choices) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.textContent = choice.name;
    if (shown.has(choice.id)) {
      const mark = document.createElement('span');
      mark.textContent = 'open in a tab';
      button.append(mark);
    }
    button.addEventListener('click', async () => {
      await read(tab.url, choice.id, tab.index + 1);
      window.close();
    });
    item.append(button);
    list.append(item);
  }
  list.querySelector('button')?.focus();
  if (!projects.length && !open.length) {
    note.hidden = false;
    note.textContent = 'Projects are listed once Research Tree has been open in a tab.';
  }
}
