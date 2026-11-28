import type { H3Event } from 'h3';
import { apiError } from './api-error';
import { buildExport } from '#shared/export/build';
import { EXPORT_FORMATS, type ExportBundle, type ExportFormat } from '#shared/export/types';
import { sanitizeFilename } from './sanitize-filename';
import { publicBaseUrl } from './public-base-url';
import { resolveExportBudget, serverAssetReader } from './export-assets';
import { dashboardVersion } from './app-version';

/** The requested format, defaulting to HTML. */
export function requireExportFormat(event: H3Event): ExportFormat {
  const raw = getQuery(event).format;
  if (raw == null || raw === '') return 'html';
  const value = String(raw).toLowerCase();
  if (!(EXPORT_FORMATS as readonly string[]).includes(value)) {
    throw apiError({
      statusCode: 400,
      message: `Unsupported export format '${value}'. Use one of: ${EXPORT_FORMATS.join(', ')}.`,
    });
  }
  return value as ExportFormat;
}

/** Absolute URL of the page this export came from, recorded in the report. */
export function exportSourceUrl(event: H3Event, path: string): string {
  return `${publicBaseUrl(event)}${path}`;
}

export function exportPiwiVersion(event: H3Event): string | null {
  return dashboardVersion(event) || null;
}

/** Build the file and write it to the response. */
export async function sendExport(event: H3Event, bundle: ExportBundle, format: ExportFormat, id: number) {
  const built = await buildExport(bundle, format, id, {
    reader: serverAssetReader,
    budget: resolveExportBudget(),
  });

  setResponseHeader(event, 'Content-Type', built.contentType);
  setResponseHeader(event, 'Content-Length', built.bytes.length);
  setResponseHeader(event, 'Content-Disposition', `attachment; filename="${sanitizeFilename(built.fileName)}"`);
  setResponseHeader(event, 'X-Content-Type-Options', 'nosniff');
  setResponseHeader(event, 'Cache-Control', 'no-store');

  return Buffer.from(built.bytes);
}
