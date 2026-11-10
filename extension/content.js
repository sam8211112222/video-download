// Floating buttons over the video or photo under the mouse:
//   video -> [Video] [Cover]      photo -> [Image]
(function () {
  if (window.__vddLoaded) return;
  window.__vddLoaded = true;

  var ICON_DL = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M12 3a1 1 0 0 1 1 1v9.59l3.3-3.3a1 1 0 1 1 1.4 1.42l-5 5a1 1 0 0 1-1.4 0l-5-5a1 1 0 1 1 1.4-1.42l3.3 3.3V4a1 1 0 0 1 1-1zM5 19a1 1 0 0 1 1-1h12a1 1 0 1 1 0 2H6a1 1 0 0 1-1-1z"/></svg>';
  var ICON_IMG = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm0 2v9.6l3.3-3.3a1 1 0 0 1 1.4 0l3.3 3.3 2.3-2.3a1 1 0 0 1 1.4 0L19 15.6V6H5zm10.5 1.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z"/></svg>';

  var bar = document.createElement('div');
  bar.className = 'vdd-bar';
  function makeBtn(icon, label, title, action) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'vdd-btn';
    b.innerHTML = icon + '<span>' + label + '</span>';
    b.title = title;
    b.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      run(b, action);
    }, true);
    bar.appendChild(b);
    return b;
  }
  var btnVideo = makeBtn(ICON_DL, 'Video', 'Download this video (VDD)', function () { return VDDResolve.resolveVideo(current); });
  var btnCover = makeBtn(ICON_IMG, 'Cover', 'Download the cover image (VDD)', function () { return VDDResolve.resolveCover(current); });
  var btnImage = makeBtn(ICON_IMG, 'Image', 'Download this photo (VDD)', function () { return VDDResolve.resolveImage(current); });

  // Stop clicks on the bar from reaching the page (which would pause/advance
  // the media). Must be bubble phase: in capture phase the bar would swallow
  // the click before it reaches the button, and no button would work.
  ['pointerdown', 'mousedown', 'mouseup', 'click'].forEach(function (t) {
    bar.addEventListener(t, function (e) { e.stopPropagation(); }, false);
  });

  var current = null, currentType = null, hideTimer = null;

  function mount() { if (!bar.isConnected) document.documentElement.appendChild(bar); }

  // Sites like Instagram cover media with transparent layers, so hit-test the
  // mouse position against every video/photo box instead of using mouseover.
  // Videos win over photos (a video's thumbnail often sits underneath it).
  function mediaAt(x, y) {
    function inside(r) { return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom; }
    var vid = null, va = Infinity;
    document.querySelectorAll('video').forEach(function (v) {
      var r = v.getBoundingClientRect();
      if (r.width < 120 || r.height < 80 || !inside(r)) return;
      if (r.width * r.height < va) { vid = v; va = r.width * r.height; }
    });
    if (vid) return { el: vid, type: 'video' };
    var img = null, ia = Infinity;
    Array.prototype.forEach.call(document.images, function (i) {
      var r = i.getBoundingClientRect();
      if (!inside(r) || !VDDResolve.isBigImage(i)) return;
      if (r.width * r.height < ia) { img = i; ia = r.width * r.height; }
    });
    return img ? { el: img, type: 'image' } : null;
  }

  function place() {
    var r = current.getBoundingClientRect();
    bar.style.top = Math.max(8, r.top + 10) + 'px';
    bar.style.left = Math.max(8, Math.min(innerWidth - bar.offsetWidth - 8, r.right - bar.offsetWidth - 10)) + 'px';
  }

  function show(hit) {
    mount();
    if (hit.el !== current) {
      current = hit.el;
      currentType = hit.type;
      btnVideo.style.display = btnCover.style.display = hit.type === 'video' ? '' : 'none';
      btnImage.style.display = hit.type === 'image' ? '' : 'none';
    }
    bar.classList.add('vdd-show');
    place();
    clearTimeout(hideTimer);
  }

  var pending = false;
  document.addEventListener('mousemove', function (e) {
    if (pending) return;
    pending = true;
    requestAnimationFrame(function () {
      pending = false;
      if (bar.contains(e.target)) { clearTimeout(hideTimer); return; }
      var hit = mediaAt(e.clientX, e.clientY);
      if (hit) show(hit);
      else {
        clearTimeout(hideTimer);
        hideTimer = setTimeout(function () { bar.classList.remove('vdd-show'); current = null; }, 400);
      }
    });
  }, { passive: true });
  window.addEventListener('scroll', function () {
    if (current && bar.classList.contains('vdd-show')) place();
  }, { passive: true });

  function toast(msg, kind) {
    var t = document.createElement('div');
    t.className = 'vdd-toast' + (kind ? ' vdd-' + kind : '');
    t.textContent = msg;
    document.documentElement.appendChild(t);
    setTimeout(function () { t.classList.add('vdd-out'); }, 3200);
    setTimeout(function () { t.remove(); }, 3700);
  }

  async function run(button, resolver) {
    if (button && button.classList.contains('vdd-busy')) return;
    if (button) button.classList.add('vdd-busy');
    try {
      var info = await resolver();
      if (info.kind === 'image' && !info.mediaUrls.length) throw new Error('No image URL found');
      var res = await chrome.runtime.sendMessage({ type: 'vdd-download', info: info });
      if (res && res.ok) toast(res.message || 'Downloading…', 'ok');
      else toast((res && res.error) || 'Download failed', 'err');
    } catch (e) {
      toast('VDD: ' + e.message, 'err');
    } finally {
      if (button) button.classList.remove('vdd-busy');
    }
  }

  chrome.runtime.onMessage.addListener(function (msg, _sender, reply) {
    if (msg && msg.type === 'vdd-download-visible') {
      run(null, function () { return VDDResolve.resolveVisible(msg.kind || 'video'); })
        .then(function () { reply({ ok: true }); });
      return true;
    }
  });
})();
