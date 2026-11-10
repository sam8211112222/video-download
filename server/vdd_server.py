#!/usr/bin/env python3
"""VDD local download server.

Runs only on 127.0.0.1. The Chrome extension and the Safari bookmarklet send it
either direct media URLs (downloaded as-is) or a page URL (handed to yt-dlp).
Files are saved to ~/Downloads/VDD Videos.
"""
import json
import os
import re
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
    name = re.sub(r"\s+", " ", name).strip(" ._")
    return (name or fallback)[:120]


def unique_path(base: Path) -> Path:
    if not base.exists():
        return base
    stem, suffix, i = base.stem, base.suffix, 2
    while (base.parent / f"{stem} ({i}){suffix}").exists():
        i += 1
    return base.parent / f"{stem} ({i}){suffix}"


def is_http(url):
    return isinstance(url, str) and url.lower().startswith(("http://", "https://"))


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
def download_direct(url, name, referer, index, total):
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
        suffix = f"_{index + 1}" if total > 1 else ""
        out = unique_path(DOWNLOAD_DIR / f"{safe_name(name)}{suffix}{ext}")
        tmp = out.with_suffix(out.suffix + ".part")
        with open(tmp, "wb") as f:
            while True:
                chunk = resp.read(1 << 16)
                if not chunk:
                    break
                f.write(chunk)
        tmp.rename(out)
        return out


def download_ytdlp(page_url, cookies_txt, browser):
    import yt_dlp  # imported lazily so /ping works even if yt-dlp is broken

    base_opts = {
        "outtmpl": str(DOWNLOAD_DIR / "%(uploader,channel,id)s_%(id)s.%(ext)s"),
        "format": "bv*+ba/b",
        "merge_output_format": "mp4",
        "noplaylist": False,
        "quiet": True,
        "no_warnings": True,
        "restrictfilenames": False,
        "windowsfilenames": True,
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
                errors.append(f"[{label}] {e}")
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
        files = []
        if media:
            for i, u in enumerate(media):
                files.append(download_direct(u, name, page, i, len(media)))
        elif is_http(page):
            files = download_ytdlp(page, payload.get("cookies"), payload.get("browser"))
        else:
            raise ValueError("No downloadable URL was provided.")
        if not files:
            raise RuntimeError("Nothing was downloaded.")
        set_job(job_id, status="done", files=[str(f) for f in files])
        notify("VDD downloaded", ", ".join(f.name for f in files))
    except Exception as e:
        set_job(job_id, status="error", error=str(e))
        notify("VDD download failed", str(e)[:200])


def start_job(payload):
    job_id = uuid.uuid4().hex[:12]
    set_job(job_id, status="queued", payload={k: payload.get(k) for k in ("pageUrl", "name")})
    threading.Thread(target=run_job, args=(job_id, payload), daemon=True).start()
    return job_id


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
        if u.path == "/dl":
            # Used by the Safari bookmarklet (a top-level navigation, so no CORS / CSP issues).
            payload = {
                "pageUrl": (q.get("page") or [""])[0],
                "mediaUrls": q.get("media") or [],
                "name": (q.get("name") or ["video"])[0],
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
