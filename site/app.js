(() => {
  "use strict";

  const DB_NAME = "che-su-lutu-v1";
  const SOURCE_KML_URL = "https://www.google.com/maps/d/kml?mid=1Q3JWYBEf6JQC8M4ei6cEojTesjg&forcekml=1";
  const SPOT_DATA_URL = "./data/spots.json?v=20261028-2";
  const COUNTY_BOUNDARY_DATA_URL = "./data/tw-counties.geojson?v=20261028-1";
  const TEMPLE_DATA_URL = "./data/temple-toilets.json?v=20261022-6";
  const WATERFRONT_DATA_URL = "./data/waterfront-points.json?v=20261022-6";
  const FOOD_DATA_URL = "./data/restaurant-directory.json?v=20261022-7";
  const ATTRACTION_DATA_URL = "./data/attraction-directory.json?v=20261103-1";
  const MAP_STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";
  const MAPLIBRE_MODULE_URL = "https://unpkg.com/maplibre-gl@6.3.0/dist/maplibre-gl.mjs";
  const MAPLIBRE_STYLESHEET_URL = "https://unpkg.com/maplibre-gl@6.3.0/dist/maplibre-gl.css";
  const FOOD_API_URL = "https://che-su-lutu-pwa.pages.dev/api/food";
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
  let attractionDirectoryPromise;
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
  let foodSearchSequence = 0;
  let lastFoodSearchKey = "";
  let attractionRequestInProgress = false;
  let attractionItemsByKey = new Map();
  let lastAttractionSearch = null;
  let showingSavedAttractions = false;
  let tripPlanSequence = 0;
  let tripAdjustmentSequence = 0;
  let tripAdjustmentConversation = [];
  let activeTripConversationContext = null;
  let tripConversationBusy = false;
  let activeTripPlanSequence = 0;
  let activeTripScheduleDays = [];
  let activeTripItinerary = [];
  let activeTripDetails = null;
  let activeTripFoodPoints = [];
  let activeTripAttractionPoints = [];
  let activeTripDirectoryError = false;
  let activeTripRouteError = false;
  let lastTripRouteRequestAt = 0;
  const tripRoadMetricCache = new Map();
  const tripMealAvailabilityCache = new Map();
  const tripStartLocationCache = new Map();
  let selectedSpotUpdateId = null;
  let sourceSpots = [];
  let sourceSpotsReady = false;
  const selectedSourceSpotIds = new Set();
  const favoriteIds = new Set(readJson("che-su-favorites", []));
  const savedAttractionData = readJson("che-su-saved-attractions", []);
  const savedAttractions = new Map((Array.isArray(savedAttractionData) ? savedAttractionData : []).filter(item => item && item.name && Number.isFinite(Number(item.lat)) && Number.isFinite(Number(item.lon))).map(item => [attractionKey(item), item]));
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

  function bloggerFoodSearchUrl(spot, mealLabel) {
    const county = spot.county || countyAtPoint(Number(spot.lon), Number(spot.lat));
    const location = [spot.name, spot.town, county].filter(Boolean).join(" ");
    const query = `${location} 附近 ${mealLabel} 美食 部落客 部落格 推薦`;
    return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
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

  function formatDistanceKm(km) {
    return km < 1 ? `${Math.round(km * 1000)} 公尺` : `${km.toFixed(1)} 公里`;
  }

  function formatDriveDistance(meters) {
    const km = meters / 1000;
    return km < 1 ? `${Math.round(meters)} 公尺` : `${km.toFixed(1)} 公里`;
  }

  function formatDriveDuration(seconds) {
    const minutes = Math.max(1, Math.round(seconds / 60));
    const hours = Math.floor(minutes / 60);
    const remainder = minutes % 60;
    return hours ? `${hours} 小時${remainder ? ` ${remainder} 分` : ""}` : `${minutes} 分`;
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

  function countyFallbackLocation(boundary) {
    const countySpots = spots.filter(spot => {
      const lat = Number(spot.lat);
      const lon = Number(spot.lon);
      return Number.isFinite(lat) && Number.isFinite(lon) && isInsideGeometry(lon, lat, boundary.geometry);
    });
    if (!countySpots.length) return null;
    const center = {
      lat: countySpots.reduce((sum, spot) => sum + Number(spot.lat), 0) / countySpots.length,
      lon: countySpots.reduce((sum, spot) => sum + Number(spot.lon), 0) / countySpots.length
    };
    const representative = countySpots
      .filter(spot => spot.overnightEligible !== false)
      .sort((a, b) => haversineKm(center, a) - haversineKm(center, b))[0] || countySpots[0];
    return {
      lat: Number(representative.lat),
      lon: Number(representative.lon),
      label: `${boundary.shortName}（縣內泊點定位）`,
      spotId: representative.id
    };
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
    food.innerHTML = `${sorted.map(optionText).join("")}<option value="current">目前位置（先定位）</option>`;
    if (previousFood && [...food.options].some(option => option.value === previousFood)) food.value = previousFood;
    const attraction = $("#attractionSpotSelect");
    const previousAttraction = attraction.value;
    attraction.innerHTML = `<option value="current">目前位置（先定位）</option>${sorted.map(optionText).join("")}`;
    if (previousAttraction && [...attraction.options].some(option => option.value === previousAttraction)) attraction.value = previousAttraction;
    updateAttractionCurrentLocationOption();
    updateFoodCurrentLocationOption();
    const datalist = $("#spotNameOptions");
    datalist.innerHTML = sorted.map(spot => `<option value="${escapeHtml(spot.name)}"></option>`).join("");
  }

  function getSpot(id) {
    return spots.find(spot => spot.id === id);
  }

  function getPlannedSpot(id) {
    return getSpot(id) || activeTripItinerary.find(item => item.spot.id === id)?.spot;
  }

  function selectSpotForSearch(selector, spot) {
    const select = $(selector);
    if (![...select.options].some(option => option.value === spot.id)) {
      const option = document.createElement("option");
      option.value = spot.id;
      option.textContent = `${spot.name}（${Number(spot.lat).toFixed(5)}, ${Number(spot.lon).toFixed(5)}）`;
      select.add(option);
    }
    select.value = spot.id;
  }

  function updateAttractionCurrentLocationOption() {
    const option = $("#attractionSpotSelect option[value='current']");
    if (option && userPosition) option.textContent = `目前位置 (${userPosition.lat.toFixed(5)}, ${userPosition.lon.toFixed(5)})`;
  }

  function updateFoodCurrentLocationOption() {
    const option = $("#foodSpotSelect option[value='current']");
    if (option && userPosition) option.textContent = `目前位置 (${userPosition.lat.toFixed(5)}, ${userPosition.lon.toFixed(5)})`;
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
    updateAttractionCurrentLocationOption();
    updateFoodCurrentLocationOption();
    if (userMarker) userMarker.remove();
    if (map) {
      userMarker = L.circleMarker([userPosition.lat, userPosition.lon], { radius: 8, weight: 3, color: "#fff", fillColor: "#3979de", fillOpacity: 1 }).addTo(map).bindTooltip("目前位置");
      map.setView([userPosition.lat, userPosition.lon], 12);
    }
    renderSpots();
    notify(`已定位 ${userPosition.lat.toFixed(5)}, ${userPosition.lon.toFixed(5)}。`);
  }

  function locationErrorMessage(error) {
    if (error.code === 1) return "定位權限被拒絕。請在手機設定或瀏覽器網站權限中允許此網站使用位置，或改選一個泊點。";
    if (error.code === 2) return "手機目前無法取得位置。請開啟裝置定位服務，或改選一個泊點。";
    if (error.code === 3) return "定位逾時。請到戶外或靠近窗邊再試一次，也可先選擇泊點搜尋。";
    return "目前無法取得位置。請確認手機定位已開啟，或改選一個泊點。";
  }

  function locateUser() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(new Error("此瀏覽器不支援定位功能。"));
      navigator.geolocation.getCurrentPosition(position => { setPosition(position); resolve(userPosition); }, error => {
        reject(new Error(locationErrorMessage(error)));
      }, { enableHighAccuracy: false, timeout: 20000, maximumAge: 60000 });
    });
  }

  async function locateNearby() {
    const position = await locateUser();
    const attractionCenter = $("#attractionSpotSelect");
    if (attractionCenter?.querySelector('option[value="current"]')) attractionCenter.value = "current";
    return position;
  }

  function switchTab(name) {
    $$(".nav-item").forEach(button => button.classList.toggle("active", button.dataset.tab === name));
    $$(".view").forEach(view => view.classList.toggle("active", view.id === `view-${name}`));
    if (name === "find" && map) setTimeout(() => map.invalidateSize(), 50);
    if (name === "updates") renderReports();
    if (name === "food") {
      const key = `${$("#foodSpotSelect").value}_${$("#foodRadius").value}`;
      if ($("#foodSpotSelect").value && key !== lastFoodSearchKey) queueMicrotask(searchFood);
    }
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
    const spot = getPlannedSpot(id);
    if (!spot) return;
    if (action === "details") openSpotDialog(spot);
    if (action === "favorite") toggleFavorite(id);
    if (action === "map") centerOnSpot(spot);
    if (action === "food") {
      selectSpotForSearch("#foodSpotSelect", spot);
      switchTab("food");
      searchFood();
    }
    if (action === "attractions") {
      selectSpotForSearch("#attractionSpotSelect", spot);
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
    const response = await fetch(`${FOOD_API_URL}?${params}`, { signal, cache: "no-store", headers: { "Accept": "application/json" } });
    if (!response.ok) {
      const error = new Error(`附近店家服務回應 ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return response.json();
  }

  async function searchFood() {
    if (foodRequestInProgress) return;
    const selectedSpotValue = $("#foodSpotSelect").value;
    const spot = selectedSpotValue === "current"
      ? userPosition && { id: `current_${stableId(userPosition.lat, userPosition.lon)}`, name: "目前位置", ...userPosition }
      : getPlannedSpot(selectedSpotValue);
    if (!spot) return showFoodStatus("先定位或選擇泊點", "按「定位附近」搜尋目前位置，或從清單選擇一個泊點。 ");
    const radius = Number($("#foodRadius").value);
    const key = `${spot.id}_${radius}`;
    lastFoodSearchKey = `${selectedSpotValue}_${radius}`;
    const googleNearby = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`餐廳 near ${spot.lat},${spot.lon}`)}`;
    const searchSequence = ++foodSearchSequence;
    const isCurrentSearch = () => searchSequence === foodSearchSequence
      && $("#foodSpotSelect").value === selectedSpotValue
      && Number($("#foodRadius").value) === radius;
    foodRequestInProgress = true;
    $("#searchFoodButton").disabled = true;
    $("#searchFoodButton").textContent = "搜尋中…";
    showFoodStatus("正在載入附近餐飲", "先顯示本機已存資料；餐飲目錄與即時地圖資料會在背景更新。", googleNearby);
    let cached = null;
    let cachedFoods = [];
    let directoryFoods = [];
    let liveFoods = [];
    let directorySource = "";
    let liveError = null;
    let liveResolved = false;
    let liveSucceeded = false;
    let hasFreshCache = false;
    let isOffline = false;
    let fallbackFoods = [];
    const renderAvailableFoods = () => {
      if (!isCurrentSearch()) return;
      const foods = mergeFoodResults(directoryFoods, cachedFoods, liveFoods);
      fallbackFoods = foods;
      if (!foods.length) {
        if (!liveResolved) return;
        if (liveError) showFoodStatus(foodErrorTitle(liveError), "店家資料服務可能暫時忙碌或網路連線不穩；可稍後重試，也可直接用 Google 地圖搜尋附近餐廳與評價。", googleNearby);
        else renderFoodResults([], spot, radius);
        return;
      }
      const message = liveError
        ? `${foodErrorTitle(liveError)}，仍顯示可用的目錄／上次查詢資料。`
        : isOffline ? "目前離線，顯示本機餐飲目錄與先前查詢資料。"
          : hasFreshCache ? "已先顯示本機資料。"
            : liveResolved ? "" : "已先顯示可用資料，正在背景更新附近地圖資料…";
      renderFoodResults(foods, spot, radius, {
        staleAt: liveSucceeded || hasFreshCache ? 0 : (cached?.savedAt || 0),
        directorySource,
        message
      });
    };
    try {
      const cachedResult = await Promise.allSettled([dbGet("food", key)]);
      cached = cachedResult[0].status === "fulfilled" ? cachedResult[0].value : null;
      cachedFoods = Array.isArray(cached?.items) ? cached.items : [];
      hasFreshCache = Boolean(cached && Date.now() - cached.savedAt < FOOD_TTL);

      if (cachedFoods.length) {
        fallbackFoods = cachedFoods;
        renderFoodResults(cachedFoods, spot, radius, {
          staleAt: hasFreshCache ? 0 : (cached?.savedAt || 0),
          message: hasFreshCache ? "已先顯示本機資料，正在背景載入官方餐飲目錄…" : "已先顯示上次查詢資料，正在背景更新…"
        });
      }

      loadFoodDirectory().then(directory => {
        directoryFoods = normalizeDirectoryFoods(directory?.points, spot, radius);
        directorySource = directory ? "交通部觀光署" : "";
        renderAvailableFoods();
      }).catch(() => []);

      if (hasFreshCache) {
        if (cachedFoods.length) renderAvailableFoods();
        else renderFoodResults([], spot, radius);
        return;
      }
      if (!navigator.onLine) {
        isOffline = true;
        if (fallbackFoods.length) renderFoodResults(fallbackFoods, spot, radius, { staleAt: cached?.savedAt || 0, message: "目前離線，顯示本機先前查詢資料。" });
        else {
          showFoodStatus("目前離線", "先前搜尋過的店家會保存在本機；重新連線後可再次查詢。", googleNearby);
        }
        return;
      }
      if (!fallbackFoods.length) {
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
      liveSucceeded = true;
      liveFoods = normalizeFoodElements(data.elements, spot, radius);
      liveResolved = true;
      await dbPut("food", { key, items: liveFoods, savedAt: Date.now() }).catch(() => {});
      renderAvailableFoods();
    } catch (error) {
      liveError = error;
      liveResolved = true;
      if (!isCurrentSearch()) return;
      renderAvailableFoods();
    } finally {
      foodRequestInProgress = false;
      $("#searchFoodButton").disabled = false;
      $("#searchFoodButton").textContent = "搜尋附近美食";
      const selectedSpot = $("#foodSpotSelect").value;
      const selectedRadius = $("#foodRadius").value;
      if (selectedSpot && `${selectedSpot}_${selectedRadius}` !== lastFoodSearchKey) queueMicrotask(searchFood);
    }
  }

  let foodLocateInProgress = false;

  async function locateAndSearchFood() {
    if (foodLocateInProgress) return;
    const button = $("#locateFoodButton");
    const select = $("#foodSpotSelect");
    foodLocateInProgress = true;
    button.disabled = true;
    button.textContent = "定位中…";
    select.disabled = true;
    showFoodStatus("正在定位目前位置", "請允許瀏覽器使用位置資訊。定位完成後會自動搜尋附近美食。");
    try {
      await locateUser();
      select.disabled = false;
      select.value = "current";
      await searchFood();
    } catch (error) {
      showFoodStatus("無法取得目前位置", error.message);
      notify(error.message);
    } finally {
      select.disabled = false;
      button.disabled = false;
      button.textContent = "定位附近";
      foodLocateInProgress = false;
    }
  }

  function handleFoodSpotChange() {
    if ($("#foodSpotSelect").value === "current" && !userPosition) {
      locateAndSearchFood();
      return;
    }
    searchFood();
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

  function attractionKey(item) {
    return `${stableId(Number(item.lat), Number(item.lon))}|${normalizeSearchText(item.name)}`;
  }

  async function loadAttractionDirectory() {
    if (!attractionDirectoryPromise) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12000);
      attractionDirectoryPromise = fetch(new URL(ATTRACTION_DATA_URL, document.baseURI), { signal: controller.signal })
        .then(response => {
          if (!response.ok) throw new Error(`觀光署景點目錄回應 HTTP ${response.status}`);
          return response.json();
        })
        .then(data => {
          if (!Array.isArray(data.points)) throw new Error("觀光署景點目錄格式不正確。");
          return data;
        })
        .catch(error => {
          attractionDirectoryPromise = null;
          throw error;
        }).finally(() => clearTimeout(timer));
    }
    return attractionDirectoryPromise;
  }

  function normalizeDirectoryAttractions(points, spot, radius) {
    return (points || []).flatMap(point => {
      const lat = Number(point.lat);
      const lon = Number(point.lon);
      if (!point.name || !Number.isFinite(lat) || !Number.isFinite(lon)) return [];
      const distance = haversineKm(spot, { lat, lon }) * 1000;
      if (distance > radius) return [];
      return [{
        id: point.id,
        name: point.name,
        lat,
        lon,
        category: "觀光署登錄景點",
        address: [point.city, point.town, point.address].filter(Boolean).join(" "),
        opening: point.opening || "",
        fee: point.fee || "",
        website: point.website || "",
        distance,
        source: "交通部觀光署"
      }];
    }).sort((a, b) => a.distance - b.distance).slice(0, 80);
  }

  function mergeAttractionResults(...groups) {
    const results = [];
    for (const item of groups.flat().sort((a, b) => a.distance - b.distance)) {
      const duplicate = results.find(existing => normalizeSearchText(existing.name) === normalizeSearchText(item.name) && haversineKm(existing, item) <= 0.12);
      if (!duplicate) results.push(item);
      else {
        const sources = new Set([...(duplicate.source || "").split("、"), ...(item.source || "").split("、")].filter(Boolean));
        duplicate.source = [...sources].join("、");
        duplicate.address ||= item.address || "";
        duplicate.opening ||= item.opening || "";
        duplicate.fee ||= item.fee || "";
        duplicate.website ||= item.website || "";
      }
    }
    return results.slice(0, 80);
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
    if (error?.status === 400) return "目前位置超出臺灣景點資料範圍";
    if ([429, 406, 503].includes(error?.status)) return "附近景點服務忙碌";
    if (error?.name === "AbortError" || /signal is aborted|operation was aborted/i.test(error?.message || "")) return "附近景點查詢逾時";
    return "目前無法連線至附近景點服務";
  }

  function renderAttractions(items, spot, radius, options = {}) {
    lastAttractionSearch = { items, spot, radius, options };
    updateSavedAttractionsButton();
    if (showingSavedAttractions) return renderSavedAttractions();
    const { staleAt = 0, message = "" } = options;
    if (!items.length) {
      showAttractionStatus("附近沒有找到已命名景點", "可擴大搜尋半徑，或使用 Google 地圖查看附近景點。", googleSearchUrl("景點", spot.lat, spot.lon, "near"));
      return;
    }
    const cards = renderAttractionCards(items, "距離搜尋位置約");
    const staleMessage = staleAt ? `<p class="data-source-hint">顯示上次查詢資料（${new Date(staleAt).toLocaleString("zh-TW")}）。</p>` : "";
    const updateMessage = message ? `<p class="data-source-hint">${escapeHtml(message)}</p>` : "";
    const centerLabel = spot.id.startsWith("current_") ? `目前位置 (${Number(spot.lat).toFixed(5)}, ${Number(spot.lon).toFixed(5)})` : spot.name;
    const sources = [...new Set(items.flatMap(item => String(item.source || "").split("、")).filter(Boolean))].join("、") || "OpenStreetMap";
    $("#attractionResults").innerHTML = `${updateMessage}${staleMessage}<p class="data-source-hint">${escapeHtml(centerLabel)} 周邊 ${Number(radius) / 1000} 公里 · ${items.length} 個景點 · ${escapeHtml(sources)}</p>${cards}<p class="data-source-hint">景點標註和開放資訊可能不完整，出發前請再確認現場或官方資訊。</p>`;
  }

  function renderAttractionCards(items, distanceLabel) {
    attractionItemsByKey = new Map(items.map(item => [attractionKey(item), item]));
    return items.map(item => {
      const details = [item.category, item.address ? `地址：${item.address}` : "", item.opening ? `開放時間：${item.opening}` : "", item.fee ? `費用：${item.fee}` : ""].filter(Boolean).join(" · ");
      const url = googleSearchUrl(item.name, item.lat, item.lon, "景點");
      const distance = item.distance < 1000 ? `${Math.round(item.distance)} 公尺` : `${(item.distance / 1000).toFixed(1)} 公里`;
      const key = attractionKey(item);
      const saved = savedAttractions.has(key);
      return `<article class="food-result-card attraction-result-card"><div><h3>${escapeHtml(item.name)}</h3><p>${escapeHtml(details)}</p><div class="food-radius">${distanceLabel} ${distance}</div></div><div class="attraction-card-actions"><a class="food-link" href="${url}" target="_blank" rel="noopener">地圖導航 ↗</a><button class="food-link attraction-save ${saved ? "saved" : ""}" type="button" data-attraction-save="${escapeHtml(key)}" aria-pressed="${saved}" aria-label="${saved ? "從已儲存景點移除" : "儲存此景點"}">${saved ? "已儲存 ♥" : "儲存 ♡"}</button></div></article>`;
    }).join("");
  }

  function updateSavedAttractionsButton() {
    const button = $("#toggleSavedAttractionsButton");
    if (!button) return;
    button.textContent = `${showingSavedAttractions ? "返回搜尋結果" : "已儲存景點"} (${savedAttractions.size})`;
    button.setAttribute("aria-pressed", String(showingSavedAttractions));
  }

  function renderSavedAttractions() {
    const items = [...savedAttractions.values()].sort((a, b) => String(a.name).localeCompare(String(b.name), "zh-Hant"));
    if (!items.length) return showAttractionStatus("尚未儲存景點", "搜尋附近景點後，按下景點卡片上的「儲存」即可留待稍後查看。");
    const cards = renderAttractionCards(items, "原搜尋位置距離");
    $("#attractionResults").innerHTML = `<p class="data-source-hint">已儲存 ${items.length} 個景點，資料保存在目前瀏覽器。</p>${cards}`;
  }

  function toggleSavedAttraction(button) {
    const key = button.dataset.attractionSave;
    const item = attractionItemsByKey.get(key);
    if (!item) return;
    const wasSaved = savedAttractions.has(key);
    if (wasSaved) savedAttractions.delete(key);
    else savedAttractions.set(key, { ...item });
    try {
      localStorage.setItem("che-su-saved-attractions", JSON.stringify([...savedAttractions.values()]));
    } catch {
      if (wasSaved) savedAttractions.set(key, item);
      else savedAttractions.delete(key);
      updateSavedAttractionsButton();
      return notify("目前瀏覽器無法儲存景點，請檢查儲存空間設定。");
    }
    updateSavedAttractionsButton();
    if (showingSavedAttractions) renderSavedAttractions();
    else {
      const saved = !wasSaved;
      button.classList.toggle("saved", saved);
      button.textContent = saved ? "已儲存 ♥" : "儲存 ♡";
      button.setAttribute("aria-pressed", String(saved));
      button.setAttribute("aria-label", saved ? "從已儲存景點移除" : "儲存此景點");
    }
    notify(wasSaved ? "已從儲存景點移除。" : "景點已儲存，可稍後查看。");
  }

  function toggleSavedAttractionsView() {
    showingSavedAttractions = !showingSavedAttractions;
    updateSavedAttractionsButton();
    if (showingSavedAttractions) return renderSavedAttractions();
    if (lastAttractionSearch) return renderAttractions(lastAttractionSearch.items, lastAttractionSearch.spot, lastAttractionSearch.radius, lastAttractionSearch.options);
    showAttractionStatus("選擇泊點或定位目前位置", "搜尋附近景點後會顯示在這裡。");
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
    let spot;
    if ($("#attractionSpotSelect").value === "current") {
      if (!userPosition) {
        showAttractionStatus("正在定位目前位置", "請允許瀏覽器使用位置資訊。");
        try { await locateNearby(); } catch (error) {
          showAttractionStatus("無法取得目前位置", error.message);
          notify(error.message);
          return;
        }
      }
      spot = { id: `current_${stableId(userPosition.lat, userPosition.lon)}`, name: "目前位置", ...userPosition };
    } else spot = getPlannedSpot($("#attractionSpotSelect").value);
    if (!spot) return showAttractionStatus("先選擇搜尋中心", "選擇一個泊點或定位目前位置後即可查詢周邊景點。");
    showingSavedAttractions = false;
    updateSavedAttractionsButton();
    const radius = Number($("#attractionRadius").value);
    const key = `${spot.id}_${radius}`;
    const googleNearby = googleSearchUrl("景點", spot.lat, spot.lon, "near");
    const coordinateLabel = `${Number(spot.lat).toFixed(5)}, ${Number(spot.lon).toFixed(5)}`;
    attractionRequestInProgress = true;
    $("#searchAttractionsButton").disabled = true;
    $("#searchAttractionsButton").textContent = "搜尋中…";
    showAttractionStatus("正在載入附近景點", `搜尋中心：${coordinateLabel}。先讀取觀光署景點目錄，再嘗試更新地圖資料。`, googleNearby);
    let cached = null;
    let fallbackItems = [];
    let fallbackOptions = {};
    try {
      const [cachedResult, directoryResult] = await Promise.allSettled([
        dbGet("attractions", key),
        loadAttractionDirectory()
      ]);
      cached = cachedResult.status === "fulfilled" ? cachedResult.value : null;
      const directory = directoryResult.status === "fulfilled" ? directoryResult.value : null;
      const directoryItems = normalizeDirectoryAttractions(directory?.points, spot, radius);
      const cachedItems = Array.isArray(cached?.items) ? cached.items : [];
      const visibleItems = mergeAttractionResults(directoryItems, cachedItems);
      fallbackItems = visibleItems;
      fallbackOptions = { staleAt: cached?.savedAt || 0 };
      const isFresh = cachedItems.length > 0 && Date.now() - cached.savedAt < ATTRACTION_TTL;
      if (isFresh) {
        renderAttractions(visibleItems, spot, radius);
        return;
      }
      if (!navigator.onLine) {
        if (visibleItems.length) renderAttractions(visibleItems, spot, radius, { staleAt: cached?.savedAt || 0, message: "目前離線，顯示本機景點目錄與上次查詢資料。" });
        else showAttractionStatus("目前離線", `搜尋中心：${coordinateLabel}。先前搜尋過的景點會保存在本機；重新連線後可再次查詢。`, googleNearby);
        return;
      }
      if (visibleItems.length) renderAttractions(visibleItems, spot, radius, { staleAt: cached?.savedAt || 0, message: "已先顯示景點目錄，正在背景更新地圖資料…" });
      else showAttractionStatus("正在查詢附近景點", "目錄中沒有附近項目，正在更新 OpenStreetMap 社群地圖。", googleNearby);

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
      renderAttractions(mergeAttractionResults(directoryItems, items), spot, radius);
    } catch (error) {
      if (fallbackItems.length) renderAttractions(fallbackItems, spot, radius, { ...fallbackOptions, message: `${attractionErrorTitle(error)}，仍顯示觀光署景點目錄與本機資料。` });
      else showAttractionStatus(attractionErrorTitle(error), `搜尋中心：${coordinateLabel}。景點資料服務可能暫時忙碌或網路不穩，可稍後重試或改用 Google 地圖。`, googleNearby);
    } finally {
      attractionRequestInProgress = false;
      $("#searchAttractionsButton").disabled = false;
      $("#searchAttractionsButton").textContent = "搜尋附近景點";
    }
  }

  async function locateAndSearchAttractions() {
    const button = $("#locateAttractionsButton");
    button.disabled = true;
    button.textContent = "定位中…";
    try {
      await locateNearby();
      $("#attractionSpotSelect").value = "current";
      await searchNearbyAttractions();
    } catch (error) {
      showAttractionStatus("無法取得目前位置", error.message);
      notify(error.message);
    } finally {
      button.disabled = false;
      button.textContent = "定位目前位置";
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

  function closestDirectoryPoints(points, center, maxKm, limit) {
    return (Array.isArray(points) ? points : []).flatMap(point => {
      const lat = Number(point.lat);
      const lon = Number(point.lon);
      if (!point.name || !Number.isFinite(lat) || !Number.isFinite(lon)) return [];
      const distanceKm = haversineKm(center, { lat, lon });
      if (distanceKm > maxKm) return [];
      return [{ ...point, lat, lon, distanceKm }];
    }).sort((a, b) => a.distanceKm - b.distanceKm).slice(0, limit);
  }

  function mealAvailability(opening, meal) {
    const intervals = [];
    const pattern = /(上午|下午|早上|中午|晚上|AM|PM)?\s*(\d{1,2})[:：](\d{2})\s*(AM|PM)?/gi;
    const times = [...String(opening || "").matchAll(pattern)].map(match => {
      let hour = Number(match[2]);
      const minute = Number(match[3]);
      const period = String(match[1] || match[4] || "").toLowerCase();
      if (hour > 24 || minute > 59) return null;
      if (["下午", "晚上", "pm"].includes(period) && hour < 12) hour += 12;
      if (["上午", "早上", "am"].includes(period) && hour === 12) hour = 0;
      if (period === "中午" && hour < 11) hour += 12;
      return hour * 60 + minute;
    }).filter(Number.isFinite);
    for (let index = 0; index + 1 < times.length; index += 2) {
      let end = times[index + 1];
      if (end <= times[index]) end += 24 * 60;
      intervals.push([times[index], end]);
    }
    if (!intervals.length) return /休息|公休|店休|未營業|歇業/u.test(String(opening || "")) ? "closed" : "unknown";
    const minute = Number.isFinite(Number(meal.minute)) ? Number(meal.minute) : meal.defaultMinute;
    const duration = Number(meal.durationMinutes) || 45;
    const start = ((minute % 1440) + 1440) % 1440;
    const end = start + duration;
    return intervals.some(([open, close]) => open <= start && close >= end) ? "open" : "closed";
  }

  function mealFoodFit(food, meal) {
    const name = String(food.name || "");
    const category = String(food.category || "");
    const cuisine = String(food.cuisine || "");
    const searchable = `${name} ${category} ${cuisine}`.toLocaleLowerCase("zh-Hant");
    const dessertOrDrink = /冰淇淋|霜淇淋|雪花冰|刨冰|芋冰|冰城|冰店|冰品|麻糬|甜點|甜品|甜湯|蛋糕|甜甜圈|糖果|巧克力專賣|手搖飲|珍珠奶茶|飲料店|茶飲店|果汁店|飲品店|ice[_ -]?cream|dessert|bubble[_ -]?tea/u.test(searchable);
    if (dessertOrDrink || /^(冰品|冰淇淋|甜點|飲料)$/u.test(category)) return null;

    const breakfastShop = /早餐店|早餐專賣|早午餐|朝食|brunch|breakfast/u.test(searchable);
    const breakfastFood = /蛋餅|飯糰|豆漿|燒餅|油條|蘿蔔糕|吐司|三明治|漢堡|肉包|包子|饅頭|水煎包|鍋貼|粥|稀飯|小籠包|麵包|蛋堡/u.test(searchable);
    const breakfastSavory = /麵|粥|稀飯|餃|包子|小吃店|飯糰/u.test(searchable);
    const savoryMeal = /餐廳|小吃|麵|飯|米粉|米線|餃|燒肉|烤肉|火鍋|海鮮|牛排|便當|排骨|肉圓|滷味|客家|麵線|肉羹|燒臘|食堂|食坊|料理|餐坊|餐館|咖哩/u.test(searchable);

    if (meal.key === "breakfast") {
      if (breakfastShop) return { score: 4, label: "早餐店／早午餐" };
      if (breakfastFood) return { score: 3, label: "常見早餐餐點" };
      if (/海鮮|活魚|牛排|燒肉|燒烤|火鍋|餐酒|酒莊|酒吧|熱炒|漁坊|合菜|宴會|飯店/u.test(searchable)) return null;
      if (breakfastSavory) return { score: 1, label: "常見餐食，早餐供應未確認" };
      if (String(food.id || "").startsWith("Restaurant_")) return { score: -1, label: "餐飲候選，早餐供應未確認" };
      return null;
    }
    if (meal.key === "dinner" && /早餐專賣|早餐店/u.test(searchable)) return null;
    if (savoryMeal || /restaurant|fast[_ -]?food|food[_ -]?court/u.test(searchable)) {
      return { score: 2, label: "正餐店家" };
    }
    return { score: 0, label: "餐點類型未確認" };
  }

  function recommendFoodsByMeal(points, center, requestedMinutes = {}, options = {}) {
    const strictOpeningHours = Boolean(options.strictOpeningHours);
    const meals = [
      { key: "breakfast", label: "早餐", defaultMinute: 7 * 60, durationMinutes: 45 },
      { key: "lunch", label: "午餐", defaultMinute: 12 * 60, durationMinutes: 60 },
      { key: "dinner", label: "晚餐", defaultMinute: 18 * 60, durationMinutes: 60 }
    ];
    const candidates = closestDirectoryPoints(points, center, 30, Infinity);
    const used = new Set();
    return Object.fromEntries(meals.map(meal => {
      const requestedMinute = Number(requestedMinutes[meal.key]);
      const minute = Number.isFinite(requestedMinute) ? requestedMinute : meal.defaultMinute;
      const ranked = candidates.map(food => {
        const fit = mealFoodFit(food, meal);
        if (!fit) return null;
        const cacheKey = `${food.id || stableId(food.lat, food.lon)}:${meal.key}:${minute}`;
        if (!tripMealAvailabilityCache.has(cacheKey)) {
          tripMealAvailabilityCache.set(cacheKey, mealAvailability(food.opening, { ...meal, minute }));
        }
        return { ...food, ...fit, mealSuitabilityLabel: fit.label, mealAvailability: tripMealAvailabilityCache.get(cacheKey), mealTime: formatTripClock(minute) };
      }).filter(food => food && (!strictOpeningHours || food.mealAvailability !== "closed"))
        .sort((a, b) => {
          if (a.score !== b.score) return b.score - a.score;
          const availabilityRank = { open: 0, unknown: 1, closed: 2 };
          if (a.mealAvailability !== b.mealAvailability) return availabilityRank[a.mealAvailability] - availabilityRank[b.mealAvailability];
          const aUsed = used.has(String(a.id || stableId(a.lat, a.lon)));
          const bUsed = used.has(String(b.id || stableId(b.lat, b.lon)));
          if (aUsed !== bUsed) return aUsed ? 1 : -1;
          return a.distanceKm - b.distanceKm;
        })
        .slice(0, 5);
      for (const food of ranked) used.add(String(food.id || stableId(food.lat, food.lon)));
      return [meal.key, { label: meal.label, time: formatTripClock(minute), foods: ranked }];
    }));
  }

  function tripScheduleMealMinutes(day) {
    const legMinutes = (day.legs || []).reduce((total, leg) => total + (Number(leg.roadMetrics?.durationS) || 0) / 60, 0);
    const routeMinutes = Number(day.routeMetrics?.durationS || day.estimatedRouteDurationS) / 60 || legMinutes;
    const dwellMinutes = (day.legs || []).reduce((total, leg) => total + (Number(leg.destination?.dwellMinutes) || 0), 0);
    const lunchStop = (day.legs || []).find(leg => leg.destination?.type === "meal" && /午餐/u.test(leg.destination.meal || ""));
    const lunchFraction = Number(lunchStop?.destination?.routePosition?.fraction);
    return {
      breakfast: day.departureMinute - 60,
      lunch: day.departureMinute + (Number.isFinite(lunchFraction) ? routeMinutes * lunchFraction : routeMinutes * 0.52),
      dinner: Math.max(18 * 60, day.departureMinute + routeMinutes + dwellMinutes)
    };
  }

  function refreshTripScheduleMealOptions(day, foodPoints = activeTripFoodPoints) {
    if (!day || !Array.isArray(foodPoints)) return;
    const minutes = tripScheduleMealMinutes(day);
    const breakfastNearby = closestDirectoryPoints(foodPoints, day.origin, 8, 90);
    const dinnerNearby = closestDirectoryPoints(foodPoints, day.end, 8, 90);
    const lunchStop = (day.legs || []).find(leg => leg.destination?.type === "meal" && /午餐/u.test(leg.destination.meal || ""));
    const lunchCenter = lunchStop?.destination || pointAtTripRouteFraction(day.routeShape, 0.52) || day.end;
    const lunchNearby = closestDirectoryPoints(foodPoints, lunchCenter, 8, 90);
    day.breakfastOptions = recommendFoodsByMeal(breakfastNearby, day.origin, minutes, { strictOpeningHours: true }).breakfast.foods;
    day.lunchOptions = recommendFoodsByMeal(lunchNearby, lunchCenter, minutes, { strictOpeningHours: true }).lunch.foods;
    day.dinnerOptions = recommendFoodsByMeal(dinnerNearby, day.end, minutes, { strictOpeningHours: true }).dinner.foods;
    if (lunchStop) lunchStop.destination.options = day.lunchOptions;
  }

  function closestBackupSpots(center, excludedIds) {
    return spots.filter(spot => spot.overnightEligible !== false && !excludedIds.has(spot.id))
      .map(spot => ({ spot, distanceKm: haversineKm(center, spot) }))
      .sort((a, b) => a.distanceKm - b.distanceKm)
      .slice(0, 3);
  }

  function tripRoadMetricKey(origin, destination) {
    return `${stableId(origin.lat, origin.lon)}>${stableId(destination.lat, destination.lon)}`;
  }

  async function waitForTripRouteService() {
    const waitMs = Math.max(0, 1100 - (Date.now() - lastTripRouteRequestAt));
    if (waitMs) await new Promise(resolve => setTimeout(resolve, waitMs));
    lastTripRouteRequestAt = Date.now();
  }

  async function fetchTripRoute(origin, destination) {
    const coordinatePath = [origin, destination].map(point => `${Number(point.lon).toFixed(6)},${Number(point.lat).toFixed(6)}`).join(";");
    const url = new URL(`https://router.project-osrm.org/route/v1/driving/${coordinatePath}`);
    url.searchParams.set("overview", "full");
    url.searchParams.set("geometries", "geojson");
    url.searchParams.set("steps", "false");
    await waitForTripRouteService();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url, { signal: controller.signal, headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error(`道路路線服務回應 HTTP ${response.status}`);
      const data = await response.json();
      const route = data.routes?.[0];
      if (data.code !== "Ok" || !route) throw new Error(`道路路線服務回應 ${data.code || "未知狀態"}`);
      return route;
    } finally {
      clearTimeout(timer);
    }
  }

  function buildTripRouteShape(coordinates) {
    const raw = Array.isArray(coordinates) ? coordinates : [];
    if (raw.length < 2) return { points: [], segments: [], totalKm: 0, bounds: null };
    const stride = Math.max(1, Math.ceil((raw.length - 1) / 220));
    const sampled = raw.filter((_, index) => index % stride === 0);
    if (sampled.at(-1) !== raw.at(-1)) sampled.push(raw.at(-1));
    const points = sampled.map(([lon, lat]) => ({ lat: Number(lat), lon: Number(lon) }))
      .filter(point => Number.isFinite(point.lat) && Number.isFinite(point.lon));
    const segments = [];
    let totalKm = 0;
    for (let index = 1; index < points.length; index++) {
      const start = points[index - 1];
      const end = points[index];
      const lengthKm = haversineKm(start, end);
      segments.push({ start, end, lengthKm, progressKm: totalKm });
      totalKm += lengthKm;
    }
    if (!segments.length) return { points, segments, totalKm: 0, bounds: null };
    return {
      points,
      segments,
      totalKm,
      bounds: points.reduce((bounds, point) => ({
        minLat: Math.min(bounds.minLat, point.lat),
        maxLat: Math.max(bounds.maxLat, point.lat),
        minLon: Math.min(bounds.minLon, point.lon),
        maxLon: Math.max(bounds.maxLon, point.lon)
      }), { minLat: Infinity, maxLat: -Infinity, minLon: Infinity, maxLon: -Infinity })
    };
  }

  function measurePointOnTripRoute(point, shape) {
    if (!shape?.segments?.length) return { distanceKm: Infinity, progressKm: 0, fraction: 0 };
    let best = { distanceKm: Infinity, progressKm: 0, fraction: 0 };
    for (const segment of shape.segments) {
      const middleLat = (segment.start.lat + segment.end.lat + Number(point.lat)) / 3;
      const lonScale = 111.32 * Math.cos(middleLat * Math.PI / 180);
      const dx = (segment.end.lon - segment.start.lon) * lonScale;
      const dy = (segment.end.lat - segment.start.lat) * 111.32;
      const px = (Number(point.lon) - segment.start.lon) * lonScale;
      const py = (Number(point.lat) - segment.start.lat) * 111.32;
      const lengthSquared = dx * dx + dy * dy;
      const t = lengthSquared ? Math.max(0, Math.min(1, (px * dx + py * dy) / lengthSquared)) : 0;
      const distanceKm = Math.hypot(px - dx * t, py - dy * t);
      if (distanceKm < best.distanceKm) {
        const progressKm = segment.progressKm + segment.lengthKm * t;
        best = { distanceKm, progressKm, fraction: shape.totalKm ? progressKm / shape.totalKm : 0 };
      }
    }
    return best;
  }

  function pointAtTripRouteFraction(shape, fraction) {
    if (!shape?.segments?.length || !shape.totalKm) return shape?.points?.[0] || null;
    const target = Math.max(0, Math.min(1, fraction)) * shape.totalKm;
    const segment = shape.segments.find(item => target <= item.progressKm + item.lengthKm) || shape.segments.at(-1);
    const t = segment.lengthKm ? Math.max(0, Math.min(1, (target - segment.progressKm) / segment.lengthKm)) : 0;
    return {
      lat: segment.start.lat + (segment.end.lat - segment.start.lat) * t,
      lon: segment.start.lon + (segment.end.lon - segment.start.lon) * t
    };
  }

  function selectTripRouteAttractions(points, shape, durationSeconds) {
    if (!shape?.segments?.length || shape.totalKm < 25) return [];
    const targets = durationSeconds >= 4 * 60 * 60 ? [0.26, 0.74] : durationSeconds >= 90 * 60 ? [0.28] : [];
    const bounds = shape.bounds;
    const candidates = (Array.isArray(points) ? points : []).flatMap(point => {
      const lat = Number(point.lat);
      const lon = Number(point.lon);
      if (!point.name || !Number.isFinite(lat) || !Number.isFinite(lon)) return [];
      if (bounds && (lat < bounds.minLat - 0.09 || lat > bounds.maxLat + 0.09 || lon < bounds.minLon - 0.12 || lon > bounds.maxLon + 0.12)) return [];
      const routePosition = measurePointOnTripRoute({ lat, lon }, shape);
      if (routePosition.distanceKm > 8 || routePosition.fraction < 0.1 || routePosition.fraction > 0.9) return [];
      return [{ ...point, lat, lon, routePosition }];
    });
    const chosen = [];
    for (const target of targets) {
      const pool = candidates.filter(candidate => !chosen.some(item => (item.id && candidate.id && item.id === candidate.id) || (item.name === candidate.name && haversineKm(item, candidate) < 1)))
        .filter(candidate => Math.abs(candidate.routePosition.fraction - target) <= 0.24)
        .sort((a, b) => (a.routePosition.distanceKm + Math.abs(a.routePosition.fraction - target) * 12)
          - (b.routePosition.distanceKm + Math.abs(b.routePosition.fraction - target) * 12));
      if (pool[0]) chosen.push({ ...pool[0], type: "attraction", dwellMinutes: 60 });
    }
    return chosen.sort((a, b) => a.routePosition.progressKm - b.routePosition.progressKm);
  }

  async function prepareTripScheduleDay(day, attractionPoints, foodPoints) {
    let route = null;
    try {
      route = await fetchTripRoute(day.origin, day.end);
      day.routeAvailable = true;
    } catch (error) {
      day.routeAvailable = false;
      day.routeMessage = error.message || "道路路線服務暫不可用";
    }
    const routeCoordinates = route?.geometry?.coordinates || [
      [day.origin.lon, day.origin.lat],
      [day.end.lon, day.end.lat]
    ];
    const shape = buildTripRouteShape(routeCoordinates);
    const baselineDuration = Number(route?.duration) || shape.totalKm / 45 * 3600;
    day.estimatedRouteDurationS = baselineDuration;
    day.routeMetrics = route ? { distanceM: route.distance, durationS: route.duration } : null;
    day.routeShape = shape;

    const attractionStops = selectTripRouteAttractions(attractionPoints, shape, baselineDuration);
    const lunchCenter = pointAtTripRouteFraction(shape, 0.52) || day.end;
    const nearbyLunchPlaces = closestDirectoryPoints(foodPoints, lunchCenter, 8, 90);
    let lunchMinute = day.departureMinute + baselineDuration / 60 * measurePointOnTripRoute(lunchCenter, shape).fraction;
    let lunchOptions = [];
    let lunchChoice = null;
    let lunchPoint = lunchCenter;
    let lunchPosition = measurePointOnTripRoute(lunchCenter, shape);
    for (let attempt = 0; attempt < 2; attempt++) {
      lunchOptions = recommendFoodsByMeal(nearbyLunchPlaces, lunchCenter, { lunch: lunchMinute }, { strictOpeningHours: true }).lunch.foods;
      lunchChoice = lunchOptions[0] || null;
      lunchPoint = lunchChoice ? { lat: lunchChoice.lat, lon: lunchChoice.lon } : lunchCenter;
      lunchPosition = measurePointOnTripRoute(lunchPoint, shape);
      lunchMinute = day.departureMinute + baselineDuration / 60 * lunchPosition.fraction;
    }
    const lunchStop = shape.totalKm > 25 ? {
      ...(lunchChoice || {}),
      lat: lunchPoint.lat,
      lon: lunchPoint.lon,
      name: lunchChoice?.name || "沿途用餐休息",
      type: "meal",
      meal: "午餐",
      options: lunchOptions,
      routePosition: lunchPosition,
      dwellMinutes: 60
    } : null;
    const stops = [...attractionStops, ...(lunchStop ? [lunchStop] : [])]
      .sort((a, b) => a.routePosition.progressKm - b.routePosition.progressKm);
    day.stops = stops;
    const sequence = [
      { ...day.origin, label: day.originName, type: "origin" },
      ...stops,
      { ...day.end, label: day.endName, type: day.overnightSpot ? "overnight" : day.returnsToStart ? "return" : "destination" }
    ];
    day.legs = sequence.slice(1).map((destination, index) => ({
      origin: sequence[index],
      destination,
      roadMetrics: null
    }));
    refreshTripScheduleMealOptions(day, foodPoints);
    return day;
  }

  async function loadTripRoadMetrics(items, scheduleDays = []) {
    const targets = [
      ...items.flatMap(item => [
      { origin: item.origin, destination: item.spot, target: item, property: "roadMetrics" },
      ...Object.values(item.foods || {}).flatMap(group => group.foods || []).map(food => ({ origin: item.spot, destination: food, target: food, property: "roadMetrics" }))
      ]),
      ...scheduleDays.flatMap(day => day.legs.map(leg => ({ origin: leg.origin, destination: leg.destination, target: leg, property: "roadMetrics" })))
    ];
    const pending = new Map();
    for (const entry of targets) {
      entry.key = tripRoadMetricKey(entry.origin, entry.destination);
      if (tripRoadMetricCache.has(entry.key)) entry.target[entry.property] = tripRoadMetricCache.get(entry.key);
      else pending.set(entry.key, entry);
    }
    if (!pending.size) return true;

    const batches = [];
    let batchEntries = [];
    let batchCoordinateIds = new Set();
    for (const entry of pending.values()) {
      const pointIds = [stableId(entry.origin.lat, entry.origin.lon), stableId(entry.destination.lat, entry.destination.lon)];
      const newIds = pointIds.filter(id => !batchCoordinateIds.has(id));
      if (batchEntries.length && batchCoordinateIds.size + new Set(newIds).size > 90) {
        batches.push(batchEntries);
        batchEntries = [];
        batchCoordinateIds = new Set();
      }
      batchEntries.push(entry);
      for (const pointId of pointIds) batchCoordinateIds.add(pointId);
    }
    if (batchEntries.length) batches.push(batchEntries);

    for (const entries of batches) {
      const coordinates = [];
      const coordinateIndices = new Map();
      const coordinateIndex = point => {
        const key = stableId(point.lat, point.lon);
        if (!coordinateIndices.has(key)) {
          coordinateIndices.set(key, coordinates.length);
          coordinates.push({ lat: Number(point.lat), lon: Number(point.lon) });
        }
        return coordinateIndices.get(key);
      };
      const indexedPairs = entries.map(entry => ({
        entry,
        source: coordinateIndex(entry.origin),
        destination: coordinateIndex(entry.destination)
      }));
      const sources = [...new Set(indexedPairs.map(pair => pair.source))];
      const destinations = [...new Set(indexedPairs.map(pair => pair.destination))];
      const sourceRows = new Map(sources.map((index, row) => [index, row]));
      const destinationColumns = new Map(destinations.map((index, column) => [index, column]));
      const coordinatePath = coordinates.map(point => `${point.lon.toFixed(6)},${point.lat.toFixed(6)}`).join(";");
      const url = new URL(`https://router.project-osrm.org/table/v1/driving/${coordinatePath}`);
      url.searchParams.set("sources", sources.join(";"));
      url.searchParams.set("destinations", destinations.join(";"));
      url.searchParams.set("annotations", "distance,duration");

      await waitForTripRouteService();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      try {
        const response = await fetch(url, { signal: controller.signal, headers: { Accept: "application/json" } });
        if (!response.ok) throw new Error(`道路距離服務回應 HTTP ${response.status}`);
        const data = await response.json();
        if (data.code !== "Ok") throw new Error(`道路距離服務回應 ${data.code || "未知狀態"}`);
        for (const pair of indexedPairs) {
          const row = sourceRows.get(pair.source);
          const column = destinationColumns.get(pair.destination);
          const distanceM = data.distances?.[row]?.[column];
          const durationS = data.durations?.[row]?.[column];
          const metric = Number.isFinite(distanceM) && Number.isFinite(durationS) ? { distanceM, durationS } : null;
          tripRoadMetricCache.set(pair.entry.key, metric);
        }
        for (const entry of targets) {
          if (tripRoadMetricCache.has(entry.key)) entry.target[entry.property] = tripRoadMetricCache.get(entry.key);
        }
      } finally {
        clearTimeout(timer);
      }
    }
    return true;
  }

  function tripCountyMentions(text) {
    const normalized = normalizeSearchText(text);
    const shortNameCounts = new Map();
    for (const boundary of countyBoundaries) shortNameCounts.set(boundary.shortName, (shortNameCounts.get(boundary.shortName) || 0) + 1);
    const aliases = countyBoundaries.flatMap(boundary => [
      { alias: boundary.normalizedName, boundary },
      ...(shortNameCounts.get(boundary.shortName) === 1 ? [{ alias: boundary.shortName, boundary }] : [])
    ]).filter(item => item.alias).sort((a, b) => b.alias.length - a.alias.length);
    const candidates = [];
    for (const item of aliases) {
      let position = normalized.indexOf(item.alias);
      while (position >= 0) {
        candidates.push({ position, end: position + item.alias.length, boundary: item.boundary });
        position = normalized.indexOf(item.alias, position + item.alias.length);
      }
    }
    candidates.sort((a, b) => a.position - b.position || b.end - a.end);
    const mentions = [];
    for (const candidate of candidates) {
      if (mentions.some(item => candidate.position < item.end && candidate.end > item.position)) continue;
      mentions.push(candidate);
    }
    return mentions.sort((a, b) => a.position - b.position);
  }

  function tripOriginBoundaryFromText(text, mentions) {
    const explicitCues = [...text.matchAll(/(?:出發地|起點|從|由)(?:是|在|為)?/gu)];
    for (const cue of explicitCues) {
      const following = mentions.find(item => item.position >= cue.index + cue[0].length);
      if (following) return following.boundary;
      const preceding = mentions.filter(item => item.end <= cue.index).at(-1);
      if (preceding) return preceding.boundary;
    }

    for (const cue of text.matchAll(/(?:前往|抵達|到達|到)/gu)) {
      const preceding = mentions.filter(item => item.end <= cue.index).at(-1);
      const following = mentions.find(item => item.position >= cue.index + cue[0].length);
      if (preceding && following && preceding.boundary.name !== following.boundary.name) return preceding.boundary;
    }

    for (const cue of text.matchAll(/出發|起程/gu)) {
      const preceding = mentions.filter(item => item.end <= cue.index).at(-1);
      const following = mentions.find(item => item.position >= cue.index + cue[0].length);
      if (preceding && (!following || preceding.boundary.name !== following.boundary.name)) return preceding.boundary;
    }
    return null;
  }

  function tripDestinationBoundaryFromText(text, mentions) {
    const cues = [...text.matchAll(/(?:前往|抵達|到達|目的地(?:是|為|在)?|到|去)/gu)];
    for (const cue of cues.reverse()) {
      const following = mentions.find(item => item.position >= cue.index + cue[0].length);
      if (following) return following.boundary;
    }
    return mentions.at(-1)?.boundary || null;
  }

  function parseTripRouteRequest(text, days) {
    const value = String(text || "");
    let markers = [...value.matchAll(/第\s*(\d+|[一二兩三四五六七八九十]{1,3})\s*天/gu)]
      .map(match => ({ day: chineseNumber(match[1]), index: match.index }));
    const allMentions = tripCountyMentions(value);
    if (!markers.length) {
      const tripContext = /(?:\d+|[一二兩三四五六七八九十]{1,3})\s*(?:天|日|夜)|車泊|車宿|行程|旅程|旅遊|旅行|出發|前往|抵達|到/u.test(value);
      if (!tripContext || !allMentions.length) return null;
      markers = [{ day: 1, index: 0 }];
    } else if (markers.length < 2 && !allMentions.length) {
      return null;
    }

    const requestedDays = new Map();
    const firstDayMarker = markers.find(marker => marker.day === 1);
    const originContextEnd = firstDayMarker
      ? markers.find(marker => marker.index > firstDayMarker.index)?.index ?? value.length
      : markers[0]?.index ?? value.length;
    const originContext = value.slice(0, originContextEnd);
    let originBoundary = tripOriginBoundaryFromText(originContext, tripCountyMentions(originContext));
    const firstDayIndex = markers[0]?.index ?? 0;
    const prelude = value.slice(0, firstDayIndex);
    const preludeMentions = tripCountyMentions(prelude);
    const defaultDestinationBoundary = tripDestinationBoundaryFromText(prelude, preludeMentions)
      || tripDestinationBoundaryFromText(value, allMentions);
    for (let index = 0; index < markers.length; index++) {
      const marker = markers[index];
      if (marker.day < 1 || marker.day > days) continue;
      const end = markers[index + 1]?.index ?? value.length;
      const segment = value.slice(marker.index, end);
      const mentions = tripCountyMentions(segment);
      const returns = /返回|回程|返程|回家|回到起點|回到出發地/u.test(segment);
      let destinationBoundary = null;
      let returnsToStart = false;

      if (marker.day === 1 && mentions.length >= 2) {
        originBoundary = mentions[0].boundary;
        destinationBoundary = mentions.at(-1).boundary;
      } else if (returns) {
        const lastMention = mentions.at(-1)?.boundary || null;
        if (lastMention && originBoundary && lastMention.name === originBoundary.name) returnsToStart = true;
        else if (lastMention) destinationBoundary = lastMention;
        else returnsToStart = true;
      } else if (mentions.length) {
        destinationBoundary = mentions.at(-1).boundary;
        if (marker.day === 1 && /出發|起程|起點/u.test(segment) && !/到|前往|抵達|去/u.test(segment)) {
          originBoundary = originBoundary || destinationBoundary;
          destinationBoundary = null;
        }
      } else if (marker.day === 1 && defaultDestinationBoundary && !returns) {
        destinationBoundary = defaultDestinationBoundary;
      }
      if (marker.day === 1 && !returnsToStart && !destinationBoundary && defaultDestinationBoundary) {
        destinationBoundary = defaultDestinationBoundary;
      }

      requestedDays.set(marker.day, { day: marker.day, destinationBoundary, returnsToStart, segment });
    }

    if (!requestedDays.size || ![...requestedDays.values()].some(item => item.destinationBoundary || item.returnsToStart)) return null;
    const nightsMatch = value.match(/(\d+|[一二兩三四五六七八九十]{1,3})\s*夜/u);
    const nights = nightsMatch ? Math.max(0, Math.min(days - 1, chineseNumber(nightsMatch[1]))) : Math.max(0, days - 1);
    const plannedDays = [];
    let previousDestination = defaultDestinationBoundary;
    for (let day = 1; day <= days; day++) {
      const requested = requestedDays.get(day);
      if (requested?.destinationBoundary) previousDestination = requested.destinationBoundary;
      if (requested?.returnsToStart) {
        plannedDays.push(requested);
      } else if (day === days && day > nights && previousDestination && !requested?.destinationBoundary) {
        plannedDays.push({ day, destinationBoundary: null, returnsToStart: true, segment: requested?.segment || "" });
      } else if (requested?.destinationBoundary || previousDestination) {
        plannedDays.push({ ...requested, day, destinationBoundary: requested?.destinationBoundary || previousDestination, returnsToStart: false, segment: requested?.segment || "" });
      } else {
        plannedDays.push({ ...requested, day, destinationBoundary: null, returnsToStart: false, segment: requested?.segment || "" });
      }
    }

    const timeMatch = value.match(/(?:上午|早上|下午|晚上)?\s*(\d{1,2})[:：](\d{2})\s*出發/u);
    let departureMinute = 8 * 60;
    if (timeMatch) {
      let hour = Number(timeMatch[1]);
      const minute = Number(timeMatch[2]);
      if (/下午|晚上/u.test(timeMatch[0]) && hour < 12) hour += 12;
      if (/上午|早上/u.test(timeMatch[0]) && hour === 12) hour = 0;
      if (hour <= 23 && minute <= 59) departureMinute = hour * 60 + minute;
    }
    return { originBoundary, nights, departureMinute, days: plannedDays };
  }

  function parseTripStartCoordinates(query) {
    const parts = String(query || "").trim().match(/^([+-]?\d+(?:\.\d+)?)\s*[,，\s]\s*([+-]?\d+(?:\.\d+)?)$/u);
    if (!parts) return null;
    const lat = Number(parts[1]);
    const lon = Number(parts[2]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      throw new Error("座標格式不正確，請依「緯度, 經度」輸入，例如 25.033, 121.565。");
    }
    return { lat, lon };
  }

  async function resolveTripStartLocation(query) {
    const coordinates = parseTripStartCoordinates(query);
    if (coordinates) {
      return { ...coordinates, label: `手動座標 ${coordinates.lat.toFixed(5)}, ${coordinates.lon.toFixed(5)}` };
    }

    const normalizedQuery = normalizeSearchText(query);
    const exactSpot = spots.find(spot => normalizeSearchText(spot.name) === normalizedQuery);
    if (exactSpot) {
      return {
        lat: Number(exactSpot.lat),
        lon: Number(exactSpot.lon),
        label: exactSpot.name,
        spotId: exactSpot.id
      };
    }
    if (tripStartLocationCache.has(normalizedQuery)) return tripStartLocationCache.get(normalizedQuery);

    const countyMatches = countyBoundaries.filter(boundary => normalizedQuery === boundary.normalizedName || normalizedQuery === boundary.shortName);
    const countyBoundary = countyMatches.length === 1 ? countyMatches[0] : null;
    const url = new URL("https://photon.komoot.io/api/");
    url.searchParams.set("q", countyBoundary ? countyBoundary.normalizedName : query);
    url.searchParams.set("countrycode", "TW");
    url.searchParams.set("limit", "5");
    if (countyBoundary) url.searchParams.set("layer", "city");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(url, { signal: controller.signal, headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error(`地名查詢服務回應 HTTP ${response.status}`);
      const data = await response.json();
      const features = (data.features || []).filter(item => item?.geometry?.coordinates?.length >= 2);
      const feature = countyBoundary
        ? features.find(item => {
          const [candidateLon, candidateLat] = item.geometry.coordinates.map(Number);
          return Number.isFinite(candidateLon) && Number.isFinite(candidateLat)
            && isInsideGeometry(candidateLon, candidateLat, countyBoundary.geometry);
        })
        : features.find(item => [item.properties?.name, item.properties?.street, item.properties?.district, item.properties?.city, item.properties?.county]
          .some(value => value && normalizeSearchText(value) === normalizedQuery)) || features[0];
      if (!feature && countyBoundary) {
        const fallback = countyFallbackLocation(countyBoundary);
        if (fallback) {
          tripStartLocationCache.set(normalizedQuery, fallback);
          return fallback;
        }
      }
      if (!feature) throw new Error("找不到這個地點，請輸入更完整的地名、地址或座標。");
      const [lon, lat] = feature.geometry.coordinates.map(Number);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error("查詢結果沒有有效座標，請改輸入緯度與經度。");
      const place = feature.properties || {};
      const mainName = place.name || place.street || query;
      const detail = [place.district, place.city, place.county, place.state]
        .find(value => value && normalizeSearchText(value) !== normalizeSearchText(mainName));
      const result = { lat, lon, label: detail ? `${mainName}（${detail}）` : mainName };
      tripStartLocationCache.set(normalizedQuery, result);
      return result;
    } catch (error) {
      if (error.name === "AbortError") throw new Error("地名查詢逾時，請稍後再試，或直接輸入緯度與經度。");
      if (error instanceof TypeError) throw new Error("目前無法連線查詢地名；可檢查網路，或直接輸入緯度與經度。");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function planTrip(manualStart = null, routeRequest = null, resolvedRouteDays = null) {
    const planSequence = ++tripPlanSequence;
    tripAdjustmentSequence++;
    activeTripPlanSequence = planSequence;
    activeTripScheduleDays = [];
    activeTripItinerary = [];
    activeTripDetails = null;
    activeTripFoodPoints = [];
    activeTripAttractionPoints = [];
    activeTripDirectoryError = false;
    activeTripRouteError = false;
    resetTripAdjustmentConversation();
    $("#tripAdjustmentPanel").hidden = true;
    parseRequirementsFromText();
    $("#planExportToolbar").hidden = true;
    const days = Math.max(1, Math.min(14, Number($("#daysInput").value) || 3));
    const maxKm = Number($("#maxKm").value) || 160;
    const preferences = $$("input[name='pref']:checked").map(input => input.value);
    const nights = routeRequest ? routeRequest.nights : days;
    $("#routeSchedule").innerHTML = routeRequest ? `<p class="plan-progress">正在安排途中景點、用餐與道路時間…</p>` : "";
    const startChoice = $("#startSpot").value;
    let current;
    let startLabel;
    const startingSpot = manualStart ? (manualStart.spotId ? getSpot(manualStart.spotId) : null) : startChoice === "current" ? null : getSpot(startChoice);
    if (manualStart) {
      current = { lat: manualStart.lat, lon: manualStart.lon };
      startLabel = manualStart.label;
    } else if (startingSpot) {
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
    if (routeRequest && resolvedRouteDays?.length) {
      const usedNightSpots = new Set(startingSpot ? [startingSpot.id] : []);
      for (const routeDay of resolvedRouteDays) {
        routeDay.origin = { ...routeOrigin };
        routeDay.originName = routeOriginName;
        routeDay.departureMinute = routeRequest.departureMinute;
        routeDay.maxKm = maxKm;
        if (routeDay.day <= nights) {
          const destinationCounty = routeDay.destinationBoundary || countyBoundaries.find(boundary =>
            isInsideGeometry(Number(routeDay.destinationPoint.lon), Number(routeDay.destinationPoint.lat), boundary.geometry));
          const countyName = destinationCounty?.name || countyAtPoint(Number(routeDay.destinationPoint.lon), Number(routeDay.destinationPoint.lat));
          const choice = spots.filter(spot => spot.overnightEligible !== false && !usedNightSpots.has(spot.id)
            && (!countyName || normalizeSearchText(spot.county || countyAtPoint(Number(spot.lon), Number(spot.lat))) === normalizeSearchText(countyName)))
            .map(spot => ({ spot, distanceKm: haversineKm(routeDay.destinationPoint, spot) }))
            .filter(item => item.distanceKm <= 50)
            .sort((a, b) => a.distanceKm - b.distanceKm)[0];
          if (choice) {
            const end = { lat: Number(choice.spot.lat), lon: Number(choice.spot.lon) };
            const distance = haversineKm(routeDay.origin, end);
            routeDay.end = end;
            routeDay.endName = choice.spot.name;
            routeDay.overnightSpot = choice.spot;
            routeDay.destinationDistanceKm = choice.distanceKm;
            itinerary.push({ day: routeDay.day, spot: choice.spot, distance, hits: preferenceHits(choice.spot, preferences), origin: routeDay.origin, originName: routeOriginName, exceeded: distance > maxKm });
            usedNightSpots.add(choice.spot.id);
            routeOrigin = end;
            routeOriginName = choice.spot.name;
          } else {
            routeDay.end = { ...routeDay.destinationPoint };
            routeDay.endName = routeDay.destinationName;
            routeDay.noOvernightSpot = true;
            routeOrigin = { ...routeDay.end };
            routeOriginName = routeDay.endName;
          }
        } else {
          routeDay.end = { ...routeDay.destinationPoint };
          routeDay.endName = routeDay.returnsToStart ? `返回${startLabel}` : routeDay.destinationName;
          routeOrigin = { ...routeDay.end };
          routeOriginName = routeDay.endName;
        }
        routeDay.exceeded = haversineKm(routeDay.origin, routeDay.end) > maxKm;
        if (routeDay.exceeded) exceeded = true;
      }
    } else {
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
    }
    const details = { days, nights, destinationPlan: Boolean(routeRequest), maxKm, preferences, startLabel, startingSpotId: startingSpot?.id || manualStart?.spotId || "", exceeded, needs: $("#needsInput").value.trim() };
    if (!itinerary.length && !routeRequest) {
      renderItinerary(itinerary, details);
      return;
    }

    const excludedBackupIds = new Set(itinerary.map(item => item.spot.id));
    if (startingSpot) excludedBackupIds.add(startingSpot.id);
    for (const item of itinerary) {
      item.backups = closestBackupSpots(item.spot, excludedBackupIds);
      item.foods = null;
      item.attractions = null;
    }
    renderItinerary(itinerary, details, { loadingData: true, routeStatus: "loading" });

    const [foodResult, attractionResult] = await Promise.allSettled([loadFoodDirectory(), loadAttractionDirectory()]);
    if (planSequence !== tripPlanSequence) return;
    const foodPoints = foodResult.status === "fulfilled" ? foodResult.value.points : [];
    const attractionPoints = attractionResult.status === "fulfilled" ? attractionResult.value.points : [];
    for (const item of itinerary) {
      item.foods = recommendFoodsByMeal(foodPoints, item.spot);
      item.attractions = closestDirectoryPoints(attractionPoints, item.spot, 25, 5);
    }
    const directoryError = foodResult.status !== "fulfilled" || attractionResult.status !== "fulfilled";
    const scheduleDays = [];
    if (routeRequest && resolvedRouteDays) {
      for (const day of resolvedRouteDays) {
        scheduleDays.push(await prepareTripScheduleDay(day, attractionPoints, foodPoints));
      }
    }
    if (planSequence !== tripPlanSequence) return;
    activeTripScheduleDays = scheduleDays;
    activeTripItinerary = itinerary;
    activeTripDetails = details;
    activeTripFoodPoints = foodPoints;
    activeTripAttractionPoints = attractionPoints;
    activeTripDirectoryError = directoryError;
    if (scheduleDays.length) renderTripSchedule(scheduleDays, { routeStatus: "loading" });
    renderItinerary(itinerary, details, { directoryError, routeStatus: "loading" });

    let routeError = scheduleDays.some(day => !day.routeAvailable);
    try {
      await loadTripRoadMetrics(itinerary, scheduleDays);
    } catch {
      routeError = true;
    }
    if (planSequence !== tripPlanSequence) return;
    activeTripRouteError = routeError;
    if (scheduleDays.length) renderTripSchedule(scheduleDays, { routeStatus: routeError ? "unavailable" : "ready" });
    renderItinerary(itinerary, details, { directoryError, routeStatus: routeError ? "unavailable" : "ready" });
    $("#planExportToolbar").hidden = !itinerary.length && !scheduleDays.length;
    showTripAdjustmentPanel();
  }

  function formatTripClock(minutes) {
    const wrapped = ((Math.round(minutes) % 1440) + 1440) % 1440;
    return `${String(Math.floor(wrapped / 60)).padStart(2, "0")}:${String(wrapped % 60).padStart(2, "0")}`;
  }

  function tripFoodOptionsMarkup(items, center, query, origin = center) {
    if (items?.length) {
      return items.map((food, index) => {
        const url = mapsDirectionsUrl(origin, food);
        const suitability = food.mealSuitabilityLabel ? `・${food.mealSuitabilityLabel}` : "";
        const availability = food.mealAvailability === "unknown" ? "・營業時間待確認" : "・時段符合";
        return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${index + 1}. ${escapeHtml(food.name)}${suitability}${availability}・導航 ↗</a>`;
      }).join("　");
    }
    const url = googleSearchUrl(query, center.lat, center.lon, "near");
    return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">用 Google 地圖搜尋附近店家 ↗</a>`;
  }

  function renderTripSchedule(days, options = {}) {
    const root = $("#routeSchedule");
    if (!days?.length) {
      root.innerHTML = "";
      return;
    }
    const cards = days.map(day => {
      const rows = [];
      const breakfastMinute = day.departureMinute - 60;
      rows.push(`<tr><td>${formatTripClock(breakfastMinute)}</td><th>早餐（${escapeHtml(day.originName)}附近）</th><td>出發前</td><td>—</td><td>約 45 分鐘</td><td>${tripFoodOptionsMarkup(day.breakfastOptions, day.origin, "早餐")}</td></tr>`);
      rows.push(`<tr class="main-route-row"><td>${formatTripClock(day.departureMinute)}</td><th>出發：${escapeHtml(day.originName)}</th><td>—</td><td>—</td><td>—</td><td>依道路狀況出發</td></tr>`);

      let clockMinute = day.departureMinute;
      let clockKnown = true;
      for (const [legIndex, leg] of (day.legs || []).entries()) {
        const metric = leg.roadMetrics;
        if (metric) clockMinute += metric.durationS / 60;
        else clockKnown = false;
        const destination = leg.destination;
        const time = options.routeStatus === "loading" ? "計算中…" : clockKnown ? formatTripClock(clockMinute) : "待查";
        const placeName = destination.name || destination.label || "自訂停留點";
        let title = destination.type === "attraction" ? `景點：${placeName}`
          : destination.type === "meal" ? `${destination.meal || "用餐"}：${placeName}`
            : destination.type === "overnight" ? `泊點：${destination.label}`
              : destination.type === "return" ? `返抵起點：${destination.label}`
                : `抵達：${destination.label}`;
        let stop = destination.dwellMinutes ? `約 ${destination.dwellMinutes} 分鐘` : destination.type === "overnight" ? "過夜" : "—";
        let details = `<a href="${escapeHtml(mapsDirectionsUrl(leg.origin, destination))}" target="_blank" rel="noopener">本段導航 ↗</a>`;
        let editorMarkup = "";
        if (destination.type === "attraction") {
          const url = googleSearchUrl(destination.name, destination.lat, destination.lon, "near");
          details += `　<a href="${escapeHtml(url)}" target="_blank" rel="noopener">景點資訊 ↗</a>`;
          details += `<small>${escapeHtml(destination.category || "沿途景點")} · 預留停留 1 小時</small>`;
        } else if (destination.type === "meal") {
          details += `<small>${tripFoodOptionsMarkup(destination.options, destination, "餐廳", leg.origin)}</small>`;
        } else if (destination.type === "overnight") {
          details += `<small>目的地：${escapeHtml(day.destinationName)}${day.destinationDistanceKm > 2 ? ` · 泊點距目的地約 ${day.destinationDistanceKm.toFixed(1)} 公里（直線）` : ""}</small>`;
        }
        if (["attraction", "meal", "overnight"].includes(destination.type)) {
          const disabled = options.routeStatus === "loading" ? " disabled" : "";
          const latitude = Number(destination.lat);
          const longitude = Number(destination.lon);
          const editor = `<details class="route-stop-adjustment"><summary>${options.routeStatus === "loading" ? "正在更新…" : "調整此停留點"}</summary><form data-trip-stop-edit data-day="${day.day}" data-leg="${legIndex}"><label>地點名稱<input name="name" required maxlength="100" value="${escapeHtml(placeName)}"${disabled}></label><div class="route-stop-coordinates"><label>緯度<input name="lat" type="number" min="-90" max="90" step="any" required value="${Number.isFinite(latitude) ? latitude.toFixed(6) : ""}"${disabled}></label><label>經度<input name="lon" type="number" min="-180" max="180" step="any" required value="${Number.isFinite(longitude) ? longitude.toFixed(6) : ""}"${disabled}></label></div>${destination.type === "overnight" ? "" : `<label>停留時間（分鐘）<input name="dwell" type="number" min="0" max="720" step="5" value="${Math.max(0, Number(destination.dwellMinutes) || 0)}"${disabled}></label>`}<div class="route-stop-edit-actions"><button type="submit"${disabled}>套用</button>${["attraction", "meal"].includes(destination.type) ? `<button type="button" data-trip-stop-move data-day="${day.day}" data-leg="${legIndex}" data-delta="-1"${legIndex === 0 ? " disabled" : disabled}>提前</button><button type="button" data-trip-stop-move data-day="${day.day}" data-leg="${legIndex}" data-delta="1"${!(["attraction", "meal"].includes(day.legs?.[legIndex + 1]?.destination?.type)) ? " disabled" : disabled}>延後</button><button type="button" class="secondary" data-trip-stop-remove data-day="${day.day}" data-leg="${legIndex}"${disabled}>移除此點</button>` : ""}</div><small>只修改這個停留點；其餘安排會保留，受影響路段會重新計算。</small></form></details>`;
          editorMarkup = editor;
        }
        rows.push(`<tr><td>${time}</td><th>${escapeHtml(title)}${editorMarkup}</th><td>${metric ? formatDriveDistance(metric.distanceM) : options.routeStatus === "loading" ? "計算中…" : "—"}</td><td>${metric ? formatDriveDuration(metric.durationS) : options.routeStatus === "loading" ? "計算中…" : "—"}</td><td>${stop}</td><td>${details}</td></tr>`);
        if (destination.dwellMinutes && clockKnown) clockMinute += destination.dwellMinutes;
      }

      if (day.overnightSpot) {
        const dinnerTime = clockKnown ? formatTripClock(Math.max(clockMinute, 18 * 60)) : "抵達後";
        rows.push(`<tr><td>${dinnerTime}</td><th>晚餐（${escapeHtml(day.endName)}附近）</th><td>泊點附近</td><td>—</td><td>約 1 小時</td><td>${tripFoodOptionsMarkup(day.dinnerOptions, day.end, "晚餐")}</td></tr>`);
      }
      const metrics = (day.legs || []).map(leg => leg.roadMetrics).filter(Boolean);
      const totalDistance = metrics.length === day.legs.length && metrics.length ? formatDriveDistance(metrics.reduce((sum, item) => sum + item.distanceM, 0)) : day.routeMetrics ? `${formatDriveDistance(day.routeMetrics.distanceM)}（未含停留繞路）` : "道路資料暫不可用";
      const totalDuration = metrics.length === day.legs.length && metrics.length ? formatDriveDuration(metrics.reduce((sum, item) => sum + item.durationS, 0)) : day.routeMetrics ? `${formatDriveDuration(day.routeMetrics.durationS)}（未含停留繞路）` : "時間待查";
      const warning = day.exceeded ? `<p class="plan-warning">本日目的地超過設定的 ${day.maxKm || 160} 公里直線距離上限，仍依你描述的目的地安排。</p>` : "";
      const overnightNotice = day.noOvernightSpot ? `<p class="plan-warning">目的地附近 50 公里內沒有找到同縣市的可過夜泊點；已先以目的地作為當日終點，請調整停留點或選擇其他泊點。</p>` : "";
      const routeNotice = !day.routeAvailable ? `<p class="plan-warning">道路路線暫時無法取得；沿途點位以直線廊道估算，行車時間與里程請以導航確認。</p>` : "";
      return `<article class="route-day-card"><header><strong>第 ${day.day} 天：${escapeHtml(day.originName)} → ${escapeHtml(day.destinationName)}</strong><div class="route-day-tools"><label>出發時間<input type="time" data-trip-departure-time="${day.day}" value="${formatTripClock(day.departureMinute)}"${options.routeStatus === "loading" ? " disabled" : ""}></label><span>預估開車 ${totalDistance} · ${totalDuration}</span></div></header>${warning}${overnightNotice}${routeNotice}<div class="day-route-table-wrap"><table class="day-route-table trip-schedule-table" aria-label="第 ${day.day} 天預計行程時間與里程"><thead><tr><th>預計時間</th><th>停留點／安排</th><th>本段里程</th><th>行車時間</th><th>停留時間</th><th>導航／推薦</th></tr></thead><tbody>${rows.join("")}</tbody></table></div></article>`;
    }).join("");
    const overview = days.map(day => `第 ${day.day} 天由 ${day.originName} 前往${day.destinationName}${day.overnightSpot ? `，夜宿${day.endName}` : day.returnsToStart ? "，行程返回起點" : ""}`).join("；");
    root.innerHTML = `<section class="trip-schedule"><div class="section-heading"><div><h2>每日路線與停留時間表</h2><span>依旅程描述安排：${escapeHtml(overview)}。可個別修改停留點的名稱、位置與時間，或移動／移除該點；其他安排會保留。</span></div></div>${cards}<p class="form-disclaimer">行車里程與時間依 OpenStreetMap 道路資料估算，不含即時路況。景點與店家營業狀況請出發前確認。</p></section>`;
  }

  function rebuildTripScheduleLegs(day, destinations = (day.legs || []).map(leg => leg.destination)) {
    const origin = { ...day.origin, label: day.originName, type: "origin" };
    day.routeMetrics = null;
    day.legs = destinations.map((destination, index) => ({
      origin: index === 0 ? origin : destinations[index - 1],
      destination,
      roadMetrics: null
    }));
    day.stops = destinations.filter(destination => ["attraction", "meal"].includes(destination.type));
    const end = destinations.at(-1);
    if (end) {
      day.end = { lat: Number(end.lat), lon: Number(end.lon) };
      day.endName = end.label || end.name || day.endName;
    }
  }

  function createTripEditedSpot(lat, lon, name, previousSpot = null) {
    const coordinateId = stableId(lat, lon);
    const knownSpot = spots.find(spot => stableId(spot.lat, spot.lon) === coordinateId);
    const previousMatches = previousSpot && stableId(previousSpot.lat, previousSpot.lon) === coordinateId;
    const base = knownSpot || (previousMatches ? previousSpot : {});
    return {
      ...base,
      id: knownSpot?.id || (previousMatches ? previousSpot.id : coordinateId),
      name,
      lat,
      lon,
      county: countyAtPoint(lon, lat) || base.county || "",
      overnightEligible: true
    };
  }

  function refreshTripParkingSuggestions(item, center) {
    if (!item) return;
    item.distance = haversineKm(item.origin, center);
    item.hits = preferenceHits(center, activeTripDetails?.preferences || []);
    item.foods = recommendFoodsByMeal(activeTripFoodPoints, center);
    for (const group of Object.values(item.foods)) {
      for (const food of group.foods || []) food.roadMetrics = null;
    }
    item.attractions = closestDirectoryPoints(activeTripAttractionPoints, center, 25, 5);
    const excludedIds = new Set(activeTripItinerary.map(planItem => planItem.spot.id));
    if (activeTripDetails?.startingSpotId) excludedIds.add(activeTripDetails.startingSpotId);
    item.backups = closestBackupSpots(center, excludedIds);
  }

  function updateOvernightInRoute(dayIndex, spot) {
    const day = activeTripScheduleDays[dayIndex];
    if (!day) return;
    day.overnightSpot = spot;
    day.destinationDistanceKm = haversineKm(day.destinationPoint, spot);
    day.routeMetrics = null;
    day.dinnerOptions = recommendFoodsByMeal(
      closestDirectoryPoints(activeTripFoodPoints, spot, 8, 90),
      spot,
      tripScheduleMealMinutes(day),
      { strictOpeningHours: true }
    ).dinner.foods;
    const destinations = (day.legs || []).map(leg => leg.destination);
    const finalDestination = destinations.at(-1);
    if (finalDestination?.type === "overnight") {
      destinations[destinations.length - 1] = { ...finalDestination, ...spot, label: spot.name, type: "overnight" };
    }
    rebuildTripScheduleLegs(day, destinations);

    for (let index = dayIndex + 1; index < activeTripScheduleDays.length; index++) {
      const previousDay = activeTripScheduleDays[index - 1];
      const nextDay = activeTripScheduleDays[index];
      nextDay.origin = { ...previousDay.end };
      nextDay.originName = previousDay.endName;
      nextDay.routeMetrics = null;
      nextDay.breakfastOptions = recommendFoodsByMeal(
        closestDirectoryPoints(activeTripFoodPoints, nextDay.origin, 8, 90),
        nextDay.origin,
        { breakfast: nextDay.departureMinute - 60 },
        { strictOpeningHours: true }
      ).breakfast.foods;
      rebuildTripScheduleLegs(nextDay);
      const nextItem = activeTripItinerary.find(planItem => planItem.day === nextDay.day);
      if (nextItem) {
        nextItem.origin = { ...nextDay.origin };
        nextItem.originName = nextDay.originName;
        nextItem.roadMetrics = null;
        refreshTripParkingSuggestions(nextItem, nextItem.spot);
      }
    }
  }

  function syncTripBackups() {
    const excludedIds = new Set(activeTripItinerary.map(item => item.spot.id));
    if (activeTripDetails?.startingSpotId) excludedIds.add(activeTripDetails.startingSpotId);
    for (const item of activeTripItinerary) {
      item.backups = closestBackupSpots(item.spot, excludedIds);
    }
  }

  async function refreshTripAfterPartialEdit(message) {
    const adjustmentSequence = ++tripAdjustmentSequence;
    const planSequence = activeTripPlanSequence;
    if (activeTripScheduleDays.length) renderTripSchedule(activeTripScheduleDays, { routeStatus: "loading" });
    renderItinerary(activeTripItinerary, activeTripDetails, {
      directoryError: activeTripDirectoryError,
      routeStatus: "loading"
    });
    let routeError = activeTripScheduleDays.some(day => !day.routeAvailable);
    try {
      await loadTripRoadMetrics(activeTripItinerary, activeTripScheduleDays);
    } catch {
      routeError = true;
    }
    if (adjustmentSequence !== tripAdjustmentSequence || planSequence !== activeTripPlanSequence) return;
    activeTripRouteError = routeError;
    const finalStatus = routeError ? "unavailable" : "ready";
    if (activeTripScheduleDays.length) renderTripSchedule(activeTripScheduleDays, { routeStatus: finalStatus });
    renderItinerary(activeTripItinerary, activeTripDetails, {
      directoryError: activeTripDirectoryError,
      routeStatus: finalStatus
    });
    $("#planExportToolbar").hidden = !activeTripItinerary.length && !activeTripScheduleDays.length;
    notify(message);
  }

  function applyTripStopEdit(form) {
    const dayNumber = Number(form.dataset.day);
    const legIndex = Number(form.dataset.leg);
    const day = activeTripScheduleDays.find(item => item.day === dayNumber);
    const leg = day?.legs?.[legIndex];
    if (!day || !leg) return;
    const data = new FormData(form);
    const name = String(data.get("name") || "").trim();
    const lat = Number(data.get("lat"));
    const lon = Number(data.get("lon"));
    const dwell = data.has("dwell") ? Number(data.get("dwell")) : 0;
    if (!name || name.length > 100) return notify("請輸入 1 到 100 個字的地點名稱。");
    if (!Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lon) || Math.abs(lon) > 180) return notify("請確認緯度與經度在有效範圍內。");
    if (data.has("dwell") && (!Number.isFinite(dwell) || dwell < 0 || dwell > 720)) return notify("停留時間請設定在 0 到 720 分鐘之間。");

    const previous = leg.destination;
    if (previous.type === "overnight") {
      const item = activeTripItinerary.find(planItem => planItem.day === dayNumber);
      const spot = createTripEditedSpot(lat, lon, name, item?.spot || day.overnightSpot);
      if (activeTripItinerary.some(planItem => planItem.day !== dayNumber && planItem.spot.id === spot.id)) {
        return notify("這個泊點已安排在其他夜晚，請選擇不同位置。");
      }
      if (item) {
        item.spot = spot;
        item.roadMetrics = null;
        refreshTripParkingSuggestions(item, spot);
      }
      updateOvernightInRoute(activeTripScheduleDays.indexOf(day), spot);
      syncTripBackups();
    } else {
      const edited = { ...previous, name, lat, lon, dwellMinutes: dwell };
      if (previous.type === "meal") edited.options = [{ ...previous, ...edited }];
      const destinations = day.legs.map(item => item.destination);
      destinations[legIndex] = edited;
      rebuildTripScheduleLegs(day, destinations);
    }
    refreshTripAfterPartialEdit("已套用這項調整，受影響的行車時間與里程已更新。");
  }

  function removeTripStop(dayNumber, legIndex) {
    const day = activeTripScheduleDays.find(item => item.day === dayNumber);
    const leg = day?.legs?.[legIndex];
    if (!leg || !["attraction", "meal"].includes(leg.destination.type)) return;
    const destinations = day.legs.map(item => item.destination);
    destinations.splice(legIndex, 1);
    rebuildTripScheduleLegs(day, destinations);
    return refreshTripAfterPartialEdit("已移除這個停留點，其餘行程保留並重新計算受影響路段。");
  }

  function moveTripStop(dayNumber, legIndex, delta) {
    const day = activeTripScheduleDays.find(item => item.day === dayNumber);
    if (!day || !["attraction", "meal"].includes(day.legs?.[legIndex]?.destination?.type)) return;
    const targetIndex = legIndex + delta;
    if (!["attraction", "meal"].includes(day.legs?.[targetIndex]?.destination?.type)) return;
    const destinations = day.legs.map(item => item.destination);
    [destinations[legIndex], destinations[targetIndex]] = [destinations[targetIndex], destinations[legIndex]];
    rebuildTripScheduleLegs(day, destinations);
    return refreshTripAfterPartialEdit("已調整停留順序，其餘行程保留並重新計算受影響路段。");
  }

  function replacePlannedOvernightSpot(dayNumber, spotId) {
    const spot = getSpot(spotId);
    const item = activeTripItinerary.find(planItem => planItem.day === dayNumber);
    if (!spot || !item || activeTripItinerary.some(planItem => planItem.day !== dayNumber && planItem.spot.id === spot.id)) return;
    item.spot = { ...spot };
    item.roadMetrics = null;
    refreshTripParkingSuggestions(item, item.spot);
    const routeDayIndex = activeTripScheduleDays.findIndex(day => day.day === dayNumber);
    if (routeDayIndex >= 0) updateOvernightInRoute(routeDayIndex, item.spot);
    else {
      for (const laterItem of activeTripItinerary.filter(planItem => planItem.day > dayNumber)) {
        const previousItem = activeTripItinerary.find(planItem => planItem.day === laterItem.day - 1);
        if (previousItem) {
          laterItem.origin = { lat: Number(previousItem.spot.lat), lon: Number(previousItem.spot.lon) };
          laterItem.originName = previousItem.spot.name;
          laterItem.roadMetrics = null;
          laterItem.distance = haversineKm(laterItem.origin, laterItem.spot);
        }
      }
    }
    syncTripBackups();
    return refreshTripAfterPartialEdit("第 " + dayNumber + " 天泊點已換成「" + spot.name + "」。");
  }

  function resetTripAdjustmentConversation() {
    tripAdjustmentConversation = [];
    activeTripConversationContext = null;
    tripConversationBusy = false;
    const messages = $("#tripAdjustmentMessages");
    if (messages) messages.replaceChildren();
    const input = $("#tripAdjustmentInput");
    if (input) input.value = "";
    const status = $("#tripAdjustmentStatus");
    if (status) status.textContent = "可調整出發時間、途中停留時間與順序、停留地點和備援泊點。";
    const submit = $("#tripAdjustmentSubmit");
    if (submit) {
      submit.disabled = false;
      submit.textContent = "送出調整";
    }
  }

  function appendTripConversationMessage(role, message) {
    const root = $("#tripAdjustmentMessages");
    if (!root) return;
    const bubble = document.createElement("div");
    bubble.className = "trip-chat-message " + (role === "user" ? "user" : "assistant");
    bubble.textContent = message;
    root.append(bubble);
    root.scrollTop = root.scrollHeight;
    tripAdjustmentConversation.push({ role, message });
  }

  function showTripAdjustmentPanel() {
    const panel = $("#tripAdjustmentPanel");
    if (!panel || (!activeTripScheduleDays.length && !activeTripItinerary.length)) return;
    panel.hidden = false;
    if (!tripAdjustmentConversation.length) {
      appendTripConversationMessage("assistant", "行程已準備好。你可以直接說想怎麼改，例如「第一天晚半小時出發」、「第二天午餐停留改成 90 分鐘」或「第一晚改規劃外澳附近的泊點」；換泊點時會一併更新附近備援、景點和美食。");
    }
  }

  function tripConversationDay(text) {
    const match = String(text).match(/第?\s*(\d{1,2}|[一二兩三四五六七八九十]{1,3})\s*(?:天|晚|夜)/u);
    return match ? chineseNumber(match[1]) : null;
  }

  function parseTripConversationDuration(text) {
    let value = String(text);
    if (/一個半小時/u.test(value)) return 90;
    value = value.replace(/半個小時|半小時|半個鐘頭/u, "30分鐘");
    const hourMatch = value.match(/(\d+(?:\.\d+)?|[一二兩三四五六七八九十]{1,3})(?:個)?\s*小時(半)?/u);
    if (hourMatch) {
      const amount = /^\d/u.test(hourMatch[1]) ? Number(hourMatch[1]) : chineseNumber(hourMatch[1]);
      return Math.round(amount * 60 + (hourMatch[2] ? 30 : 0));
    }
    const minuteMatch = value.match(/(\d+|[一二兩三四五六七八九十]{1,3})\s*(?:分鐘|分)/u);
    return minuteMatch ? chineseNumber(minuteMatch[1]) : null;
  }

  function tripConversationStopType(text) {
    if (/午餐|中餐|用餐|吃飯|午飯/u.test(text)) return "meal";
    if (/景點|景區|觀光點/u.test(text)) return "attraction";
    if (/泊點|住宿|過夜/u.test(text)) return "overnight";
    return null;
  }

  function tripConversationCandidates(text, type = tripConversationStopType(text)) {
    const requestedDay = tripConversationDay(text);
    const days = activeTripScheduleDays.filter(day => !requestedDay || day.day === requestedDay);
    if (requestedDay && !days.length) throw new Error("目前行程沒有第 " + requestedDay + " 天，請確認天數。");
    let candidates = days.flatMap(day => (day.legs || []).map((leg, legIndex) => ({ day, leg, legIndex })))
      .filter(item => ["attraction", "meal", "overnight"].includes(item.leg.destination && item.leg.destination.type));
    if (type) candidates = candidates.filter(item => item.leg.destination.type === type);
    const named = candidates.filter(item => {
      const name = item.leg.destination.name || item.leg.destination.label || "";
      return name.length > 1 && text.includes(name);
    });
    if (named.length === 1) return named;
    if (named.length > 1) candidates = named;
    if (!candidates.length) throw new Error(type === "meal"
      ? "這一天沒有安排途中用餐停留；請改指定景點或泊點，或先重新規劃路線。"
      : "找不到符合條件的停留點，請說明日期和類型，例如「第二天景點」。");
    if (candidates.length > 1) {
      const choices = candidates.map(item => "第 " + item.day.day + " 天「" + (item.leg.destination.name || item.leg.destination.label || item.leg.destination.type) + "」").join("、");
      throw new Error("我找到多個可能的停留點（" + choices + "），請補上天數或地點名稱。");
    }
    return candidates;
  }

  function tripConversationOvernightItem(text) {
    const dayNumber = tripConversationDay(text);
    const items = activeTripItinerary.filter(item => !dayNumber || item.day === dayNumber);
    if (dayNumber && !items.length) throw new Error("目前行程沒有第 " + dayNumber + " 天的泊點。");
    if (items.length > 1) throw new Error("請補上天數，例如「第二晚改用第一個備援泊點」。");
    if (!items.length) throw new Error("目前行程沒有可調整的泊點。");
    return items[0];
  }

  function tripParkingLocationQuery(text) {
    if (/備援|替代泊點/u.test(text) || !/(?:泊點|住宿|過夜|車泊)/u.test(text)) return "";
    if (!/(?:改|調整|規劃|安排|找|尋找|選|挑|住|換|搬)/u.test(text)) return "";
    const match = text.match(/(?:改規劃|改安排|改到|改成|改為|調整為|換到|換成|搬到|搬去|規劃|安排到|安排在|安排|尋找|選擇|挑選|找|選|挑|住在|住到|住)\s*(.+)$/u);
    if (!match) return "";
    return match[1]
      .replace(/(?:的)?(?:泊點|停車點|住宿點|住宿|過夜點|車泊點).*$/u, "")
      .replace(/(?:附近|周邊|一帶)$/u, "")
      .replace(/^[到在往去至]+/u, "")
      .replace(/[的、，。！？\s]+$/u, "")
      .trim();
  }

  async function resolveTripLocationOrNamedSpot(query) {
    try {
      return await resolveTripStartLocation(query);
    } catch (error) {
      const normalized = normalizeSearchText(query);
      const namedSpots = spots.filter(spot => normalizeSearchText(spot.name).includes(normalized));
      if (!namedSpots.length) throw error;
      const center = namedSpots.reduce((sum, spot) => ({
        lat: sum.lat + Number(spot.lat) / namedSpots.length,
        lon: sum.lon + Number(spot.lon) / namedSpots.length
      }), { lat: 0, lon: 0 });
      return { ...center, label: query + "（依本機泊點資料定位）" };
    }
  }

  function findNearbyTripOvernightSpot(center, dayNumber, maxDistanceKm = 30) {
    const usedElsewhere = new Set(activeTripItinerary
      .filter(item => item.day !== dayNumber)
      .map(item => item.spot.id));
    if (activeTripDetails?.startingSpotId) usedElsewhere.add(activeTripDetails.startingSpotId);
    return spots.filter(spot => spot.overnightEligible !== false && !usedElsewhere.has(spot.id))
      .map(spot => ({ spot, distanceKm: haversineKm(center, spot) }))
      .sort((a, b) => a.distanceKm - b.distanceKm)
      .filter(item => item.distanceKm <= maxDistanceKm);
  }

  function parseTripDepartureMinute(text, currentMinute) {
    const match = text.match(/(?:上午|早上|下午|晚上)?\s*(\d{1,2})[:：](\d{2})/u);
    if (match && /出發|起程|時間|改成|調整/u.test(text)) {
      let hour = Number(match[1]);
      const minute = Number(match[2]);
      if (/下午|晚上/u.test(text) && hour < 12) hour += 12;
      if (/上午|早上/u.test(text) && hour === 12) hour = 0;
      if (hour > 23 || minute > 59) throw new Error("請輸入有效時間，例如 08:30。");
      return hour * 60 + minute;
    }
    const spoken = text.match(/(上午|早上|中午|下午|晚上)?\s*(\d{1,2}|[一二兩三四五六七八九十]{1,3})\s*點(?:半|(\d{1,2})分?)?/u);
    if (spoken && /出發|起程|時間|改成|調整/u.test(text)) {
      let hour = /^\d/u.test(spoken[2]) ? Number(spoken[2]) : chineseNumber(spoken[2]);
      const minute = spoken[0].includes("半") ? 30 : Number(spoken[3] || 0);
      if (["下午", "晚上"].includes(spoken[1]) && hour < 12) hour += 12;
      if (["上午", "早上"].includes(spoken[1]) && hour === 12) hour = 0;
      if (spoken[1] === "中午" && hour < 11) hour += 12;
      if (hour > 23 || minute > 59) throw new Error("請輸入有效時間，例如「早上九點半」或 09:30。");
      return hour * 60 + minute;
    }
    const duration = parseTripConversationDuration(text);
    if (duration == null || !/出發|起程/u.test(text)) return null;
    if (/晚|延後|延遲|往後/u.test(text)) return currentMinute + duration;
    if (/早|提早|提前|往前/u.test(text)) return currentMinute - duration;
    return null;
  }

  function setTripDayDeparture(day, minute) {
    day.departureMinute = ((minute % 1440) + 1440) % 1440;
  }

  async function applyTripConversationalAdjustment(rawText) {
    const text = String(rawText || "").trim();
    if (!text) throw new Error("請輸入想調整的內容。");
    if (!activeTripItinerary.length && !activeTripScheduleDays.length) throw new Error("目前沒有已規劃的行程，請先完成規劃。");
    const requestedDay = tripConversationDay(text);
    const daysToAdjust = requestedDay
      ? activeTripScheduleDays.filter(day => day.day === requestedDay)
      : /每天|每一天/u.test(text) ? activeTripScheduleDays : [];
    if (requestedDay && activeTripScheduleDays.length && !daysToAdjust.length) throw new Error("目前行程沒有第 " + requestedDay + " 天。");

    const parkingLocationQuery = tripParkingLocationQuery(text);
    if (parkingLocationQuery) {
      const item = tripConversationOvernightItem(text);
      const location = await resolveTripLocationOrNamedSpot(parkingLocationQuery);
      const nearbySpots = findNearbyTripOvernightSpot(location, item.day, 30);
      const nearest = nearbySpots[0];
      if (!nearest) {
        const closest = spots.filter(spot => spot.overnightEligible !== false)
          .map(spot => ({ spot, distanceKm: haversineKm(location, spot) }))
          .sort((a, b) => a.distanceKm - b.distanceKm)[0];
        throw new Error("「" + parkingLocationQuery + "」30 公里內沒有可用泊點" + (closest ? "；目前最近的是「" + closest.spot.name + "」，約 " + closest.distanceKm.toFixed(1) + " 公里。" : "。") + "我沒有替你改動原行程。");
      }
      await replacePlannedOvernightSpot(item.day, nearest.spot.id);
      const updated = activeTripItinerary.find(planItem => planItem.day === item.day);
      const mealCount = Object.values(updated?.foods || {}).reduce((count, group) => count + (group.foods || []).length, 0);
      const backupCount = updated?.backups?.length || 0;
      const attractionCount = updated?.attractions?.length || 0;
      activeTripConversationContext = null;
      return "已把第 " + item.day + " 晚改到「" + nearest.spot.name + "」（距「" + parkingLocationQuery + "」約 " + nearest.distanceKm.toFixed(1) + " 公里）。我也已依這個泊點更新 " + backupCount + " 個附近備援泊點、" + attractionCount + " 個附近景點和 " + mealCount + " 家三餐推薦；後續行程會從新泊點接續。";
    }

    if (/備援|替代泊點/u.test(text)) {
      const item = tripConversationOvernightItem(text);
      const numberMatch = text.match(/(?:第\s*)?(一|二|三|1|2|3)\s*個/u);
      const backupIndex = numberMatch ? chineseNumber(numberMatch[1]) - 1 : 0;
      const backup = item.backups && item.backups[backupIndex];
      if (!backup) throw new Error("第 " + item.day + " 天沒有第 " + (backupIndex + 1) + " 個備援泊點可選。");
      await replacePlannedOvernightSpot(item.day, backup.spot.id);
      activeTripConversationContext = null;
      return "已把第 " + item.day + " 天的泊點改為「" + backup.spot.name + "」，並更新後續路線。";
    }

    if (/出發|起程/u.test(text)) {
      if (!activeTripScheduleDays.length) throw new Error("這份規劃沒有每日路線時間表，無法調整出發時間。");
      const targets = /每天|每一天/u.test(text) ? activeTripScheduleDays : daysToAdjust;
      if (!targets.length) throw new Error("請說明哪一天出發，例如「第一天晚半小時出發」。");
      const newMinute = parseTripDepartureMinute(text, targets[0].departureMinute);
      if (newMinute == null) throw new Error("請說明要提早／延後多久，或直接給時間，例如「第二天改成 09:00 出發」。");
      const duration = parseTripConversationDuration(text);
      for (const day of targets) {
        const minute = /每天|每一天/u.test(text) && duration != null
          ? (/晚|延後|延遲|往後/u.test(text) ? day.departureMinute + duration : /早|提早|提前|往前/u.test(text) ? day.departureMinute - duration : newMinute)
          : newMinute;
        setTripDayDeparture(day, minute);
        refreshTripScheduleMealOptions(day);
      }
      await refreshTripAfterPartialEdit("已更新出發時間。");
      activeTripConversationContext = null;
      return "出發時間已調整為 " + targets.map(day => "第 " + day.day + " 天 " + formatTripClock(day.departureMinute)).join("、") + "。";
    }

    if (/刪除|移除|取消(?:這個|該)?停留/u.test(text)) {
      const item = tripConversationCandidates(text)[0];
      if (!["attraction", "meal"].includes(item.leg.destination.type)) throw new Error("泊點是每晚住宿終點，不能當作途中停留點移除；可改選備援泊點。");
      const label = item.leg.destination.name || item.leg.destination.meal || "停留點";
      await removeTripStop(item.day.day, item.legIndex);
      activeTripConversationContext = null;
      return "已移除第 " + item.day.day + " 天的「" + label + "」，並更新受影響路段。";
    }

    if (/提前|延後|往前|往後|(?:移到|改到|排在).*(?:景點|午餐|中餐|用餐)(?:前|後)/u.test(text)) {
      const type = tripConversationStopType(text);
      if (!type || type === "overnight") throw new Error("請說明要移動的景點或用餐點，例如「第二天把午餐移到景點前」。");
      const item = tripConversationCandidates(text, type)[0];
      const targets = item.day.legs.map((leg, index) => ({ leg, index })).filter(other => other.index !== item.legIndex && ["attraction", "meal"].includes(other.leg.destination.type));
      if (!targets.length) throw new Error("這一天沒有另一個途中停留點可調整順序。");
      const relative = text.match(/(?:景點|午餐|中餐|用餐).*?(前|後)/u);
      let targetIndex;
      if (/移到|改到|排在/u.test(text) && relative) {
        const targetType = /景點/u.test(text) ? "attraction" : /午餐|中餐|用餐/u.test(text) ? "meal" : null;
        const target = targets.find(other => !targetType || other.leg.destination.type === targetType);
        if (!target) throw new Error("找不到你指定的相對停留點，請改說「午餐提前」或「景點延後」。");
        targetIndex = target.index + (relative[1] === "後" ? 1 : 0);
      } else {
        const delta = /延後|往後/u.test(text) ? 1 : -1;
        const target = targets.find(other => other.index === item.legIndex + delta);
        if (!target) throw new Error("這個停留點已在可移動的最前／最後位置。");
        targetIndex = target.index;
      }
      const destinations = item.day.legs.map(leg => leg.destination);
      const moving = destinations.splice(item.legIndex, 1)[0];
      const insertionIndex = targetIndex > item.legIndex ? targetIndex - 1 : targetIndex;
      destinations.splice(Math.max(0, Math.min(destinations.length, insertionIndex)), 0, moving);
      rebuildTripScheduleLegs(item.day, destinations);
      await refreshTripAfterPartialEdit("已調整停留順序。");
      activeTripConversationContext = null;
      return "已調整第 " + item.day.day + " 天的停留順序，受影響路段里程與時間已更新。";
    }

    const duration = parseTripConversationDuration(text);
    const continuingDwell = /^(?:再|另外|多|少|增加|減少|延長|縮短|改成|改為|調成|設定為|停留)/u.test(text) && activeTripConversationContext && activeTripConversationContext.intent === "dwell";
    if (duration != null && (/停留|多留|多停|少留|少停|待久|景點/u.test(text) || continuingDwell)) {
      let day;
      let leg;
      let legIndex;
      if (continuingDwell) {
        day = activeTripScheduleDays.find(candidate => candidate.day === activeTripConversationContext.day);
        legIndex = activeTripConversationContext.legIndex;
        leg = day && day.legs[legIndex];
        if (!leg || !["attraction", "meal"].includes(leg.destination.type)) throw new Error("剛才調整的停留點已不存在，請重新指定日期和地點。");
      } else {
        const found = tripConversationCandidates(text)[0];
        day = found.day;
        leg = found.leg;
        legIndex = found.legIndex;
      }
      if (!["attraction", "meal"].includes(leg.destination.type)) throw new Error("泊點停留時間固定為過夜，無法用這個方式修改。");
      const relative = /多留|多停|少留|少停|待久|延長|縮短|增加|減少/u.test(text);
      const delta = /少|減少|縮短/u.test(text) ? -duration : duration;
      const absolute = /(?:改成|改為|調整為|設定為|停留)\s*(?:約\s*)?(?:\d+|[一二兩三四五六七八九十]{1,3}|半小時)/u.test(text);
      const dwell = Math.max(0, Math.min(720, relative && !absolute ? (Number(leg.destination.dwellMinutes) || 0) + delta : duration));
      const destinations = day.legs.map(routeLeg => routeLeg.destination);
      destinations[legIndex] = { ...leg.destination, dwellMinutes: dwell };
      rebuildTripScheduleLegs(day, destinations);
      await refreshTripAfterPartialEdit("已更新停留時間。");
      activeTripConversationContext = { intent: "dwell", day: day.day, legIndex };
      return "第 " + day.day + " 天「" + (leg.destination.name || leg.destination.meal || "停留點") + "」現在安排停留 " + dwell + " 分鐘。你可以接著說「再多留半小時」。";
    }

    const relocateMatch = text.match(/(?:午餐|中餐|用餐|吃飯|午飯|景點|停留點)\s*(?:改到|移到|改去|安排到|安排在|改成)\s*(.+)$/u);
    if (relocateMatch) {
      if (!activeTripScheduleDays.length) throw new Error("目前行程沒有途中路線表，無法重新安排沿途地點。");
      const isMeal = /午餐|中餐|用餐|吃飯|午飯/u.test(text);
      const type = isMeal ? "meal" : "attraction";
      const placeQuery = relocateMatch[1].replace(/(?:附近|一帶|周邊|作為.*)$/u, "").replace(/[，。！？、\s]+$/u, "").trim();
      if (!placeQuery) throw new Error("請在「改到」後面補上地名，例如「午餐改到花蓮市區」。");
      const place = await resolveTripStartLocation(placeQuery);
      let targetDays = requestedDay ? activeTripScheduleDays.filter(day => day.day === requestedDay) : activeTripScheduleDays;
      if (!requestedDay) {
        const ranked = targetDays.map(day => ({ day, distance: day.routeShape && day.routeShape.segments && day.routeShape.segments.length
          ? measurePointOnTripRoute(place, day.routeShape).distanceKm
          : Math.min(haversineKm(place, day.origin), haversineKm(place, day.end)) })).sort((a, b) => a.distance - b.distance);
        if (!ranked.length || ranked[0].distance > 30 || ranked.length > 1 && ranked[1].distance - ranked[0].distance < 3) {
          throw new Error("請補上天數，例如「第二天午餐改到花蓮市區」，這樣我才能保留其他天的安排。");
        }
        targetDays = [ranked[0].day];
      }
      const day = targetDays[0];
      const found = day.legs.map((leg, index) => ({ leg, index })).find(item => item.leg.destination.type === type);
      if (!found) throw new Error("第 " + day.day + " 天目前沒有安排" + (isMeal ? "午餐" : "景點") + "，無法移動這個停留點。");
      const previous = found.leg.destination;
      let updated;
      if (isMeal) {
        const nearby = closestDirectoryPoints(activeTripFoodPoints, place, 5, 50);
        const options = recommendFoodsByMeal(nearby, place, tripScheduleMealMinutes(day), { strictOpeningHours: true }).lunch.foods;
        const choice = options[0] || null;
        const point = choice || place;
        updated = { ...previous, ...(choice || {}), lat: Number(point.lat), lon: Number(point.lon), name: choice && choice.name || "午餐（" + place.label + "）", label: choice && choice.name || place.label, meal: "午餐", options, routePosition: day.routeShape ? measurePointOnTripRoute(point, day.routeShape) : previous.routePosition, dwellMinutes: previous.dwellMinutes };
        day.lunchOptions = options;
      } else {
        const nearest = closestDirectoryPoints(activeTripAttractionPoints, place, 5, 1)[0];
        const point = nearest || place;
        updated = { ...previous, ...(nearest || {}), lat: Number(point.lat), lon: Number(point.lon), name: nearest && nearest.name || place.label, label: nearest && nearest.name || place.label, routePosition: day.routeShape ? measurePointOnTripRoute(point, day.routeShape) : previous.routePosition, dwellMinutes: previous.dwellMinutes };
      }
      const destinations = day.legs.map(leg => leg.destination);
      destinations[found.index] = updated;
      const finalStop = destinations.find(destination => ["overnight", "return", "destination"].includes(destination.type));
      const routeStops = destinations.filter(destination => destination !== finalStop)
        .sort((a, b) => (a.routePosition && a.routePosition.progressKm || 0) - (b.routePosition && b.routePosition.progressKm || 0));
      rebuildTripScheduleLegs(day, finalStop ? routeStops.concat(finalStop) : routeStops);
      await refreshTripAfterPartialEdit("已移動途中停留點。");
      activeTripConversationContext = null;
      return isMeal
        ? "第 " + day.day + " 天午餐已移到「" + place.label + "」" + (updated.name !== place.label ? "，並選用附近的「" + updated.name + "」。" : "；附近沒有目錄店家，先保留地區位置。")
        : "第 " + day.day + " 天景點已改為「" + updated.name + "」（" + place.lat.toFixed(4) + ", " + place.lon.toFixed(4) + "）。";
    }

    throw new Error("我還不能判斷要改哪一項。你可以說「第一天晚半小時出發」、「第二天午餐停留改成 90 分鐘」、「刪除第一天景點」、「午餐提前」、「第一晚改用第一個備援泊點」或「第一晚改規劃外澳附近的泊點」。");
  }

  async function submitTripAdjustment(event) {
    event.preventDefault();
    if (tripConversationBusy) return;
    const input = $("#tripAdjustmentInput");
    const text = input.value.trim();
    if (!text) return;
    appendTripConversationMessage("user", text);
    input.value = "";
    tripConversationBusy = true;
    $("#tripAdjustmentSubmit").disabled = true;
    $("#tripAdjustmentSubmit").textContent = "正在調整…";
    $("#tripAdjustmentStatus").textContent = "正在依照你的描述更新行程…";
    try {
      appendTripConversationMessage("assistant", await applyTripConversationalAdjustment(text));
      $("#tripAdjustmentStatus").textContent = "可以接著輸入下一項微調；每次變更都會更新受影響的行車時間與里程。";
    } catch (error) {
      appendTripConversationMessage("assistant", error.message || "這次沒有套用調整，請換個方式描述。");
      $("#tripAdjustmentStatus").textContent = "請補上天數、停留點類型或更明確的地名，再送出一次。";
    } finally {
      tripConversationBusy = false;
      $("#tripAdjustmentSubmit").disabled = false;
      $("#tripAdjustmentSubmit").textContent = "送出調整";
      input.focus();
    }
  }

  async function exportTripPlanPng() {
    const button = $("#exportTripPngButton");
    if (typeof window.html2canvas !== "function") {
      notify("PNG 匯出工具尚未載入，請重新整理後再試。");
      return;
    }

    let captureRoot;
    button.disabled = true;
    button.textContent = "正在製作 PNG…";
    try {
      const cssWidth = 1040;
      captureRoot = document.createElement("div");
      captureRoot.className = "trip-share-capture";
      captureRoot.style.cssText = `position:fixed;left:-100000px;top:0;width:${cssWidth}px;padding:34px;background:#f7f8f5;color:#173e34;font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;box-sizing:border-box;`;
      captureRoot.innerHTML = `<header style="margin:0 0 20px;padding:0 0 16px;border-bottom:1px solid #dce5df"><p style="margin:0 0 7px;color:#789087;font-size:12px;letter-spacing:2px;font-weight:700">車宿旅圖・行程分享</p><h1 style="margin:0 0 6px;font-size:26px;line-height:1.3">行程規劃</h1><p style="margin:0;color:#738078;font-size:13px;line-height:1.6">${escapeHtml($("#needsInput").value.trim() || "我的車宿旅程")}</p></header>`;
      for (const selector of ["#routeSchedule", "#itinerary"]) {
        const source = $(selector);
        if (!source?.textContent.trim()) continue;
        captureRoot.append(source.cloneNode(true));
      }
      $$(".route-stop-adjustment, .backup-replace-button, .route-day-tools", captureRoot).forEach(control => control.remove());
      const now = new Date();
      const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      const footer = document.createElement("p");
      footer.textContent = `由車宿旅圖匯出 · ${date}`;
      footer.style.cssText = "margin:20px 0 0;padding-top:12px;border-top:1px solid #dce5df;color:#85938b;font-size:11px";
      captureRoot.append(footer);
      document.body.append(captureRoot);
      if (document.fonts?.ready) await document.fonts.ready;

      const cssHeight = Math.ceil(captureRoot.getBoundingClientRect().height);
      if (!cssHeight) throw new Error("目前沒有可匯出的行程內容。");
      const scale = Math.min(2, 16000 / cssHeight, 4200 / cssWidth, Math.sqrt(18000000 / (cssWidth * cssHeight)));
      const canvas = await window.html2canvas(captureRoot, {
        backgroundColor: "#f7f8f5",
        scale,
        width: cssWidth,
        height: cssHeight,
        windowWidth: cssWidth,
        windowHeight: cssHeight,
        scrollX: 0,
        scrollY: 0,
        logging: false
      });
      const blob = await new Promise((resolve, reject) => canvas.toBlob(result => result ? resolve(result) : reject(new Error("PNG 圖片建立失敗。")), "image/png"));
      const fileName = `車宿旅圖行程-${date}.png`;
      let shared = false;
      if (typeof navigator.share === "function" && typeof File === "function") {
        try {
          const file = new File([blob], fileName, { type: "image/png" });
          const canShareFile = typeof navigator.canShare !== "function" || navigator.canShare({ files: [file] });
          if (canShareFile) {
            await navigator.share({ title: "車宿旅圖行程", text: "分享我的車宿旅程規劃", files: [file] });
            shared = true;
          }
        } catch (error) {
          if (error.name === "AbortError") return;
        }
      }
      if (shared) {
        notify("已開啟行程圖片分享選單。");
        return;
      }

      const objectUrl = URL.createObjectURL(blob);
      const download = document.createElement("a");
      download.href = objectUrl;
      download.download = fileName;
      document.body.append(download);
      download.click();
      download.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 30000);
      notify("行程 PNG 已下載。");
    } catch (error) {
      notify(error.message || "行程 PNG 製作失敗，請稍後再試。");
    } finally {
      captureRoot?.remove();
      button.disabled = false;
      button.textContent = "分享／匯出 PNG";
    }
  }

  function renderItinerary(items, details, options = {}) {
    const root = $("#itinerary");
    if (!items.length) {
      root.innerHTML = details.destinationPlan ? "" : `<div class="empty-state"><strong>目前沒有可安排的泊點</strong><p>調整起點或需求後再試一次。</p></div>`;
      return;
    }
    const prefLabels = { sea: "海邊／海線", mountain: "山區／森林", spring: "溫泉", temple: "廟宇", service: "服務區／休息站" };
    const prefText = details.preferences.map(key => prefLabels[key]).join("、");
    const routeLabel = metric => metric
      ? `開車 ${formatDriveDistance(metric.distanceM)} · 約 ${formatDriveDuration(metric.durationS)}`
      : options.routeStatus === "loading" ? "正在計算路線…"
        : options.routeStatus === "unavailable" ? "道路服務暫不可用"
          : "沒有可用道路路線";
    const dayCards = items.map(item => {
      const hits = item.hits.length ? item.hits.map(key => `<span class="badge">符合${prefLabels[key]}</span>`).join("") : "";
      const warning = item.exceeded ? `<p class="plan-warning">此點超過設定的 ${details.maxKm} 公里直線上限，是當下可選的最近點。</p>` : "";
      const backupRows = (item.backups || []).map((backup, index) => `<li><span class="backup-rank">${index + 1}</span><div><strong>${escapeHtml(backup.spot.name)}</strong><small>距規劃泊點 ${formatDistanceKm(backup.distanceKm)}（直線）</small></div><div class="backup-actions"><a href="${escapeHtml(mapsDirectionsUrl(item.origin, backup.spot))}" target="_blank" rel="noopener">導航 ↗</a><button type="button" class="backup-replace-button" data-replace-overnight-day="${item.day}" data-replace-overnight-spot="${escapeHtml(backup.spot.id)}"${options.routeStatus === "loading" ? " disabled" : ""}>改用此泊點</button></div></li>`).join("") || `<li>沒有其他可用的備援泊點。</li>`;
      const foodRows = item.foods === null && options.loadingData
        ? `<tr><td colspan="5">正在載入美食目錄…</td></tr>`
        : [
          { key: "breakfast", label: "早餐" },
          { key: "lunch", label: "午餐" },
          { key: "dinner", label: "晚餐" }
        ].map(meal => {
          const foods = item.foods?.[meal.key]?.foods || [];
          const bloggerUrl = escapeHtml(bloggerFoodSearchUrl(item.spot, meal.label));
          const recommendations = foods.map(food => {
            const address = [food.city, food.town, food.address].filter(Boolean).join(" ");
            const opening = String(food.opening || "").trim();
            const hours = opening ? `登錄營業時間：${opening.slice(0, 72)}${opening.length > 72 ? "…" : ""}` : "營業時間未提供，請先確認";
            const details = [address, food.mealSuitabilityLabel, hours].filter(Boolean).join(" · ");
            return `<tr><th><a href="${escapeHtml(mapsDirectionsUrl(item.spot, food))}" target="_blank" rel="noopener">${escapeHtml(food.name)}・導航 ↗</a><small>${escapeHtml(details)}</small></th><td>${formatDistanceKm(food.distanceKm)}</td><td>${food.roadMetrics ? formatDriveDistance(food.roadMetrics.distanceM) : routeLabel(null)}</td><td>${food.roadMetrics ? formatDriveDuration(food.roadMetrics.durationS) : options.routeStatus === "loading" ? "計算中…" : "—"}</td><td><a href="${escapeHtml(mapsDirectionsUrl(item.spot, food))}" target="_blank" rel="noopener">導航 ↗</a></td></tr>`;
          }).join("");
          const fallbackUrl = escapeHtml(googleSearchUrl(`${meal.label} 餐廳`, item.spot.lat, item.spot.lon, "near"));
          const missingRows = foods.length < 5
            ? `<tr class="meal-missing-row"><th>${meal.label}推薦不足 5 家</th><td colspan="3">目錄中符合餐別的店家不足；可搜尋確認餐點和營業狀況</td><td><a href="${fallbackUrl}" target="_blank" rel="noopener">搜尋 ↗</a></td></tr>`
            : "";
          return `<tr class="meal-section-row"><th colspan="5"><span class="meal-section-heading"><span>${meal.label}推薦 ${foods.length}/5</span><a href="${bloggerUrl}" target="_blank" rel="noopener noreferrer" aria-label="搜尋${escapeHtml(item.spot.name)}附近${meal.label}網路部落客美食">網路部落客美食 ↗</a></span></th></tr>${recommendations}${missingRows}`;
        }).join("");
      const attractionRows = item.attractions === null && options.loadingData
        ? `<li>正在載入景點目錄…</li>`
        : (item.attractions || []).map(attraction => `<li><a href="${escapeHtml(googleSearchUrl(attraction.name, attraction.lat, attraction.lon, "near"))}" target="_blank" rel="noopener">${escapeHtml(attraction.name)} ↗</a><small>${escapeHtml(attraction.category || "觀光署登錄景點")} · 距泊點 ${formatDistanceKm(attraction.distanceKm)}（直線）</small></li>`).join("") || `<li>25 公里內沒有找到觀光署登錄景點。<a href="${escapeHtml(googleSearchUrl("景點", item.spot.lat, item.spot.lon, "near"))}" target="_blank" rel="noopener">用 Google 地圖搜尋 ↗</a></li>`;
      const mainRouteLink = escapeHtml(mapsDirectionsUrl(item.origin, item.spot));
      const foodTable = `<div class="day-route-table-wrap"><table class="day-route-table" aria-label="第 ${item.day} 天行程里程與三餐推薦美食"><thead><tr><th>路段／美食</th><th>直線距離</th><th>道路里程</th><th>行車時間</th><th>導航</th></tr></thead><tbody><tr class="main-route-row"><th>第 ${item.day} 天：${escapeHtml(item.originName)} → ${escapeHtml(item.spot.name)}</th><td>${formatDistanceKm(item.distance)}</td><td>${item.roadMetrics ? formatDriveDistance(item.roadMetrics.distanceM) : routeLabel(null)}</td><td>${item.roadMetrics ? formatDriveDuration(item.roadMetrics.durationS) : options.routeStatus === "loading" ? "計算中…" : "—"}</td><td><a href="${mainRouteLink}" target="_blank" rel="noopener">導航 ↗</a></td></tr>${foodRows}</tbody></table></div>`;
      return `<article class="day-card"><div class="day-number">DAY<b>${item.day}</b></div><div class="day-main"><div class="day-heading"><div><h3>${escapeHtml(item.spot.name)}</h3><p>由 ${escapeHtml(item.originName)} 出發 · ${Number(item.spot.lat).toFixed(5)}, ${Number(item.spot.lon).toFixed(5)}</p></div><span class="day-distance">${routeLabel(item.roadMetrics)}<small>直線 ${item.distance.toFixed(1)} 公里</small></span></div><div class="spot-badges">${hits}</div>${warning}<div class="day-actions"><a href="${mainRouteLink}" target="_blank" rel="noopener">Google 導航 ↗</a><button type="button" data-action="food" data-id="${escapeHtml(item.spot.id)}">附近美食</button><button type="button" data-action="attractions" data-id="${escapeHtml(item.spot.id)}">附近景點</button><button type="button" data-action="details" data-id="${escapeHtml(item.spot.id)}">泊點資訊</button></div><section class="day-plan-section"><h4>備援泊點（最近三個）</h4><ol class="backup-list">${backupRows}</ol></section><section class="day-plan-section"><h4>行程里程與三餐推薦</h4>${foodTable}</section><section class="day-plan-section"><h4>附近景點</h4><ul class="nearby-attraction-list">${attractionRows}</ul></section></div></article>`;
    }).join("");
    const plannedNights = details.destinationPlan ? details.nights : details.days;
    const omitted = items.length < plannedNights ? `<p class="plan-warning">找到 ${items.length} 個不重複泊點，少於需求的 ${plannedNights} 夜；可更改目的地或起點。</p>` : "";
    const needsLine = details.needs ? `<span>需求：${escapeHtml(details.needs.slice(0, 90))}</span>` : `<span>偏好：${escapeHtml(prefText || "未指定")}</span>`;
    const loadingDirectory = options.loadingData ? `<p class="plan-progress">正在載入推薦美食與附近景點…</p>` : "";
    const directoryNotice = options.directoryError ? `<p class="plan-warning">部分官方美食或景點目錄暫時無法載入，其他行程資訊仍可查看。</p>` : "";
    const mealNotice = `<p class="form-disclaimer">三餐清單會依餐點類型篩選，冰品、甜點和飲料店不列入正餐；早餐優先列早餐店、早午餐和常見早餐餐點，其他店家會註明餐點供應尚未確認。營業時段與菜單仍請出發前確認。</p>`;
    const routeNotice = options.routeStatus === "loading" && !options.loadingData
      ? `<p class="plan-progress">正在計算行車里程與時間…</p>`
      : options.routeStatus === "unavailable" ? `<p class="plan-warning">道路距離服務暫不可用；可開啟導航查看即時路線與時間。行車資料由 <a href="https://project-osrm.org/" target="_blank" rel="noopener">OSRM</a> 依 <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> 道路網估算，不含即時路況。</p>`
        : options.routeStatus === "ready" ? `<p class="form-disclaimer">行車里程與時間由 <a href="https://project-osrm.org/" target="_blank" rel="noopener">OSRM</a> 依 <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> 道路資料估算，不含即時路況；泊點與景點直線距離為座標計算。出發前請用導航確認路況、開放狀態及車泊規定。</p>` : "";
    const tripTitle = details.destinationPlan ? `${details.days} 天 ${details.nights} 夜行程建議` : `${details.days} 天車宿建議`;
    root.innerHTML = `<div class="trip-summary"><strong>${tripTitle}</strong><span>起點：${escapeHtml(details.startLabel)}<br>${needsLine}</span></div>${omitted}${details.exceeded && !omitted ? `<p class="plan-warning">部分日程超過距離上限，請檢查 Google 道路導航里程。</p>` : ""}${loadingDirectory}${directoryNotice}${routeNotice}${mealNotice}${dayCards}`;
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
    $("#tripAdjustmentForm").addEventListener("submit", submitTripAdjustment);
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
    $("#locateButton").addEventListener("click", () => locateNearby().catch(error => notify(error.message)));
    $("#loadMore").addEventListener("click", () => { visibleCount += PAGE_SIZE; renderSpots(); });
    $("#spotList").addEventListener("click", event => {
      const button = event.target.closest("[data-action]");
      if (button) handleSpotAction(button.dataset.action, button.dataset.id);
    });
    $("#itinerary").addEventListener("click", event => {
      const replaceButton = event.target.closest("[data-replace-overnight-day]");
      if (replaceButton) {
        replacePlannedOvernightSpot(Number(replaceButton.dataset.replaceOvernightDay), replaceButton.dataset.replaceOvernightSpot);
        return;
      }
      const button = event.target.closest("[data-action]");
      if (button) handleSpotAction(button.dataset.action, button.dataset.id);
    });
    $("#routeSchedule").addEventListener("submit", event => {
      const form = event.target.closest("[data-trip-stop-edit]");
      if (!form) return;
      event.preventDefault();
      applyTripStopEdit(form);
    });
    $("#routeSchedule").addEventListener("click", event => {
      const removeButton = event.target.closest("[data-trip-stop-remove]");
      if (removeButton) {
        removeTripStop(Number(removeButton.dataset.day), Number(removeButton.dataset.leg));
        return;
      }
      const moveButton = event.target.closest("[data-trip-stop-move]");
      if (moveButton) moveTripStop(Number(moveButton.dataset.day), Number(moveButton.dataset.leg), Number(moveButton.dataset.delta));
    });
    $("#routeSchedule").addEventListener("change", event => {
      const input = event.target.closest("[data-trip-departure-time]");
      if (!input) return;
      const match = input.value.match(/^(\d{2}):(\d{2})$/u);
      const day = activeTripScheduleDays.find(item => item.day === Number(input.dataset.tripDepartureTime));
      if (!match || !day) return;
      day.departureMinute = Number(match[1]) * 60 + Number(match[2]);
      refreshTripScheduleMealOptions(day);
      renderTripSchedule(activeTripScheduleDays, { routeStatus: activeTripRouteError ? "unavailable" : "ready" });
    });
    $("#mapExpand").addEventListener("click", () => {
      const card = $(".map-card");
      card.classList.toggle("expanded");
      $("#mapExpand").textContent = card.classList.contains("expanded") ? "縮小地圖" : "展開地圖";
      setTimeout(() => map?.invalidateSize(), 220);
    });
    $("#mapRetry").addEventListener("click", loadMapBackground);
    $("#startLocationInput").addEventListener("input", () => {
      const status = $("#startLocationStatus");
      status.textContent = $("#startLocationInput").value.trim()
        ? "自訂起點會優先於下方選項；座標可以不連線直接使用。"
        : "輸入地名會由 Photon（OpenStreetMap）查詢座標；也可直接輸入緯度, 經度。";
    });
    $("#planForm").addEventListener("submit", async event => {
      event.preventDefault();
      $("#planExportToolbar").hidden = true;
      parseRequirementsFromText();
      const startQuery = $("#startLocationInput").value.trim();
      const routeRequest = parseTripRouteRequest($("#needsInput").value, Number($("#daysInput").value) || 3);
      let manualStart = null;
      let resolvedRouteDays = null;
      const submitButton = event.currentTarget.querySelector("button[type='submit']");
      try {
        if (startQuery) {
          submitButton.disabled = true;
          $("#startLocationStatus").textContent = "正在查詢輸入的起點…";
          manualStart = await resolveTripStartLocation(startQuery);
          $("#startLocationStatus").textContent = `起點解析為：${manualStart.label}（${manualStart.lat.toFixed(5)}, ${manualStart.lon.toFixed(5)}）`;
        } else if (routeRequest?.originBoundary && $("#startSpot").value === "current") {
          submitButton.disabled = true;
          $("#startLocationStatus").textContent = `依旅程描述查詢起點：${routeRequest.originBoundary.shortName}…`;
          manualStart = await resolveTripStartLocation(routeRequest.originBoundary.shortName);
          $("#startLocationStatus").textContent = `起點解析為：${manualStart.label}（${manualStart.lat.toFixed(5)}, ${manualStart.lon.toFixed(5)}）`;
        }
        if (!manualStart && $("#startSpot").value === "current" && !userPosition) {
          submitButton.disabled = true;
          await locateUser();
        }
        if (routeRequest) {
          const selectedSpot = $("#startSpot").value === "current" ? null : getSpot($("#startSpot").value);
          const tripOrigin = manualStart || (selectedSpot
            ? { lat: Number(selectedSpot.lat), lon: Number(selectedSpot.lon), label: selectedSpot.name }
            : userPosition ? { ...userPosition, label: "目前位置" } : null);
          if (!tripOrigin) throw new Error("請先輸入起點、選擇泊點或允許定位，再規劃返程路線。");
          const destinations = await Promise.all(routeRequest.days.map(async day => {
            if (day.returnsToStart) return { destinationPoint: { lat: tripOrigin.lat, lon: tripOrigin.lon }, destinationName: tripOrigin.label };
            if (day.destinationBoundary) {
              const place = await resolveTripStartLocation(day.destinationBoundary.shortName);
              return { destinationPoint: { lat: place.lat, lon: place.lon }, destinationName: place.label };
            }
            return null;
          }));
          let previousDestination = null;
          resolvedRouteDays = routeRequest.days.map((day, index) => {
            const destination = destinations[index];
            if (destination) previousDestination = destination;
            const resolved = destination || previousDestination;
            if (!resolved) throw new Error(`第 ${day.day} 天找不到目的地，請在描述中補上縣市或地名。`);
            return { ...day, ...resolved, returnsToStart: day.returnsToStart || resolved.destinationPoint.lat === tripOrigin.lat && resolved.destinationPoint.lon === tripOrigin.lon };
          });
        }
      } catch (error) {
        $("#startLocationStatus").textContent = error.message;
        notify(error.message);
        return;
      } finally {
        submitButton.disabled = false;
      }
      planTrip(manualStart, routeRequest, resolvedRouteDays);
    });
    $("#exportTripPngButton").addEventListener("click", exportTripPlanPng);
    $("#foodSpotSelect").addEventListener("change", handleFoodSpotChange);
    $("#foodRadius").addEventListener("change", searchFood);
    $("#locateFoodButton").addEventListener("click", locateAndSearchFood);
    $("#searchFoodButton").addEventListener("click", searchFood);
    $("#attractionSpotSelect").addEventListener("change", () => showAttractionStatus("已選擇搜尋中心", "按下搜尋附近景點開始查詢。"));
    $("#searchAttractionsButton").addEventListener("click", searchNearbyAttractions);
    $("#locateAttractionsButton").addEventListener("click", locateAndSearchAttractions);
    $("#toggleSavedAttractionsButton").addEventListener("click", toggleSavedAttractionsView);
    $("#attractionResults").addEventListener("click", event => {
      const button = event.target.closest("[data-attraction-save]");
      if (button) toggleSavedAttraction(button);
    });
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
      const spot = getPlannedSpot(button.dataset.id);
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
    updateSavedAttractionsButton();
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
