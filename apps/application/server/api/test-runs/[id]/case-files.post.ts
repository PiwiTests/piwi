import { readFile } from 'node:fs/promises';
import { getDatabase, type DbClient } from '../../../database';
import { testRuns, testCases, testRunsCases, files } from '../../../database/schema';
import { eq, and, desc } from 'drizzle-orm';
import { runEventBus } from '../../../utils/run-events';
import { parseLocation } from '#shared/parse-location';
import { validateAndReviveRun } from '../../../utils/revive-run';
import { matchesShardToken, readShardTokensFromMeta } from '../../../utils/shard-tokens';
import { upsertTraceBlob, upsertTraceFile, findTraceBlob } from '../../../utils/trace-blobs';
import { deriveTraceEvidence } from '../../../utils/trace-fallback-evidence';
import { recordIngestHealth } from '../../../utils/ingest-health';
import { attachmentStoragePaths } from '../../../utils/attachment-paths';
import { getStorage } from '../../../storage';
import { joinSuitePath } from '#shared/utils/suites';
import { sanitizeFilename } from '../../../utils/sanitize-filename';
import { streamMultipart } from '../../../utils/multipart-stream';
import { resolveMaxUploadBytes } from '../../../utils/upload-limits';
import { formatBytes } from '#shared/utils/format-bytes';

defineRouteMeta({
  openAPI: {
    tags: ['Test Runs'],
    summary: 'Upload trace and attachment files for a test case',
    description:
      'Upload trace files and attachments for a specific test case during an active streaming run. Authenticated by the run stream token. Supports trace deduplication via SHA-256 hashing and is idempotent on retry.',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
  },
});

/**
 * Live per-case file upload for streaming runs.
 *
 * The reporter calls this as soon as a test finishes (after flushing the
 * matching `complete` event) so traces and attachments are viewable on the
 * test case page while the run is still going. Authenticated by the run's
 * stream token, like the events endpoint.
 *
 * Multipart fields:
 *  - streamToken   — run stream token, sent before any file part
 *  - testCase      — JSON { title, location, retries, suitePath } identifying the run case
 *  - trace         — optional trace ZIP file
 *  - trace_hash    — optional SHA-256 of the trace, checked against it; without a file,
 *                    names a trace the project already stores. The server hashes a
 *                    trace sent without one.
 *  - attach_meta   — optional JSON array of { name, contentType, originalName }
 *  - attach_file   — attachment files, in the same order as attach_meta
 */
export default eventHandler(async (event) => {
  const id = parseInt(getRouterParam(event, 'id') || '0');

  if (!id) {
    throw apiError({
      statusCode: 400,
      message: 'Invalid test run ID',
    });
  }

  const maxUploadBytes = resolveMaxUploadBytes();
  const contentLength = parseInt(getRequestHeader(event, 'content-length') ?? '0', 10);
  if (contentLength > maxUploadBytes) {
    throw apiError({ statusCode: 413, message: `Upload too large (max ${formatBytes(maxUploadBytes)})` });
  }

  const db = await getDatabase();

  // Stream the request to temp files so a large trace never sits in the heap for
  // the whole transfer; the file parts are read back one at a time below and the
  // temp directory is removed in the `finally`. The run and the stream token,
  // which clients send ahead of the files, are checked before any file part
  // reaches the disk.
  let testRun: CaseFilesRun | undefined;
  const multipart = await streamMultipart(event, {
    maxTotalBytes: maxUploadBytes,
    maxFields: 16,
    beforeFiles: async (fields) => {
      testRun = await authorizeCaseFilesRun(db, id, fields.get('streamToken'));
    },
  });
  try {
    return await handleCaseFiles(db, id, testRun!, multipart);
  } finally {
    await multipart.cleanup();
  }
});

type CaseFilesRun = typeof testRuns.$inferSelect;

/**
 * The run a case-files upload targets, once its stream token is checked: the
 * run's own token or, in a sharded run where every shard uploads its own case
 * files, one of its shard tokens.
 */
async function authorizeCaseFilesRun(db: DbClient, id: number, streamToken: string | undefined): Promise<CaseFilesRun> {
  if (!streamToken) {
    throw apiError({
      statusCode: 401,
      message: 'Missing stream token',
    });
  }

  const [testRun] = await db.select().from(testRuns).where(eq(testRuns.id, id));
  if (!testRun) {
    throw apiError({
      statusCode: 404,
      message: 'Test run not found',
    });
  }

  const isSharded = !!(testRun.shardTotal && testRun.shardTotal > 1);
  const shardTokens = isSharded ? readShardTokensFromMeta(testRun.metadata) : undefined;
  const isShardToken = shardTokens ? (token: string) => matchesShardToken(shardTokens, token) : undefined;
  await validateAndReviveRun(db, id, testRun, streamToken, isShardToken);
  return testRun;
}

async function handleCaseFiles(
  db: DbClient,
  id: number,
  testRun: CaseFilesRun,
  multipart: Awaited<ReturnType<typeof streamMultipart>>,
): Promise<{ success: boolean; executionId: number; traces: number; attachments: number }> {
  const { fields } = multipart;

  let caseInfo: { title?: string; location?: string; retries?: number; suitePath?: string[] | null } | undefined;
  const rawCase = fields.get('testCase');
  if (rawCase !== undefined) {
    try {
      caseInfo = JSON.parse(rawCase);
    } catch {
      throw apiError({ statusCode: 400, message: 'Invalid JSON in testCase field' });
    }
  }

  const rawHash = fields.get('trace_hash');
  const traceHash = rawHash && /^[0-9a-f]{64}$/i.test(rawHash) ? rawHash.toLowerCase() : undefined;

  let attachmentMeta: { name: string; contentType: string; originalName: string }[] = [];
  const rawAttachMeta = fields.get('attach_meta');
  if (rawAttachMeta !== undefined) {
    try {
      const parsed = JSON.parse(rawAttachMeta);
      if (Array.isArray(parsed)) {
        attachmentMeta = parsed.map((a: Record<string, unknown>) => ({
          name: String(a.name || 'attachment'),
          contentType: String(a.contentType || 'application/octet-stream'),
          originalName: String(a.originalName || 'attachment'),
        }));
      }
    } catch {
      // Metadata is optional; ignore parse errors
    }
  }

  // The trace part (at most one) and the attachment parts, streamed to temp files.
  const traceStreamed = multipart.files.find((f) => f.field === 'trace');
  const attachmentStreamed = multipart.files.filter((f) => f.field === 'attach_file');

  if (!caseInfo?.title || !caseInfo?.location) {
    throw apiError({
      statusCode: 400,
      message: 'Missing required testCase fields: title, location',
    });
  }

  // Locate the run case row the reporter streamed earlier
  const { filePath } = parseLocation(caseInfo.location);
  const retries = caseInfo.retries ?? 0;
  const suitePath = caseInfo.suitePath ? joinSuitePath(caseInfo.suitePath) : '';

  const sharedCases = await db
    .select({ id: testCases.id })
    .from(testCases)
    .where(
      and(
        eq(testCases.projectId, testRun.projectId),
        eq(testCases.filePath, filePath),
        eq(testCases.suitePath, suitePath),
        eq(testCases.title, caseInfo.title),
      ),
    );
  const sharedCase = sharedCases[0];

  const runCaseRows = sharedCase
    ? await db
        .select({ id: testRunsCases.id })
        .from(testRunsCases)
        .where(
          and(
            eq(testRunsCases.testRunId, id),
            eq(testRunsCases.testCaseId, sharedCase.id),
            eq(testRunsCases.retries, retries),
          ),
        )
        .orderBy(desc(testRunsCases.id))
        .limit(1)
    : [];
  const runCase = runCaseRows[0];

  if (!runCase) {
    // The complete event for this case has not been persisted yet — the
    // reporter flushes events before uploading files, so this only happens
    // on out-of-order delivery. The reporter retries on 404.
    throw apiError({
      statusCode: 404,
      message: 'Test case not found for this run',
    });
  }

  const storage = getStorage();
  const testRunPath = `project-${testRun.projectId}/run-${id}`;

  // Existing file paths for this case make retried uploads idempotent
  const existingFiles = await db
    .select({ path: files.path, type: files.type })
    .from(files)
    .where(eq(files.testRunsCaseId, runCase.id));
  const existingPaths = new Set(existingFiles.map((f) => f.path));
  const hasTrace = existingFiles.some((f) => f.type === 'trace');

  let storedTraces = 0;
  let storedAttachments = 0;

  // --- Trace ---
  if ((traceStreamed || traceHash) && !hasTrace) {
    try {
      let blob: { id: number; path: string; size: number } | null;
      if (traceStreamed) {
        // Read the streamed trace into memory only now, for the one call that
        // parses it; the buffer is released as soon as the blob is stored.
        const data = await readFile(traceStreamed.path);
        blob = traceHash
          ? await upsertTraceBlob(testRun.projectId, traceHash, data)
          : await upsertTraceFile(testRun.projectId, data);
      } else {
        // Reporter said this blob already exists on the server — look it up
        blob = await findTraceBlob(testRun.projectId, traceHash!);
        if (!blob) {
          throw apiError({
            statusCode: 422,
            message: 'Trace blob not found for the provided hash',
          });
        }
      }

      const normalizedPath = blob.path.replace(/\\/g, '/');
      if (!existingPaths.has(normalizedPath)) {
        await db.insert(files).values({
          testRunsCaseId: runCase.id,
          testRunId: id,
          type: 'trace',
          path: normalizedPath,
          size: blob.size,
          blobId: blob.id,
        });
        storedTraces++;
        console.log(`[CaseFiles] Stored trace for case #${runCase.id} (run #${id})`);
      }
    } catch (error) {
      // 422 (unknown hash) must reach the reporter so it can resend with the file
      if (error && typeof error === 'object' && 'statusCode' in error) throw error;
      console.error(`[CaseFiles] Failed to store trace for case #${runCase.id}: ${error}`);
      await recordIngestHealth(db, id, { tracesSkipped: 1 });
    }
  }

  // --- Attachments ---
  if (attachmentMeta.length > 0 && attachmentStreamed.length > 0) {
    const attachmentDir = `${testRunPath}/${runCase.id}`;
    await storage.mkdir(attachmentDir);

    const count = Math.min(attachmentMeta.length, attachmentStreamed.length);
    const storagePaths = attachmentStoragePaths(
      attachmentDir,
      attachmentStreamed.slice(0, count).map((f) => sanitizeFilename(f.filename)),
    );

    for (let fi = 0; fi < count; fi++) {
      const meta = attachmentMeta[fi]!;
      const fileEntry = attachmentStreamed[fi]!;
      const storagePath = storagePaths[fi]!;

      if (existingPaths.has(storagePath)) continue;

      try {
        await storage.writeFile(storagePath, await readFile(fileEntry.path));
        await db.insert(files).values({
          testRunsCaseId: runCase.id,
          testRunId: id,
          type: 'attachment',
          subtype: meta.name,
          label: meta.contentType,
          path: storagePath,
          size: fileEntry.size,
        });
        existingPaths.add(storagePath);
        storedAttachments++;
        console.log(`[CaseFiles] Stored attachment "${meta.name}" for case #${runCase.id} (run #${id})`);
      } catch (error) {
        console.error(`[CaseFiles] Failed to store attachment for case #${runCase.id}: ${error}`);
      }
    }
  }

  // With a trace now linked, recover any evidence the capture fixtures would
  // have provided (console, network, ARIA) so a fixture-less project still gets
  // most of the failure evidence. Idempotent and best-effort.
  if ((storedTraces > 0 || hasTrace) && (storedTraces > 0 || storedAttachments > 0)) {
    try {
      await deriveTraceEvidence(db, runCase.id);
    } catch (error) {
      console.error(`[CaseFiles] Failed to derive trace evidence for case #${runCase.id}: ${error}`);
    }
  }

  // Keep the run's activity timestamp fresh so the stale-run cleanup
  // doesn't interrupt runs that are only uploading files
  await db.update(testRuns).set({ updatedAt: new Date() }).where(eq(testRuns.id, id));

  if (storedTraces > 0 || storedAttachments > 0) {
    runEventBus.publish(id, {
      type: 'case-files',
      data: {
        executionId: runCase.id,
        title: caseInfo.title,
        location: caseInfo.location,
        traces: storedTraces,
        attachments: storedAttachments,
      },
    });
  }

  return {
    success: true,
    executionId: runCase.id,
    traces: storedTraces,
    attachments: storedAttachments,
  };
}
