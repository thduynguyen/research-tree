# Research Tree desktop app

The same interface in a window of its own. What the desktop app adds: a web
panel is a real browser, so any site works in it, signed in and with its
scripts running, including the web versions of Claude, ChatGPT and Gemini.
Sign-ins made in web panels are remembered between launches.

It needs the local helper installed and set to serve the built interface (see
the helper's README). The app starts the helper if it is not running and stops
it again on quitting.

```sh
cd desktop
npm install
node node_modules/electron/install.js   # if the install step skipped Electron's download
npm start
```

This is an early version, run from source; it is not yet packaged as an
installable app.
