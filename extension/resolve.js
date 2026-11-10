// Shared by the Chrome extension (content script) and the Safari bookmarklets.
// Works out how to download a video, a video's cover image, or a photo.
// Every resolver returns { mediaUrls: [direct file URLs], pageUrl, name, kind }.
//  - mediaUrls non-empty -> download those files directly
//  - mediaUrls empty     -> hand pageUrl to yt-dlp on the local helper (videos only)
// Reads the video's original file URLs from the page's React data (Threads
// and other Meta players). Must run in the page's own JS world (the Safari
// bookmarklet does; the extension runs it via chrome.scripting, world MAIN),
// and must stay self-contained because the extension serializes it.
// Returns { progressive, dashVideo, dashAudio, types } or null.
function vddFiberProbe(video) {
  video = video || document.querySelector('video[data-vdd-probe]');
  if (!video) return null;
  var fk = Object.keys(video).find(function (k) { return k.indexOf('__reactFiber') === 0; });
  if (!fk) return null;
  var mp4 = /^https:\/\/[^\s"]+\.mp4/;
  var res = { progressive: null, dashVideo: null, dashAudio: null, types: [] };
  var manifest = null;
  function findMpd(o, depth) {
    if (manifest || !o || depth > 3) return;
    if (typeof o === 'string') { if (o.indexOf('<MPD') >= 0) manifest = o; return; }
    if (typeof o !== 'object' || o instanceof Node) return;
    Object.keys(o).forEach(function (k) { if (k !== 'children' && k.indexOf('__') !== 0) { try { findMpd(o[k], depth + 1); } catch (e) {} } });
  }
  function takeSrc(o) {
    if (res.progressive || !o) return;
    var s = o.hdSrc || o.sdSrc || o.playable_url_quality_hd || o.playable_url;
    if (typeof s === 'string' && mp4.test(s)) res.progressive = s;
  }
  for (var f = video[fk], d = 0; f && d < 40; f = f.return, d++) {
    var p = f.memoizedProps;
    if (!p || typeof p !== 'object') continue;
    takeSrc(p);
    if (Array.isArray(p.implementations)) {
      p.implementations.forEach(function (i) {
        res.types.push(i.typename || '?');
        takeSrc(i.data || i);
        findMpd(i.data || i, 0);
      });
    }
  }
  if (manifest) {
    try {
      var doc = new DOMParser().parseFromString(manifest, 'application/xml');
      // Prefer codecs macOS plays natively (H.264 > HEVC > VP9/AV1; AAC > Opus),
      // then the highest bitrate. Score = codec rank * 1e12 + bandwidth.
      function rank(codecs, kind) {
        if (kind === 'audio') return /^mp4a/.test(codecs) ? 2 : 1;
        return /^(avc1|avc3)/.test(codecs) ? 3 : /^(hvc1|hev1)/.test(codecs) ? 2 : 1;
      }
      var best = { video: [-1, null], audio: [-1, null] };
      Array.prototype.forEach.call(doc.getElementsByTagName('AdaptationSet'), function (set) {
        var setKind = (set.getAttribute('contentType') || set.getAttribute('mimeType') || '').indexOf('audio') >= 0 ? 'audio' : 'video';
        Array.prototype.forEach.call(set.getElementsByTagName('Representation'), function (r) {
          var kind = (r.getAttribute('mimeType') || '').indexOf('audio') >= 0 ? 'audio' : setKind;
          var codecs = r.getAttribute('codecs') || set.getAttribute('codecs') || '';
          var score = rank(codecs, kind) * 1e12 + parseInt(r.getAttribute('bandwidth') || '0', 10);
          var base = r.getElementsByTagName('BaseURL')[0];
          if (base && score > best[kind][0]) best[kind] = [score, base.textContent.trim()];
        });
      });
      res.dashVideo = best.video[1];
      res.dashAudio = best.audio[1];
    } catch (e) { /* ignore a manifest we cannot parse */ }
  }
  return res;
}

// Identifies the media itself, independent of size, codec or the expiring
// signature in the URL. Must match media_key() in server/vdd_server.py.
function vddMediaKey(url) {
  var u = new URL(url);
  var efg = u.searchParams.get('efg');
  if (efg) {
    try {
      // Read the digits as text: the ids exceed 2^53, so JSON.parse would round them.
      var m = atob(efg.replace(/-/g, '+').replace(/_/g, '/')).match(/"xpv_asset_id"\s*:\s*"?(\d+)/);
      if (m) return 'asset:' + m[1];
    } catch (e) { /* not base64 */ }
  }
  var name = u.pathname.split('/').pop();
  if (/\.(jpe?g|png|webp|heic|avif|gif)$/i.test(name)) return 'file:' + name.replace(/\.[^.]+$/, '');
  return 'url:' + u.host + u.pathname;
}

var VDDResolve = (function () {
  var IG_APP_ID = '936619743392459'; // public app id used by instagram.com web
  var host = location.hostname;
  var isIG = /(^|\.)instagram\.com$/.test(host);
  var isThreads = /(^|\.)threads\.(net|com)$/.test(host);
  var isX = /(^|\.)(x|twitter)\.com$/.test(host);
  var isFB = /(^|\.)facebook\.com$/.test(host);
  // Skips /reels/audio/<id> (the music link on every reel), which is not a post.
  var IG_POST_RE = /\/(?:p|reel|reels|tv)\/(?!audio\/)([A-Za-z0-9_-]{5,})/;
  var IG_STORY_RE = /\/stories\/([^/]+)\/(\d+)/;
  var TH_POST_RE = /\/@([^/]+)\/post\/([A-Za-z0-9_-]+)/;
  var X_POST_RE = /\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/;
  // Facebook video links: /<page>/videos/[<slug>/]<id>, /reel/<id>, /watch/?v=<id>
  var FB_POST_RE = /(?:facebook\.com)?\/(?:([A-Za-z0-9.]+)\/videos\/(?:[^/?#]+\/)?(\d+)|reel\/(\d+)|watch\/?\?v=(\d+))/;
  var FB_RESERVED = /^(watch|reel|groups|events|stories|photo|photos|videos|profile\.php|share|people|pages)$/;
  var MIN_IMG = 150; // ignore avatars, icons, emoji
  // How to run vddFiberProbe: directly (bookmarklet, page world). The extension
  // replaces this, because content scripts cannot see the page's React data.
  var probe = function (video) { return Promise.resolve(vddFiberProbe(video)); };
  var IG_RESERVED = /^(p|reel|reels|tv|stories|explore|direct|accounts|about|legal|developer|web|challenge|emails|session|api|audio)$/;

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

  // The post author's username from the page: /<user>/p/<code>/ URLs, or the
  // first profile link (/<user>/) inside the post the element belongs to.
  function igUserFromDom(el) {
    var m = location.pathname.match(/^\/([A-Za-z0-9._]{1,30})\/(?:p|reel|tv)\//);
    if (m && !IG_RESERVED.test(m[1])) return m[1];
    for (var n = el && el.parentElement, d = 0; n && d < 30; n = n.parentElement, d++) {
      var links = n.querySelectorAll('a[href]');
      for (var i = 0; i < links.length; i++) {
        var h = links[i].getAttribute('href').match(/^\/([A-Za-z0-9._]{1,30})\/?$/);
        if (h && !IG_RESERVED.test(h[1])) return h[1];
      }
      if (n.tagName === 'ARTICLE') break;
      if (n.querySelectorAll('video').length > 3) break;
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
    var res = { items: [], user: user, pageUrl: location.href.split('?')[0], name: user + '_story_' + (storyId || Date.now()) };
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
      user: null,
      pageUrl: code ? 'https://www.instagram.com/p/' + code + '/' : location.href,
      name: code || id || 'instagram'
    };
    if (id) {
      try {
        var item = (await igFetch('/api/v1/media/' + id + '/info/')).items[0];
        user = item.user && item.user.username;
        res.items = item.carousel_media || [item];
      } catch (e) {
        console.warn('[VDD] Instagram API lookup failed:', e);
      }
    }
    res.user = user || igUserFromDom(el);
    if (res.user) res.name = res.user + '_' + (code || id || 'instagram');
    return res;
  }

  // ------------------------------------------------------------ Threads
  function threadsPost(el) {
    var m = closestLink(el, TH_POST_RE) || location.pathname.match(TH_POST_RE);
    return {
      user: m ? m[1] : null,
      pageUrl: m ? 'https://www.threads.com/@' + m[1] + '/post/' + m[2] : location.href,
      name: m ? m[1] + '_' + m[2] : 'threads'
    };
  }

  // ------------------------------------------------------------ X / Twitter
  function xPost(el) {
    var m = closestLink(el, X_POST_RE) || location.pathname.match(X_POST_RE);
    return m ? { user: m[1], pageUrl: 'https://x.com/' + m[1] + '/status/' + m[2], name: m[1] + '_' + m[2] }
             : { user: null, pageUrl: location.href, name: 'x' };
  }

  // Full-size photo: pbs.twimg.com/media/<id>?format=jpg&name=small -> name=orig
  function xOriginal(src) {
    try {
      var u = new URL(src);
      if (u.hostname === 'pbs.twimg.com' && u.pathname.indexOf('/media/') === 0) {
        u.searchParams.set('name', 'orig');
        return u.href;
      }
    } catch (e) { /* not a URL */ }
    return src;
  }

  // ------------------------------------------------------------ Facebook
  function fbPost(el) {
    var m = closestLink(el, FB_POST_RE) || (location.pathname + location.search).match(FB_POST_RE);
    var id = m && (m[2] || m[3] || m[4]);
    var user = m && m[1] && !FB_RESERVED.test(m[1]) ? m[1] : null;
    if (!user && /\/videos\/|\/reel\/|\/watch/.test(location.pathname)) {
      // On a video's own page the title ends with "| <Page name> | Facebook".
      var parts = document.title.split(' | ');
      if (parts.length >= 3 && parts[parts.length - 1] === 'Facebook') user = parts[parts.length - 2];
    }
    return {
      user: user || 'facebook',
      pageUrl: id ? (m[1] && m[2] ? 'https://www.facebook.com/' + m[1] + '/videos/' + id + '/'
                                   : 'https://www.facebook.com/watch/?v=' + id) : location.href,
      name: (user || 'facebook') + '_' + (id || Date.now())
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
      return { mediaUrls: parts.map(bestVideo), pageUrl: r.pageUrl, name: r.name, user: r.user, kind: 'video' };
    }
    if (isThreads && video) {
      // yt-dlp cannot download Threads, so never fall back to it here.
      var p = threadsPost(video), s = httpSrc(video);
      var out = { mediaUrls: s ? [s] : [], pageUrl: p.pageUrl, name: p.name, user: p.user, kind: 'video' };
      if (s) return out;
      // Playing as a blob stream: read the real file URLs from the player.
      var pr = await probe(video).catch(function () { return null; });
      if (pr && pr.progressive) { out.mediaUrls = [pr.progressive]; return out; }
      if (pr && pr.dashVideo) {
        out.merge = { video: pr.dashVideo, audio: pr.dashAudio || null };
        return out;
      }
      throw new Error('Could not find this Threads video file' +
        (pr ? ' (player: ' + (pr.types.join(', ') || 'unknown') + ')' : ' (no player data)') +
        '. Try playing the video first, or open the post itself.');
    }
    if (isX && video) {
      // X streams video (HLS), so yt-dlp downloads it from the tweet URL.
      // GIFs are plain MP4 files and are fetched directly.
      var xp = xPost(video), xs = httpSrc(video);
      var xok = xs && !/\.(m3u8|mpd)(\?|$)/i.test(xs);
      return { mediaUrls: xok ? [xs] : [], pageUrl: xp.pageUrl, name: xp.name, user: xp.user, kind: 'video' };
    }
    if (isFB && video) {
      // Same Meta player as Threads: take the MP4 from the player's data,
      // else let yt-dlp try the post URL.
      var fp = fbPost(video);
      var fout = { mediaUrls: [], pageUrl: fp.pageUrl, name: fp.name, user: fp.user, kind: 'video' };
      var fs = httpSrc(video);
      if (fs) { fout.mediaUrls = [fs]; return fout; }
      var fpr = await probe(video).catch(function () { return null; });
      if (fpr && fpr.progressive) { fout.mediaUrls = [fpr.progressive]; return fout; }
      if (fpr && fpr.dashVideo) { fout.merge = { video: fpr.dashVideo, audio: fpr.dashAudio || null }; return fout; }
      return fout;
    }
    var src = video && httpSrc(video);
    // A plain file URL (not an HLS/DASH manifest) can be fetched directly.
    var ok = src && !/\.(m3u8|mpd)(\?|$)/i.test(src);
    return { mediaUrls: ok ? [src] : [], pageUrl: location.href, name: pageName(), user: null, kind: 'video' };
  }

  async function resolveCover(video) {
    var url = null, pageUrl = location.href, name = pageName(), user = null;
    if (isIG) {
      var r = await igLookup(video);
      var parts = matchByDuration(r.items.filter(function (x) { return x.video_versions; }), video);
      url = parts.length ? bestImage(parts[0]) : null;
      pageUrl = r.pageUrl; name = r.name; user = r.user;
      if (!url && /\/p\//.test(pageUrl)) url = await ogImage(pageUrl).catch(function () { return null; });
    } else if (isThreads) {
      var p = threadsPost(video);
      pageUrl = p.pageUrl; name = p.name; user = p.user;
      url = await ogImage(p.pageUrl.replace(/^https:\/\/www\.threads\.com/, location.origin))
        .catch(function () { return null; });
    } else if (isX) {
      var xc = xPost(video);
      pageUrl = xc.pageUrl; name = xc.name; user = xc.user;
      if (video && video.poster) url = xOriginal(video.poster);
    } else if (isFB) {
      var fc = fbPost(video);
      pageUrl = fc.pageUrl; name = fc.name; user = fc.user;
      if (fc.pageUrl !== location.href) {
        url = await ogImage(fc.pageUrl.replace(/^https:\/\/www\.facebook\.com/, location.origin))
          .catch(function () { return null; });
      }
    }
    if (!url && video && video.poster) url = video.poster;
    if (!url) url = await ogImage(location.href).catch(function () { return null; });
    if (!url) throw new Error('Could not find a cover image for this video');
    return { mediaUrls: [url], pageUrl: pageUrl, name: name + '_cover', user: user, kind: 'image' };
  }

  async function resolveImage(img) {
    var name = pageName(), pageUrl = location.href, user = null;
    if (isIG) {
      var m = location.pathname.match(/\/stories\/([^/]+)(?:\/(\d+))?/);
      if (m && m[1] !== 'highlights') {
        user = m[1]; name = m[1] + '_story_' + (m[2] || Date.now());
      } else {
        // Only used for the username / file name; the photo itself comes from the page.
        var r = await igLookup(img);
        user = r.user; name = r.name; pageUrl = r.pageUrl;
      }
    } else if (isThreads) {
      var p = threadsPost(img);
      name = p.name; pageUrl = p.pageUrl; user = p.user;
    } else if (isX) {
      var xi = xPost(img);
      name = xi.name; pageUrl = xi.pageUrl; user = xi.user;
      return { mediaUrls: [xOriginal(img.currentSrc || img.src)], pageUrl: pageUrl, name: name, user: user, kind: 'image' };
    } else if (isFB) {
      var fi = fbPost(img);
      name = fi.name; pageUrl = fi.pageUrl; user = fi.user;
    }
    return { mediaUrls: [largestImg(img)], pageUrl: pageUrl, name: name, user: user, kind: 'image' };
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
    if (!v && (isIG || isThreads || isX || isFB)) throw new Error('No video found on screen');
    return resolveVideo(v);
  }

  return {
    resolveVideo: resolveVideo,
    resolveCover: resolveCover,
    resolveImage: resolveImage,
    resolveVisible: resolveVisible,
    isBigImage: isBigImage,
    setProbe: function (fn) { probe = fn; }
  };
})();
