/* eslint-disable */
// @ts-nocheck
/**
 * The in-iframe snapshot-only chrome layered on top of the shared picker core
 * (`@piwitests/picker-dom`'s `installPickerOverlay`, run in `'postMessage'`
 * transport — see `snapshot-picker-document.ts`): pre-highlighting likely
 * elements, text search, extended inertness (nothing in a dead snapshot
 * should ever react), and reporting content height so the opaque-origin host
 * can size the iframe without reading its document.
 *
 * Authored as a self-contained function (no references to this module's
 * scope; all config passed as the single argument) and serialized into the
 * sandboxed DOM-snapshot iframe via `String(installSnapshotPickerExtras)`,
 * ahead of the shared core overlay in the same `<script>` tag.
 *
 * Lives in `shared/` (not `app/utils/`) so the document assembly that
 * serializes it can run both in the browser (demo `srcdoc`) and on the server
 * (the `dom-snapshot-frame` endpoint). `@ts-nocheck` because it is
 * browser-context DOM code that never executes in this module — it is only
 * ever stringified — which keeps the pure host-side helpers fully type-checked.
 */
export function installSnapshotPickerExtras() {
  var doc = document;
  var g = window;
  var Z = 2147483600;

  // ── Guidance: pre-highlight likely elements + text search ──────────────────
  // The host derives search hints from the healing result and drives a search
  // box; both find elements by visible text and outline them, so the user does
  // not have to hunt for the element the failing locator meant to hit.

  var hintBoxes = [];
  function clearHints() {
    for (var i = 0; i < hintBoxes.length; i++) {
      if (hintBoxes[i].parentNode) hintBoxes[i].parentNode.removeChild(hintBoxes[i]);
    }
    hintBoxes = [];
  }
  // Case and accents never matter, as in `foldText` (`#shared/utils/fold-text`), which this serialized code cannot import.
  function norm(s) {
    return (s || '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[\u00f8\u0142\u0111\u0127\u0131]/g, function (c) {
        return { '\u00f8': 'o', '\u0142': 'l', '\u0111': 'd', '\u0127': 'h', '\u0131': 'i' }[c];
      })
      .normalize('NFC');
  }
  function textMatches(hintText) {
    var q = norm(hintText);
    if (q.length < 2) return [];
    var all = doc.querySelectorAll(
      'button,a,[role],h1,h2,h3,h4,h5,h6,label,summary,input,textarea,select,option,span,li,td,th,p',
    );
    var exact = [];
    var partial = [];
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      var t = norm(el.textContent);
      if (!t) {
        var pl = norm((el.getAttribute && (el.getAttribute('placeholder') || el.getAttribute('aria-label'))) || '');
        if (pl && (pl === q || pl.indexOf(q) !== -1)) exact.push(el);
        continue;
      }
      if (t.length > 120) continue; // skip large containers
      if (t === q) exact.push(el);
      else if (t.indexOf(q) !== -1 && t.length < q.length + 30) partial.push(el);
    }
    return exact.concat(partial);
  }
  function box(el, color) {
    var r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return null;
    var b = doc.createElement('div');
    b.__piwiHint = true;
    b.style.cssText =
      'position:fixed;pointer-events:none;z-index:' +
      (Z + 1) +
      ';box-sizing:border-box;border-radius:3px;' +
      'transition:opacity .3s;border:2px solid ' +
      color +
      ';box-shadow:0 0 0 3px ' +
      color +
      '55;' +
      'left:' +
      r.left +
      'px;top:' +
      r.top +
      'px;width:' +
      r.width +
      'px;height:' +
      r.height +
      'px;';
    doc.body.appendChild(b);
    hintBoxes.push(b);
    return b;
  }
  function scrollHostTo(el) {
    var r = el.getBoundingClientRect();
    g.parent.postMessage({ type: 'piwiScrollTo', y: r.top }, '*');
  }
  function highlightHints(hints) {
    clearHints();
    if (!hints || !hints.length) return;
    var best = null;
    for (var i = 0; i < hints.length; i++) {
      var h = hints[i];
      var matches = textMatches(h && h.text);
      for (var j = 0; j < Math.min(matches.length, 3); j++) {
        box(matches[j], '#f59e0b');
        if (!best) best = matches[j];
      }
    }
    if (best) scrollHostTo(best);
    // Fade after a few seconds so the outlines never obscure the pick target.
    setTimeout(function () {
      for (var i = 0; i < hintBoxes.length; i++) hintBoxes[i].style.opacity = '0';
    }, 2600);
    setTimeout(clearHints, 3000);
  }
  var searchMatches = [];
  var searchIdx = 0;
  function reportSearch() {
    g.parent.postMessage(
      { type: 'piwiSearchResult', count: searchMatches.length, index: searchMatches.length ? searchIdx : -1 },
      '*',
    );
  }
  function focusSearchMatch() {
    clearHints();
    var el = searchMatches[searchIdx];
    if (!el) return;
    box(el, '#7c3aed');
    scrollHostTo(el);
    reportSearch();
  }
  function doSearch(q) {
    searchMatches = textMatches(q);
    searchIdx = 0;
    if (!searchMatches.length) {
      clearHints();
      reportSearch();
      return;
    }
    focusSearchMatch();
  }
  function cycleSearch() {
    if (!searchMatches.length) return;
    searchIdx = (searchIdx + 1) % searchMatches.length;
    focusSearchMatch();
  }

  // The iframe rarely holds keyboard focus — the modal's focus-trap keeps it in
  // the parent — so the host forwards search/highlight guidance commands here.
  // Arrow/Esc key forwarding is the shared core overlay's own concern
  // (`piwiPickerKey`, handled by `installPickerOverlay` itself).
  function onParentMsg(e) {
    var d = e.data;
    if (!d || typeof d.type !== 'string') return;
    if (d.type === 'piwiHighlight') {
      try {
        highlightHints(d.hints);
      } catch (err) {}
    } else if (d.type === 'piwiSearch') {
      try {
        doSearch(d.q);
      } catch (err) {}
    } else if (d.type === 'piwiSearchNext') {
      try {
        cycleSearch();
      } catch (err) {}
    } else if (d.type === 'piwiClearHints') {
      try {
        clearHints();
      } catch (err) {}
    }
  }
  g.addEventListener('message', onParentMsg, false);

  // Every interaction the snapshot must swallow so it behaves as an inert
  // picture: a click must never navigate a link, submit a form, activate a
  // control, type into a field, or start a drag/selection. `mousemove`, `click`
  // and `keydown` are the shared core overlay's own concern; this list stays
  // installed for the whole picker lifetime, on top of the core's own (looser)
  // suppression — intentionally STRICTER than the reporter's live picker, which
  // runs on a real page the user may still want to interact with. Here the page
  // is a dead snapshot, so nothing should react.
  function stop(e) {
    e.preventDefault();
    e.stopImmediatePropagation();
  }
  var INERT_EVENTS = [
    'mousedown',
    'mouseup',
    'pointerdown',
    'pointerup',
    'auxclick',
    'dblclick',
    'contextmenu',
    'submit',
    'beforeinput',
    'input',
    'change',
    'paste',
    'cut',
    'drop',
    'dragstart',
    'keypress',
    'keyup',
    'touchstart',
    'touchend',
  ];
  for (var i = 0; i < INERT_EVENTS.length; i++) doc.addEventListener(INERT_EVENTS[i], stop, true);

  g.__piwiSnapshotExtras = {
    onPick: function () {
      clearHints();
    },
    onClose: function () {
      clearHints();
      g.removeEventListener('message', onParentMsg, false);
      for (var i = 0; i < INERT_EVENTS.length; i++) doc.removeEventListener(INERT_EVENTS[i], stop, true);
    },
  };

  // ── Report full content height so the host can size the (opaque-origin)
  // iframe without reading its document. Replaces parent-side measurement. ────
  function reportHeight() {
    var h = Math.max(doc.documentElement ? doc.documentElement.scrollHeight : 0, doc.body ? doc.body.scrollHeight : 0);
    if (h > 0) g.parent.postMessage({ type: 'piwiContentHeight', height: h }, '*');
  }
  reportHeight();
  try {
    if (g.ResizeObserver) {
      var ro = new g.ResizeObserver(reportHeight);
      if (doc.documentElement) ro.observe(doc.documentElement);
      if (doc.body) ro.observe(doc.body);
    }
  } catch (err) {
    /* height stays at the recorded viewport */
  }
}

/**
 * Applies, in the snapshot iframe, the live state the renderer could only mark
 * (`renderedAttributes` in `server/utils/dom-snapshot-render.ts` writes the
 * `data-piwi-*` markers): the custom elements the page had defined, so its
 * `:defined` styles match; modal dialogs and open popovers in the top layer;
 * every element's scroll offsets; an outline on the action's target. It runs
 * first in both the picker and the read-only documents, so the picker overlay
 * installs over the page as it was. A browser without declarative shadow DOM
 * gets its shadow roots attached here too. The page's own scroll offset can't
 * apply in a frame as tall as its content, so it goes to the host as
 * `piwiScrollTo`, right after the frame's height; an open modal dialog or
 * popover goes instead, being what the page showed on top. Serialized with
 * `String(...)`, like the scripts around it.
 */
export function restoreSnapshotState() {
  var doc = document;
  var g = window;

  // The document and every open shadow root in it.
  var roots = [doc];
  for (var r = 0; r < roots.length; r++) {
    var templates = roots[r].querySelectorAll('template[shadowrootmode]');
    for (var t = 0; t < templates.length; t++) {
      var host = templates[t].parentNode;
      try {
        if (host && host.nodeType === 1 && !host.shadowRoot) {
          host.attachShadow({ mode: 'open' }).appendChild(templates[t].content);
          templates[t].remove();
        }
      } catch (err) {}
    }
    var all = roots[r].querySelectorAll('*');
    for (var a = 0; a < all.length; a++) if (all[a].shadowRoot) roots.push(all[a].shadowRoot);
  }
  function each(selector, apply) {
    var found = [];
    for (var i = 0; i < roots.length; i++) {
      var matches = roots[i].querySelectorAll(selector);
      for (var j = 0; j < matches.length; j++) found.push(matches[j]);
    }
    for (var k = 0; k < found.length; k++) {
      try {
        apply(found[k]);
      } catch (err) {}
    }
    return found;
  }

  var names = ((doc.body && doc.body.getAttribute('data-piwi-custom-elements')) || '').split(',');
  for (var n = 0; n < names.length; n++) {
    try {
      if (names[n] && g.customElements && !g.customElements.get(names[n])) {
        g.customElements.define(names[n], class extends HTMLElement {});
      }
    } catch (err) {}
  }

  // A modal stays open: no Escape, no close request.
  doc.addEventListener(
    'cancel',
    function (e) {
      e.preventDefault();
    },
    true,
  );
  // Inert while it opens, so it focuses nothing and keyboard focus stays in the host page.
  var modals = each('dialog[data-piwi-modal]', function (el) {
    el.removeAttribute('open');
    el.inert = true;
    try {
      el.showModal();
    } catch (err) {
      el.setAttribute('open', '');
    }
    el.inert = false;
  });
  // Manual, so neither a click nor another popover dismisses it.
  var popovers = each('[data-piwi-popover-open]', function (el) {
    el.setAttribute('popover', 'manual');
    el.showPopover();
  });

  each('[data-piwi-target]', function (el) {
    el.style.setProperty('outline', '2px solid #2563eb', 'important');
    el.style.setProperty('outline-offset', '1px', 'important');
  });

  var pageY = 0;
  function scroll() {
    each('[data-piwi-scroll-top],[data-piwi-scroll-left]', function (el) {
      var top = Number(el.getAttribute('data-piwi-scroll-top')) || 0;
      if (el === doc.documentElement || el === doc.body) {
        pageY = top;
        return;
      }
      el.scrollTop = top;
      el.scrollLeft = Number(el.getAttribute('data-piwi-scroll-left')) || 0;
    });
  }
  scroll();
  // Images change scroll heights as they load, so the offsets apply again then.
  g.addEventListener('load', scroll);

  // The height goes first, so the host's canvas is tall enough to scroll to y.
  setTimeout(function () {
    var onTop = modals[0] || popovers[0];
    var y = onTop ? onTop.getBoundingClientRect().top : pageY;
    if (y <= 0) return;
    var height = Math.max(doc.documentElement.scrollHeight, (doc.body && doc.body.scrollHeight) || 0);
    g.parent.postMessage({ type: 'piwiContentHeight', height: height }, '*');
    g.parent.postMessage({ type: 'piwiScrollTo', y: y }, '*');
  }, 0);
}

/**
 * The read-only variant's in-iframe script: no picking overlay, just make the
 * snapshot inert (no navigation, no submits) and report its content height over
 * `postMessage` so the host can size the opaque-origin iframe. Kept here (with
 * the picker extras, `@ts-nocheck`) because it is browser-context code that only
 * ever runs after being serialized with `String(...)` — never in this module.
 */
export function readonlySnapshotScript() {
  var post = function () {
    var docEl = document.documentElement;
    var height = Math.max(docEl.scrollHeight, docEl.offsetHeight, (document.body && document.body.scrollHeight) || 0);
    parent.postMessage({ type: 'piwiContentHeight', height: height }, '*');
  };
  // Neutralize anything that would navigate or mutate away from the snapshot.
  document.addEventListener(
    'click',
    function (event) {
      var anchor = event.target && event.target.closest && event.target.closest('a,button,[type=submit]');
      if (anchor) event.preventDefault();
    },
    true,
  );
  document.addEventListener(
    'submit',
    function (event) {
      event.preventDefault();
    },
    true,
  );
  if (document.readyState === 'complete' || document.readyState === 'interactive') post();
  else document.addEventListener('DOMContentLoaded', post);
  addEventListener('load', post);
  try {
    new ResizeObserver(function () {
      post();
    }).observe(document.documentElement);
  } catch (err) {
    /* ResizeObserver may be unavailable — the load handler still reports once. */
  }
}
