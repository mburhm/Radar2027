const CACHE = "radar-pro-v1";
const PRECACHE = [
  "./", "./index.html", "./app.js", "./app.css",
  "./manifest.webmanifest", "./icon.svg",
  "./icon-180.png", "./icon-192.png", "./icon-512.png",
];
const STATIC_EXT = /\.(?:js|css|png|svg|webmanifest|woff2?|ico)(?:\?.*)?$/i;

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE && k.startsWith("radar-pro-")).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.mode === "navigate" || req.destination === "document" || url.pathname.endsWith("/") || url.pathname.endsWith(".html")) {
    e.respondWith(networkFirst(req));
    return;
  }
  if (STATIC_EXT.test(url.pathname)) {
    e.respondWith(staleWhileRevalidate(req));
    return;
  }
  e.respondWith(networkFirst(req));
});
async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.ok) cache.put(req, fresh.clone());
    return fresh;
  } catch {
    return (await cache.match(req)) || (await cache.match("./index.html")) || new Response("Offline", { status: 503 });
  }
}
async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(req);
  const net = fetch(req).then((res) => {
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  }).catch(() => null);
  if (cached) { net; return cached; }
  return (await net) || new Response("Offline", { status: 503 });
}
