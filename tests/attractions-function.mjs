import assert from "node:assert/strict";
import { onRequestGet } from "../functions/api/attractions.js";

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
const makeRequest = (query = "lat=25.033000&lon=121.565000&radius=5000") => new Request(`https://test.pages.dev/api/attractions?${query}`);
const makeResponse = () => new Response(JSON.stringify({ elements: [{ type: "node", id: 7, lat: 25.04, lon: 121.56, tags: { name: "測試觀景點", tourism: "viewpoint" } }] }), { headers: { "content-type": "application/json" } });

try {
  let calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), body: options.body });
    return makeResponse();
  };
  const miss = await onRequestGet({ request: makeRequest() });
  assert.equal(miss.status, 200);
  assert.equal(miss.headers.get("x-attraction-cache"), "miss");
  const query = new URLSearchParams(calls[0].body).get("data");
  assert.match(query, /around:5000,25\.033000,121\.565000/);
  assert.match(query, /tourism.*historic.*leisure.*natural/);

  const hit = await onRequestGet({ request: makeRequest() });
  assert.equal(hit.status, 200);
  assert.equal(hit.headers.get("x-attraction-cache"), "hit");
  assert.equal(calls.length, 1, "a cache hit should not call Overpass again");

  const invalid = await onRequestGet({ request: makeRequest("lat=40&lon=121&radius=5000") });
  assert.equal(invalid.status, 400);
  assert.equal(calls.length, 1, "invalid coordinates should not call an upstream service");

  cachedResponses.clear();
  calls = [];
  globalThis.fetch = async url => {
    calls.push(String(url));
    if (calls.length === 1) throw new Error("primary service unavailable");
    return makeResponse();
  };
  const fallback = await onRequestGet({ request: makeRequest("lat=24.5&lon=120.9&radius=10000") });
  assert.equal(fallback.status, 200);
  assert.equal(calls.length, 2);
  assert.match(calls[1], /overpass\.private\.coffee/);

  console.log("PASS attractions Pages Function: coordinate validation, radius query, edge cache, and alternate upstream");
} finally {
  globalThis.fetch = originalFetch;
}
