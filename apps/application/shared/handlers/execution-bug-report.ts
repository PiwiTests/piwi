/**
 * A failed execution as a Piwi Picker bug report (`.piwibug`): the reads, and
 * the archive. The conversion itself is `bugReportFromExecution`
 * (`@piwitests/core/execution-steps`); this gathers what it reads — the stored
 * steps and error, the element snapshots of the test's call sites, the console,
 * the failed requests, the viewport and the failure screenshot — and writes
 * the archive the way Piwi Picker writes one. Shared so the server route and
 * the demo mirror build the same file.
 */
import { and, eq, gte, isNotNull, or } from 'drizzle-orm';
import {
  BUG_REPORT_EXTENSION,
  BUG_REPORT_FILES,
  BUG_REPORT_MEDIA_TYPE,
  bugTitle,
  renderBugMarkdown,
  renderBugSpec,
  type BugReport,
  type BugReportNote,
} from '@piwitests/core/bug-report';
import {
  bugReportFromExecution,
  EXECUTION_SCREENSHOT_FILE,
  type ExecutionElementSnapshot,
} from '@piwitests/core/execution-steps';
import type { PiwiSteps } from '@piwitests/core/steps';
import { files, locatorSnapshots, networkRequests, testCases, testRunsCases } from '../../server/database/schema';
import { failurePageScreenshot, isScreenshotFileRow } from '#shared/file-classify';
import { buildExportZip } from '#shared/export/zip';
import type { ExportAssetReader } from '#shared/export/types';
import type { BrowserConfig } from '#shared/types';
import { bugSpecFileName } from './bug-reports';
import type { DrizzleDB } from './db';

/** What the execution page says about the report before it is downloaded. */
export interface ExecutionReplaySummary {
  /** The steps document, as `steps.json` holds it. */
  steps: PiwiSteps;
  /** Steps in the document, of which a person does `manualSteps` by hand. */
  stepCount: number;
  manualSteps: number;
  /** Calls of the test the steps leave out. */
  notes: BugReportNote[];
  notReplayed: number;
  /** The step the test failed at, an index into the steps; null when it failed elsewhere. */
  failedStep: number | null;
}

interface ExecutionBugReport {
  report: BugReport;
  manualSteps: number;
  /** The storage path of the failure screenshot the archive holds, when there is one. */
  screenshotPath: string | null;
  /** The archive's file name: the test's title as a slug, and the execution's id. */
  fileName: string;
}

type ConsoleRow = { type?: unknown; text?: unknown; timestamp?: unknown };

/** The console's errors and warnings, as a report keeps them. */
function consoleEntries(raw: unknown): Array<{ level: 'error' | 'warn'; message: string; time: number | null }> {
  if (!Array.isArray(raw)) return [];
  return (raw as ConsoleRow[]).flatMap((entry) => {
    const type = typeof entry?.type === 'string' ? entry.type : '';
    const level =
      type === 'error' || type === 'pageerror' ? 'error' : type === 'warning' || type === 'warn' ? 'warn' : null;
    if (!level || typeof entry.text !== 'string') return [];
    return [{ level, message: entry.text, time: typeof entry.timestamp === 'number' ? entry.timestamp : null }];
  });
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** A file name made from the test's title, as its spec's is: `checkout-applies-coupon.piwibug`, `bug-123.piwibug`. */
function archiveName(title: string, id: number): string {
  return bugSpecFileName(title, id).replace(/\.spec\.ts$/, `.${BUG_REPORT_EXTENSION}`);
}

/**
 * The text files of a report's archive, as Piwi Picker writes them: the media
 * type first (stored without compression), the steps document, the failing
 * test, the Markdown and the evidence with the context and the `export` block.
 */
function bugReportTextFiles(report: BugReport): Array<{ name: string; data: string }> {
  const evidence = {
    v: report.v,
    context: report.context,
    evidence: report.evidence,
    ...(report.export ? { export: report.export } : {}),
  };
  return [
    { name: BUG_REPORT_FILES.mediaType, data: BUG_REPORT_MEDIA_TYPE },
    { name: BUG_REPORT_FILES.steps, data: `${JSON.stringify(report.steps, null, 2)}\n` },
    { name: bugSpecFileName(bugTitle(report), report.export?.executionId ?? 0), data: renderBugSpec(report).code },
    { name: BUG_REPORT_FILES.markdown, data: renderBugMarkdown(report) },
    { name: BUG_REPORT_FILES.evidence, data: `${JSON.stringify(evidence, null, 2)}\n` },
  ];
}

/**
 * Reads an execution and makes its bug report. Null when the execution does
 * not exist.
 */
export async function getExecutionBugReport(db: DrizzleDB, id: number): Promise<ExecutionBugReport | null> {
  const [row] = await db
    .select({
      steps: testRunsCases.steps,
      error: testRunsCases.error,
      consoleLogs: testRunsCases.consoleLogs,
      browser: testRunsCases.browser,
      pageState: testRunsCases.pageState,
      startedAt: testRunsCases.startedAt,
      testRunId: testRunsCases.testRunId,
      testCaseId: testRunsCases.testCaseId,
      title: testCases.title,
      filePath: testCases.filePath,
    })
    .from(testRunsCases)
    .leftJoin(testCases, eq(testCases.id, testRunsCases.testCaseId))
    .where(eq(testRunsCases.id, id));
  if (!row) return null;

  const [requests, snapshots, fileRows] = await Promise.all([
    db
      .select({
        method: networkRequests.method,
        url: networkRequests.url,
        status: networkRequests.status,
        startTime: networkRequests.startTime,
      })
      .from(networkRequests)
      .where(
        and(
          eq(networkRequests.testRunsCaseId, id),
          or(gte(networkRequests.status, 400), eq(networkRequests.status, 0), isNotNull(networkRequests.failure)),
        ),
      ),
    row.testCaseId
      ? db.select().from(locatorSnapshots).where(eq(locatorSnapshots.testCaseId, row.testCaseId))
      : Promise.resolve([]),
    db
      .select({ type: files.type, subtype: files.subtype, label: files.label, path: files.path })
      .from(files)
      .where(eq(files.testRunsCaseId, id)),
  ]);

  const shots = fileRows.filter(isScreenshotFileRow);
  const shot = failurePageScreenshot(shots, (s) => s.subtype);
  const screenshotPath =
    shot && (shot.label?.toLowerCase() === 'image/png' || shot.path.toLowerCase().endsWith('.png')) ? shot.path : null;

  const browser = (row.browser as BrowserConfig | null) ?? null;
  const pageState = (row.pageState as { url?: unknown } | null) ?? null;
  const elementSnapshots: ExecutionElementSnapshot[] = snapshots.map((s) => {
    const attrs = parseJson<Record<string, unknown>>(s.elementAttrs, {});
    return {
      location: s.location,
      used: { method: s.usedMethod, args: parseJson<unknown[]>(s.usedArgs, []) },
      tagName: s.elementTag,
      attributes: attrs,
      text: s.elementText,
      accessibleName: typeof attrs.accessibleName === 'string' ? attrs.accessibleName : null,
      alternatives: parseJson<ExecutionElementSnapshot['alternatives']>(s.alternatives, []).filter(
        (a) => typeof a?.locator === 'string',
      ),
      // The store keeps the latest snapshot per call site: one from a later run may show a changed element.
      otherRun: s.lastSeenRunId !== row.testRunId,
    };
  });
  const title = row.title ?? `Execution ${id}`;
  const { report, manualSteps } = bugReportFromExecution({
    executionId: id,
    title,
    steps: row.steps,
    error: row.error,
    testFilePath: row.filePath ?? null,
    origin: typeof pageState?.url === 'string' ? pageState.url : null,
    snapshots: elementSnapshots,
    console: consoleEntries(row.consoleLogs),
    requests: requests.map((r) => ({ method: r.method, url: r.url ?? '', status: r.status, time: r.startTime })),
    viewport: browser?.viewport ?? null,
    browser: browser?.browserName ?? browser?.projectName ?? null,
    time: typeof row.startedAt === 'number' ? row.startedAt : null,
    screenshot: screenshotPath != null,
  });
  return { report, manualSteps, screenshotPath, fileName: archiveName(title, id) };
}

/** The report's summary for the execution page: its steps, how many a person does, and what it leaves out. */
export function executionReplaySummary(
  built: Pick<ExecutionBugReport, 'report' | 'manualSteps'>,
): ExecutionReplaySummary {
  const exported = built.report.export;
  const notes = exported?.notes ?? [];
  return {
    steps: built.report.steps,
    stepCount: built.report.steps.steps.length,
    manualSteps: built.manualSteps,
    notes,
    notReplayed: notes.length + (exported?.notesDropped ?? 0),
    failedStep: exported?.failedStep ?? null,
  };
}

/**
 * The report's `.piwibug` archive, as Piwi Picker writes one: every entry
 * stored without compression, `mimetype` first, then the steps, the spec, the
 * Markdown and the evidence, and the failure screenshot when `reader` finds
 * it. A screenshot that cannot be read leaves the report saying it has none.
 */
export async function executionBugReportArchive(
  built: ExecutionBugReport,
  reader: ExportAssetReader,
): Promise<Uint8Array> {
  let report = built.report;
  let screenshot: Uint8Array | null = null;
  if (built.screenshotPath) {
    screenshot = await reader
      .read({
        storagePath: built.screenshotPath,
        zipPath: EXECUTION_SCREENSHOT_FILE,
        kind: 'screenshot',
        name: 'failure screenshot',
        contentType: 'image/png',
        size: null,
      })
      .catch(() => null);
    if (!screenshot) {
      report = {
        ...report,
        evidence: { ...report.evidence, screenshots: [], screenshotNote: 'the failure screenshot could not be read' },
      };
    }
  }
  return buildExportZip([
    ...bugReportTextFiles(report).map((file) => ({ path: file.name, data: file.data, precompressed: true })),
    ...(screenshot ? [{ path: EXECUTION_SCREENSHOT_FILE, data: screenshot, precompressed: true }] : []),
  ]);
}
