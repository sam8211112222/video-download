// Shared by the Chrome extension (content script) and the Safari bookmarklets.
// Works out how to download a video, a video's cover image, or a photo.
// Every resolver returns { mediaUrls: [direct file URLs], pageUrl, name, kind }.
//  - mediaUrls non-empty -> download those files directly
//  - mediaUrls empty     -> hand pageUrl to yt-dlp on the local helper (videos only)
var VDDResolve = (function () {
  var IG_APP_ID = '936619743392459'; // public app id used by instagram.com web
  var host = location.hostname;
  var isIG = /(^|\.)instagram\.com$/.test(host);
  var isThreads = /(^|\.)threads\.(net|com)$/.test(host);
  // Skips /reels/audio/<id> (the music link on every reel), which is not a post.
  var IG_POST_RE = /\/(?:p|reel|reels|tv)\/(?!audio\/)([A-Za-z0-9_-]{5,})/;
  var IG_STORY_RE = /\/stories\/([^/]+)\/(\d+)/;
  var TH_POST_RE = /\/@([^/]+)\/post\/([A-Za-z0-9_-]+)/;
  var MIN_IMG = 150; // ignore avatars, icons, emoji

  // ------------------------------------------------------------ DOM helpers
  function httpSrc(v) {
    var c = [v.currentSrc, v.src];
    v.querySelectorAll('source').forEach(function (s) { c.push(s.src); });
    for (var i = 0; i < c.length; i++) if (c[i] && /^https?:/i.test(c[i])) return c[i];
    return null;
  }

  // Largest candidate from an <img>'s srcset (falls back to currentSrc).
  function largestImg(img) {
    var best = img.currentSrc || img.src, bestW = 0;
    (img.getAttribute('srcset') || '').split(/,\s+/).forEach(function (part) {
      var p = part.trim().split(/\s+/);
      if (!p[0]) return;
      var w = parseFloat(p[1]) || 0;
      if (p[1] && /x$/.test(p[1])) w *= 1000;
      if (w > bestW) { bestW = w; best = p[0]; }
    });
    return best ? new URL(best, location.href).href : null;
  }

  function visibleArea(el) {
    var r = el.getBoundingClientRect();
    var w = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
    var h = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
    return w * h;
  }

  function isBigImage(img) {
    var r = img.getBoundingClientRect();
    if (r.width < MIN_IMG || r.height < MIN_IMG) return false;
    var cs = getComputedStyle(img);
    return cs.visibility !== 'hidden' && cs.opacity !== '0' && /^https?:/i.test(img.currentSrc || img.src);
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

  // Most prominent video or photo on screen.
  function pickMedia() {
    var best = pickVideo(), bestScore = best ? visibleArea(best) * (best.paused ? 1 : 2) : 0;
    Array.prototype.forEach.call(document.images, function (img) {
      if (!isBigImage(img)) return;
      var s = visibleArea(img);
      if (s > bestScore) { best = img; bestScore = s; }
    });
    return best;
  }

  // Walk up from el looking for a link matching re, but stop once we leave
  // the post el belongs to (an <article>, or a container with many videos).
  function closestLink(el, re) {
    for (var n = el && el.parentElement, d = 0; n && d < 30; n = n.parentElement, d++) {
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

  function largest(list) {
    return list.slice().sort(function (a, b) {
      return (b.width * b.height || 0) - (a.width * a.height || 0);
    })[0].url;
  }
  function bestVideo(item) { return largest(item.video_versions); }
  function bestImage(item) {
    var c = item.image_versions2 && item.image_versions2.candidates;
    return c && c.length ? largest(c) : null;
  }

  // og:image of a page (Threads/IG post pages use it for the cover).
  async function ogImage(url) {
    var html = await (await fetch(url, { credentials: 'include' })).text();
    var m = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/) ||
            html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:image"/);
    if (!m) return null;
    var t = document.createElement('textarea');
    t.innerHTML = m[1];
    return t.value;
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

  // In a carousel / story tray, keep the part whose length matches the video.
  function matchByDuration(parts, video) {
    if (parts.length > 1 && video && video.tagName === 'VIDEO' && isFinite(video.duration)) {
      var hit = parts.filter(function (x) {
        return x.video_versions && Math.abs((x.video_duration || 0) - video.duration) < 0.6;
      });
      if (hit.length === 1) return hit;
    }
    return parts;
  }

  // ------------------------------------------------------------ Instagram
  // Stories (including private accounts you follow) use your logged-in
  // session. Story video_versions are progressive MP4s with audio.
  async function igStory(video, user, storyId) {
    var res = { items: [], pageUrl: location.href.split('?')[0], name: user + '_story_' + (storyId || Date.now()) };
    try {
      if (storyId) res.items = (await igFetch('/api/v1/media/' + storyId + '/info/')).items || [];
    } catch (e) { /* fall through to the reel tray */ }
    if (!res.items.length) {
      try {
        var prof = await igFetch('/api/v1/users/web_profile_info/?username=' + encodeURIComponent(user));
        var uid = prof.data.user.id;
        var reels = await igFetch('/api/v1/feed/reels_media/?reel_ids=' + uid);
        var all = ((reels.reels && reels.reels[uid]) || (reels.reels_media || [])[0] || {}).items || [];
        res.items = storyId ? all.filter(function (x) { return String(x.pk) === String(storyId); }) : [];
        if (!res.items.length && video && video.tagName === 'VIDEO' && isFinite(video.duration)) {
          // No id in the URL: match the playing story by length.
          res.items = all.filter(function (x) {
            return x.video_versions && Math.abs((x.video_duration || 0) - video.duration) < 0.6;
          }).slice(0, 1);
        }
        if (!res.items.length && !storyId) res.items = all; // last resort: every story
      } catch (e) {
        console.warn('[VDD] story lookup failed:', e);
      }
    }
    return res;
  }

  // Finds the post/story `el` belongs to and fetches its media items.
  async function igLookup(el) {
    var m = location.pathname.match(/\/stories\/([^/]+)(?:\/(\d+))?/);
    if (m && m[1] !== 'highlights') return igStory(el, m[1], m[2]);
    var id = null, code = null, user = null;
    if ((m = location.pathname.match(IG_STORY_RE))) {
      id = m[2]; // highlight
    } else {
      m = closestLink(el, IG_POST_RE) || location.pathname.match(IG_POST_RE);
      if (m) { code = m[1]; id = shortcodeToId(code); }
    }
    var res = {
      items: [],
      pageUrl: code ? 'https://www.instagram.com/p/' + code + '/' : location.href,
      name: code || id || 'instagram'
    };
    if (!id) return res;
    try {
      var item = (await igFetch('/api/v1/media/' + id + '/info/')).items[0];
      user = item.user && item.user.username;
      res.name = (user ? user + '_' : '') + (code || id);
      res.items = item.carousel_media || [item];
    } catch (e) {
      console.warn('[VDD] Instagram API lookup failed:', e);
    }
    return res;
  }

  // ------------------------------------------------------------ Threads
  function threadsPost(el) {
    var m = closestLink(el, TH_POST_RE) || location.pathname.match(TH_POST_RE);
    return {
      pageUrl: m ? 'https://www.threads.com/@' + m[1] + '/post/' + m[2] : location.href,
      name: m ? m[1] + '_' + m[2] : 'threads'
    };
  }

  function pageName() { return (document.title || host).slice(0, 80); }

  // ------------------------------------------------------------ public API
  async function resolveVideo(video) {
    video = video || pickVideo();
    if (isIG) {
      var r = await igLookup(video);
      var parts = matchByDuration(r.items.filter(function (x) {
        return x.video_versions && x.video_versions.length;
      }), video);
      // The lookup worked but there is no video: it's a photo post.
      if (r.items.length && !parts.length) throw new Error('This post is a photo, not a video. Use the Image button (⌥⇧I).');
      return { mediaUrls: parts.map(bestVideo), pageUrl: r.pageUrl, name: r.name, kind: 'video' };
    }
    if (isThreads && video) {
      var p = threadsPost(video), s = httpSrc(video);
      return { mediaUrls: s ? [s] : [], pageUrl: p.pageUrl, name: p.name, kind: 'video' };
    }
    var src = video && httpSrc(video);
    // A plain file URL (not an HLS/DASH manifest) can be fetched directly.
    var ok = src && !/\.(m3u8|mpd)(\?|$)/i.test(src);
    return { mediaUrls: ok ? [src] : [], pageUrl: location.href, name: pageName(), kind: 'video' };
  }

  async function resolveCover(video) {
    var url = null, pageUrl = location.href, name = pageName();
    if (isIG) {
      var r = await igLookup(video);
      var parts = matchByDuration(r.items.filter(function (x) { return x.video_versions; }), video);
      url = parts.length ? bestImage(parts[0]) : null;
      pageUrl = r.pageUrl; name = r.name;
      if (!url && /\/p\//.test(pageUrl)) url = await ogImage(pageUrl).catch(function () { return null; });
    } else if (isThreads) {
      var p = threadsPost(video);
      pageUrl = p.pageUrl; name = p.name;
      url = await ogImage(p.pageUrl.replace(/^https:\/\/www\.threads\.com/, location.origin))
        .catch(function () { return null; });
    }
    if (!url && video && video.poster) url = video.poster;
    if (!url) url = await ogImage(location.href).catch(function () { return null; });
    if (!url) throw new Error('Could not find a cover image for this video');
    return { mediaUrls: [url], pageUrl: pageUrl, name: name + '_cover', kind: 'image' };
  }

  async function resolveImage(img) {
    var name = pageName(), pageUrl = location.href;
    if (isIG) {
      var m = location.pathname.match(/\/stories\/([^/]+)(?:\/(\d+))?/);
      if (m) name = m[1] + '_story_' + (m[2] || Date.now());
      else if ((m = closestLink(img, IG_POST_RE) || location.pathname.match(IG_POST_RE))) {
        name = m[1]; pageUrl = 'https://www.instagram.com/p/' + m[1] + '/';
      }
    } else if (isThreads) {
      var p = threadsPost(img);
      name = p.name; pageUrl = p.pageUrl;
    }
    return { mediaUrls: [largestImg(img)], pageUrl: pageUrl, name: name, kind: 'image' };
  }

  // kind 'video': the main video on screen. kind 'image': the main photo on
  // screen, or the cover of the main video if that is what is showing.
  async function resolveVisible(kind) {
    if (kind === 'image') {
      var el = pickMedia();
      if (!el) throw new Error('No photo or video found on screen');
      return el.tagName === 'VIDEO' ? resolveCover(el) : resolveImage(el);
    }
    var v = pickVideo();
    if (!v && (isIG || isThreads)) throw new Error('No video found on screen');
    return resolveVideo(v);
  }

  return {
    resolveVideo: resolveVideo,
    resolveCover: resolveCover,
    resolveImage: resolveImage,
    resolveVisible: resolveVisible,
    isBigImage: isBigImage
  };
})();
