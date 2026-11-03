import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const data = JSON.parse(await readFile(new URL("../site/data/attraction-directory.json", import.meta.url), "utf8"));
const app = await readFile(new URL("../site/app.js", import.meta.url), "utf8");
const html = await readFile(new URL("../site/index.html", import.meta.url), "utf8");
const sw = await readFile(new URL("../site/sw.js", import.meta.url), "utf8");

assert.equal(data.source.publisher, "交通部觀光署");
assert.equal(data.source.url, "https://data.gov.tw/dataset/7777");
assert.equal(data.counts.publicTaiwanPoints, data.points.length);
assert.ok(data.points.length > 6000);
assert.ok(data.points.every(point => point.id && point.name && point.lat >= 21 && point.lat <= 26.5 && point.lon >= 118 && point.lon <= 123.5));
const center = { lat: 25.033, lon: 121.565 };
const rad = value => value * Math.PI / 180;
const distanceKm = (a, b) => {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const value = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
};
assert.ok(data.points.filter(point => distanceKm(center, point) <= 5).length > 0, "5 km search around Taipei should find official attractions");
assert.match(app, /normalizeDirectoryAttractions\(directory\?\.points, spot, radius\)/);
assert.match(app, /仍顯示觀光署景點目錄與本機資料/);
assert.match(app, /目前位置 \(\$\{Number\(spot\.lat\)\.toFixed\(5\)\}/);
assert.match(app, /async function locateNearby\(\)[\s\S]*?attractionCenter\.value = "current"/);
assert.match(app, /#locateButton"\)\.addEventListener\("click", \(\) => locateNearby\(\)/);
assert.match(app, /#locateAttractionsButton"\)\.addEventListener\("click", locateAndSearchAttractions\)/);
assert.match(html, /id="locateAttractionsButton"[^>]*>定位附近</);
assert.match(html, /data\.gov\.tw\/dataset\/7777/);
assert.match(sw, /attraction-directory\.json\?v=20261103-1/);

console.log(`PASS attraction directory: ${data.points.length} public, geocoded Taiwan records and timeout fallback`);
