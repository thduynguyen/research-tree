# Read in Research Tree (browser extension)

A toolbar icon that opens the page or PDF you are on in Research Tree, and a
right-click entry on links ("Read link in Research Tree"). If a tab is already
showing the app, the page goes to that tab; otherwise a new one opens. It reads
nothing from pages; it only passes on the address of the tab or link you act
on, and looks for the app's tab among tabs on this computer's own addresses.

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
