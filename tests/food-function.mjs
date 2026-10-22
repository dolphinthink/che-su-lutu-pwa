import assert from "node:assert/strict";
import { onRequestGet } from "../functions/api/food.js";

const cachedResponses = new Map();
globalThis.caches = {
  async open() {
    return {
      async match(request) { return cachedResponses.get(request.url)?.clone(); },
      async put(request, response) { cachedResponses.set(request.url, response.clone()); }
    };
  }
};

const originalFetch = globalThis.fetch;
const makeRequest = (query = "lat=25.0154&lon=121.49476&radius=10000") => new Request(`https://test.pages.dev/api/food?${query}`);
const makeUpstreamResponse = () => new Response(JSON.stringify({ elements: [{ type: "node", id: 5, lat: 25.01, lon: 121.49, tags: { name: "測試餐館", amenity: "restaurant" } }] }), { headers: { "content-type": "application/json" } });

try {
  let calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), body: options.body });
    return makeUpstreamResponse();
  };
  const miss = await onRequestGet({ request: makeRequest() });
  assert.equal(miss.status, 200);
  assert.equal(miss.headers.get("x-food-cache"), "miss");
  assert.equal((await miss.json()).elements[0].tags.name, "測試餐館");
  assert.equal(new URLSearchParams(calls[0].body).get("data").includes("timeout:10"), true);
  assert.equal(new URLSearchParams(calls[0].body).get("data").includes("out center qt 100"), true);

  const hit = await onRequestGet({ request: makeRequest() });
  assert.equal(hit.status, 200);
  assert.equal(hit.headers.get("x-food-cache"), "hit");
  assert.equal(calls.length, 1, "cache hit should avoid another Overpass request");

  const invalid = await onRequestGet({ request: makeRequest("lat=40&lon=121&radius=10000") });
  assert.equal(invalid.status, 400);
  assert.equal(calls.length, 1, "invalid coordinates should not make an upstream request");

  cachedResponses.clear();
  calls = [];
  globalThis.fetch = async url => {
    calls.push(String(url));
    if (calls.length === 1) throw new Error("primary service unavailable");
    return makeUpstreamResponse();
  };
  const fallback = await onRequestGet({ request: makeRequest("lat=24.5&lon=120.9&radius=5000") });
  assert.equal(fallback.status, 200);
  assert.equal(calls.length, 2, "the alternate Overpass service should be attempted");
  assert.match(calls[1], /overpass\.private\.coffee/);

  console.log("PASS food Pages Function: validation, 10 km query, edge cache hit, and alternate upstream fallback");
} finally {
  globalThis.fetch = originalFetch;
}
