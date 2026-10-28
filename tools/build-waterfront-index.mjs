import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(fileURLToPath(new URL("..", import.meta.url)));
const sourceFile = join(repo, "site", "data", "spots.json");
const outputFile = join(repo, "site", "data", "waterfront-points.json");
const spots = JSON.parse(await readFile(sourceFile, "utf8"));

const rules = [
  ["sea", /海灘|沙灘|海邊|海岸|濱海|海濱|海水浴|漁港|海港|漁村|漁民廣場|漁人碼頭|漁光島|沙丘|潮間帶|海口|海濱公園/u],
  ["river", /河濱|河岸|河堤|河邊|河口|河川|水岸|堤防|提防|青龍岸/u],
  ["creek", /溪|瀑布|親水/u]
];
const waterLabel = { sea: "海邊／海岸", river: "河邊／河岸", creek: "溪邊／溪谷" };
const officialSources = [
  {
    match: /白沙灣/u,
    url: "https://media.taiwan.net.tw/en-us/portal/travel/details/attraction_a15011000h_000014",
    title: "交通部觀光署：白沙灣水域遊憩區",
    accessEvidence: "官方資料標示位於臺2線沿線；停車場欄位未列內容，請現場確認停車位置及限制。"
  },
  {
    match: /金沙灣/u,
    url: "https://media.taiwan.net.tw/zh-tw/portal/travel/details/attraction_a15011300h_000059",
    title: "交通部觀光署：金沙灣海濱公園",
    accessEvidence: "官方介紹提及濱海公路旁及園區停車場；實際停車位置、開放及車宿規則請現場確認。"
  },
  {
    match: /磯崎/u,
    url: "https://www.eastcoast-nsa.gov.tw/zh-tw/attractions/detail/6/",
    title: "東部海岸國家風景區：磯崎海濱遊憩區",
    accessEvidence: "官方介紹指出海濱休憩區旁設有停車場並連接臺11線；景點入口至水岸仍依現場動線。"
  },
  {
    match: /內埤/u,
    url: "https://media.taiwan.net.tw/en-us/portal/travel/details/attraction_a15011300h_010092",
    title: "交通部觀光署：內埤海灘",
    accessEvidence: "官方頁提供地點資料但未列停車資訊；請先確認附近停車與步行動線。"
  }
];

function classify(name) {
  if (/溪頭|溪州/u.test(name)) return null;
  return rules.find(([, pattern]) => pattern.test(name))?.[0] || null;
}

const pointsById = new Map();
for (const spot of spots) {
  const waterType = classify(String(spot.name || ""));
  if (!waterType) continue;
  const official = officialSources.find(source => source.match.test(spot.name));
  pointsById.set(spot.id, {
    ...spot,
    category: "waterfront",
    waterType,
    waterLabel: waterLabel[waterType],
    sourceType: "vehicle-stay-map",
    accessEvidence: official?.accessEvidence || "沿用公開地圖標註座標；此座標只代表點位附近，不保證車輛能直達水岸、可停車或可過夜。",
    ...(official ? { officialSourceUrl: official.url, officialSourceTitle: official.title } : {})
  });
}

const officialPlaces = [
  {
    id: "waterfront-tourism-huazhong-riverside",
    name: "華中河濱公園",
    lat: 25.0154,
    lon: 121.49476,
    county: "臺北市",
    category: "waterfront",
    waterType: "river",
    waterLabel: waterLabel.river,
    sourceType: "official-tourism-open-data",
    overnightEligible: false,
    accessEvidence: "交通部觀光署公開資料指出，華中一號門、二號門入口設有停車場；進入河岸步道仍依現場動線，該景點資料不代表開放車宿。",
    officialSourceUrl: "https://media.taiwan.net.tw/zh-tw/portal/travel/details/attraction_379000000a_000226",
    officialSourceTitle: "交通部觀光署：華中河濱公園"
  },
  {
    id: "waterfront-tourism-baishawan",
    name: "白沙灣水域遊憩區",
    lat: 25.28422,
    lon: 121.5179,
    county: "新北市",
    category: "waterfront",
    waterType: "sea",
    waterLabel: waterLabel.sea,
    sourceType: "official-tourism-open-data",
    overnightEligible: false,
    accessEvidence: "交通部觀光署公開資料標示位於臺2線沿線；停車場欄位未列內容，請現場確認停車位置及限制。此景點資料不代表開放車宿。",
    officialSourceUrl: "https://media.taiwan.net.tw/en-us/portal/travel/details/attraction_a15011000h_000014",
    officialSourceTitle: "交通部觀光署：白沙灣水域遊憩區"
  }
];

for (const point of officialPlaces) {
  const duplicate = [...pointsById.values()].find(item => {
    const dLat = (item.lat - point.lat) * 111;
    const dLon = (item.lon - point.lon) * 101;
    return Math.hypot(dLat, dLon) < 0.12;
  });
  if (!duplicate) pointsById.set(point.id, point);
}

const points = [...pointsById.values()].sort((a, b) => a.name.localeCompare(b.name, "zh-Hant"));
const output = {
  source: {
    fetchedOn: "2026-10-22",
    mapSourceTitle: "公開總圖泊點標註",
    mapSourceUrl: "https://www.google.com/maps/d/viewer?mid=1Q3JWYBEf6JQC8M4ei6cEojTesjg",
    officialSourceTitle: "交通部觀光署觀光多媒體開放資料",
    officialPortalUrl: "https://media.taiwan.net.tw/zh-tw/portal/travel?Tab=Attraction",
    attribution: "觀光資料依政府資料開放授權條款提供；頁面保留原資料機關與來源連結。",
    note: "依公開泊點名稱關鍵字整理溪、河、海周邊位置，並新增有官方座標的水岸景點。分類僅表示名稱或官方介紹與水域相鄰，不代表可下水、車輛直達岸邊、可停車或允許過夜。"
  },
  counts: {
    total: points.length,
    sea: points.filter(item => item.waterType === "sea").length,
    river: points.filter(item => item.waterType === "river").length,
    creek: points.filter(item => item.waterType === "creek").length,
    official: points.filter(item => item.sourceType === "official-tourism-open-data").length
  },
  points
};

await writeFile(outputFile, `${JSON.stringify(output, null, 2)}\n`, "utf8");
console.log(`Built ${points.length} water-adjacent points: ${JSON.stringify(output.counts)}`);
