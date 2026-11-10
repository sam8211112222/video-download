const SERVER = 'http://127.0.0.1:17723';

function safeName(s) {
  return (s || 'video').replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 100) || 'video';
}

function extFromUrl(url) {
  const m = new URL(url).pathname.match(/\.(mp4|webm|mov|m4v)$/i);
  return m ? m[1].toLowerCase() : 'mp4';
}

// Cookies for the page's site in Netscape format, so yt-dlp can see
// logged-in-only posts without touching the macOS keychain.
async function netscapeCookies(pageUrl) {
  const cookies = await chrome.cookies.getAll({ url: pageUrl });
  const lines = ['# Netscape HTTP Cookie File'];
  for (const c of cookies) {
    const domain = c.hostOnly ? c.domain : (c.domain.startsWith('.') ? c.domain : '.' + c.domain);
    lines.push([
      (c.httpOnly ? '#HttpOnly_' : '') + domain,
      c.hostOnly ? 'FALSE' : 'TRUE',
      c.path,
      c.secure ? 'TRUE' : 'FALSE',
      Math.floor(c.expirationDate || 0),
      c.name,
      c.value
    ].join('\t'));
  }
  return lines.join('\n') + '\n';
}

async function downloadDirect(info) {
  const base = safeName(info.name);
  const many = info.mediaUrls.length > 1;
  for (let i = 0; i < info.mediaUrls.length; i++) {
    const url = info.mediaUrls[i];
    await chrome.downloads.download({
      url,
      filename: `VDD Videos/${base}${many ? '_' + (i + 1) : ''}.${extFromUrl(url)}`,
      conflictAction: 'uniquify'
    });
  }
  return { ok: true, message: many ? `Downloading ${info.mediaUrls.length} videos…` : 'Downloading…' };
}

async function downloadViaServer(info) {
  let cookies = '';
  try { cookies = await netscapeCookies(info.pageUrl); } catch (_) {}
  let res;
  try {
    res = await fetch(`${SERVER}/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pageUrl: info.pageUrl, name: info.name, cookies })
    });
  } catch (_) {
    return { ok: false, error: 'This video needs the VDD helper app.\nStart it with "Start VDD.command" and try again.' };
  }
  if (!res.ok) return { ok: false, error: 'VDD helper error ' + res.status };
  const { id } = await res.json();
  pollJob(id);
  return { ok: true, message: 'Sent to VDD helper (yt-dlp)… you will get a notification when done.' };
}

async function pollJob(id) {
  for (let i = 0; i < 600; i++) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      const j = await (await fetch(`${SERVER}/status/${id}`)).json();
      if (j.status === 'done' || j.status === 'error') {
        chrome.action.setBadgeText({ text: j.status === 'done' ? '✓' : '!' });
        chrome.action.setBadgeBackgroundColor({ color: j.status === 'done' ? '#16a34a' : '#dc2626' });
        setTimeout(() => chrome.action.setBadgeText({ text: '' }), 5000);
        return;
      }
    } catch (_) { return; }
  }
}

async function handle(info) {
  if (info.mediaUrls && info.mediaUrls.length) {
    try {
      return await downloadDirect(info);
    } catch (e) {
      // e.g. URL rejected by chrome.downloads — let the helper try.
      return downloadViaServer(info);
    }
  }
  return downloadViaServer(info);
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg && msg.type === 'vdd-download') {
    handle(msg.info).then(reply, e => reply({ ok: false, error: String(e) }));
    return true;
  }
  if (msg && msg.type === 'vdd-page') {
    downloadViaServer({ pageUrl: msg.url, name: msg.title }).then(reply);
    return true;
  }
  if (msg && msg.type === 'vdd-ping') {
    fetch(`${SERVER}/ping`).then(r => r.json()).then(j => reply(j), () => reply({ ok: false }));
    return true;
  }
});

chrome.commands.onCommand.addListener(async (cmd) => {
  if (cmd !== 'download-visible') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) chrome.tabs.sendMessage(tab.id, { type: 'vdd-download-visible' }).catch(() => {});
});
