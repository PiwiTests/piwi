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
import { pageActionOf, type ParsedTraceData, type TraceFrameSnapshot } from './trace-events';

/**
 * Cap for the rendered snapshot HTML. Generous so a fully-styled snapshot
 * (inline CSS can run to a few hundred KB) fits; `extractDomSnapshot` drops
 * inline `<style>` only when a page exceeds it.
 */
export const DOM_SNAPSHOT_CAP_CHARS = 1_500_000;

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

/** Input types whose `value` is not what the field shows: a checkbox's or radio's submitted value, a file's fake path. */
const VALUELESS_INPUT_TYPES = new Set(['checkbox', 'radio', 'file']);

type Attrs = Record<string, unknown>;

/**
 * One element's attributes as the renderer writes them: its recorded ones,
 * less inline handlers and unsafe names, with its live state applied. What
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
    // Inline handlers are noise for diagnosis and unsafe to re-emit.
    if (/^on[a-z]/i.test(name) || UNSAFE_NAME_RE.test(name)) continue;
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

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

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
 * snapshot is missing or the tree is entirely unrenderable.
 */
export function renderSnapshotHtml(
  snapshots: TraceFrameSnapshot[],
  snapshotName: string,
  options: RenderOptions = {},
): string | null {
  const { dropStyles = false } = options;
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

  /**
   * The node a back-reference names, in the earlier snapshot's node space —
   * rendering continues in THAT snapshot's context, whose own refs go further
   * back. Null when it can't be resolved.
   */
  const deref = (ref: unknown[], snapshotIndex: number): { node: unknown; snapshotIndex: number } | null => {
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
    if (typeof n === 'string') return n;
    if (!Array.isArray(n) || !Array.isArray(n[0])) return null;
    const ref = deref(n[0], snapshotIndex);
    return ref ? textOf(ref.node, ref.snapshotIndex) : null;
  };

  const render = (n: unknown, snapshotIndex: number): string => {
    if (typeof n === 'string') return escapeText(n);
    if (!Array.isArray(n) || n.length === 0) return '';

    if (Array.isArray(n[0])) {
      const ref = deref(n[0], snapshotIndex);
      return ref ? render(ref.node, ref.snapshotIndex) : '<!-- [unresolved snapshot reference] -->';
    }

    if (typeof n[0] !== 'string' || !n[0] || UNSAFE_NAME_RE.test(n[0])) return '';
    // HTML tags are recorded upper case, SVG ones as authored (`svg`, `script`).
    const tagUpper = (n[0] as string).toUpperCase();
    const tag = tagUpper.toLowerCase();
    const attrs: Attrs = n[1] && typeof n[1] === 'object' && !Array.isArray(n[1]) ? (n[1] as Attrs) : {};

    // A script is an empty marker — no `src`, no body — so nothing the page
    // shipped ever runs in the rendered frame. Playwright drops HTML scripts when
    // recording but keeps SVG ones, whose tag is lower case.
    if (tagUpper === 'SCRIPT') return '<script></script>';
    if (tagUpper === 'LINK' && isResourceHint(attrs)) return '';

    // An adopted stylesheet (the document's or a shadow root's) is recorded as a
    // `template` holding its CSS, where it applies: written there as a `<style>`.
    const adopted = attrs[LIVE.styleSheet];
    if (tagUpper === 'TEMPLATE' && typeof adopted === 'string') {
      return dropStyles ? '<style></style>' : `<style>${rawStyleText(adopted)}</style>`;
    }

    let out = `<${tag}`;
    // A shadow root is recorded as a `template` first in its host; as a
    // declarative shadow root, the browser attaches it while parsing.
    if (tagUpper === 'TEMPLATE' && attrs[LIVE.shadowRoot] !== undefined) out += ' shadowrootmode="open"';
    for (const [name, value] of renderedAttributes(tagUpper, attrs, isTargetMark)) {
      out += ` ${name}="${escapeAttr(value)}"`;
    }
    out += '>';
    if (VOID_ELEMENTS.has(tagUpper)) return out;

    const value = attrs[LIVE.value];
    if (tagUpper === 'TEXTAREA' && typeof value === 'string') {
      // The parser drops one newline right after `<textarea>`.
      return `${out}${value.startsWith('\n') ? '\n' : ''}${escapeText(value)}</${tag}>`;
    }

    // `<style>` bodies are dropped only under the lean fallback; the tag stays
    // as a marker. An HTML `<style>` holds raw text, so its CSS is written as
    // is; an SVG `style` (recorded lower case) is parsed as markup and stays escaped.
    if (dropStyles && tagUpper === 'STYLE') return `${out}</${tag}>`;
    const rawText = n[0] === 'STYLE';
    for (let i = 2; i < n.length; i++) {
      const text = rawText ? textOf(n[i], snapshotIndex) : null;
      out += text !== null ? rawStyleText(text) : render(n[i], snapshotIndex);
    }
    return `${out}</${tag}>`;
  };

  try {
    const body = render(target.html, targetIndex);
    if (!body) return null;
    const doctype = target.doctype ? `<!DOCTYPE ${target.doctype}>\n` : '';
    return doctype + body;
  } catch {
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
  return { href, media };
}

/** Every `<link rel="stylesheet">` in the HTML, unique by original `href`, with its `media`. Pure. */
export function collectStylesheetLinks(html: string): { href: string; media: string | null }[] {
  const out: { href: string; media: string | null }[] = [];
  const seen = new Set<string>();
  const re = /<link\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const link = parseStylesheetLink(m[0]);
    if (link && !seen.has(link.href)) {
      seen.add(link.href);
      out.push(link);
    }
  }
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
  return html.replace(/<link\b[^>]*>/gi, (tag) => {
    const link = parseStylesheetLink(tag);
    if (!link) return tag;
    const css = cssByHref[link.href];
    if (typeof css !== 'string' || css.length === 0 || css.length > budget) return tag;
    budget -= css.length;
    const media = link.media ? ` media="${escapeAttr(link.media)}"` : '';
    return `<style${media}>${rawStyleText(css)}</style>`;
  });
}

// A `url(...)` target: single/double quoted (group 2) or bare (group 3).
const CSS_URL_RE = /url\(\s*(?:(['"])(.*?)\1|([^)\s'"]+))\s*\)/gi;

/**
 * Every `url(...)` target in a CSS body worth resolving — quotes stripped, and
 * already-inline (`data:`) / in-document (`#id`) refs skipped — with how many
 * times the CSS uses it: each use embeds its own copy. Pure; the caller
 * resolves each against the stylesheet's own URL.
 */
export function collectCssUrls(css: string): Map<string, number> {
  const uses = new Map<string, number>();
  const re = new RegExp(CSS_URL_RE.source, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    const raw = (m[2] ?? m[3] ?? '').trim();
    // Skip already-inline data: URIs and any fragment ref (`#blur` filters,
    // `sprite.svg#icon`) — a data: URI can't carry the fragment that addresses
    // the resource, so inlining would break them; leaving them alone is safer.
    if (!raw || raw.startsWith('data:') || raw.includes('#')) continue;
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
  return css.replace(new RegExp(CSS_URL_RE.source, 'gi'), (full, _q, quoted, bare) => {
    const raw = (quoted ?? bare ?? '').trim();
    const repl = replacements[raw];
    return repl ? `url("${repl}")` : full;
  });
}

// The `src` of an `<img>` start tag as the renderer writes it (double-quoted).
// Quoted values are skipped whole, so a `>` inside one never ends the tag early.
const IMG_SRC_RE = /(<img(?=[\s/>])(?:[^>"']|"[^"]*"|'[^']*')*?\ssrc=")([^"]*)(")/gi;

function unescapeAttr(value: string): string {
  return value.replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

/**
 * Every `<img src>` URL in rendered snapshot HTML (`data:` URIs skipped), with
 * how many images use it — each use embeds its own copy. Pure.
 */
export function collectImageSources(html: string): Map<string, number> {
  const uses = new Map<string, number>();
  for (const m of html.matchAll(IMG_SRC_RE)) {
    const src = unescapeAttr(m[2]!).trim();
    if (src && !/^data:/i.test(src)) uses.set(src, (uses.get(src) ?? 0) + 1);
  }
  return uses;
}

/**
 * Point every `<img src>` whose URL appears in `replacements` at its
 * replacement — a `data:` URI of the image captured in the trace. Others are
 * left untouched. Pure.
 */
export function inlineImageSources(html: string, replacements: Record<string, string>): string {
  if (!html || Object.keys(replacements).length === 0) return html;
  return html.replace(IMG_SRC_RE, (full, open: string, value: string, close: string) => {
    const repl = replacements[unescapeAttr(value).trim()];
    return repl ? `${open}${escapeAttr(repl)}${close}` : full;
  });
}

/** The two representations a case can be viewed as: trace-derived DOM or the ARIA tree. */
export type DomSnapshotSource = 'dom' | 'aria';

export interface DomSnapshotResult {
  status: 'ok' | 'no-trace' | 'no-snapshot';
  html?: string;
  truncated?: boolean;
  /** Which snapshot was rendered (e.g. `before@call@12`). */
  snapshotName?: string;
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
  const candidates = [
    at?.phase === 'before' ? named?.beforeSnapshot : (named?.afterSnapshot ?? named?.snapshotName),
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
  if (last?.snapshotName && !candidates.includes(last.snapshotName)) candidates.push(last.snapshotName);

  for (const name of candidates) {
    // Full-fidelity first (inline <style> kept). If keeping styles blows the
    // cap the real <body> can get truncated away, so re-render lean (inline
    // CSS dropped) — that reliably fits and preserves the whole DOM.
    const styled = renderSnapshotHtml(data.frameSnapshots, name);
    if (!styled) continue;
    let result = sanitizeDomSnapshot(styled, capChars, options);
    if (result.truncated) {
      const lean = renderSnapshotHtml(data.frameSnapshots, name, { dropStyles: true });
      if (lean) result = sanitizeDomSnapshot(lean, capChars, options);
    }
    // The viewport of the snapshot we rendered (main frame preferred, mirroring
    // renderSnapshotHtml) so the client can render it at its true proportions.
    const rendered =
      data.frameSnapshots.find((s) => s.snapshotName === name && s.isMainFrame !== false) ??
      data.frameSnapshots.find((s) => s.snapshotName === name);
    return {
      status: 'ok',
      html: result.html,
      truncated: result.truncated,
      snapshotName: name,
      action: fa?.apiName,
      viewport: rendered?.viewport,
      frameUrl: rendered?.frameUrl,
    };
  }
  return { status: 'no-snapshot' };
}
