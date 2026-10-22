const CACHE_NAME = "che-su-lutu-shell-v5";
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.webmanifest",
  "./assets/icon.svg",
  "./assets/icon-180.png",
  "./assets/icon-192.png",
  "./assets/icon-512.png",
  "./assets/vendor/leaflet.css",
  "./assets/vendor/leaflet.js",
  "./data/spots.json",
  "./data/partners.json"
];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith("che-su-lutu-") && key !== CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  // Keep map tiles and external data services outside the app cache.
  if (url.origin !== self.location.origin) return;

  if (url.pathname.endsWith("/data/spots.json")) {
    event.respondWith(fetch(request).then(async response => {
      if (response.ok) await caches.open(CACHE_NAME).then(cache => cache.put(request, response.clone()));
      return response;
    }).catch(async () => (await caches.match(request)) || (await caches.match(new URL("./data/spots.json", self.location.href).href))));
    return;
  }

  event.respondWith(caches.match(request).then(cached => cached || fetch(request).then(async response => {
    if (response.ok && url.origin === self.location.origin) await caches.open(CACHE_NAME).then(cache => cache.put(request, response.clone()));
    return response;
  })));
});
