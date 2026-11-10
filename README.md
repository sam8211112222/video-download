# VDD Video Downloader

直接在 Chrome / Safari 下載正在看的影片、影片封面和照片（Instagram 貼文 / Reels / 限時動態、Threads 等），不經過第三方網站。
Download the videos, video covers and photos you are viewing in Chrome / Safari (Instagram posts / Reels / Stories, Threads, and more) without any third-party website.

檔案依帳號分資料夾存放，例如 `~/Downloads/VDD Videos/irisliang__/`；同一個帳號的影片、封面、照片都在同一個資料夾。抓不到帳號名稱時（例如一般網站），直接放在 `VDD Videos/` 底下。
Files are sorted into one folder per account, e.g. `~/Downloads/VDD Videos/irisliang__/`; a person's videos, covers and photos all go in the same folder. When no account name can be found (e.g. generic sites), files go straight into `VDD Videos/`.

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
3. 滑鼠移到影片上會出現 **Video**（影片）和 **Cover**（封面）；移到照片上會出現 **Image**。快捷鍵：`⌥⇧D` 下載影片，`⌥⇧I` 下載照片或封面。
   Hover a video for **Video** and **Cover** buttons, or a photo for an **Image** button. Keys: `⌥⇧D` video, `⌥⇧I` photo or cover.

### 2b. Safari

1. helper 開著時打開 <http://127.0.0.1:17723/>。/ With the helper running, open <http://127.0.0.1:17723/>.
2. 把 **⬇ VDD Video** 和 **🖼 VDD Image** 兩個按鈕拖到「喜好項目列」(⇧⌘B)。/ Drag the **⬇ VDD Video** and **🖼 VDD Image** buttons to the Favorites Bar (⇧⌘B).
3. Safari 設定 → 進階 → 勾選「顯示網頁開發者功能」，再到「開發 → 開發者設定…」開啟「允許來自智慧型搜尋欄位的 JavaScript」。
   Safari Settings → Advanced → "Show features for web developers", then Develop → Developer Settings… → enable "Allow JavaScript from Smart Search Field".
4. **⬇ VDD Video** 下載畫面上的影片；**🖼 VDD Image** 下載畫面上的照片，若畫面上是影片則下載它的封面。
   **⬇ VDD Video** downloads the video on screen; **🖼 VDD Image** downloads the photo on screen, or the cover if a video is showing.

## 檔案 / Files

- `extension/` — Chrome 擴充功能 / Chrome extension (`resolve.js` 也用於 Safari 書籤 / also used by the Safari bookmarklet)
- `server/vdd_server.py` — 本機 helper，只聽 127.0.0.1:17723 / Local helper, listens on 127.0.0.1:17723 only
- `Start VDD.command`, `install-autostart.sh` — 啟動方式 / Launchers

## 疑難排解 / Troubleshooting

- 按鈕沒出現：擴充功能安裝或更新後要重新整理頁面。/ No button: reload the page after installing or updating the extension.
- IG 失敗：確認在同一個瀏覽器已登入 IG。IG 改版時可能需要更新 `resolve.js`。/ IG fails: make sure you are logged in to IG in that browser. IG changes may require updating `resolve.js`.
- 照片貼文按 Video 會提示改用 Image，不會再丟給 yt-dlp。/ Pressing Video on a photo post now tells you to use Image instead of sending it to yt-dlp.
- Threads 的影片封面來自貼文的 og:image，最大約 640px。IG 的封面則是原尺寸。/ Threads video covers come from the post's og:image (about 640px max); IG covers are full size.
- yt-dlp 失敗：重新啟動 `Start VDD.command`（會自動更新 yt-dlp）。/ yt-dlp fails: restart `Start VDD.command` (it updates yt-dlp).

請只下載你有權保存的內容，並尊重創作者（尤其是私人帳號）的隱私，不要再散布。
Only download content you have the right to keep, and respect creators' privacy (especially private accounts) — don't redistribute it.
