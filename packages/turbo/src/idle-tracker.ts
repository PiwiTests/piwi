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
  let pending = 0;
  let serviceWorkerListener = false;
  const settle = () => { pending--; };
  const track = (result) => {
    if (result && typeof result.then === 'function') {
      pending++;
      result.then(settle, settle);
    }
    return result;
  };
  const trackMethods = (target, names) => {
    if (!target) return;
    for (const name of names) {
      const method = target[name];
      if (typeof method !== 'function') continue;
      target[name] = function () { return track(method.apply(this, arguments)); };
    }
  };
  const prototypeOf = (name) => g[name] && g[name].prototype;
  // Work the page can wait on with no request, timer or frame of its own.
  trackMethods(prototypeOf('SubtleCrypto'), ['encrypt', 'decrypt', 'sign', 'verify', 'digest', 'generateKey', 'deriveKey', 'deriveBits', 'importKey', 'exportKey', 'wrapKey', 'unwrapKey']);
  trackMethods(prototypeOf('CacheStorage'), ['open', 'match', 'has', 'delete', 'keys']);
  trackMethods(prototypeOf('Cache'), ['match', 'matchAll', 'add', 'addAll', 'put', 'delete', 'keys']);
  trackMethods(prototypeOf('StorageManager'), ['getDirectory', 'estimate', 'persist', 'persisted']);
  trackMethods(prototypeOf('FileSystemDirectoryHandle'), ['getFileHandle', 'getDirectoryHandle', 'removeEntry', 'resolve']);
  trackMethods(prototypeOf('FileSystemFileHandle'), ['getFile', 'createWritable', 'createSyncAccessHandle']);
  trackMethods(prototypeOf('FileSystemWritableFileStream'), ['write', 'seek', 'truncate', 'close']);
  trackMethods(prototypeOf('Response'), ['text', 'json', 'arrayBuffer', 'blob', 'formData', 'bytes']);
  trackMethods(prototypeOf('Blob'), ['text', 'arrayBuffer', 'bytes']);
  trackMethods(prototypeOf('HTMLImageElement'), ['decode']);
  trackMethods(prototypeOf('ServiceWorkerContainer'), ['register', 'getRegistration', 'getRegistrations']);
  trackMethods(g, ['createImageBitmap']);
  trackMethods(g.WebAssembly, ['compile', 'instantiate', 'compileStreaming', 'instantiateStreaming']);
  // IndexedDB: a request until it succeeds or fails, a transaction until it completes or aborts.
  const until = (target, events) => {
    pending++;
    let open = true;
    const end = () => { if (open) { open = false; pending--; } };
    for (const event of events) target.addEventListener(event, end, { once: true });
    return target;
  };
  if (g.IDBFactory) {
    for (const name of ['open', 'deleteDatabase']) {
      const method = g.IDBFactory.prototype[name];
      g.IDBFactory.prototype[name] = function () { return until(method.apply(this, arguments), ['success', 'error']); };
    }
  }
  if (g.IDBDatabase) {
    const transaction = g.IDBDatabase.prototype.transaction;
    g.IDBDatabase.prototype.transaction = function () { return until(transaction.apply(this, arguments), ['complete', 'abort', 'error']); };
  }
  // A service worker can post to a page that listens to it at any time.
  if (g.ServiceWorkerContainer) {
    const proto = g.ServiceWorkerContainer.prototype;
    const addEventListener = proto.addEventListener;
    proto.addEventListener = function (type) {
      if (type === 'message') serviceWorkerListener = true;
      return addEventListener.apply(this, arguments);
    };
    const onmessage = Object.getOwnPropertyDescriptor(proto, 'onmessage');
    if (onmessage && onmessage.set) {
      Object.defineProperty(proto, 'onmessage', { ...onmessage, set(handler) { serviceWorkerListener = true; return onmessage.set.call(this, handler); } });
    }
  }
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
  for (const name of ['WebSocket', 'EventSource', 'Worker', 'SharedWorker', 'BroadcastChannel']) {
    if (!g[name]) continue;
    g[name] = new Proxy(g[name], { construct(target, args, newTarget) {
      const instance = Reflect.construct(target, args, newTarget);
      live.add(instance);
      return instance;
    } });
  }
  // A terminated worker and a closed channel post nothing more.
  for (const [name, method] of [['Worker', 'terminate'], ['BroadcastChannel', 'close']]) {
    const proto = prototypeOf(name);
    if (!proto || typeof proto[method] !== 'function') continue;
    const end = proto[method];
    proto[method] = function () { live.delete(this); return end.apply(this, arguments); };
  }
  g.__piwiTurboIdle = (ms) => {
    if (document.readyState !== 'complete') return false;
    if (requests > 0 || pending > 0 || repeating.size || frames.size || idleCallbacks.size) return false;
    if (serviceWorkerListener && navigator.serviceWorker && navigator.serviceWorker.controller) return false;
    for (const instance of live) {
      // A worker and a channel can always post a message; a socket or event source until it is closed.
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
