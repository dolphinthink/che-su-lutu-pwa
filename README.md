# 車宿旅圖 GitHub Pages 部署包

此儲存庫僅供發布 PWA。網站檔案位於 `site/`；GitHub Actions 會在推送至 `main` 時部署。

## GitHub Pages 設定

在 Repository Settings → Pages → Build and deployment，將 Source 設為 **GitHub Actions**。

## 公開內容

GitHub Pages 網站與 `site/data/` 中的 JSON 資料可由網際網路公開讀取。請勿在此儲存庫放入密碼、存取權杖或私人資料。

## 更新網站

將目前專案的 `index.html`、`app.js`、`styles.css`、`sw.js`、`manifest.webmanifest`、`assets/`、`data/` 同步到 `site/`，提交並推送至 `main`。部署狀態可在 Actions 頁面查看。

## 泊點縣市搜尋

`site/data/spots.json` 的 `county` 欄位由泊點座標對應至內政部國土測繪中心縣市界線，供離線搜尋縣市名稱使用。來源為[政府資料開放平臺縣市界線資料集](https://data.gov.tw/dataset/7442)，依政府資料開放授權條款第 1 版釋出。若重建縣市欄位，取得 WGS84 GeoJSON 後執行：

```powershell
node tools/enrich-spot-counties.mjs ..\data\tw-counties.geojson ..\data\spots.json site\data\spots.json
```
