// Codeforge service worker
// Precaches the entire app shell so it works fully offline after first
// load. Bump CACHE_VERSION whenever any cached file changes so clients
// pick up the new build instead of serving stale assets forever.
const CACHE_VERSION = "codeforge-v1";

const PRECACHE_URLS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./css/codemirror.css",
  "./css/style.css",
  "./css/theme.css",
  "./fonts/ibm-plex-mono-400.woff2",
  "./fonts/ibm-plex-mono-500.woff2",
  "./fonts/ibm-plex-sans-400.woff2",
  "./fonts/ibm-plex-sans-500.woff2",
  "./fonts/ibm-plex-sans-600.woff2",
  "./fonts/ibm-plex-sans-700.woff2",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./js/app.js",
  "./js/codemirror/codemirror.js",
  "./js/codemirror/mode/javascript/javascript.js",
  "./js/codemirror/mode/python/python.js",
  "./js/codemirror/mode/xml/xml.js",
  "./js/codemirror/mode/css/css.js",
  "./js/codemirror/mode/htmlmixed/htmlmixed.js",
  "./js/codemirror/mode/clike/clike.js",
  "./js/codemirror/mode/shell/shell.js",
  "./js/codemirror/mode/markdown/markdown.js",
  "./js/codemirror/addon/edit/matchbrackets.js",
  "./js/codemirror/addon/edit/closebrackets.js",
  "./js/codemirror/addon/selection/active-line.js"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Strategy:
//  - Gemini API calls (generativelanguage.googleapis.com): always network,
//    never cached (they're live AI responses and carry the API key).
//  - Everything else (app shell): cache-first, falling back to network,
//    and updating the cache in the background when the network succeeds.
self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (req.method !== "GET") return;
  if (url.hostname === "generativelanguage.googleapis.com") return; // never intercept API calls

  if (url.origin !== self.location.origin) return; // don't meddle with other cross-origin requests

  event.respondWith(
    caches.match(req).then((cached) => {
      const networkFetch = fetch(req).then((res) => {
        if (res && res.ok) {
          const clone = res.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(req, clone));
        }
        return res;
      }).catch(() => cached);
      return cached || networkFetch;
    })
  );
});
