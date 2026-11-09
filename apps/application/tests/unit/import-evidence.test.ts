import { describe, test, expect } from 'vitest';
import { parseErrorContext, consoleLogsFromTrace } from '../../server/utils/import-evidence';
import { errorContextMarkdown } from '../utils/blob-report-fixture';
import type { ParsedTraceData } from '../../server/utils/trace-events';

/** A `ParsedTraceData` carrying only the console entries and context headers a test cares about. */
function traceWith(
  consoleEntries: ParsedTraceData['consoleEntries'],
  contexts: ParsedTraceData['contexts'] = [],
): ParsedTraceData {
  return {
    actions: [],
    consoleEntries,
    networkRequests: [],
    frameSnapshots: [],
    failingAction: null,
    failingActionIndex: -1,
    contexts,
    errors: [],
    eventCount: 0,
    timeoutFallback: false,
    traceEndTime: 0,
  };
}

describe('parseErrorContext', () => {
  const markdown = errorContextMarkdown({
    snapshot: '- heading "Hello" [level=1]\n- button "Go"',
    source: [
      [1, "import { test } from '@playwright/test';"],
      [2, ''],
      [3, "test('a', async ({ page }) => {"],
      [4, "  await expect(page.getByRole('button')).toBeVisible();"],
      [5, '});'],
    ],
  });

  test('extracts the failure-time page snapshot', () => {
    const evidence = parseErrorContext(markdown, { declLine: 3, failingLine: 4 });
    expect(evidence.ariaSnapshot).toBe('- heading "Hello" [level=1]\n- button "Go"');
  });

  test('re-renders the source in the reporter snippet format', () => {
    const evidence = parseErrorContext(markdown, { declLine: 3, failingLine: 4 });
    const lines = evidence.testSource!.split('\n');

    // `>` marks the failing line, `*` the test declaration, numbers pad to four.
    expect(lines[3]).toBe(">    4 |   await expect(page.getByRole('button')).toBeVisible();");
    expect(lines[2]).toBe("*    3 | test('a', async ({ page }) => {");
    expect(lines[0]).toBe("     1 | import { test } from '@playwright/test';");
  });

  test('marks the declaration with `>` when no failing line is known', () => {
    const evidence = parseErrorContext(markdown, { declLine: 3, failingLine: null });
    expect(evidence.testSource!.split('\n')[2]).toBe(">    3 | test('a', async ({ page }) => {");
  });

  test('windows the snippet around the failure', () => {
    const source: Array<[number, string]> = Array.from({ length: 200 }, (_, i) => [i + 1, `line ${i + 1}`]);
    const evidence = parseErrorContext(errorContextMarkdown({ snapshot: '- body', source }), {
      declLine: 100,
      failingLine: 100,
      context: 5,
    });

    // `context` lines either side of the anchor, plus the anchor itself.
    const lines = evidence.testSource!.split('\n');
    expect(lines).toHaveLength(11);
    expect(lines[0]).toContain('line 95');
    expect(lines.at(-1)).toContain('line 105');
  });

  test('returns nulls for a context with neither section', () => {
    expect(parseErrorContext('# Test info\n\n- Name: demo\n')).toEqual({ ariaSnapshot: null, testSource: null });
  });
});

describe('consoleLogsFromTrace', () => {
  test('keeps the levels the capture fixtures record and drops the rest', () => {
    const logs = consoleLogsFromTrace(
      traceWith([
        { type: 'error', text: 'boom', timestamp: 0 },
        { type: 'warning', text: 'careful', timestamp: 0 },
        { type: 'assert', text: 'assertion', timestamp: 0 },
        { type: 'log', text: 'chatter', timestamp: 0 },
        { type: 'info', text: 'noise', timestamp: 0 },
      ]),
      null,
    );

    expect(logs!.map((l) => l.type)).toEqual(['error', 'warning', 'assert']);
  });

  test('rebases monotonic trace offsets onto the execution start', () => {
    const logs = consoleLogsFromTrace(
      traceWith([{ type: 'error', text: 'boom', timestamp: 9604.857 }]),
      1_700_000_000_000,
    );
    // Trace timestamps that are too small to be an epoch are offsets, not dates.
    expect(logs![0]!.timestamp).toBe(1_700_000_009_605);
  });

  test("puts a monotonic time on the wall clock through the trace's own anchor, not the worker's uptime", () => {
    // The worker had been up an hour when the browser context opened at 1_700_000_000_000.
    const contexts = [
      { origin: 'testRunner', wallTime: 1_699_999_999_900, monotonicTime: 3_599_900 },
      { origin: 'library', wallTime: 1_700_000_000_000, monotonicTime: 3_600_000 },
    ];
    const logs = consoleLogsFromTrace(
      traceWith([{ type: 'error', text: 'boom', timestamp: 3_605_000.4 }], contexts),
      1_699_999_999_900,
    );
    expect(logs![0]!.timestamp).toBe(1_700_000_005_000);
  });

  test('leaves wall-clock trace timestamps alone', () => {
    const logs = consoleLogsFromTrace(
      traceWith([{ type: 'error', text: 'boom', timestamp: 1_700_000_005_000 }]),
      1_700_000_000_000,
    );
    expect(logs![0]!.timestamp).toBe(1_700_000_005_000);
  });

  test('formats a structured location and drops an inline-script one', () => {
    const logs = consoleLogsFromTrace(
      traceWith([
        {
          type: 'error',
          text: 'a',
          timestamp: 0,
          location: { url: 'https://app/x.js', lineNumber: 3, columnNumber: 8 },
        },
        { type: 'error', text: 'b', timestamp: 0, location: { url: '', lineNumber: 0, columnNumber: 8 } },
      ]),
      null,
    );

    expect(logs![0]!.location).toBe('https://app/x.js:3:8');
    expect(logs![1]!.location).toBeNull();
  });

  test('returns null when the trace has nothing worth storing', () => {
    expect(consoleLogsFromTrace(null, null)).toBeNull();
    expect(consoleLogsFromTrace(traceWith([]), null)).toBeNull();
    expect(consoleLogsFromTrace(traceWith([{ type: 'log', text: 'chatter', timestamp: 0 }]), null)).toBeNull();
  });
});
