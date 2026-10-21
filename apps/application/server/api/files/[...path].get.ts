import { extname } from 'path';
import { requireAuth } from '../../utils/auth';
import {
  requireProjectAccess,
  requireResolvedProjectAccess,
  resolveBugReportProjectId,
} from '../../utils/project-access';
import { getStorage } from '../../storage';
import { resolveStoredTrace } from '../../utils/trace-reconstruct';
import { prepareHtmlReport } from '../../utils/html-report';
import { readReportArchiveIndex } from '../../utils/report-archive';
import { getDatabase } from '../../database';

defineRouteMeta({
  openAPI: {
    tags: ['Files'],
    summary: 'Download a stored file',
    description:
      'Serves stored files including test reports, trace archives, and attachments. Supports trace ZIP reconstruction from slim blobs and gzip decompression for report archives.',
    parameters: [
      { name: 'path', in: 'path', required: true, schema: { type: 'string' } },
      {
        name: 'contentType',
        in: 'query',
        required: false,
        schema: { type: 'string' },
        description: 'Override the response Content-Type for the served file.',
      },
      {
        name: 'compress',
        in: 'query',
        required: false,
        schema: { type: 'string', enum: ['1'] },
        description: 'Set to "1" to serve the stored archive gzip-compressed rather than decompressed.',
      },
    ],
    'x-required-permission': 'project:read',
  },
});

const COMPRESSIBLE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

// Content types a caller may name for an extension-less attachment, all inert.
// Anything else (HTML, SVG, any XML type) would let arbitrary stored bytes run as
// a scriptable document on the dashboard origin, so it falls back to octet-stream.
const OVERRIDABLE_CONTENT_TYPE =
  /^(?:image\/(?:png|jpeg|gif|webp|avif|bmp)|video\/[\w.-]+|audio\/[\w.-]+|text\/(?:plain|csv|markdown)|application\/(?:json|x-ndjson|pdf|zip|octet-stream))$/;

function isOverridableContentType(value: string): boolean {
  return OVERRIDABLE_CONTENT_TYPE.test(value.split(';')[0]!.trim().toLowerCase());
}

export default eventHandler(async (event) => {
  const path = getRouterParam(event, 'path');
  const query = getQuery(event);
  const overrideContentType = typeof query.contentType === 'string' ? query.contentType : null;
  const wantCompressed = query.compress === '1';

  if (!path) {
    throw apiError({
      statusCode: 400,
      message: 'File path is required',
    });
  }

  // Security: Prevent path traversal
  if (path.includes('..') || path.startsWith('/')) {
    throw apiError({
      statusCode: 403,
      message: 'Invalid file path',
    });
  }

  // Every stored file belongs to a project: its own folder, or a bug report's.
  // A path that names neither is refused rather than served to any signed-in user.
  const projectMatch = path.match(/^project-(\d+)\//);
  const bugReportMatch = path.match(/^bug-reports\/(\d+)\//);
  if (projectMatch) {
    await requireProjectAccess(event, Number(projectMatch[1]));
  } else if (bugReportMatch) {
    await requireResolvedProjectAccess(event, Number(bugReportMatch[1]), resolveBugReportProjectId, 'Bug report');
  } else {
    await requireAuth(event);
    throw apiError({ statusCode: 404, message: 'File not found' });
  }

  const storage = getStorage();
  const projectId = projectMatch ? Number(projectMatch[1]) : null;

  /** The `index.html` inside the report archive stored at `archivePath`, or null. */
  async function reportIndex(archivePath: string): Promise<Buffer | null> {
    if (projectId === null) return null;
    return readReportArchiveIndex(await getDatabase(), projectId, archivePath, () => storage.readFile(archivePath));
  }

  // Security headers applied to all file responses
  setResponseHeader(event, 'X-Content-Type-Options', 'nosniff');

  // Trace blobs live under /blobs/ and are content-addressed by hash, so their
  // bytes never change — cache them aggressively and answer conditional requests
  // with 304 instead of re-downloading and re-reconstructing the full ZIP on
  // every trace-viewer open. Every other path (reports, attachments) is
  // path-stable but content-mutable, so it keeps no-store.
  const isBlobPath = path.includes('/blobs/');
  if (isBlobPath) {
    const etag = `"${path.split('/blobs/')[1]}"`;
    setResponseHeader(event, 'ETag', etag);
    setResponseHeader(event, 'Cache-Control', 'private, max-age=31536000, immutable');
    if (getRequestHeader(event, 'if-none-match') === etag) {
      setResponseStatus(event, 304);
      return null;
    }
  } else {
    setResponseHeader(event, 'Cache-Control', 'no-store');
  }

  // Trace archives are fetched by the Playwright trace viewer from the user's
  // browser. The bundled local viewer (/trace-viewer/) is same-origin, so it
  // works with auth on; the hosted trace.playwright.dev viewer is cross-origin
  // and cannot send the session cookie, so it only works when auth is disabled.
  // Only that viewer may read them cross-origin.
  if (path.endsWith('.zip')) {
    setResponseHeader(event, 'Access-Control-Allow-Origin', 'https://trace.playwright.dev');
    setResponseHeader(event, 'Vary', 'Origin');
  }

  // Content types that should be displayed inline rather than downloaded
  const inlineDispositionTypes = new Set([
    'text/html',
    'text/css',
    'text/markdown',
    'text/plain',
    'application/json',
    'application/javascript',
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/svg+xml',
    'image/webp',
    'video/webm',
    'video/mp4',
    'video/ogg',
    'video/quicktime',
    'video/x-msvideo',
    'font/woff2',
    'font/ttf',
  ]);

  // Helper to serve a file with the right content type
  function setContentType(ext: string): string {
    if (ext === '.html' || ext === '.htm') return 'text/html';
    if (ext === '.gz') return 'application/gzip';
    if (ext === '.zip') return 'application/zip';
    if (ext === '.json') return 'application/json';
    if (ext === '.js') return 'application/javascript';
    if (ext === '.css') return 'text/css';
    if (ext === '.md' || ext === '.mdx') return 'text/markdown';
    if (ext === '.txt') return 'text/plain';
    if (ext === '.png') return 'image/png';
    if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
    if (ext === '.gif') return 'image/gif';
    if (ext === '.webp') return 'image/webp';
    if (ext === '.webm') return 'video/webm';
    if (ext === '.mp4') return 'video/mp4';
    if (ext === '.ogg' || ext === '.ogv') return 'video/ogg';
    if (ext === '.mov') return 'video/quicktime';
    if (ext === '.avi') return 'video/x-msvideo';
    if (ext === '.svg') return 'image/svg+xml';
    if (ext === '.woff' || ext === '.woff2') return 'font/woff2';
    if (ext === '.ttf') return 'font/ttf';
    if (ext === '.wasm') return 'application/wasm';
    return 'application/octet-stream';
  }

  function applyInlineDisposition(contentType: string): void {
    if (inlineDispositionTypes.has(contentType)) {
      setResponseHeader(event, 'Content-Disposition', 'inline');
    }
  }

  function resolveContentType(ext: string): string {
    // If the caller supplied a content-type for an extension-less attachment,
    // honor it only for inert types; otherwise the file stays octet-stream, which
    // `nosniff` keeps inert.
    const guessed = setContentType(ext);
    if (
      guessed === 'application/octet-stream' &&
      overrideContentType &&
      isOverridableContentType(overrideContentType)
    ) {
      return overrideContentType;
    }
    return guessed;
  }

  /**
   * Apply a Content-Security-Policy sandbox to untrusted HTML responses.
   *
   * Playwright/Monocart reports rely on JavaScript to render, so scripts stay
   * enabled — but `allow-same-origin` is deliberately omitted, giving the
   * document a unique opaque origin. Its scripts can no longer read the
   * dashboard's cookies or localStorage, or make credentialed same-origin calls
   * to `/api`, so a malicious uploaded report cannot act as the viewer. Bundled
   * relative resources still load (they are fetched from the dashboard by URL).
   */
  function applyHtmlCsp(): void {
    setResponseHeader(event, 'Content-Security-Policy', 'sandbox allow-scripts');
  }

  function prepareHtmlResponse(content: Buffer): Buffer {
    const prepared = prepareHtmlReport(content);
    applyHtmlCsp();
    applyInlineDisposition('text/html');
    setResponseHeader(event, 'Content-Length', prepared.length);
    return prepared;
  }

  /**
   * SVGs can embed scripts that execute when the file is opened top-level. A
   * no-scripts sandbox renders it as an inert image and blocks any network
   * callout, while `<img>` embedding elsewhere in the app is unaffected.
   */
  function applySvgCsp(): void {
    setResponseHeader(event, 'Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  }

  // 1. Try exact path
  if (await storage.exists(path)) {
    const ext = extname(path).toLowerCase();

    // An uploaded report archive (.gz): serve the index.html inside it
    if (ext === '.gz') {
      const htmlContent = await reportIndex(path);
      if (htmlContent) {
        setResponseHeader(event, 'Content-Type', 'text/html');
        return prepareHtmlResponse(htmlContent);
      }
    }

    const fileContent = await storage.readFile(path);

    // Slim trace blob: reconstruct full ZIP from shared resource pool
    if (ext === '.zip' && path.includes('/blobs/')) {
      let fullZip: Buffer;
      try {
        fullZip = await resolveStoredTrace(storage, path, fileContent);
      } catch (error) {
        // A passing storage error: never let the immutable cache keep a partial trace.
        console.warn(`[Files] Could not rebuild trace ${path}:`, error);
        removeResponseHeader(event, 'ETag');
        setResponseHeader(event, 'Cache-Control', 'no-store');
        throw apiError({ statusCode: 503, message: 'The trace could not be read from storage. Try again.' });
      }
      if (fullZip !== fileContent) {
        setResponseHeader(event, 'Content-Type', 'application/zip');
        setResponseHeader(event, 'Content-Length', fullZip.length);
        return fullZip;
      }
      // Not a slim blob, or it could not be parsed — fall through to serve it as stored
    }

    const contentType = resolveContentType(ext);

    // Compress image on demand: resize to max 1280px, output as WebP
    if (wantCompressed && COMPRESSIBLE_IMAGE_TYPES.has(contentType)) {
      try {
        const { default: sharp } = await import('sharp');
        const compressed = await sharp(fileContent)
          .resize(1280, 1280, { fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 90 })
          .toBuffer();
        setResponseHeader(event, 'Content-Type', 'image/webp');
        setResponseHeader(event, 'Content-Length', compressed.length);
        applyInlineDisposition('image/webp');
        return compressed;
      } catch {
        // Fall through to serve original if sharp fails
      }
    }

    setResponseHeader(event, 'Content-Type', contentType);
    setResponseHeader(event, 'Content-Length', fileContent.length);
    applyInlineDisposition(contentType);
    if (contentType === 'text/html') {
      return prepareHtmlResponse(fileContent);
    } else if (contentType === 'image/svg+xml') {
      applySvgCsp();
    }
    return fileContent;
  }

  // 2. Try path + /index.html (directory without explicit index.html)
  const indexPath = `${path.replace(/\/+$/, '')}/index.html`;
  if (await storage.exists(indexPath)) {
    const fileContent = await storage.readFile(indexPath);
    setResponseHeader(event, 'Content-Type', 'text/html');
    return prepareHtmlResponse(fileContent);
  }

  // 3. Try path + .gz (an uploaded report archive - serve the index.html inside it)
  const gzPath = `${path}.gz`;
  if (await storage.exists(gzPath)) {
    const htmlContent = await reportIndex(gzPath);
    if (htmlContent) {
      setResponseHeader(event, 'Content-Type', 'text/html');
      return prepareHtmlResponse(htmlContent);
    }
  }

  throw apiError({
    statusCode: 404,
    message: 'File not found',
  });
});
