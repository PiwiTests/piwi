import {
  buildPickerDocument,
  buildReadonlyDocument,
  readonlyScriptTag,
  snapshotPickerScriptTag,
} from '#shared/snapshot-picker-document';
import { CAPTURED_ATTRIBUTES } from '#shared/locator-generation';

/**
 * A rendered snapshot frame's document and the headers that sandbox it, with no Node module: the server serves them
 * (`dom-snapshot-frame.ts`), and so does the demo's service worker for the pages its Inspect shows
 * (`app/demo/api/live-view.ts`).
 */

/** How a snapshot frame shows the page: the interactive locator picker, or the read-only render. */
export type SnapshotFrameMode = 'pick' | 'readonly';

/** The mode a request names (`mode=readonly`), the picker otherwise. */
export function snapshotFrameMode(query: Record<string, unknown>): SnapshotFrameMode {
  return query.mode === 'readonly' ? 'readonly' : 'pick';
}

/**
 * A minimal valid document for a frame with no snapshot, so the iframe renders blank rather than erroring: a client
 * points a frame at a snapshot only once it knows one exists.
 */
const EMPTY_DOC =
  '<!doctype html><html><head><meta charset="utf-8"><title>No snapshot</title></head><body></body></html>';

/** A nonce for a snapshot frame's script, drawn afresh for each document. */
export function snapshotFrameNonce(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
}

/** What a snapshot frame's document may do, past its sandbox: only the script marked with `nonce`, nothing from the network. */
function snapshotFramePolicy(nonce: string): string[] {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    "style-src 'unsafe-inline'",
    'img-src data:',
    'font-src data:',
    'media-src data:',
    "base-uri 'none'",
    "form-action 'none'",
  ];
}

/**
 * The headers of a snapshot frame's document: an opaque origin with scripts allowed, matching the iframe's own
 * `sandbox="allow-scripts"`, where only the script marked with `nonce` runs and nothing loads from the network.
 */
export function snapshotFrameHeaders(nonce: string): Record<string, string> {
  return {
    'Content-Security-Policy': ['sandbox allow-scripts', ...snapshotFramePolicy(nonce)].join('; '),
    'Content-Type': 'text/html; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  };
}

/**
 * A snapshot frame's document: the page with the picker's script or the read-only one, marked with `nonce`. `html`
 * null is an empty document; `offline` says its network references were stripped already (`stripNetworkReferences`, as
 * a live page kept rendered is).
 */
export function snapshotFrameHtml(
  html: string | null,
  mode: SnapshotFrameMode,
  nonce: string,
  { offline = false }: { offline?: boolean } = {},
): string {
  if (!html) return EMPTY_DOC;
  const config = { probedAttrs: CAPTURED_ATTRIBUTES };
  if (offline) return html + (mode === 'readonly' ? readonlyScriptTag(nonce) : snapshotPickerScriptTag(config, nonce));
  return mode === 'readonly' ? buildReadonlyDocument(html, nonce) : buildPickerDocument(html, config, nonce);
}

/**
 * A snapshot frame's document for a frame that takes it inline (`srcdoc`), which no header reaches: the policy of
 * `snapshotFrameHeaders` but its sandbox, which the iframe's own attribute sets, as a `<meta>` first in its head.
 */
export function snapshotFrameInlineHtml(doc: string, nonce: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${snapshotFramePolicy(nonce).join('; ')}">`;
  const head = /<head(?:\s[^>]*)?>/i.exec(doc);
  if (head) return doc.slice(0, head.index + head[0].length) + meta + doc.slice(head.index + head[0].length);
  const doctype = /^\s*<!doctype[^>]*>/i.exec(doc);
  const at = doctype ? doctype[0].length : 0;
  return `${doc.slice(0, at)}<head>${meta}</head>${doc.slice(at)}`;
}
