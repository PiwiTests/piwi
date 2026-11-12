import { randomBytes } from 'node:crypto';
import { setResponseHeader, type H3Event } from 'h3';
import {
  buildPickerDocument,
  buildReadonlyDocument,
  readonlyScriptTag,
  snapshotPickerScriptTag,
} from '#shared/snapshot-picker-document';
import { CAPTURED_ATTRIBUTES } from '#shared/locator-generation';

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

/**
 * The document of a rendered snapshot frame, with the headers that sandbox it: an opaque origin with scripts allowed,
 * matching the iframe's own `sandbox="allow-scripts"`, where only the nonce-marked builder script runs and nothing
 * loads from the network. The document carries its stylesheets and images inline, so any fetch left in the snapshot is
 * blocked rather than sent to this origin or the tested app. Served over HTTP (not `srcdoc`), the frame carries this
 * policy instead of inheriting the dashboard page's `strict-dynamic` CSP, which would block the inline picker script.
 * `html` null serves an empty document; `offline` says its network references were stripped already
 * (`stripNetworkReferences`, as a live page kept rendered is).
 */
export function snapshotFrameDocument(
  event: H3Event,
  html: string | null,
  mode: SnapshotFrameMode,
  { offline = false }: { offline?: boolean } = {},
): string {
  const nonce = randomBytes(16).toString('base64');
  setResponseHeader(
    event,
    'Content-Security-Policy',
    [
      'sandbox allow-scripts',
      "default-src 'none'",
      `script-src 'nonce-${nonce}'`,
      "style-src 'unsafe-inline'",
      'img-src data:',
      'font-src data:',
      'media-src data:',
      "base-uri 'none'",
      "form-action 'none'",
    ].join('; '),
  );
  setResponseHeader(event, 'Content-Type', 'text/html; charset=utf-8');
  setResponseHeader(event, 'X-Content-Type-Options', 'nosniff');
  setResponseHeader(event, 'Cache-Control', 'no-store');
  if (!html) return EMPTY_DOC;
  const config = { probedAttrs: CAPTURED_ATTRIBUTES };
  if (offline) return html + (mode === 'readonly' ? readonlyScriptTag(nonce) : snapshotPickerScriptTag(config, nonce));
  return mode === 'readonly' ? buildReadonlyDocument(html, nonce) : buildPickerDocument(html, config, nonce);
}
