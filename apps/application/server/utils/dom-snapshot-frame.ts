import { randomBytes } from 'node:crypto';
import { setResponseHeader, type H3Event } from 'h3';
import { snapshotFrameHeaders, snapshotFrameHtml, type SnapshotFrameMode } from './snapshot-frame-html';

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
  options: { offline?: boolean } = {},
): string {
  const nonce = randomBytes(16).toString('base64');
  for (const [name, value] of Object.entries(snapshotFrameHeaders(nonce))) setResponseHeader(event, name, value);
  return snapshotFrameHtml(html, mode, nonce, options);
}
