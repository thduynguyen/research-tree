// Tells the interface that it is running in the desktop app, where a web panel is a real browser.
const { contextBridge } = require('electron');
contextBridge.exposeInMainWorld('researchTreeDesktop', { version: 1 });
