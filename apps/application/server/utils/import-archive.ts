/**
 * The server's whole "import one archive" path, shared by the multipart upload
 * endpoint and the desktop app's local-path import: project resolution (with
 * scope checks and auto-create), idempotency by content hash, blob-report vs
 * trace dispatch, and the storage-backed `ImportPort`.
 */
import { createHash } from 'node:crypto';
import { apiError } from './api-error';
import { getDatabase } from '../database';
import { getStorage } from '../storage';
import { getProjectScope } from './project-access';
import { resolveIngestProject } from './ingest-project';
import { resolveMaxImportBytes } from './upload-limits';
import { sanitizeFilename } from './sanitize-filename';
import { persistRunCases } from './persist-run-cases';
import { upsertTraceBlob } from './trace-blobs';
import { deleteRunStorageDir, gcTraceBlobs } from './delete-run-files';
import { parseBlobReport, BlobReportError } from './blob-report';
import { parseTraceArchive, looksLikeTrace, TraceImportError } from './trace-import';
import { openArchive, ArchiveError } from './archive-reader';
import { parseErrorContext, consoleLogsFromTrace } from './import-evidence';
import { parseTraceEvents } from './trace-parser';
import { runEventBus } from './run-events';
import {
  findImportedRun,
  importBlobReportRun,
  importTraceRun,
  toBytes,
  type ImportPort,
  type StoredImportFile,
} from '#shared/handlers/import-runs';
import type { ImportRunResponse } from '#shared/import.types';
import { formatBytes } from '#shared/utils/format-bytes';

export interface ImportArchiveInput {
  /** The authenticated caller, as returned by `requireAuth`. */
  user: unknown;
  projectName: string;
  archive: { filename: string; data: Buffer };
  environment?: string | null;
  label?: string | null;
  /** Hex SHA-256 grouping key gathering several traces into one run. */
  importGroup?: string | null;
}

export async function importArchive(input: ImportArchiveInput): Promise<ImportRunResponse> {
  const { user, projectName, archive } = input;
  const environment = input.environment ?? null;
  const label = input.label ?? null;
  const importGroup = input.importGroup ?? null;

  const maxUploadBytes = resolveMaxImportBytes();
  if (archive.data.length === 0) {
    throw apiError({ statusCode: 400, message: 'The uploaded archive is empty' });
  }
  if (archive.data.length > maxUploadBytes) {
    throw apiError({ statusCode: 413, message: `Archive too large (max ${formatBytes(maxUploadBytes)})` });
  }

  // Hashed server-side rather than trusted from the client: this is the
  // idempotency key, so a wrong value would let the same archive import twice.
  const importHash = createHash('sha256').update(archive.data).digest('hex');

  const db = await getDatabase();
  const scope = await getProjectScope(db, user as any);

  const project = await resolveIngestProject(db, scope, projectName);

  const duplicate = await findImportedRun(db, project.id, importHash);
  if (duplicate) return duplicate;

  // Both kinds of archive are ZIPs; only their contents tell them apart.
  let opened;
  try {
    opened = openArchive(archive.data);
  } catch (error) {
    if (error instanceof ArchiveError) throw apiError({ statusCode: 400, message: error.message });
    throw error;
  }
  const { entryNames, readEntry } = opened;

  const port = createServerImportPort();
  await getStorage().mkdir(`project-${project.id}`);

  try {
    if (!entryNames.includes('report.jsonl')) {
      if (!looksLikeTrace(entryNames)) {
        throw apiError({
          statusCode: 400,
          message:
            'Unrecognised archive: expected a Playwright blob report (blob-report/report-*.zip) or a trace file (trace.zip).',
        });
      }

      const parsed = await parseTraceArchive(entryNames, readEntry);
      const result = await importTraceRun(db, port, {
        projectId: project.id,
        parsed,
        bytes: archive.data,
        importHash,
        importGroup,
        source: importGroup ? 'trace files' : archive.filename,
        environment,
        label,
      });
      console.log(`[Import] Trace "${parsed.case.title}" imported into run #${result.runId}`);
      return result;
    }

    const parsed = await parseBlobReport(readEntry);
    if (parsed.cases.length === 0) {
      throw apiError({ statusCode: 400, message: 'The archive contains no test results' });
    }

    const result = await importBlobReportRun(db, port, {
      projectId: project.id,
      parsed,
      readEntry,
      importHash,
      source: archive.filename,
      environment,
      label,
    });
    console.log(
      `[Import] Run #${result.runId} imported from ${archive.filename}: ` +
        `${result.totalTests} executions, ${result.traceCount} traces, ${result.attachmentCount} attachments`,
    );
    return result;
  } catch (error) {
    // The parsers speak in their own error types; the HTTP status is this
    // layer's business.
    if (error instanceof BlobReportError || error instanceof TraceImportError) {
      throw apiError({ statusCode: 400, message: error.message });
    }
    throw error;
  }
}

/**
 * The server's half of an import: executions go through the shared write path,
 * traces into the content-addressed blob store, and other attachments under the
 * run's directory in whichever storage backend is configured.
 */
function createServerImportPort(): ImportPort {
  const storage = getStorage();

  return {
    persistRunCases: (db, projectId, testRunId, cases, options) =>
      persistRunCases(db as never, projectId, testRunId, cases as never, options),

    async storeFile({
      projectId,
      testRunId,
      testRunsCaseId,
      kind,
      entryName,
      bytes,
      digest,
    }): Promise<StoredImportFile> {
      // Always a buffer here: only the browser half ever passes a `Blob`.
      const raw = await toBytes(bytes);
      const data = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);

      try {
        if (kind === 'trace') {
          // Content-addressed, so a trace shared by several runs is stored once
          // and lands on the same path every time it is imported — which is
          // what lets a repeated upload be recognised.
          const hash = digest ?? createHash('sha256').update(data).digest('hex');
          const blob = await upsertTraceBlob(projectId, hash, data);
          return { path: blob.path.replace(/\\/g, '/'), size: blob.size, blobId: blob.id };
        }

        const dir = `project-${projectId}/run-${testRunId}/${testRunsCaseId}`;
        await storage.mkdir(dir);
        const path = `${dir}/${sanitizeFilename(entryName.split('/').pop() || 'attachment')}`;
        await storage.writeFile(path, data);
        return { path: path.replace(/\\/g, '/'), size: data.length };
      } catch (error) {
        // The import fails whole: it leaves no run, so a retry once storage recovers imports it in full.
        console.error(`[Import] Failed to store ${kind} ${entryName}: ${error}`);
        throw apiError({
          statusCode: 503,
          message: `The archive's files could not be stored, so nothing was imported: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    },

    async discardFiles(db, { projectId, runId, blobIds }) {
      await deleteRunStorageDir(projectId, runId);
      await gcTraceBlobs(db as never, blobIds);
    },

    async readTraceConsole(bytes, startedAt) {
      try {
        const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        return consoleLogsFromTrace(await parseTraceEvents(data), startedAt);
      } catch {
        return null;
      }
    },

    parseErrorContext: (markdown, declLine) => parseErrorContext(markdown, { declLine }),

    publishRunSubmitted: (payload) => runEventBus.publishGlobal({ type: 'run-submitted', ...payload }),
    publishRollupUpdated: (payload) => runEventBus.publishGlobal({ type: 'rollup-updated', ...payload }),

    warn: (message) => console.warn(`[Import] ${message}`),
  };
}
