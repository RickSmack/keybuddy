/* Key Buddy service worker — caches the app shell and the CDN ML libraries
   so the tool works offline after the first successful online load. */
const CACHE = "keybuddy-v1";

// App shell — same-origin files we control.
const SHELL = [
  "./",
  "./index.html",
];

// Cross-origin ML libraries. Cached opaquely on first fetch (see fetch handler).
const CDN = [
  "https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.20.0/dist/tf.min.js",
  "https://cdn.jsdelivr.net/npm/@tensorflow-models/mobilenet@2.1.1/dist/mobilenet.min.js",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Strategy:
//  - Model weight files (tfhub / storage.googleapis) & CDN scripts: cache-first, then
//    fetch-and-store so they're available offline afterward.
//  - App shell & everything else: stale-while-revalidate (fast + self-updating).
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;

  const url = req.url;
  const isModelAsset =
    url.includes("tfhub.dev") ||
    url.includes("storage.googleapis.com") ||
    url.includes("cdn.jsdelivr.net");

  if (isModelAsset) {
    e.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        try {
          const res = await fetch(req);
          // Store even opaque responses so offline reloads succeed.
          cache.put(req, res.clone());
          return res;
        } catch (err) {
          return hit || Response.error();
        }
      })
    );
    return;
  }

  // Stale-while-revalidate for the app shell.
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
