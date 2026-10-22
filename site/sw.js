const CACHE_NAME = "che-su-lutu-shell-v6";
const CORE_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.webmanifest"
];
const OPTIONAL_SHELL = [
  "./assets/icon.svg",
  "./assets/icon-180.png",
  "./assets/icon-192.png",
  "./assets/icon-512.png",
  "./assets/vendor/leaflet.css",
  "./assets/vendor/leaflet.js",
  "./data/spots.json",
  "./data/partners.json"
];

const OFFLINE_PAGE = `<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#174d43"><title>車宿旅圖｜暫時離線</title><body style="margin:0;background:#f7f8f5;color:#174d43;font:16px system-ui,sans-serif"><main style="max-width:34rem;margin:18vh auto;padding:2rem"><h1>目前無法連線</h1><p>車宿旅圖的離線首頁尚未載入。請確認手機網路後再重試；連線恢復後，也可以直接用 Chrome 開啟網站更新離線資料。</p><button style="padding:.8rem 1.2rem;border:0;border-radius:.7rem;background:#174d43;color:white;font:inherit" onclick="location.reload()">重新連線</button></main></body></html>`;

async function cacheOptionalAsset(cache, path) {
  const url = new URL(path, self.registration.scope);
  const response = await fetch(url);
  if (response.ok) await cache.put(url, response);
}

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(CORE_SHELL);
    await Promise.allSettled(OPTIONAL_SHELL.map(path => cacheOptionalAsset(cache, path)));
    await self.skipWaiting();
  })());
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

  if (request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response.ok) {
          const cache = await caches.open(CACHE_NAME);
          const indexUrl = new URL("./index.html", self.registration.scope);
          const rootUrl = new URL("./", self.registration.scope);
          await Promise.all([cache.put(indexUrl, response.clone()), cache.put(rootUrl, response.clone())]);
        }
        return response;
      } catch {
        const cached = await caches.match(request)
          || await caches.match(new URL("./index.html", self.registration.scope))
          || await caches.match(new URL("./", self.registration.scope));
        if (cached) return cached;
        return new Response(OFFLINE_PAGE, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
    })());
    return;
  }

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
