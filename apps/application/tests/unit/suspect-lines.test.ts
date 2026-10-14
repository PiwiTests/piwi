import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import { and, eq, inArray } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import type { ScmChanges } from '../../server/utils/scm/ScmProvider';

/**
 * Suspect lines against a migrated SQLite database: executions ingested with
 * their coverage, the regression context's last green run as the baseline,
 * and a stubbed source control provider for the changes of the range.
 */

vi.mock('../../server/storage', () => ({
  getStorage: () => ({
    async readFile() {
      throw new Error('no file');
    },
    async deleteFile() {},
    async deleteDirectory() {},
  }),
}));

let changes: ScmChanges | null = null;
let scmError: Error | null = null;
let providerAvailable = true;
const fetched: Array<[string, string]> = [];
vi.mock('../../server/utils/scm', () => ({
  detectScmProvider: () => 'github',
  resolveScmToken: async () => null,
  createScmProvider: async () =>
    providerAvailable
      ? {
          fetchChanges: async (from: string, to: string) => {
            fetched.push([from, to]);
            if (scmError) throw scmError;
            return changes;
          },
          fetchFileAtRef: async () => null,
          fetchTree: async () => [],
          getDefaultBranch: async () => 'main',
        }
      : null,
}));

// The context limits read a stored setting through Nitro's auto-imported helper: none is stored.
vi.stubGlobal('getAppSetting', async () => null);

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the modules under test load.
delete process.env.PIWI_DATABASE_URL;
const { persistRunCases } = await import('../../server/utils/persist-run-cases');
const { getExecutionsCoverage } = await import('../../server/utils/coverage');
const { suspectLinesForExecution, suspectLinesForCluster, clusterSuspectLinesForChanges, withFixPlanSuspectLines } =
  await import('../../server/utils/suspect-lines');
const { buildDiagnosisContext } = await import('../../server/utils/ai-context');
const { fixPlanToMarkdown } = await import('../../shared/fix-plan-markdown');
const { testCaseCache } = await import('../../server/utils/test-case-cache');
const { testSuiteCache } = await import('../../server/utils/test-suite-cache');

type Db = ReturnType<typeof drizzle<typeof schema>>;
const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 8, 1);
const REMOTE = 'https://github.com/acme/shop.git';
const GREEN = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const LATER = 'c'.repeat(40);
const BLOB = 'd'.repeat(40);
const BASKET = 'src/ApplicationCore/Services/BasketService.cs';
const LAYOUT = 'src/Web/Views/Shared/_Layout.cshtml';
const NOISE = 'src/basket/basket-page.ts';

const BASKET_PATCH = [
  '@@ -54,9 +54,9 @@ public class BasketService : IBasketService',
  '     {',
  '         var basket = await _basketRepository.FirstOrDefaultAsync(basketSpec);',
  '         if (basket == null) return Result<Basket>.NotFound();',
  '-        _logger.LogInformation("Setting quantities");',
  '-        foreach (var item in basket.Items)',
  '-            if (quantities.TryGetValue(item.Id.ToString(), out var quantity)) item.SetQuantity(quantity);',
  '+        _logger.LogInformation("Updating basket quantities");',
  '+        foreach (var item in basket.Items)',
  '+            if (quantities.TryGetValue(item.Id.ToString(), out var quantity)) item.AddQuantity(quantity);',
  '         basket.RemoveEmptyItems();',
  '         await _basketRepository.UpdateAsync(basket);',
  '         return basket;',
].join('\n');

/** A patch adding `count` lines at the top of a file, over the context's patch budget. */
function bigPatch(count: number): string {
  const added = Array.from({ length: count }, (_, i) => `+export const line${i} = '${'x'.repeat(60)}';`);
  return [`@@ -0,0 +1,${count} @@`, ...added].join('\n');
}

function changed(...files: Array<{ filename: string; patch?: string; status?: string }>): ScmChanges {
  return {
    commits: [{ sha: HEAD.slice(0, 7), message: 'Update basket quantities' }],
    files: files.map((f) => ({ status: 'modified', additions: 3, deletions: 3, ...f })),
  };
}

const tmpDir = mkdtempSync(join(tmpdir(), 'piwi-suspect-lines-'));
afterAll(() => rmSync(tmpDir, { recursive: true, force: true }));

let db: Db;

async function run(id: number, status: 'passed' | 'failed', commit: string, at: number) {
  await db.insert(schema.testRuns).values({
    id,
    projectId: 1,
    status,
    startTime: new Date(at),
    branch: 'main',
    isFullRun: 1,
    metadata: { scm: { commit, remoteUrl: REMOTE, branch: 'main' } },
    totalTests: 1,
  });
}

const basketCoverage = (lines: Array<[number, number]>) => ({
  path: BASKET,
  runtime: 'server',
  blob: BLOB,
  functions: [[40, 90]],
  lines,
});
const layoutCoverage = { path: LAYOUT, runtime: 'server', blob: BLOB, lines: [[1, 60]] };

/** An execution with no error, so ingest files it under no cluster: the tests set the clusters. */
function execution(title: string, status: 'passed' | 'failed', files?: unknown[]) {
  return {
    title,
    filePath: 'tests/basket.spec.ts',
    status,
    line: 1,
    column: 1,
    ...(files ? { coverage: { v: 1, files } } : {}),
  };
}

async function executionId(runId: number, title: string): Promise<number> {
  const [row] = await db
    .select({ id: schema.testRunsCases.id })
    .from(schema.testRunsCases)
    .innerJoin(schema.testCases, eq(schema.testRunsCases.testCaseId, schema.testCases.id))
    .where(and(eq(schema.testRunsCases.testRunId, runId), eq(schema.testCases.title, title)));
  return row!.id;
}

async function cluster(id: number, firstSeenRunId: number, executionIds: number[]) {
  await db.insert(schema.failureClusters).values({
    id,
    projectId: 1,
    fingerprint: `fp-${id}`,
    signature: 'Error: expected 2, received 3',
    errorType: 'Error',
    firstSeenRunId,
    lastSeenRunId: firstSeenRunId,
    status: 'open',
  });
  await db
    .update(schema.testRunsCases)
    .set({ failureClusterId: id })
    .where(inArray(schema.testRunsCases.id, executionIds));
}

beforeAll(async () => {
  db = drizzle(createClient({ url: `file:${join(tmpDir, 'test.db')}` }), { schema });
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../../server/database/migrations', import.meta.url)) });
  await db.insert(schema.projects).values({ id: 1, name: 'shop', defaultBranch: 'main' });
  testCaseCache.invalidate(1);
  testSuiteCache.invalidate(1);

  // Run 1 is the last green run; run 2 fails at HEAD; run 3, earlier than run 1, has no green run before it.
  await run(1, 'passed', GREEN, T0);
  await persistRunCases(db as never, 1, 1, [execution('updates the quantity', 'passed', [basketCoverage([[54, 62]])])]);
  await run(2, 'failed', HEAD, T0 + HOUR);
  await persistRunCases(db as never, 1, 2, [
    execution('updates the quantity', 'failed', [
      layoutCoverage,
      basketCoverage([
        [20, 30],
        [54, 62],
      ]),
    ]),
    execution('removes an item', 'failed', [layoutCoverage, basketCoverage([[57, 57]])]),
    execution('checks out', 'passed', [layoutCoverage, basketCoverage([[54, 62]])]),
    execution('browses', 'passed', [layoutCoverage]),
    execution('signs in', 'passed'),
    execution('fails without coverage', 'failed'),
  ]);
  await run(3, 'failed', HEAD, T0 - HOUR);
  await persistRunCases(db as never, 1, 3, [execution('updates the quantity', 'failed', [basketCoverage([[54, 62]])])]);
  await run(4, 'failed', GREEN, T0 + 2 * HOUR);
  await persistRunCases(db as never, 1, 4, [execution('updates the quantity', 'failed', [basketCoverage([[54, 62]])])]);
  await cluster(1, 2, [await executionId(2, 'updates the quantity'), await executionId(2, 'removes an item')]);
  await cluster(2, 2, [await executionId(2, 'fails without coverage')]);
});

beforeEach(() => {
  changes = changed({ filename: BASKET, patch: BASKET_PATCH });
  scmError = null;
  providerAvailable = true;
  fetched.length = 0;
});

describe('suspectLinesForExecution', () => {
  test('joins the changed lines with the execution’s coverage, scored against the passing executions', async () => {
    const answer = await suspectLinesForExecution(db as never, await executionId(2, 'updates the quantity'));
    expect(fetched).toEqual([[GREEN, HEAD]]);
    expect(answer).toEqual({
      available: true,
      range: { from: GREEN, to: HEAD },
      baselineRunId: 1,
      summary: {
        changedFiles: 1,
        changedLines: 3,
        hunks: 1,
        executedHunks: 1,
        executedLines: 3,
        failingWithCoverage: 1,
        passingWithCoverage: 2,
      },
      suspects: [
        {
          path: BASKET,
          runtime: 'server',
          hunk: [57, 59],
          lines: [[57, 59]],
          granularity: 'lines',
          failing: 1,
          passing: 1,
          score: 0.707,
        },
      ],
    });
  });

  test('keeps the answer for the same execution and range', async () => {
    const id = await executionId(2, 'updates the quantity');
    const first = await suspectLinesForExecution(db as never, id);
    changes = changed();
    expect(await suspectLinesForExecution(db as never, id)).toEqual(first);
    expect(fetched).toEqual([]);
  });

  test('not-failing, no-coverage, and null for an unknown execution', async () => {
    expect(await suspectLinesForExecution(db as never, await executionId(2, 'checks out'))).toMatchObject({
      available: false,
      reason: 'not-failing',
      suspects: [],
    });
    expect(await suspectLinesForExecution(db as never, await executionId(2, 'fails without coverage'))).toMatchObject({
      available: false,
      reason: 'no-coverage',
    });
    expect(await suspectLinesForExecution(db as never, 999_999)).toBeNull();
    expect(fetched).toEqual([]);
  });

  test('no-baseline when no green run came before', async () => {
    const answer = await suspectLinesForExecution(db as never, await executionId(3, 'updates the quantity'));
    expect(answer).toMatchObject({ available: false, reason: 'no-baseline' });
    expect(fetched).toEqual([]);
  });

  test('no-changes when the run tested the green run’s commit', async () => {
    const answer = await suspectLinesForExecution(db as never, await executionId(4, 'updates the quantity'));
    expect(answer).toMatchObject({ available: false, reason: 'no-changes', range: { from: GREEN, to: GREEN } });
  });

  test('no-scm, never an error, when the provider fails or is missing, and the failure is kept a minute', async () => {
    scmError = new Error('rate limited');
    const id = await executionId(2, 'removes an item');
    expect(await suspectLinesForExecution(db as never, id)).toMatchObject({
      available: false,
      reason: 'no-scm',
      range: { from: GREEN, to: HEAD },
    });
    scmError = null;
    expect(await suspectLinesForExecution(db as never, id)).toMatchObject({ reason: 'no-scm' });
    expect(fetched).toHaveLength(1);
  });
});

describe('suspectLinesForCluster', () => {
  test('reads the newest run with failing coverage, every failing execution of the cluster in it', async () => {
    providerAvailable = true;
    const answer = await suspectLinesForCluster(db as never, 1);
    expect(answer).toMatchObject({ available: true, runId: 2, range: { from: GREEN, to: HEAD } });
    expect(answer.summary).toMatchObject({ failingWithCoverage: 2, passingWithCoverage: 2, executedLines: 3 });
    // One failing execution ran 57-59, the other 57 only: both executed the hunk.
    expect(answer.suspects).toEqual([
      expect.objectContaining({ lines: [[57, 59]], failing: 2, passing: 1, score: 0.816 }),
    ]);
  });

  test('no-coverage, with no run, when no failing execution of the cluster recorded coverage', async () => {
    expect(await suspectLinesForCluster(db as never, 2)).toMatchObject({
      available: false,
      reason: 'no-coverage',
      runId: null,
    });
  });

  test('no-scm when the project has no provider for the repository', async () => {
    providerAvailable = false;
    // A range no other test of this file keeps an answer for.
    await db
      .update(schema.testRuns)
      .set({ metadata: { scm: { commit: LATER, remoteUrl: REMOTE } } })
      .where(eq(schema.testRuns.id, 2));
    try {
      expect(await suspectLinesForCluster(db as never, 1)).toMatchObject({
        available: false,
        reason: 'no-scm',
        runId: 2,
        range: { from: GREEN, to: LATER },
      });
    } finally {
      await db
        .update(schema.testRuns)
        .set({ metadata: { scm: { commit: HEAD, remoteUrl: REMOTE, branch: 'main' } } })
        .where(eq(schema.testRuns.id, 2));
    }
  });

  test('no-changes when the range changes no line on the head side', async () => {
    changes = changed({ filename: 'src/Old.cs', status: 'removed', patch: '@@ -1,2 +0,0 @@\n-a\n-b' });
    const answer = await clusterSuspectLinesForChanges(db as never, 1, changes, { from: 'e'.repeat(40), to: HEAD });
    expect(answer).toMatchObject({ available: false, reason: 'no-changes', runId: 2 });
  });

  test('no-scm when the provider left out the patches of the changed files', async () => {
    const unread = changed({ filename: BASKET }, { filename: 'assets/logo.png', status: 'modified' });
    unread.files[1]!.additions = 0;
    unread.files[1]!.deletions = 0;
    const answer = await clusterSuspectLinesForChanges(db as never, 1, unread, { from: 'e'.repeat(40), to: HEAD });
    expect(answer).toMatchObject({ available: false, reason: 'no-scm', runId: 2 });
    const binaryOnly = changed({ filename: 'assets/logo.png' });
    binaryOnly.files[0]!.additions = 0;
    binaryOnly.files[0]!.deletions = 0;
    expect(
      await clusterSuspectLinesForChanges(db as never, 1, binaryOnly, { from: 'e'.repeat(40), to: HEAD }),
    ).toMatchObject({ available: false, reason: 'no-changes' });
  });

  test('joins changes already fetched when the coverage run tested their head commit', async () => {
    const pinned = { from: 'f'.repeat(40), to: HEAD };
    const answer = await clusterSuspectLinesForChanges(db as never, 1, changes!, pinned);
    expect(fetched).toEqual([]);
    expect(answer).toMatchObject({ available: true, range: pinned, runId: 2, summary: { executedHunks: 1 } });
  });

  test('falls back to the cluster’s own range when the changes end at another commit', async () => {
    const answer = await clusterSuspectLinesForChanges(db as never, 1, changed(), { from: GREEN, to: LATER });
    expect(answer).toMatchObject({ available: true, range: { from: GREEN, to: HEAD }, runId: 2 });
  });
});

describe('getExecutionsCoverage', () => {
  test('reads several executions at once, with ranges only for the files asked for', async () => {
    const ids = [await executionId(2, 'checks out'), await executionId(2, 'signs in')];
    const coverage = await getExecutionsCoverage(db as never, ids, { rangesFor: ['Services/BasketService.cs'] });
    expect(coverage.get(ids[0]!)).toEqual({
      v: 1,
      files: [
        { path: BASKET, runtime: 'server', blob: BLOB, functions: [[40, 90]], lines: [[54, 62]] },
        { path: LAYOUT, runtime: 'server' },
      ],
    });
    expect(coverage.get(ids[1]!)).toEqual({ v: 1, files: [] });
  });
});

describe('the fix plan', () => {
  test('carries the top suspect lines, in JSON and Markdown', async () => {
    const plan = await withFixPlanSuspectLines(db as never, 1, { suspectLines: null } as never);
    const suspectLines = (plan as { suspectLines: { available: boolean; suspects: unknown[] } }).suspectLines;
    expect(suspectLines).toMatchObject({ available: true, runId: 2 });
    expect(suspectLines.suspects).toHaveLength(1);
    const markdown = fixPlanToMarkdown({
      cluster: {
        id: 1,
        title: null,
        signature: 'Error',
        errorType: null,
        status: 'open',
        occurrences: 2,
        fixVerification: null,
      },
      diagnosis: null,
      edits: [],
      failingTests: [],
      ownership: { owner: null, source: null },
      verify: { command: 'npx playwright test', expectation: '', commitTrailer: '' },
      reproduce: { steps: [], env: [], notes: [] },
      bisect: { available: false, reason: 'no range' },
      bisectedCommit: null,
      fixedBefore: [],
      issue: null,
      ...(plan as object),
    } as never);
    expect(markdown).toContain('## Suspect lines');
    expect(markdown).toContain(
      `- \`${BASKET}\` 57-59 (server): executed lines, 2 failing tests, 1 passing test, score 0.82`,
    );
  });
});

describe('the AI diagnosis context', () => {
  test('lists the changed lines the failing tests executed, and puts their files’ patches first', async () => {
    changes = changed({ filename: NOISE, patch: bigPatch(400) }, { filename: BASKET, patch: BASKET_PATCH });
    const context = await buildDiagnosisContext(db as never, { kind: 'cluster', clusterId: 1 });
    const suspects = context.sections.find((s) => s.id === 'suspectLines');
    expect(suspects?.markdown).toContain('## Changed Lines the Failing Tests Executed');
    expect(suspects?.markdown).toContain(`- \`${BASKET}\` 57-59 (server): executed lines`);
    expect(context.coverage.suspectLines).toEqual({ suspects: 1, changedLines: 403, executedLines: 3 });

    const diff = context.sections.find((s) => s.id === 'scmInvestigation')!.markdown;
    expect(diff).toContain('## What Changed Since Last Green Run');
    expect(diff).toContain('## Changed Files Since Last Green Run');
    const basketPatch = diff.indexOf(`--- ${BASKET}`);
    const noisePatch = diff.indexOf(`--- ${NOISE}`);
    expect(basketPatch).toBeGreaterThan(-1);
    expect(noisePatch).toBeGreaterThan(basketPatch);
    expect(diff).toContain('item.AddQuantity(quantity)');
    expect(context.text).toContain(
      '- [suspectLines] Changed lines the failing tests executed (suspect lines): present',
    );
  });

  test('says why the section is absent when the cluster recorded no coverage', async () => {
    const context = await buildDiagnosisContext(db as never, { kind: 'cluster', clusterId: 2 });
    expect(context.sections.some((s) => s.id === 'suspectLines')).toBe(false);
    expect(context.coverage.suspectLines).toBeNull();
    expect(context.text).toContain('absent (the failing tests recorded no coverage)');
  });
});
