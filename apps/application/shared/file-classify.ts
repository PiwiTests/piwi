/**
 * Classification of `files` rows into the evidence kinds the UI and exports
 * care about.
 *
 * Real ingestion stores Playwright attachments as `type='attachment'` with
 * `subtype=<attachment name>` and `label=<content type>`, so a bare
 * `files.type = 'screenshot'` filter matches nothing the upload endpoints
 * write. These predicates accept both shapes.
 */
import { FAILURE_SCREENSHOT_ATTACHMENT } from '@piwitests/core/wire';

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
const VIDEO_EXTS = new Set(['webm', 'mp4', 'ogg']);

export interface ClassifiableFileRow {
  type: string;
  subtype?: string | null;
  label?: string | null;
  path: string;
}

/** The evidence kinds an export groups files by. */
export type EvidenceKind = 'screenshot' | 'video' | 'trace' | 'attachment';

function extensionOf(path: string): string {
  return path.toLowerCase().split('.').pop() || '';
}

/**
 * Whether an attachment row belongs to a media family (`image/`, `video/`).
 *
 * The recorded content type decides on its own when the row has one; the
 * attachment name and the file extension are guesses that only apply to rows
 * without it. So an attachment named `screenshot-metadata` carrying
 * `application/json` is a JSON file, and `notes.ogg` carrying `audio/ogg` is
 * not a video.
 */
function isAttachmentOfFamily(
  row: ClassifiableFileRow,
  family: 'image' | 'video',
  namePrefix: string,
  exts: ReadonlySet<string>,
): boolean {
  const contentType = row.label?.toLowerCase();
  if (contentType) return contentType.startsWith(`${family}/`);
  if (row.subtype?.toLowerCase().startsWith(namePrefix)) return true;
  return exts.has(extensionOf(row.path));
}

/** True when a files row refers to a screenshot image (either storage shape). */
export function isScreenshotFileRow(row: ClassifiableFileRow): boolean {
  if (row.type === 'screenshot') return true;
  if (row.type !== 'attachment') return false;
  return isAttachmentOfFamily(row, 'image', 'screenshot', IMAGE_EXTS);
}

/**
 * The screenshot of the page a failed test was on, among one execution's
 * screenshots: the one the capture fixtures took of the page the test last
 * acted on, else the only one. Playwright takes a screenshot of every page
 * still open when a test fails and of every page of each context the test
 * closed before, so among several of its own none is known to be that page.
 */
export function failurePageScreenshot<T>(shots: readonly T[], name: (shot: T) => string | null | undefined): T | null {
  return shots.find((shot) => name(shot) === FAILURE_SCREENSHOT_ATTACHMENT) ?? (shots.length === 1 ? shots[0]! : null);
}

/** One execution's screenshots in their order, with the page the test failed on first when it is known. */
export function failurePageFirst<T>(shots: readonly T[], name: (shot: T) => string | null | undefined): T[] {
  const atFailure = failurePageScreenshot(shots, name);
  return atFailure ? [atFailure, ...shots.filter((shot) => shot !== atFailure)] : [...shots];
}

/** True when a files row refers to a recorded video. */
export function isVideoFileRow(row: ClassifiableFileRow): boolean {
  if (row.type === 'video') return true;
  if (row.type !== 'attachment') return false;
  return isAttachmentOfFamily(row, 'video', 'video', VIDEO_EXTS);
}

/** The evidence kind a files row belongs to. */
export function classifyEvidenceFile(row: ClassifiableFileRow): EvidenceKind {
  if (row.type === 'trace') return 'trace';
  if (isScreenshotFileRow(row)) return 'screenshot';
  if (isVideoFileRow(row)) return 'video';
  return 'attachment';
}

/** The image media types the provider vision APIs accept. */
export const SUPPORTED_IMAGE_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;
export type SupportedImageMediaType = (typeof SUPPORTED_IMAGE_MEDIA_TYPES)[number];

const EXT_IMAGE_MEDIA_TYPES: Record<string, SupportedImageMediaType> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

/**
 * The media type a stored screenshot may be sent to a model as. The recorded
 * content type decides when the row has one — including deciding against it, so
 * a format no provider accepts (SVG, BMP, TIFF, …) yields null and the file is
 * left out of the context rather than sent under a media type it does not
 * match. Rows without a content type fall back to their file extension.
 */
export function supportedImageMediaType(row: { label?: string | null; path: string }): SupportedImageMediaType | null {
  const contentType = row.label?.toLowerCase().split(';')[0]?.trim();
  if (contentType) {
    if (contentType === 'image/jpg') return 'image/jpeg';
    return (SUPPORTED_IMAGE_MEDIA_TYPES as readonly string[]).includes(contentType)
      ? (contentType as SupportedImageMediaType)
      : null;
  }
  return EXT_IMAGE_MEDIA_TYPES[extensionOf(row.path)] ?? null;
}

/** Best-effort content type for a stored evidence file. */
export function contentTypeForPath(path: string, fallback?: string | null): string {
  const byExt: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    webm: 'video/webm',
    mp4: 'video/mp4',
    ogg: 'video/ogg',
    zip: 'application/zip',
    json: 'application/json',
    txt: 'text/plain',
    html: 'text/html',
  };
  return byExt[extensionOf(path)] ?? fallback ?? 'application/octet-stream';
}
