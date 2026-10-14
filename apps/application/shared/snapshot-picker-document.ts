/**
 * Assembly of the hardened DOM-snapshot iframe document, shared by:
 *  - the dashboard (browser) for the demo's `srcdoc` path, and
 *  - the server's `dom-snapshot-frame` endpoint, which serves the same document
 *    over HTTP with its own sandboxing, no-network CSP so it can be loaded via
 *    the iframe's `src` (a `srcdoc` frame inherits the desktop page's strict
 *    CSP, which blocks the picker's inline script; a `src`-loaded document
 *    carries its own CSP instead).
 *
 * The snapshot loads into a sandboxed iframe — `sandbox="allow-scripts"` with NO
 * `allow-same-origin`, i.e. an opaque origin — with the picker overlay appended
 * as a `<script>` (see `snapshot-picker-extras.ts`). The picker can touch only
 * its own document and talks to the host purely over `postMessage`, so a
 * sanitizer bypass in the rendered snapshot can't reach the dashboard's
 * cookies, storage, or API. The document loads nothing from the network (see
 * `stripNetworkReferences`): the page's scripts, preloads and unembedded assets
 * never reach the dashboard's origin or the tested app.
 *
 * Lives in `shared/` (not `app/utils/`) so both callers above can build the
 * exact same document — the host-only helpers (highlight-hint derivation) stay
 * in `app/utils/snapshot-picker-script.ts`, which re-exports these.
 */
import { installPickerOverlay, probeElementAttrs, type PickerOverlayArg, type ProbeArg } from '@piwitests/picker-dom';
import {
  installSnapshotPickerExtras,
  readonlySnapshotScript,
  restoreSnapshotState,
} from '#shared/snapshot-picker-extras';

/** Configuration handed to the serialized picker (the only bridge into it). */
export interface SnapshotPickerConfig {
  /** Attribute whitelist to probe — the shared `CAPTURED_ATTRIBUTES`. */
  probedAttrs: string[];
}

/** Escape a serialized function/value so a stray `</script>` in it can't close the tag early. */
const escScriptClose = (src: string): string => src.replace(/<\/(script)/gi, '<\\/$1');

/** The `nonce` attribute that lets a script run under a nonce-based CSP (none when unset). */
const nonceAttr = (nonce?: string): string => (nonce ? ` nonce="${nonce}"` : '');

/**
 * The `<script>` tag to append to the snapshot HTML. Four self-contained
 * pieces run in sequence, each re-serialized independently via
 * `Function.prototype.toString()` — a serialized function can carry no
 * imports, so they can't just import one another:
 *
 *  0. `restoreSnapshotState` puts the page back as it was recorded (open
 *     dialogs, scroll offsets, the action's target…), before anything installs
 *     over it.
 *  1. `probeElementAttrs` is installed on `globalThis.__piwiProbe` — the
 *     shared core overlay reads it from there when a pick commits, since it
 *     runs standalone in this iframe with no Node process to probe from later
 *     (contrast the reporter's live picker, which probes after the fact from
 *     Node against a live element handle).
 *  2. The snapshot-only chrome (`installSnapshotPickerExtras`) — search,
 *     highlight hints, extended inertness, content-height reporting. Installs
 *     `globalThis.__piwiSnapshotExtras` before the core overlay runs, so its
 *     `onPick`/`onClose` hooks are in place before they're ever needed.
 *  3. The shared core overlay (`installPickerOverlay`), run with
 *     `transport: 'postMessage'`.
 */
export function snapshotPickerScriptTag(config: SnapshotPickerConfig, nonce?: string): string {
  const probeArg: ProbeArg = { keep: config.probedAttrs, includeStructural: false };
  const overlayArg: PickerOverlayArg = { transport: 'postMessage', probeArg };
  const restoreSrc = escScriptClose(String(restoreSnapshotState));
  const probeSrc = escScriptClose(String(probeElementAttrs));
  const extrasSrc = escScriptClose(String(installSnapshotPickerExtras));
  const overlaySrc = escScriptClose(String(installPickerOverlay));
  // Init runs inside a try/catch and behind error listeners that report any
  // failure to the host over `postMessage` as `piwiError`, so a throw during
  // setup (a serialization slip, a missing browser API) shows as an error in the
  // host — and, in the desktop shell, in its log. A script that is *CSP-blocked*
  // never runs at all, so this can't fire for that case: the host's readiness
  // timeout does.
  return (
    `<script${nonceAttr(nonce)}>` +
    `(function(){` +
    `function __piwiReport(e){try{parent.postMessage({type:'piwiError',` +
    `message:String((e&&e.message)||e),stack:(e&&e.stack)?String(e.stack):''},'*');}catch(_){}}` +
    `addEventListener('error',function(e){__piwiReport(e.error||e.message);});` +
    `addEventListener('unhandledrejection',function(e){__piwiReport(e.reason);});` +
    `try{` +
    `(${restoreSrc})();` +
    `globalThis.__piwiProbe = (${probeSrc});` +
    `(${extrasSrc})();` +
    `(${overlaySrc})(${JSON.stringify(overlayArg)});` +
    `}catch(e){__piwiReport(e);}` +
    `})();` +
    `</script>`
  );
}

// A start tag. Quoted attribute values are matched whole, so a `>` inside one
// never ends the tag early.
const START_TAG_RE = /<([a-zA-Z][^\s/>]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
// One attribute: its name, then a double-quoted, single-quoted or bare value.
const ATTR_RE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
// A `<style>` element: its CSS is raw text, rewritten as CSS rather than markup.
const STYLE_ELEMENT_RE = /(<style(?=[\s/>])(?:[^>"']|"[^"]*"|'[^']*')*>)([\s\S]*?)(<\/style\s*>|$)/gi;
const CSS_IMPORT_RE = /@import\s+(?:url\(\s*(?:"[^"]*"|'[^']*'|[^)]*)\)|"[^"]*"|'[^']*')[^;]*;?/gi;
const CSS_URL_RE = /url\(\s*(?:(['"])(.*?)\1|([^)\s'"]+))\s*\)/gi;

/** A URL the browser resolves without the network: a well-formed `data:` URI or an in-document `#fragment`. */
function isInlineRef(url: string): boolean {
  const ref = url.trim();
  return ref.startsWith('#') || /^data:[^,]*,/i.test(ref);
}

/** CSS with every `@import` removed and every `url(...)` that would fetch replaced by `none`. */
function stripCssNetworkRefs(css: string): string {
  return css
    .replace(CSS_IMPORT_RE, '')
    .replace(CSS_URL_RE, (full, _quote, quoted?: string, bare?: string) =>
      isInlineRef(quoted ?? bare ?? '') ? full : 'none',
    );
}

function decodeAttr(value: string): string {
  return value
    .replace(/&quot;|&#34;|&#x22;/gi, '"')
    .replace(/&apos;|&#39;|&#x27;/gi, "'")
    .replace(/&amp;/g, '&');
}

/**
 * One attribute as the offline document keeps it: unchanged, rewritten (a
 * `style` whose CSS would fetch) or dropped (`''`). Links and form targets stay —
 * they only act on a click or a submit, both of which the frame swallows.
 */
function offlineAttr(tag: string, attr: string, name: string, value: string | undefined): string {
  const lower = name.toLowerCase();
  if (lower === 'style' && value !== undefined) {
    const css = decodeAttr(value);
    const stripped = stripCssNetworkRefs(css);
    return stripped === css ? attr : `${name}="${stripped.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`;
  }
  // Scripts, nested browsing contexts and plugins would run or load code of their own.
  if (lower === 'srcdoc') return '';
  if (/^(script|iframe|frame|embed)$/.test(tag) && /^(src|href|xlink:href)$/.test(lower)) return '';
  if (tag === 'object' && lower === 'data') return '';
  const fetches =
    lower === 'src' ||
    lower === 'srcset' ||
    lower === 'poster' ||
    lower === 'background' ||
    ((lower === 'href' || lower === 'xlink:href') && tag !== 'a' && tag !== 'area');
  return fetches && !isInlineRef(decodeAttr(value ?? '')) ? '' : attr;
}

function stripMarkupNetworkRefs(html: string): string {
  return html.replace(START_TAG_RE, (full, name: string, attrs: string) => {
    const tag = name.toLowerCase();
    // A `<link>` still here after the server inlined the stylesheets it could
    // would only fetch; `<base>` would point relative URLs at the tested app; a
    // `<meta http-equiv>` refresh navigates the frame.
    if (tag === 'link' || tag === 'base') return '';
    if (tag === 'meta' && /\bhttp-equiv\s*=/i.test(attrs)) return '';
    const kept = attrs.replace(ATTR_RE, (attr, attrName: string, dq?: string, sq?: string, bare?: string) =>
      offlineAttr(tag, attr, attrName, dq ?? sq ?? bare),
    );
    return kept === attrs ? full : `<${name}${kept}>`;
  });
}

/**
 * The snapshot as a document that loads nothing from the network: it renders
 * only what it carries inline — the stylesheets and images the server embedded
 * from the trace, `data:` URIs and in-document references. Every other
 * subresource would resolve against the dashboard's origin (or reach the live
 * tested app), so it is removed: leftover `<link>` elements, `<base>`,
 * `<meta http-equiv>`, nested frame/object/embed sources, `src`/`srcset`/
 * `poster`/`href` media URLs, and CSS `url(...)`/`@import` in `<style>` and
 * `style=""`. A masked `data:` URI is malformed, so it goes too.
 */
export function stripNetworkReferences(html: string): string {
  let out = '';
  let last = 0;
  for (const m of html.matchAll(STYLE_ELEMENT_RE)) {
    out += stripMarkupNetworkRefs(html.slice(last, m.index) + m[1]) + stripCssNetworkRefs(m[2]!) + m[3];
    last = m.index + m[0].length;
  }
  return out + stripMarkupNetworkRefs(html.slice(last));
}

/**
 * Build the full picker document: the snapshot with its network references
 * stripped, plus the appended picker script. `nonce` marks that script for a
 * nonce-based CSP.
 */
export function buildPickerDocument(html: string, config: SnapshotPickerConfig, nonce?: string): string {
  return stripNetworkReferences(html) + snapshotPickerScriptTag(config, nonce);
}

/**
 * Build the read-only document: the snapshot with its network references
 * stripped, plus the page's recorded state put back (`restoreSnapshotState`)
 * and the inert-and-measure script (`readonlySnapshotScript`) — the styled page
 * as the picker shows it, but with no picking overlay, reporting its content
 * height over `postMessage` so the host can size the sandboxed iframe exactly
 * as the picker does.
 */
export function buildReadonlyDocument(html: string, nonce?: string): string {
  const restoreSrc = escScriptClose(String(restoreSnapshotState));
  const src = escScriptClose(String(readonlySnapshotScript));
  return stripNetworkReferences(html) + `<script${nonceAttr(nonce)}>(${restoreSrc})();(${src})();</script>`;
}
