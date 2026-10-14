/**
 * Failure-time DOM snapshot resolution over stored traces. The pure rendering
 * (`renderSnapshotHtml`/`extractDomSnapshot`) lives in the node-free
 * `dom-snapshot-render.ts` so the browser demo can reuse it; this module wires
 * it to node-only trace loading (storage + zlib via `trace-evidence.ts`). No
 * re-exports: Nitro auto-imports every server/utils export, and duplicates
 * would shadow each other — import the pure API from `dom-snapshot-render.ts`
 * directly.
 */
import { getStorage } from '../storage';
import { loadStoredTraceEvents } from './trace-evidence';
import { decodeResource } from './resource-compression';
import type { TraceResource } from './trace-events';
import {
  DOM_SNAPSHOT_CAP_CHARS,
  extractDomSnapshot,
  collectStylesheetLinks,
  inlineStylesheets,
  collectCssUrls,
  inlineCssUrls,
  collectImageSources,
  inlineImageSources,
  mediaMatchesViewport,
  maskCssText,
  withPageInteraction,
  type DomSnapshotResult,
  type DomSnapshotSource,
  type SnapshotMoment,
} from './dom-snapshot-render';
// The ARIA-snapshot fallback renderer lives in its own node-free module so the
// browser demo can reuse it (the trace path above pulls in node-only zlib).
import { renderAriaSnapshotHtml } from './dom-snapshot-aria';

// Budgets — a broken app can ship huge bundles, and base64 inflates by a third,
// so cap both the text and the embedded binary.
const MAX_STYLESHEET_BYTES = 4_000_000; // per external stylesheet
const INLINE_ASSET_BUDGET = 2_500_000; // total raw bytes embedded as data: URIs across the snapshot
const MAX_ASSET_BYTES = 512_000; // per font/image
const INLINE_STYLES_MAX_CHARS = 8_000_000; // ceiling on total inlined CSS text (incl. data: URIs)

/** File-extension → MIME fallback when the trace didn't record a usable Content-Type. */
const EXT_MIME: Record<string, string> = {
  woff2: 'font/woff2',
  woff: 'font/woff',
  ttf: 'font/ttf',
  otf: 'font/otf',
  eot: 'application/vnd.ms-fontobject',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
};

/** Resolve a `<link href>` / CSS `url(...)` (possibly relative) against a base URL. */
function resolveResourceUrl(href: string, base: string | undefined): string | null {
  try {
    return new URL(href, base).href;
  } catch {
    return null;
  }
}

/**
 * The MIME type to stamp on a `data:` URI for a captured asset: the recorded
 * Content-Type when it's a real type, else inferred from the stored file's or
 * the reference's extension. Null when nothing plausible is known — the caller
 * then leaves the reference alone rather than emit a mis-typed data URI.
 */
function assetMimeType(res: TraceResource, ref: string): string | null {
  const recorded = res.mimeType?.split(';')[0]?.trim();
  if (recorded && recorded.includes('/') && !/x-unknown|octet-stream/i.test(recorded)) return recorded;
  const ext = (
    /\.([a-z0-9]+)(?:[?#]|$)/i.exec(res.sha1)?.[1] ?? /\.([a-z0-9]+)(?:[?#]|$)/i.exec(ref)?.[1]
  )?.toLowerCase();
  return (ext && EXT_MIME[ext]) || null;
}

/** Where the snapshot's captured resources live, and the binary budget they share. */
interface AssetSource {
  urlToRes: Map<string, TraceResource>;
  resourcesDir: string;
  budget: { value: number };
}

/**
 * A captured asset (font, image) as a base64 `data:` URI, charged to the shared
 * budget once per use — every use embeds its own copy. `ref` resolves against
 * `baseUrl`, then looks up the stored body. Null when the trace didn't capture
 * it, its type is unknown, it is too large for what's left of the budget, or it
 * can't be read.
 */
async function assetDataUri(
  ref: string,
  baseUrl: string | undefined,
  assets: AssetSource,
  uses = 1,
): Promise<string | null> {
  const abs = resolveResourceUrl(ref, baseUrl);
  const res = (abs ? assets.urlToRes.get(abs) : undefined) ?? assets.urlToRes.get(ref);
  if (!res) return null;
  const mime = assetMimeType(res, ref);
  if (!mime) return null;
  try {
    const bytes = decodeResource(await getStorage().readFile(`${assets.resourcesDir}/${res.sha1}`));
    const cost = bytes.length * uses;
    if (bytes.length === 0 || bytes.length > MAX_ASSET_BYTES || cost > assets.budget.value) return null;
    assets.budget.value -= cost;
    return `data:${mime};base64,${bytes.toString('base64')}`;
  } catch {
    return null;
  }
}

/**
 * Embed a stylesheet's own `url(...)` assets (fonts, background images) as
 * base64 `data:` URIs so they render in the offline, opaque-origin iframe. Each
 * ref resolves against the stylesheet's URL (not the document's). Returns the
 * CSS with resolvable refs rewritten; the rest untouched.
 */
async function inlineCssAssets(css: string, styleBaseUrl: string, assets: AssetSource): Promise<string> {
  if (assets.budget.value <= 0) return css;
  const replacements: Record<string, string> = {};
  for (const [ref, uses] of collectCssUrls(css)) {
    if (assets.budget.value <= 0) break;
    const dataUri = await assetDataUri(ref, styleBaseUrl, assets, uses);
    if (dataUri) replacements[ref] = dataUri;
  }
  return Object.keys(replacements).length ? inlineCssUrls(css, replacements) : css;
}

/**
 * Embed every `<img src>` the trace captured as a `data:` URI, resolved against
 * the frame's URL, so the page's images render in the offline iframe. Images
 * the trace lacks keep their `src`.
 */
async function inlineImages(html: string, frameUrl: string | undefined, assets: AssetSource): Promise<string> {
  const replacements: Record<string, string> = {};
  for (const [src, uses] of collectImageSources(html)) {
    if (assets.budget.value <= 0) break;
    const dataUri = await assetDataUri(src, frameUrl, assets, uses);
    if (dataUri) replacements[src] = dataUri;
  }
  return inlineImageSources(html, replacements);
}

/**
 * Inline the snapshot's external stylesheets, then its images, from the trace's
 * stored resources. Each reference maps → absolute URL (via the frame's base) →
 * content hash (from the `.network` stream) → the body stored under the
 * project's `trace-resources` pool. Stylesheets go first, so their fonts and
 * backgrounds take the shared budget before images do. Purely additive: any
 * missing piece leaves that `<link>` or `<img>` untouched.
 */
async function inlineTraceAssets(
  blobPath: string,
  urlToRes: Map<string, TraceResource>,
  result: DomSnapshotResult,
): Promise<DomSnapshotResult> {
  if (result.status !== 'ok' || !result.html) return result;
  if (urlToRes.size === 0) return result;

  // Resources live in a project-scoped shared pool; the id is in the blob path
  // (`project-<id>/blobs/<hash>.zip`).
  const projectId = /^project-(\d+)\//.exec(blobPath)?.[1];
  if (!projectId) return result;
  const assets: AssetSource = {
    urlToRes,
    resourcesDir: `project-${projectId}/trace-resources`,
    budget: { value: INLINE_ASSET_BUDGET },
  };

  const cssByHref: Record<string, string> = {};
  for (const { href, media } of collectStylesheetLinks(result.html)) {
    // A sheet for another viewport never applies in the frame, which renders at
    // the recorded one.
    if (media && !mediaMatchesViewport(media, result.viewport)) continue;
    const abs = resolveResourceUrl(href, result.frameUrl);
    const res = (abs ? urlToRes.get(abs) : undefined) ?? urlToRes.get(href);
    if (!res) continue;
    try {
      const bytes = decodeResource(await getStorage().readFile(`${assets.resourcesDir}/${res.sha1}`));
      if (bytes.length === 0 || bytes.length > MAX_STYLESHEET_BYTES) continue;
      // Embed the sheet's own url() assets first, THEN mask token-shaped secrets
      // — masking last leaves the fresh base64 data URIs (and this sheet's
      // content-hashed filenames) intact.
      const css = await inlineCssAssets(bytes.toString('utf8'), abs ?? href, assets);
      cssByHref[href] = maskCssText(css);
    } catch {
      // Resource missing/unreadable — leave the <link> as-is.
    }
  }
  const styled = inlineStylesheets(result.html, cssByHref, INLINE_STYLES_MAX_CHARS);
  const html = await inlineImages(styled, result.frameUrl, assets);
  return html === result.html ? result : { ...result, html };
}

/** Options for {@link getTraceDomSnapshot}. */
export interface TraceDomSnapshotOptions {
  /** Inline external stylesheets and images from the trace's resources (the rendered page only). */
  inlineStyles?: boolean;
  /** One action's snapshot to render first, see `extractDomSnapshot`. */
  at?: SnapshotMoment;
}

/** `extractDomSnapshot` over a stored (slim) trace blob, optionally inlining its stylesheets and images. */
export async function getTraceDomSnapshot(
  blobPath: string,
  capChars: number,
  options: TraceDomSnapshotOptions = {},
): Promise<DomSnapshotResult> {
  const events = await loadStoredTraceEvents(blobPath);
  if (!events) return { status: 'no-trace' };

  // The rendered page views keep the page's inline images; text consumers get them masked.
  const result = extractDomSnapshot(events.parsed, capChars, { keepInlineImages: options.inlineStyles }, options.at);
  if (!options.inlineStyles) return result;
  try {
    return await inlineTraceAssets(blobPath, events.resourcesByUrl, result);
  } catch {
    // Inlining is best-effort decoration — never fail the snapshot over it.
    return result;
  }
}

/** Options for {@link resolveCaseDomSnapshot}. */
export interface ResolveCaseDomSnapshotOptions {
  /**
   * Which representation to render. Defaults to `dom` (trace-derived) when a
   * trace exists, falling back to `aria`. Pass `aria` to force the ARIA tree
   * even when a trace is available (the view toggle).
   */
  source?: DomSnapshotSource;
  /**
   * Inline the trace's stylesheets and images so the snapshot renders as
   * recorded. The rendered page frame (`dom-snapshot-frame`) requests it; text
   * consumers such as the AI context do not, where inlined bundles would just
   * be noise.
   */
  inlineStyles?: boolean;
  /** One action's snapshot to render first — the DOM beside a screenshot of the same moment. */
  at?: SnapshotMoment;
  /** The case's page state: its focus, hover and selection apply to the failure-time snapshot. */
  pageState?: unknown;
}

/**
 * Resolve the failure-time snapshot for a case. By default it prefers the
 * trace-derived DOM and falls back to the ARIA tree, but `source: 'aria'`
 * forces the ARIA tree even when a trace exists. The result reports which
 * representation it is (`source`) and every representation available for the
 * case (`availableSources`) so the UI can offer a view toggle. Shared by the
 * dom-snapshot endpoint and the interactive locator picker.
 */
export async function resolveCaseDomSnapshot(
  traceBlobPath: string | null | undefined,
  ariaSnapshot: string | null | undefined,
  capChars: number = DOM_SNAPSHOT_CAP_CHARS,
  options: ResolveCaseDomSnapshotOptions = {},
): Promise<DomSnapshotResult> {
  // Render the ARIA tree up front (cheap) so we can both offer it as a toggle
  // and serve it directly without parsing the trace when it's the one requested.
  const ariaHtml = ariaSnapshot ? renderAriaSnapshotHtml(ariaSnapshot) : null;
  let domAvailable = !!traceBlobPath;
  const ariaAvailable = !!ariaHtml;

  const sources = (): DomSnapshotSource[] => {
    const list: DomSnapshotSource[] = [];
    if (domAvailable) list.push('dom');
    if (ariaAvailable) list.push('aria');
    return list;
  };
  const asAria = (): DomSnapshotResult => ({
    status: 'ok',
    html: ariaHtml!,
    truncated: false,
    snapshotName: 'aria-fallback',
    source: 'aria',
    availableSources: sources(),
  });

  // Explicit ARIA request — skip the trace entirely.
  if (options.source === 'aria' && ariaHtml) return asAria();

  if (traceBlobPath) {
    const result = await getTraceDomSnapshot(traceBlobPath, capChars, {
      inlineStyles: options.inlineStyles,
      at: options.at,
    });
    if (result.status === 'ok' && result.html) {
      return withPageInteraction({ ...result, source: 'dom', availableSources: sources() }, options.pageState);
    }
    // The trace produced no usable DOM — drop it as an option and fall back.
    domAvailable = false;
  }
  if (ariaHtml) return asAria();
  return { status: 'no-trace', availableSources: sources() };
}
