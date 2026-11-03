/**
 * Reconstructs a test execution from a bare Playwright trace archive.
 *
 * A trace is not a report: it records one attempt of one test, with no run
 * around it and no notion of what else executed. But it is far from empty — the
 * `context-options` headers carry the test's display title (`file:line › suite
 * › … › test`), its timeout, its browser and viewport, and the wall-clock
 * anchor for every monotonic timestamp inside; a top-level `error` event
 * carries the failure with its stack. That is enough to rebuild an execution
 * that clusters, charts and renders like any other.
 *
 * Everything derived here goes through the same helpers the blob-report path
 * uses, so a test imported from a trace is indistinguishable from the same test
 * imported from a report — bar the fields no trace ever held.
 */

import { parseTraceTexts, traceFileRank, type ParsedTraceData, type TraceContextOptions } from './trace-events';
import type { ArchiveEntryReader } from './blob-report';
import { consoleLogsFromTrace } from './import-evidence';
import { collectStepMetrics } from '#shared/step-analysis';
import { joinErrorMessages, appendErrorLocation } from '#shared/error-text';
import type { RunCaseInput } from './persist-run-cases';

/** Raised for an archive that is recognisably not an importable trace. */
export class TraceImportError extends Error {}

export interface ParsedTraceImport {
  /** The execution, ready for `persistRunCases` once its spec path is resolved. */
  case: RunCaseInput;
  /** Epoch ms the test started — the run's start time when it stands alone. */
  startedAt: number;
  /** Wall-clock length of the trace, in ms. */
  duration: number;
  playwrightVersion: string | null;
  /**
   * Spec path exactly as the trace records it (`checkout.spec.ts`), before it is
   * matched against the paths the project already knows.
   */
  rawFilePath: string;
}

/** Does this archive look like a trace rather than a blob report? */
export function looksLikeTrace(entryNames: Iterable<string>): boolean {
  for (const name of entryNames) {
    if (name.endsWith('.trace')) return true;
  }
  return false;
}

/**
 * Split a trace's display title into its parts.
 *
 * Playwright writes `file:line › describe › … › test title`. The separator is
 * a non-ASCII `›`, which no path and (in practice) no test title contains.
 */
export function parseTraceTitle(title: string): {
  filePath: string;
  line: number | null;
  suitePath: string[];
  title: string;
} {
  const parts = title
    .split('›')
    .map((part) => part.trim())
    .filter(Boolean);

  const head = parts.shift() ?? '';
  const testTitle = parts.pop() ?? head;

  // The head is `file:line`; a Windows path can carry its own colon, so only a
  // trailing all-digit segment counts as the line number.
  const match = head.match(/^(.*):(\d+)$/);

  return {
    filePath: match ? match[1]! : head,
    line: match ? Number(match[2]) : null,
    suitePath: parts,
    title: testTitle,
  };
}

/**
 * Match the spec path a trace records against the paths the project already
 * knows, so an imported trace lands on the existing test case rather than a
 * lookalike beside it.
 *
 * A trace records the path Playwright displays — relative to the config's test
 * root (`checkout.spec.ts`) — while the reporter records it relative to the
 * working directory (`tests/checkout.spec.ts`). Neither the repo root nor the
 * test root is recoverable from a trace, so the project's own paths are the
 * only evidence available: a stored path ending in the recorded one is the same
 * file. An unmatched path is kept verbatim rather than guessed at.
 */
export function resolveSpecPath(rawPath: string, knownPaths: Iterable<string>): string {
  const needle = rawPath.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!needle) return rawPath;

  let best: string | null = null;
  for (const known of knownPaths) {
    const candidate = known.replace(/\\/g, '/');
    if (candidate === needle) return known;
    if (!candidate.endsWith(`/${needle}`)) continue;
    // Prefer the shallowest match: with both `tests/a.spec.ts` and
    // `packages/x/tests/a.spec.ts` present, the ambiguity is real, and the
    // shorter path is the likelier root.
    if (best === null || candidate.length < best.length) best = known;
  }

  return best ?? rawPath;
}

/** Build the stored browser config from the library context's options. */
function browserConfigFrom(context: TraceContextOptions | undefined): Record<string, unknown> | null {
  if (!context) return null;

  const options = context.options ?? {};
  const config: Record<string, unknown> = {};
  if (context.browserName) {
    config.browserName = context.browserName;
    // No Playwright project name is recorded in a trace; the browser is the
    // most faithful stand-in, and it is what `resolveBrowserName` stores.
    config.projectName = context.browserName;
  }
  for (const key of [
    'viewport',
    'deviceScaleFactor',
    'isMobile',
    'hasTouch',
    'locale',
    'timezoneId',
    'colorScheme',
    'offline',
    'bypassCSP',
    'javaScriptEnabled',
    'serviceWorkers',
    'userAgent',
  ] as const) {
    if (options[key] !== undefined) config[key] = options[key];
  }

  return Object.keys(config).length > 0 ? config : null;
}

/**
 * Turn the trace's actions into the step shape `collectStepMetrics` consumes,
 * rebasing their monotonic timestamps onto wall-clock so the timeline lines up
 * with executions that arrived through the reporter.
 */
function stepsFromActions(parsed: ParsedTraceData, wallTime: number, monotonicTime: number) {
  const toWallClock = (monotonic: number) => Math.round(wallTime + (monotonic - monotonicTime));

  return parsed.actions.map((action) => ({
    title: action.apiName,
    duration: action.endTime != null ? Math.round(action.endTime - action.startTime) : 0,
    // Traces carry no step category; `categorizeStep` derives one from the title.
    category: undefined,
    startTime: action.startTime ? toWallClock(action.startTime) : undefined,
    error: action.error?.message ? { message: action.error.message } : undefined,
    steps: [],
  }));
}

/**
 * Parse a trace archive into a single execution.
 *
 * Throws `TraceImportError` when the archive holds no trace event stream, or
 * when it holds one but no context header — without the header there is no
 * title, no clock anchor and no browser, which would leave an execution too
 * hollow to be worth storing.
 */
export async function parseTraceArchive(
  entryNames: string[],
  readEntry: ArchiveEntryReader,
): Promise<ParsedTraceImport> {
  const traceEntries = entryNames.filter((name) => name.endsWith('.trace'));
  if (traceEntries.length === 0) {
    throw new TraceImportError('The archive contains no Playwright trace data.');
  }

  traceEntries.sort((a, b) => traceFileRank(a) - traceFileRank(b));

  const decoder = new TextDecoder();
  const texts: string[] = [];
  for (const name of traceEntries) {
    // A corrupt stream costs its events, not the whole import.
    const bytes = await readEntry(name);
    if (bytes) texts.push(decoder.decode(bytes));
  }

  const parsed = parseTraceTexts(texts);

  // The runner context anchors the test; the library context describes the
  // browser and carries the display title.
  const runnerContext = parsed.contexts.find((c) => c.origin === 'testRunner');
  const libraryContext = parsed.contexts.find((c) => c.title) ?? parsed.contexts.find((c) => c.origin === 'library');
  const anchor = runnerContext ?? libraryContext;

  if (!anchor) {
    throw new TraceImportError('The trace has no context header, so its test cannot be identified.');
  }

  const rawTitle = libraryContext?.title ?? runnerContext?.title ?? '';
  if (!rawTitle) {
    throw new TraceImportError(
      'This trace records no test title, so the test it belongs to cannot be identified. ' +
        'Playwright writes the title with the browser context, so a test that never opened a page — one that was ' +
        'skipped, or failed in a hook — produces a trace that cannot be imported on its own.',
    );
  }

  const { filePath, line, suitePath, title } = parseTraceTitle(rawTitle);

  const wallTime = anchor.wallTime ?? Date.now();
  const monotonicTime = anchor.monotonicTime ?? 0;
  const duration = parsed.traceEndTime > monotonicTime ? Math.round(parsed.traceEndTime - monotonicTime) : 0;

  // A trace records one attempt. The runner logs the errors the test ended
  // with, so with its context those decide: an action error the test caught
  // (`click().catch(() => {})`) is no failure. A trace recorded without the
  // runner failed when an action carried an error — `timeoutFallback` alone is
  // not failure, since a passing trace also ends on its last action.
  const errorText = buildTraceErrorText(parsed, runnerContext !== undefined);
  const status = errorText ? (isTimeout(errorText) ? 'timedOut' : 'failed') : 'passed';

  const metrics = collectStepMetrics(stepsFromActions(parsed, wallTime, monotonicTime));

  return {
    case: {
      filePath,
      suitePath: suitePath.length ? suitePath : null,
      title,
      status,
      duration,
      timeout: runnerContext?.testTimeout ?? null,
      error: errorText,
      retries: 0,
      line,
      column: null,
      steps: metrics.steps.length ? metrics.steps : null,
      slowestStep: metrics.slowestStep?.title ?? null,
      slowestStepDuration: metrics.slowestStep?.duration ?? null,
      wastedTimeMs: metrics.waitTotalDuration,
      consoleLogs: consoleLogsFromTrace(parsed, wallTime),
      startedAt: wallTime,
      browser: browserConfigFrom(libraryContext),
    },
    startedAt: wallTime,
    duration,
    playwrightVersion: anchor.playwrightVersion ?? libraryContext?.playwrightVersion ?? null,
    rawFilePath: filePath,
  };
}

/** True when the failure is Playwright's own test-timeout message. */
function isTimeout(errorText: string): boolean {
  return /Test timeout of \d+ms exceeded/i.test(errorText);
}

/**
 * Assemble the error text from the runner's `error` events (which carry the
 * call log). A trace the runner did not record (`fromRunner` false) falls back
 * to the failing action's own error.
 */
function buildTraceErrorText(parsed: ParsedTraceData, fromRunner: boolean): string | null {
  const messages = parsed.errors.map((error) => ({ message: error.message }));

  if (!fromRunner && messages.length === 0 && parsed.failingAction?.error?.message && !parsed.timeoutFallback) {
    messages.push({ message: parsed.failingAction.error.message });
  }

  const text = joinErrorMessages(messages);
  if (!text) return null;

  // The stack frames are absolute paths from the machine that ran the test; the
  // first in-project frame is what locator healing keys on.
  const frame = parsed.errors.find((error) => error.stack?.length)?.stack?.[0];
  if (!frame?.file) return text;

  return appendErrorLocation(text, { file: frame.file, line: frame.line ?? 0, column: frame.column ?? 0 });
}
