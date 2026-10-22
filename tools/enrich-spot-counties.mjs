import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultBoundaryPath = fileURLToPath(new URL("../../data/tw-counties.geojson", import.meta.url));
const [boundaryArg = defaultBoundaryPath, ...spotArgs] = process.argv.slice(2);
const boundaryPath = resolve(boundaryArg);
const spotPaths = spotArgs.length ? spotArgs.map(path => resolve(path)) : [resolve("site/data/spots.json")];

function ringContains(ring, longitude, latitude) {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const [x1, y1] = ring[index];
    const [x2, y2] = ring[previous];
    if ((y1 > latitude) !== (y2 > latitude) && longitude < ((x2 - x1) * (latitude - y1)) / (y2 - y1) + x1) inside = !inside;
  }
  return inside;
}

function polygonContains(rings, longitude, latitude) {
  return ringContains(rings[0], longitude, latitude) && !rings.slice(1).some(ring => ringContains(ring, longitude, latitude));
}

function geometryContains(geometry, longitude, latitude) {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  return polygons.some(rings => polygonContains(rings, longitude, latitude));
}

function distanceToSegmentMeters(longitude, latitude, start, end) {
  const cosine = Math.cos((latitude * Math.PI) / 180);
  const x = value => ((value * Math.PI) / 180) * 6371000 * cosine;
  const y = value => ((value * Math.PI) / 180) * 6371000;
  const pointX = x(longitude);
  const pointY = y(latitude);
  const startX = x(start[0]);
  const startY = y(start[1]);
  const dx = x(end[0]) - startX;
  const dy = y(end[1]) - startY;
  const lengthSquared = dx * dx + dy * dy;
  const projection = lengthSquared ? Math.max(0, Math.min(1, ((pointX - startX) * dx + (pointY - startY) * dy) / lengthSquared)) : 0;
  return Math.hypot(pointX - (startX + projection * dx), pointY - (startY + projection * dy));
}

function nearestCountyWithin(longitude, latitude, features, maxDistanceMeters = 1500) {
  let nearest = null;
  for (const feature of features) {
    const polygons = feature.geometry.type === "Polygon" ? [feature.geometry.coordinates] : feature.geometry.coordinates;
    for (const rings of polygons) {
      for (const ring of rings) {
        for (let index = 1; index < ring.length; index++) {
          const distance = distanceToSegmentMeters(longitude, latitude, ring[index - 1], ring[index]);
          if (distance < (nearest?.distance ?? maxDistanceMeters + 1)) {
            nearest = { name: feature.properties.COUNTYNAME, distance };
          }
        }
      }
    }
  }
  return nearest?.distance <= maxDistanceMeters ? nearest.name : null;
}

const boundaries = JSON.parse(await readFile(boundaryPath, "utf8"));
if (boundaries.crs?.properties?.name && !/CRS84|4326/.test(boundaries.crs.properties.name)) {
  throw new Error(`Expected WGS84 longitude/latitude boundaries, got ${boundaries.crs.properties.name}`);
}

for (const spotPath of spotPaths) {
  const spots = JSON.parse(await readFile(spotPath, "utf8"));
  const counts = new Map();
  let unmatched = 0;
  for (const spot of spots) {
    const longitude = Number(spot.lon);
    const latitude = Number(spot.lat);
    const feature = boundaries.features.find(item => geometryContains(item.geometry, longitude, latitude));
    const county = feature?.properties?.COUNTYNAME || nearestCountyWithin(longitude, latitude, boundaries.features);
    if (county) {
      spot.county = county;
      counts.set(spot.county, (counts.get(spot.county) || 0) + 1);
    } else {
      delete spot.county;
      unmatched++;
    }
  }
  await writeFile(spotPath, `${JSON.stringify(spots)}\n`, "utf8");
  const summary = [...counts].sort(([left], [right]) => left.localeCompare(right, "zh-Hant")).map(([county, count]) => `${county} ${count}`).join("、");
  console.log(`${spotPath}: ${spots.length} 筆；${summary}；未落在縣市範圍 ${unmatched} 筆`);
}
