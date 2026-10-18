import { getDatabase } from '../../database';
import { projects, testRuns, files } from '../../database/schema';
import type { Project } from '../../database/schema';
import { eq } from 'drizzle-orm';
import { upsertTraceBlob, findTraceBlob } from '../../utils/trace-blobs';
import { join } from 'path';
import { decompressDirectory } from '../../utils/compression';
import { requireAuth } from '../../utils/auth';
import { getStorage } from '../../storage';
import { uploadDirectory } from '../../utils/storage-helpers';
import { sanitizeFilename } from '../../utils/sanitize-filename';
import { tmpdir } from 'os';
import { rm, mkdir, readdir, readFile } from 'fs/promises';
import { parseLocation } from '#shared/parse-location';
import { persistRunCases, type RunCaseInput } from '../../utils/persist-run-cases';
import { deriveTraceEvidence } from '../../utils/trace-fallback-evidence';
import { recordIngestHealth } from '../../utils/ingest-health';
import { sanitizeMetadata } from '../../utils/sanitize';
import { resolveRunBranch } from '../../utils/run-branch';
import { runCommit, runOrigin } from '#shared/run-eligibility';
import { runEventBus } from '../../utils/run-events';
import { runFinalizeSideEffects } from '../../utils/run-finalize-side-effects';
import { deliverOnce, readDeliveryKey } from '../../utils/run-deliveries';
import {
  addBatchShard,
  batchShardRun,
  batchShardTally,
  finalizeShardedRun,
  publishShardProgress,
} from '../../utils/sharded-runs';
import { settleFinalizingRun } from '../../utils/finalizing-runs';
import { getProjectScope, scopeAllows } from '../../utils/project-access';
import { resolveIngestProject } from '../../utils/ingest-project';
import { resolveMaxUploadBytes } from '../../utils/upload-limits';
import { streamMultipart, type StreamedMultipart } from '../../utils/multipart-stream';
import { sumFailedAndTimedOut } from '#shared/utils/test-counts';
import { formatBytes } from '#shared/utils/format-bytes';
import { applyReporterKeep } from '#shared/handlers/run-keep';
import { sanitizeResourceReport } from '#shared/resource-report';
import { saveResourceReportPart } from '#shared/handlers/resource-reports';

defineRouteMeta({
  openAPI: {
    tags: ['Test Runs'],
    summary: 'Upload test results with reports, traces, and attachments',
    description:
      'Upload Playwright test run results as multipart form data, including HTML reports, trace files, and other attachments. Supports both new runs and attaching files to existing streaming runs.',
    'x-required-permission': 'run:submit',
    requestBody: {
      content: {
        'multipart/form-data': {
          schema: {
            type: 'object',
            properties: {
              projectName: { type: 'string' },
              testRun: {
                type: 'string',
                description:
                  'JSON-encoded test run data. Its `deliveryKey`, as on the submit endpoint, makes a repeated delivery answer with the run its first delivery stored.',
              },
              testCases: { type: 'string', description: 'JSON-encoded test cases array' },
            },
            required: ['projectName', 'testRun'],
          },
        },
      },
    },
  },
});

// Default labels for known report types
const REPORT_TYPE_LABELS: Record<string, string> = {
  html: 'HTML Report',
  monocart: 'Monocart Report',
  blob: 'Blob Report',
};

/** Return a human-readable label for a report type */
function getReportLabel(type: string, override?: string): string {
  if (override) return override;
  return REPORT_TYPE_LABELS[type] ?? `${type.charAt(0).toUpperCase() + type.slice(1)} Report`;
}

export default eventHandler(async (event) => {
  // `run:submit` on at least one project, from the route meta; the project itself is checked below.
  const user = await requireAuth(event);

  const maxUploadBytes = resolveMaxUploadBytes();
  const contentLength = parseInt(getRequestHeader(event, 'content-length') ?? '0', 10);
  if (contentLength > maxUploadBytes) {
    throw apiError({ statusCode: 413, message: `Upload too large (max ${formatBytes(maxUploadBytes)})` });
  }

  // Stream the request to temp files, within the upload cap counted on the bytes
  // read: the reporter sends chunked bodies, which declare no length. Each file
  // is read back from disk only when it is stored.
  const multipart = await streamMultipart(event, {
    maxTotalBytes: maxUploadBytes,
    maxFieldBytes: maxUploadBytes,
    maxTotalFieldBytes: maxUploadBytes,
    maxFields: MAX_UPLOAD_PARTS,
    maxFiles: MAX_UPLOAD_PARTS,
  });
  try {
    return await handleUpload(user, multipart);
  } finally {
    await multipart.cleanup();
  }
});

/** Most value fields, and most file parts, one upload may carry (a few per test case). */
const MAX_UPLOAD_PARTS = 100_000;

/** A file part of the upload, read from its temp file when it is stored. */
interface UploadedFile {
  filename: string;
  path: string;
  size: number;
}

async function handleUpload(user: Awaited<ReturnType<typeof requireAuth>>, multipart: StreamedMultipart) {
  // Parse form fields
  let projectName: string | undefined;
  let existingTestRunId: number | undefined; // Set when attaching uploads to an already-created streaming run
  let testRunData: Record<string, unknown> | undefined;
  let testCasesData: Record<string, unknown>[] = [];
  // Map of report type -> { filename, path, label }
  const reportFiles: Map<string, UploadedFile & { label?: string }> = new Map();
  // Trace files attached for specific test case indices: index -> file
  const traceFiles: Map<number, UploadedFile> = new Map();
  // SHA-256 hashes for traces, keyed by the same index as traceFiles.
  // Sent by the reporter for all traces (including those not uploaded due to deduplication).
  const traceHashes: Map<number, string> = new Map();
  // Non-trace attachments: test case index -> array of { name, contentType, originalName }
  const attachmentMeta: Map<number, { name: string; contentType: string; originalName: string }[]> = new Map();
  const attachmentFiles: Map<number, UploadedFile[]> = new Map();

  for (const part of multipart.files) {
    const file = { filename: sanitizeFilename(part.filename), path: part.path, size: part.size };
    if (part.field === 'htmlReport') {
      // The 'htmlReport' field is the report of type 'html'
      reportFiles.set('html', file);
    } else if (part.field.startsWith('report_')) {
      // Any report type: the field name is 'report_<type>'
      const type = part.field.slice('report_'.length);
      if (type && /^[a-z0-9_-]+$/i.test(type)) reportFiles.set(type, file);
    } else if (part.field.startsWith('trace_')) {
      const traceIndex = parseInt(part.field.slice('trace_'.length), 10);
      if (!isNaN(traceIndex)) traceFiles.set(traceIndex, file);
    } else if (part.field.startsWith('attach_file_')) {
      const idx = parseInt(part.field.slice('attach_file_'.length), 10);
      if (!isNaN(idx)) {
        if (!attachmentFiles.has(idx)) attachmentFiles.set(idx, []);
        attachmentFiles.get(idx)!.push(file);
      }
    }
  }

  for (const [name, value] of multipart.fields) {
    if (name === 'runId') {
      const parsed = parseInt(value, 10);
      if (!isNaN(parsed) && parsed > 0) existingTestRunId = parsed;
    } else if (name === 'projectName') {
      projectName = value;
    } else if (name === 'testRun') {
      try {
        testRunData = JSON.parse(value);
      } catch {
        throw apiError({
          statusCode: 400,
          message: 'Invalid JSON in testRun field',
        });
      }
    } else if (name === 'testCases') {
      try {
        testCasesData = JSON.parse(value);
      } catch {
        throw apiError({
          statusCode: 400,
          message: 'Invalid JSON in testCases field',
        });
      }
    } else if (name.startsWith('report_label_')) {
      // Optional label override: 'report_label_<type>'
      const entry = reportFiles.get(name.slice('report_label_'.length));
      if (entry) entry.label = value;
    } else if (name === 'trace_hashes') {
      try {
        const parsed = JSON.parse(value);
        for (const [indexStr, hash] of Object.entries(parsed)) {
          const idx = parseInt(indexStr, 10);
          if (!isNaN(idx) && typeof hash === 'string' && /^[0-9a-f]{64}$/i.test(hash)) {
            traceHashes.set(idx, hash);
          }
        }
      } catch {
        // Deduplication metadata is optional; ignore parse errors
      }
    } else if (name.startsWith('attach_meta_')) {
      const idx = parseInt(name.slice('attach_meta_'.length), 10);
      if (!isNaN(idx)) {
        try {
          const parsed = JSON.parse(value);
          if (Array.isArray(parsed)) {
            attachmentMeta.set(
              idx,
              parsed.map((a: Record<string, unknown>) => ({
                name: String(a.name || 'attachment'),
                contentType: String(a.contentType || 'application/octet-stream'),
                originalName: String(a.originalName || 'attachment'),
              })),
            );
          }
        } catch {
          // Metadata is optional; ignore parse errors
        }
      }
    }
  }

  // Validate required fields
  if (!projectName || !testRunData) {
    throw apiError({
      statusCode: 400,
      message: 'Missing required fields: projectName, testRun',
    });
  }

  const db = await getDatabase();
  const scope = await getProjectScope(db, user as any, 'run:submit');
  const storage = getStorage();

  // If attaching to an existing streaming run, look up the run and its project
  let project: Project | undefined;
  let attachingToExistingRun = false;
  let existingRunStatus: string | undefined;
  let existingRunMetadata: unknown;

  if (existingTestRunId) {
    const existingRunRows = await db.select().from(testRuns).where(eq(testRuns.id, existingTestRunId));
    const existingRun = existingRunRows[0];
    if (!existingRun) {
      throw apiError({ statusCode: 404, message: 'Existing test run not found' });
    }
    const projectRows = await db.select().from(projects).where(eq(projects.id, existingRun.projectId));
    project = projectRows[0];
    if (!project || !scopeAllows(scope, project.id)) {
      throw apiError({ statusCode: 403, message: 'No access to this project' });
    }
    attachingToExistingRun = true;
    existingRunStatus = existingRun.status;
    existingRunMetadata = existingRun.metadata;
  }

  if (!project) {
    project = await resolveIngestProject(
      db,
      scope,
      projectName,
      testRunData.projectDescription as string | null | undefined,
    );
  }

  // A repeated delivery (the reporter gave up waiting and sent the run again)
  // answers with the run its first delivery stored, its reports and traces unread.
  const deliveryKey = attachingToExistingRun ? null : readDeliveryKey(testRunData.deliveryKey);
  return deliverOnce(db, project.id, deliveryKey, async () => {
    // Create project directory in storage
    const projectPath = `project-${project.id}`;
    await storage.mkdir(projectPath);

    // Helper: store a report file and return { path, size }
    async function storeReport(type: string, report: UploadedFile): Promise<{ path: string; size: number }> {
      if (report.filename.endsWith('.gz')) {
        // Extract gzip compressed archive to temp directory first
        const ts = Date.now();
        const reportDirName = `run-${ts}-${type}-report`;
        const tempDir = join(tmpdir(), `playwright-report-${ts}-${type}`);

        await mkdir(tempDir, { recursive: true });

        try {
          await decompressDirectory(await readFile(report.path), tempDir);

          // Determine the correct entry file for this report type.
          // Blob reports contain .zip archives rather than HTML; find the first one.
          // All other report types (html, monocart, …) use index.html.
          let entryFile = 'index.html';
          if (type === 'blob') {
            const extracted = await readdir(tempDir);
            const zipFile = extracted.find((f) => f.endsWith('.zip'));
            if (zipFile) entryFile = zipFile;
          }

          const storagePath = join(`project-${project!.id}`, reportDirName, entryFile);

          const size = await uploadDirectory(tempDir, join(`project-${project!.id}`, reportDirName), storage);

          await rm(tempDir, { recursive: true, force: true });
          return { path: storagePath, size };
        } catch (error) {
          console.error(`Failed to extract ${type} report: ${error}`);
          // Save as gz file if extraction fails
          const reportFilename = `run-${Date.now()}-${report.filename}`;
          await storage.writeFile(join(`project-${project!.id}`, reportFilename), await readFile(report.path));
          return {
            path: join(`project-${project!.id}`, reportFilename),
            size: report.size,
          };
        }
      } else if (report.filename.endsWith('.zip')) {
        // Store zip as-is (e.g. blob reports are downloadable zip archives)
        const reportFilename = `run-${Date.now()}-${report.filename}`;
        await storage.writeFile(join(`project-${project!.id}`, reportFilename), await readFile(report.path));
        return {
          path: join(`project-${project!.id}`, reportFilename),
          size: report.size,
        };
      } else {
        // Save as regular file (backward compatibility for unknown formats)
        const reportFilename = `run-${Date.now()}-${report.filename}`;
        await storage.writeFile(join(`project-${project!.id}`, reportFilename), await readFile(report.path));
        return {
          path: join(`project-${project!.id}`, reportFilename),
          size: report.size,
        };
      }
    }

    // Store all reports and collect their metadata. Reports are processed one at a
    // time — each `.gz` report is inflated fully into memory before being written
    // to disk, so decompressing them in parallel would stack every report's peak
    // at once.
    const storedReports: { type: string; label: string; path: string; size: number }[] = [];

    for (const [type, report] of [...reportFiles.entries()]) {
      try {
        console.log(`[Upload] Storing ${type} report: ${report.filename}`);
        const { path: storedPath, size } = await storeReport(type, report);
        const label = getReportLabel(type, report.label);
        console.log(`[Upload] Stored ${type} report at ${storedPath} (${size} bytes)`);
        storedReports.push({ type, label, path: storedPath, size });
      } catch (error) {
        console.error(`[Upload] Failed to store ${type} report: ${error}`);
      }
    }

    // Create or retrieve the test run; a created one carries its isFullRun and status for the finalize side effects.
    let testRun: { id: number; projectId: number; isFullRun?: number; status?: string };
    const incomingResources = sanitizeResourceReport(testRunData.resourceReport);

    // A shard of a batch run: its executions join the run its instance's shards
    // share, and the last shard to arrive settles it.
    const instanceId = (testRunData.instanceId as string | null | undefined) || null;
    const shardTotal = testRunData.shardTotal as number | undefined;
    const isBatchShard = !attachingToExistingRun && !!instanceId && !!(shardTotal && shardTotal > 1);

    if (attachingToExistingRun && existingTestRunId) {
      // Attach reports to an already-created streaming run — do not create a new run
      testRun = { id: existingTestRunId, projectId: project.id };
      await applyReporterKeep(db, existingTestRunId, testRunData.keep);
    } else if (isBatchShard) {
      const run = await batchShardRun(db, project.id, instanceId!, testRunData);
      testRun = { id: run.id, projectId: run.projectId };
      if (incomingResources) await saveResourceReportPart(db, run.id, incomingResources);
      await applyReporterKeep(db, run.id, testRunData.keep);
    } else {
      // Create a new test run (standard batch upload)
      const metadata = sanitizeMetadata((testRunData.metadata || null) as Record<string, unknown> | null);
      const testRunResult = await db
        .insert(testRuns)
        .values({
          projectId: project.id,
          status: testRunData.status as string,
          startTime: new Date(testRunData.startTime as string | number | Date),
          duration: (testRunData.duration as number | null | undefined) || null,
          totalTests: (testRunData.totalTests as number | undefined) || 0,
          passedTests: (testRunData.passedTests as number | undefined) || 0,
          failedTests: sumFailedAndTimedOut(
            testRunData.failedTests as number | undefined,
            testRunData.timedOutTests as number | undefined,
          ),
          skippedTests: (testRunData.skippedTests as number | undefined) || 0,
          didNotRunTests: (testRunData.didNotRunTests as number | undefined) || 0,
          environment: (testRunData.environment as string | null | undefined) || null,
          branch: resolveRunBranch(testRunData.metadata),
          label: (testRunData.label as string | null | undefined) || null,
          metadata,
          origin: runOrigin(metadata),
          commit: runCommit(metadata),
          instanceId: (testRunData.instanceId as string | null | undefined) || null,
          playwrightVersion: (testRunData.playwrightVersion as string | null | undefined) || null,
          reporterVersion: (testRunData.reporterVersion as string | null | undefined) || null,
          isFullRun: testRunData.isFullRun !== false ? 1 : 0,
          filterDetails: (testRunData.filterDetails as Record<string, unknown> | null | undefined) || null,
        })
        .returning();

      const resultTestRun = testRunResult[0];

      if (!resultTestRun) {
        throw apiError({
          statusCode: 500,
          message: 'Failed to create test run',
        });
      }

      testRun = {
        id: resultTestRun.id,
        projectId: resultTestRun.projectId,
        isFullRun: resultTestRun.isFullRun,
        status: resultTestRun.status,
      };
      if (incomingResources) await saveResourceReportPart(db, resultTestRun.id, incomingResources);
      await applyReporterKeep(db, resultTestRun.id, testRunData.keep);

      runEventBus.publishGlobal({
        type: 'run-submitted',
        runId: resultTestRun.id,
        projectId: resultTestRun.projectId,
        status: resultTestRun.status,
      });
    }

    // Batch insert report records into the files table
    if (storedReports.length > 0) {
      await db.insert(files).values(
        storedReports.map((r) => ({
          testRunId: testRun.id,
          type: 'report',
          subtype: r.type,
          label: r.label,
          path: r.path.replace(/\\/g, '/'),
          size: r.size,
        })),
      );
    }

    // When attaching reports to an existing streaming run, either settle a
    // finalizing run to the status its reporter sent to /finish, or re-notify if
    // it already finished.
    if (attachingToExistingRun) {
      const settledStatus =
        existingRunStatus === 'finalizing'
          ? await settleFinalizingRun(db, {
              id: testRun.id,
              projectId: testRun.projectId,
              metadata: existingRunMetadata,
            })
          : null;

      if (!settledStatus) {
        // Run already had a final status — just re-notify for dashboard refresh.
        // Re-read it: the stale-run sweep may have settled the run while the
        // reports were being stored.
        const [current] = await db
          .select({ status: testRuns.status })
          .from(testRuns)
          .where(eq(testRuns.id, testRun.id));
        runEventBus.publishGlobal({
          type: 'run-finished',
          runId: testRun.id,
          projectId: testRun.projectId,
          status: current?.status ?? existingRunStatus!,
        });
      }
    }

    // Create test run directory for traces
    const testRunPath = `project-${project.id}/run-${testRun.id}`;
    await storage.mkdir(testRunPath);

    // Insert test cases using the new schema (skipped when attaching to an existing streaming run)
    if (!attachingToExistingRun && testCasesData && testCasesData.length > 0) {
      const cases: RunCaseInput[] = testCasesData.map((testCase: Record<string, unknown>) => {
        const locationStr = testCase.location as string | undefined;
        const { filePath, line, column } = locationStr
          ? parseLocation(locationStr)
          : { filePath: 'unknown', line: null, column: null };

        return {
          filePath,
          suitePath: (testCase.suitePath as string[] | null | undefined) ?? null,
          suiteConfig: (testCase.suiteConfig as RunCaseInput['suiteConfig']) ?? null,
          testAnnotations: (testCase.testAnnotations as RunCaseInput['testAnnotations']) ?? null,
          title: testCase.title as string,
          status: testCase.status as string,
          duration: testCase.duration as number | null | undefined,
          timeout: testCase.timeout as number | null | undefined,
          error: testCase.error as string | null | undefined,
          retries: testCase.retries as number | undefined,
          attempts: testCase.attempts,
          line,
          column,
          steps: testCase.steps,
          stepEvents: testCase.stepEvents,
          slowestStep: testCase.slowestStep as string | null | undefined,
          slowestStepDuration: testCase.slowestStepDuration as number | null | undefined,
          wastedTimeMs: testCase.wastedTimeMs as number | null | undefined,
          networkRequests: testCase.networkRequests,
          webVitals: testCase.webVitals,
          pageState: testCase.pageState,
          pageInventory: testCase.pageInventory,
          locatorPages: testCase.locatorPages,
          codeReach: testCase.codeReach,
          coverage: testCase.coverage,
          resources: testCase.resources ?? null,
          aiUsage: testCase.aiUsage,
          consoleLogs: testCase.consoleLogs,
          dialogs: testCase.dialogs,
          ariaSnapshot: testCase.ariaSnapshot as string | null | undefined,
          ariaSnapshotJson: testCase.ariaSnapshotJson as string | null | undefined,
          testSource: testCase.testSource as string | null | undefined,
          testSourceFrames: testCase.testSourceFrames as unknown,
          browser: testCase.browser as unknown | null | undefined,
          workerIndex: testCase.workerIndex as number | null | undefined,
          shardIndex: testCase.shardIndex as number | null | undefined,
          startedAt: testCase.startedAt as number | null | undefined,
          tags: testCase.tags ?? null,
          locks: testCase.locks ?? null,
          testMeta: testCase.testMeta ?? null,
          locatorSnapshots: (testCase as any).locatorSnapshots ?? null,
          didNotRunReason: (testCase.didNotRunReason as string | null | undefined) ?? null,
          expectedStatus: (testCase.expectedStatus as string | null | undefined) ?? null,
          blockedBy: (testCase.blockedBy as string | null | undefined) ?? null,
        };
      });

      // Traces and attachments are keyed by the index of their case in the
      // upload; a duplicate case the insert skipped has no execution to link to.
      const insertedRunCases = await persistRunCases(db, project.id, testRun.id, cases);
      const executionByIndex = new Map(insertedRunCases.map((row) => [row.inputIndex, row]));

      // Store trace files linked to their test run case, with content-addressed deduplication.
      // traceHashes may contain entries for indices where no file was uploaded (reporter
      // determined the blob already exists); those still need a files record pointing at
      // the existing blob path.
      const allTraceIndices = new Set([...traceFiles.keys(), ...traceHashes.keys()]);
      // Execution rows that got a trace this upload — evidence is derived from
      // them once all files are stored.
      const tracedCaseIds: number[] = [];
      let tracesSkipped = 0;
      if (executionByIndex.size > 0 && allTraceIndices.size > 0) {
        for (const index of allTraceIndices) {
          const inserted = executionByIndex.get(index);
          if (!inserted?.id) continue;
          const testRunsCaseId = inserted.id;
          const traceFile = traceFiles.get(index);
          const hash = traceHashes.get(index);

          try {
            let storagePath: string;
            let blobId: number | null = null;
            let size: number | null = null;

            if (hash && traceFile) {
              // New content with known hash: upsert into the blob store
              const blob = await upsertTraceBlob(project!.id, hash, await readFile(traceFile.path));
              storagePath = blob.path;
              blobId = blob.id;
              size = blob.size;
              console.log(`[Upload] Stored trace blob ${hash.slice(0, 8)}… for case #${testRunsCaseId}`);
            } else if (hash && !traceFile) {
              // Reporter said this blob already exists on the server — look it up
              const blob = await findTraceBlob(project!.id, hash);
              if (!blob) {
                console.warn(`[Upload] Hash ${hash.slice(0, 8)}… referenced but blob not found, skipping`);
                tracesSkipped++;
                continue;
              }
              storagePath = blob.path;
              blobId = blob.id;
              size = blob.size;
              console.log(`[Upload] Reused trace blob ${hash.slice(0, 8)}… for case #${testRunsCaseId}`);
            } else if (traceFile) {
              // Legacy path: no hash metadata, store at run-specific location
              storagePath = `${testRunPath}/${testRunsCaseId}-${traceFile.filename}`;
              await storage.writeFile(storagePath, await readFile(traceFile.path));
              size = traceFile.size;
              console.log(`[Upload] Stored trace for case #${testRunsCaseId} at ${storagePath}`);
            } else {
              continue;
            }

            await db.insert(files).values({
              testRunsCaseId,
              testRunId: testRun.id,
              type: 'trace',
              path: storagePath.replace(/\\/g, '/'),
              size,
              blobId,
            });
            tracedCaseIds.push(testRunsCaseId);
          } catch (error) {
            console.error(`[Upload] Failed to store trace for case #${testRunsCaseId}: ${error}`);
            tracesSkipped++;
          }
        }
      }

      await recordIngestHealth(db, testRun.id, { tracesSkipped });

      // Store non-trace attachments (screenshots, videos, custom files) linked to test run cases
      if (executionByIndex.size > 0 && attachmentMeta.size > 0) {
        for (const [index, metaList] of attachmentMeta) {
          const inserted = executionByIndex.get(index);
          if (!inserted?.id) continue;
          const testRunsCaseId = inserted.id;
          const filesList = attachmentFiles.get(index) || [];

          for (let fi = 0; fi < Math.min(metaList.length, filesList.length); fi++) {
            const meta = metaList[fi]!;
            const fileEntry = filesList[fi]!;
            const attachmentDir = `${testRunPath}/${testRunsCaseId}`;
            await storage.mkdir(attachmentDir);
            const storagePath = `${attachmentDir}/${fileEntry.filename}`;

            try {
              await storage.writeFile(storagePath, await readFile(fileEntry.path));
              await db.insert(files).values({
                testRunsCaseId,
                testRunId: testRun.id,
                type: 'attachment',
                subtype: meta.name,
                label: meta.contentType,
                path: storagePath.replace(/\\/g, '/'),
                size: fileEntry.size,
              });
              console.log(`[Upload] Stored attachment "${meta.name}" for case #${testRunsCaseId}`);
            } catch (error) {
              console.error(`[Upload] Failed to store attachment for case #${testRunsCaseId}: ${error}`);
            }
          }
        }
      }

      // With traces and attachments stored, recover the evidence the capture
      // fixtures would have provided (console, network, ARIA) for any execution
      // that got a trace but no fixture data. Idempotent and best-effort.
      for (const tracedCaseId of tracedCaseIds) {
        try {
          await deriveTraceEvidence(db, tracedCaseId);
        } catch (error) {
          console.error(`[Upload] Failed to derive trace evidence for case #${tracedCaseId}: ${error}`);
        }
      }
    }

    // Compute and store performance summary (avgTestDuration, p90TestDuration) + flaky count
    // Only applicable for new (non-streaming) runs that include test case data
    if (!attachingToExistingRun && !isBatchShard && testCasesData && testCasesData.length > 0) {
      const durations = testCasesData.map((tc: Record<string, unknown>) => tc.duration as number | null | undefined);

      // Flaky count is independent of whether duration data is present
      const flakyTestCount = testCasesData.filter(
        (tc: Record<string, unknown>) => tc.status === 'passed' && ((tc.retries as number) || 0) > 0,
      ).length;

      const stats = durationStats(durations);
      if (stats) {
        await db
          .update(testRuns)
          .set({ avgTestDuration: stats.avg, p90TestDuration: stats.p90, flakyTests: flakyTestCount })
          .where(eq(testRuns.id, testRun.id));
      } else if (flakyTestCount > 0) {
        // No duration data, but still persist flaky count
        await db.update(testRuns).set({ flakyTests: flakyTestCount }).where(eq(testRuns.id, testRun.id));
      }
    }

    if (isBatchShard) {
      await addBatchShard(db, testRun.id, batchShardTally(testRunData, testCasesData));
      if (!(await finalizeShardedRun(db, testRun.id, 'run-submitted'))) await publishShardProgress(db, testRun.id);
    } else if (!attachingToExistingRun) {
      // For new (non-streaming) runs, fire the finalize side effects after cases are
      // persisted — probe-aware, so a probe-stamped upload stays silent.
      await runFinalizeSideEffects(db, testRun.id, {
        projectId: project.id,
        metadata: testRunData?.metadata,
        isFullRun: testRun.isFullRun,
        status: testRun.status,
      });
    }

    return {
      success: true,
      runId: testRun.id,
      projectId: project.id,
      reports: storedReports.map((r) => ({ type: r.type, label: r.label, path: r.path })),
    };
  });
}
