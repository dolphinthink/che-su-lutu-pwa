#!/usr/bin/env python3
"""Build a compact nearby-attractions fallback from official daily data."""

from __future__ import annotations

import io
import json
import urllib.request
import zipfile
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE_URL = "https://media.taiwan.net.tw/XMLReleaseAll_public/v2.0/Zh_tw/Attraction-json.zip"
SOURCE_ARCHIVE = ROOT / "site" / "data" / "attraction-source.zip"
OUTPUT_FILE = ROOT / "site" / "data" / "attraction-directory.json"


def as_text(value: object, limit: int = 240) -> str:
    if isinstance(value, str):
        return " ".join(value.split())[:limit]
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
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.read()


archive_bytes = SOURCE_ARCHIVE.read_bytes() if SOURCE_ARCHIVE.exists() else download_archive()
with zipfile.ZipFile(io.BytesIO(archive_bytes)) as archive:
    source = json.loads(archive.read("AttractionList.json").decode("utf-8-sig"))

source_rows = source.get("Attractions", []) if isinstance(source, dict) else []
points = []
for row in source_rows:
    if int(row.get("IsPublicAccess") or 0) != 1:
        continue
    try:
        lat = float(row.get("PositionLat"))
        lon = float(row.get("PositionLon"))
    except (TypeError, ValueError):
        continue
    name = as_text(row.get("AttractionName"), 120)
    if not name or not (21 <= lat <= 26.5 and 118 <= lon <= 123.5):
        continue

    postal = row.get("PostalAddress") if isinstance(row.get("PostalAddress"), dict) else {}
    telephones = row.get("Telephones") if isinstance(row.get("Telephones"), list) else []
    phone = as_text((telephones[0] or {}).get("Tel"), 40) if telephones and isinstance(telephones[0], dict) else ""
    attraction_id = as_text(row.get("AttractionID"), 100)
    point = {
        "id": attraction_id or f"attraction-{len(points) + 1}",
        "name": name,
        "lat": lat,
        "lon": lon,
        "city": as_text(postal.get("City"), 40),
        "town": as_text(postal.get("Town"), 40),
        "address": as_text(postal.get("StreetAddress"), 120),
        "phone": phone,
        "opening": as_text(row.get("ServiceTimeInfo"), 240),
        "fee": as_text(row.get("FeeInfo"), 160),
        "website": as_text(row.get("WebsiteURL"), 300),
    }
    points.append(point)

points.sort(key=lambda item: item["name"])
result = {
    "source": {
        "publisher": "交通部觀光署",
        "title": "景點－觀光資訊資料庫",
        "url": "https://data.gov.tw/dataset/7777",
        "downloadUrl": SOURCE_URL,
        "license": "政府資料開放授權條款－第 1 版",
        "retrievedOn": date.today().isoformat(),
        "sourceUpdateTime": as_text(source.get("UpdateTime"), 40) if isinstance(source, dict) else "",
        "note": "提供有公開參觀標記及臺灣座標的景點；資料可能不完整或延遲更新。距離為直線估算，開放、費用及道路狀況請出發前向官方確認。",
    },
    "counts": {"sourceRecords": len(source_rows), "publicTaiwanPoints": len(points)},
    "points": points,
}

OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
OUTPUT_FILE.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
print(f"Built {len(points)} public Taiwan attractions from {len(source_rows)} tourism records ({OUTPUT_FILE.stat().st_size:,} bytes).")
