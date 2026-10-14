import { describe, test, expect } from 'vitest';
import { FAILURE_SCREENSHOT_ATTACHMENT } from '@piwitests/core/wire';
import {
  classifyEvidenceFile,
  contentTypeForPath,
  failurePageFirst,
  failurePageScreenshot,
  isScreenshotFileRow,
  isVideoFileRow,
  supportedImageMediaType,
} from '#shared/file-classify';

/**
 * Ingestion (`case-files.post.ts`, `upload.post.ts`, `import-runs.ts`) stores a
 * Playwright attachment as `type='attachment'`, `subtype=<attachment name>`,
 * `label=<content type>`. These helpers build rows in that exact shape so the
 * cases below stay tied to what the endpoints actually write.
 */
const attachment = (name: string, contentType: string | null, path: string) => ({
  type: 'attachment',
  subtype: name,
  label: contentType,
  path,
});

describe('isScreenshotFileRow', () => {
  test('accepts legacy type=screenshot rows whatever their path', () => {
    expect(isScreenshotFileRow({ type: 'screenshot', path: 'x/shot.png' })).toBe(true);
    expect(isScreenshotFileRow({ type: 'screenshot', path: 'x/opaque-blob' })).toBe(true);
  });

  test('accepts an attachment whose content type is an image', () => {
    expect(isScreenshotFileRow(attachment('screenshot', 'image/png', 'x/screenshot.png'))).toBe(true);
    expect(isScreenshotFileRow(attachment('checkout-actual', 'image/png', 'x/checkout-actual.png'))).toBe(true);
    // The path carries no extension — the content type still settles it.
    expect(isScreenshotFileRow(attachment('shot', 'image/jpeg', 'x/blob-abc123'))).toBe(true);
  });

  test('trusts the content type over the attachment name', () => {
    expect(isScreenshotFileRow(attachment('screenshot-metadata', 'application/json', 'x/meta.json'))).toBe(false);
    expect(isScreenshotFileRow(attachment('screenshots-taken', 'text/plain', 'x/list.txt'))).toBe(false);
  });

  test('falls back to the attachment name when no content type was recorded', () => {
    expect(isScreenshotFileRow(attachment('screenshot', null, 'x/a.bin'))).toBe(true);
    expect(isScreenshotFileRow(attachment('screenshot-1', null, 'x/a.bin'))).toBe(true);
    expect(isScreenshotFileRow(attachment('Screenshot', null, 'x/a.bin'))).toBe(true);
  });

  test('falls back to the file extension, case-insensitively', () => {
    expect(isScreenshotFileRow(attachment('evidence', null, 'x/final-state.JPG'))).toBe(true);
    expect(isScreenshotFileRow(attachment('evidence', null, 'x/final-state.webp'))).toBe(true);
    expect(isScreenshotFileRow(attachment('evidence', null, 'x/notes.md'))).toBe(false);
    expect(isScreenshotFileRow(attachment('evidence', null, 'x/no-extension'))).toBe(false);
    expect(isScreenshotFileRow(attachment('evidence', null, ''))).toBe(false);
  });

  test('rejects videos, other evidence kinds and unrelated file types', () => {
    expect(isScreenshotFileRow(attachment('video', 'video/webm', 'x/v.webm'))).toBe(false);
    expect(isScreenshotFileRow(attachment('error-context', 'text/markdown', 'x/error-context.md'))).toBe(false);
    expect(isScreenshotFileRow({ type: 'trace', path: 'x/trace.zip' })).toBe(false);
    expect(isScreenshotFileRow({ type: 'video', path: 'x/v.webm' })).toBe(false);
    expect(isScreenshotFileRow({ type: 'report', subtype: 'html', path: 'x/index.html' })).toBe(false);
  });
});

describe('isVideoFileRow', () => {
  test('accepts legacy type=video rows and video content types', () => {
    expect(isVideoFileRow({ type: 'video', path: 'x/v.webm' })).toBe(true);
    expect(isVideoFileRow(attachment('video', 'video/webm', 'x/video.webm'))).toBe(true);
    expect(isVideoFileRow(attachment('recording', 'video/mp4', 'x/opaque-blob'))).toBe(true);
  });

  test('trusts the content type over the attachment name', () => {
    expect(isVideoFileRow(attachment('video-notes', 'text/plain', 'x/notes.txt'))).toBe(false);
    // A .ogg is as often audio as video, and the content type says which.
    expect(isVideoFileRow(attachment('beep', 'audio/ogg', 'x/beep.ogg'))).toBe(false);
  });

  test('falls back to the attachment name, then the extension', () => {
    expect(isVideoFileRow(attachment('video', null, 'x/a.bin'))).toBe(true);
    expect(isVideoFileRow(attachment('evidence', null, 'x/run.MP4'))).toBe(true);
    expect(isVideoFileRow(attachment('evidence', null, 'x/shot.png'))).toBe(false);
  });

  test('rejects screenshots and other file types', () => {
    expect(isVideoFileRow(attachment('screenshot', 'image/png', 'x/shot.png'))).toBe(false);
    expect(isVideoFileRow({ type: 'screenshot', path: 'x/shot.png' })).toBe(false);
    expect(isVideoFileRow({ type: 'trace', path: 'x/trace.zip' })).toBe(false);
  });
});

describe('classifyEvidenceFile', () => {
  test('sorts each evidence kind into its own bucket', () => {
    expect(classifyEvidenceFile({ type: 'trace', path: 'x/trace.zip' })).toBe('trace');
    expect(classifyEvidenceFile(attachment('screenshot', 'image/png', 'x/shot.png'))).toBe('screenshot');
    expect(classifyEvidenceFile(attachment('video', 'video/webm', 'x/v.webm'))).toBe('video');
    expect(classifyEvidenceFile(attachment('error-context', 'text/markdown', 'x/ctx.md'))).toBe('attachment');
  });

  test('the trace type wins over anything the name or path suggests', () => {
    expect(classifyEvidenceFile({ type: 'trace', subtype: 'screenshot', path: 'x/shot.png' })).toBe('trace');
  });

  test('anything unrecognized is a plain attachment', () => {
    expect(classifyEvidenceFile(attachment('stdout', 'text/plain', 'x/stdout.txt'))).toBe('attachment');
    expect(classifyEvidenceFile(attachment('piwi-network', 'application/json', 'x/net.json'))).toBe('attachment');
    expect(classifyEvidenceFile({ type: 'report', subtype: 'html', path: 'x/index.html' })).toBe('attachment');
  });
});

describe('supportedImageMediaType', () => {
  test('uses the recorded content type', () => {
    expect(supportedImageMediaType({ label: 'image/png', path: 'x/shot.png' })).toBe('image/png');
    expect(supportedImageMediaType({ label: 'image/webp', path: 'x/opaque-blob' })).toBe('image/webp');
    expect(supportedImageMediaType({ label: 'IMAGE/GIF', path: 'x/a.gif' })).toBe('image/gif');
    // The non-standard alias browsers and tools still emit.
    expect(supportedImageMediaType({ label: 'image/jpg', path: 'x/a.jpg' })).toBe('image/jpeg');
    // Parameters are not part of the type.
    expect(supportedImageMediaType({ label: 'image/png; charset=binary', path: 'x/a.png' })).toBe('image/png');
  });

  test('rejects an image format no provider accepts, extension notwithstanding', () => {
    expect(supportedImageMediaType({ label: 'image/svg+xml', path: 'x/diagram.svg' })).toBeNull();
    expect(supportedImageMediaType({ label: 'image/bmp', path: 'x/a.bmp' })).toBeNull();
    // A mislabeled extension must not resurrect an unsupported content type.
    expect(supportedImageMediaType({ label: 'image/svg+xml', path: 'x/diagram.png' })).toBeNull();
  });

  test('falls back to the file extension when no content type was recorded', () => {
    expect(supportedImageMediaType({ label: null, path: 'x/shot.PNG' })).toBe('image/png');
    expect(supportedImageMediaType({ path: 'x/shot.jpeg' })).toBe('image/jpeg');
    expect(supportedImageMediaType({ label: '', path: 'x/shot.jpg' })).toBe('image/jpeg');
    expect(supportedImageMediaType({ label: null, path: 'x/shot.svg' })).toBeNull();
    expect(supportedImageMediaType({ label: null, path: 'x/no-extension' })).toBeNull();
  });
});

describe('contentTypeForPath', () => {
  test('maps known extensions, case-insensitively', () => {
    expect(contentTypeForPath('x/shot.png')).toBe('image/png');
    expect(contentTypeForPath('x/shot.JPG')).toBe('image/jpeg');
    expect(contentTypeForPath('x/v.webm')).toBe('video/webm');
    expect(contentTypeForPath('x/trace.zip')).toBe('application/zip');
    expect(contentTypeForPath('x/report.html')).toBe('text/html');
  });

  test('uses the fallback only for an unknown extension', () => {
    expect(contentTypeForPath('x/blob.bin', 'application/x-custom')).toBe('application/x-custom');
    // A known extension outranks a fallback that disagrees with it.
    expect(contentTypeForPath('x/shot.png', 'application/octet-stream')).toBe('image/png');
  });

  test('defaults to octet-stream with no extension and no fallback', () => {
    expect(contentTypeForPath('x/blob.bin')).toBe('application/octet-stream');
    expect(contentTypeForPath('x/no-extension')).toBe('application/octet-stream');
    expect(contentTypeForPath('x/blob.bin', null)).toBe('application/octet-stream');
    expect(contentTypeForPath('')).toBe('application/octet-stream');
  });
});

describe('failurePageScreenshot / failurePageFirst', () => {
  const name = (row: { subtype: string }) => row.subtype;
  // Playwright's own: one per page open at the failure, one per page of a context closed earlier.
  const listPage = attachment('screenshot', 'image/png', 'run/1/test-failed-1.png');
  const detailPage = attachment('screenshot', 'image/png', 'run/1/test-failed-2.png');
  const popup = attachment('screenshot', 'image/png', 'run/1/test-failed-3.png');
  const failingPage = attachment(FAILURE_SCREENSHOT_ATTACHMENT, 'image/png', 'run/1/piwi-failure-screenshot.png');

  test('the capture fixtures’ screenshot is the failing page, wherever it sits', () => {
    expect(failurePageScreenshot([listPage, detailPage, failingPage, popup], name)).toBe(failingPage);
    expect(failurePageFirst([listPage, detailPage, failingPage, popup], name)).toEqual([
      failingPage,
      listPage,
      detailPage,
      popup,
    ]);
  });

  test('a lone screenshot is the failing page', () => {
    expect(failurePageScreenshot([popup], name)).toBe(popup);
  });

  test('among several of Playwright’s own, none is the failing page and the order is kept', () => {
    expect(failurePageScreenshot([listPage, detailPage, popup], name)).toBeNull();
    expect(failurePageFirst([listPage, detailPage, popup], name)).toEqual([listPage, detailPage, popup]);
  });

  test('no screenshot, no failing page', () => {
    expect(failurePageScreenshot([], name)).toBeNull();
    expect(failurePageFirst([], name)).toEqual([]);
  });
});
