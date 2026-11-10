// Appended after extension/resolve.js for the Safari keyboard shortcuts
// (Quick Actions run it with AppleScript "do JavaScript"). AppleScript cannot
// wait for a Promise, so the result is left in window.__vddResult for it to
// pick up and POST to the helper.
window.__vddResult = '';
(function () {
  function done(o) { o.source = 'safari'; window.__vddResult = JSON.stringify(o); }
  if (/^(127\.0\.0\.1|localhost)$/.test(location.hostname)) {
    return done({ error: 'Open an Instagram or Threads post first, then press the shortcut there.' });
  }
  VDDResolve.resolveVisible('__KIND__').then(done, function (e) { done({ error: e.message }); });
})();
