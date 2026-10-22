# 車宿旅圖 GitHub Pages 部署包

此儲存庫僅供發布 PWA。網站檔案位於 `site/`；GitHub Actions 會在推送至 `main` 時部署。

## GitHub Pages 設定

在 Repository Settings → Pages → Build and deployment，將 Source 設為 **GitHub Actions**。

## 公開內容

GitHub Pages 網站與 `site/data/` 中的 JSON 資料可由網際網路公開讀取。請勿在此儲存庫放入密碼、存取權杖或私人資料。

## 更新網站

將目前專案的 `index.html`、`app.js`、`styles.css`、`sw.js`、`manifest.webmanifest`、`assets/`、`data/` 同步到 `site/`，提交並推送至 `main`。部署狀態可在 Actions 頁面查看。

## Cloudflare Pages 美食查詢

Pages Functions 位於儲存庫根目錄的 `functions/`，靜態網站輸出位於 `site/`。從儲存庫根目錄執行 Wrangler 部署，讓 Wrangler 同時讀取輸出資料夾與 Pages Functions：

```powershell
npx wrangler pages deploy site --project-name=che-su-lutu-pwa --branch=main
```

附近美食 API 會查詢 OpenStreetMap Overpass 公共服務，並使用 Cloudflare Cache API 暫存成功結果一小時；若公開服務皆無回應，頁面會顯示本機先前查詢資料或 Google 地圖搜尋連結。

## 泊點縣市搜尋

`site/data/spots.json` 的 `county` 欄位由泊點座標對應至內政部國土測繪中心縣市界線，供離線搜尋縣市名稱使用。來源為[政府資料開放平臺縣市界線資料集](https://data.gov.tw/dataset/7442)，依政府資料開放授權條款第 1 版釋出。若重建縣市欄位，取得 WGS84 GeoJSON 後執行：

```powershell
node tools/enrich-spot-counties.mjs ..\data\tw-counties.geojson ..\data\spots.json site\data\spots.json
```
