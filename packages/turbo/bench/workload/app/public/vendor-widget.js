// Stand-in for a third-party chat widget: a floating button and a presence ping every two seconds.
(function () {
  var origin = document.currentScript ? new URL(document.currentScript.src).origin : '';
  var button = document.createElement('button');
  button.id = 'vendor-chat';
  button.type = 'button';
  button.setAttribute('aria-label', 'Open support chat');
  button.textContent = '?';
  button.style.cssText =
    'position:fixed;right:20px;bottom:20px;width:44px;height:44px;border-radius:50%;border:0;background:#111827;' +
    'color:#fff;font:600 18px system-ui;box-shadow:0 6px 18px rgba(0,0,0,.25);z-index:5;cursor:pointer;' +
    'transition:transform .3s ease;transform:scale(.6)';
  document.body.appendChild(button);
  requestAnimationFrame(function () { button.style.transform = 'scale(1)'; });
  setInterval(function () {
    fetch(origin + '/beacon?presence=1', { mode: 'no-cors' }).catch(function () {});
  }, 2000);
})();
