import { describe, test, expect } from 'vitest';
import {
  buildChangeCoverageStatus,
  buildCommitStatus,
  buildGateStatus,
  buildPrComment,
  isQuietRun,
  DEFAULT_PR_FEEDBACK,
  PR_COMMENT_MARKER,
  PR_EXCERPT_MAX,
  renderChangeCoverage,
  resolvePrFeedbackSettings,
  type PrChangeCoverage,
  type PrFailureEntry,
  type PrSummaryInput,
} from '#shared/pr-feedback';
import { errorExcerpt } from '#shared/notification-events';

function entry(overrides: Partial<PrFailureEntry> = {}): PrFailureEntry {
  return {
    title: 'checkout applies the discount',
    filePath: 'tests/checkout.spec.ts',
    errorExcerpt: 'TimeoutError: locator.click: Timeout 30000ms exceeded',
    executionId: 901,
    ...overrides,
  };
}

function summary(overrides: Partial<PrSummaryInput> = {}): PrSummaryInput {
  return {
    runId: 42,
    runUrl: 'https://piwi.example.com/test-runs/42',
    projectName: 'checkout',
    status: 'passed',
    totalTests: 120,
    passedTests: 120,
    failedTests: 0,
    flakyTests: 0,
    durationMs: 65_000,
    newRegressions: [],
    preExisting: [],
    flaky: [],
    newClusters: [],
    fixedClusters: [],
    wastedMinutes: null,
    hasBaseline: true,
    ...overrides,
  };
}

describe('resolvePrFeedbackSettings', () => {
  test('defaults to off — posting to a pull request needs an explicit opt-in', () => {
    expect(DEFAULT_PR_FEEDBACK.enabled).toBe(false);
    expect(resolvePrFeedbackSettings(undefined).enabled).toBe(false);
    expect(resolvePrFeedbackSettings({}).enabled).toBe(false);
  });

  test('only an exact true enables it', () => {
    expect(resolvePrFeedbackSettings({ enabled: 'yes' as unknown as boolean }).enabled).toBe(false);
    expect(resolvePrFeedbackSettings({ enabled: true }).enabled).toBe(true);
  });

  test('comment and status default on, onlyOnFailure defaults off', () => {
    const resolved = resolvePrFeedbackSettings({ enabled: true });
    expect(resolved).toMatchObject({ comment: true, status: true, onlyOnFailure: false });
  });

  test('falls back to the default status context when blank', () => {
    expect(resolvePrFeedbackSettings({ statusContext: '   ' }).statusContext).toBe(DEFAULT_PR_FEEDBACK.statusContext);
  });

  test('trims and caps the status context', () => {
    expect(resolvePrFeedbackSettings({ statusContext: '  ci/piwi  ' }).statusContext).toBe('ci/piwi');
    expect(resolvePrFeedbackSettings({ statusContext: 'x'.repeat(200) }).statusContext).toHaveLength(80);
  });
});

describe('buildPrComment', () => {
  test('tells the reader to remove test.fail() from the spec of a bug that looks fixed', () => {
    const body = buildPrComment(
      summary({
        status: 'failed',
        failedTests: 1,
        looksFixed: [
          { title: 'bug: coupon not applied', filePath: 'tests/bugs/coupon.spec.ts', executionId: 7, bugId: 37 },
        ],
      }),
    );
    expect(body).toContain('#### 🐞 Looks fixed (1)');
    expect(body).toContain(
      '[the spec](https://piwi.example.com/test-run-cases/7) of bug #37 now passes: remove `test.fail()` in `tests/bugs/coupon.spec.ts`',
    );
  });

  test('starts with the marker so the comment can be found and edited later', () => {
    expect(buildPrComment(summary()).startsWith(PR_COMMENT_MARKER)).toBe(true);
  });

  test('says so plainly when nothing failed', () => {
    const body = buildPrComment(summary());
    expect(body).toContain('✅');
    expect(body).toContain('No failures.');
  });

  test('names the selection when the run came from one', () => {
    const body = buildPrComment(summary({ selection: { key: 'smoke', testCount: 42 } }));
    expect(body).toContain('`smoke`');
    expect(body).toContain('42 tests');
  });

  test('says nothing about selections on an ordinary run', () => {
    expect(buildPrComment(summary())).not.toContain('Selection');
  });

  test('flags a lock held on two shards at once', () => {
    const body = buildPrComment(summary({ splitLocks: ['database'] }));
    expect(body).toContain('`database`');
    expect(body).toContain('two shards at once');
    expect(body).toContain('piwi run --shard');
  });

  test('says nothing about split locks when none crossed shards', () => {
    expect(buildPrComment(summary())).not.toContain('two shards at once');
  });

  test('separates new failures from pre-existing ones', () => {
    const body = buildPrComment(
      summary({
        status: 'failed',
        failedTests: 2,
        passedTests: 118,
        newRegressions: [entry({ title: 'broke by this change' })],
        preExisting: [entry({ title: 'already broken', executionId: 902 })],
      }),
    );
    expect(body).toContain('New failures (1)');
    expect(body).toContain('Pre-existing failures (1)');
    // The reviewer's own damage must come first.
    expect(body.indexOf('New failures')).toBeLessThan(body.indexOf('Pre-existing failures'));
  });

  test('links each failure to its execution on the dashboard origin', () => {
    const body = buildPrComment(summary({ failedTests: 1, newRegressions: [entry()] }));
    expect(body).toContain('https://piwi.example.com/test-run-cases/901');
  });

  test('surfaces the suggested locator, which is the actionable part', () => {
    const body = buildPrComment(
      summary({
        failedTests: 1,
        newRegressions: [entry({ suggestedLocator: "getByRole('button', { name: 'Save' })" })],
      }),
    );
    expect(body).toContain("💡 Try `getByRole('button', { name: 'Save' })` instead.");
  });

  test('shows owner and tags so a reader knows who to route it to', () => {
    const body = buildPrComment(
      summary({ failedTests: 1, newRegressions: [entry({ owner: '@checkout-team', tags: ['critical', 'smoke'] })] }),
    );
    expect(body).toContain('@checkout-team');
    expect(body).toContain('`@critical`');
  });

  test('truncates a long failure list rather than flooding the pull request', () => {
    const many = Array.from({ length: 9 }, (_, i) => entry({ title: `test ${i}`, executionId: i }));
    const body = buildPrComment(summary({ failedTests: 9, newRegressions: many }));
    expect(body).toContain('…and 4 more');
  });

  test('escapes a pipe so a test title cannot break the layout', () => {
    const body = buildPrComment(summary({ failedTests: 1, newRegressions: [entry({ title: 'a | b' })] }));
    expect(body).toContain('a \\| b');
  });

  test('quotes a timeout with where Playwright was waiting, the way notifications do', () => {
    const raw = `TimeoutError: locator.click: Timeout 30000ms exceeded.
Call log:
  - waiting for getByRole('button', { name: 'Pay' })
  - locator resolved to <button disabled>Pay</button>

    at tests/checkout.spec.ts:12:40`;
    const excerpt = errorExcerpt(raw, PR_EXCERPT_MAX)!;
    const body = buildPrComment(summary({ failedTests: 1, newRegressions: [entry({ errorExcerpt: excerpt })] }));
    expect(body).toContain(
      'TimeoutError: locator.click: Timeout 30000ms exceeded. locator resolved to <button disabled>Pay</button>',
    );
    expect(body).not.toContain('Call log');
    expect(body).not.toContain('checkout.spec.ts:12:40');
  });

  test('keeps a pull-request excerpt within its own cap', () => {
    const excerpt = errorExcerpt(`Error: ${'x'.repeat(500)}`, PR_EXCERPT_MAX)!;
    expect(excerpt.length).toBe(PR_EXCERPT_MAX + 1);
    expect(excerpt.endsWith('…')).toBe(true);
  });

  test('flattens a multi-line error excerpt onto one line', () => {
    const body = buildPrComment(
      summary({ failedTests: 1, newRegressions: [entry({ errorExcerpt: 'line one\nline two' })] }),
    );
    expect(body).toContain('line one line two');
  });

  test('lists new failure clusters with their case counts', () => {
    const body = buildPrComment(
      summary({ failedTests: 3, newClusters: [{ id: 5, signature: 'Timeout waiting for selector', caseCount: 3 }] }),
    );
    expect(body).toContain('New failure clusters (1)');
    expect(body).toContain('https://piwi.example.com/failure-clusters/5');
    expect(body).toContain('3 tests');
  });

  test('explains why failures were not split when there is no baseline', () => {
    const body = buildPrComment(summary({ status: 'failed', failedTests: 2, hasBaseline: false }));
    expect(body).toContain('No previous green run');
  });

  test('omits the baseline caveat on a green run', () => {
    expect(buildPrComment(summary({ hasBaseline: false }))).not.toContain('No previous green run');
  });

  test('reports wasted CI minutes only when they are worth a line', () => {
    expect(buildPrComment(summary({ wastedMinutes: 4.2 }))).toContain('4.2 CI minutes');
    expect(buildPrComment(summary({ wastedMinutes: 0.3 }))).not.toContain('CI minutes');
    expect(buildPrComment(summary({ wastedMinutes: null }))).not.toContain('CI minutes');
  });

  test('degrades to plain titles when the run URL has no parseable origin', () => {
    const body = buildPrComment(
      summary({ runUrl: 'not-a-url', failedTests: 1, newRegressions: [entry({ title: 'plain' })] }),
    );
    // The failure entry keeps its title but loses the deep link, since there is
    // no origin to build one from.
    expect(body).toContain('- plain — `tests/checkout.spec.ts`');
    expect(body).not.toContain('test-run-cases');
  });
});

describe('buildPrComment — fixed clusters', () => {
  test('reports what this change closed, which is the answer to "did my fix work?"', () => {
    const body = buildPrComment(
      summary({
        fixedClusters: [
          {
            id: 9,
            label: 'Timeout waiting for #pay',
            testCount: 4,
            verification: 'stopped-failing',
            timeToResolutionMs: 3 * 60 * 60 * 1000,
          },
        ],
      }),
    );
    expect(body).toContain('Fixed by this change (1)');
    expect(body).toContain('https://piwi.example.com/failure-clusters/9');
    expect(body).toContain('4 tests');
    expect(body).toContain('open 3h');
  });

  test('calls out when the change matched the diagnosed file', () => {
    const body = buildPrComment(
      summary({
        fixedClusters: [
          { id: 9, label: 'Timeout', testCount: 1, verification: 'diagnosis-verified', timeToResolutionMs: null },
        ],
      }),
    );
    expect(body).toContain('matches the diagnosed change');
  });

  test('names the auto-heal pull request that landed the fix', () => {
    const body = buildPrComment(
      summary({
        fixedClusters: [
          {
            id: 9,
            label: 'Locator',
            testCount: 1,
            verification: 'stopped-failing',
            timeToResolutionMs: null,
            healPr: { number: 12, url: 'https://github.com/acme/app/pull/12' },
          },
        ],
      }),
    );
    expect(body).toContain('landed by auto-heal [#12](https://github.com/acme/app/pull/12)');
  });

  test('says nothing when no cluster was closed', () => {
    expect(buildPrComment(summary())).not.toContain('Fixed by this change');
    expect(buildPrComment(summary({ fixedClusters: [] }))).not.toContain('Fixed by this change');
  });

  // Several call sites build this shape; a summary without the field must
  // render rather than throw.
  test('tolerates a summary built without the field', () => {
    const withoutField = summary();
    delete (withoutField as { fixedClusters?: unknown }).fixedClusters;
    expect(() => buildPrComment(withoutField)).not.toThrow();
  });
});

describe('buildCommitStatus', () => {
  test('is a success when nothing failed', () => {
    expect(buildCommitStatus(summary(), 'piwi/tests')).toMatchObject({
      state: 'success',
      context: 'piwi/tests',
      targetUrl: 'https://piwi.example.com/test-runs/42',
    });
  });

  test('is a failure when tests failed', () => {
    expect(buildCommitStatus(summary({ failedTests: 2, passedTests: 118 }), 'piwi/tests').state).toBe('failure');
  });

  test('summarizes counts, new failures and flakes in the description', () => {
    const status = buildCommitStatus(
      summary({ failedTests: 2, passedTests: 118, flakyTests: 3, newRegressions: [entry()] }),
      'piwi/tests',
    );
    expect(status.description).toBe('118/120 passed, 1 new, 3 flaky');
  });

  test('stays green when only quarantined tests failed, and says how many', () => {
    const status = buildCommitStatus(
      summary({ failedTests: 2, passedTests: 118, quarantinedFailures: 2 }),
      'piwi/tests',
    );
    expect(status.state).toBe('success');
    expect(status.description).toBe('118/120 passed, 2 quarantined');
  });

  test('is a failure when a test outside quarantine failed too', () => {
    const status = buildCommitStatus(
      summary({ failedTests: 3, passedTests: 117, quarantinedFailures: 2 }),
      'piwi/tests',
    );
    expect(status.state).toBe('failure');
    expect(status.description).toBe('117/120 passed, 2 quarantined');
  });

  test('the strict project setting turns quarantined failures red', () => {
    const status = buildCommitStatus(
      summary({ failedTests: 2, passedTests: 118, quarantinedFailures: 2, quarantineFailsStatus: true }),
      'piwi/tests',
    );
    expect(status.state).toBe('failure');
    expect(status.description).toBe('118/120 passed, 2 quarantined');
  });

  test('caps the description at what GitHub accepts', () => {
    const status = buildCommitStatus(summary({ projectName: 'x'.repeat(500) }), 'piwi/tests');
    expect(status.description.length).toBeLessThanOrEqual(140);
  });
});

describe('isQuietRun', () => {
  const onlyOnFailure = { onlyOnFailure: true };

  test('keeps the comment off a run whose only failures are quarantined', () => {
    expect(isQuietRun(onlyOnFailure, summary({ failedTests: 2, passedTests: 118, quarantinedFailures: 2 }))).toBe(true);
  });

  test('posts it when the project counts quarantined failures', () => {
    const run = summary({ failedTests: 2, passedTests: 118, quarantinedFailures: 2, quarantineFailsStatus: true });
    expect(isQuietRun(onlyOnFailure, run)).toBe(false);
  });

  test('posts it when a test outside quarantine failed too', () => {
    expect(isQuietRun(onlyOnFailure, summary({ failedTests: 3, passedTests: 117, quarantinedFailures: 2 }))).toBe(
      false,
    );
  });

  test('posts every run when only-on-failure is off', () => {
    expect(isQuietRun({ onlyOnFailure: false }, summary())).toBe(false);
  });
});

describe('buildGateStatus', () => {
  const url = 'https://piwi.example.com/test-runs/42';

  test('is a success when the policy passed', () => {
    expect(buildGateStatus({ verdict: 'passed', violations: [] }, url, 'piwi/tests/gate')).toEqual({
      state: 'success',
      description: 'Gate policy satisfied',
      targetUrl: url,
      context: 'piwi/tests/gate',
    });
  });

  test('is a failure naming the first violation and how many there are', () => {
    const status = buildGateStatus(
      { verdict: 'failed', violations: [{ message: '2 failed (limit 0)' }, { message: '1 new cluster' }] },
      url,
      'piwi/tests/gate',
    );
    expect(status).toMatchObject({ state: 'failure', description: '2 violations: 2 failed (limit 0)' });
  });

  test('caps the description at what GitHub accepts', () => {
    const status = buildGateStatus({ verdict: 'failed', violations: [{ message: 'x'.repeat(500) }] }, url, 'g');
    expect(status.description.length).toBeLessThanOrEqual(140);
  });
});

describe('buildPrComment — failure headline', () => {
  test('leads each failure with its headline in bold, markdown-escaped, before the raw excerpt', () => {
    const body = buildPrComment(
      summary({
        failedTests: 1,
        newRegressions: [
          entry({
            headline: "Expected 26 rows, found 51 — getByRole('row') toHaveCount",
            errorExcerpt: 'Error: expect(locator).toHaveCount(expected) failed',
          }),
        ],
      }),
    );
    const headlineAt = body.indexOf("  **Expected 26 rows, found 51 — getByRole('row') toHaveCount**");
    const excerptAt = body.indexOf('  ```\n  Error: expect(locator).toHaveCount(expected) failed\n  ```');
    expect(headlineAt).toBeGreaterThan(-1);
    expect(excerptAt).toBeGreaterThan(headlineAt);
  });

  test('escapes markdown inside a headline and omits the line without one', () => {
    const escaped = buildPrComment(
      summary({ failedTests: 1, newRegressions: [entry({ headline: 'Expected `a_b`, got *c* — toBe' })] }),
    );
    expect(escaped).toContain('**Expected \\`a\\_b\\`, got \\*c\\* — toBe**');
    const plain = buildPrComment(summary({ failedTests: 1, newRegressions: [entry({ headline: null })] }));
    expect(plain).not.toContain('**Expected');
  });
});

describe('change coverage section', () => {
  function coverage(overrides: Partial<PrChangeCoverage> = {}): PrChangeCoverage {
    return {
      fileReach: true,
      totalFiles: 7,
      uncoveredFiles: 2,
      reachedFiles: 5,
      notCounted: { notObservable: 0, outOfScope: 0, deleted: 0 },
      ticketCount: 1,
      windowRuns: 30,
      tickets: [
        {
          ticket: 'PROJ-418',
          files: [
            {
              filePath: 'server/api/orders/[id].patch.ts',
              additions: 41,
              deletions: 3,
              reach: 'unreached',
              draftTitle: 'a scenario that exercises [id].patch.ts',
            },
            {
              filePath: 'components/OrderRow.vue',
              additions: 8,
              deletions: 2,
              reach: 'reached',
            },
          ],
        },
      ],
      ...overrides,
    };
  }

  test('lists uncovered files per ticket with observed-reach wording', () => {
    const section = renderChangeCoverage(coverage());
    expect(section).toContain('🟣 Uncovered changes · 2 of 7 files · 1 ticket');
    expect(section).toContain('Observed reach, not instrumented coverage');
    expect(section).toContain('**PROJ-418**');
    expect(section).toContain('`server/api/orders/[id].patch.ts` · changed (+41 −3) · 0 tests in 30 runs');
    // A reached file is not listed as uncovered, and the comment claims no gate it does not know.
    expect(section).not.toContain('OrderRow.vue');
    expect(section).toContain('5 files reached.');
    expect(section).not.toContain('Gate');
  });

  test('reports a clean diff without listing files', () => {
    const section = renderChangeCoverage(coverage({ uncoveredFiles: 0, reachedFiles: 7, tickets: [] }));
    expect(section).toContain('All 7 changed files are reached.');
  });

  test('a backtick in a file path cannot break out of the code span', () => {
    const section = renderChangeCoverage(
      coverage({
        totalFiles: 1,
        uncoveredFiles: 1,
        reachedFiles: 0,
        ticketCount: 0,
        tickets: [
          {
            ticket: null,
            files: [
              {
                filePath: 'src/`rm -rf`/x.ts',
                additions: 1,
                deletions: 0,
                reach: 'unreached',
              },
            ],
          },
        ],
      }),
    )!;
    // The path is fenced by a two-backtick run and padded, so the inner single
    // backticks render literally instead of closing the span and injecting markdown.
    expect(section).toContain('`` src/`rm -rf`/x.ts ``');
  });

  test('notes when the diff file list was truncated', () => {
    const section = renderChangeCoverage(coverage({ filesTruncated: true }))!;
    expect(section).toContain('more files changed than are counted here');
  });

  test('caps the uncovered list across ticket groups and reports the remainder', () => {
    const files = Array.from({ length: 40 }, (_, i) => ({
      filePath: `src/file-${i}.ts`,
      additions: 1,
      deletions: 0,
      reach: 'unreached' as const,
    }));
    const section = renderChangeCoverage(
      coverage({
        totalFiles: 40,
        uncoveredFiles: 40,
        reachedFiles: 0,
        ticketCount: 1,
        tickets: [{ ticket: 'PROJ-1', files }],
      }),
    )!;
    const listed = (section.match(/ · changed \(\+/g) ?? []).length;
    expect(listed).toBe(10);
    expect(section).toContain('…and 30 more');
  });

  test('separates a file reached only in history from the uncovered list', () => {
    const section = renderChangeCoverage(
      coverage({
        totalFiles: 2,
        uncoveredFiles: 1,
        reachedFiles: 1,
        ticketCount: 1,
        tickets: [
          {
            ticket: 'PROJ-1',
            files: [
              {
                filePath: 'src/new.ts',
                additions: 5,
                deletions: 0,
                reach: 'unreached',
                draftTitle: 'exercise new.ts',
              },
              {
                filePath: 'src/old.ts',
                additions: 2,
                deletions: 0,
                reach: 'reached-earlier',
              },
            ],
          },
        ],
      }),
    )!;
    expect(section).toContain('`src/new.ts`');
    // Reached only in history — not in the uncovered list, but its own line.
    expect(section).not.toContain('`src/old.ts`');
    expect(section).toContain('1 file reached only in the last 30 runs, not this run.');
  });

  test('embeds into the comment and drives an informational commit status', () => {
    const body = buildPrComment(summary({ changeCoverage: coverage() }));
    expect(body).toContain('Uncovered changes');

    const status = buildChangeCoverageStatus(
      coverage(),
      'https://piwi.example.com/test-runs/42',
      'piwi/tests/change-coverage',
    );
    expect(status.state).toBe('success');
    expect(status.description).toBe('2 of 7 changed files no test reached');
    expect(status.context).toBe('piwi/tests/change-coverage');
  });

  test('the status keeps the patch coverage when the file list is withheld', () => {
    const patchCoverage = {
      commit: 'c0ffee1234',
      changedLines: 4,
      executedLines: 3,
      unitLines: 3,
      e2eLines: 0,
      undeterminedLines: 0,
      suites: [],
      areas: [],
      files: 1,
    };
    const status = buildChangeCoverageStatus(
      coverage({ fileReach: false, patchCoverage }),
      'https://x',
      'piwi/tests/change-coverage',
    );
    expect(status.description).toBe('patch coverage 75%');
  });
});

describe('new leaks', () => {
  test('lists each leak the base branch never showed, with the line that opened it', () => {
    const body = buildPrComment(
      summary({
        newLeaks: {
          baseBranch: 'main',
          leaks: [
            {
              verdict: 'leaked',
              kind: 'context',
              where: 'tests/cart.spec.ts:12',
              site: 'tests/cart.spec.ts:12',
              scope: 'test',
              tests: 4,
              count: 4,
              heldMs: 41_200,
              untilWorkerEnd: true,
            },
          ],
        },
      }),
    );
    expect(body).toContain('#### 🟠 Left open by this change (1)\n\nNever seen on `main`.');
    expect(body).toContain(
      '- **Leaked context** · `tests/cart.spec.ts:12` · 4 contexts · 4 tests · open until the worker shut down (41.2 s past its test)',
    );
  });

  test('adds nothing when the branch introduced no leak', () => {
    expect(buildPrComment(summary({ newLeaks: { baseBranch: 'main', leaks: [] } }))).not.toContain('Left open');
  });
});
