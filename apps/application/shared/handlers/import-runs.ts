/**
 * Importing historical archives into a project — the logic both the server and
 * demo mode run.
 *
 * The parsing already lives in `server/utils/blob-report.ts` and
 * `trace-import.ts`, free of `node:` imports so both runtimes can use it. What
 * happens *after* parsing — creating the run, persisting the executions,
 * linking their files, rolling a trace group's counters up — is identical
 * database work, so it lives here rather than in two copies.
 *
 * Only four things genuinely differ between the two, and they arrive as an
 * `ImportPort`: how executions are persisted, where files are stored, how a
 * trace's console is read back out of a nested archive, and how the dashboard
 * is told a run appeared. Everything else is shared.
 */

import { RUN_ORIGIN_METADATA_KEY } from '@piwitests/core/wire';
import { and, eq, gt, ne } from 'drizzle-orm';
import { testRuns, testRunsCases, testCases, files, networkRequests } from '../../server/database/schema';
import type { DrizzleDB } from './db';
import type { ImportedRunCase, ParsedBlobReport } from '../../server/utils/blob-report';
import { resolveSpecPath, type ParsedTraceImport } from '../../server/utils/trace-import';
import { resolveRunBranch } from '../../server/utils/run-branch';
import { runCommit, runOrigin } from '../run-eligibility';
import type { PersistRunCasesOptions } from '../../server/utils/persist-options';
import { durationStats } from '../utils/stats';
import { sumFailedAndTimedOut } from '../utils/test-counts';
import { joinSuitePath } from '../utils/suites';
import { formatBytes } from '../utils/format-bytes';
import type { ImportCheckResult, ImportRunResponse } from '../import.types';
import { upsertDailyRollup } from './analytics/rollups';

/** A file the host stored, as it should be recorded in `files`. */
export interface StoredImportFile {
  path: string;
  size: number;
  /** Set when the host deduplicates into a blob table (server only). */
  blobId?: number | null;
}

/**
 * Bytes handed to the host for storage.
 *
 * A `Blob` is allowed so a host that never materialised the archive does not
 * have to: in the browser the uploaded `File` is engine-managed, and both the
 * ZIP reader and IndexedDB take it as-is. Everything read *out* of an archive
 * is a plain buffer — only the whole archive is big enough for this to matter.
 */
export type StorableBytes = Uint8Array | Blob;

/** Length of either form, without copying a `Blob` to find out. */
export function byteLengthOf(value: StorableBytes): number {
  return value instanceof Uint8Array ? value.byteLength : value.size;
}

/** A buffer either way, materialising a `Blob` only when the host needs one. */
export async function toBytes(value: StorableBytes): Promise<Uint8Array> {
  return value instanceof Uint8Array ? value : new Uint8Array(await value.arrayBuffer());
}

/** What an import needs from its host runtime. */
export interface ImportPort {
  /**
   * Persist executions and return the inserted junction rows, each with the
   * index of the case it came from, so files are linked by `inputIndex`. A case
   * deduplicated on the junction's unique key returns no row. The server and
   * the demo have separate implementations of this already.
   */
  persistRunCases(
    db: DrizzleDB,
    projectId: number,
    testRunId: number,
    cases: unknown[],
    options?: PersistRunCasesOptions,
  ): Promise<Array<{ id: number; inputIndex: number }>>;

  /**
   * Write one file and report where it landed, or null if it could not be
   * stored. `testRunsCaseId` is absent while traces are being staged ahead of
   * their case rows.
   */
  storeFile(input: {
    projectId: number;
    testRunId: number;
    testRunsCaseId: number | null;
    kind: 'trace' | 'attachment';
    /** Archive entry name, for deriving a filename or extension. */
    entryName: string;
    bytes: StorableBytes;
    /**
     * SHA-256 of `bytes` when the caller already knows it, so a host that
     * content-addresses its storage need not read them again to find out.
     */
    digest?: string;
  }): Promise<StoredImportFile | null>;

  /** Console entries recovered from a trace archive's bytes. */
  readTraceConsole(bytes: Uint8Array, startedAt: number | null): Promise<unknown>;

  /** Recover the ARIA snapshot and source snippet from an `error-context` body. */
  parseErrorContext(
    markdown: string,
    declLine: number | null,
  ): { ariaSnapshot: string | null; testSource: string | null };

  /** Tell the dashboard a run appeared. */
  publishRunSubmitted(event: { runId: number; projectId: number; status: string }): void;

  /** Tell the analytics the run's daily rollup now counts it (the widget cache, the live dashboards). */
  publishRollupUpdated(event: { runId: number; projectId: number }): void;

  /** Optional diagnostics; the server logs, the demo stays quiet. */
  warn?(message: string): void;
}

/** Reads one entry out of the archive, or null when absent or unreadable. */
type ArchiveEntryReader = (name: string) => Promise<Uint8Array | null>;

const SHA256_RE = /^[0-9a-f]{64}$/;

/** Which of these digests the project already holds, mapped to their run. */
export async function findImportedHashes(
  db: DrizzleDB,
  projectId: number,
  hashes: string[],
): Promise<Map<string, number>> {
  const found = new Map<string, number>();
  if (hashes.length === 0) return found;

  const wanted = new Set(hashes);
  const rows = await db
    .select({ id: testRuns.id, importHash: testRuns.importHash })
    .from(testRuns)
    .where(eq(testRuns.projectId, projectId));

  for (const row of rows) {
    if (row.importHash && wanted.has(row.importHash)) found.set(row.importHash, row.id);
  }
  return found;
}

/**
 * Judge a batch of candidate archives from their metadata alone.
 *
 * Everything decidable without reading the file is decided here, so a client
 * can skip uploads that would be rejected or ignored. The only thing that
 * varies between hosts is the ceiling — the server's configured limit, or the
 * much lower one the demo can hold in a browser tab.
 */
export function judgeImportFiles(
  candidates: unknown[],
  options: { maxBytes: number; alreadyImported: Map<string, number>; tooLargeSuffix?: string },
): ImportCheckResult[] {
  return candidates.map((raw) => {
    const entry = (raw ?? {}) as Record<string, unknown>;
    const name = typeof entry.name === 'string' && entry.name ? entry.name : 'file';
    const size = typeof entry.size === 'number' ? entry.size : -1;
    const hash = typeof entry.hash === 'string' ? entry.hash.toLowerCase() : '';

    if (size < 0 || !SHA256_RE.test(hash)) {
      return { name, status: 'invalid', message: 'Missing a readable name, size or SHA-256.' };
    }
    if (size === 0) return { name, status: 'invalid', message: 'The file is empty.' };
    if (!name.toLowerCase().endsWith('.zip')) {
      return { name, status: 'invalid', message: 'Expected a .zip blob report (blob-report/report-*.zip).' };
    }
    if (size > options.maxBytes) {
      return {
        name,
        status: 'too-large',
        message: `${formatBytes(size)} exceeds ${formatBytes(options.maxBytes)}` + (options.tooLargeSuffix ?? '.'),
      };
    }

    const existingRunId = options.alreadyImported.get(hash);
    if (existingRunId !== undefined) {
      return { name, status: 'duplicate', message: 'Already imported into this project.', runId: existingRunId };
    }

    return { name, status: 'ok' };
  });
}

/**
 * Whether an imported run is historical: the project already holds a run that
 * started after it. A historical import writes no shared state (the tests'
 * tags, owner, priority, locks and locator snapshots) and wakes no snoozed
 * cluster.
 */
export async function isHistoricalImport(
  db: DrizzleDB,
  projectId: number,
  runId: number,
  startTime: Date,
): Promise<boolean> {
  const [newer] = await db
    .select({ id: testRuns.id })
    .from(testRuns)
    .where(and(eq(testRuns.projectId, projectId), ne(testRuns.id, runId), gt(testRuns.startTime, startTime)))
    .limit(1);
  return newer !== undefined;
}

/**
 * How an imported run's executions are persisted: dated from their attempts,
 * and, for a historical import ({@link isHistoricalImport}), leaving the tests'
 * current state and snoozed clusters as they are.
 */
export async function importPersistOptions(
  db: DrizzleDB,
  projectId: number,
  runId: number,
  startTime: Date,
): Promise<PersistRunCasesOptions> {
  const historical = await isHistoricalImport(db, projectId, runId, startTime);
  return { datedFrom: startTime, keepTestState: historical, keepSnoozed: historical };
}

/** Return an already-imported archive's summary, or null when it is new. */
export async function findImportedRun(
  db: DrizzleDB,
  projectId: number,
  importHash: string,
): Promise<ImportRunResponse | null> {
  const rows = await db
    .select()
    .from(testRuns)
    .where(and(eq(testRuns.projectId, projectId), eq(testRuns.importHash, importHash)));

  const run = rows[0];
  return run ? summarizeRun(run, projectId, 'duplicate', 0, 0) : null;
}

/**
 * Import a parsed blob report: one archive becomes one complete run.
 *
 * Evidence and traces are handled before the rows exist — the evidence lands on
 * the case columns, and reading each trace once yields both its console entries
 * and its stored bytes.
 */
export async function importBlobReportRun(
  db: DrizzleDB,
  port: ImportPort,
  input: {
    projectId: number;
    parsed: ParsedBlobReport;
    readEntry: ArchiveEntryReader;
    importHash: string;
    source: string;
    environment?: string | null;
    label?: string | null;
  },
): Promise<ImportRunResponse> {
  const { projectId, parsed, readEntry, importHash, source } = input;

  const stagedTraces = new Map<number, Array<{ file: StoredImportFile; entryName: string }>>();

  for (const [index, entry] of parsed.cases.entries()) {
    await recoverErrorContext(port, readEntry, entry);

    const staged: Array<{ file: StoredImportFile; entryName: string }> = [];
    for (const [traceIndex, ref] of entry.traces.entries()) {
      const bytes = await readEntry(ref.entry);
      if (!bytes) continue;
      // The first trace covers the execution itself; one read serves both the
      // console entries and the stored file.
      if (traceIndex === 0) entry.case.consoleLogs = await port.readTraceConsole(bytes, entry.case.startedAt ?? null);

      const file = await port.storeFile({
        projectId,
        testRunId: 0,
        testRunsCaseId: null,
        kind: 'trace',
        entryName: ref.entry,
        bytes,
      });
      if (file) staged.push({ file, entryName: ref.entry });
    }
    if (staged.length) stagedTraces.set(index, staged);
  }

  const metadata = {
    ...(parsed.scm ? { scm: parsed.scm } : {}),
    [RUN_ORIGIN_METADATA_KEY]: { kind: 'import' },
    import: {
      source,
      importedAt: new Date().toISOString(),
      blobVersion: parsed.blobVersion,
      ...(parsed.shard ? { shard: parsed.shard } : {}),
    },
  };
  const inserted = await db
    .insert(testRuns)
    .values({
      projectId,
      status: parsed.status,
      startTime: parsed.startTime,
      duration: parsed.duration,
      totalTests: parsed.totalTests,
      passedTests: parsed.passedTests,
      failedTests: sumFailedAndTimedOut(parsed.failedTests, parsed.timedOutTests),
      skippedTests: parsed.skippedTests,
      didNotRunTests: parsed.didNotRunTests,
      flakyTests: parsed.flakyTests,
      environment: input.environment ?? null,
      branch: resolveRunBranch({ scm: parsed.scm }),
      label: input.label ?? null,
      playwrightVersion: parsed.playwrightVersion,
      importHash,
      metadata: metadata as never,
      origin: runOrigin(metadata),
      commit: runCommit(metadata),
    })
    .returning();

  const run = inserted[0];
  if (!run) throw new Error('Failed to create the imported test run');

  let traceCount = 0;
  let attachmentCount = 0;

  try {
    const insertedCases = await port.persistRunCases(
      db,
      projectId,
      run.id,
      parsed.cases.map((entry) => entry.case),
      await importPersistOptions(db, projectId, run.id, parsed.startTime),
    );

    // A repeatEach run collides on the junction's unique key and drops a case;
    // the files of a dropped case have no execution to link to.
    const executionByIndex = new Map(insertedCases.map((row) => [row.inputIndex, row.id]));
    if (insertedCases.length < parsed.cases.length) {
      port.warn?.(
        `${parsed.cases.length - insertedCases.length} of ${parsed.cases.length} executions were deduplicated in run #${run.id}; their files are not linked`,
      );
    }

    for (const [index, entry] of parsed.cases.entries()) {
      const testRunsCaseId = executionByIndex.get(index);
      if (!testRunsCaseId) continue;

      for (const staged of stagedTraces.get(index) ?? []) {
        await db.insert(files).values({
          testRunsCaseId,
          testRunId: run.id,
          type: 'trace',
          path: staged.file.path,
          size: staged.file.size,
          blobId: staged.file.blobId ?? null,
        });
        traceCount++;
      }

      for (const ref of entry.attachments) {
        const bytes = await readEntry(ref.entry);
        if (!bytes) continue;
        const stored = await port.storeFile({
          projectId,
          testRunId: run.id,
          testRunsCaseId,
          kind: 'attachment',
          entryName: ref.entry,
          bytes,
        });
        if (!stored) continue;

        await db.insert(files).values({
          testRunsCaseId,
          testRunId: run.id,
          type: 'attachment',
          subtype: ref.name,
          label: ref.contentType,
          path: stored.path,
          size: stored.size,
          blobId: stored.blobId ?? null,
        });
        attachmentCount++;
      }
    }

    const stats = durationStats(parsed.cases.map((entry) => entry.case.duration));
    if (stats) {
      await db
        .update(testRuns)
        .set({ avgTestDuration: stats.avg, p90TestDuration: stats.p90 })
        .where(eq(testRuns.id, run.id));
    }
  } catch (error) {
    // A failed import leaves no run behind, so a retry of the same archive is
    // not taken for a duplicate of it.
    await discardImportedRun(db, port, run.id);
    throw error;
  }

  await upsertDailyRollup(db, run.id).catch((e) => console.error('[analytics] upsertDailyRollup failed', e));
  port.publishRunSubmitted({ runId: run.id, projectId, status: parsed.status });
  port.publishRollupUpdated({ runId: run.id, projectId });

  return {
    status: 'imported',
    kind: 'blob-report',
    runId: run.id,
    projectId,
    runStatus: parsed.status,
    startTime: parsed.startTime.toISOString(),
    totalTests: parsed.totalTests,
    passedTests: parsed.passedTests,
    failedTests: sumFailedAndTimedOut(parsed.failedTests, parsed.timedOutTests),
    skippedTests: parsed.skippedTests,
    didNotRunTests: parsed.didNotRunTests,
    flakyTests: parsed.flakyTests,
    traceCount,
    attachmentCount,
    playwrightVersion: parsed.playwrightVersion,
    projectNames: parsed.projectNames,
    filePaths: [...new Set(parsed.cases.map((entry) => entry.case.filePath))].sort().slice(0, 20),
    shard: parsed.shard,
  };
}

/**
 * Import a parsed trace as one execution.
 *
 * A trace knows nothing of the run it belonged to, so the caller decides how
 * they group: with an `importGroup`, every trace uploaded under it lands in one
 * run; without one, each trace becomes its own single-test run.
 */
export async function importTraceRun(
  db: DrizzleDB,
  port: ImportPort,
  input: {
    projectId: number;
    parsed: ParsedTraceImport;
    bytes: StorableBytes;
    importHash: string;
    importGroup: string | null;
    source: string;
    environment?: string | null;
    label?: string | null;
  },
): Promise<ImportRunResponse> {
  const { projectId, parsed, bytes, importHash, importGroup, source } = input;

  // Adopt the spec path this project already uses for the file, so the imported
  // execution joins the existing test case instead of forking a lookalike.
  const knownPaths = await db
    .selectDistinct({ filePath: testCases.filePath })
    .from(testCases)
    .where(eq(testCases.projectId, projectId));
  parsed.case.filePath = resolveSpecPath(
    parsed.rawFilePath,
    knownPaths.map((row) => row.filePath),
  );

  // The group is the run's identity when set, so a re-uploaded batch reuses the
  // same run rather than building a second copy of it beside the first.
  const runKey = importGroup ?? importHash;
  let createdRun = false;
  let run = (
    await db
      .select()
      .from(testRuns)
      .where(and(eq(testRuns.projectId, projectId), eq(testRuns.importHash, runKey)))
  )[0];

  if (!run) {
    const metadata = {
      [RUN_ORIGIN_METADATA_KEY]: { kind: 'import' },
      import: { source, importedAt: new Date().toISOString(), kind: 'trace' },
    };
    try {
      run = (
        await db
          .insert(testRuns)
          .values({
            projectId,
            status: 'passed',
            startTime: new Date(parsed.startedAt),
            duration: 0,
            environment: input.environment ?? null,
            label: input.label ?? null,
            playwrightVersion: parsed.playwrightVersion,
            importHash: runKey,
            metadata: metadata as never,
            origin: runOrigin(metadata),
            commit: runCommit(metadata),
          })
          .returning()
      )[0];
      createdRun = true;
    } catch {
      // Another trace from the same group created the run in between.
      run = (
        await db
          .select()
          .from(testRuns)
          .where(and(eq(testRuns.projectId, projectId), eq(testRuns.importHash, runKey)))
      )[0];
    }
  }
  if (!run) throw new Error('Failed to create the imported test run');

  let traceCount = 0;
  try {
    // Stage the trace first: its stored path is derived from the bytes, so it
    // doubles as the check for whether this very trace is already in the run.
    const stored = await port.storeFile({
      projectId,
      testRunId: run.id,
      testRunsCaseId: null,
      kind: 'trace',
      entryName: `${importHash}.zip`,
      bytes,
      // The archive's own digest is what identifies this import, so the store can
      // address it by that instead of reading the whole thing a second time.
      digest: importHash,
    });

    if (stored) {
      const already = await db
        .select({ id: files.id })
        .from(files)
        .where(and(eq(files.testRunId, run.id), eq(files.path, stored.path)));
      // The same trace already here is a repeat upload, not a second attempt.
      if (already.length > 0) return summarizeRun(await reloadRun(db, run.id), projectId, 'duplicate', 0, 0);
    }

    // A different trace for a test the run already has is a retry. Traces carry
    // no attempt index of their own, so it comes from how many attempts of this
    // test the run already holds — which makes upload order the attempt order.
    parsed.case.retries = await countPriorAttempts(db, projectId, run.id, parsed.case);

    const inserted = await port.persistRunCases(
      db,
      projectId,
      run.id,
      [parsed.case],
      await importPersistOptions(db, projectId, run.id, new Date(parsed.startedAt)),
    );
    const testRunsCaseId = inserted[0]?.id;
    if (!testRunsCaseId) return summarizeRun(await reloadRun(db, run.id), projectId, 'duplicate', 0, 0);

    if (stored) {
      await db.insert(files).values({
        testRunsCaseId,
        testRunId: run.id,
        type: 'trace',
        path: stored.path,
        size: stored.size,
        blobId: stored.blobId ?? null,
      });
      traceCount = 1;
    }

    await rollUpTraceRun(db, run.id, new Date(parsed.startedAt));
  } catch (error) {
    // A failed import leaves no run of its own behind, so a retry of the same
    // trace is not taken for a duplicate of it.
    if (createdRun) await discardImportedRun(db, port, run.id);
    throw error;
  }

  const updated = await reloadRun(db, run.id);
  await upsertDailyRollup(db, run.id).catch((e) => console.error('[analytics] upsertDailyRollup failed', e));
  port.publishRunSubmitted({ runId: run.id, projectId, status: updated.status });
  port.publishRollupUpdated({ runId: run.id, projectId });

  return summarizeRun(
    updated,
    projectId,
    'imported',
    traceCount,
    0,
    [parsed.case.filePath],
    [...(parsed.case.suitePath ?? []), parsed.case.title].join(' › '),
  );
}

/**
 * Remove a run an import created and could not finish, with the rows written
 * for it so far. Child rows are deleted explicitly, since the in-browser
 * database does not enforce foreign keys. A failure here is only reported, so
 * the caller rethrows the import's own error.
 */
async function discardImportedRun(db: DrizzleDB, port: ImportPort, runId: number): Promise<void> {
  try {
    await db.delete(files).where(eq(files.testRunId, runId));
    await db.delete(networkRequests).where(eq(networkRequests.testRunId, runId));
    await db.delete(testRunsCases).where(eq(testRunsCases.testRunId, runId));
    await db.delete(testRuns).where(eq(testRuns.id, runId));
  } catch (error) {
    port.warn?.(`Could not remove the unfinished run #${runId}: ${error}`);
  }
}

/** Recover the evidence Playwright's `error-context` attachment still holds. */
async function recoverErrorContext(
  port: ImportPort,
  readEntry: ArchiveEntryReader,
  entry: ImportedRunCase,
): Promise<void> {
  const contextRef = entry.attachments.find((a) => a.name === 'error-context');
  if (!contextRef) return;

  const bytes = await readEntry(contextRef.entry);
  if (!bytes) return;

  const evidence = port.parseErrorContext(new TextDecoder().decode(bytes), entry.case.line ?? null);
  entry.case.ariaSnapshot = evidence.ariaSnapshot;
  entry.case.testSource = evidence.testSource;
}

/** How many executions of this same test the run already holds. */
async function countPriorAttempts(
  db: DrizzleDB,
  projectId: number,
  testRunId: number,
  input: { filePath: string; suitePath?: string[] | null; title: string },
): Promise<number> {
  const existing = await db
    .select({ id: testCases.id })
    .from(testCases)
    .where(
      and(
        eq(testCases.projectId, projectId),
        eq(testCases.filePath, input.filePath),
        eq(testCases.suitePath, joinSuitePath(input.suitePath)),
        eq(testCases.title, input.title),
      ),
    );

  const testCaseId = existing[0]?.id;
  if (testCaseId === undefined) return 0;

  const attempts = await db
    .select({ id: testRunsCases.id })
    .from(testRunsCases)
    .where(and(eq(testRunsCases.testRunId, testRunId), eq(testRunsCases.testCaseId, testCaseId)));

  return attempts.length;
}

/**
 * Recompute a trace-built run's counters from the executions it now holds.
 *
 * Traces arrive one request at a time, so the run's totals are derived after
 * each one rather than accumulated — a rebuild from the rows cannot drift the
 * way a running tally can when a request is retried.
 */
async function rollUpTraceRun(db: DrizzleDB, testRunId: number, startTime: Date): Promise<void> {
  const rows = await db
    .select({ status: testRunsCases.status, duration: testRunsCases.duration, startedAt: testRunsCases.startedAt })
    .from(testRunsCases)
    .where(eq(testRunsCases.testRunId, testRunId));

  const counts = { passed: 0, failed: 0, timedOut: 0, skipped: 0, didNotRun: 0 };
  for (const row of rows) {
    if (row.status === 'passed') counts.passed++;
    else if (row.status === 'timedout' || row.status === 'timedOut') counts.timedOut++;
    else if (row.status === 'skipped') counts.skipped++;
    else if (row.status === 'didnotrun') counts.didNotRun++;
    else counts.failed++;
  }

  const stats = durationStats(rows.map((row) => row.duration));
  const earliest = rows.reduce<number>(
    (min, row) => (row.startedAt != null && row.startedAt < min ? row.startedAt : min),
    startTime.getTime(),
  );
  // Wall-clock span of the group, not the sum: traces from one job overlap.
  const latestEnd = rows.reduce<number>(
    (max, row) => Math.max(max, (row.startedAt ?? earliest) + (row.duration ?? 0)),
    earliest,
  );

  await db
    .update(testRuns)
    .set({
      status: counts.failed + counts.timedOut > 0 ? 'failed' : 'passed',
      startTime: new Date(earliest),
      duration: Math.max(0, latestEnd - earliest),
      totalTests: rows.length,
      passedTests: counts.passed,
      failedTests: sumFailedAndTimedOut(counts.failed, counts.timedOut),
      skippedTests: counts.skipped,
      didNotRunTests: counts.didNotRun,
      avgTestDuration: stats?.avg ?? null,
      p90TestDuration: stats?.p90 ?? null,
      updatedAt: new Date(),
    })
    .where(eq(testRuns.id, testRunId));
}

async function reloadRun(db: DrizzleDB, testRunId: number) {
  const rows = await db.select().from(testRuns).where(eq(testRuns.id, testRunId));
  const run = rows[0];
  if (!run) throw new Error('The imported test run disappeared');
  return run;
}

/** Project a stored run row onto the import response shape. */
function summarizeRun(
  run: Awaited<ReturnType<typeof reloadRun>>,
  projectId: number,
  status: ImportRunResponse['status'],
  traceCount: number,
  attachmentCount: number,
  filePaths: string[] = [],
  caseTitle?: string,
): ImportRunResponse {
  const isTrace = (run.metadata as { import?: { kind?: string } } | null)?.import?.kind === 'trace';
  return {
    status,
    kind: isTrace ? 'trace' : 'blob-report',
    ...(caseTitle ? { caseTitle } : {}),
    runId: run.id,
    projectId,
    runStatus: run.status,
    startTime: run.startTime.toISOString(),
    totalTests: run.totalTests,
    passedTests: run.passedTests,
    failedTests: run.failedTests,
    skippedTests: run.skippedTests,
    didNotRunTests: run.didNotRunTests,
    flakyTests: run.flakyTests,
    traceCount,
    attachmentCount,
    playwrightVersion: run.playwrightVersion,
    projectNames: [],
    filePaths,
    shard: null,
  };
}
