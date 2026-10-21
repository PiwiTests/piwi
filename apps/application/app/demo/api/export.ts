/**
 * Client-side offline export for demo mode.
 *
 * Collection, rendering and ZIP writing are the shared implementation the
 * server uses — the demo only supplies its own asset reader, because its
 * evidence is committed static files under `public/demo/` rather than rows in
 * a storage backend.
 */
import { buildExport } from '#shared/export/build';
import { collectClusterBundle, collectExecutionBundle } from '#shared/export/collect';
import {
  DEFAULT_EXPORT_MAX_BYTES,
  DEFAULT_EXPORT_MAX_CASES,
  DEFAULT_EXPORT_MAX_INLINE_BYTES,
} from '#shared/export/limits';
import { EXPORT_FORMATS, type ExportAssetReader, type ExportFormat } from '#shared/export/types';
import { BUG_REPORT_MEDIA_TYPE } from '@piwitests/core/bug-report';
import {
  executionBugReportArchive,
  executionReplaySummary,
  getExecutionBugReport,
  type ExecutionReplaySummary,
} from '#shared/handlers/execution-bug-report';
import { getDemoDb, getDemoDbBaseUrl, getDemoImportedFile } from '../db.client';
import { demoHttpError } from './http-error';

/**
 * Demo evidence is served from the built static assets (and, for runs this
 * visitor imported themselves, from IndexedDB).
 */
const demoAssetReader: ExportAssetReader = {
  async read(asset) {
    const imported = await getDemoImportedFile(asset.storagePath);
    if (imported) return imported;

    try {
      const base = getDemoDbBaseUrl().replace(/\/$/, '');
      const response = await fetch(`${base}/${asset.storagePath}`);
      if (!response.ok) return null;
      return new Uint8Array(await response.arrayBuffer());
    } catch {
      return null;
    }
  },
};

function parseFormat(query?: URLSearchParams): ExportFormat {
  const raw = (query?.get('format') || 'html').toLowerCase();
  return (EXPORT_FORMATS as readonly string[]).includes(raw) ? (raw as ExportFormat) : 'html';
}

async function respond(
  bundle: Awaited<ReturnType<typeof collectExecutionBundle>>,
  format: ExportFormat,
  id: number,
): Promise<Response> {
  if (!bundle) {
    return new Response(JSON.stringify({ statusCode: 404, message: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const built = await buildExport(bundle, format, id, {
    reader: demoAssetReader,
    budget: { maxInlineBytes: DEFAULT_EXPORT_MAX_INLINE_BYTES, maxTotalBytes: DEFAULT_EXPORT_MAX_BYTES },
  });

  return new Response(built.bytes as BufferSource, {
    status: 200,
    headers: {
      'Content-Type': built.contentType,
      'Content-Disposition': `attachment; filename="${built.fileName}"`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    },
  });
}

export async function apiExportTestRunCase(id: number, query?: URLSearchParams): Promise<Response> {
  const db = await getDemoDb();
  const bundle = await collectExecutionBundle(db, id, { maxCases: 1, piwiVersion: 'demo' });
  return respond(bundle, parseFormat(query), id);
}

export async function apiExportFailureCluster(id: number, query?: URLSearchParams): Promise<Response> {
  const db = await getDemoDb();
  const requested = query?.get('cases');
  const maxCases =
    requested === 'all' || !requested
      ? DEFAULT_EXPORT_MAX_CASES
      : Math.min(DEFAULT_EXPORT_MAX_CASES, Math.max(1, Number(requested) || DEFAULT_EXPORT_MAX_CASES));

  const bundle = await collectClusterBundle(db, id, { maxCases, piwiVersion: 'demo' });
  return respond(bundle, parseFormat(query), id);
}

/** An execution as a Piwi Picker bug report, the archive the server's route writes. */
export async function apiExecutionBugReport(id: number): Promise<Response> {
  const built = await getExecutionBugReport(await getDemoDb(), id);
  if (!built) throw demoHttpError(404, 'Test run case not found');
  const bytes = await executionBugReportArchive(built, demoAssetReader);
  return new Response(bytes as BufferSource, {
    status: 200,
    headers: {
      'Content-Type': BUG_REPORT_MEDIA_TYPE,
      'Content-Disposition': `attachment; filename="${built.fileName}"`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    },
  });
}

/** An execution's steps as Piwi Picker replays them, with what it leaves out. */
export async function apiExecutionReplaySteps(id: number): Promise<ExecutionReplaySummary> {
  const built = await getExecutionBugReport(await getDemoDb(), id);
  if (!built) throw demoHttpError(404, 'Test run case not found');
  return executionReplaySummary(built);
}
