# Read in Research Tree (browser extension)

A toolbar icon that sends the page or PDF you are on to Research Tree. Clicking
it lists your projects; choose one and the page opens there as a new session.
A project that a tab is already showing is listed first, and the page appears
in that tab; otherwise any tab showing the app is used, or a new one opens.
Enter picks the first in the list.

Right-clicking a link offers "Read link in Research Tree", which sends the
linked page or PDF to the project of the app's tab.

It reads nothing from the pages you browse: only the address of the tab or link
you act on. From tabs showing the app, on this computer's own addresses, it
reads the list of projects.

## Install (Chrome, Edge, Brave)

1. Open `chrome://extensions`.
2. Turn on "Developer mode" (top right).
3. Choose "Load unpacked" and pick this `extension` folder.
4. Pin the icon: the puzzle-piece button in the toolbar, then the pin next to
   "Read in Research Tree".

By default it sends pages to `http://127.0.0.1:8765/`, the copy of the app
served by the local helper. To use another address, right-click the icon,
choose "Options", and enter it.

After updating the extension's files, press the reload arrow on its card in
`chrome://extensions`. With the app at an address other than this computer's,
a new tab opens each time.
