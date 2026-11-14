// The page side of the fail-fast hook: an init script that keeps count of what could still change the page, and
// `globalThis.__piwiTurboIdle(ms)`, true when nothing can within `ms` milliseconds.
export const IDLE_TRACKER = `(() => {
  const g = globalThis;
  if (g.__piwiTurboIdle) return;
  const now = () => performance.now();
  const timeouts = new Map();
  const repeating = new Set();
  const frames = new Set();
  const idleCallbacks = new Set();
  const live = new Set();
  let requests = 0;
  const original = {
    setTimeout: g.setTimeout, clearTimeout: g.clearTimeout, setInterval: g.setInterval, clearInterval: g.clearInterval,
    requestAnimationFrame: g.requestAnimationFrame, cancelAnimationFrame: g.cancelAnimationFrame,
    requestIdleCallback: g.requestIdleCallback, cancelIdleCallback: g.cancelIdleCallback,
  };
  const run = (handler, self, args) => (typeof handler === 'function' ? handler.apply(self, args) : (0, eval)(String(handler)));
  g.setTimeout = function (handler, delay, ...rest) {
    const id = original.setTimeout.call(this, function () { timeouts.delete(id); return run(handler, this, arguments); }, delay, ...rest);
    timeouts.set(id, now() + Math.max(0, Number(delay) || 0));
    return id;
  };
  g.setInterval = function (handler, delay, ...rest) {
    const id = original.setInterval.call(this, handler, delay, ...rest);
    repeating.add(id);
    return id;
  };
  g.clearTimeout = g.clearInterval = function (id) {
    timeouts.delete(id);
    repeating.delete(id);
    return original.clearTimeout.call(this, id);
  };
  if (original.requestAnimationFrame) {
    g.requestAnimationFrame = function (callback) {
      const id = original.requestAnimationFrame.call(this, (time) => { frames.delete(id); callback(time); });
      frames.add(id);
      return id;
    };
    g.cancelAnimationFrame = function (id) { frames.delete(id); return original.cancelAnimationFrame.call(this, id); };
  }
  if (original.requestIdleCallback) {
    g.requestIdleCallback = function (callback, options) {
      const id = original.requestIdleCallback.call(this, (deadline) => { idleCallbacks.delete(id); callback(deadline); }, options);
      idleCallbacks.add(id);
      return id;
    };
    g.cancelIdleCallback = function (id) { idleCallbacks.delete(id); return original.cancelIdleCallback.call(this, id); };
  }
  if (g.fetch) {
    const fetch = g.fetch;
    g.fetch = function () {
      requests++;
      return fetch.apply(this, arguments).finally(() => { requests--; });
    };
  }
  if (g.XMLHttpRequest) {
    const send = g.XMLHttpRequest.prototype.send;
    g.XMLHttpRequest.prototype.send = function () {
      requests++;
      this.addEventListener('loadend', () => { requests--; }, { once: true });
      return send.apply(this, arguments);
    };
  }
  for (const name of ['WebSocket', 'EventSource', 'Worker', 'SharedWorker']) {
    if (!g[name]) continue;
    g[name] = new Proxy(g[name], { construct(target, args, newTarget) {
      const instance = Reflect.construct(target, args, newTarget);
      live.add(instance);
      return instance;
    } });
  }
  g.__piwiTurboIdle = (ms) => {
    if (document.readyState !== 'complete') return false;
    if (requests > 0 || repeating.size || frames.size || idleCallbacks.size) return false;
    for (const instance of live) {
      // A worker can always post a message; a socket or event source until it is closed.
      if (!('readyState' in instance) || instance.readyState !== (instance instanceof g.WebSocket ? 3 : 2)) return false;
    }
    const horizon = now() + ms;
    for (const due of timeouts.values()) if (due <= horizon) return false;
    if (document.getAnimations && document.getAnimations().some((a) => a.pending || a.playState === 'running')) return false;
    for (const media of document.querySelectorAll('video, audio')) if (!media.paused) return false;
    if (document.fonts && document.fonts.status === 'loading') return false;
    return true;
  };
})();`;
