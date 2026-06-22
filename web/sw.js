// RECALL service worker — caches the app shell + CDN libs for offline review.
// Card/state data is NOT cached here (it lives in IndexedDB, written by app.js);
// GitHub API and tutor calls always go to the network.
const CACHE = "recall-v18";
const SHELL = [
  "./",
  "./index.html",
  "./app.js",
  "./icon.svg",
  "./manifest.webmanifest",
  "https://cdn.jsdelivr.net/npm/ts-fsrs@4.7.0/+esm",
  "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css",
  "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js",
  "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/auto-render.min.js",
  "https://cdn.jsdelivr.net/npm/dompurify@3.1.6/dist/purify.min.js",
];

// ---------- IndexedDB helpers (SW context) ----------
function idbSwOpen() {
  return new Promise((res, rej) => {
    const r = indexedDB.open("recall", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
function idbSwGet(key) {
  return idbSwOpen().then((db) => new Promise((res) => {
    const tx = db.transaction("kv").objectStore("kv").get(key);
    tx.onsuccess = () => res(tx.result);
    tx.onerror = () => res(undefined);
  }));
}
function idbSwSet(key, val) {
  return idbSwOpen().then((db) => new Promise((res) => {
    const tx = db.transaction("kv", "readwrite").objectStore("kv").put(val, key);
    tx.onsuccess = () => res();
    tx.onerror = () => res();
  }));
}

// ---------- install / activate / fetch ----------
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
  if (url.protocol !== "https:" && url.protocol !== "http:") return;
  if (url.hostname === "api.github.com" || url.hostname.includes("groq") ||
      url.hostname.includes("dictionaryapi")) return;
  // Local app files: network-first so deploys take effect immediately.
  // CDN libs: cache-first (immutable, versioned by URL).
  const isLocal = url.origin === location.origin;
  if (isLocal) {
    e.respondWith(
      fetch(e.request).then((res) => {
        if (e.request.method === "GET" && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      }).catch(() =>
        caches.match(e.request)
          .then((hit) => hit || caches.match(e.request, { ignoreSearch: true }))
      )
    );
  } else {
    e.respondWith(
      caches.match(e.request).then((hit) =>
        hit || fetch(e.request).then((res) => {
          if (e.request.method === "GET" && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy));
          }
          return res;
        }).catch(() => hit)
      )
    );
  }
});

// ---------- message handler (config from app.js) ----------
self.addEventListener("message", (e) => {
  if (e.data?.type === "STORE_CONFIG") {
    const { owner, repo, branch, pat } = e.data;
    idbSwSet("sw_config", { owner, repo, branch, pat });
  }
});

// ---------- notificationclick handler ----------
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url.includes("/web/") && "focus" in client) {
          client.focus();
          client.postMessage({ type: "NAVIGATE", tab: "review" });
          return;
        }
      }
      return self.clients.openWindow("./?tab=review");
    })
  );
});

// ---------- periodic background sync (Android Chrome) ----------
async function checkDueAndNotify() {
  const cfg = await idbSwGet("sw_config");
  if (!cfg?.owner || !cfg?.pat) return;

  const url = `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/state/scheduler.json?ref=${cfg.branch || "main"}`;
  const r = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${cfg.pat}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    cache: "no-store",
  });
  if (!r.ok) return;

  const j = await r.json();
  const bin = atob(j.content.replace(/\n/g, ""));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  const text = new TextDecoder().decode(bytes);
  const scheduler = JSON.parse(text);

  const now = new Date();
  let dueCount = 0;
  for (const id in scheduler) {
    const s = scheduler[id];
    if (s.state === 0 || new Date(s.due) <= now) dueCount++;
  }

  if (dueCount > 0) {
    await self.registration.showNotification("RECALL", {
      body: `${dueCount} card${dueCount === 1 ? "" : "s"} due for review`,
      tag: "recall-due",
      icon: "./icon.svg",
      badge: "./icon.svg",
      data: { tab: "review" },
    });
  }
}

self.addEventListener("periodicsync", (e) => {
  if (e.tag === "recall-due") {
    e.waitUntil(checkDueAndNotify());
  }
});
