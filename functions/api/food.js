const CACHE_TTL_SECONDS = 60 * 60;
const UPSTREAM_TIMEOUT_MS = 10000;
const CACHE_ZONE = "che-su-lutu-food-v1";
const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter"
];

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers }
  });
}

function boundedCoordinate(value, min, max) {
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : null;
}

function buildQuery(lat, lon, radiusM) {
  return `[out:json][timeout:10];(nwr["amenity"~"^(restaurant|cafe|fast_food|food_court|ice_cream)$"]["name"](around:${Math.round(radiusM)},${lat.toFixed(6)},${lon.toFixed(6)}););out center qt 100;`;
}

async function fetchUpstream(query) {
  let lastError;
  for (const endpoint of ENDPOINTS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
          "accept": "application/json",
          "user-agent": "che-su-lutu-pwa/1.0 (https://che-su-lutu-pwa.pages.dev/)"
        },
        body: `data=${encodeURIComponent(query)}`,
        signal: controller.signal
      });
      if (!response.ok) {
        const error = new Error(`OpenStreetMap query returned ${response.status}`);
        error.status = response.status;
        if ([400, 429, 406].includes(response.status)) throw error;
        lastError = error;
        continue;
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      if (error.status === 400) break;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error("Nearby food data is temporarily unavailable.");
}

export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  const lat = boundedCoordinate(url.searchParams.get("lat"), 21, 26.5);
  const lon = boundedCoordinate(url.searchParams.get("lon"), 118, 123.5);
  const radius = Number(url.searchParams.get("radius"));
  if (lat == null || lon == null || ![1000, 2000, 5000, 10000].includes(radius)) {
    return json({ error: "請提供臺灣範圍內座標及有效搜尋半徑。" }, 400);
  }

  const keyUrl = new URL("/api/food/cache", url.origin);
  keyUrl.searchParams.set("lat", lat.toFixed(6));
  keyUrl.searchParams.set("lon", lon.toFixed(6));
  keyUrl.searchParams.set("radius", String(radius));
  const cacheKey = new Request(keyUrl.toString(), { method: "GET" });
  const cache = await caches.open(CACHE_ZONE);
  const cached = await cache.match(cacheKey);
  if (cached) return new Response(cached.body, { status: 200, headers: { ...Object.fromEntries(cached.headers), "x-food-cache": "hit" } });

  try {
    const result = await fetchUpstream(buildQuery(lat, lon, radius));
    const response = json(result, 200, {
      "cache-control": `public, max-age=${CACHE_TTL_SECONDS}`,
      "x-food-cache": "miss"
    });
    await cache.put(cacheKey, response.clone());
    return response;
  } catch {
    return json({ error: "附近店家資料暫時忙碌，請改用 Google 地圖搜尋。" }, 503, { "cache-control": "no-store" });
  }
}
