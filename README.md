# VDD Video Downloader

直接在 Chrome / Safari 下載正在看的影片（Instagram 貼文 / Reels / 限時動態、Threads 等），不經過第三方網站。
Download the videos you are watching in Chrome / Safari (Instagram posts / Reels / Stories, Threads, and more) without any third-party website.

影片儲存在 `~/Downloads/VDD Videos`。
Videos are saved to `~/Downloads/VDD Videos`.

## 運作方式 / How it works

| 網站 / Site | 方式 / Method |
|---|---|
| Threads | 頁面上的 `<video>` 就是 mp4，直接下載 / The page's `<video>` is a plain MP4, downloaded directly |
| Instagram 貼文、Reels、限時動態 / posts, Reels, Stories | 用你**已登入**的 IG 連線呼叫 IG 網頁 API，取得原始 mp4（含聲音）/ Uses your **logged-in** IG session to call IG's web API for the original MP4 (with audio) |
| 其他網站 (YouTube, X, Facebook…) / Other sites | 交給本機的 yt-dlp / Handed to local yt-dlp |

私人帳號的限時動態：只要你已登入並且有追蹤該帳號（看得到），就能下載。
Private-account Stories: works whenever you are logged in and follow that account (i.e. you can already see them).

## 安裝 / Setup

### 1. 本機 helper（建議一直開著）/ Local helper (keep it running)

雙擊 `Start VDD.command`。第一次會自動安裝 yt-dlp。
Double-click `Start VDD.command`. The first run installs yt-dlp.

想要開機自動啟動 / To start automatically at login:

```bash
./install-autostart.sh
```

Chrome 的 IG / Threads 下載不需要 helper；Safari 以及 yt-dlp 備援需要。
Chrome's IG / Threads downloads work without the helper; Safari and the yt-dlp fallback need it.

### 2a. Chrome

1. 打開 `chrome://extensions`，開啟「開發人員模式」。/ Open `chrome://extensions` and turn on Developer mode.
2. 「載入未封裝項目」→ 選 `VDD/extension` 資料夾。/ Click "Load unpacked" and choose the `VDD/extension` folder.
3. 把滑鼠移到影片上，點右上角的 **Download**，或按 `⌥⇧D`。/ Hover a video and click **Download**, or press `⌥⇧D`.

### 2b. Safari

1. helper 開著時打開 <http://127.0.0.1:17723/>。/ With the helper running, open <http://127.0.0.1:17723/>.
2. 把 **⬇ VDD Download** 按鈕拖到「喜好項目列」(⇧⌘B)。/ Drag the **⬇ VDD Download** button to the Favorites Bar (⇧⌘B).
3. Safari 設定 → 進階 → 勾選「顯示網頁開發者功能」，再到「開發 → 開發者設定…」開啟「允許來自智慧型搜尋欄位的 JavaScript」。
   Safari Settings → Advanced → "Show features for web developers", then Develop → Developer Settings… → enable "Allow JavaScript from Smart Search Field".
4. 影片在畫面上時，點喜好項目列的 **⬇ VDD Download**。/ With the video on screen, click **⬇ VDD Download** in the Favorites Bar.

## 檔案 / Files

- `extension/` — Chrome 擴充功能 / Chrome extension (`resolve.js` 也用於 Safari 書籤 / also used by the Safari bookmarklet)
- `server/vdd_server.py` — 本機 helper，只聽 127.0.0.1:17723 / Local helper, listens on 127.0.0.1:17723 only
- `Start VDD.command`, `install-autostart.sh` — 啟動方式 / Launchers

## 疑難排解 / Troubleshooting

- 按鈕沒出現：擴充功能安裝或更新後要重新整理頁面。/ No button: reload the page after installing or updating the extension.
- IG 失敗：確認在同一個瀏覽器已登入 IG。IG 改版時可能需要更新 `resolve.js`。/ IG fails: make sure you are logged in to IG in that browser. IG changes may require updating `resolve.js`.
- yt-dlp 失敗：重新啟動 `Start VDD.command`（會自動更新 yt-dlp）。/ yt-dlp fails: restart `Start VDD.command` (it updates yt-dlp).

請只下載你有權保存的內容，並尊重創作者（尤其是私人帳號）的隱私，不要再散布。
Only download content you have the right to keep, and respect creators' privacy (especially private accounts) — don't redistribute it.
