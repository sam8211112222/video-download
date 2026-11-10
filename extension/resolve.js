// Shared by the Chrome extension (content script) and the Safari bookmarklet.
// Figures out how to download a given <video> element on the current page.
// Returns { mediaUrls: [direct file URLs], pageUrl, name }.
//  - mediaUrls non-empty -> download those files directly
//  - mediaUrls empty     -> hand pageUrl to yt-dlp on the local server
var VDDResolve = (function () {
  var IG_APP_ID = '936619743392459'; // public app id used by instagram.com web
  var host = location.hostname;
  var isIG = /(^|\.)instagram\.com$/.test(host);
  var isThreads = /(^|\.)threads\.(net|com)$/.test(host);
  var IG_POST_RE = /\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]{5,})/;
  var IG_STORY_RE = /\/stories\/([^/]+)\/(\d+)/;
  var TH_POST_RE = /\/@([^/]+)\/post\/([A-Za-z0-9_-]+)/;

  function httpSrc(v) {
    var c = [v.currentSrc, v.src];
    v.querySelectorAll('source').forEach(function (s) { c.push(s.src); });
    for (var i = 0; i < c.length; i++) if (c[i] && /^https?:/i.test(c[i])) return c[i];
    return null;
  }

  function visibleArea(el) {
    var r = el.getBoundingClientRect();
    var w = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
    var h = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
    return w * h;
  }

  // The video the user is most likely looking at: biggest on screen, playing wins.
  function pickVideo() {
    var best = null, bestScore = 0;
    document.querySelectorAll('video').forEach(function (v) {
      var s = visibleArea(v);
      if (!v.paused) s *= 2;
      if (s > bestScore) { best = v; bestScore = s; }
    });
    return best;
  }

  // Walk up from the video looking for a link matching re, but stop once we
  // leave the post the video belongs to (an <article>, or a container that
  // holds other videos too).
  function closestLink(video, re) {
    for (var n = video.parentElement, d = 0; n && d < 30; n = n.parentElement, d++) {
      var links = n.querySelectorAll('a[href]');
      for (var i = 0; i < links.length; i++) {
        var m = links[i].getAttribute('href').match(re);
        if (m) return m;
      }
      if (n.tagName === 'ARTICLE') return null;
      if (n.querySelectorAll('video').length > 3) return null;
    }
    return null;
  }

  function shortcodeToId(code) {
    var abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    code = code.slice(0, 11);
    var id = BigInt(0);
    for (var i = 0; i < code.length; i++) id = id * BigInt(64) + BigInt(abc.indexOf(code[i]));
    return id.toString();
  }

  function bestVersion(versions) {
    return versions.slice().sort(function (a, b) {
      return (b.width * b.height || 0) - (a.width * a.height || 0);
    })[0].url;
  }

  function igFetch(path) {
    return fetch(path, {
      credentials: 'include',
      headers: { 'X-IG-App-ID': IG_APP_ID, 'X-Requested-With': 'XMLHttpRequest' }
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  // Stories (including private accounts you follow): uses your logged-in
  // session. Story video_versions are progressive MP4s with audio.
  async function resolveStory(video, user, storyId) {
    var pageUrl = location.href.split('?')[0];
    var name = user + '_story_' + (storyId || Date.now());
    var items = [];
    try {
      if (storyId) items = (await igFetch('/api/v1/media/' + storyId + '/info/')).items || [];
    } catch (e) { /* fall through to the reel tray */ }
    if (!items.some(function (x) { return x.video_versions; })) {
      try {
        var prof = await igFetch('/api/v1/users/web_profile_info/?username=' + encodeURIComponent(user));
        var uid = prof.data.user.id;
        var reels = await igFetch('/api/v1/feed/reels_media/?reel_ids=' + uid);
        var all = ((reels.reels && reels.reels[uid]) || (reels.reels_media || [])[0] || {}).items || [];
        items = storyId ? all.filter(function (x) { return String(x.pk) === String(storyId); }) : [];
        if (!items.length && video && isFinite(video.duration)) {
          // No id in the URL: match the playing story by length.
          items = all.filter(function (x) {
            return x.video_versions && Math.abs((x.video_duration || 0) - video.duration) < 0.6;
          }).slice(0, 1);
        }
        if (!items.length && !storyId) items = all; // last resort: every story video
      } catch (e) {
        console.warn('[VDD] story lookup failed, falling back to yt-dlp:', e);
      }
    }
    var urls = items.filter(function (x) { return x.video_versions && x.video_versions.length; })
      .map(function (x) { return bestVersion(x.video_versions); });
    return { mediaUrls: urls, pageUrl: pageUrl, name: name };
  }

  async function resolveInstagram(video) {
    var id = null, code = null, user = null, m;
    if ((m = location.pathname.match(/\/stories\/([^/]+)(?:\/(\d+))?/)) && m[1] !== 'highlights') {
      return resolveStory(video, m[1], m[2]);
    }
    if ((m = location.pathname.match(IG_STORY_RE))) {
      user = m[1]; id = m[2];
    } else {
      m = closestLink(video, IG_POST_RE) || location.pathname.match(IG_POST_RE);
      if (m) { code = m[1]; id = shortcodeToId(code); }
    }
    var pageUrl = code ? 'https://www.instagram.com/p/' + code + '/' : location.href;
    var name = (user ? user + '_' : '') + (code || id || 'instagram');
    if (!id) return { mediaUrls: [], pageUrl: pageUrl, name: name };

    try {
      var r = await fetch('/api/v1/media/' + id + '/info/', {
        credentials: 'include',
        headers: { 'X-IG-App-ID': IG_APP_ID, 'X-Requested-With': 'XMLHttpRequest' }
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      var item = (await r.json()).items[0];
      user = item.user && item.user.username;
      name = (user ? user + '_' : '') + (code || id);
      var parts = (item.carousel_media || [item]).filter(function (x) {
        return x.video_versions && x.video_versions.length;
      });
      // Carousel: try to match the hovered video by duration.
      if (parts.length > 1 && video && isFinite(video.duration)) {
        var hit = parts.filter(function (x) {
          return Math.abs((x.video_duration || 0) - video.duration) < 0.6;
        });
        if (hit.length === 1) parts = hit;
      }
      if (parts.length) {
        return { mediaUrls: parts.map(function (x) { return bestVersion(x.video_versions); }),
                 pageUrl: pageUrl, name: name };
      }
    } catch (e) {
      console.warn('[VDD] Instagram API lookup failed, falling back to yt-dlp:', e);
    }
    return { mediaUrls: [], pageUrl: pageUrl, name: name };
  }

  function resolveThreads(video) {
    var m = closestLink(video, TH_POST_RE) || location.pathname.match(TH_POST_RE);
    var pageUrl = m ? 'https://www.threads.com/@' + m[1] + '/post/' + m[2] : location.href;
    var name = m ? m[1] + '_' + m[2] : 'threads';
    var src = httpSrc(video);
    return { mediaUrls: src ? [src] : [], pageUrl: pageUrl, name: name };
  }

  async function resolve(video) {
    video = video || pickVideo();
    if (isIG) return resolveInstagram(video);
    if (isThreads && video) return resolveThreads(video);
    var name = (document.title || host).slice(0, 80);
    var src = video && httpSrc(video);
    // A plain file URL (not an HLS/DASH manifest) can be fetched directly.
    if (src && !/\.(m3u8|mpd)(\?|$)/i.test(src)) return { mediaUrls: [src], pageUrl: location.href, name: name };
    return { mediaUrls: [], pageUrl: location.href, name: name };
  }

  return { resolve: resolve, pickVideo: pickVideo };
})();
