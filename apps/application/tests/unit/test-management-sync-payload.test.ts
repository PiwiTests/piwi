import { describe, expect, test } from 'vitest';
import {
  buildSyncPayload,
  MAX_PAYLOAD_UNKNOWN_KEYS,
  MAX_RUN_NAME_LENGTH,
  renderRunName,
  type SyncAttemptRow,
  type SyncRunFacts,
} from '#shared/integrations/test-management-sync';
import {
  DEFAULT_RUN_NAME_TEMPLATE,
  DEFAULT_TEST_MANAGEMENT_OPTIONS,
  DEFAULT_TEST_MANAGEMENT_STATUSES,
  emptyTestManagementBinding,
} from '#shared/integrations/test-management-binding';

const run: SyncRunFacts = {
  runId: 123,
  url: 'https://piwi.example.com/test-runs/123',
  branch: 'main',
  environment: 'staging',
  commit: 'abcdef0123456789',
  startedAt: Date.parse('2026-11-11T08:30:00Z'),
  ciBuild: '4711',
};

function row(testCaseId: number, status: string, extra: Partial<SyncAttemptRow> = {}): SyncAttemptRow {
  return {
    testCaseId,
    browserName: 'chromium',
    repeatEachIndex: 0,
    retries: 0,
    status,
    passedAfterFailure: null,
    tags: [],
    externalId: null,
    ...extra,
  };
}

const known = new Set(['SHOP-T1', 'SHOP-T2', 'SHOP-T3', 'SHOP-T4']);

function build(rows: SyncAttemptRow[], binding: Partial<ReturnType<typeof emptyTestManagementBinding>> = {}) {
  return buildSyncPayload({
    run,
    rows,
    pattern: '^SHOP-T[0-9]+$',
    binding: { ...emptyTestManagementBinding(), providerProjectKey: 'SHOP', ...binding },
    knownKeys: known,
    tagsTruncated: 0,
  });
}

describe('the results of a sync', () => {
  test('one result per key, named by the binding’s statuses', () => {
    const payload = build([
      row(1, 'passed', { tags: ['@SHOP-T1'] }),
      row(2, 'failed', { tags: ['@SHOP-T2'] }),
      row(3, 'timedOut', { tags: ['@SHOP-T3'] }),
    ]);
    expect(payload.results).toEqual([
      { key: 'SHOP-T1', status: 'Pass' },
      { key: 'SHOP-T2', status: 'Fail' },
      { key: 'SHOP-T3', status: 'Fail' },
    ]);
    expect(payload.counts).toEqual({ passed: 1, failed: 2, flaky: 0, notExecuted: 0 });
  });

  test('a renamed status is sent under its name', () => {
    const statuses = { ...DEFAULT_TEST_MANAGEMENT_STATUSES, pass: 'Passed', fail: 'Failed' };
    const payload = build([row(1, 'passed', { tags: ['@SHOP-T1'] })], { statuses });
    expect(payload.results).toEqual([{ key: 'SHOP-T1', status: 'Passed' }]);
  });

  test('the worst outcome of the tests that cover a key wins', () => {
    const payload = build([
      row(1, 'passed', { tags: ['@SHOP-T1'] }),
      row(2, 'failed', { tags: ['@SHOP-T1'] }),
      row(3, 'passed', { tags: ['@SHOP-T2'] }),
      row(4, 'skipped', { tags: ['@SHOP-T2'] }),
    ]);
    expect(payload.results).toEqual([
      { key: 'SHOP-T1', status: 'Fail' },
      { key: 'SHOP-T2', status: 'Pass' },
    ]);
  });

  test('a test in two browsers counts through its worst browser', () => {
    const payload = build([
      row(1, 'passed', { tags: ['@SHOP-T1'], browserName: 'chromium' }),
      row(1, 'failed', { tags: ['@SHOP-T1'], browserName: 'firefox' }),
    ]);
    expect(payload.results).toEqual([{ key: 'SHOP-T1', status: 'Fail' }]);
  });

  test('a test that covers several keys reports each', () => {
    const payload = build([row(1, 'failed', { tags: ['@SHOP-T1', '@SHOP-T2', '@smoke'] })]);
    expect(payload.results.map((r) => r.key)).toEqual(['SHOP-T1', 'SHOP-T2']);
  });

  test('only the final attempt of a test decides it', () => {
    const payload = build([
      row(1, 'failed', { tags: ['@SHOP-T1'], retries: 0 }),
      row(1, 'passed', { tags: ['@SHOP-T1'], retries: 1, passedAfterFailure: true }),
      row(2, 'failed', { tags: ['@SHOP-T2'], retries: 0 }),
      row(2, 'failed', { tags: ['@SHOP-T2'], retries: 1 }),
    ]);
    expect(payload.results).toEqual([
      { key: 'SHOP-T1', status: 'Pass' },
      { key: 'SHOP-T2', status: 'Fail' },
    ]);
    expect(payload.counts).toMatchObject({ passed: 0, flaky: 1, failed: 1 });
  });

  test.each([
    ['pass', 'Pass'],
    ['fail', 'Fail'],
    ['flaky', 'Flaky'],
  ] as const)('a pass after a retry is reported as %s', (flakyAs, status) => {
    const payload = build(
      [
        row(1, 'failed', { tags: ['@SHOP-T1'], retries: 0 }),
        row(1, 'passed', { tags: ['@SHOP-T1'], retries: 1, passedAfterFailure: true }),
      ],
      {
        options: { ...DEFAULT_TEST_MANAGEMENT_OPTIONS, flakyAs },
        statuses: { ...DEFAULT_TEST_MANAGEMENT_STATUSES, flaky: 'Flaky' },
      },
    );
    expect(payload.results).toEqual([{ key: 'SHOP-T1', status }]);
  });

  test('a flaky test beats a passing one on the same key', () => {
    const payload = build(
      [
        row(1, 'passed', { tags: ['@SHOP-T1'] }),
        row(2, 'failed', { tags: ['@SHOP-T1'], retries: 0 }),
        row(2, 'passed', { tags: ['@SHOP-T1'], retries: 1, passedAfterFailure: true }),
      ],
      {
        options: { ...DEFAULT_TEST_MANAGEMENT_OPTIONS, flakyAs: 'flaky' },
        statuses: { ...DEFAULT_TEST_MANAGEMENT_STATUSES, flaky: 'Flaky' },
      },
    );
    expect(payload.results).toEqual([{ key: 'SHOP-T1', status: 'Flaky' }]);
  });

  test('a key whose tests were all skipped or did not run is left out', () => {
    const payload = build([
      row(1, 'skipped', { tags: ['@SHOP-T1'] }),
      row(2, 'didnotrun', { tags: ['@SHOP-T2'] }),
      row(3, 'passed', { tags: ['@SHOP-T3'] }),
    ]);
    expect(payload.results).toEqual([{ key: 'SHOP-T3', status: 'Pass' }]);
  });

  test('skipped tests are sent as Not Executed when the binding says so', () => {
    const payload = build([row(1, 'skipped', { tags: ['@SHOP-T1'] }), row(2, 'didnotrun', { tags: ['@SHOP-T2'] })], {
      options: { ...DEFAULT_TEST_MANAGEMENT_OPTIONS, skippedAs: 'notExecuted' },
    });
    expect(payload.results).toEqual([
      { key: 'SHOP-T1', status: 'Not Executed' },
      { key: 'SHOP-T2', status: 'Not Executed' },
    ]);
    expect(payload.counts.notExecuted).toBe(2);
  });

  test('no result is made up for a test the run never reached: nothing but a known key is sent', () => {
    const payload = build([row(1, 'interrupted', { tags: ['@SHOP-T1'] })]);
    expect(payload.results).toEqual([]);
  });

  test('the key of an external ID counts only when the binding reads it', () => {
    const rows = [row(1, 'passed', { externalId: 'SHOP-T1' })];
    expect(build(rows).results).toEqual([]);
    const payload = build(rows, { keySources: { tags: false, externalId: true } });
    expect(payload.results).toEqual([{ key: 'SHOP-T1', status: 'Pass' }]);
  });

  test('a tag of another pattern is no key', () => {
    expect(build([row(1, 'passed', { tags: ['@smoke', '@SHOP-1234'] })]).results).toEqual([]);
  });

  test('the tags of every attempt of a test count', () => {
    const payload = build([
      row(1, 'failed', { tags: ['@SHOP-T1'], retries: 0 }),
      row(1, 'failed', { tags: [], retries: 1 }),
    ]);
    expect(payload.results).toEqual([{ key: 'SHOP-T1', status: 'Fail' }]);
  });
});

describe('keys the catalog does not hold', () => {
  test('are listed, never sent', () => {
    const payload = build([
      row(1, 'passed', { tags: ['@SHOP-T1'] }),
      row(2, 'failed', { tags: ['@SHOP-T999'] }),
      row(3, 'skipped', { tags: ['@SHOP-T998'] }),
    ]);
    expect(payload.results).toEqual([{ key: 'SHOP-T1', status: 'Pass' }]);
    expect(payload.unknownKeys).toEqual(['SHOP-T998', 'SHOP-T999']);
    expect(payload.unknownKeyCount).toBe(2);
  });

  test('are listed up to a cap, and counted', () => {
    const rows = Array.from({ length: 30 }, (_, i) => row(i + 1, 'passed', { tags: [`@SHOP-T${1000 + i}`] }));
    const payload = build(rows);
    expect(payload.unknownKeys).toHaveLength(MAX_PAYLOAD_UNKNOWN_KEYS);
    expect(payload.unknownKeyCount).toBe(30);
  });

  test('tests with no key are counted once each, whatever their browsers', () => {
    const payload = build([
      row(1, 'passed'),
      row(1, 'passed', { browserName: 'firefox' }),
      row(2, 'passed', { tags: ['@SHOP-T1'] }),
      row(3, 'failed'),
    ]);
    expect(payload.unmappedCount).toBe(2);
  });
});

describe('the test run of a sync', () => {
  test('is named from the template with the run’s facts', () => {
    expect(build([]).run.name).toBe('Automation · main · staging · Piwi #123');
    expect(renderRunName('{branch}/{commit} {date} build {ciBuild} #{runId}', run)).toBe(
      'main/abcdef0 2026-11-11 build 4711 #123',
    );
  });

  test('says "-" for a fact the run does not carry', () => {
    const bare = { ...run, branch: null, environment: null, commit: null, startedAt: null, ciBuild: null };
    expect(renderRunName('{branch} {environment} {commit} {date} {ciBuild} #{runId}', bare)).toBe('- - - - - #123');
  });

  test('keeps {runId} when the facts make the name too long', () => {
    const long = { ...run, branch: 'feature/' + 'x'.repeat(300) };
    const name = renderRunName(DEFAULT_RUN_NAME_TEMPLATE, long);
    expect(name.length).toBeLessThanOrEqual(MAX_RUN_NAME_LENGTH);
    expect(name).toMatch(/Piwi #123$/);
  });

  test('keeps {runId} even for a template that is long itself', () => {
    const template = `${'a'.repeat(190)} {branch} {environment} {ciBuild} {runId}`;
    const long = { ...run, branch: 'b'.repeat(200), environment: 'c'.repeat(200), ciBuild: 'd'.repeat(200) };
    const name = renderRunName(template, long);
    expect(name.length).toBeLessThanOrEqual(MAX_RUN_NAME_LENGTH);
    expect(name).toContain('#123');
  });

  test('has a description with the run’s address, branch, commit and what was sent', () => {
    const payload = build([
      row(1, 'passed', { tags: ['@SHOP-T1'] }),
      row(2, 'failed', { tags: ['@SHOP-T2'] }),
      row(3, 'failed', { tags: ['@SHOP-T3'], retries: 0 }),
      row(3, 'passed', { tags: ['@SHOP-T3'], retries: 1, passedAfterFailure: true }),
    ]);
    expect(payload.run.description).toBe(
      [
        'Piwi run #123',
        'https://piwi.example.com/test-runs/123',
        'Branch: main',
        'Commit: abcdef0',
        'Results sent: 3 (1 passed, 1 failed, 1 flaky)',
      ].join('\n'),
    );
  });

  test('leaves out the lines of a fact the run does not carry', () => {
    const payload = buildSyncPayload({
      run: { ...run, url: null, branch: null, commit: null },
      rows: [row(1, 'passed', { tags: ['@SHOP-T1'] })],
      pattern: '^SHOP-T[0-9]+$',
      binding: emptyTestManagementBinding(),
      knownKeys: known,
      tagsTruncated: 0,
    });
    expect(payload.run.description).toBe('Piwi run #123\nResults sent: 1 (1 passed, 0 failed)');
  });

  test('carries the folder and version of the binding when it names them', () => {
    const base = emptyTestManagementBinding();
    const payload = build([], { runPolicy: { ...base.runPolicy, folderId: '42', version: '3.1' } });
    expect(payload.run).toMatchObject({ folderId: '42', version: '3.1' });
    expect(build([]).run).not.toHaveProperty('folderId');
  });

  test('is a dry run exactly when the binding is, and carries the cut tags', () => {
    expect(build([], { dryRun: true }).dryRun).toBe(true);
    expect(build([], { dryRun: false }).dryRun).toBe(false);
    expect(
      buildSyncPayload({
        ...{ run, rows: [], pattern: null, knownKeys: known },
        binding: emptyTestManagementBinding(),
        tagsTruncated: 3,
      }).tagsTruncated,
    ).toBe(3);
  });
});
