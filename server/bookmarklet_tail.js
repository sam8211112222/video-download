// Appended after extension/resolve.js to build the Safari bookmarklet.
// Opens the helper window right away (keeps the click's user gesture so
// Safari doesn't block the pop-up), then points it at the helper.
if (/^(127\.0\.0\.1|localhost)$/.test(location.hostname)) {
  alert('VDD: 請先打開 Instagram 或 Threads 的貼文，再按這個書籤。\nOpen an Instagram or Threads post first, then click this bookmark.');
} else {
var w = window.open('about:blank', 'vdd', 'width=560,height=380');
VDDResolve.resolveVisible('__KIND__').then(function (i) {
  var q = 'page=' + encodeURIComponent(i.pageUrl) + '&name=' + encodeURIComponent(i.name) + '&browser=safari' + (i.user ? '&user=' + encodeURIComponent(i.user) : '');
  i.mediaUrls.forEach(function (u) { q += '&media=' + encodeURIComponent(u); });
  if (i.merge) q += '&mergeVideo=' + encodeURIComponent(i.merge.video) + (i.merge.audio ? '&mergeAudio=' + encodeURIComponent(i.merge.audio) : '');
  var url = 'http://127.0.0.1:__PORT__/dl?' + q;
  if (w) w.location.href = url; else location.href = url;
}, function (e) { if (w) w.close(); alert('VDD: ' + e.message); });
}
