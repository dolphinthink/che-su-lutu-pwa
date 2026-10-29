(() => {
  "use strict";

  const DB_NAME = "che-su-lutu-v1";
  const SOURCE_KML_URL = "https://www.google.com/maps/d/kml?mid=1Q3JWYBEf6JQC8M4ei6cEojTesjg&forcekml=1";
  const SPOT_DATA_URL = "./data/spots.json?v=20261028-2";
  const COUNTY_BOUNDARY_DATA_URL = "./data/tw-counties.geojson?v=20261028-1";
  const TEMPLE_DATA_URL = "./data/temple-toilets.json?v=20261022-6";
  const WATERFRONT_DATA_URL = "./data/waterfront-points.json?v=20261022-6";
  const FOOD_DATA_URL = "./data/restaurant-directory.json?v=20261022-7";
  const MAP_STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";
  const MAPLIBRE_MODULE_URL = "https://unpkg.com/maplibre-gl@6.3.0/dist/maplibre-gl.mjs";
  const MAPLIBRE_STYLESHEET_URL = "https://unpkg.com/maplibre-gl@6.3.0/dist/maplibre-gl.css";
  const MAPLIBRE_LEAFLET_ZOOM_OFFSET = -1;
  const MAP_SPOT_LABEL_ZOOM = 12;
  const FOOD_TTL = 6 * 60 * 60 * 1000;
  const ATTRACTION_TTL = 6 * 60 * 60 * 1000;
  const PAGE_SIZE = 36;
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  let dbPromise;
  let spots = [];
  let countyBoundaries = [];
  let templeToiletData = null;
  let waterfrontData = null;
  let foodDirectoryPromise;
  let visibleCount = PAGE_SIZE;
  let userPosition = null;
  let map;
  let markerLayer;
  let userMarker;
  let mapBackground;
  let mapLibreStylesheetPromise;
  let installPrompt = null;
  let toastTimer;
  let foodRequestInProgress = false;
  let attractionRequestInProgress = false;
  let selectedSpotUpdateId = null;
  let sourceSpots = [];
  let sourceSpotsReady = false;
  const selectedSourceSpotIds = new Set();
  const favoriteIds = new Set(readJson("che-su-favorites", []));
  const spotCountiesByCoordinates = new WeakMap();

  function readJson(key, fallback) {
    try {
      const value = localStorage.getItem(key);
      return value ? JSON.parse(value) : fallback;
    } catch {
      return fallback;
    }
  }

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!("indexedDB" in window)) return reject(new Error("此瀏覽器不支援本機資料庫。"));
      const request = indexedDB.open(DB_NAME, 2);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("spots")) db.createObjectStore("spots", { keyPath: "id" });
        if (!db.objectStoreNames.contains("reports")) db.createObjectStore("reports", { keyPath: "id" });
        if (!db.objectStoreNames.contains("food")) db.createObjectStore("food", { keyPath: "key" });
        if (!db.objectStoreNames.contains("attractions")) db.createObjectStore("attractions", { keyPath: "key" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("無法開啟本機資料庫。"));
    });
    return dbPromise;
  }

  async function dbRequest(storeName, method, value) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, method === "getAll" ? "readonly" : "readwrite");
      const store = transaction.objectStore(storeName);
      const request = method === "getAll" ? store.getAll() : method === "get" ? store.get(value) : method === "delete" ? store.delete(value) : store.put(value);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("本機資料讀寫失敗。"));
    });
  }

  const dbAll = name => dbRequest(name, "getAll");
  const dbGet = (name, key) => dbRequest(name, "get", key);
  const dbPut = (name, value) => dbRequest(name, "put", value);
  const dbDelete = (name, key) => dbRequest(name, "delete", key);

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  }

  function safeWebUrl(value) {
    try {
      const url = new URL(String(value || ""));
      return url.protocol === "https:" || url.protocol === "http:" ? url.href : "";
    } catch { return ""; }
  }

  function stableId(lat, lon) {
    return `${Number(lat).toFixed(6)}_${Number(lon).toFixed(6)}`;
  }

  function haversineKm(a, b) {
    const rad = degrees => degrees * Math.PI / 180;
    const dLat = rad(b.lat - a.lat);
    const dLon = rad(b.lon - a.lon);
    const value = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
  }

  function googleSearchUrl(name, lat, lon, extra = "") {
    const query = [name, extra, `${Number(lat).toFixed(6)},${Number(lon).toFixed(6)}`].filter(Boolean).join(" ");
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
  }

  function googleSpotSearchUrl(spot) {
    const coordinates = `${Number(spot.lat).toFixed(6)},${Number(spot.lon).toFixed(6)}`;
    const county = spot.county || countyAtPoint(Number(spot.lon), Number(spot.lat));
    const locality = county ? `, ${county}` : "";
    const query = `${spot.name} near ${coordinates}${locality}, Taiwan`;
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
  }

  function hasManualLocationOverride(spot) {
    if (spot?.locationOverride === true) return true;
    const id = String(spot?.id || "");
    const match = /^(-?\d+(?:\.\d+)?)_(-?\d+(?:\.\d+)?)$/.exec(id);
    if (!match) return false;
    const sourceCoordinates = stableId(Number(match[1]), Number(match[2]));
    return stableId(Number(spot.lat), Number(spot.lon)) !== sourceCoordinates;
  }

  function mapsDirectionsUrl(origin, destination) {
    return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(`${origin.lat},${origin.lon}`)}&destination=${encodeURIComponent(`${destination.lat},${destination.lon}`)}&travelmode=driving`;
  }

  function notify(message) {
    const toast = $("#toast");
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 2800);
  }

  function setNetworkStatus() {
    const status = $("#networkState");
    if (navigator.onLine) {
      status.classList.remove("offline");
      status.lastChild.textContent = "線上";
    } else {
      status.classList.add("offline");
      status.lastChild.textContent = "離線可查";
    }
  }

  async function loadSpots() {
    const dataUrl = new URL(SPOT_DATA_URL, document.baseURI);
    let response;
    let countyBoundaryData;
    const optionalJson = url => fetch(new URL(url, document.baseURI))
      .then(result => result.ok ? result.json() : null)
      .catch(() => null);
    try {
      [response, countyBoundaryData, templeToiletData, waterfrontData] = await Promise.all([
        fetch(dataUrl),
        optionalJson(COUNTY_BOUNDARY_DATA_URL),
        optionalJson(TEMPLE_DATA_URL),
        optionalJson(WATERFRONT_DATA_URL)
      ]);
    } catch {
      if (location.protocol === "file:") {
        throw new Error("目前是直接開啟 index.html，瀏覽器無法讀取泊點資料。請在車宿資料夾執行「啟動車宿旅圖.ps1」，再開啟 http://localhost:8000/。");
      }
      throw new Error(`無法連線讀取 ${dataUrl.pathname}。請確認網站部署時包含 data/spots.json，並從 PWA 專案根目錄提供網頁。`);
    }
    if (!response.ok) {
      throw new Error(`泊點資料回應 HTTP ${response.status}。請確認部署內容包含 data/spots.json，且網址位於 PWA 專案根目錄。`);
    }
    const base = await response.json();
    countyBoundaries = (countyBoundaryData?.features || []).map(createCountyBoundary).filter(Boolean).sort((a, b) => a.area - b.area);
    const spotUpdates = new Map((templeToiletData?.spotUpdates || []).map(update => [update.id, update.toiletInfo]));
    const saved = await dbAll("spots").catch(() => []);
    const merged = new Map(base.map(spot => {
      const id = spot.id || stableId(spot.lat, spot.lon);
      const toiletInfo = spotUpdates.get(id);
      return [id, { ...spot, id, ...(toiletInfo ? { toiletInfo } : {}) }];
    }));
    for (const spot of saved) {
      const baseSpot = merged.get(spot.id);
      const locationOverride = hasManualLocationOverride(spot);
      merged.set(spot.id, baseSpot
        ? { ...baseSpot, ...spot, locationOverride, county: locationOverride ? spot.county : (baseSpot.county || spot.county) }
        : { ...spot, locationOverride });
    }
    for (const temple of templeToiletData?.temples || []) {
      if (temple.id && !merged.has(temple.id)) merged.set(temple.id, temple);
    }
    for (const point of waterfrontData?.points || []) {
      if (!point.id) continue;
      const existing = merged.get(point.id);
      merged.set(point.id, existing ? {
        ...existing,
        waterType: point.waterType,
        waterLabel: point.waterLabel,
        sourceType: point.sourceType,
        accessEvidence: point.accessEvidence,
        officialSourceUrl: point.officialSourceUrl,
        officialSourceTitle: point.officialSourceTitle,
        toiletInfo: existing.toiletInfo
      } : point);
    }
    spots = [...merged.values()]
      .filter(spot => Number.isFinite(Number(spot.lat)) && Number.isFinite(Number(spot.lon)))
      .map(spot => withResolvedCounty(spot, !spot.county || hasManualLocationOverride(spot)));
    spots.sort((a, b) => a.name.localeCompare(b.name, "zh-Hant"));
    const templeToggle = $("#templeFacilitiesToggle");
    if (templeToggle) {
      const count = Number(templeToiletData?.counts?.templeSitesWithRegisteredRestrooms) || 0;
      templeToggle.textContent = `⛩ 廟宇公廁 ${count.toLocaleString("zh-TW")}`;
      templeToggle.disabled = !templeToiletData?.temples?.length;
    }
    const waterfrontToggle = $("#waterfrontToggle");
    if (waterfrontToggle) {
      const count = Number(waterfrontData?.counts?.total) || 0;
      waterfrontToggle.textContent = `🌊 溪河海 ${count.toLocaleString("zh-TW")}`;
      waterfrontToggle.disabled = !count;
    }
    fillSpotSelectors();
    renderSpots();
    renderSpotUpdateSearch();
    renderReports();
  }

  function initMap() {
    if (!window.L || !$("#map")) return;
    map = L.map("map", { zoomControl: true, scrollWheelZoom: false, preferCanvas: true }).setView([23.72, 120.96], 7);
    map.attributionControl.addAttribution('<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> &copy; <a href="https://www.openmaptiles.org" target="_blank" rel="noopener">OpenMapTiles</a> · Data from <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>');
    map.on("move zoom resize", syncMapBackground);
    map.on("moveend zoomend", updateMapSpotLabels);
    markerLayer = L.layerGroup().addTo(map);
    drawMapMarkers();
    loadMapBackground();
  }

  function toMapLibreZoom(leafletZoom) {
    // Leaflet uses 256 px world tiles; MapLibre vector styles use 512 px tiles.
    return leafletZoom + MAPLIBRE_LEAFLET_ZOOM_OFFSET;
  }

  function syncMapBackground() {
    if (!map || !mapBackground || !mapBackground.isStyleLoaded()) return;
    const center = map.getCenter();
    mapBackground.jumpTo({ center: [center.lng, center.lat], zoom: toMapLibreZoom(map.getZoom()) });
  }

  function showMapServiceNotice(message) {
    const notice = $("#mapServiceNotice");
    const center = map?.getCenter();
    if (center) {
      const query = `車泊點 near ${center.lat.toFixed(5)},${center.lng.toFixed(5)}`;
      $("#mapOpenGoogle").href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
    }
    $("#mapServiceMessage").textContent = message;
    notice.hidden = false;
  }

  async function loadMapBackground() {
    const retryButton = $("#mapRetry");
    const mapBase = $("#mapBase");
    retryButton.disabled = true;
    mapBase.dataset.status = "loading";
    $("#mapServiceNotice").hidden = true;
    if (mapBackground) {
      mapBackground.remove();
      mapBackground = null;
    }
    try {
      let timeoutId;
      const mapAssets = Promise.all([
        import(MAPLIBRE_MODULE_URL),
        loadMapLibreStylesheet()
      ]);
      const [maplibregl] = await Promise.race([
        mapAssets,
        new Promise((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error("地圖資源載入逾時")), 12000);
        })
      ]).finally(() => clearTimeout(timeoutId));
      let mapHadError = false;
      mapBackground = new maplibregl.Map({
        container: "mapBase",
        style: MAP_STYLE_URL,
        center: [map.getCenter().lng, map.getCenter().lat],
        zoom: toMapLibreZoom(map.getZoom()),
        interactive: false,
        attributionControl: false
      });
      mapBackground.on("load", () => {
        syncMapBackground();
        if (mapHadError) {
          mapBase.dataset.status = "error";
          showMapServiceNotice("地圖底圖部分內容載入失敗，泊點清單仍可使用。可重試或用 Google 地圖查看附近。");
        } else {
          mapBase.dataset.status = "ready";
          $("#mapServiceNotice").hidden = true;
        }
      });
      mapBackground.on("error", () => {
        mapHadError = true;
        mapBase.dataset.status = "error";
        showMapServiceNotice("地圖底圖目前無法完整連線，泊點清單仍可使用。可重試，或用 Google 地圖查看附近。");
      });
    } catch {
      mapBase.dataset.status = "error";
      showMapServiceNotice("地圖底圖程式載入失敗，泊點清單仍可使用。請確認網路連線後重試。 ");
    } finally {
      retryButton.disabled = false;
    }
  }

  function loadMapLibreStylesheet() {
    if (mapLibreStylesheetPromise) return mapLibreStylesheetPromise;
    mapLibreStylesheetPromise = new Promise((resolve, reject) => {
      let stylesheet = $("link[data-maplibre-stylesheet]");
      if (stylesheet?.dataset.status === "loaded") return resolve();
      if (stylesheet) stylesheet.remove();
      stylesheet = document.createElement("link");
      stylesheet.rel = "stylesheet";
      stylesheet.href = MAPLIBRE_STYLESHEET_URL;
      stylesheet.dataset.maplibreStylesheet = "true";
      stylesheet.addEventListener("load", () => {
        stylesheet.dataset.status = "loaded";
        resolve();
      }, { once: true });
      stylesheet.addEventListener("error", () => {
        stylesheet.dataset.status = "error";
        mapLibreStylesheetPromise = null;
        reject(new Error("地圖樣式載入失敗"));
      }, { once: true });
      document.head.append(stylesheet);
    });
    return mapLibreStylesheetPromise;
  }

  function markerColor(spot) {
    if (spot.waterType === "sea") return "#3278a8";
    if (spot.waterType === "river") return "#438b83";
    if (spot.waterType === "creek") return "#7584b3";
    const code = (spot.style || "").match(/-([0-9A-F]{6})(?:-labelson)?$/i)?.[1]?.toUpperCase();
    const palette = { "DB4436": "#d84e3f", "E65100": "#df7c31", "673AB7": "#7760bd", "0F9D58": "#3f9870", "0288D1": "#428db8", "7CB342": "#82a943", "F9A825": "#d4a039", "000000": "#4b5c55" };
    return palette[code] || "#286859";
  }

  function normalizeSearchText(value) {
    return String(value ?? "").normalize("NFKC").replace(/台/g, "臺").toLocaleLowerCase("zh-Hant");
  }

  function createCountyBoundary(feature) {
    const name = String(feature?.properties?.COUNTYNAME || "").trim();
    const geometry = feature?.geometry;
    if (!name || !geometry?.coordinates) return null;
    const bounds = { minLon: Infinity, minLat: Infinity, maxLon: -Infinity, maxLat: -Infinity };
    const visitCoordinates = value => {
      if (!Array.isArray(value)) return;
      if (typeof value[0] === "number" && typeof value[1] === "number") {
        bounds.minLon = Math.min(bounds.minLon, value[0]);
        bounds.maxLon = Math.max(bounds.maxLon, value[0]);
        bounds.minLat = Math.min(bounds.minLat, value[1]);
        bounds.maxLat = Math.max(bounds.maxLat, value[1]);
        return;
      }
      value.forEach(visitCoordinates);
    };
    visitCoordinates(geometry.coordinates);
    if (!Number.isFinite(bounds.minLon)) return null;
    const ringArea = ring => {
      let area = 0;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) area += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
      return Math.abs(area / 2);
    };
    const polygonArea = rings => Math.max(0, ringArea(rings[0]) - rings.slice(1).reduce((sum, ring) => sum + ringArea(ring), 0));
    const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.type === "MultiPolygon" ? geometry.coordinates : [];
    const area = polygons.reduce((sum, rings) => sum + polygonArea(rings), 0);
    if (!Number.isFinite(area) || area <= 0) return null;
    const normalizedName = normalizeSearchText(name);
    return {
      name,
      normalizedName,
      shortName: normalizedName.replace(/(?:市|縣)$/u, ""),
      geometry,
      bounds,
      area
    };
  }

  function pointOnRingSegment(point, start, end) {
    const [x, y] = point;
    const [x1, y1] = start;
    const [x2, y2] = end;
    const cross = (x - x1) * (y2 - y1) - (y - y1) * (x2 - x1);
    const epsilon = 1e-10;
    return Math.abs(cross) <= epsilon
      && x >= Math.min(x1, x2) - epsilon && x <= Math.max(x1, x2) + epsilon
      && y >= Math.min(y1, y2) - epsilon && y <= Math.max(y1, y2) + epsilon;
  }

  function pointInRing(point, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const start = ring[j];
      const end = ring[i];
      if (pointOnRingSegment(point, start, end)) return true;
      if ((start[1] > point[1]) !== (end[1] > point[1])
        && point[0] < (end[0] - start[0]) * (point[1] - start[1]) / (end[1] - start[1]) + start[0]) {
        inside = !inside;
      }
    }
    return inside;
  }

  function pointInPolygon(point, rings) {
    return Boolean(rings?.length && pointInRing(point, rings[0]) && !rings.slice(1).some(ring => pointInRing(point, ring)));
  }

  function isInsideGeometry(lon, lat, geometry) {
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || !geometry) return false;
    const point = [lon, lat];
    if (geometry.type === "Polygon") return pointInPolygon(point, geometry.coordinates);
    if (geometry.type === "MultiPolygon") return geometry.coordinates.some(polygon => pointInPolygon(point, polygon));
    return false;
  }

  function countyAtPoint(lon, lat) {
    for (const boundary of countyBoundaries) {
      const { minLon, minLat, maxLon, maxLat } = boundary.bounds;
      if (lon < minLon || lon > maxLon || lat < minLat || lat > maxLat) continue;
      if (isInsideGeometry(lon, lat, boundary.geometry)) return boundary.name;
    }
    return "";
  }

  function withResolvedCounty(spot, forceRecalculate = false) {
    const savedCounty = String(spot.county || "").trim();
    const county = !forceRecalculate && savedCounty
      ? savedCounty
      : countyAtPoint(Number(spot.lon), Number(spot.lat));
    const resolvedCounty = county || savedCounty;
    const resolved = resolvedCounty && resolvedCounty !== spot.county ? { ...spot, county: resolvedCounty } : spot;
    spotCountiesByCoordinates.set(resolved, resolvedCounty);
    return resolved;
  }

  function findCountySearchMatches(query) {
    return countyBoundaries.filter(boundary => query === boundary.normalizedName || query === boundary.shortName);
  }

  function drawMapMarkers(filteredSpots = getFilteredSpots(false)) {
    if (!map || !markerLayer) return;
    markerLayer.clearLayers();
    const renderer = L.canvas({ padding: 0.5 });
    for (const spot of filteredSpots.slice(0, 2500)) {
      const marker = L.circleMarker([Number(spot.lat), Number(spot.lon)], {
        renderer,
        radius: 5,
        weight: 1.4,
        color: "#fff",
        fillColor: markerColor(spot),
        fillOpacity: 0.9
      }).addTo(markerLayer);
      marker.bindTooltip(escapeHtml(spot.name), { direction: "top", className: "spot-label", opacity: 0.96, interactive: true });
      marker.on("click", () => openSpotDialog(spot));
    }
    if (userPosition) {
      if (userMarker) userMarker.remove();
      userMarker = L.circleMarker([userPosition.lat, userPosition.lon], { radius: 8, weight: 3, color: "#fff", fillColor: "#3979de", fillOpacity: 1 }).addTo(map).bindTooltip("目前位置");
    }
    updateMapSpotLabels();
  }

  function updateMapSpotLabels() {
    if (!map || !markerLayer) return;
    const labelsEnabled = map.getZoom() >= MAP_SPOT_LABEL_ZOOM;
    const bounds = labelsEnabled ? map.getBounds().pad(0.08) : null;
    markerLayer.eachLayer(marker => {
      const tooltip = marker.getTooltip();
      if (!tooltip) return;
      const shouldShow = labelsEnabled && bounds.contains(marker.getLatLng());
      if (tooltip.options.permanent === shouldShow) return;
      const content = tooltip.getContent();
      marker.unbindTooltip();
      marker.bindTooltip(content, {
        direction: "top",
        className: "spot-label",
        opacity: 0.96,
        permanent: shouldShow,
        interactive: true
      });
      if (shouldShow) marker.openTooltip();
    });
  }

  function getFilteredSpots(applyRadius = true) {
    const query = normalizeSearchText($("#searchInput").value.trim());
    const searchCounties = findCountySearchMatches(query);
    const includeTempleFacilities = $("#templeFacilitiesToggle")?.getAttribute("aria-pressed") === "true" || /廟|寺|宮|祠|壇|神社|道觀|精舍|佛堂|堂|殿/u.test(query);
    const includeWaterfront = $("#waterfrontToggle")?.getAttribute("aria-pressed") === "true";
    const radiusValue = $("#radiusSelect").value;
    const favorites = $("#favoritesOnly").getAttribute("aria-pressed") === "true";
    let result = spots.filter(spot => {
      if (spot.category === "temple-restroom" && !includeTempleFacilities) return false;
      if (spot.category === "waterfront" && !includeWaterfront) return false;
      if (includeWaterfront && !spot.waterType) return false;
      if (favorites && !favoriteIds.has(spot.id)) return false;
      if (searchCounties.length && !searchCounties.some(boundary => normalizeSearchText(spotCountiesByCoordinates.get(spot) || spot.county || "") === boundary.normalizedName)) return false;
      if (query && !searchCounties.length && !normalizeSearchText(`${spot.name} ${spot.county || ""} ${spot.lat} ${spot.lon} ${spot.hot || ""} ${spot.waterLabel || ""} ${spot.waterType || ""}`).includes(query)) return false;
      if (applyRadius && !query && radiusValue !== "all" && userPosition && haversineKm(userPosition, spot) > Number(radiusValue)) return false;
      return true;
    });
    if ($("#sortSelect").value === "name" || !userPosition) result.sort((a, b) => a.name.localeCompare(b.name, "zh-Hant"));
    else result.sort((a, b) => haversineKm(userPosition, a) - haversineKm(userPosition, b));
    return result;
  }

  function makeSpotCard(spot) {
    const distance = userPosition ? `<span class="badge">${haversineKm(userPosition, spot).toFixed(1)} 公里</span>` : "";
    const county = spot.county ? `<span class="badge">${escapeHtml(spot.county)}</span>` : "";
    const hot = spot.hot !== "" && spot.hot != null ? `<span class="badge warm">熱水欄位 ${escapeHtml(spot.hot)}</span>` : "";
    const photo = spot.photo ? `<span class="badge">有圖片</span>` : "";
    const toilet = spot.toiletInfo;
    const toiletBadge = toilet?.status === "onsite"
      ? `<span class="badge toilet-badge">廟宇登記公廁</span>`
      : toilet?.nearby?.length
        ? `<span class="badge toilet-badge">附近公廁 ${Number(toilet.nearby[0].distanceM).toLocaleString("zh-TW")} m</span>`
        : "";
    const categoryBadge = spot.category === "temple-restroom" ? `<span class="badge toilet-badge">廟宇公廁・非車泊點</span>` : "";
    const waterBadge = spot.waterType ? `<span class="badge waterfront-badge">${spot.waterLabel || "近水點"}${spot.category === "waterfront" ? "・非車泊點" : ""}</span>` : "";
    const saved = favoriteIds.has(spot.id);
    return `<article class="spot-card" data-spot-card="${escapeHtml(spot.id)}">
      <div class="spot-card-head"><button class="spot-title" type="button" data-action="details" data-id="${escapeHtml(spot.id)}">${escapeHtml(spot.name)}</button><button class="favorite-button ${saved ? "saved" : ""}" type="button" data-action="favorite" data-id="${escapeHtml(spot.id)}" aria-label="${saved ? "取消收藏" : "收藏"}">${saved ? "♥" : "♡"}</button></div>
      <p class="spot-coords">${Number(spot.lat).toFixed(5)}, ${Number(spot.lon).toFixed(5)}${distance ? `　·　${distance.replace(/<[^>]*>/g, "")}` : ""}</p>
      <div class="spot-badges">${county}${categoryBadge}${waterBadge}${toiletBadge}${hot}${photo}</div>
      <div class="spot-actions"><button class="mini-action" type="button" data-action="food" data-id="${escapeHtml(spot.id)}">附近美食</button><button class="mini-action" type="button" data-action="attractions" data-id="${escapeHtml(spot.id)}">附近景點</button><button class="mini-action" type="button" data-action="map" data-id="${escapeHtml(spot.id)}">地圖定位</button><a class="mini-action google" href="${googleSpotSearchUrl(spot)}" target="_blank" rel="noopener">Google 地點／評價 ↗</a></div>
    </article>`;
  }

  function focusMapOnSpots(filteredSpots) {
    if (!map || !filteredSpots.length) return;
    if (filteredSpots.length === 1) {
      const spot = filteredSpots[0];
      map.setView([Number(spot.lat), Number(spot.lon)], 12, { animate: false });
      return;
    }
    const bounds = L.latLngBounds(filteredSpots.map(spot => [Number(spot.lat), Number(spot.lon)]));
    if (bounds.isValid()) map.fitBounds(bounds.pad(0.12), { maxZoom: 11, animate: false });
  }

  function renderSpots(focusResults = false) {
    if (!spots.length) return;
    const results = getFilteredSpots();
    const countLabel = $("#resultCount");
    const includeTempleFacilities = $("#templeFacilitiesToggle")?.getAttribute("aria-pressed") === "true" || /廟|寺|宮|祠|壇|神社|道觀|精舍|佛堂|堂|殿/u.test($("#searchInput").value);
    const includeWaterfront = $("#waterfrontToggle")?.getAttribute("aria-pressed") === "true";
    countLabel.textContent = `${results.length.toLocaleString("zh-TW")} 個${includeWaterfront || includeTempleFacilities ? "地點" : "泊點"}`;
    const hasQuery = $("#searchInput").value.trim();
    const searchCounties = findCountySearchMatches(normalizeSearchText(String(hasQuery || "").trim()));
    $("#listSubheading").textContent = hasQuery
      ? searchCounties.length
        ? userPosition ? `依${searchCounties.map(boundary => boundary.name).join("、")}座標範圍篩選；依目前位置排序` : `依${searchCounties.map(boundary => boundary.name).join("、")}座標範圍篩選泊點`
        : userPosition ? "關鍵字搜尋全台；依目前位置排序" : "關鍵字搜尋全台泊點"
      : userPosition ? "已依距離排序；可選距離縮小附近範圍" : "可收藏常用泊點";
    const list = $("#spotList");
    list.innerHTML = results.slice(0, visibleCount).map(makeSpotCard).join("") || `<div class="empty-state"><strong>找不到符合的${includeWaterfront ? "近水地點" : "泊點"}</strong><p>試試不同關鍵字或放寬距離範圍。</p></div>`;
    $("#loadMore").hidden = results.length <= visibleCount;
    drawMapMarkers(results);
    if (focusResults) focusMapOnSpots(results);
  }

  function fillSpotSelectors() {
    const sorted = [...spots].sort((a, b) => a.name.localeCompare(b.name, "zh-Hant"));
    const optionText = spot => `<option value="${escapeHtml(spot.id)}">${escapeHtml(spot.name)} (${Number(spot.lat).toFixed(3)}, ${Number(spot.lon).toFixed(3)})</option>`;
    const start = $("#startSpot");
    const previousStart = start.value;
    start.innerHTML = `<option value="current">目前位置（先定位）</option>${sorted.map(optionText).join("")}`;
    if (previousStart && [...start.options].some(option => option.value === previousStart)) start.value = previousStart;
    const food = $("#foodSpotSelect");
    const previousFood = food.value;
    food.innerHTML = sorted.map(optionText).join("");
    if (previousFood && [...food.options].some(option => option.value === previousFood)) food.value = previousFood;
    const attraction = $("#attractionSpotSelect");
    const previousAttraction = attraction.value;
    attraction.innerHTML = sorted.map(optionText).join("");
    if (previousAttraction && [...attraction.options].some(option => option.value === previousAttraction)) attraction.value = previousAttraction;
    const datalist = $("#spotNameOptions");
    datalist.innerHTML = sorted.map(spot => `<option value="${escapeHtml(spot.name)}"></option>`).join("");
  }

  function getSpot(id) {
    return spots.find(spot => spot.id === id);
  }

  function renderSpotUpdateSearch() {
    const input = $("#spotUpdateSearch");
    if (!input) return;
    const query = normalizeSearchText(input.value.trim());
    const eligible = spots.filter(spot => spot.category !== "temple-restroom" && spot.category !== "waterfront" && spot.overnightEligible !== false);
    const matches = query
      ? eligible.filter(spot => normalizeSearchText(`${spot.name} ${spot.county || ""} ${spot.lat} ${spot.lon}`).includes(query))
      : [];
    const shown = matches.slice(0, 12);
    $("#spotUpdateCount").textContent = query ? `${matches.length.toLocaleString("zh-TW")} 筆符合${matches.length > shown.length ? "，顯示前 12 筆" : ""}` : "輸入關鍵字開始搜尋";
    $("#spotUpdateResults").innerHTML = query
      ? shown.map(spot => `<button class="spot-update-result ${spot.id === selectedSpotUpdateId ? "selected" : ""}" type="button" data-update-spot="${escapeHtml(spot.id)}"><strong>${escapeHtml(spot.name)}</strong><span>${escapeHtml(spot.county || "泊點")} · ${Number(spot.lat).toFixed(5)}, ${Number(spot.lon).toFixed(5)}</span></button>`).join("") || `<div class="empty-state"><strong>找不到符合的泊點</strong><p>試試名稱、縣市或座標的一部分。</p></div>`
      : `<div class="empty-state"><strong>搜尋要更新的泊點</strong><p>目前共有 ${eligible.length.toLocaleString("zh-TW")} 筆泊點可搜尋。</p></div>`;
  }

  function selectSpotForUpdate(id) {
    const spot = getSpot(id);
    if (!spot) return;
    selectedSpotUpdateId = spot.id;
    $("#spotUpdateName").value = spot.name || "";
    $("#spotUpdateLat").value = String(spot.lat ?? "");
    $("#spotUpdateLon").value = String(spot.lon ?? "");
    $("#spotUpdateHot").value = spot.hot ?? "";
    $("#spotUpdatePhoto").value = spot.photo || "";
    $("#spotUpdateFormTitle").textContent = `更新：${spot.name}`;
    $("#spotUpdateStatus").textContent = "座標請依地圖或現場資訊確認。";
    $("#spotUpdateForm").hidden = false;
    renderSpotUpdateSearch();
    $("#spotUpdateForm").scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  async function saveSpotUpdate(event) {
    event.preventDefault();
    const original = getSpot(selectedSpotUpdateId);
    if (!original) return;
    const name = $("#spotUpdateName").value.trim();
    const lat = Number($("#spotUpdateLat").value);
    const lon = Number($("#spotUpdateLon").value);
    const photoValue = $("#spotUpdatePhoto").value.trim();
    const photo = photoValue ? safeWebUrl(photoValue) : "";
    if (!name) return notify("請輸入點位名稱。");
    if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180) return notify("請輸入有效的緯度與經度。");
    if (photoValue && !photo) return notify("圖片連結須使用 http 或 https 網址。");
    const coordinateConflict = spots.find(spot => spot.id !== original.id && Number(spot.lat) === lat && Number(spot.lon) === lon);
    if (coordinateConflict) return notify(`這組座標已屬於「${coordinateConflict.name}」，請確認後再儲存。`);
    const locationOverride = hasManualLocationOverride(original)
      || stableId(lat, lon) !== stableId(original.lat, original.lon);
    const locationChanged = stableId(lat, lon) !== stableId(original.lat, original.lon);
    const updated = withResolvedCounty({ ...original, name, lat, lon, locationOverride, hot: $("#spotUpdateHot").value.trim(), photo }, locationChanged);
    try {
      await dbPut("spots", updated);
      spots = spots.map(spot => spot.id === original.id ? updated : spot).sort((a, b) => a.name.localeCompare(b.name, "zh-Hant"));
      fillSpotSelectors();
      renderSpots();
      renderSpotUpdateSearch();
      $("#spotUpdateFormTitle").textContent = `已更新：${updated.name}`;
      $("#spotUpdateStatus").textContent = "已儲存在此瀏覽器。下載目前資料可備份這筆更新。";
      notify("泊點已更新並儲存在此裝置。");
    } catch (error) {
      $("#spotUpdateStatus").textContent = error.message || "儲存失敗，請確認瀏覽器儲存空間。";
    }
  }

  function cancelSpotUpdate() {
    selectedSpotUpdateId = null;
    $("#spotUpdateForm").reset();
    $("#spotUpdateForm").hidden = true;
    renderSpotUpdateSearch();
  }

  function directKmlChildText(node, name) {
    const child = [...(node?.children || [])].find(element => element.localName === name);
    return child?.textContent?.trim() || "";
  }

  function kmlElements(node, name) {
    return [...(node?.getElementsByTagNameNS?.("*", name) || [])];
  }

  function readKmlMetadata(placemark) {
    const fields = new Map();
    for (const data of kmlElements(placemark, "Data")) {
      const key = data.getAttribute("name");
      const value = directKmlChildText(data, "value");
      if (key && value) fields.set(normalizeSearchText(key), value);
    }
    for (const data of kmlElements(placemark, "SimpleData")) {
      const key = data.getAttribute("name");
      const value = data.textContent.trim();
      if (key && value) fields.set(normalizeSearchText(key), value);
    }
    const pick = (...keys) => keys.map(key => fields.get(normalizeSearchText(key))).find(Boolean) || "";
    return {
      hot: pick("熱水欄位（原始值）", "熱水欄位", "熱水", "hot"),
      photo: pick("圖片連結", "圖片", "photo"),
      style: pick("圖示樣式ID", "樣式ID", "style")
    };
  }

  function parseSourceKml(kmlText) {
    const xml = new DOMParser().parseFromString(kmlText, "application/xml");
    if (xml.getElementsByTagName("parsererror").length) throw new Error("KML 格式無法讀取，請重新匯出來源地圖。");
    const folder = kmlElements(xml, "Folder").find(item => normalizeSearchText(directKmlChildText(item, "name")).replace(/[\s　]/g, "") === "泊點");
    if (!folder) throw new Error("來源 KML 沒有找到名稱為「泊點」的圖層。請匯出整份來源地圖的 KML。");
    const byId = new Map();
    for (const placemark of kmlElements(folder, "Placemark")) {
      const name = directKmlChildText(placemark, "name");
      const point = kmlElements(placemark, "Point")[0];
      const coordinateText = directKmlChildText(point, "coordinates");
      const [lonText, latText] = coordinateText.split(/[\s,]+/).filter(Boolean);
      const lat = Number(latText);
      const lon = Number(lonText);
      if (!name || !Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;
      const metadata = readKmlMetadata(placemark);
      let photo = safeWebUrl(metadata.photo);
      if (!photo) {
        const description = directKmlChildText(placemark, "description");
        if (description) {
          const descriptionDoc = new DOMParser().parseFromString(description, "text/html");
          photo = safeWebUrl(descriptionDoc.querySelector("img[src]")?.getAttribute("src"));
        }
      }
      const style = metadata.style || directKmlChildText(placemark, "styleUrl").replace(/^#/, "");
      const id = stableId(lat, lon);
      byId.set(id, { id, name, lat, lon, hot: metadata.hot, photo, style, source: "公開總圖" });
    }
    if (!byId.size) throw new Error("在「泊點」圖層中沒有讀到有效座標點。");
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, "zh-Hant"));
  }

  function renderSourceSpots() {
    const search = $("#sourceSpotSearch");
    const query = normalizeSearchText(search.value.trim());
    const matches = sourceSpots.filter(spot => !query || normalizeSearchText(`${spot.name} ${spot.lat} ${spot.lon}`).includes(query));
    const shown = matches.slice(0, 100);
    const candidateIds = new Set(sourceSpots.map(spot => spot.id));
    for (const id of selectedSourceSpotIds) if (!candidateIds.has(id)) selectedSourceSpotIds.delete(id);
    $("#sourceSpotCount").textContent = `${matches.length.toLocaleString("zh-TW")} 筆可新增${matches.length > shown.length ? "，顯示前 100 筆" : ""}`;
    $("#sourceSpotResults").innerHTML = shown.length
      ? shown.map(spot => `<label class="source-spot-result"><input type="checkbox" data-source-spot="${escapeHtml(spot.id)}" ${selectedSourceSpotIds.has(spot.id) ? "checked" : ""}><span><strong>${escapeHtml(spot.name)}</strong><small>${Number(spot.lat).toFixed(5)}, ${Number(spot.lon).toFixed(5)}${spot.hot ? ` · 熱水 ${escapeHtml(spot.hot)}` : ""}</small></span></label>`).join("")
      : `<div class="empty-state"><strong>${sourceSpotsReady ? "沒有符合的新增泊點" : "尚未載入來源資料"}</strong><p>${sourceSpotsReady ? "目前搜尋條件沒有可新增的項目，或來源泊點都已在本機資料中。" : "按下上方按鈕搜尋來源地圖，或匯入 KML 檔。"}</p></div>`;
    $("#selectVisibleSourceSpots").disabled = !shown.length;
    $("#addSelectedSourceSpots").disabled = selectedSourceSpotIds.size === 0;
    $("#addSelectedSourceSpots").textContent = selectedSourceSpotIds.size ? `新增所選泊點（${selectedSourceSpotIds.size}）` : "新增所選泊點";
  }

  function acceptSourceKml(kmlText, sourceLabel) {
    const imported = parseSourceKml(kmlText);
    const knownIds = new Set(spots.map(spot => spot.id));
    const knownCoordinates = new Set(spots.map(spot => stableId(spot.lat, spot.lon)));
    sourceSpots = imported.filter(spot => !knownIds.has(spot.id) && !knownCoordinates.has(stableId(spot.lat, spot.lon)));
    sourceSpotsReady = true;
    selectedSourceSpotIds.clear();
    $("#sourceSpotSearch").disabled = false;
    $("#sourceSpotSearch").value = "";
    $("#sourceSpotStatus").textContent = `已讀取${sourceLabel}：來源「泊點」圖層 ${imported.length.toLocaleString("zh-TW")} 筆，有 ${sourceSpots.length.toLocaleString("zh-TW")} 筆尚未加入本機。`;
    renderSourceSpots();
  }

  async function searchSourceSpots() {
    const button = $("#searchSourceSpotsButton");
    button.disabled = true;
    button.textContent = "正在讀取來源…";
    $("#sourceSpotStatus").textContent = "正在向公開總圖讀取最新泊點資料…";
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);
      try {
        const response = await fetch(SOURCE_KML_URL, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error(`來源地圖回應 HTTP ${response.status}。`);
        acceptSourceKml(await response.text(), "來源地圖");
      } finally { clearTimeout(timeout); }
    } catch (error) {
      const reason = error.name === "AbortError" ? "連線逾時。" : error instanceof TypeError ? "瀏覽器或來源伺服器未允許直接讀取。" : error.message || "瀏覽器無法直接讀取來源地圖。";
      $("#sourceSpotStatus").textContent = `${reason} 可在來源地圖匯出 KML，或點選「匯入來源 KML」讀取。`;
    } finally {
      button.disabled = false;
      button.textContent = "重新搜尋來源泊點";
    }
  }

  async function importSourceKmlFile(file) {
    if (!file) return;
    try {
      acceptSourceKml(await file.text(), `檔案「${file.name}」`);
    } catch (error) {
      $("#sourceSpotStatus").textContent = error.message || "無法讀取 KML 檔。";
    } finally {
      $("#sourceKmlInput").value = "";
    }
  }

  function toggleVisibleSourceSpots() {
    const query = normalizeSearchText($("#sourceSpotSearch").value.trim());
    const shown = sourceSpots.filter(spot => !query || normalizeSearchText(`${spot.name} ${spot.lat} ${spot.lon}`).includes(query)).slice(0, 100);
    const allSelected = shown.length && shown.every(spot => selectedSourceSpotIds.has(spot.id));
    for (const spot of shown) {
      if (allSelected) selectedSourceSpotIds.delete(spot.id);
      else selectedSourceSpotIds.add(spot.id);
    }
    renderSourceSpots();
  }

  async function addSelectedSourceSpots() {
    const selected = sourceSpots.filter(spot => selectedSourceSpotIds.has(spot.id));
    if (!selected.length) return;
    const knownIds = new Set(spots.map(spot => spot.id));
    const knownCoordinates = new Set(spots.map(spot => stableId(spot.lat, spot.lon)));
    const added = selected.filter(spot => !knownIds.has(spot.id) && !knownCoordinates.has(stableId(spot.lat, spot.lon)));
    if (!added.length) {
      $("#sourceSpotStatus").textContent = "選取的泊點已存在於本機資料。";
      acceptSourceKmlSearchRefresh();
      return;
    }
    const button = $("#addSelectedSourceSpots");
    button.disabled = true;
    try {
      const normalizedAdded = added.map(spot => withResolvedCounty(spot));
      for (const spot of normalizedAdded) await dbPut("spots", spot);
      spots = [...spots, ...normalizedAdded].sort((a, b) => a.name.localeCompare(b.name, "zh-Hant"));
      fillSpotSelectors();
      visibleCount = PAGE_SIZE;
      renderSpots();
      renderSpotUpdateSearch();
      renderReports();
      const addedIds = new Set(added.map(spot => spot.id));
      sourceSpots = sourceSpots.filter(spot => !addedIds.has(spot.id));
      selectedSourceSpotIds.clear();
      $("#sourceSpotStatus").textContent = `已新增 ${added.length.toLocaleString("zh-TW")} 筆泊點，資料已儲存在此瀏覽器。`;
      renderSourceSpots();
      notify(`已新增 ${added.length} 筆來源泊點。`);
    } catch (error) {
      $("#sourceSpotStatus").textContent = error.message || "新增泊點失敗，請確認瀏覽器儲存空間。";
    } finally {
      button.disabled = false;
      renderSourceSpots();
    }
  }

  function acceptSourceKmlSearchRefresh() {
    const knownIds = new Set(spots.map(spot => spot.id));
    const knownCoordinates = new Set(spots.map(spot => stableId(spot.lat, spot.lon)));
    sourceSpots = sourceSpots.filter(spot => !knownIds.has(spot.id) && !knownCoordinates.has(stableId(spot.lat, spot.lon)));
    selectedSourceSpotIds.clear();
    renderSourceSpots();
  }

  function centerOnSpot(spot) {
    if (!map) return;
    switchTab("find");
    const visible = getFilteredSpots();
    if (!visible.some(item => item.id === spot.id)) visible.unshift(spot);
    drawMapMarkers(visible);
    map.invalidateSize();
    map.setView([Number(spot.lat), Number(spot.lon)], Math.max(12, map.getZoom()));
  }

  function openSpotDialog(spot) {
    if (!spot) return;
    const distance = userPosition ? `<span class="badge">距目前位置 ${haversineKm(userPosition, spot).toFixed(1)} 公里</span>` : "";
    const hot = spot.hot !== "" && spot.hot != null ? `<span class="badge warm">熱水原始值：${escapeHtml(spot.hot)}</span>` : "";
    const photo = spot.photo ? `<img class="dialog-image" src="${escapeHtml(spot.photo)}" alt="${escapeHtml(spot.name)} 地圖圖片" loading="lazy">` : "";
    const toiletInfo = spot.toiletInfo;
    const restroomLines = (toiletInfo?.restrooms || []).map(item => `<li>${escapeHtml(item.type || "登記公廁")}${item.grade ? ` · ${escapeHtml(item.grade)}` : ""}</li>`).join("");
    const nearbyLines = (toiletInfo?.nearby || []).map(item => {
      const url = googleSearchUrl(item.name, item.lat, item.lon);
      return `<li><a href="${url}" target="_blank" rel="noopener">${escapeHtml(item.name)}</a> · ${Number(item.distanceM).toLocaleString("zh-TW")} 公尺${item.category ? ` · ${escapeHtml(item.category)}` : ""}${item.grade ? ` · ${escapeHtml(item.grade)}` : ""}</li>`;
    }).join("");
    const restroomSection = toiletInfo ? `<div class="dialog-section"><h3>${toiletInfo.status === "onsite" ? "廟宇登記公廁" : "附近登記公廁"}</h3>${restroomLines ? `<ul>${restroomLines}</ul>` : ""}${nearbyLines ? `<p>附近 250 公尺內：</p><ul>${nearbyLines}</ul>` : ""}<p>資料來自環境部全國公廁建檔資料；來源未標示沖水方式、即時開放時間或外來訪客是否可使用。車泊許可請另向管理單位確認。</p><a href="https://data.moenv.gov.tw/dataset/detail/FAC_P_07" target="_blank" rel="noopener">查看環境部資料來源 ↗</a></div>` : "";
    const titleLabel = spot.category === "temple-restroom" ? "環境部公開資料・廟宇登記公廁（非車泊點）" : "公開地圖・泊點";
    const spotDetails = spot.category === "temple-restroom"
      ? "這是廟宇登記公廁的位置，並非車宿泊點。廟方開放時間、訪客使用規定與停車／過夜許可須先向管理單位確認。"
      : "本地資料只包含名稱和座標等公開地圖欄位。地點是否開放車泊、費用和設施狀態請向場地確認。";
    const waterBadge = spot.waterType ? `<span class="badge waterfront-badge">${escapeHtml(spot.waterLabel || "近水點")}</span>` : "";
    const waterSourceUrl = safeWebUrl(spot.officialSourceUrl);
    const waterSection = spot.waterType ? `<div class="dialog-section"><h3>${escapeHtml(spot.waterLabel || "近水位置")}</h3><p>${escapeHtml(spot.accessEvidence || "依公開地圖名稱整理的水域附近線索；實際道路、步行距離與停車請現場確認。")}</p><p>此分類不判定是否可戲水，也不代表車輛可抵達水岸、可停車或允許車宿。</p>${waterSourceUrl ? `<a href="${escapeHtml(waterSourceUrl)}" target="_blank" rel="noopener">${escapeHtml(spot.officialSourceTitle || "查看官方地點資料")} ↗</a>` : ""}</div>` : "";
    const content = $("#dialogContent");
    content.innerHTML = `<div class="dialog-body"><p class="dialog-eyebrow">${titleLabel}</p><h2>${escapeHtml(spot.name)}</h2><p class="dialog-coords">${Number(spot.lat).toFixed(6)}, ${Number(spot.lon).toFixed(6)}${spot.address ? ` · ${escapeHtml(spot.address)}` : ""}</p><div class="dialog-badges">${spot.county ? `<span class="badge">${escapeHtml(spot.county)}</span>` : ""}${waterBadge}${distance}${hot}${spot.photo ? `<span class="badge">來源附有圖片</span>` : ""}</div>${photo}<div class="dialog-actions"><a class="button button-primary" href="${googleSpotSearchUrl(spot)}" target="_blank" rel="noopener">Google 地點與評價 ↗</a><button class="button button-light" type="button" data-dialog-action="food" data-id="${escapeHtml(spot.id)}">搜尋附近美食</button><button class="button button-light" type="button" data-dialog-action="map" data-id="${escapeHtml(spot.id)}">地圖定位</button></div><div class="dialog-section"><h3>${spot.category === "temple-restroom" ? "地點說明" : spot.category === "waterfront" ? "近水景點資訊" : "泊點資訊"}</h3><p>${spotDetails}</p></div>${waterSection}${restroomSection}</div>`;
    const dialog = $("#spotDialog");
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  }

  function setPosition(position) {
    userPosition = { lat: position.coords.latitude, lon: position.coords.longitude };
    if (userMarker) userMarker.remove();
    if (map) {
      userMarker = L.circleMarker([userPosition.lat, userPosition.lon], { radius: 8, weight: 3, color: "#fff", fillColor: "#3979de", fillOpacity: 1 }).addTo(map).bindTooltip("目前位置");
      map.setView([userPosition.lat, userPosition.lon], 12);
    }
    renderSpots();
    notify("已定位，泊點依距離排列。");
  }

  function locateUser() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(new Error("此瀏覽器不支援定位功能。"));
      navigator.geolocation.getCurrentPosition(position => { setPosition(position); resolve(userPosition); }, error => {
        const message = error.code === 1 ? "請在瀏覽器設定中允許定位，或改選一個起點泊點。" : "目前無法取得位置，請稍後再試。";
        reject(new Error(message));
      }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 300000 });
    });
  }

  function switchTab(name) {
    $$(".nav-item").forEach(button => button.classList.toggle("active", button.dataset.tab === name));
    $$(".view").forEach(view => view.classList.toggle("active", view.id === `view-${name}`));
    if (name === "find" && map) setTimeout(() => map.invalidateSize(), 50);
    if (name === "updates") renderReports();
    history.replaceState(null, "", `#${name}`);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function toggleFavorite(id) {
    if (favoriteIds.has(id)) favoriteIds.delete(id);
    else favoriteIds.add(id);
    localStorage.setItem("che-su-favorites", JSON.stringify([...favoriteIds]));
    renderSpots();
  }

  function handleSpotAction(action, id) {
    const spot = getSpot(id);
    if (!spot) return;
    if (action === "details") openSpotDialog(spot);
    if (action === "favorite") toggleFavorite(id);
    if (action === "map") centerOnSpot(spot);
    if (action === "food") {
      $("#foodSpotSelect").value = id;
      switchTab("food");
      searchFood();
    }
    if (action === "attractions") {
      $("#attractionSpotSelect").value = id;
      switchTab("attractions");
      searchNearbyAttractions();
    }
  }

  function categorizeFood(tags) {
    const amenity = tags.amenity || "餐飲店家";
    const names = { restaurant: "餐廳", cafe: "咖啡店", fast_food: "速食／小吃", food_court: "美食街", ice_cream: "冰品" };
    return names[amenity] || amenity.replaceAll("_", " ");
  }

  async function loadFoodDirectory() {
    if (!foodDirectoryPromise) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12000);
      foodDirectoryPromise = fetch(new URL(FOOD_DATA_URL, document.baseURI), { signal: controller.signal })
        .then(response => {
          if (!response.ok) throw new Error(`觀光署餐飲目錄回應 HTTP ${response.status}`);
          return response.json();
        })
        .then(data => {
          if (!Array.isArray(data.points)) throw new Error("觀光署餐飲目錄格式不正確。");
          return data;
        })
        .catch(error => {
          foodDirectoryPromise = null;
          throw error;
        }).finally(() => clearTimeout(timer));
    }
    return foodDirectoryPromise;
  }

  function normalizeDirectoryFoods(points, spot, radius) {
    return (points || []).flatMap(point => {
      const lat = Number(point.lat);
      const lon = Number(point.lon);
      if (!point.name || !Number.isFinite(lat) || !Number.isFinite(lon)) return [];
      const distance = haversineKm(spot, { lat, lon }) * 1000;
      if (distance > radius) return [];
      const address = [point.city, point.town, point.address].filter(Boolean).join(" ");
      return [{
        id: point.id,
        name: point.name,
        lat,
        lon,
        category: "觀光署登錄餐飲",
        cuisine: "",
        opening: point.opening || "",
        address,
        phone: point.phone || "",
        distance,
        source: "交通部觀光署"
      }];
    }).sort((a, b) => a.distance - b.distance).slice(0, 30);
  }

  function foodQuery(lat, lon, radius) {
    return `[out:json][timeout:12];(nwr["amenity"~"^(restaurant|cafe|fast_food|food_court|ice_cream)$"]["name"](around:${Math.round(radius)},${Number(lat).toFixed(6)},${Number(lon).toFixed(6)}););out center qt 100;`;
  }

  function normalizeFoodElements(elements, spot, radius) {
    const unique = new Map();
    for (const element of elements || []) {
      const tags = element.tags || {};
      const name = tags.name || tags["name:zh"] || tags["name:en"];
      if (!name) continue;
      const lat = Number(element.lat ?? element.center?.lat);
      const lon = Number(element.lon ?? element.center?.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const id = `${name.toLocaleLowerCase("zh-Hant")}_${lat.toFixed(4)}_${lon.toFixed(4)}`;
      const distance = haversineKm(spot, { lat, lon }) * 1000;
      if (distance > radius) continue;
      if (!unique.has(id)) unique.set(id, { name, lat, lon, category: categorizeFood(tags), cuisine: tags.cuisine || "", opening: tags.opening_hours || "", distance, source: "OpenStreetMap" });
    }
    return [...unique.values()].sort((a, b) => a.distance - b.distance).slice(0, 30);
  }

  function mergeFoodResults(...groups) {
    const result = [];
    for (const food of groups.flat().sort((a, b) => a.distance - b.distance)) {
      const duplicate = result.some(item => normalizeSearchText(item.name) === normalizeSearchText(food.name) && haversineKm(item, food) <= 0.12);
      if (!duplicate) result.push(food);
    }
    return result.slice(0, 30);
  }

  function showFoodStatus(title, body, fallbackLink = "") {
    $("#foodResults").innerHTML = `<div class="empty-state"><span class="empty-icon">♨</span><strong>${escapeHtml(title)}</strong><p>${escapeHtml(body)}</p>${fallbackLink ? `<p><a class="button button-light" href="${fallbackLink}" target="_blank" rel="noopener">開啟 Google 地圖附近美食 ↗</a></p>` : ""}</div>`;
  }

  function isFoodAbortError(error) {
    return error?.name === "AbortError" || /signal is aborted|operation was aborted/i.test(error?.message || "");
  }

  function foodErrorTitle(error) {
    if ([429, 406, 503].includes(error?.status)) return "附近店家服務忙碌";
    if (isFoodAbortError(error)) return "附近店家查詢逾時";
    return "目前無法連線至附近店家服務";
  }

  function renderFoodResults(foods, spot, radius, options = {}) {
    const { staleAt = 0, message = "", directorySource = "" } = typeof options === "number" ? { staleAt: options } : options;
    if (!foods.length) {
      showFoodStatus("附近沒有找到已命名店家", "可改用 Google 地圖查看附近餐廳，或擴大搜尋半徑。", googleSearchUrl("餐廳", spot.lat, spot.lon, "near"));
      return;
    }
    const cards = foods.map(food => {
      const detail = [food.category, food.cuisine ? `料理：${food.cuisine}` : "", food.opening ? `營業時間：${food.opening}` : "", food.address ? `地址：${food.address}` : ""].filter(Boolean).join(" · ");
      const url = googleSearchUrl(food.name, food.lat, food.lon, "評價");
      return `<article class="food-result-card"><div><h3>${escapeHtml(food.name)}</h3><p>${escapeHtml(detail)}</p><div class="food-radius">距離泊點約 ${food.distance < 1000 ? `${Math.round(food.distance)} 公尺` : `${(food.distance / 1000).toFixed(1)} 公里`}</div></div><a class="food-link" href="${url}" target="_blank" rel="noopener">Google 評價 ↗</a></article>`;
    }).join("");
    const staleMessage = staleAt ? `<p class="data-source-hint">附近查詢逾時，先顯示上次成功資料（${new Date(staleAt).toLocaleString("zh-TW")}）。</p>` : "";
    const sources = [...new Set([directorySource, ...foods.map(food => food.source)].filter(Boolean))].join("、") || "OpenStreetMap";
    const updateMessage = message ? `<p class="data-source-hint">${escapeHtml(message)}</p>` : "";
    $("#foodResults").innerHTML = `${updateMessage}${staleMessage}<p class="data-source-hint">${escapeHtml(spot.name)} 周邊 ${Number(radius) / 1000} 公里 · ${foods.length} 個餐飲點 · ${escapeHtml(sources)}</p>${cards}<p class="data-source-hint">餐飲目錄可能不完整或延遲更新；Google 地圖連結可查看介紹、營業資訊與評價。</p>`;
  }

  async function fetchFoodFromEndpoint(endpoint, query, signal) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: `data=${encodeURIComponent(query)}`,
      signal
    });
    if (!response.ok) {
      const error = new Error(`附近店家服務回應 ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return response.json();
  }

  async function fetchFoodFromProxy(spot, radius, signal) {
    const params = new URLSearchParams({ lat: Number(spot.lat).toFixed(6), lon: Number(spot.lon).toFixed(6), radius: String(radius) });
    const response = await fetch(`./api/food?${params}`, { signal, cache: "no-store", headers: { "Accept": "application/json" } });
    if (!response.ok) {
      const error = new Error(`附近店家服務回應 ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return response.json();
  }

  async function searchFood() {
    if (foodRequestInProgress) return;
    const spot = getSpot($("#foodSpotSelect").value);
    if (!spot) return showFoodStatus("先選擇一個泊點", "回到找泊點頁面，也可以從任何泊點卡片直接開始搜尋。 ");
    const radius = Number($("#foodRadius").value);
    const key = `${spot.id}_${radius}`;
    const googleNearby = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`餐廳 near ${spot.lat},${spot.lon}`)}`;
    foodRequestInProgress = true;
    $("#searchFoodButton").disabled = true;
    $("#searchFoodButton").textContent = "搜尋中…";
    showFoodStatus("正在載入附近餐飲", "先讀取已下載的餐飲目錄，再嘗試更新地圖資料。", googleNearby);
    let fallbackFoods = [];
    let fallbackOptions = {};
    try {
      const [cachedResult, directoryResult] = await Promise.allSettled([
        dbGet("food", key),
        loadFoodDirectory()
      ]);
      const cached = cachedResult.status === "fulfilled" ? cachedResult.value : null;
      const directory = directoryResult.status === "fulfilled" ? directoryResult.value : null;
      const directoryFoods = normalizeDirectoryFoods(directory?.points, spot, radius);
      const cachedFoods = cached?.items || [];
      const hasFreshCache = cached && Date.now() - cached.savedAt < FOOD_TTL;
      let visibleFoods = mergeFoodResults(directoryFoods, cachedFoods);
      const directorySource = directory ? "交通部觀光署" : "";
      fallbackFoods = visibleFoods;
      fallbackOptions = { staleAt: cached?.savedAt || 0, directorySource };

      if (hasFreshCache) {
        renderFoodResults(visibleFoods, spot, radius, { directorySource });
        return;
      }
      if (!navigator.onLine) {
        if (visibleFoods.length) {
          renderFoodResults(visibleFoods, spot, radius, { staleAt: cached?.savedAt || 0, directorySource, message: "目前離線，顯示本機餐飲目錄與先前查詢資料。" });
        } else {
          showFoodStatus("目前離線", "先前搜尋過的店家會保存在本機；重新連線後可再次查詢。", googleNearby);
        }
        return;
      }
      if (visibleFoods.length) {
        fallbackOptions.message = "即時地圖查詢尚未完成，先顯示餐飲目錄與上次查詢資料。";
        renderFoodResults(visibleFoods, spot, radius, { ...fallbackOptions, message: "已先顯示餐飲目錄，正在背景更新附近地圖資料…" });
      } else {
        showFoodStatus("正在查詢附近店家", "目前沒有目錄店家，正在更新 OpenStreetMap 社群地圖。", googleNearby);
      }

      let data;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 26000);
      try {
        try {
          data = await fetchFoodFromProxy(spot, radius, controller.signal);
        } catch (error) {
          if (error.status !== 404 && error.status !== 405) throw error;
          const query = foodQuery(Number(spot.lat), Number(spot.lon), radius);
          const fallbackController = new AbortController();
          const fallbackTimer = setTimeout(() => fallbackController.abort(), 8000);
          try {
            data = await fetchFoodFromEndpoint("https://overpass-api.de/api/interpreter", query, fallbackController.signal);
          } finally {
            clearTimeout(fallbackTimer);
          }
        }
      } finally {
        clearTimeout(timer);
      }
      const items = normalizeFoodElements(data.elements, spot, radius);
      await dbPut("food", { key, items, savedAt: Date.now() }).catch(() => {});
      visibleFoods = mergeFoodResults(directoryFoods, items);
      renderFoodResults(visibleFoods, spot, radius, { directorySource });
    } catch (error) {
      if (fallbackFoods.length) {
        renderFoodResults(fallbackFoods, spot, radius, {
          ...fallbackOptions,
          message: `${foodErrorTitle(error)}，仍顯示可用的目錄／上次查詢資料。`
        });
        return;
      }
      showFoodStatus(foodErrorTitle(error), "店家資料服務可能暫時忙碌或網路連線不穩；可稍後重試，也可直接用 Google 地圖搜尋附近餐廳與評價。", googleNearby);
    } finally {
      foodRequestInProgress = false;
      $("#searchFoodButton").disabled = false;
      $("#searchFoodButton").textContent = "搜尋附近美食";
    }
  }

  function attractionQuery(lat, lon, radiusM) {
    const radius = Math.round(radiusM);
    const point = `${Number(lat).toFixed(6)},${Number(lon).toFixed(6)}`;
    return `[out:json][timeout:15];(nwr["name"]["tourism"~"^(attraction|museum|viewpoint|theme_park|zoo|aquarium|gallery|artwork)$"](around:${radius},${point});nwr["name"]["historic"](around:${radius},${point});nwr["name"]["leisure"~"^(park|garden|nature_reserve)$"](around:${radius},${point});nwr["name"]["natural"~"^(peak|waterfall|cave_entrance|hot_spring|beach)$"](around:${radius},${point}););out center qt 120;`;
  }

  function attractionCategory(tags) {
    const tourism = {
      attraction: "觀光景點", museum: "博物館", viewpoint: "觀景點", theme_park: "主題樂園",
      zoo: "動物園", aquarium: "水族館", gallery: "美術館／畫廊", artwork: "公共藝術"
    };
    const historic = {
      castle: "古堡", archaeological_site: "考古遺址", monument: "紀念碑", memorial: "紀念地",
      ruins: "遺跡", fort: "古城／要塞", manor: "歷史建築"
    };
    const leisure = { park: "公園", garden: "庭園", nature_reserve: "自然保護區" };
    const natural = { peak: "山峰", waterfall: "瀑布", cave_entrance: "洞穴", hot_spring: "溫泉", beach: "海灘" };
    if (tags.tourism) return tourism[tags.tourism] || "觀光景點";
    if (tags.historic) return historic[tags.historic] || "歷史景點";
    if (tags.leisure) return leisure[tags.leisure] || "休閒景點";
    if (tags.natural) return natural[tags.natural] || "自然景點";
    return "景點";
  }

  function normalizeAttractionElements(elements, spot, radius) {
    const results = [];
    for (const element of Array.isArray(elements) ? elements : []) {
      const tags = element.tags || {};
      const lat = Number(element.lat ?? element.center?.lat);
      const lon = Number(element.lon ?? element.center?.lon);
      const name = String(tags["name:zh-TW"] || tags["name:zh"] || tags.name || "").trim();
      if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const distance = haversineKm(spot, { lat, lon }) * 1000;
      if (distance > radius) continue;
      const normalizedName = normalizeSearchText(name);
      if (results.some(item => normalizeSearchText(item.name) === normalizedName && haversineKm(item, { lat, lon }) * 1000 <= 120)) continue;
      const address = tags["addr:full"] || [tags["addr:city"], tags["addr:district"] || tags["addr:suburb"], tags["addr:street"]].filter(Boolean).join("");
      results.push({
        name,
        lat,
        lon,
        category: attractionCategory(tags),
        address,
        opening: tags.opening_hours || "",
        distance,
        source: "OpenStreetMap"
      });
    }
    return results.sort((a, b) => a.distance - b.distance).slice(0, 80);
  }

  function showAttractionStatus(title, body, fallbackLink = "") {
    $("#attractionResults").innerHTML = `<div class="empty-state"><span class="empty-icon">景</span><strong>${escapeHtml(title)}</strong><p>${escapeHtml(body)}</p>${fallbackLink ? `<p><a class="button button-light" href="${escapeHtml(fallbackLink)}" target="_blank" rel="noopener">用 Google 地圖搜尋附近景點 ↗</a></p>` : ""}</div>`;
  }

  function attractionErrorTitle(error) {
    if ([429, 406, 503].includes(error?.status)) return "附近景點服務忙碌";
    if (error?.name === "AbortError" || /signal is aborted|operation was aborted/i.test(error?.message || "")) return "附近景點查詢逾時";
    return "目前無法連線至附近景點服務";
  }

  function renderAttractions(items, spot, radius, options = {}) {
    const { staleAt = 0, message = "" } = options;
    if (!items.length) {
      showAttractionStatus("附近沒有找到已命名景點", "可擴大搜尋半徑，或使用 Google 地圖查看附近景點。", googleSearchUrl("景點", spot.lat, spot.lon, "near"));
      return;
    }
    const cards = items.map(item => {
      const details = [item.category, item.address ? `地址：${item.address}` : "", item.opening ? `開放時間：${item.opening}` : ""].filter(Boolean).join(" · ");
      const url = googleSearchUrl(item.name, item.lat, item.lon, "景點");
      const distance = item.distance < 1000 ? `${Math.round(item.distance)} 公尺` : `${(item.distance / 1000).toFixed(1)} 公里`;
      return `<article class="food-result-card attraction-result-card"><div><h3>${escapeHtml(item.name)}</h3><p>${escapeHtml(details)}</p><div class="food-radius">距離泊點約 ${distance}</div></div><a class="food-link" href="${url}" target="_blank" rel="noopener">地圖導航 ↗</a></article>`;
    }).join("");
    const staleMessage = staleAt ? `<p class="data-source-hint">顯示上次查詢資料（${new Date(staleAt).toLocaleString("zh-TW")}）。</p>` : "";
    const updateMessage = message ? `<p class="data-source-hint">${escapeHtml(message)}</p>` : "";
    $("#attractionResults").innerHTML = `${updateMessage}${staleMessage}<p class="data-source-hint">${escapeHtml(spot.name)} 周邊 ${Number(radius) / 1000} 公里 · ${items.length} 個景點 · OpenStreetMap</p>${cards}<p class="data-source-hint">景點標註和開放資訊可能不完整，出發前請再確認現場或官方資訊。</p>`;
  }

  async function fetchAttractionsFromProxy(spot, radius, signal) {
    const params = new URLSearchParams({ lat: Number(spot.lat).toFixed(6), lon: Number(spot.lon).toFixed(6), radius: String(radius) });
    const response = await fetch(`./api/attractions?${params}`, { signal, cache: "no-store", headers: { "Accept": "application/json" } });
    if (!response.ok) {
      const error = new Error(`附近景點服務回應 ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return response.json();
  }

  async function searchNearbyAttractions() {
    if (attractionRequestInProgress) return;
    const spot = getSpot($("#attractionSpotSelect").value);
    if (!spot) return showAttractionStatus("先選擇一個泊點", "選好泊點後即可查詢周邊景點。");
    const radius = Number($("#attractionRadius").value);
    const key = `${spot.id}_${radius}`;
    const googleNearby = googleSearchUrl("景點", spot.lat, spot.lon, "near");
    attractionRequestInProgress = true;
    $("#searchAttractionsButton").disabled = true;
    $("#searchAttractionsButton").textContent = "搜尋中…";
    showAttractionStatus("正在查詢附近景點", "正在搜尋 OpenStreetMap 社群地圖資料。", googleNearby);
    let cached = null;
    try {
      cached = await dbGet("attractions", key).catch(() => null);
      const cachedItems = Array.isArray(cached?.items) ? cached.items : [];
      const isFresh = cached && Date.now() - cached.savedAt < ATTRACTION_TTL;
      if (isFresh) {
        renderAttractions(cachedItems, spot, radius);
        return;
      }
      if (!navigator.onLine) {
        if (cached) renderAttractions(cachedItems, spot, radius, { staleAt: cached.savedAt, message: "目前離線，顯示本機保存的查詢結果。" });
        else showAttractionStatus("目前離線", "先前搜尋過的景點會保存在本機；重新連線後可再次查詢。", googleNearby);
        return;
      }
      if (cachedItems.length) renderAttractions(cachedItems, spot, radius, { staleAt: cached.savedAt, message: "正在更新附近景點資料…" });

      let data;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 26000);
      try {
        try {
          data = await fetchAttractionsFromProxy(spot, radius, controller.signal);
        } catch (error) {
          if (error.status !== 404 && error.status !== 405) throw error;
          const query = attractionQuery(spot.lat, spot.lon, radius);
          const fallbackController = new AbortController();
          const fallbackTimer = setTimeout(() => fallbackController.abort(), 10000);
          try {
            data = await fetchFoodFromEndpoint("https://overpass-api.de/api/interpreter", query, fallbackController.signal);
          } finally {
            clearTimeout(fallbackTimer);
          }
        }
      } finally {
        clearTimeout(timer);
      }
      const items = normalizeAttractionElements(data.elements, spot, radius);
      await dbPut("attractions", { key, items, savedAt: Date.now() }).catch(() => {});
      renderAttractions(items, spot, radius);
    } catch (error) {
      const cachedItems = Array.isArray(cached?.items) ? cached.items : [];
      if (cached) renderAttractions(cachedItems, spot, radius, { staleAt: cached.savedAt, message: `${attractionErrorTitle(error)}，仍顯示本機保存資料。` });
      else showAttractionStatus(attractionErrorTitle(error), "景點資料服務可能暫時忙碌或網路不穩，可稍後重試或改用 Google 地圖。", googleNearby);
    } finally {
      attractionRequestInProgress = false;
      $("#searchAttractionsButton").disabled = false;
      $("#searchAttractionsButton").textContent = "搜尋附近景點";
    }
  }

  const preferenceRules = {
    sea: /海邊|海線|海岸|海景|海濱|海水浴|沙灘|漁港|海$/i,
    mountain: /山區|山線|山景|森林|高山|林道|山莊|山屋|登山|山$/i,
    spring: /溫泉|泡湯|湯屋|風呂/i,
    temple: /廟|寺|宮|堂|神社|祠|道觀|佛堂|天壇|壇|殿/i,
    service: /服務區|休息站|國道|交流道/i
  };

  function chineseNumber(value) {
    const map = { 零: 0, 〇: 0, 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
    if (/^\d+$/.test(value)) return Number(value);
    if (value === "十") return 10;
    if (value.startsWith("十")) return 10 + (map[value[1]] || 0);
    if (value.includes("十")) return (map[value[0]] || 1) * 10 + (map[value[2]] || 0);
    return map[value] || 0;
  }

  function parseRequirementsFromText() {
    const text = $("#needsInput").value;
    const daysMatch = text.match(/(\d+|[一二兩三四五六七八九十]{1,3})\s*(?:天|日)/);
    if (daysMatch) {
      const days = Math.max(1, Math.min(14, chineseNumber(daysMatch[1])));
      $("#daysInput").value = String(days);
    }
    const kmMatch = text.match(/(\d{2,3})\s*(?:公里|km)/i);
    if (kmMatch) {
      const choices = [80, 120, 160, 220, 300, 500];
      const nearest = choices.reduce((a, b) => Math.abs(b - Number(kmMatch[1])) < Math.abs(a - Number(kmMatch[1])) ? b : a);
      $("#maxKm").value = String(nearest);
    }
    const inferred = Object.entries(preferenceRules).filter(([, pattern]) => pattern.test(text)).map(([key]) => key);
    for (const key of inferred) {
      const checkbox = $(`input[name="pref"][value="${key}"]`);
      if (checkbox) checkbox.checked = true;
    }
  }

  function preferenceHits(spot, preferences) {
    const name = spot.name;
    return preferences.filter(key => preferenceRules[key]?.test(name));
  }

  function planTrip() {
    parseRequirementsFromText();
    const days = Math.max(1, Math.min(14, Number($("#daysInput").value) || 3));
    const maxKm = Number($("#maxKm").value) || 160;
    const preferences = $$("input[name='pref']:checked").map(input => input.value);
    const startChoice = $("#startSpot").value;
    let current;
    let startLabel;
    const startingSpot = startChoice === "current" ? null : getSpot(startChoice);
    if (startingSpot) {
      current = { lat: Number(startingSpot.lat), lon: Number(startingSpot.lon) };
      startLabel = startingSpot.name;
    } else if (userPosition) {
      current = userPosition;
      startLabel = "目前位置";
    } else {
      notify("請先定位目前位置，或在起點清單選一個泊點。");
      $("#startSpot").focus();
      return;
    }
    const unplanned = new Set(spots.filter(spot => spot.overnightEligible !== false).map(spot => spot.id));
    if (startingSpot) unplanned.delete(startingSpot.id);
    const itinerary = [];
    let routeOrigin = { ...current };
    let routeOriginName = startLabel;
    let exceeded = false;
    for (let day = 1; day <= days; day++) {
      const ranked = [...unplanned].map(id => getSpot(id)).filter(Boolean).map(spot => ({ spot, distance: haversineKm(current, spot), hits: preferenceHits(spot, preferences) }));
      if (!ranked.length) break;
      const within = ranked.filter(item => item.distance <= maxKm);
      const pool = within.length ? within : ranked;
      if (!within.length) exceeded = true;
      pool.sort((a, b) => {
        const aScore = a.distance - Math.min(a.hits.length, 2) * 24;
        const bScore = b.distance - Math.min(b.hits.length, 2) * 24;
        return aScore - bScore;
      });
      const choice = pool[0];
      itinerary.push({ day, spot: choice.spot, distance: choice.distance, hits: choice.hits, origin: routeOrigin, originName: routeOriginName, exceeded: choice.distance > maxKm });
      unplanned.delete(choice.spot.id);
      current = { lat: Number(choice.spot.lat), lon: Number(choice.spot.lon) };
      routeOrigin = { ...current };
      routeOriginName = choice.spot.name;
    }
    renderItinerary(itinerary, { days, maxKm, preferences, startLabel, exceeded, needs: $("#needsInput").value.trim() });
  }

  function renderItinerary(items, details) {
    const root = $("#itinerary");
    if (!items.length) {
      root.innerHTML = `<div class="empty-state"><strong>目前沒有可安排的泊點</strong><p>調整起點或需求後再試一次。</p></div>`;
      return;
    }
    const prefLabels = { sea: "海邊／海線", mountain: "山區／森林", spring: "溫泉", temple: "廟宇", service: "服務區／休息站" };
    const prefText = details.preferences.map(key => prefLabels[key]).join("、");
    const dayCards = items.map(item => {
      const hits = item.hits.length ? item.hits.map(key => `<span class="badge">符合${prefLabels[key]}</span>`).join("") : "";
      const warning = item.exceeded ? `<p class="plan-warning">此點超過設定的 ${details.maxKm} 公里直線上限，是當下可選的最近點。</p>` : "";
      return `<article class="day-card"><div class="day-number">DAY<b>${item.day}</b></div><div class="day-main"><div class="day-heading"><div><h3>${escapeHtml(item.spot.name)}</h3><p>由 ${escapeHtml(item.originName)} 出發 · ${Number(item.spot.lat).toFixed(5)}, ${Number(item.spot.lon).toFixed(5)}</p></div><span class="day-distance">直線 ${item.distance.toFixed(1)} km</span></div><div class="spot-badges">${hits}</div>${warning}<div class="day-actions"><a href="${mapsDirectionsUrl(item.origin, item.spot)}" target="_blank" rel="noopener">Google 導航 ↗</a><button type="button" data-action="food" data-id="${escapeHtml(item.spot.id)}">附近美食</button><button type="button" data-action="attractions" data-id="${escapeHtml(item.spot.id)}">附近景點</button><button type="button" data-action="details" data-id="${escapeHtml(item.spot.id)}">泊點資訊</button></div></div></article>`;
    }).join("");
    const omitted = items.length < details.days ? `<p class="plan-warning">找到 ${items.length} 個不重複泊點，少於需求的 ${details.days} 天；可放寬距離，或改選其他起點。</p>` : "";
    const needsLine = details.needs ? `<span>需求：${escapeHtml(details.needs.slice(0, 90))}</span>` : `<span>偏好：${escapeHtml(prefText || "未指定")}</span>`;
    root.innerHTML = `<div class="trip-summary"><strong>${details.days} 天車宿建議</strong><span>起點：${escapeHtml(details.startLabel)}<br>${needsLine}</span></div>${omitted}${details.exceeded && !omitted ? `<p class="plan-warning">部分日程超過距離上限，請檢查 Google 道路導航里程。</p>` : ""}${dayCards}<p class="form-disclaimer">本建議按直線距離和泊點名稱排序；實際道路路線、開放狀態、合法性、收費與設施請逐站確認。</p>`;
  }

  function parseCsv(text) {
    const input = text.replace(/^\uFEFF/, "");
    const rows = [];
    let row = [];
    let cell = "";
    let quoted = false;
    for (let index = 0; index < input.length; index++) {
      const char = input[index];
      if (quoted) {
        if (char === '"' && input[index + 1] === '"') { cell += '"'; index++; }
        else if (char === '"') quoted = false;
        else cell += char;
      } else if (char === '"') quoted = true;
      else if (char === ",") { row.push(cell); cell = ""; }
      else if (char === "\n" || char === "\r") {
        if (char === "\r" && input[index + 1] === "\n") index++;
        row.push(cell); cell = "";
        if (row.some(value => value.trim() !== "")) rows.push(row);
        row = [];
      } else cell += char;
    }
    row.push(cell);
    if (row.some(value => value.trim() !== "")) rows.push(row);
    return rows;
  }

  function normalizeCsvSpot(header, row) {
    const record = Object.fromEntries(header.map((key, index) => [key.trim(), row[index] ?? ""]));
    const pick = (...keys) => keys.map(key => record[key]).find(value => value != null && String(value).trim() !== "") ?? "";
    const name = String(pick("點位名稱", "名稱", "name", "Name")).trim();
    const lat = Number(pick("緯度", "lat", "latitude", "Latitude"));
    const lon = Number(pick("經度", "lon", "lng", "longitude", "Longitude"));
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return { id: stableId(lat, lon), name, lat, lon, hot: String(pick("熱水欄位（原始值）", "熱水", "hot")), photo: String(pick("圖片連結", "圖片", "photo")), style: String(pick("圖示樣式ID", "style")) };
  }

  function csvCell(value) { return `"${String(value ?? "").replace(/"/g, '""')}"`; }

  function downloadFile(name, content, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function importCsv(file) {
    const status = $("#csvStatus");
    try {
      const rows = parseCsv(await file.text());
      if (rows.length < 2) throw new Error("CSV 沒有資料列。");
      const headers = rows[0].map(value => value.trim());
      const incoming = rows.slice(1).map(row => normalizeCsvSpot(headers, row)).filter(Boolean);
      if (!incoming.length) throw new Error("找不到有效點位；請確認有點位名稱、緯度和經度欄位。");
      const merged = new Map(spots.map(spot => [spot.id, spot]));
      let added = 0;
      let preservedLocations = 0;
      const savedIncoming = [];
      for (const spot of incoming) {
        const sameCoordinates = [...merged.values()].find(existing => Number(existing.lat) === spot.lat && Number(existing.lon) === spot.lon);
        const sameId = merged.get(spot.id);
        const targetId = sameCoordinates?.id || spot.id;
        if (!sameCoordinates && !merged.has(targetId)) added++;
        const preserveLocation = Boolean(sameId && hasManualLocationOverride(sameId)
          && (!sameCoordinates || sameCoordinates.id === sameId.id));
        if (preserveLocation) preservedLocations++;
        const previous = sameCoordinates || sameId;
        const nextLat = preserveLocation ? sameId.lat : spot.lat;
        const nextLon = preserveLocation ? sameId.lon : spot.lon;
        const locationChanged = Boolean(previous && stableId(previous.lat, previous.lon) !== stableId(nextLat, nextLon));
        const updated = withResolvedCounty({
          ...(sameCoordinates || sameId || {}),
          ...spot,
          id: targetId,
          ...(preserveLocation ? { lat: sameId.lat, lon: sameId.lon, locationOverride: true } : {})
        }, locationChanged || !spot.county);
        merged.set(targetId, updated);
        savedIncoming.push(updated);
      }
      for (const spot of savedIncoming) await dbPut("spots", spot);
      spots = [...merged.values()]
        .map(spot => withResolvedCounty(spot, !spot.county || hasManualLocationOverride(spot)))
        .sort((a, b) => a.name.localeCompare(b.name, "zh-Hant"));
      fillSpotSelectors();
      renderSpotUpdateSearch();
      visibleCount = PAGE_SIZE;
      renderSpots();
      status.textContent = `已匯入 ${incoming.length} 筆；新增 ${added} 筆，其他同座標資料已更新；${preservedLocations} 筆手動校正座標已保留。本次變更存在此瀏覽器。`;
      notify(`已匯入 ${incoming.length} 筆泊點資料。`);
    } catch (error) {
      status.textContent = error.message || "CSV 匯入失敗。";
      notify(status.textContent);
    } finally {
      $("#csvInput").value = "";
    }
  }

  function exportCsv() {
    const headers = ["點位名稱", "緯度", "經度", "熱水欄位（原始值）", "圖片連結", "Google 地圖連結", "圖示樣式ID"];
    const rows = spots.map(spot => [spot.name, spot.lat, spot.lon, spot.hot || "", spot.photo || "", googleSpotSearchUrl(spot), spot.style || ""]);
    const csv = "\uFEFF" + [headers, ...rows].map(row => row.map(csvCell).join(",")).join("\r\n");
    downloadFile("車宿旅圖_泊點資料.csv", csv, "text/csv;charset=utf-8");
  }

  function readImageData(file) {
    return new Promise((resolve, reject) => {
      if (!file) return resolve("");
      if (!file.type.startsWith("image/")) return reject(new Error("附件請選擇圖片檔。"));
      const image = new Image();
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("讀取圖片失敗。"));
      reader.onload = () => { image.src = reader.result; };
      image.onerror = () => reject(new Error("無法開啟這張圖片。"));
      image.onload = () => {
        const scale = Math.min(1, 1280 / Math.max(image.width, image.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", .76));
      };
      reader.readAsDataURL(file);
    });
  }

  async function submitReport(event) {
    event.preventDefault();
    const button = $("#reportForm button[type='submit']");
    button.disabled = true;
    try {
      const image = await readImageData($("#reportPhoto").files[0]);
      const report = {
        id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}_${Math.random().toString(16).slice(2)}`,
        type: $("#reportType").value,
        place: $("#reportPlace").value.trim(),
        message: $("#reportMessage").value.trim(),
        photo: image,
        createdAt: new Date().toISOString()
      };
      await dbPut("reports", report);
      event.target.reset();
      renderReports();
      notify("回報已儲存在本機。可在下方匯出分享檔。");
    } catch (error) {
      notify(error.message || "回報儲存失敗，請確認本機儲存空間。 ");
    } finally {
      button.disabled = false;
    }
  }

  async function renderReports() {
    const container = $("#reportsList");
    if (!container) return;
    const reports = await dbAll("reports").catch(() => []);
    reports.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (!reports.length) {
      container.innerHTML = `<div class="empty-state"><strong>目前沒有本機回報</strong><p>新增後可匯出 JSON 分享。</p></div>`;
      return;
    }
    container.innerHTML = reports.map(report => {
      const date = new Date(report.createdAt).toLocaleString("zh-TW", { dateStyle: "short", timeStyle: "short" });
      const photo = report.photo ? `<img class="report-photo" src="${report.photo}" alt="回報圖片">` : "";
      return `<article class="report-row"><div><strong>${escapeHtml(report.type)} · ${escapeHtml(report.place)}</strong><p>${escapeHtml(report.message)}</p><small>${date}</small>${photo}</div><button type="button" data-report-delete="${escapeHtml(report.id)}">刪除</button></article>`;
    }).join("");
  }

  async function exportReports() {
    const reports = await dbAll("reports").catch(() => []);
    downloadFile("車宿旅圖_現場回報.json", JSON.stringify({ exportedAt: new Date().toISOString(), reports }, null, 2), "application/json;charset=utf-8");
  }

  async function importReports(file) {
    try {
      const parsed = JSON.parse(await file.text());
      const reports = Array.isArray(parsed) ? parsed : parsed.reports;
      if (!Array.isArray(reports)) throw new Error("回報 JSON 格式不正確。");
      let count = 0;
      for (const item of reports) {
        if (!item || !item.place || !item.message) continue;
        await dbPut("reports", { ...item, id: String(item.id || `${Date.now()}_${count}`), type: item.type || "匯入回報", createdAt: item.createdAt || new Date().toISOString() });
        count++;
      }
      await renderReports();
      notify(`已匯入 ${count} 筆回報。`);
    } catch (error) {
      notify(error.message || "回報匯入失敗。");
    } finally {
      $("#reportsInput").value = "";
    }
  }

  function bindEvents() {
    $$(".nav-item").forEach(button => button.addEventListener("click", () => switchTab(button.dataset.tab)));
    $("#searchInput").addEventListener("input", () => { visibleCount = PAGE_SIZE; renderSpots(true); });
    $("#clearSearch").addEventListener("click", () => { $("#searchInput").value = ""; visibleCount = PAGE_SIZE; renderSpots(true); $("#searchInput").focus(); });
    $("#resetSpotFilters").addEventListener("click", () => {
      $("#searchInput").value = "";
      $("#radiusSelect").value = "all";
      $("#favoritesOnly").setAttribute("aria-pressed", "false");
      $("#templeFacilitiesToggle").setAttribute("aria-pressed", "false");
      $("#waterfrontToggle").setAttribute("aria-pressed", "false");
      visibleCount = PAGE_SIZE;
      renderSpots(true);
      $("#searchInput").focus();
    });
    $("#sortSelect").addEventListener("change", renderSpots);
    $("#radiusSelect").addEventListener("change", () => {
      if ($("#radiusSelect").value !== "all" && !userPosition) locateUser().catch(error => notify(error.message));
      else renderSpots();
    });
    $("#favoritesOnly").addEventListener("click", event => {
      const active = event.currentTarget.getAttribute("aria-pressed") === "true";
      event.currentTarget.setAttribute("aria-pressed", String(!active));
      renderSpots();
    });
    $("#templeFacilitiesToggle").addEventListener("click", event => {
      const active = event.currentTarget.getAttribute("aria-pressed") === "true";
      event.currentTarget.setAttribute("aria-pressed", String(!active));
      visibleCount = PAGE_SIZE;
      renderSpots(true);
    });
    $("#waterfrontToggle").addEventListener("click", event => {
      const active = event.currentTarget.getAttribute("aria-pressed") === "true";
      event.currentTarget.setAttribute("aria-pressed", String(!active));
      visibleCount = PAGE_SIZE;
      renderSpots(true);
    });
    $("#locateButton").addEventListener("click", () => locateUser().catch(error => notify(error.message)));
    $("#loadMore").addEventListener("click", () => { visibleCount += PAGE_SIZE; renderSpots(); });
    $("#spotList").addEventListener("click", event => {
      const button = event.target.closest("[data-action]");
      if (button) handleSpotAction(button.dataset.action, button.dataset.id);
    });
    $("#itinerary").addEventListener("click", event => {
      const button = event.target.closest("[data-action]");
      if (button) handleSpotAction(button.dataset.action, button.dataset.id);
    });
    $("#mapExpand").addEventListener("click", () => {
      const card = $(".map-card");
      card.classList.toggle("expanded");
      $("#mapExpand").textContent = card.classList.contains("expanded") ? "縮小地圖" : "展開地圖";
      setTimeout(() => map?.invalidateSize(), 220);
    });
    $("#mapRetry").addEventListener("click", loadMapBackground);
    $("#planForm").addEventListener("submit", async event => {
      event.preventDefault();
      parseRequirementsFromText();
      if ($("#startSpot").value === "current" && !userPosition) {
        try { await locateUser(); } catch (error) { notify(error.message); return; }
      }
      planTrip();
    });
    $("#foodSpotSelect").addEventListener("change", () => showFoodStatus("已選擇泊點", "按下搜尋附近美食開始查詢。"));
    $("#searchFoodButton").addEventListener("click", searchFood);
    $("#attractionSpotSelect").addEventListener("change", () => showAttractionStatus("已選擇泊點", "按下搜尋附近景點開始查詢。"));
    $("#searchAttractionsButton").addEventListener("click", searchNearbyAttractions);
    $("#searchSourceSpotsButton").addEventListener("click", searchSourceSpots);
    $("#sourceKmlInput").addEventListener("change", event => { if (event.target.files[0]) importSourceKmlFile(event.target.files[0]); });
    $("#sourceSpotSearch").addEventListener("input", renderSourceSpots);
    $("#selectVisibleSourceSpots").addEventListener("click", toggleVisibleSourceSpots);
    $("#sourceSpotResults").addEventListener("change", event => {
      const checkbox = event.target.closest("[data-source-spot]");
      if (!checkbox) return;
      if (checkbox.checked) selectedSourceSpotIds.add(checkbox.dataset.sourceSpot);
      else selectedSourceSpotIds.delete(checkbox.dataset.sourceSpot);
      renderSourceSpots();
    });
    $("#addSelectedSourceSpots").addEventListener("click", addSelectedSourceSpots);
    $("#csvInput").addEventListener("change", event => { if (event.target.files[0]) importCsv(event.target.files[0]); });
    $("#spotUpdateSearch").addEventListener("input", renderSpotUpdateSearch);
    $("#spotUpdateResults").addEventListener("click", event => {
      const button = event.target.closest("[data-update-spot]");
      if (button) selectSpotForUpdate(button.dataset.updateSpot);
    });
    $("#spotUpdateForm").addEventListener("submit", saveSpotUpdate);
    $("#cancelSpotUpdate").addEventListener("click", cancelSpotUpdate);
    $("#exportCsvButton").addEventListener("click", exportCsv);
    $("#reportForm").addEventListener("submit", submitReport);
    $("#exportReportsButton").addEventListener("click", exportReports);
    $("#reportsInput").addEventListener("change", event => { if (event.target.files[0]) importReports(event.target.files[0]); });
    $("#reportsList").addEventListener("click", async event => {
      const button = event.target.closest("[data-report-delete]");
      if (!button) return;
      await dbDelete("reports", button.dataset.reportDelete);
      renderReports();
    });
    $("#dialogClose").addEventListener("click", () => $("#spotDialog").close?.());
    $("#spotDialog").addEventListener("click", event => {
      const button = event.target.closest("[data-dialog-action]");
      if (!button) return;
      const spot = getSpot(button.dataset.id);
      $("#spotDialog").close?.();
      if (button.dataset.dialogAction === "food") handleSpotAction("food", button.dataset.id);
      if (button.dataset.dialogAction === "map") centerOnSpot(spot);
    });
    window.addEventListener("online", setNetworkStatus);
    window.addEventListener("offline", setNetworkStatus);
    window.addEventListener("beforeinstallprompt", event => {
      event.preventDefault();
      installPrompt = event;
      $("#installButton").hidden = false;
    });
    $("#installButton").addEventListener("click", async () => {
      if (!installPrompt) return;
      installPrompt.prompt();
      await installPrompt.userChoice;
      installPrompt = null;
      $("#installButton").hidden = true;
    });
  }

  async function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    try {
      const previousController = navigator.serviceWorker.controller;
      if (previousController) {
        navigator.serviceWorker.addEventListener("controllerchange", () => {
          if (navigator.serviceWorker.controller && navigator.serviceWorker.controller !== previousController) location.reload();
        }, { once: true });
      }
      const registration = await navigator.serviceWorker.register("./sw.js");
      await registration.update();
    }
    catch { /* file:// 開啟或非安全連線時，瀏覽器不會啟用離線快取 */ }
  }

  async function init() {
    bindEvents();
    setNetworkStatus();
    // Register the offline shell before data requests so a slow mobile connection
    // cannot leave an installed app without a Service Worker on first launch.
    registerServiceWorker();
    initMap();
    await loadSpots();
    const requestedTab = location.hash.slice(1);
    if (["find", "plan", "food", "attractions", "updates"].includes(requestedTab)) switchTab(requestedTab);
  }

  init().catch(error => {
    $("#resultCount").textContent = "資料讀取失敗";
    const message = error.message || "請確認檔案已完整解壓，並透過本機伺服器開啟。";
    $("#dataLoadError").textContent = message;
    $("#dataLoadError").hidden = false;
    $("#spotList").innerHTML = `<div class="empty-state"><strong>無法載入泊點資料</strong><p>${escapeHtml(message)}</p></div>`;
  });
})();
