import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { formatTagsTruncatedTests } from '@piwitests/core/test-meta';
import * as schema from '../../server/database/schema.sqlite';
import { openTempDb, type TempDb } from './temp-db';
import {
  defaultTestCaseKeyPattern,
  MAX_LISTED_UNKNOWN_KEYS,
  summarizeTestCaseMapping,
  testCaseKeys,
} from '#shared/integrations/test-management-mapping';
import { makeTagKeyMatcher } from '#shared/integrations/tag-keys';
import { testManagementMappingSummary } from '../../shared/handlers/test-management-summary';
import {
  readTestManagementBinding,
  writeTestManagementBinding,
} from '../../server/utils/integrations/test-management/binding';

delete process.env.PIWI_DATABASE_URL;

const test_ = (title: string, tags: string[] = [], externalId: string | null = null) => ({
  title,
  file: 'cart.spec.ts',
  tags,
  externalId,
});
const sources = { tags: true, externalId: false };
const read = new Date('2026-11-09T08:00:00Z');

describe('defaultTestCaseKeyPattern', () => {
  test('is the project key, -T and digits, and is a pattern the tag matcher accepts', () => {
    const matches = makeTagKeyMatcher(defaultTestCaseKeyPattern('SHOP'));
    expect(defaultTestCaseKeyPattern('SHOP')).toBe('^SHOP-T[0-9]+$');
    expect(matches('SHOP-T12')).toBe(true);
    expect(matches('SHOP-12')).toBe(false);
    expect(matches('XSHOP-T12')).toBe(false);
  });

  test('escapes the characters of a key that a pattern reads as syntax', () => {
    const matches = makeTagKeyMatcher(defaultTestCaseKeyPattern('WEB_APP'));
    expect(matches('WEB_APP-T3')).toBe(true);
    expect(matches('WEBXAPP-T3')).toBe(false);
  });
});

describe('testCaseKeys', () => {
  const pattern = '^SHOP-T[0-9]+$';

  test('reads the matching tags, with or without the @, each once', () => {
    expect(
      testCaseKeys({ tags: ['smoke', '@SHOP-T1', 'SHOP-T1', 'SHOP-T2'], externalId: null }, pattern, sources),
    ).toEqual(['SHOP-T1', 'SHOP-T2']);
  });

  test('reads the external ID only when that source is on and the ID matches the pattern', () => {
    const test = { tags: [], externalId: 'SHOP-T7' };
    expect(testCaseKeys(test, pattern, sources)).toEqual([]);
    expect(testCaseKeys(test, pattern, { tags: false, externalId: true })).toEqual(['SHOP-T7']);
    expect(testCaseKeys({ tags: [], externalId: 'TC-7' }, pattern, { tags: false, externalId: true })).toEqual([]);
  });

  test('a key a tag and the external ID both carry counts once', () => {
    expect(
      testCaseKeys({ tags: ['SHOP-T7'], externalId: 'SHOP-T7' }, pattern, { tags: true, externalId: true }),
    ).toEqual(['SHOP-T7']);
  });

  test('reads nothing without a valid pattern', () => {
    expect(testCaseKeys({ tags: ['SHOP-T7'], externalId: null }, null, sources)).toEqual([]);
    expect(testCaseKeys({ tags: ['SHOP-T7'], externalId: null }, 'SHOP-T7', sources)).toEqual([]);
  });
});

describe('summarizeTestCaseMapping', () => {
  const pattern = '^SHOP-T[0-9]+$';
  const tests = [
    test_('adds an item', ['SHOP-T1', 'smoke']),
    test_('removes an item', ['SHOP-T2']),
    test_('pays by card', ['SHOP-T999']),
    test_('pays by card again', ['SHOP-T999']),
    test_('has no key', ['smoke']),
    test_('covers two cases', ['SHOP-T1', 'SHOP-T2']),
  ];

  test('counts mapped tests, tests with no key and the distinct keys', () => {
    const summary = summarizeTestCaseMapping({
      tests,
      pattern,
      keySources: sources,
      catalog: { keys: ['SHOP-T1', 'SHOP-T2', 'SHOP-T3'], fetchedAt: read },
    });
    expect(summary).toMatchObject({
      mappedTests: 5,
      testsWithoutKey: 1,
      keys: ['SHOP-T1', 'SHOP-T2', 'SHOP-T999'],
      catalogRead: true,
      catalogSize: 3,
      catalogFetchedAt: read,
    });
  });

  test('lists a key the catalog does not hold with the titles of its tests, each once', () => {
    const summary = summarizeTestCaseMapping({
      tests: [...tests, test_('pays by card', ['SHOP-T999'])],
      pattern,
      keySources: sources,
      catalog: { keys: ['SHOP-T1', 'SHOP-T2'], fetchedAt: read },
    });
    expect(summary.unknownKeyCount).toBe(1);
    expect(summary.unknownKeys).toEqual([
      { key: 'SHOP-T999', examples: ['pays by card', 'pays by card again'], tests: 3 },
    ]);
  });

  test('keeps three examples per unknown key and twenty unknown keys', () => {
    const many = Array.from({ length: 25 }, (_, index) => test_(`test ${index}`, [`SHOP-T${1000 + index}`]));
    const crowded = Array.from({ length: 5 }, (_, index) => test_(`crowd ${index}`, ['SHOP-T5000']));
    const summary = summarizeTestCaseMapping({
      tests: [...many, ...crowded],
      pattern,
      keySources: sources,
      catalog: { keys: [], fetchedAt: read },
    });
    expect(summary.unknownKeys).toHaveLength(MAX_LISTED_UNKNOWN_KEYS);
    expect(summary.unknownKeyCount).toBe(26);
    expect(summary.unknownKeys.find((entry) => entry.key === 'SHOP-T5000')).toMatchObject({
      examples: ['crowd 0', 'crowd 1', 'crowd 2'],
      tests: 5,
    });
  });

  test('while the catalog was never read, no key is unknown and the catalog is said not to be read', () => {
    const summary = summarizeTestCaseMapping({
      tests,
      pattern,
      keySources: sources,
      catalog: { keys: [], fetchedAt: null },
    });
    expect(summary).toMatchObject({ catalogRead: false, unknownKeys: [], unknownKeyCount: 0, catalogFetchedAt: null });
    expect(summary.mappedTests).toBe(5);
  });

  test('a catalog read that held no case makes every key unknown', () => {
    const summary = summarizeTestCaseMapping({
      tests: [test_('a', ['SHOP-T1'])],
      pattern,
      keySources: sources,
      catalog: { keys: [], fetchedAt: read },
    });
    expect(summary.unknownKeyCount).toBe(1);
  });

  test('a run with no test maps nothing', () => {
    expect(
      summarizeTestCaseMapping({ tests: [], pattern, keySources: sources, catalog: { keys: [], fetchedAt: null } }),
    ).toMatchObject({ mappedTests: 0, testsWithoutKey: 0, keys: [] });
  });
});

describe('testManagementMappingSummary', () => {
  let db: TempDb;
  let close: () => Promise<void>;
  let connectionId: number;
  const start = Date.parse('2026-11-01T12:00:00Z');
  beforeAll(async () => {
    ({ db, close } = await openTempDb());
    await db.insert(schema.projects).values([
      { id: 1, name: 'shop', tagKeys: { issue: null, testCase: '^SHOP-T[0-9]+$' } },
      { id: 2, name: 'plain' },
      { id: 3, name: 'unbound' },
    ]);
    const [connection] = await db
      .insert(schema.integrationConnections)
      .values({ provider: 'zephyr-scale', name: 'Zephyr', baseUrl: '' })
      .returning();
    connectionId = connection!.id;
    for (const projectId of [1, 2]) {
      await writeTestManagementBinding(db, projectId, {
        connectionId,
        providerProjectKey: 'SHOP',
        keySources: { tags: true, externalId: projectId === 2 },
      } as never);
    }
    await db.insert(schema.testCases).values([
      { id: 1, projectId: 1, filePath: 'cart.spec.ts', title: 'adds an item' },
      { id: 2, projectId: 1, filePath: 'cart.spec.ts', title: 'pays by card' },
      { id: 3, projectId: 1, filePath: 'cart.spec.ts', title: 'no key' },
      { id: 4, projectId: 2, filePath: 'a.spec.ts', title: 'by id', externalId: 'SHOP-T5' },
    ]);
    const run = (id: number, projectId: number, extra: Record<string, unknown> = {}) => ({
      id,
      projectId,
      status: 'passed',
      branch: 'main',
      environment: 'prod',
      startTime: new Date(start + id * 60_000),
      metadata: {},
      ...extra,
    });
    const cut = {
      tests: 25,
      examples: Array.from({ length: 20 }, (_, i) => ({ filePath: 'a.ts', title: `t${i}`, dropped: 1 })),
    };
    await db
      .insert(schema.testRuns)
      .values([run(1, 1), run(2, 1, { metadata: { tagsTruncated: cut } }), run(3, 1, { isFullRun: 0 }), run(4, 2)]);
    const row = (runId: number, testCaseId: number, tags: string[] | null, status = 'passed', retries = 0) => ({
      testRunId: runId,
      testCaseId,
      status,
      tags,
      retries,
    });
    await db.insert(schema.testRunsCases).values([
      row(1, 1, ['SHOP-T100']),
      // The last complete run is run 2; a retry of test 1 is a second row of the same test.
      row(2, 1, ['SHOP-T1']),
      row(2, 1, ['SHOP-T1', 'smoke'], 'failed', 1),
      row(2, 2, ['SHOP-T999']),
      row(2, 3, ['smoke']),
      row(3, 3, ['SHOP-T3']),
      row(4, 4, []),
    ]);
  });
  afterAll(async () => {
    await close();
    vi.unstubAllGlobals();
  });

  const catalogRow = (key: string) => ({
    connectionId,
    projectKey: 'SHOP',
    key,
    providerId: key,
    name: key,
    statusName: null,
    folder: null,
    fetchedAt: new Date('2026-11-09T08:00:00Z'),
  });

  test('is not bound for a project with no binding', async () => {
    expect(await testManagementMappingSummary(db as never, 3)).toEqual({ bound: false });
  });

  test('reads the last complete run, not an older or a partial one, and says the catalog was not read', async () => {
    const report = await testManagementMappingSummary(db as never, 1);
    expect(report).toMatchObject({
      bound: true,
      runId: 2,
      pattern: '^SHOP-T[0-9]+$',
      patternIsDefault: false,
      summary: { mappedTests: 2, testsWithoutKey: 1, catalogRead: false, unknownKeys: [], catalogSize: 0 },
    });
    expect((report as { summary: { keys: string[] } }).summary.keys).toEqual(['SHOP-T1', 'SHOP-T999']);
  });

  test('flags a key the catalog lacks once the catalog has been read', async () => {
    await db.insert(schema.testManagementCases).values([catalogRow('SHOP-T1'), catalogRow('SHOP-T2')]);
    const report = await testManagementMappingSummary(db as never, 1);
    expect(report).toMatchObject({
      summary: {
        catalogRead: true,
        catalogSize: 2,
        unknownKeys: [{ key: 'SHOP-T999', examples: ['pays by card'], tests: 1 }],
      },
    });
  });

  test('flags every key as unknown after a read that found no cases', async () => {
    await db.delete(schema.testManagementCases);
    await db
      .insert(schema.testManagementCatalogReads)
      .values({ connectionId, projectKey: 'SHOP', fetchedAt: new Date('2026-11-09T08:00:00Z') });
    const report = await testManagementMappingSummary(db as never, 1);
    expect(report).toMatchObject({
      summary: { catalogRead: true, catalogSize: 0 },
    });
    expect(
      (report as { summary: { unknownKeys: Array<{ key: string }> } }).summary.unknownKeys.map((u) => u.key),
    ).toEqual(['SHOP-T1', 'SHOP-T999']);
    await db.delete(schema.testManagementCatalogReads);
  });

  test('uses the default key pattern of the provider project when the project names none, and the external ID source', async () => {
    const report = await testManagementMappingSummary(db as never, 2);
    expect(report).toMatchObject({
      pattern: '^SHOP-T[0-9]+$',
      patternIsDefault: true,
      keySources: { tags: true, externalId: true },
      summary: { mappedTests: 1, keys: ['SHOP-T5'] },
    });
  });

  test('gives the tests whose tags were cut so they are shown as "at least N", never as the stored count', async () => {
    const report = await testManagementMappingSummary(db as never, 1);
    if (!report.bound || !report.tagsTruncated) throw new Error('expected tagsTruncated');
    expect(report.tagsTruncated.tests).toBe(25);
    expect(formatTagsTruncatedTests(report.tagsTruncated)).toBe('at least 20 tests');
  });

  test('a binding with no run reads as no tests', async () => {
    await db.delete(schema.testRuns);
    expect(await testManagementMappingSummary(db as never, 1)).toMatchObject({
      runId: null,
      summary: { mappedTests: 0, testsWithoutKey: 0 },
      tagsTruncated: null,
    });
    expect((await readTestManagementBinding(db, 1)).providerProjectKey).toBe('SHOP');
  });
});
