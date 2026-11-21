// Offline support. Once the app has been opened, its code and the pages
// visited are kept, so the field app (and the rest) open without signal.
// Facility data lives in the browser's IndexedDB and is not touched here.

const VERSION = "bimos-v1";
const STATIC = `${VERSION}-static`;
const PAGES = `${VERSION}-pages`;
const START = ["/field", "/assets", "/maintenance", "/"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(PAGES)
      .then((cache) => Promise.all(START.map((path) => cache.add(path).catch(() => undefined))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => !key.startsWith(VERSION)).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

async function cacheFirst(request) {
  const cache = await caches.open(STATIC);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

async function networkFirst(request, key) {
  const cache = await caches.open(PAGES);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(key, response.clone());
    return response;
  } catch (error) {
    const hit = (await cache.match(key)) || (request.mode === "navigate" ? await cache.match("/field") : undefined);
    if (hit) return hit;
    throw error;
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  // Built code and fixed files never change under the same name.
  if (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/icons/") || url.pathname.startsWith("/web-ifc/")) {
    event.respondWith(cacheFirst(request));
    return;
  }
  // Pages: fresh from the network, the kept copy without signal (one copy per page, whatever its query).
  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request, url.pathname));
    return;
  }
  // The data pages load as you move around the app, and the manifest.
  if (request.headers.get("RSC") === "1" || url.pathname === "/manifest.webmanifest") {
    event.respondWith(networkFirst(request, request.headers.get("RSC") === "1" ? `${url.pathname}?__rsc` : url.pathname));
  }
});
