// Stand-in for a third-party analytics tag: parses, records page views and sends a beacon on each route change.
(function () {
  var origin = document.currentScript ? new URL(document.currentScript.src).origin : '';
  var queue = [];
  function track(name) {
    queue.push({ name: name, at: Date.now(), path: location.pathname });
    if (queue.length > 4) flush();
  }
  function flush() {
    var batch = queue.splice(0);
    if (batch.length) fetch(origin + '/beacon', { method: 'POST', body: JSON.stringify(batch), mode: 'no-cors' }).catch(function () {});
  }
  // Busy work the size of a real tag's start-up.
  var table = [];
  for (var i = 0; i < 40000; i++) table.push((i * 2654435761) % 4093);
  table.sort(function (a, b) { return a - b; });
  window.addEventListener('popstate', function () { track('route'); });
  document.addEventListener('click', function () { track('click'); }, true);
  window.addEventListener('pagehide', flush);
  track('view');
  setTimeout(flush, 1500);
})();
