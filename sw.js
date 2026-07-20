/* Key Buddy service worker — everything is self-hosted (same origin) now.
   Caches the app shell and the vendored ML assets so the tool works offline
   after the first successful online load. */
const CACHE = "keybuddy-v2";

// App shell — cached up front on install.
const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./vendor/tf.min.js",
  "./vendor/opencv.js",
  "./vendor/mobilenet/model.json",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    // Best-effort precache; individual failures shouldn't abort install.
    caches.open(CACHE)
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // only handle same-origin

  // Immutable, heavy assets (model weight shards + libraries): cache-first.
  const isVendor = url.pathname.includes("/vendor/");
  if (isVendor) {
    e.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        try {
          const res = await fetch(req);
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        } catch (err) {
          return hit || Response.error();
        }
      })
    );
    return;
  }

  // App shell & everything else: stale-while-revalidate.
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(req);
      const fetching = fetch(req)
        .then((res) => { if (res && res.ok) cache.put(req, res.clone()); return res; })
        .catch(() => hit);
      return hit || fetching;
    })
  );
});
