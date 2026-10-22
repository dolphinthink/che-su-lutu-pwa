#!/usr/bin/env python3
"""Create the small nearby-food index from the Tourism Administration JSON archive."""

from __future__ import annotations

import io
import json
import urllib.request
import zipfile
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE_URL = "https://media.taiwan.net.tw/XMLReleaseAll_public/v2.0/Zh_tw/Restaurant-json.zip"
SOURCE_ARCHIVE = ROOT / "site" / "data" / "restaurant-source.zip"
OUTPUT_FILE = ROOT / "site" / "data" / "restaurant-directory.json"


def as_text(value: object) -> str:
    if isinstance(value, str):
        return " ".join(value.split())
    if isinstance(value, (int, float)):
        return str(value)
    return ""


def download_archive() -> bytes:
    request = urllib.request.Request(
        SOURCE_URL,
        headers={
            "User-Agent": "CheSuLuTuPWA/1.0 (+https://che-su-lutu-pwa.pages.dev/)",
            "Accept": "application/zip, application/octet-stream;q=0.9, */*;q=0.8",
        },
    )
    with urllib.request.urlopen(request, timeout=45) as response:
        return response.read()


archive_bytes = SOURCE_ARCHIVE.read_bytes() if SOURCE_ARCHIVE.exists() else download_archive()
with zipfile.ZipFile(io.BytesIO(archive_bytes)) as archive:
    source = json.loads(archive.read("RestaurantList.json").decode("utf-8-sig"))

source_rows = source.get("Restaurants", []) if isinstance(source, dict) else []
points = []
for row in source_rows:
    try:
        lat = float(row.get("PositionLat"))
        lon = float(row.get("PositionLon"))
    except (TypeError, ValueError):
        continue
    name = as_text(row.get("RestaurantName"))
    if not name or not (21 <= lat <= 26.5 and 118 <= lon <= 123.5):
        continue

    postal = row.get("PostalAddress") if isinstance(row.get("PostalAddress"), dict) else {}
    telephones = row.get("Telephones") if isinstance(row.get("Telephones"), list) else []
    phone = as_text((telephones[0] or {}).get("Tel")) if telephones and isinstance(telephones[0], dict) else ""
    point = {
        "id": as_text(row.get("RestaurantID")),
        "name": name,
        "lat": lat,
        "lon": lon,
        "city": as_text(postal.get("City")),
        "town": as_text(postal.get("Town")),
        "address": as_text(postal.get("StreetAddress")),
        "phone": phone,
        "opening": as_text(row.get("ServiceTimeInfo")),
    }
    if not point["id"]:
        point["id"] = f"restaurant-{len(points) + 1}"
    points.append(point)

points.sort(key=lambda item: item["name"])
result = {
    "source": {
        "publisher": "交通部觀光署",
        "title": "餐飲－觀光資訊資料庫",
        "url": "https://data.gov.tw/dataset/7779",
        "downloadUrl": SOURCE_URL,
        "license": "政府資料開放授權條款－第 1 版",
        "retrievedOn": date.today().isoformat(),
        "sourceUpdateTime": as_text(source.get("UpdateTime")) if isinstance(source, dict) else "",
        "note": "這是觀光署登錄的餐飲地點目錄；不保證涵蓋所有餐廳、即時營業狀態或最新評價。距離以直線估算，Google 地圖連結可查看介紹與評價。",
    },
    "counts": {"sourceRecords": len(source_rows), "withTaiwanCoordinates": len(points)},
    "points": points,
}

OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
OUTPUT_FILE.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
print(f"Built {len(points)} Taiwan dining points from {len(source_rows)} tourism records ({OUTPUT_FILE.stat().st_size:,} bytes).")
