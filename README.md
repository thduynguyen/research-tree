# Research Tree

A reading and thinking tool where every question can branch. Read a paper,
select a passage, and highlight it, write a note on it, or ask an AI about it.
Each note or conversation becomes a branch anchored to that passage, and you
can branch again from any reply or note. The result is a tree you can scroll
through: sideways for depth, up and down across the branches at one level.

It runs entirely in the browser. There is no server and no account.

## What it does

- **PDF reader.** Open a PDF from a link or a file. arXiv links load directly.
  Zoom with the buttons or by pinching, and search the whole document.
- **Highlights, notes and questions.** Select text in a PDF, an AI reply or a
  note. One click highlights in one of four colours; "Note" opens a written
  annotation (Markdown and LaTeX math); "Ask AI" opens a conversation about
  the passage.
- **A tree, not a thread.** Branches open in columns beside what they came
  from. A branch's own branches stay closed until you open them.
- **Projects and sessions.** Each paper or chat is a session; sessions are
  grouped into projects.
- **Your choice of model.** Claude, Gemini or OpenAI, with your own API key.
- **Your data stays with you.** Everything is stored in the browser. PDFs are
  cached locally and never uploaded; only their link and a fingerprint are
  kept with your notes. Optionally, sessions can be pushed to a private GitHub
  repository of yours as JSON plus readable Markdown.

## Run it

Requires Node.js 20 or later.

```sh
npm install
npm run dev      # development server
npm test         # unit tests
npm run build    # static site in dist/
```

The built site is plain static files and can be hosted anywhere.

## Connecting a model

Open **Settings** in the side panel.

- **API key.** Paste a key for Gemini, Claude or OpenAI. Keys are kept in the
  browser and sent only to that provider.
- **Your own server.** Give the address of any server that speaks the OpenAI
  chat format, such as a model running on your computer with Ollama, LM Studio
  or llama.cpp. The address ends in `/v1`; a key is optional. The server has to
  allow requests from the page's address (for Ollama, set `OLLAMA_ORIGINS`).
  A server may also offer to work in a folder on your computer: reading a
  project's files, changing them and running commands (asking first, or not),
  keeping sessions there as files, and running a shell command you type after
  `!`. The choice appears under the message box and is off by default.
- **Demo.** A built-in stand-in that needs no key, for trying the interface.

A question about a paper sends the paper's text with it, placed first so that
the provider's prompt cache can bill repeats at a reduced rate. Each
conversation can instead send only the passage's page, or only the passage.

## Status

This is early software. In particular:

- The Claude, Gemini and OpenAI API-key connections have had little real use.
- Sync to GitHub is implemented but has not been exercised.
- Scanned PDFs with no text layer can be read but not highlighted.
- Phone layouts are untested.

## How it is built

React and TypeScript, built with Vite. Storage is IndexedDB through Dexie.
PDFs are rendered with PDF.js, Markdown with marked, and math with KaTeX.
The logic for the tree, the text sent to a model, and syncing lives in
`src/tree.ts`, `src/workspace.ts` and `src/export.ts`, and is covered by the
tests in `src/tree.test.ts`.

## Licence

MIT. See [LICENSE](LICENSE).
