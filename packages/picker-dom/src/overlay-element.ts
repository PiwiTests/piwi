import type { ProbeArg } from './types.js';

/** The overlay's texts a host may give in its own language; each one left out is the English default. */
export interface PickerOverlayStrings {
  /** The banner's heading for the `'global'` transport with no failing locator. */
  banner?: string;
  /** The banner's foot before an element is hovered: the keys, Enter picking the focused element. */
  keys?: string;
  /** The banner's foot while an element is hovered: a click or Enter picks it. */
  keysHovering?: string;
  /** The banner's foot once an element is picked. */
  analyzing?: string;
}

/** Configuration for `installPickerOverlay` — see the function doc for the transport split. */
export interface PickerOverlayArg {
  transport: 'global' | 'postMessage';
  /** Rendered failing locator for the banner heading (`'global'` transport only). */
  failing?: string | null;
  /** Probe arguments for the inline probe the `'postMessage'` transport performs on pick. */
  probeArg?: ProbeArg;
  /** The banner's texts, for a host that shows another language than English. */
  strings?: PickerOverlayStrings;
  /**
   * The attribute `getByTestId` reads in the project (Playwright's
   * `testIdAttribute`); `data-testid` when null or absent. The overlay's own
   * description of an element and its snapping to a test id read it.
   */
  testIdAttribute?: string | null;
}

/**
 * Runs inside the browser — installs the element-picking overlay: a hover
 * highlight, an instruction banner, and capture-phase listeners that suppress
 * the app's own handlers while picking. The hover target snaps to the nearest
 * actionable ancestor (button/link/field/role/test id) and up/down walk the
 * DOM chain before the click commits. The hover reaches into open shadow
 * roots, and the chain walks out of them through each host. Enter picks the
 * outlined element, or with none the focused one, so a control reached with
 * Tab is picked without the pointer.
 *
 * `transport` picks how a pick/skip is reported, since the two hosts cross
 * fundamentally different boundaries:
 *  - `'global'` — the reporter drives a live page from Node over CDP. The
 *    picked element is parked on `globalThis.__piwiPickedElement` and
 *    `__piwiPickState` is set to `'picked'`/`'skipped'`, polled from Node;
 *    probing happens later, from Node, against a live element handle.
 *  - `'postMessage'` — the snapshot picker runs standalone inside a sandboxed
 *    opaque-origin iframe with nothing outside able to reach in, so the pick
 *    is probed and posted to `window.parent` in the same tick. The probe
 *    itself can't be imported (a serialized function carries no imports), so
 *    the embedding host installs it on `globalThis.__piwiProbe` before
 *    invoking this function, and may install lifecycle hooks on
 *    `globalThis.__piwiSnapshotExtras` (`onPick`/`onClose`) for its own
 *    snapshot-only chrome (search, highlight hints, extended inertness).
 *
 * The banner is in English unless `arg.strings` gives its texts.
 *
 * The hovered element's locator is shown twice — in a chip pinned to the
 * element itself and on its own line in the banner. Both render whatever
 * `globalThis.__piwiDescribeElement(el)` returns when a host installs one (the
 * extension points it at the real ranked locator engine), falling back to this
 * function's own attribute-order approximation. A host whose answer improves
 * later (checked against the page once the pointer rests) calls
 * `globalThis.__piwiRedescribe()` to have the hovered element described again.
 *
 * Must stay fully self-contained (no module-closure references) — both hosts
 * re-serialize this function via `Function.prototype.toString()` (the
 * reporter through `page.evaluate`, the snapshot picker through `String()`
 * into a `<script>` tag).
 */
export function installPickerOverlay(arg: PickerOverlayArg): void {
  const g = globalThis as any;
  const doc = g.document;
  if (!doc || !doc.body) {
    if (arg.transport === 'postMessage') g.parent.postMessage({ type: 'pickerClosed' }, '*');
    else g.__piwiPickState = 'skipped';
    return;
  }
  const Z = 2147483600;
  const testIdAttr = arg.testIdAttribute || 'data-testid';
  // The snapshot picker's host forwards the arrows only, so its keys leave Enter out.
  const enterReaches = arg.transport === 'global';
  const words = {
    banner: 'Piwi inspector — click any element to generate locators for it',
    keys: enterReaches
      ? 'Enter picks the focused element · ↑ parent · ↓ child · Esc skip'
      : '↑ parent · ↓ child · Esc skip',
    keysHovering: enterReaches
      ? 'click or Enter to pick · ↑ parent · ↓ child · Esc skip'
      : 'click to pick · ↑ parent · ↓ child · Esc skip',
    analyzing: 'Analyzing element…',
  };
  for (const key of Object.keys(words) as Array<keyof typeof words>) {
    const given = arg.strings?.[key];
    if (typeof given === 'string' && given) words[key] = given;
  }

  // A light hairline outside the purple ring and a dark one outside that, so the
  // highlight keeps its edge over white, black and busy backgrounds alike.
  const highlight = doc.createElement('div');
  highlight.id = '__piwi_picker_highlight';
  highlight.style.cssText =
    `position:fixed;pointer-events:none;z-index:${Z};display:none;box-sizing:border-box;` +
    'border:2px solid #a855f7;background:rgba(168,85,247,.14);border-radius:4px;' +
    'box-shadow:0 0 0 1px rgba(255,255,255,.9),0 0 0 3px rgba(59,7,100,.55),inset 0 0 0 1px rgba(255,255,255,.5);';
  const banner = doc.createElement('div');
  banner.id = '__piwi_picker_banner';
  banner.style.cssText =
    `position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:${Z + 2};` +
    'background:#111827;color:#f9fafb;font:13px/1.5 system-ui,sans-serif;border:1px solid #312e81;' +
    'padding:10px 16px;border-radius:10px;box-shadow:0 4px 24px rgba(0,0,0,.5);max-width:min(680px,86vw);';
  // Syntax-highlight a Playwright locator expression to inline-styled HTML —
  // method purple, option keys blue, strings green, literals amber, punctuation
  // muted; the palette is read on the dark chips this overlay mounts. Nested
  // rather than imported, and kept in sync by hand with `syntax-highlight.ts`
  // and the copy in overlay-confirm.ts: each must stay self-contained, since
  // each is serialized independently.
  const hlTokens = (expr: string): string => {
    const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const re =
      /('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")|([A-Za-z_$][\w$]*)(?=\s*\()|([A-Za-z_$][\w$]*)(?=\s*:)|(true|false|null|\d+)|([{}(),.])/g;
    let html = '';
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(expr)) !== null) {
      if (m.index > last) html += escHtml(expr.slice(last, m.index));
      const color = m[1] ? '#86efac' : m[2] ? '#d8b4fe' : m[3] ? '#93c5fd' : m[4] ? '#fcd34d' : '#9ca3af';
      html += `<span style="color:${color}">${escHtml(m[0])}</span>`;
      last = re.lastIndex;
    }
    if (last < expr.length) html += escHtml(expr.slice(last));
    return html;
  };
  const MONO = 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace';
  const hlLocator = (expr: string): string => `<code style="font-family:${MONO}">${hlTokens(expr)}</code>`;
  const head = doc.createElement('div');
  if (arg.transport === 'postMessage') head.textContent = 'Click an element to generate locators';
  else if (arg.failing)
    head.innerHTML = `Piwi locator picker — click the element that should replace ${hlLocator(arg.failing)}`;
  else head.textContent = words.banner;
  // The hovered element's locator, given a line of its own at reading size
  // rather than tucked into the hint text.
  const locatorLine = doc.createElement('div');
  locatorLine.id = '__piwi_picker_locator';
  locatorLine.style.cssText =
    'display:none;margin-top:7px;padding:5px 9px;border-radius:7px;background:#0b1120;' +
    `border:1px solid #4c1d95;font:13.5px/1.55 ${MONO};word-break:break-word;overflow-wrap:anywhere;`;
  const foot = doc.createElement('div');
  foot.id = '__piwi_picker_foot';
  foot.style.cssText = 'color:#9ca3af;margin-top:6px;font-size:12px;';
  foot.textContent = words.keys;
  banner.appendChild(head);
  banner.appendChild(locatorLine);
  banner.appendChild(foot);

  // The same locator pinned to the element itself, so the eye never has to
  // travel to the banner and back to know what a hover would produce.
  const label = doc.createElement('div');
  label.id = '__piwi_picker_label';
  label.style.cssText =
    `position:fixed;pointer-events:none;z-index:${Z + 1};display:none;box-sizing:border-box;` +
    'max-width:min(620px,92vw);background:#0b1120;color:#f9fafb;border:1px solid #7c3aed;' +
    `border-radius:7px;padding:4px 8px;font:12.5px/1.45 ${MONO};white-space:nowrap;` +
    'overflow:hidden;text-overflow:ellipsis;box-shadow:0 4px 18px rgba(0,0,0,.5);';
  // A modal dialog the page opened sits in the top layer and makes the rest of
  // the page inert: the overlay goes at its end, unless the dialog lays out
  // \`position: fixed\` children in its own box (a transform, a filter,
  // containment…), and back to the body when it closes.
  const mountParent = (): any => {
    let modal: any = null;
    try {
      modal = doc.querySelector('dialog:modal');
    } catch {
      modal = null;
    }
    if (!modal) return doc.body;
    const s = g.getComputedStyle(modal);
    const holdsFixed =
      s.transform !== 'none' ||
      s.perspective !== 'none' ||
      s.filter !== 'none' ||
      /\b(paint|layout|strict|content)\b/.test(s.contain) ||
      /\b(transform|perspective|filter)\b/.test(s.willChange);
    return holdsFixed ? doc.body : modal;
  };
  const mount = (...nodes: any[]) => {
    const parent = mountParent();
    for (const node of nodes) parent.appendChild(node);
    if (parent !== doc.body) {
      parent.addEventListener(
        'close',
        () => {
          for (const node of nodes) if (node.parentNode === parent) doc.body.appendChild(node);
        },
        { once: true },
      );
    }
  };
  mount(highlight, label, banner);

  // Short descriptor of an element for the banner breadcrumb. The overlay runs
  // serialized in the page, so it carries its own copy of core's `quoteJsString`.
  const quoteJs = (s: string) =>
    `'${JSON.stringify(s)
      .slice(1, -1)
      .replace(/\\"/g, '"')
      .replace(/'/g, "\\'")
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029')}'`;
  const describe = (el: any): string => {
    const tag = (el.tagName || '?').toLowerCase();

    const testId = el.getAttribute && el.getAttribute(testIdAttr);
    if (testId) return `getByTestId(${quoteJs(testId)})`;

    if (el.labels && el.labels.length > 0) {
      const labelText = (el.labels[0].textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);
      if (labelText) return `getByLabel(${quoteJs(labelText)})`;
    }

    const ariaLabel = el.getAttribute && el.getAttribute('aria-label');
    if (ariaLabel) return `getByLabel(${quoteJs(ariaLabel)})`;

    const placeholder = el.getAttribute && el.getAttribute('placeholder');
    if (placeholder) return `getByPlaceholder(${quoteJs(placeholder)})`;

    const alt = el.getAttribute && el.getAttribute('alt');
    if (alt) return `getByAltText(${quoteJs(alt)})`;

    const titleAttr = el.getAttribute && el.getAttribute('title');
    if (titleAttr) return `getByTitle(${quoteJs(titleAttr)})`;

    if (el.id) return `locator(${quoteJs(`#${el.id}`)})`;

    const cls = ((el.getAttribute && el.getAttribute('class')) || '').split(/\s+/).find((c: string) => c.length > 1);
    return cls ? `locator(${quoteJs(`.${cls}`)})` : tag;
  };

  // An element's parent, out through its shadow root's host at the top of an
  // open shadow root, so a chain started inside a web component reaches the page.
  const parentOf = (node: any): any => {
    if (node.parentElement) return node.parentElement;
    const root = node.getRootNode ? node.getRootNode() : null;
    return root && root !== doc && root.host ? root.host : null;
  };

  // The element an event happened on, inside open shadow roots: the browser
  // retargets `target` to the outermost host, the composed path keeps the
  // innermost element. A closed shadow root stays at its host.
  const targetOf = (e: any): any => {
    const path = typeof e.composedPath === 'function' ? e.composedPath() : null;
    const first = path && path.length ? path[0] : null;
    return first && first.nodeType === 1 ? first : e.target;
  };

  // The hover chain: raw target up to (not including) body, capped.
  const buildChain = (raw: any): any[] => {
    const chain: any[] = [];
    let node = raw;
    while (node && chain.length < 15) {
      const tag = (node.tagName || '').toLowerCase();
      if (tag === 'body' || tag === 'html') break;
      chain.push(node);
      node = parentOf(node);
    }
    return chain.length ? chain : [raw];
  };

  // Snap the initial pick to the nearest actionable ancestor — a click lands
  // on the <span> inside a button, but the button is what the test targets.
  const ACTIONABLE_TAGS = ['button', 'a', 'input', 'select', 'textarea', 'summary', 'option'];
  const snapIndex = (chain: any[]): number => {
    for (let i = 0; i < Math.min(chain.length, 4); i++) {
      const el = chain[i];
      const tag = (el.tagName || '').toLowerCase();
      if (ACTIONABLE_TAGS.includes(tag)) return i;
      if (el.getAttribute && (el.getAttribute('role') || el.getAttribute(testIdAttr))) return i;
    }
    return 0;
  };

  // The host's locator engine when one is installed, else the approximation
  // above. Called once per element the hover settles on, not once per mouse
  // move — a real engine ranks every candidate, which is not free.
  const locatorOf = (el: any): string => {
    const hook = g.__piwiDescribeElement;
    if (typeof hook === 'function') {
      try {
        const derived = hook(el);
        if (typeof derived === 'string' && derived) return derived;
      } catch {
        // Fall through to the built-in descriptor.
      }
    }
    return describe(el);
  };

  let chain: any[] = [];
  let idx = 0;
  let lastRaw: any = null;
  let labeled: any = null;

  // Pin the chip above the element, flipping below when the top edge is too
  // close to the viewport, and keep it inside the horizontal bounds.
  const placeLabel = (r: any) => {
    label.style.display = 'block';
    const lr = label.getBoundingClientRect();
    const vw = g.innerWidth || doc.documentElement.clientWidth || 0;
    const vh = g.innerHeight || doc.documentElement.clientHeight || 0;
    let top = r.top - lr.height - 6;
    if (top < 4) top = r.bottom + 6;
    if (top + lr.height > vh - 4) top = Math.max(4, vh - lr.height - 4);
    let left = r.left;
    if (left + lr.width > vw - 6) left = vw - lr.width - 6;
    if (left < 6) left = 6;
    label.style.left = left + 'px';
    label.style.top = top + 'px';
  };

  const current = (): any => chain[idx] ?? null;
  const refresh = () => {
    const el = current();
    if (!el) {
      highlight.style.display = 'none';
      label.style.display = 'none';
      return;
    }
    const r = el.getBoundingClientRect();
    highlight.style.display = 'block';
    highlight.style.left = r.left + 'px';
    highlight.style.top = r.top + 'px';
    highlight.style.width = r.width + 'px';
    highlight.style.height = r.height + 'px';
    if (el !== labeled) {
      labeled = el;
      const tag = (el.tagName || '?').toLowerCase();
      const locatorHtml = hlTokens(locatorOf(el));
      label.innerHTML = `<span style="color:#c4b5fd">&lt;${tag}&gt;</span> ${locatorHtml}`;
      locatorLine.innerHTML = locatorHtml;
      locatorLine.style.display = 'block';
    }
    placeLabel(r);
    foot.textContent = words.keysHovering;
  };

  const redescribe = () => {
    labeled = null;
    if (current()) refresh();
  };
  g.__piwiRedescribe = redescribe;

  const stop = (e: any) => {
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  const isOwn = (el: any) =>
    el === banner ||
    el === highlight ||
    el === label ||
    (banner.contains && banner.contains(el)) ||
    !!(el && el.__piwiHint);
  let bannerDocked: 'top' | 'bottom' = 'top';
  const dockBanner = (side: 'top' | 'bottom') => {
    if (bannerDocked === side) return;
    bannerDocked = side;
    if (side === 'bottom') {
      banner.style.top = 'auto';
      banner.style.bottom = '12px';
    } else {
      banner.style.top = '12px';
      banner.style.bottom = 'auto';
    }
  };
  const onMove = (e: any) => {
    const raw = targetOf(e);
    if (!raw || isOwn(raw)) {
      // The overlay's own chrome outlines nothing, so Enter falls back to the focus.
      chain = [];
      idx = 0;
      lastRaw = null;
      highlight.style.display = 'none';
      label.style.display = 'none';
      foot.textContent = words.keys;
      return;
    }
    if (raw !== lastRaw) {
      lastRaw = raw;
      chain = buildChain(raw);
      idx = snapIndex(chain);
    }
    refresh();
    const el = current();
    if (el) {
      const r = el.getBoundingClientRect();
      const br = banner.getBoundingClientRect();
      const margin = 8;
      if (
        r.left < br.right + margin &&
        r.right > br.left - margin &&
        r.top < br.bottom + margin &&
        r.bottom > br.top - margin
      ) {
        dockBanner(bannerDocked === 'top' ? 'bottom' : 'top');
      }
    }
  };

  // Suppress the app's own pointer handlers while picking — a pick must never
  // navigate or mutate the page under inspection.
  const suppressed = ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'auxclick', 'dblclick'];
  const removePickingListeners = () => {
    doc.removeEventListener('mousemove', onMove, true);
    doc.removeEventListener('click', onClick, true);
    doc.removeEventListener('keydown', onKey, true);
    if (arg.transport === 'postMessage') g.removeEventListener('message', onParentMsg, false);
  };
  const removeSuppressed = () => {
    for (const t of suppressed) doc.removeEventListener(t, stop, true);
  };
  const cleanup = () => {
    highlight.remove();
    label.remove();
    banner.remove();
    if (g.__piwiRedescribe === redescribe) delete g.__piwiRedescribe;
  };
  // Everything the overlay put on the page, whatever step it is at: its
  // listeners, the suppressed pointer events and the post-pick blockers as
  // well as its nodes.
  const teardown = () => {
    removePickingListeners();
    removeSuppressed();
    doc.removeEventListener('click', stop, true);
    doc.removeEventListener('keydown', stop, true);
    cleanup();
  };

  // A pick committed. `'global'` hands the raw element back to Node (probed
  // later, separately) and tears everything down — the reporter's next step
  // (anchors) installs its own overlay. `'postMessage'` has no Node on the
  // other end of the wire, so it probes inline and keeps the overlay's inert
  // blockers installed (the review step still shows this same page) —
  // `onPick` lets the embedding host clear its own snapshot-only chrome
  // (search highlights) without this function knowing it exists.
  const reportPicked = (el: any) => {
    removePickingListeners();
    highlight.style.display = 'none';
    label.style.display = 'none';
    if (arg.transport === 'postMessage') {
      const probeFn = g.__piwiProbe;
      const attrs = typeof probeFn === 'function' ? probeFn(el, arg.probeArg) : null;
      g.__piwiSnapshotExtras?.onPick?.();
      doc.addEventListener('click', stop, true);
      doc.addEventListener('keydown', stop, true);
      foot.textContent = words.analyzing;
      g.parent.postMessage({ type: 'elementPicked', attrs }, '*');
    } else {
      removeSuppressed();
      g.__piwiPickedElement = el;
      g.__piwiPickState = 'picked';
      foot.textContent = words.analyzing;
    }
  };

  const reportSkipped = () => {
    removePickingListeners();
    if (arg.transport === 'postMessage') {
      doc.removeEventListener('click', stop, true);
      doc.removeEventListener('keydown', stop, true);
      removeSuppressed();
      g.__piwiSnapshotExtras?.onClose?.();
      cleanup();
      g.parent.postMessage({ type: 'pickerClosed' }, '*');
    } else {
      removeSuppressed();
      g.__piwiPickState = 'skipped';
      cleanup();
    }
  };

  const onClick = (e: any) => {
    stop(e);
    const el = current();
    if (!el || isOwn(targetOf(e))) return;
    reportPicked(el);
  };
  // The focused element, inside open shadow roots; none when the focus is on
  // the page itself or on the overlay.
  const focused = (): any => {
    let el = doc.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    const tag = ((el && el.tagName) || '').toLowerCase();
    return !el || tag === 'body' || tag === 'html' || isOwn(el) ? null : el;
  };
  const onKey = (e: any) => {
    if (e.key === 'Escape') {
      stop(e);
      reportSkipped();
      return;
    }
    if (e.key === 'Enter' && !e.isComposing) {
      stop(e);
      const el = current() || focused();
      if (el) reportPicked(el);
      return;
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      stop(e);
      if (!chain.length) return;
      if (e.key === 'ArrowUp') idx = Math.min(idx + 1, chain.length - 1);
      else idx = Math.max(idx - 1, 0);
      refresh();
    }
  };
  // The snapshot iframe rarely holds keyboard focus (a host modal's focus trap
  // keeps it in the parent document), so its host forwards arrow/Esc presses.
  const onParentMsg = (e: any) => {
    const d = e.data;
    if (!d || typeof d.type !== 'string' || d.type !== 'piwiPickerKey' || typeof d.key !== 'string') return;
    onKey({
      key: d.key,
      preventDefault() {},
      stopImmediatePropagation() {},
    });
  };

  g.__piwiPickCleanup = teardown;
  doc.addEventListener('mousemove', onMove, true);
  doc.addEventListener('click', onClick, true);
  doc.addEventListener('keydown', onKey, true);
  for (const t of suppressed) doc.addEventListener(t, stop, true);
  if (arg.transport === 'postMessage') {
    g.addEventListener('message', onParentMsg, false);
    g.parent.postMessage({ type: 'pickerReady' }, '*');
  }
}

/**
 * Tears down the element-picking overlay: highlight, banner and chip, and the
 * capture listeners it holds while picking, so the page gets its clicks and
 * keys back even when the pick never finished.
 *
 * `installPickerOverlay` deliberately leaves its nodes standing once a pick is
 * committed: the reporter's flow hands the element back to Node, which drives
 * whatever comes next, and multi-pick keeps the banner up between picks while
 * only its footer text changes. Anything that finishes with the element
 * itself — a single pick, an assertion or context panel — has to remove them,
 * or the banner survives the whole flow still reading "Analyzing element…",
 * which is indistinguishable from a pick that hung.
 *
 * Safe to call more than once, and when no overlay was ever installed.
 */
export function removePickerOverlay(): void {
  const g = globalThis as any;
  // `installPickerOverlay` stashes the teardown for exactly the nodes and
  // listeners it put on the page; prefer it, and fall back to removing by id
  // so a half-torn-down or re-injected overlay still goes away.
  const cleanup = g.__piwiPickCleanup;
  if (typeof cleanup === 'function') {
    cleanup();
    g.__piwiPickCleanup = undefined;
    return;
  }
  const doc = g.document;
  if (!doc) return;
  for (const id of ['__piwi_picker_highlight', '__piwi_picker_label', '__piwi_picker_banner']) {
    doc.getElementById(id)?.remove();
  }
}
