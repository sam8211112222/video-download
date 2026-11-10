#!/usr/bin/env python3
"""VDD local download server.

Runs only on 127.0.0.1. The Chrome extension and the Safari bookmarklet send it
either direct media URLs (downloaded as-is) or a page URL (handed to yt-dlp).
Files are saved to ~/Downloads/VDD Videos.
"""
import base64
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HOST = "127.0.0.1"
PORT = int(os.environ.get("VDD_PORT", "17723"))
DOWNLOAD_DIR = Path(os.environ.get("VDD_DIR", Path.home() / "Downloads" / "VDD Videos"))
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36")
HERE = Path(__file__).resolve().parent

JOBS = {}
JOBS_LOCK = threading.Lock()


# ---------------------------------------------------------------- helpers
def safe_name(name, fallback="video"):
    name = re.sub(r'[\\/:*?"<>|\x00-\x1f]+', "_", (name or "").strip())
    name = re.sub(r"\s+", " ", name).strip(" .")  # keep "_" (common in usernames)
    return (name or fallback)[:120]


def media_key(url):
    """What identifies the media itself, independent of size, codec or the
    expiring signature in the URL (must match vddMediaKey in resolve.js):
    Meta CDN videos carry xpv_asset_id in the base64 "efg" parameter; images
    keep the same file name across sizes; anything else uses the URL path."""
    parsed = urllib.parse.urlparse(url)
    efg = urllib.parse.parse_qs(parsed.query).get("efg")
    if efg:
        try:
            raw = efg[0].replace("-", "+").replace("_", "/")
            text = base64.b64decode(raw + "=" * (-len(raw) % 4)).decode("utf-8", "replace")
            # Same text-based read as resolve.js (JS would round ids above 2^53).
            m = re.search(r'"xpv_asset_id"\s*:\s*"?(\d+)', text)
            if m:
                return f"asset:{m.group(1)}"
        except (ValueError, TypeError):
            pass
    name = parsed.path.rsplit("/", 1)[-1]
    if re.search(r"\.(jpe?g|png|webp|heic|avif|gif)$", name, re.I):
        return "file:" + name.rsplit(".", 1)[0]
    return "url:" + parsed.netloc + parsed.path


def tagged_name(name, url):
    """e.g. yuxx.uana_DfCcSPuAauO_1a2b3c4d: the same media always gets the same
    name (so downloading it again replaces the old file), different media in
    one post get different names."""
    short = hashlib.sha1(media_key(url).encode()).hexdigest()[:8]
    return f"{safe_name(name)}_{short}"


def unique_path(base: Path) -> Path:
    if not base.exists():
        return base
    stem, suffix, i = base.stem, base.suffix, 2
    while (base.parent / f"{stem} ({i}){suffix}").exists():
        i += 1
    return base.parent / f"{stem} ({i}){suffix}"


def user_dir(user):
    """One folder per account, e.g. ~/Downloads/VDD Videos/irisliang__/."""
    folder = DOWNLOAD_DIR / safe_name(user) if user else DOWNLOAD_DIR
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def is_http(url):
    return isinstance(url, str) and url.lower().startswith(("http://", "https://"))


def is_local(url):
    host = (urllib.parse.urlparse(url).hostname or "").lower()
    return host in ("127.0.0.1", "localhost", "::1") or host.endswith(".localhost")


def notify(title, message):
    """macOS notification (best effort)."""
    if sys.platform != "darwin":
        return
    script = 'display notification {} with title {}'.format(
        json.dumps(message), json.dumps(title))
    subprocess.run(["osascript", "-e", script], capture_output=True)


def set_job(job_id, **kw):
    with JOBS_LOCK:
        JOBS.setdefault(job_id, {}).update(kw)


# ---------------------------------------------------------------- download
def download_direct(url, stem, referer, folder):
    """Saves url as folder/<stem>.<ext>, replacing an existing file of that name."""
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        **({"Referer": referer} if referer else {}),
    })
    with urllib.request.urlopen(req, timeout=60) as resp:
        ctype = resp.headers.get("Content-Type", "")
        ext = {
            "video/webm": ".webm", "video/quicktime": ".mov",
            "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp",
            "image/heic": ".heic", "image/gif": ".gif", "image/avif": ".avif",
        }.get(ctype.split(";")[0].strip().lower(), ".mp4")
        out = folder / f"{stem}{ext}"
        tmp = out.with_suffix(out.suffix + ".part")
        with open(tmp, "wb") as f:
            while True:
                chunk = resp.read(1 << 16)
                if not chunk:
                    break
                f.write(chunk)
        tmp.replace(out)
        return out


def find_tool(name):
    return shutil.which(name) or next(
        (p for p in (f"/opt/homebrew/bin/{name}", f"/usr/local/bin/{name}") if os.path.exists(p)), None)


VIDEO_EXT = {".mp4", ".mov", ".m4v", ".webm", ".mkv"}
MAC_VIDEO = {"h264", "hevc", "prores"}
MAC_AUDIO = {"aac", "mp3", "alac", "ac3", "eac3"}


def ensure_mac_playable(path):
    """Make sure QuickTime / Photos / iPhone can open the video.

    Meta's DASH streams and yt-dlp may give VP9 / AV1 video or Opus audio,
    which macOS reports as "not compatible". Those get converted to
    H.264 / AAC; HEVC only needs the hvc1 tag. Files already fine are untouched.
    """
    path = Path(path)
    ffprobe, ffmpeg = find_tool("ffprobe"), find_tool("ffmpeg")
    if path.suffix.lower() not in VIDEO_EXT or not ffprobe or not ffmpeg:
        return path
    r = subprocess.run([ffprobe, "-v", "error", "-show_entries",
                        "stream=codec_type,codec_name,codec_tag_string", "-of", "json", str(path)],
                       capture_output=True, text=True)
    try:
        streams = json.loads(r.stdout).get("streams") or []
    except ValueError:
        return path
    video = [s for s in streams if s.get("codec_type") == "video"]
    audio = [s for s in streams if s.get("codec_type") == "audio"]
    if not video:
        return path
    vcodec = video[0].get("codec_name")
    v_ok = vcodec in MAC_VIDEO
    a_ok = all(s.get("codec_name") in MAC_AUDIO for s in audio)
    hevc_retag = vcodec == "hevc" and video[0].get("codec_tag_string") != "hvc1"
    if v_ok and a_ok and not hevc_retag and path.suffix.lower() in (".mp4", ".mov", ".m4v"):
        return path

    tmp = path.with_name(path.stem + ".vdd-convert.mp4")
    cmd = [ffmpeg, "-y", "-loglevel", "error", "-i", str(path), "-map", "0:v:0", "-map", "0:a:0?"]
    if v_ok:
        cmd += ["-c:v", "copy"] + (["-tag:v", "hvc1"] if vcodec == "hevc" else [])
    else:
        cmd += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p"]
    cmd += ["-c:a", "copy"] if a_ok else ["-c:a", "aac", "-b:a", "192k"]
    cmd += ["-movflags", "+faststart", str(tmp)]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        tmp.unlink(missing_ok=True)
        raise RuntimeError("Could not convert to a Mac-compatible format: " + r.stderr[-300:])
    path.unlink()
    final = path.with_suffix(".mp4")
    tmp.replace(final)  # replaces an older download of the same media
    return final


def download_merge(video_url, audio_url, name, referer, folder):
    """Separate video + audio tracks (DASH) -> one MP4 via ffmpeg (no re-encode)."""
    ffmpeg = find_tool("ffmpeg")
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        stem = tagged_name(name, video_url)
        v = download_direct(video_url, "v", referer, tmp)
        if not audio_url:
            out = folder / f"{stem}{v.suffix}"
            shutil.move(str(v), out)
            return out
        a = download_direct(audio_url, "a", referer, tmp)
        if not ffmpeg:
            raise RuntimeError("ffmpeg is needed to join video and audio: brew install ffmpeg")
        out = folder / f"{stem}.mp4"
        r = subprocess.run([ffmpeg, "-y", "-loglevel", "error", "-i", str(v), "-i", str(a),
                            "-map", "0:v:0", "-map", "1:a:0", "-c", "copy", "-movflags", "+faststart",
                            str(out)], capture_output=True, text=True)
        if r.returncode != 0:
            raise RuntimeError("ffmpeg failed: " + r.stderr[-400:])
        return out


def download_ytdlp(page_url, cookies_txt, browser, user):
    import yt_dlp  # imported lazily so /ping works even if yt-dlp is broken

    # Folder per account: the username we were given, else what yt-dlp reports
    # (for Instagram "channel" is the username).
    folder = safe_name(user).replace("%", "%%") if user else "%(channel,uploader,uploader_id|Other)s"
    base_opts = {
        "outtmpl": str(DOWNLOAD_DIR) + "/" + folder + "/%(channel,uploader,id)s_%(id)s.%(ext)s",
        "format": "bv*[vcodec^=avc1]+ba[acodec^=mp4a]/b[vcodec^=avc1]/bv*+ba/b",
        "merge_output_format": "mp4",
        "noplaylist": False,
        "quiet": True,
        "no_warnings": True,
        "restrictfilenames": False,
        "windowsfilenames": True,
        "overwrites": True,  # re-downloading replaces the old file
    }
    attempts = [("no cookies", {})]
    cookie_file = None
    if cookies_txt:
        cookie_file = tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False)
        cookie_file.write(cookies_txt)
        cookie_file.close()
        attempts.insert(0, ("extension cookies", {"cookiefile": cookie_file.name}))
    if browser:
        attempts.append((f"{browser} cookies", {"cookiesfrombrowser": (browser,)}))

    errors = []
    try:
        for label, extra in attempts:
            files = []

            def hook(d):
                if d.get("status") == "finished" and d.get("info_dict"):
                    files.append(d["info_dict"].get("filepath") or d.get("filename"))

            opts = {**base_opts, **extra, "postprocessor_hooks": [hook]}
            try:
                with yt_dlp.YoutubeDL(opts) as ydl:
                    info = ydl.extract_info(page_url, download=True)
                if not files and info:
                    entries = info.get("entries") or [info]
                    for e in entries:
                        if e and e.get("requested_downloads"):
                            files += [r.get("filepath") for r in e["requested_downloads"]]
                return [Path(f) for f in files if f]
            except Exception as e:  # try next cookie source
                msg = str(e)
                if "Operation not permitted" in msg and "Cookies" in msg:
                    msg = ("macOS blocks reading Safari cookies (would need Full Disk Access); "
                           "log-in-only posts cannot use the yt-dlp fallback from Safari.")
                errors.append(f"[{label}] {msg}")
        raise RuntimeError("yt-dlp failed:\n" + "\n".join(errors))
    finally:
        if cookie_file:
            os.unlink(cookie_file.name)


def run_job(job_id, payload):
    set_job(job_id, status="running", started=time.time())
    try:
        DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)
        page = payload.get("pageUrl") or ""
        media = [u for u in (payload.get("mediaUrls") or []) if is_http(u)]
        name = payload.get("name") or "video"
        user = payload.get("user") or None
        files = []
        merge = payload.get("merge") or {}
        if is_http(merge.get("video")):
            audio = merge.get("audio") if is_http(merge.get("audio")) else None
            files = [download_merge(merge["video"], audio, name, page, user_dir(user))]
        elif media:
            folder = user_dir(user)
            for u in media:
                files.append(download_direct(u, tagged_name(name, u), page, folder))
        elif is_http(page) and is_local(page):
            raise ValueError("Open an Instagram or Threads post first, then use VDD there "
                             "(it was used on the VDD page itself).")
        elif is_http(page):
            files = download_ytdlp(page, payload.get("cookies"), payload.get("browser"), user)
        else:
            raise ValueError("No downloadable URL was provided.")
        if not files:
            raise RuntimeError("Nothing was downloaded.")
        files = [ensure_mac_playable(f) for f in files]
        set_job(job_id, status="done", files=[str(f) for f in files])
        notify("VDD downloaded", ", ".join(f.name for f in files))
    except Exception as e:
        set_job(job_id, status="error", error=str(e))
        notify("VDD download failed", str(e)[:200])


def start_job(payload):
    job_id = uuid.uuid4().hex[:12]
    set_job(job_id, status="queued", payload={k: payload.get(k) for k in ("pageUrl", "name", "user")})
    threading.Thread(target=run_job, args=(job_id, payload), daemon=True).start()
    return job_id


def build_safari_script(kind):
    """resolve.js + safari_tail.js as plain JS, for the Safari keyboard shortcuts."""
    src = (HERE.parent / "extension" / "resolve.js").read_text() + "\n" + \
        (HERE / "safari_tail.js").read_text().replace("__KIND__", kind)
    return "(function(){\n" + src + "\n})();\n'started';"


def build_bookmarklet(kind):
    """resolve.js (shared with the extension) + a small launcher, as a javascript: URL."""
    src = (HERE.parent / "extension" / "resolve.js").read_text() + "\n" + \
        (HERE / "bookmarklet_tail.js").read_text().replace("__PORT__", str(PORT)).replace("__KIND__", kind)
    lines = [ln.strip() for ln in src.splitlines()]
    src = "\n".join(ln for ln in lines if ln and not ln.startswith("//"))
    return "javascript:" + urllib.parse.quote("(function(){" + src + "\n})();", safe="")


# ---------------------------------------------------------------- HTTP
STATUS_PAGE = """<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>VDD</title>
<style>body{font:15px -apple-system,system-ui,sans-serif;max-width:560px;margin:48px auto;padding:0 16px;color:#222}
.err{color:#b00020;white-space:pre-wrap;font-size:13px}.ok{color:#0a7a32}code{font-size:12px;word-break:break-all}
button{font:inherit;padding:6px 14px;margin-top:12px}</style>
<h2 id=t>Downloading…</h2><div id=d></div>
<script>
const id=%s;
async function poll(){
  const j=await (await fetch('/status/'+id)).json();
  if(j.status==='done'){t.textContent='Done';t.className='ok';
    d.innerHTML=j.files.map(f=>'<code>'+f.replace(/&/g,'&amp;').replace(/</g,'&lt;')+'</code>').join('<br>')+
    '<br><button onclick="fetch(\\'/reveal/'+id+'\\')">Show in Finder</button>';
    setTimeout(()=>window.close(),4000);return;}
  if(j.status==='error'){t.textContent='Failed';d.className='err';d.textContent=j.error;return;}
  setTimeout(poll,700);
}
poll();
</script>"""


class Handler(BaseHTTPRequestHandler):
    server_version = "VDD/1.0"

    def log_message(self, fmt, *args):
        sys.stderr.write("[vdd] " + (fmt % args) + "\n")

    def _send(self, code, body, ctype="application/json"):
        data = body if isinstance(body, bytes) else body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype + "; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _json(self, code, obj):
        self._send(code, json.dumps(obj))

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        if u.path == "/ping":
            return self._json(200, {"ok": True, "dir": str(DOWNLOAD_DIR)})
        if u.path in ("/", "/index.html"):
            html = (HERE / "home.html").read_text() \
                .replace("__BOOKMARKLET_VIDEO__", build_bookmarklet("video")) \
                .replace("__BOOKMARKLET_IMAGE__", build_bookmarklet("image"))
            return self._send(200, html, "text/html")
        if u.path == "/safari.js":
            kind = "image" if (q.get("kind") or [""])[0] == "image" else "video"
            return self._send(200, build_safari_script(kind), "text/javascript")
        if u.path == "/dl":
            # Used by the Safari bookmarklet (a top-level navigation, so no CORS / CSP issues).
            payload = {
                "pageUrl": (q.get("page") or [""])[0],
                "mediaUrls": q.get("media") or [],
                "name": (q.get("name") or ["video"])[0],
                "user": (q.get("user") or [""])[0] or None,
                "merge": {"video": (q.get("mergeVideo") or [""])[0], "audio": (q.get("mergeAudio") or [""])[0]},
                "browser": (q.get("browser") or [""])[0] or None,
            }
            if payload["browser"] not in (None, "safari", "chrome", "firefox", "edge", "brave"):
                payload["browser"] = None
            job_id = start_job(payload)
            return self._send(200, STATUS_PAGE % json.dumps(job_id), "text/html")
        m = re.fullmatch(r"/status/([0-9a-f]+)", u.path)
        if m:
            with JOBS_LOCK:
                job = dict(JOBS.get(m.group(1)) or {"status": "unknown"})
            return self._json(200, job)
        m = re.fullmatch(r"/reveal/([0-9a-f]+)", u.path)
        if m:
            with JOBS_LOCK:
                files = (JOBS.get(m.group(1)) or {}).get("files") or []
            if files and sys.platform == "darwin":
                subprocess.run(["open", "-R", files[0]])
            return self._json(200, {"ok": bool(files)})
        self._json(404, {"error": "not found"})

    def do_POST(self):
        # JSON-only: browsers must preflight a JSON POST, and we never answer
        # CORS preflights, so random web pages cannot drive this endpoint.
        if self.path != "/download":
            return self._json(404, {"error": "not found"})
        if "application/json" not in (self.headers.get("Content-Type") or ""):
            return self._json(415, {"error": "JSON required"})
        try:
            length = int(self.headers.get("Content-Length") or 0)
            payload = json.loads(self.rfile.read(min(length, 2_000_000)) or b"{}")
        except Exception:
            return self._json(400, {"error": "bad JSON"})
        if payload.get("error"):  # the Safari shortcut could not find anything to download
            notify("VDD", str(payload["error"])[:200])
            return self._json(200, {"ok": False})
        if payload.get("source") == "safari":
            notify("VDD", "Downloading…")
        self._json(200, {"id": start_job(payload)})


def main():
    DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"VDD server on http://{HOST}:{PORT}  ->  saving to {DOWNLOAD_DIR}", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
