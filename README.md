# Codeforge

A local-first AI coding companion: a code editor with syntax highlighting
next to a chat pane wired to the Gemini API. Pure HTML/CSS/JS, no build
step, no backend — everything (your files, chat history, API key) lives
in your browser's local storage. The only network call this app makes is
directly from your browser to Google's Gemini API.

## Quick start

**Easiest — just open it:**
Double-click `index.html`. The editor, tabs, and chat all work
immediately. (Two PWA-only features — installing to your home screen and
working fully offline — need the app to be loaded over `http://` or
`https://`, because browsers disable service workers on `file://` pages.
Everything else, including saving your API key and chatting with Gemini,
works fine straight from disk.)

**Full PWA experience (installable + offline):**
Serve the folder with any static file server — no build step, no
dependencies to install. Pick whichever you have on hand:

```bash
# Python (usually already installed)
cd codeforge
python3 -m http.server 8080
# then open http://localhost:8080

# Node
npx serve codeforge

# PHP
php -S localhost:8080 -t codeforge
```

Then open the printed `localhost` URL. Your browser will offer to
install it (or use the install icon in the title bar / your browser's
address-bar install button). After the first load it keeps working with
no connection — only sending a message to the assistant needs the
internet.

You can also drop the whole `codeforge` folder onto any static host
(GitHub Pages, Netlify, Vercel, Cloudflare Pages, a plain S3 bucket) for
a permanent installable URL — there's nothing to configure server-side.

## Get a Gemini API key

1. Go to [aistudio.google.com/apikey](https://aistudio.google.com/apikey)
2. Create a key
3. In Codeforge, click the gear icon (top right) and paste it in

The key is stored only in your browser's `localStorage`, scoped to
wherever you're hosting the app. It is never sent anywhere except
directly to `generativelanguage.googleapis.com` when you send a chat
message.

## Features

- **Multi-file tabs** — new file, rename (double-click a tab), close,
  download to disk. Autosaves to local storage as you type.
- **Syntax highlighting** for JavaScript/JSX, Python, HTML, CSS, C,
  C++, Java, Shell, and Markdown (CodeMirror 5, bundled locally).
- **Chat assistant** — streams responses from Gemini as they generate.
  Toggle "use file" to include your current file as context
  automatically. Code blocks in replies get Copy and Insert-at-cursor
  buttons.
- **Per-file conversations** — each open file keeps its own chat
  thread, so switching tabs switches context.
- **Run HTML files** — when a file's language is set to HTML, a "Run"
  button appears in the editor toolbar. It opens a sandboxed preview
  pane below the editor that live-updates as you type, plus buttons to
  refresh, pop the preview into its own tab, or close it.
- **Model + theme picker** in Settings (gemini-3.8-flash /
  gemini-3.7-flash / gemini-3.5-flash-lite / gemini-3.1-pro; light/dark
  editor theme).
- **Fully offline-capable** once installed as a PWA — the app shell,
  fonts, and editor are all cached locally; only live chat needs a
  connection.

## Project structure

```
codeforge/
  index.html          — app shell
  css/                 — styles + CodeMirror + custom syntax theme
  js/app.js            — all app logic (editor, tabs, chat, Gemini calls)
  js/codemirror/        — CodeMirror 5 (vendored, no CDN dependency)
  fonts/                — IBM Plex Sans/Mono (vendored .woff2)
  icons/                — app icons
  manifest.json         — PWA manifest
  sw.js                 — service worker (offline caching)
```

## Notes

- This is a static site: nothing to `npm install`, nothing to build.
  Every file is plain HTML/CSS/JS committed as-is.
- If you edit any file after installing as a PWA, bump
  `CACHE_VERSION` at the top of `sw.js` so installed users pick up the
  change instead of a cached copy.
- Local storage has a per-origin size limit (typically 5–10MB in most
  browsers) — plenty for code files and chat history, but very large
  files may hit it.
