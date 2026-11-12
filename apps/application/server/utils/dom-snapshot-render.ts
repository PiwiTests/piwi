/**
 * Trace-derived DOM snapshot: render Playwright's serialized `frame-snapshot`
 * node arrays back into sanitized HTML. The DOM is never captured by the
 * reporter — it is extracted lazily from the trace ZIPs already in storage,
 * so richer failure evidence costs zero extra upload bytes.
 *
 * Format (Playwright-internal, version-sensitive — everything here is
 * best-effort and degrades to placeholders/null, never throws):
 *  - element: `[TAGNAME, {attrs}, ...children]` (children always from index 2)
 *  - text: plain string
 *  - back-reference: `[[snapshotsAgo, nodeIndex]]` — the node at `nodeIndex`
 *    in the post-order node list of the snapshot `snapshotsAgo` earlier in the
 *    same frame's snapshot sequence
 *  - live state: `__playwright_*` attributes beside an element's own (a
 *    field's value, a checkbox's state, scroll offsets, an open dialog, the
 *    action's target), and `template` nodes for shadow roots and adopted
 *    stylesheets — the same in every version from 1.60 on, but for the target,
 *    which 1.60 marks with the action's call id and later versions leave empty
 *
 * Node-free (pure rendering over already-parsed trace data) so the browser
 * demo can render the committed demo trace with the same code the server
 * uses; the node-only trace loading lives in `dom-snapshot.ts`.
 */
import { cssUrls, replaceCssUrls } from '#shared/css-urls';
import { sanitizePageInteraction } from '#shared/page-interaction';
import { pageActionOf, type ParsedTraceData, type TraceAction, type TraceFrameSnapshot } from './trace-events';

/**
 * Cap for the rendered snapshot HTML. Generous so a fully-styled snapshot
 * (inline CSS can run to a few hundred KB) fits; `extractDomSnapshot` drops
 * inline `<style>` only when a page exceeds it.
 */
export const DOM_SNAPSHOT_CAP_CHARS = 1_500_000;

/**
 * What one render of a snapshot may cost: the nodes it visits, the back-references it follows, and the characters it
 * writes, counted as it goes. A chain whose references name the same nodes again and again writes far more than it
 * holds: past any of these, the render gives up (null).
 */
export const MAX_RENDER_NODES = 500_000;
export const MAX_RENDER_REFERENCES = 250_000;
export const MAX_RENDER_CHARS = 16_000_000;

/** Thrown inside a render past its budget, and caught where it began. */
class RenderTooLarge extends Error {}

const VOID_ELEMENTS = new Set([
  'AREA',
  'BASE',
  'BR',
  'COL',
  'EMBED',
  'HR',
  'IMG',
  'INPUT',
  'LINK',
  'META',
  'SOURCE',
  'TRACK',
  'WBR',
]);

// A tag or attribute name holding whitespace, a quote, `<`, `>`, `/` or `=`
// can't be written back as markup without spilling into it.
const UNSAFE_NAME_RE = /[\s"'<>/=]/;

/**
 * `<link rel>` tokens that only ask the browser to fetch ahead — Vite's
 * `modulepreload` chunks, `preload`, `prefetch`, … Playwright's recorder drops
 * plain `preload`/`prefetch` links and keeps the rest; none is page content.
 */
const RESOURCE_HINT_RELS = new Set(['modulepreload', 'preload', 'prefetch', 'prerender', 'preconnect', 'dns-prefetch']);

/** A `<link>` whose `rel` is a resource hint and not also a stylesheet. */
function isResourceHint(attrs: unknown): boolean {
  if (!attrs || typeof attrs !== 'object' || Array.isArray(attrs)) return false;
  const rel = (attrs as Record<string, unknown>).rel;
  const tokens = typeof rel === 'string' ? rel.toLowerCase().split(/\s+/) : [];
  return !tokens.includes('stylesheet') && tokens.some((token) => RESOURCE_HINT_RELS.has(token));
}

/** Options controlling how much of the DOM survives rendering. */
export interface RenderOptions {
  /**
   * Drop the text body of inline `<style>` elements (the tag stays as a
   * marker). Inline CSS is the single biggest source of bloat — a framework's
   * inlined styles can run to hundreds of KB and push the real `<body>` past
   * the endpoint cap, leaving the snapshot blank. Off by default (full
   * fidelity); `extractDomSnapshot` turns it on only when a styled render would
   * be truncated. `<link>` stylesheets and inline `style=` attrs are always
   * kept, so pages with external CSS still render styled either way.
   */
  dropStyles?: boolean;
  /**
   * Called for each back-reference that names a snapshot the list does not
   * hold: a list cut short of the frame's last full snapshot renders a
   * placeholder in its place.
   */
  onUnresolved?: () => void;
  /** Called when the render gives up past its budget (`MAX_RENDER_NODES` and the others), returning null. */
  onTooLarge?: () => void;
}

function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

/**
 * CSS written into a `<style>` element, whose text is raw (entities are not
 * decoded there): only a closing tag could end it early, so that one is defanged.
 */
function rawStyleText(css: string): string {
  return css.replace(/<\/(style)/gi, '<\\/$1');
}

/** The `__playwright_*` attributes that carry an element's live state in a recorded snapshot. */
const LIVE = {
  value: '__playwright_value_',
  checked: '__playwright_checked_',
  selected: '__playwright_selected_',
  scrollTop: '__playwright_scroll_top_',
  scrollLeft: '__playwright_scroll_left_',
  target: '__playwright_target__',
  currentSrc: '__playwright_current_src__',
  popoverOpen: '__playwright_popover_open_',
  dialogOpen: '__playwright_dialog_open_',
  customElements: '__playwright_custom_elements__',
  shadowRoot: '__playwright_shadow_root_',
  styleSheet: '__playwright_style_sheet_',
} as const;

/** What a password field shows: that it holds something, never what. */
export const PASSWORD_MASK = '••••••••';

/**
 * A URL that runs code when followed (`javascript:`, `vbscript:`), as a browser
 * reads it: ASCII whitespace and control characters ignored.
 */
function isScriptUrl(value: string): boolean {
  let read = '';
  for (const char of value) if (char > ' ') read += char;
  return /^(?:javascript|vbscript):/i.test(read);
}

/** The attributes that hold a URL, a script URL in one of which would run when followed or loaded. */
const URL_ATTRIBUTES = new Set([
  'href',
  'src',
  'action',
  'formaction',
  'xlink:href',
  'data',
  'poster',
  'background',
  'cite',
  // SVG animation, which can set `href` to its value.
  'to',
  'from',
  'by',
]);

/**
 * Whether an attribute holds a script URL: one of `URL_ATTRIBUTES`, a candidate of a `srcset`, or one of an SVG
 * animation's `values`. Any other attribute holds text, whatever it reads like.
 */
function holdsScriptUrl(name: string, value: string): boolean {
  const lower = name.toLowerCase();
  if (lower === 'srcset' || lower === 'imagesrcset') {
    return value.split(',').some((candidate) => isScriptUrl(candidate.trim().split(/\s+/)[0] ?? ''));
  }
  if (lower === 'values') return value.split(';').some(isScriptUrl);
  return URL_ATTRIBUTES.has(lower) && isScriptUrl(value);
}

/** Input types whose `value` is not what the field shows: a checkbox's or radio's submitted value, a file's fake path. */
const VALUELESS_INPUT_TYPES = new Set(['checkbox', 'radio', 'file']);

type Attrs = Record<string, unknown>;

/**
 * One element's attributes as the renderer writes them: its recorded ones,
 * less inline handlers, script URLs and unsafe names, with its live state applied. What
 * markup can say is written as markup: a field's value (masked in a password
 * field), a checkbox's or option's state, the image the page chose from a
 * `srcset`, an open dialog. The rest becomes a `data-piwi-*` marker the frame
 * script applies (`restoreSnapshotState` in `#shared/snapshot-picker-extras`):
 * scroll offsets, a modal dialog, an open popover, the action's target, the
 * custom elements the page had defined.
 */
function renderedAttributes(tagUpper: string, attrs: Attrs, isTargetMark: (value: unknown) => boolean) {
  const out = new Map<string, string>();
  for (const [name, value] of Object.entries(attrs)) {
    if (name.startsWith('__playwright')) continue;
    // Inline handlers and script URLs are noise for diagnosis and unsafe to re-emit.
    if (/^on[a-z]/i.test(name) || UNSAFE_NAME_RE.test(name)) continue;
    if (holdsScriptUrl(name, String(value))) continue;
    out.set(name, String(value));
  }
  const live = (name: string): string | undefined => {
    const value = attrs[name];
    return typeof value === 'string' ? value : undefined;
  };
  const setFlag = (name: string, on: boolean) => {
    if (on) out.set(name, '');
    else out.delete(name);
  };

  if (tagUpper === 'INPUT') {
    const type = (out.get('type') ?? '').toLowerCase();
    const value = live(LIVE.value);
    if (type === 'password') {
      const held = value ?? out.get('value');
      if (held !== undefined) out.set('value', held ? PASSWORD_MASK : '');
    } else if (value !== undefined && !VALUELESS_INPUT_TYPES.has(type)) {
      out.set('value', value);
    }
    const checked = live(LIVE.checked);
    if (checked !== undefined) setFlag('checked', checked === 'true');
  }
  const selected = live(LIVE.selected);
  if (tagUpper === 'OPTION' && selected !== undefined) setFlag('selected', selected === 'true');
  const currentSrc = live(LIVE.currentSrc);
  if (tagUpper === 'IMG' && currentSrc) {
    out.set('src', currentSrc);
    out.delete('srcset');
  }
  // A dialog's `open` attribute is not recorded, only whether it was open and how.
  const dialog = live(LIVE.dialogOpen);
  if (tagUpper === 'DIALOG' && dialog) {
    out.set('open', '');
    if (dialog === 'modal') out.set('data-piwi-modal', '');
  }
  if (live(LIVE.popoverOpen) === 'true') out.set('data-piwi-popover-open', '');
  const scrollTop = live(LIVE.scrollTop);
  if (scrollTop) out.set('data-piwi-scroll-top', scrollTop);
  const scrollLeft = live(LIVE.scrollLeft);
  if (scrollLeft) out.set('data-piwi-scroll-left', scrollLeft);
  if (isTargetMark(attrs[LIVE.target])) out.set('data-piwi-target', '');
  const customElements = live(LIVE.customElements);
  if (tagUpper === 'BODY' && customElements) out.set('data-piwi-custom-elements', customElements);
  return out;
}

/** An attribute's value, double-quoted: its angle brackets escaped too, so no context the browser reads it in ends early. */
function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Where a node is written, as the browser parses it there: HTML markup, SVG or MathML markup (`foreign`, where a
 * `style` holds markup rather than raw text), or the text of an element whose content the browser reads as text.
 */
type Place = 'html' | 'foreign' | 'text';

/** HTML elements whose content the browser reads as text: their markup would be text, so their text alone is written. */
const TEXT_ELEMENTS = new Set(['TITLE', 'TEXTAREA', 'XMP', 'IFRAME', 'NOEMBED', 'NOFRAMES', 'NOSCRIPT']);

/** A doctype the renderer writes: a plain name (`html`); anything else is left out. */
const DOCTYPE_RE = /^[a-z]+$/i;

/**
 * Post-order node list of one snapshot's tree — the indexing space that
 * back-references point into. Ref nodes are neither descended nor indexed
 * (mirrors Playwright's snapshotNodes).
 */
function collectNodes(html: unknown): unknown[] {
  const nodes: unknown[] = [];
  const visit = (n: unknown) => {
    if (typeof n === 'string') {
      nodes.push(n);
    } else if (Array.isArray(n) && typeof n[0] === 'string') {
      for (let i = 2; i < n.length; i++) visit(n[i]);
      nodes.push(n);
    }
  };
  visit(html);
  return nodes;
}

/**
 * Render one named snapshot to an HTML string, resolving back-references
 * against the earlier snapshots of the same frame. Returns null when the
 * snapshot is missing, the tree is entirely unrenderable, or the render costs
 * more than its budget (`onTooLarge`).
 */
export function renderSnapshotHtml(
  snapshots: TraceFrameSnapshot[],
  snapshotName: string,
  options: RenderOptions = {},
): string | null {
  const { dropStyles = false, onUnresolved, onTooLarge } = options;
  const target =
    snapshots.find((s) => s.snapshotName === snapshotName && s.isMainFrame !== false) ??
    snapshots.find((s) => s.snapshotName === snapshotName);
  if (!target || target.html === undefined) return null;

  const frameList = snapshots.filter((s) => s.frameId === target.frameId);
  const targetIndex = frameList.indexOf(target);

  const nodeListCache = new Map<number, unknown[]>();
  const nodesOf = (snapshotIndex: number): unknown[] => {
    let cached = nodeListCache.get(snapshotIndex);
    if (!cached) {
      cached = collectNodes(frameList[snapshotIndex]!.html);
      nodeListCache.set(snapshotIndex, cached);
    }
    return cached;
  };

  // 1.60 marks the action's target with its call id, later versions with an
  // empty value; an id of another action is a mark an earlier snapshot left.
  const isTargetMark = (value: unknown) => value === '' || (!!target.callId && value === target.callId);

  // What the render has spent: past any budget, it gives up.
  let nodes = 0;
  let references = 0;
  let chars = 0;
  const visit = () => {
    if (++nodes > MAX_RENDER_NODES) throw new RenderTooLarge();
  };
  const write = (piece: string): string => {
    chars += piece.length;
    if (chars > MAX_RENDER_CHARS) throw new RenderTooLarge();
    return piece;
  };

  /**
   * The node a back-reference names, in the earlier snapshot's node space —
   * rendering continues in THAT snapshot's context, whose own refs go further
   * back. Null when it can't be resolved.
   */
  const deref = (ref: unknown[], snapshotIndex: number): { node: unknown; snapshotIndex: number } | null => {
    if (++references > MAX_RENDER_REFERENCES) throw new RenderTooLarge();
    const delta = typeof ref[0] === 'number' ? ref[0] : NaN;
    const nodeIndex = typeof ref[1] === 'number' ? ref[1] : NaN;
    const refSnapshotIndex = snapshotIndex - delta;
    if (!Number.isInteger(refSnapshotIndex) || refSnapshotIndex < 0 || refSnapshotIndex >= snapshotIndex) return null;
    const refNodes = nodesOf(refSnapshotIndex);
    if (!Number.isInteger(nodeIndex) || nodeIndex < 0 || nodeIndex >= refNodes.length) return null;
    return { node: refNodes[nodeIndex], snapshotIndex: refSnapshotIndex };
  };

  /** The text a child node stands for, following back-references; null for an element. */
  const textOf = (n: unknown, snapshotIndex: number): string | null => {
    visit();
    if (typeof n === 'string') return n;
    if (!Array.isArray(n) || !Array.isArray(n[0])) return null;
    const ref = deref(n[0], snapshotIndex);
    if (!ref) onUnresolved?.();
    return ref ? textOf(ref.node, ref.snapshotIndex) : null;
  };

  /** A node written at `place`: a reference is written where it is named, whatever it was in its own snapshot. */
  const render = (n: unknown, snapshotIndex: number, place: Place): string => {
    visit();
    if (typeof n === 'string') return write(escapeText(n));
    if (!Array.isArray(n) || n.length === 0) return '';

    if (Array.isArray(n[0])) {
      const ref = deref(n[0], snapshotIndex);
      if (!ref) onUnresolved?.();
      return ref ? render(ref.node, ref.snapshotIndex, place) : write('<!-- [unresolved snapshot reference] -->');
    }

    // An element where the browser reads text would be text: it goes.
    if (place === 'text') return '';
    if (typeof n[0] !== 'string' || !n[0] || UNSAFE_NAME_RE.test(n[0])) return '';
    // HTML tags are recorded upper case, SVG ones as authored (`svg`, `script`).
    const tagUpper = (n[0] as string).toUpperCase();
    // `plaintext` would read the rest of the document, the frame's own script included, as text.
    const tag = tagUpper === 'PLAINTEXT' ? 'pre' : tagUpper.toLowerCase();
    const attrs: Attrs = n[1] && typeof n[1] === 'object' && !Array.isArray(n[1]) ? (n[1] as Attrs) : {};

    // A script is an empty marker — no `src`, no body — so nothing the page
    // shipped ever runs in the rendered frame. Playwright drops HTML scripts when
    // recording but keeps SVG ones, whose tag is lower case.
    if (tagUpper === 'SCRIPT') return write('<script></script>');
    if (tagUpper === 'LINK' && isResourceHint(attrs)) return '';

    // An adopted stylesheet (the document's or a shadow root's) is recorded as a
    // `template` holding its CSS, where it applies: written there as a `<style>`.
    const adopted = attrs[LIVE.styleSheet];
    if (tagUpper === 'TEMPLATE' && typeof adopted === 'string') {
      if (dropStyles) return write('<style></style>');
      return write(`<style>${place === 'html' ? rawStyleText(adopted) : escapeText(adopted)}</style>`);
    }

    let open = `<${tag}`;
    // A shadow root is recorded as a `template` first in its host; as a
    // declarative shadow root, the browser attaches it while parsing.
    if (tagUpper === 'TEMPLATE' && attrs[LIVE.shadowRoot] !== undefined) open += ' shadowrootmode="open"';
    for (const [name, value] of renderedAttributes(tagUpper, attrs, isTargetMark)) {
      open += ` ${name}="${escapeAttr(value)}"`;
    }
    let out = write(`${open}>`);
    if (VOID_ELEMENTS.has(tagUpper)) return out;

    const value = attrs[LIVE.value];
    if (tagUpper === 'TEXTAREA' && typeof value === 'string') {
      // The parser drops one newline right after `<textarea>`.
      return out + write(`${value.startsWith('\n') ? '\n' : ''}${escapeText(value)}</${tag}>`);
    }

    // `<style>` bodies are dropped only under the lean fallback; the tag stays
    // as a marker. An HTML `<style>` holds raw text, so its CSS is written as
    // is, anything else in it left out; inside SVG or MathML a `style` is parsed
    // as markup, whatever case it was recorded in, and stays escaped.
    if (dropStyles && tagUpper === 'STYLE') return out + write(`</${tag}>`);
    if (tagUpper === 'STYLE' && place === 'html') {
      for (let i = 2; i < n.length; i++) {
        const text = textOf(n[i], snapshotIndex);
        if (text !== null) out += write(rawStyleText(text));
      }
      return out + write(`</${tag}>`);
    }
    const inner: Place =
      place === 'foreign' || tagUpper === 'SVG' || tagUpper === 'MATH'
        ? 'foreign'
        : TEXT_ELEMENTS.has(tagUpper)
          ? 'text'
          : 'html';
    for (let i = 2; i < n.length; i++) out += render(n[i], snapshotIndex, inner);
    return out + write(`</${tag}>`);
  };

  try {
    const body = render(target.html, targetIndex, 'html');
    if (!body) return null;
    const doctype = typeof target.doctype === 'string' && DOCTYPE_RE.test(target.doctype) ? target.doctype : null;
    return (doctype ? `<!DOCTYPE ${doctype}>\n` : '') + body;
  } catch (error) {
    if (error instanceof RenderTooLarge) onTooLarge?.();
    return null;
  }
}

const DATA_URI_RE = /\bdata:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi;
const JWT_RE = /\beyJ[\w-]{10,}\.[\w-]{5,}\.[\w-]{5,}\b/g;
const LONG_HEX_RE = /\b[0-9a-f]{32,}\b/gi;

/**
 * Mask token-shaped strings (base64 data URIs, JWTs, long hex blobs) in any
 * user-visible text extracted from a trace. Single masking source of truth,
 * shared by the DOM snapshot, network headers/bodies and AI-context sections.
 */
export function maskSensitiveText(text: string): string {
  return text
    .replace(DATA_URI_RE, 'data:[masked]')
    .replace(JWT_RE, '[masked-token]')
    .replace(LONG_HEX_RE, '[masked-hex]');
}

// Stands in for a `data:` URI set aside while the text around it is masked. NUL
// never survives into rendered HTML or CSS, so a marker can't collide with text.
const SET_ASIDE_RE = /\u0000(\d+)\u0000/g;

/**
 * Set aside the `data:` URIs `keep` accepts behind markers, so masking (and a
 * cap) runs on the text around them and never inside one — a run of zero bytes
 * encodes as `AAAA…`, which the hex mask would shred. `restore` puts them back
 * and drops a marker the cap cut in half.
 */
function setAsideDataUris(text: string, keep: (uri: string) => boolean) {
  const kept: string[] = [];
  const marked = text.replace(DATA_URI_RE, (uri) => {
    if (!keep(uri)) return uri;
    kept.push(uri);
    return `\u0000${kept.length - 1}\u0000`;
  });
  const restore = (masked: string): string =>
    kept.length ? masked.replace(SET_ASIDE_RE, (_, i: string) => kept[Number(i)]!).replace(/\u0000\d*/g, '') : masked;
  return { marked, restore };
}

/**
 * Mask secrets in a CSS body destined for an inlined `<style>`, but leave
 * `data:` URIs alone — unlike {@link maskSensitiveText}. The picker deliberately
 * embeds fonts/images as base64 data URIs, so blanket data-URI masking would
 * wipe them out; token-shaped secrets (JWTs, long hex) are still scrubbed around
 * them. Run this AFTER assets are inlined so the fresh data URIs survive. Pure.
 */
export function maskCssText(css: string): string {
  const { marked, restore } = setAsideDataUris(css, () => true);
  return restore(marked.replace(JWT_RE, '[masked-token]').replace(LONG_HEX_RE, '[masked-hex]'));
}

// The largest inline `data:image/*` URI a rendered page keeps, and the most all
// of them may add up to — in characters.
const MAX_INLINE_IMAGE_CHARS = 200_000;
const INLINE_IMAGES_MAX_CHARS = 2_000_000;

/** Options for {@link sanitizeDomSnapshot}. */
export interface SanitizeOptions {
  /**
   * Keep inline `data:image/*` URIs — within `MAX_INLINE_IMAGE_CHARS` each and
   * `INLINE_IMAGES_MAX_CHARS` in all — for the rendered page views, where an
   * image is content rather than a blob of text. Every other `data:` URI and
   * token-shaped string is still masked, and kept images don't count against
   * the cap.
   */
  keepInlineImages?: boolean;
}

/**
 * Mask token-shaped strings and cap the rendered HTML. Pure and unit-testable.
 * The renderer already masks password fields and drops inline handlers and
 * script bodies — this pass handles secrets baked into ordinary markup.
 */
export function sanitizeDomSnapshot(
  html: string,
  capChars: number,
  options: SanitizeOptions = {},
): { html: string; truncated: boolean } {
  let budget = INLINE_IMAGES_MAX_CHARS;
  const { marked, restore } = setAsideDataUris(html, (uri) => {
    const keep =
      !!options.keepInlineImages &&
      /^data:image\//i.test(uri) &&
      uri.length <= MAX_INLINE_IMAGE_CHARS &&
      uri.length <= budget;
    if (keep) budget -= uri.length;
    return keep;
  });
  let out = maskSensitiveText(marked);
  let truncated = false;
  if (capChars > 0 && out.length > capChars) {
    out = out.slice(0, capChars) + '\n<!-- [truncated] -->';
    truncated = true;
  }
  return { html: restore(out), truncated };
}

// One media feature real stylesheets split on: `(min-width: 700px)`, `(max-height: 40em)`.
const MEDIA_BOUND_RE = /^\(\s*(min|max)-(width|height)\s*:\s*([\d.]+)(px|r?em)?\s*\)$/;

/**
 * Whether one media query (no commas) can apply at `viewport`: `null` when it
 * uses anything beyond media types and min/max width/height bounds.
 */
function mediaQueryMatches(query: string, viewport: { width: number; height: number }): boolean | null {
  let q = query.trim().toLowerCase();
  const negate = q.startsWith('not ');
  q = q.replace(/^(not|only)\s+/, '');
  let matches = true;
  for (const part of q.split(/\s+and\s+/)) {
    if (part === 'screen' || part === 'all') continue;
    if (part === 'print' || part === 'speech') {
      matches = false;
      continue;
    }
    const bound = MEDIA_BOUND_RE.exec(part);
    if (!bound) return null;
    const px = Number(bound[3]) * (bound[4]?.endsWith('em') ? 16 : 1);
    const actual = bound[2] === 'width' ? viewport.width : viewport.height;
    if (bound[1] === 'min' ? actual < px : actual > px) matches = false;
  }
  return negate ? !matches : matches;
}

/**
 * Whether a stylesheet's `media` attribute can apply to a page rendered at
 * `viewport` — the rendered frame always has the recorded viewport's width, so
 * a sheet for another viewport never applies there. Reads media types and
 * min/max width/height bounds; a query it can't read counts as applying, as
 * does any query when the viewport is unknown. Pure.
 */
export function mediaMatchesViewport(media: string, viewport?: { width: number; height: number }): boolean {
  if (!viewport || !media.trim()) return true;
  return media.split(',').some((query) => mediaQueryMatches(query, viewport) ?? true);
}

/**
 * A `<link rel="stylesheet">` parsed out of rendered snapshot HTML: its original
 * `href` (the key a resource map is looked up by) and any `media` attribute.
 */
function parseStylesheetLink(tag: string): { href: string; media: string | null } | null {
  // rel may be quoted or bare and carry several tokens (`rel="preload stylesheet"`).
  if (!/\brel\s*=\s*("|')?[^"'>]*\bstylesheet\b/i.test(tag)) return null;
  const quoted = /\bhref\s*=\s*("|')(.*?)\1/i.exec(tag);
  const href = quoted ? quoted[2]! : (/\bhref\s*=\s*([^\s"'>]+)/i.exec(tag)?.[1] ?? null);
  if (!href) return null;
  const media = /\bmedia\s*=\s*("|')(.*?)\1/i.exec(tag)?.[2] ?? null;
  // The values as the browser reads them, their characters escaped by the renderer put back.
  return { href: unescapeAttr(href), media: media === null ? null : unescapeAttr(media) };
}

// A style element of rendered HTML, its text whole: CSS, raw, which may hold
// anything but its closing tag, and which a pattern for markup must pass over.
const STYLE_ELEMENT_RE = /<style(?=[\s/>])[^>]*>[\s\S]*?(?:<\/style\s*>|$)/gi;

/**
 * `html` with `edit` applied to its markup between its style elements, their
 * text kept as it is: out of a style, the renderer writes no `<` but a tag's,
 * so a pattern for tags reads each once.
 */
function editMarkup(html: string, edit: (markup: string) => string): string {
  let out = '';
  let last = 0;
  for (const style of html.matchAll(STYLE_ELEMENT_RE)) {
    out += edit(html.slice(last, style.index)) + style[0];
    last = style.index + style[0].length;
  }
  return out + edit(html.slice(last));
}

/** Every `<link rel="stylesheet">` in the HTML, unique by original `href`, with its `media`. Pure. */
export function collectStylesheetLinks(html: string): { href: string; media: string | null }[] {
  const out: { href: string; media: string | null }[] = [];
  const seen = new Set<string>();
  editMarkup(html, (markup) => {
    for (const m of markup.matchAll(/<link\b[^>]*>/gi)) {
      const link = parseStylesheetLink(m[0]);
      if (link && !seen.has(link.href)) {
        seen.add(link.href);
        out.push(link);
      }
    }
    return markup;
  });
  return out;
}

/**
 * Replace external `<link rel="stylesheet">` elements whose CSS we have with an
 * inline `<style>`, so the snapshot renders styled inside the opaque-origin
 * picker iframe — where the original href (pointing at the long-gone test
 * server) can never load. `cssByHref` is keyed by each link's ORIGINAL href
 * attribute; links with no entry are left untouched (their href might still
 * resolve, and a broken link is no worse than before). `<style>` bodies are raw
 * text to the HTML parser, so a stray `</style` in the CSS is defanged here.
 *
 * The caller is responsible for scrubbing secrets from the CSS first (see
 * `maskCssText`): masking must run BEFORE any `url(...)` assets are embedded, or
 * it would shred the base64 data URIs it can't tell from real tokens.
 *
 * Inlining stops once `maxTotalChars` of CSS has been emitted; the remaining
 * links stay as-is rather than emit a half sheet. Pure and unit-testable.
 */
export function inlineStylesheets(html: string, cssByHref: Record<string, string>, maxTotalChars = 8_000_000): string {
  if (!html || Object.keys(cssByHref).length === 0) return html;
  let budget = maxTotalChars;
  return editMarkup(html, (markup) =>
    markup.replace(/<link\b[^>]*>/gi, (tag) => {
      const link = parseStylesheetLink(tag);
      if (!link) return tag;
      const css = cssByHref[link.href];
      if (typeof css !== 'string' || css.length === 0 || css.length > budget) return tag;
      budget -= css.length;
      const media = link.media ? ` media="${escapeAttr(link.media)}"` : '';
      return `<style${media}>${rawStyleText(css)}</style>`;
    }),
  );
}

/**
 * Every `url(...)` target in a CSS body worth resolving — quotes stripped, and
 * already-inline (`data:`) / in-document (`#id`) refs skipped — with how many
 * times the CSS uses it: each use embeds its own copy. Pure; the caller
 * resolves each against the stylesheet's own URL.
 */
export function collectCssUrls(css: string): Map<string, number> {
  const uses = new Map<string, number>();
  for (const url of cssUrls(css)) {
    const raw = url.target.trim();
    // Skip already-inline data: URIs and in-document refs (`#blur` filters).
    // One addressed by a fragment is resolved without it (`font.eot?#iefix`),
    // and an SVG one is left as it is (`assetDataUri`).
    if (!raw || raw.startsWith('data:') || raw.startsWith('#')) continue;
    uses.set(raw, (uses.get(raw) ?? 0) + 1);
  }
  return uses;
}

/**
 * Rewrite every `url(...)` whose target appears in `replacements` (keyed by the
 * raw target) to the replacement, double-quoted. Used to swap external asset
 * refs for `data:` URIs so fonts / background images render offline. Targets
 * with no replacement are left untouched. Pure.
 */
export function inlineCssUrls(css: string, replacements: Record<string, string>): string {
  if (!css || Object.keys(replacements).length === 0) return css;
  return replaceCssUrls(css, (url) => {
    const repl = replacements[url.target.trim()];
    return repl ? `url("${repl}")` : null;
  });
}

// The `src` of an `<img>` start tag as the renderer writes it (double-quoted).
// Quoted values are skipped whole, so a `>` inside one never ends the tag early.
const IMG_SRC_RE = /(<img(?=[\s/>])(?:[^>"']|"[^"]*"|'[^']*')*?\ssrc=")([^"]*)(")/gi;

function unescapeAttr(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * Every `<img src>` URL in rendered snapshot HTML (`data:` URIs skipped), with
 * how many images use it — each use embeds its own copy. Pure.
 */
export function collectImageSources(html: string): Map<string, number> {
  const uses = new Map<string, number>();
  editMarkup(html, (markup) => {
    for (const m of markup.matchAll(IMG_SRC_RE)) {
      const src = unescapeAttr(m[2]!).trim();
      if (src && !/^data:/i.test(src)) uses.set(src, (uses.get(src) ?? 0) + 1);
    }
    return markup;
  });
  return uses;
}

/**
 * Point every `<img src>` whose URL appears in `replacements` at its
 * replacement — a `data:` URI of the image captured in the trace. Others are
 * left untouched. Pure.
 */
export function inlineImageSources(html: string, replacements: Record<string, string>): string {
  if (!html || Object.keys(replacements).length === 0) return html;
  return editMarkup(html, (markup) =>
    markup.replace(IMG_SRC_RE, (full, open: string, value: string, close: string) => {
      const repl = replacements[unescapeAttr(value).trim()];
      return repl ? `${open}${escapeAttr(repl)}${close}` : full;
    }),
  );
}

/** The two representations a case can be viewed as: trace-derived DOM or the ARIA tree. */
export type DomSnapshotSource = 'dom' | 'aria';

export interface DomSnapshotResult {
  status: 'ok' | 'no-trace' | 'no-snapshot';
  html?: string;
  truncated?: boolean;
  /** Which snapshot was rendered (e.g. `before@call@12`). */
  snapshotName?: string;
  /**
   * The rendered snapshot is the failure-time one, the one rendered when no
   * other moment is asked for: the page the reporter read its page state from.
   */
  atFailure?: boolean;
  /** The failing action the snapshot belongs to, when identified. */
  action?: string;
  /** The recorded page viewport, for proportion-preserving scaled rendering. */
  viewport?: { width: number; height: number };
  /** The rendered frame's document URL — the base for resolving `<link href>` when inlining stylesheets. */
  frameUrl?: string;
  /** Which representation `html` is — the trace DOM (`dom`) or the ARIA tree (`aria`). */
  source?: DomSnapshotSource;
  /**
   * Which representations exist for this case, so the UI can offer a toggle
   * (e.g. view the ARIA tree even when a trace was uploaded).
   */
  availableSources?: DomSnapshotSource[];
}

/** One action's snapshot moment: the page before it ran, or after it. */
export interface SnapshotMoment {
  callId: string;
  phase: 'before' | 'after';
}

/** Longest `callId` a snapshot request may name. */
const MAX_CALL_ID_CHARS = 200;

/**
 * The snapshot moment a request names with `callId` and `phase` query
 * parameters, or undefined when it names none (or a malformed one).
 */
export function snapshotMomentFromQuery(query: Record<string, unknown>): SnapshotMoment | undefined {
  const { callId, phase } = query;
  if (typeof callId !== 'string' || !callId || callId.length > MAX_CALL_ID_CHARS) return undefined;
  return phase === 'before' || phase === 'after' ? { callId, phase } : undefined;
}

/**
 * Where the mouse was when a snapshot was taken, in viewport pixels: the point
 * of the last pointer action on the snapshot's page up to that moment — its
 * own action included, unless the snapshot is from before it. An action's page
 * is the one its snapshots were taken on, the only place a 1.63 trace records
 * it. Null when nothing had moved the mouse yet.
 */
export function pointerAt(
  data: Pick<ParsedTraceData, 'actions' | 'frameSnapshots'>,
  snapshot: TraceFrameSnapshot,
): { x: number; y: number } | null {
  const name = snapshot.snapshotName ?? '';
  const callId = snapshot.callId ?? name.slice(name.indexOf('@') + 1);
  const phase = snapshot.phase ?? name.slice(0, name.indexOf('@'));
  const index = data.actions.findIndex((a) => a.callId === callId);
  if (index < 0) return null;
  const pageOf = (a: TraceAction) => a.pageId ?? data.frameSnapshots.find((s) => s.callId === a.callId)?.pageId;
  for (let i = phase === 'before' ? index - 1 : index; i >= 0; i--) {
    const action = data.actions[i]!;
    if (!action.point) continue;
    const page = pageOf(action);
    if (!snapshot.pageId || !page || page === snapshot.pageId) return action.point;
  }
  return null;
}

/**
 * Render one named snapshot and sanitize it within `capChars`: full fidelity
 * first (inline `<style>` kept), and, when keeping styles blows the cap and
 * would cut the real `<body>` away, lean (inline CSS dropped), which reliably
 * fits and keeps the whole DOM; lean too when the styled render costs more
 * than its budget. Null when the snapshot does not render, or costs more than
 * its budget lean too (`onTooLarge`). `onUnresolved` hears each back-reference
 * the list cannot resolve.
 */
export function renderSanitizedSnapshot(
  snapshots: TraceFrameSnapshot[],
  snapshotName: string,
  capChars: number,
  options: SanitizeOptions = {},
  onUnresolved?: () => void,
  onTooLarge?: () => void,
): { html: string; truncated: boolean } | null {
  let tooLarge = false;
  const styled = renderSnapshotHtml(snapshots, snapshotName, { onUnresolved, onTooLarge: () => (tooLarge = true) });
  if (!styled && !tooLarge) return null;
  const result = styled ? sanitizeDomSnapshot(styled, capChars, options) : null;
  if (result && !result.truncated) return result;
  const lean = renderSnapshotHtml(snapshots, snapshotName, { dropStyles: true, onUnresolved, onTooLarge });
  return lean ? sanitizeDomSnapshot(lean, capChars, options) : result;
}

/**
 * Pick and render the failure-time DOM from parsed trace data: the failing
 * action's after-snapshot (the page when the error was raised, the moment the
 * failure screenshot and the failing aria tree show), falling back to its
 * action snapshot, then its before-snapshot. A runner action (`Test.*`) records
 * none, so the page-side action it drove stands in, in the same order. Finally
 * the frame's last recorded snapshot (final page state). `at` names one
 * action's snapshot to render first — the DOM beside a screenshot of the same
 * moment.
 */
export function extractDomSnapshot(
  data: ParsedTraceData,
  capChars: number,
  options: SanitizeOptions = {},
  at?: SnapshotMoment,
): DomSnapshotResult {
  if (data.frameSnapshots.length === 0) return { status: 'no-snapshot' };

  const fa = data.failingAction;
  const pageAction = pageActionOf(data, fa);
  const named = at ? data.actions.find((a) => a.callId === at.callId) : undefined;
  const failureCandidates = [
    fa?.afterSnapshot,
    fa?.snapshotName,
    fa?.beforeSnapshot,
    pageAction?.afterSnapshot,
    pageAction?.snapshotName,
    pageAction?.beforeSnapshot,
  ].filter((name): name is string => !!name);
  // Final fallback: the last main-frame snapshot in the trace.
  const mains = data.frameSnapshots.filter((s) => s.isMainFrame !== false && s.snapshotName);
  const last = mains[mains.length - 1];
  if (last?.snapshotName && !failureCandidates.includes(last.snapshotName)) failureCandidates.push(last.snapshotName);
  const failureName = failureCandidates.find((name) => data.frameSnapshots.some((s) => s.snapshotName === name));
  const asked = at?.phase === 'before' ? named?.beforeSnapshot : (named?.afterSnapshot ?? named?.snapshotName);
  const candidates = asked ? [asked, ...failureCandidates] : failureCandidates;

  for (const name of candidates) {
    const result = renderSanitizedSnapshot(data.frameSnapshots, name, capChars, options);
    if (!result) continue;
    // The viewport of the snapshot we rendered (main frame preferred, mirroring
    // renderSnapshotHtml) so the client can render it at its true proportions.
    const rendered =
      data.frameSnapshots.find((s) => s.snapshotName === name && s.isMainFrame !== false) ??
      data.frameSnapshots.find((s) => s.snapshotName === name);
    // Where the mouse was, for the frame script to mark it and what it hovered.
    const pointer = rendered ? pointerAt(data, rendered) : null;
    const html = pointer
      ? result.html.replace(/<html\b/i, `<html data-piwi-pointer="${pointer.x},${pointer.y}"`)
      : result.html;
    return {
      status: 'ok',
      html,
      truncated: result.truncated,
      snapshotName: name,
      atFailure: name === failureName,
      action: fa?.apiName,
      viewport: rendered?.viewport,
      frameUrl: rendered?.frameUrl,
    };
  }
  return { status: 'no-snapshot' };
}

/**
 * The failure-time snapshot with what the page was doing at test end, as the
 * reporter read it into its page state (focus, hover, a text selection,
 * indeterminate checkboxes), handed to the frame script as JSON on `<html>`
 * (`data-piwi-page-state`): element paths only, which the script resolves in
 * the rendered page. Any other snapshot, the ARIA view, or a page state
 * without them is returned as is.
 */
export function withPageInteraction(result: DomSnapshotResult, pageState: unknown): DomSnapshotResult {
  if (result.status !== 'ok' || !result.html || !result.atFailure || result.source === 'aria') return result;
  const { focus, hover, selection, indeterminate } = sanitizePageInteraction(pageState);
  const forFrame = {
    ...(focus ? { focus: { path: focus.element.path, visible: focus.visible } } : {}),
    ...(hover ? { hover: hover.path } : {}),
    ...(selection ? { selection: { start: selection.start, end: selection.end } } : {}),
    ...(indeterminate ? { indeterminate: indeterminate.map((box) => box.path) } : {}),
  };
  if (Object.keys(forFrame).length === 0) return result;
  const attr = `data-piwi-page-state="${escapeAttr(JSON.stringify(forFrame))}"`;
  return { ...result, html: result.html.replace(/<html\b/i, `<html ${attr}`) };
}
