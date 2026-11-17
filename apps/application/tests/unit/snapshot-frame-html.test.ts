import { describe, expect, test } from 'vitest';
import {
  snapshotFrameHeaders,
  snapshotFrameHtml,
  snapshotFrameInlineHtml,
  snapshotFrameNonce,
} from '../../server/utils/snapshot-frame-html';

/** A snapshot frame's document and its policy, served with headers or taken inline (`srcdoc`). */

const POLICY =
  "default-src 'none'; script-src 'nonce-n0nce'; style-src 'unsafe-inline'; img-src data:; font-src data:; " +
  "media-src data:; base-uri 'none'; form-action 'none'";

describe('a snapshot frame’s policy', () => {
  test('is the served document’s header, sandboxed', () => {
    expect(snapshotFrameHeaders('n0nce')['Content-Security-Policy']).toBe(`sandbox allow-scripts; ${POLICY}`);
  });

  test('travels in the document taken inline, first in its head, without the sandbox its iframe sets', () => {
    const doc = snapshotFrameHtml(
      '<!DOCTYPE html><html><head><title>Checkout</title></head><body>x</body></html>',
      'readonly',
      'n0nce',
    );
    const inline = snapshotFrameInlineHtml(doc, 'n0nce');
    const meta = `<meta http-equiv="Content-Security-Policy" content="${POLICY}">`;
    expect(inline).toContain(meta);
    expect(inline.indexOf(meta)).toBeLessThan(inline.indexOf('<title>'));
    expect(inline.indexOf(meta)).toBeGreaterThan(inline.indexOf('<head'));
    expect(inline.replace(meta, '')).toBe(doc);
    expect(meta).not.toContain('sandbox');
  });

  test('travels in a document with no head, after its doctype', () => {
    expect(snapshotFrameInlineHtml('<!doctype html><p>x</p>', 'n0nce')).toBe(
      `<!doctype html><head><meta http-equiv="Content-Security-Policy" content="${POLICY}"></head><p>x</p>`,
    );
  });

  test('names a fresh nonce for each document', () => {
    const nonce = snapshotFrameNonce();
    expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(snapshotFrameNonce()).not.toBe(nonce);
  });
});
