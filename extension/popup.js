const msg = document.getElementById('msg');

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

document.getElementById('visible').onclick = async () => {
  const tab = await activeTab();
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'vdd-download-visible' });
    window.close();
  } catch (_) {
    msg.textContent = 'Reload the page first (the extension was just installed or updated).';
  }
};

document.getElementById('page').onclick = async () => {
  const tab = await activeTab();
  msg.textContent = 'Sending…';
  const res = await chrome.runtime.sendMessage({ type: 'vdd-page', url: tab.url, title: tab.title });
  msg.textContent = res.ok ? res.message : res.error;
};

chrome.runtime.sendMessage({ type: 'vdd-ping' }, (res) => {
  const on = res && res.ok;
  document.getElementById('dot').className = 'dot ' + (on ? 'on' : 'off');
  document.getElementById('status').textContent = on
    ? 'Helper running · saves to ' + res.dir.replace(/^\/Users\/[^/]+/, '~')
    : 'Helper not running (needed for yt-dlp fallback)';
});
