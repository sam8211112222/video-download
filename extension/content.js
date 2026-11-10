// Adds a floating "Download" button over any video under the mouse.
(function () {
  if (window.__vddLoaded) return;
  window.__vddLoaded = true;

  var btn = document.createElement('button');
  btn.className = 'vdd-btn';
  btn.type = 'button';
  btn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M12 3a1 1 0 0 1 1 1v9.59l3.3-3.3a1 1 0 1 1 1.4 1.42l-5 5a1 1 0 0 1-1.4 0l-5-5a1 1 0 1 1 1.4-1.42l3.3 3.3V4a1 1 0 0 1 1-1zM5 19a1 1 0 0 1 1-1h12a1 1 0 1 1 0 2H6a1 1 0 0 1-1-1z"/></svg><span>Download</span>';
  btn.title = 'Download this video (VDD)';
  var current = null;
  var hideTimer = null;

  function mount() { if (!btn.isConnected) document.documentElement.appendChild(btn); }

  // Sites like Instagram cover videos with transparent layers, so hit-test
  // the mouse position against every video's box instead of using mouseover.
  function videoAt(x, y) {
    var found = null, bestArea = Infinity;
    document.querySelectorAll('video').forEach(function (v) {
      var r = v.getBoundingClientRect();
      if (r.width < 120 || r.height < 80) return;
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
        var a = r.width * r.height;
        if (a < bestArea) { found = v; bestArea = a; }
      }
    });
    return found;
  }

  function place(v) {
    var r = v.getBoundingClientRect();
    btn.style.top = Math.max(8, r.top + 10) + 'px';
    btn.style.left = Math.min(innerWidth - 120, r.right - 110) + 'px';
  }

  var pending = false;
  document.addEventListener('mousemove', function (e) {
    if (pending) return;
    pending = true;
    requestAnimationFrame(function () {
      pending = false;
      var v = videoAt(e.clientX, e.clientY);
      if (v) {
        mount();
        current = v;
        place(v);
        btn.classList.add('vdd-show');
        clearTimeout(hideTimer);
      } else if (e.target !== btn && !btn.contains(e.target)) {
        clearTimeout(hideTimer);
        hideTimer = setTimeout(function () { btn.classList.remove('vdd-show'); }, 400);
      }
    });
  }, { passive: true });
  window.addEventListener('scroll', function () { if (current && btn.classList.contains('vdd-show')) place(current); }, { passive: true });

  // Capture phase + stopping propagation keeps the click from pausing the video.
  ['pointerdown', 'mousedown', 'mouseup'].forEach(function (t) {
    btn.addEventListener(t, function (e) { e.stopPropagation(); }, true);
  });
  btn.addEventListener('click', function (e) {
    e.preventDefault();
    e.stopPropagation();
    download(current);
  }, true);

  function toast(msg, kind) {
    var t = document.createElement('div');
    t.className = 'vdd-toast' + (kind ? ' vdd-' + kind : '');
    t.textContent = msg;
    document.documentElement.appendChild(t);
    setTimeout(function () { t.classList.add('vdd-out'); }, 3200);
    setTimeout(function () { t.remove(); }, 3700);
  }

  async function download(video) {
    if (btn.classList.contains('vdd-busy')) return;
    btn.classList.add('vdd-busy');
    try {
      var info = await VDDResolve.resolve(video);
      var res = await chrome.runtime.sendMessage({ type: 'vdd-download', info: info });
      if (res && res.ok) toast(res.message || 'Downloading…', 'ok');
      else toast((res && res.error) || 'Download failed', 'err');
    } catch (e) {
      toast('VDD: ' + e.message, 'err');
    } finally {
      btn.classList.remove('vdd-busy');
    }
  }

  chrome.runtime.onMessage.addListener(function (msg, _sender, reply) {
    if (msg && msg.type === 'vdd-download-visible') {
      var v = VDDResolve.pickVideo();
      if (!v && !msg.allowPage) { toast('No video found on screen', 'err'); reply({ ok: false }); return; }
      download(v).then(function () { reply({ ok: true }); });
      return true;
    }
    if (msg && msg.type === 'vdd-count') {
      reply({ count: document.querySelectorAll('video').length });
    }
  });
})();
