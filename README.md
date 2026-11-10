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

### 2b. Safari（快捷鍵 / keyboard shortcuts）

1. 安裝快捷鍵（只要一次）/ Install the shortcuts (once):
   ```bash
   ./install-safari-shortcuts.sh
   ```
2. Safari 設定 → 進階 → 勾選「顯示網頁開發者功能」，再到「開發」選單勾選「允許來自 Apple Events 的 JavaScript」。
   Safari Settings → Advanced → "Show features for web developers", then Develop menu → "Allow JavaScript from Apple Events".
3. 在 IG / Threads 頁面按：/ On an IG / Threads page press:
   - `⌥⇧D` 下載畫面上的影片 / download the video on screen
   - `⌥⇧I` 下載畫面上的照片，或影片的封面 / download the photo on screen, or the video's cover
4. 第一次使用時 macOS 會詢問是否允許控制 Safari，按「好」。/ The first time, macOS asks to allow controlling Safari: click OK.

也可以從 Safari 選單 → 服務 執行。移除：`./install-safari-shortcuts.sh --remove`
Also available in Safari menu → Services. Remove with `./install-safari-shortcuts.sh --remove`.

不想用快捷鍵的話，也可以從 <http://127.0.0.1:17723/> 把書籤拖到喜好項目列（需開啟「允許來自智慧型搜尋欄位的 JavaScript」）。
Alternatively, drag the bookmarklets from <http://127.0.0.1:17723/> to the Favorites Bar (needs "Allow JavaScript from Smart Search Field").

## 檔案 / Files

- `extension/` — Chrome 擴充功能 / Chrome extension (`resolve.js` 也用於 Safari 書籤 / also used by the Safari bookmarklet)
- `server/vdd_server.py` — 本機 helper，只聽 127.0.0.1:17723 / Local helper, listens on 127.0.0.1:17723 only
- `Start VDD.command`, `install-autostart.sh` — 啟動方式 / Launchers
- `install-safari-shortcuts.sh`, `safari/` — Safari 快捷鍵 / Safari keyboard shortcuts

## 疑難排解 / Troubleshooting

- 按鈕沒出現，或出現「Extension context invalidated」：重新整理頁面（⌘R）。1.3.1 起更新後會自動注入已開的分頁，通常不需要。/ No button, or "Extension context invalidated": reload the page (⌘R). From 1.3.1, updates are injected into open tabs automatically, so this is rarely needed.
- IG 失敗：確認在同一個瀏覽器已登入 IG。IG 改版時可能需要更新 `resolve.js`。/ IG fails: make sure you are logged in to IG in that browser. IG changes may require updating `resolve.js`.
- 照片貼文按 Video 會提示改用 Image，不會再丟給 yt-dlp。/ Pressing Video on a photo post now tells you to use Image instead of sending it to yt-dlp.
- Threads 登入後影片常以串流（blob）播放：VDD 會從播放器資料取得原始 mp4；若只有分開的影像與聲音軌，會由 helper 用 ffmpeg 合併（需要 helper 在執行）。Threads 不會再交給 yt-dlp（它不支援 Threads）。
  When logged in, Threads often plays videos as a stream (blob): VDD reads the original MP4 from the player data; if there are only separate video and audio tracks, the helper joins them with ffmpeg (the helper must be running). Threads is never sent to yt-dlp (it does not support Threads).
- 「與 QuickTime 不相容」：經過 helper 的影片會自動檢查格式，VP9 / AV1 / Opus 等 Mac 不支援的格式會轉成 H.264 + AAC。/ "Not compatible with QuickTime": videos that go through the helper are checked, and VP9 / AV1 / Opus are converted to H.264 + AAC.
- Threads 的影片封面來自貼文的 og:image，最大約 640px。IG 的封面則是原尺寸。/ Threads video covers come from the post's og:image (about 640px max); IG covers are full size.
- yt-dlp 失敗：重新啟動 `Start VDD.command`（會自動更新 yt-dlp）。/ yt-dlp fails: restart `Start VDD.command` (it updates yt-dlp).

請只下載你有權保存的內容，並尊重創作者（尤其是私人帳號）的隱私，不要再散布。
Only download content you have the right to keep, and respect creators' privacy (especially private accounts) — don't redistribute it.
