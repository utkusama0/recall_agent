// RECALL service worker — caches the app shell + CDN libs for offline review.
// Card/state data is NOT cached here (it lives in IndexedDB, written by app.js);
// GitHub API and tutor calls always go to the network.
const CACHE = "recall-v7";
const SHELL = [
  "./", "./index.html", "./app.js", "./manifest.webmanifest", "./icon.svg",
  "https://cdn.jsdelivr.net/npm/ts-fsrs@4.7.0/+esm",
  "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css",
  "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js",
  "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/auto-render.min.js",
  "https://cdn.jsdelivr.net/npm/dompurify@3.1.6/dist/purify.min.js",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // Never cache API / tutor traffic.
  if (url.hostname === "api.github.com" || url.hostname.includes("groq") ||
      url.hostname.includes("dictionaryapi")) return;
  // Cache-first for shell + CDN; fall back to network and cache new GETs.
  e.respondWith(
    caches.match(e.request).then((hit) =>
      hit || fetch(e.request).then((res) => {
        if (e.request.method === "GET" && res.ok && (url.origin === location.origin || url.hostname.includes("jsdelivr"))) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      }).catch(() => hit)
    )
  );
});
