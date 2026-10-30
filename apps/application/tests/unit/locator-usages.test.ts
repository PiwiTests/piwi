import { describe, test, expect, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

delete process.env.PIWI_DATABASE_URL;
const { upsertLocatorUsages, getExecutionLocators, getLocatorUsages, backfillLocatorUsages, getLocatorIndex } =
  await import('../../server/utils/locator-usages');
type LocatorUsageCase = import('../../server/utils/locator-usages').LocatorUsageCase;

let db: ReturnType<typeof drizzle<typeof schema>>;
let runSeq = 0;

const ROOT = '/work/shop/';

/** Steps as Playwright 1.63 reports them and the reporter stores them. */
const step = (title: string, locator: string, location: string) => ({
  title,
  category: 'action',
  duration: 5,
  subtitle: locator,
  params: { locator },
  location: `${ROOT}${location}`,
});

const SHIPPING = "getByRole('form', { name: 'Shipping' })";
const COUNTRY = `${SHIPPING}.getByLabel('Country')`;
const PAY = "getByRole('button', { name: 'Pay' })";

async function seedCase(id: number, title: string, filePath = 'tests/checkout.spec.ts'): Promise<number> {
  await db.insert(schema.testCases).values({ id, projectId: 1, filePath, title });
  return id;
}

/** A run, one minute after the previous one unless `startedAt` says otherwise. */
async function seedRun(
  opts: { startedAt?: Date; metadata?: Record<string, unknown>; branch?: string | null } = {},
): Promise<number> {
  const id = ++runSeq;
  await db.insert(schema.testRuns).values({
    id,
    projectId: 1,
    status: 'passed',
    startTime: opts.startedAt ?? new Date(Date.UTC(2026, 0, 1) + id * 60_000),
    metadata: opts.metadata ?? null,
    branch: opts.branch ?? null,
  });
  return id;
}

async function seedExecution(
  runId: number,
  testCaseId: number,
  steps: unknown[],
  opts: { status?: string; browserName?: string } = {},
): Promise<number> {
  const [row] = await db
    .insert(schema.testRunsCases)
    .values({
      testRunId: runId,
      testCaseId,
      status: opts.status ?? 'passed',
      steps,
      browserName: opts.browserName ?? 'chromium',
    })
    .returning({ id: schema.testRunsCases.id });
  return row!.id;
}

/** One execution for `upsertLocatorUsages`: a passed chromium run of test 1 by default. */
const exec = (runId: number, steps: unknown[], more: Partial<LocatorUsageCase> = {}): LocatorUsageCase => ({
  caseId: 1,
  browserName: 'chromium',
  filePath: 'tests/checkout.spec.ts',
  runId,
  complete: true,
  steps,
  ...more,
});

async function usages() {
  return db.select().from(schema.locatorUsages);
}

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  await db.insert(schema.projects).values({ id: 1, name: 'locator-usages-project' });
  runSeq = 0;
});

describe('upsertLocatorUsages', () => {
  test('indexes chains, actions and project-relative call sites, never typed values', async () => {
    await seedCase(1, 'pays by card');
    const runId = await seedRun();
    await upsertLocatorUsages(db as never, 1, [
      exec(runId, [
        step('Fill "Jane Secret"', `${SHIPPING}.getByLabel('Name')`, 'pages/shipping.page.ts:37:5'),
        step('Select option', COUNTRY, 'pages/shipping.page.ts:41:5'),
        step('Select option', COUNTRY, 'pages/shipping.page.ts:41:5'),
        { title: "Click getByRole('button', { name: 'Pay' })", location: `${ROOT}tests/checkout.spec.ts:20:3` },
      ]),
    ]);
    const rows = await usages();
    expect(rows.map((r) => [r.action, r.locator, r.target, r.callSite])).toEqual([
      ['fill', `${SHIPPING}.getByLabel('Name')`, "getByLabel('Name')", 'pages/shipping.page.ts:37:5'],
      ['selectOption', COUNTRY, "getByLabel('Country')", 'pages/shipping.page.ts:41:5'],
      [
        'click',
        "getByRole('button', { name: 'Pay' })",
        "getByRole('button', { name: 'Pay' })",
        'tests/checkout.spec.ts:20:3',
      ],
    ]);
    expect(JSON.stringify(rows)).not.toContain('Jane Secret');
  });

  test('keeps the first-seen run and moves the last-seen run', async () => {
    await seedCase(1, 'pays by card');
    const first = await seedRun();
    const second = await seedRun();
    const steps = [step('Click', PAY, 'tests/checkout.spec.ts:20:3')];
    await upsertLocatorUsages(db as never, 1, [exec(first, steps)]);
    await upsertLocatorUsages(db as never, 1, [exec(second, steps)]);
    const [row] = await usages();
    expect([row!.firstSeenRunId, row!.lastSeenRunId]).toEqual([first, second]);
  });

  test('a later complete execution drops uses the test no longer has; an incomplete one keeps them', async () => {
    await seedCase(1, 'pays by card');
    const first = await seedRun();
    const second = await seedRun();
    const pay = step('Click', PAY, 'tests/checkout.spec.ts:20:3');
    const back = step('Click', "getByRole('link', { name: 'Back' })", 'tests/checkout.spec.ts:21:3');
    await upsertLocatorUsages(db as never, 1, [exec(first, [pay, back])]);

    await upsertLocatorUsages(db as never, 1, [exec(second, [pay], { complete: false })]);
    expect((await usages()).length).toBe(2);

    await upsertLocatorUsages(db as never, 1, [exec(second, [pay])]);
    expect((await usages()).map((r) => r.locator)).toEqual([PAY]);
  });

  test('a Playwright project only drops the uses it recorded itself', async () => {
    await seedCase(1, 'opens the menu');
    const first = await seedRun();
    const second = await seedRun();
    const pay = step('Click', PAY, 'tests/checkout.spec.ts:20:3');
    const menu = step('Click', "getByRole('button', { name: 'Menu' })", 'tests/checkout.spec.ts:19:3');
    await upsertLocatorUsages(db as never, 1, [
      exec(first, [pay]),
      exec(first, [menu, pay], { browserName: 'mobile-safari' }),
    ]);
    // The next run's batches land one project at a time.
    await upsertLocatorUsages(db as never, 1, [exec(second, [menu, pay], { browserName: 'mobile-safari' })]);
    await upsertLocatorUsages(db as never, 1, [exec(second, [pay])]);

    const rows = await usages();
    expect(rows.map((r) => `${r.browserName} ${r.locator}`).sort()).toEqual([
      `chromium ${PAY}`,
      "mobile-safari getByRole('button', { name: 'Menu' })",
      `mobile-safari ${PAY}`,
    ]);
  });

  test('an old report imported late never rolls the index back', async () => {
    await seedCase(1, 'pays by card');
    const current = await seedRun();
    const imported = await seedRun({ startedAt: new Date(Date.UTC(2025, 0, 1)) });
    const pay = step('Click', PAY, 'tests/checkout.spec.ts:20:3');
    const legacy = step('Click', "getByRole('button', { name: 'Checkout' })", 'tests/checkout.spec.ts:20:3');
    await upsertLocatorUsages(db as never, 1, [exec(current, [pay])]);
    await upsertLocatorUsages(db as never, 1, [exec(imported, [legacy])]);

    const rows = await usages();
    expect(rows.find((r) => r.locator === PAY)?.lastSeenRunId).toBe(current);
    // The older run adds what it saw, but can't remove a use seen after it.
    expect(rows.map((r) => r.locator).sort()).toEqual([PAY, "getByRole('button', { name: 'Checkout' })"].sort());

    await upsertLocatorUsages(db as never, 1, [exec(imported, [pay])]);
    expect((await usages()).find((r) => r.locator === PAY)?.lastSeenRunId).toBe(current);
  });

  test('the working directory sent with the run makes page-object call sites relative', async () => {
    await seedCase(1, 'pays by card');
    const runId = await seedRun({ metadata: { workingDir: '/work/shop' } });
    await upsertLocatorUsages(db as never, 1, [
      exec(runId, [step('Select option', COUNTRY, 'pages/shipping.page.ts:41:5')]),
    ]);
    expect((await usages()).map((r) => r.callSite)).toEqual(['pages/shipping.page.ts:41:5']);
  });

  test('a call site that cannot be made relative is left out, and its execution removes nothing', async () => {
    await seedCase(1, 'pays by card');
    const first = await seedRun();
    const second = await seedRun();
    await upsertLocatorUsages(db as never, 1, [exec(first, [step('Click', PAY, 'tests/checkout.spec.ts:20:3')])]);
    // Every step behind a page object, no working directory: the root is unknown.
    await upsertLocatorUsages(db as never, 1, [
      exec(second, [step('Select option', COUNTRY, 'pages/shipping.page.ts:41:5')]),
    ]);
    const rows = await usages();
    expect(rows.map((r) => r.locator)).toEqual([PAY]);
    expect(rows.every((r) => !r.callSite.startsWith('/'))).toBe(true);
  });

  test('chains over the byte budget are left out', async () => {
    await seedCase(1, 'reads a long label');
    const runId = await seedRun();
    const long = `getByText('${'文'.repeat(400)}')`;
    await upsertLocatorUsages(db as never, 1, [
      exec(runId, [
        step('Click', long, 'tests/checkout.spec.ts:20:3'),
        step('Click', PAY, 'tests/checkout.spec.ts:21:3'),
      ]),
    ]);
    expect((await usages()).map((r) => r.locator)).toEqual([PAY]);
  });
});

describe('getExecutionLocators', () => {
  test('lists uses in step order with how many tests share the chain and the target', async () => {
    await seedCase(1, 'pays by card');
    await seedCase(2, 'saves an address', 'tests/address.spec.ts');
    await seedCase(3, 'picks a country', 'tests/address.spec.ts');
    const runId = await seedRun();
    const execution = await seedExecution(runId, 1, [
      step('Select option', COUNTRY, 'pages/shipping.page.ts:41:5'),
      step('Select option', COUNTRY, 'pages/shipping.page.ts:41:5'),
      step('Click', "getByRole('button', { name: 'Pay' })", 'tests/checkout.spec.ts:20:3'),
    ]);
    await seedExecution(runId, 2, [step('Select option', COUNTRY, 'pages/shipping.page.ts:41:5')]);
    await seedExecution(runId, 3, [step('Click', "getByLabel('Country')", 'tests/address.spec.ts:18:3')]);

    await backfillLocatorUsages(db as never, 1);
    const result = await getExecutionLocators(db as never, execution);
    expect(result?.uses).toEqual([
      expect.objectContaining({
        stepIndex: 0,
        occurrences: 2,
        action: 'selectOption',
        locator: COUNTRY,
        target: "getByLabel('Country')",
        scopes: [SHIPPING],
        callSite: 'pages/shipping.page.ts:41:5',
        sameLocatorTests: 2,
        sameTargetTests: 3,
      }),
      expect.objectContaining({ stepIndex: 2, action: 'click', sameLocatorTests: 1, sameTargetTests: 1 }),
    ]);
  });

  test('never builds the index itself', async () => {
    await seedCase(1, 'pays by card');
    const runId = await seedRun();
    const execution = await seedExecution(runId, 1, [step('Click', PAY, 'tests/checkout.spec.ts:20:3')]);
    const result = await getExecutionLocators(db as never, execution);
    expect(result?.uses[0]).toMatchObject({ locator: PAY, sameLocatorTests: 0 });
    expect(await usages()).toEqual([]);
  });

  test('returns null for an unknown execution', async () => {
    expect(await getExecutionLocators(db as never, 999)).toBeNull();
  });
});

describe('backfillLocatorUsages', () => {
  test('indexes the latest passed execution per test and project, skips probe runs, and marks the project', async () => {
    await seedCase(1, 'pays by card');
    const passed = await seedRun();
    const failed = await seedRun();
    const probe = await seedRun({ metadata: { piwiProbe: true } });
    await seedExecution(passed, 1, [step('Click', PAY, 'tests/checkout.spec.ts:20:3')]);
    await seedExecution(
      failed,
      1,
      [step('Click', "getByRole('link', { name: 'Cart' })", 'tests/checkout.spec.ts:18:3')],
      {
        status: 'failed',
      },
    );
    await seedExecution(probe, 1, [
      step('Click', "getByRole('button', { name: 'Retry' })", 'tests/checkout.spec.ts:22:3'),
    ]);
    await seedExecution(
      failed,
      1,
      [step('Click', "getByRole('button', { name: 'Menu' })", 'tests/checkout.spec.ts:19:3')],
      {
        status: 'failed',
        browserName: 'mobile-safari',
      },
    );

    await backfillLocatorUsages(db as never, 1);

    expect((await usages()).map((r) => `${r.browserName} ${r.locator}`).sort()).toEqual([
      `chromium ${PAY}`,
      "mobile-safari getByRole('button', { name: 'Menu' })",
    ]);
    const [project] = await db.select().from(schema.projects);
    expect(project!.locatorIndexBuiltAt).toBeInstanceOf(Date);
  });
});

describe('getLocatorUsages', () => {
  beforeEach(async () => {
    await seedCase(1, 'pays by card');
    await seedCase(2, 'saves an address', 'tests/address.spec.ts');
    await seedCase(3, 'picks a country', 'tests/address.spec.ts');
    const runId = await seedRun();
    await seedExecution(runId, 1, [step('Select option', COUNTRY, 'pages/shipping.page.ts:41:5')]);
    await seedExecution(runId, 2, [
      step('Select option', COUNTRY, 'pages/shipping.page.ts:41:5'),
      step('Fill "x"', `${SHIPPING}.getByLabel('City')`, 'pages/shipping.page.ts:44:5'),
    ]);
    await seedExecution(runId, 3, [step('Click', "getByLabel('Country')", 'tests/address.spec.ts:18:3')]);
    await backfillLocatorUsages(db as never, 1);
  });

  test('locator: one call site shared by two tests', async () => {
    const result = await getLocatorUsages(db as never, 1, 'locator', COUNTRY);
    expect(result.testCount).toBe(2);
    expect(result.sites).toHaveLength(1);
    expect(result.sites[0]).toMatchObject({ callSite: 'pages/shipping.page.ts:41:5', actions: ['selectOption'] });
    expect(result.sites[0]!.tests.map((t) => t.title).sort()).toEqual(['pays by card', 'saves an address']);
  });

  test('target: every chain ending on the same call, whatever its container', async () => {
    const result = await getLocatorUsages(db as never, 1, 'target', "getByLabel('Country')");
    expect(result.testCount).toBe(3);
    expect(result.sites.map((s) => s.callSite)).toEqual(['pages/shipping.page.ts:41:5', 'tests/address.spec.ts:18:3']);
  });

  test('scope: every chain that searches inside a container', async () => {
    const result = await getLocatorUsages(db as never, 1, 'scope', SHIPPING);
    expect(result.sites.map((s) => s.locator).sort()).toEqual([`${SHIPPING}.getByLabel('City')`, COUNTRY]);
    expect(result.testCount).toBe(2);
  });

  test('scope matching is a case-sensitive prefix', async () => {
    const result = await getLocatorUsages(db as never, 1, 'scope', "getByRole('form', { name: 'shipping' })");
    expect(result.testCount).toBe(0);
  });

  test('search: text inside any chain, ignoring case', async () => {
    const result = await getLocatorUsages(db as never, 1, 'search', 'city');
    expect(result.sites.map((s) => s.locator)).toEqual([`${SHIPPING}.getByLabel('City')`]);
  });

  test('search treats LIKE wildcards literally', async () => {
    expect((await getLocatorUsages(db as never, 1, 'search', '%')).testCount).toBe(0);
  });
});

describe('getLocatorIndex', () => {
  test("groups uses by chain, most-used first, with each test's actions, call sites and projects", async () => {
    await seedCase(1, 'pays by card');
    await seedCase(2, 'pays with a voucher', 'tests/voucher.spec.ts');
    await db.update(schema.testCases).set({ suitePath: 'Checkout\x1fPayment' }).where(eq(schema.testCases.id, 1));
    const run = await seedRun({
      metadata: {
        htmlReport: {
          projects: [
            { name: 'chromium', use: { testIdAttribute: 'data-qa', viewport: { width: 1280, height: 720 } } },
            { name: 'Mobile Safari', use: { viewport: { width: 390, height: 664 } } },
            { name: 'no viewport', use: { viewport: null } },
          ],
        },
      },
    });
    await seedExecution(run, 1, [], { status: 'passed' });
    await seedExecution(run, 2, [], { status: 'failed' });
    await upsertLocatorUsages(db as never, 1, [
      exec(run, [
        step(`Select option ${COUNTRY}`, COUNTRY, 'pages/checkout.ts:10:5'),
        step(`Click ${PAY}`, PAY, 'pages/checkout.ts:20:5'),
      ]),
      exec(run, [step(`Click ${PAY}`, PAY, 'tests/voucher.spec.ts:8:3')], {
        caseId: 2,
        browserName: 'mobile-safari',
        filePath: 'tests/voucher.spec.ts',
      }),
    ]);

    const index = await getLocatorIndex(db as never, 1);
    expect(index).toMatchObject({ projectId: 1, projectName: 'locator-usages-project', truncated: false });
    expect(index!.testIdAttributes).toEqual(['data-qa']);
    expect(index!.viewports).toEqual([
      { project: 'chromium', width: 1280, height: 720 },
      { project: 'Mobile Safari', width: 390, height: 664 },
    ]);
    expect(index!.locators.map((l) => l.locator)).toEqual([PAY, COUNTRY]);

    const byId = new Map(index!.tests.map((t, i) => [t.id, { ...t, i }]));
    expect(byId.get(1)).toMatchObject({ title: 'pays by card', suite: ['Checkout', 'Payment'], status: 'passed' });
    expect(byId.get(2)).toMatchObject({ file: 'tests/voucher.spec.ts', suite: [], status: 'failed' });

    const pay = index!.locators[0]!;
    expect(pay.uses).toHaveLength(2);
    const voucherUse = pay.uses.find((u) => index!.tests[u.test]!.id === 2)!;
    expect(voucherUse).toMatchObject({
      actions: ['click'],
      callSites: ['tests/voucher.spec.ts:8:3'],
      projects: ['mobile-safari'],
    });
  });

  test('marks a pass after retries flaky and says when the chains were cut off', async () => {
    await seedCase(1, 'retried');
    const run = await seedRun({ metadata: { workingDir: '/work/shop' } });
    await db.insert(schema.testRunsCases).values({ testRunId: run, testCaseId: 1, status: 'passed', retries: 1 });
    await upsertLocatorUsages(db as never, 1, [
      exec(run, [
        step(`Click ${PAY}`, PAY, 'pages/checkout.ts:20:5'),
        step(`Select option ${COUNTRY}`, COUNTRY, 'pages/checkout.ts:10:5'),
      ]),
    ]);
    const index = await getLocatorIndex(db as never, 1, { maxLocators: 1 });
    expect(index!.tests[0]!.status).toBe('flaky');
    expect(index!.locators).toHaveLength(1);
    expect(index!.truncated).toBe(true);
    expect(index!.testIdAttributes).toBeNull();
    expect(index!.viewports).toBeUndefined();
  });

  test('answers null for a missing project and an empty index for a project with no uses', async () => {
    expect(await getLocatorIndex(db as never, 99)).toBeNull();
    const index = await getLocatorIndex(db as never, 1);
    expect(index).toMatchObject({ locators: [], tests: [], truncated: false, builtAt: null });
  });
});

describe('branches', () => {
  const BACK = "getByRole('link', { name: 'Back' })";
  const VOUCHER = "getByLabel('Voucher')";
  const pay = step('Click', PAY, 'tests/checkout.spec.ts:20:3');
  const back = step('Click', BACK, 'tests/checkout.spec.ts:21:3');
  const voucher = step('Fill', VOUCHER, 'tests/checkout.spec.ts:22:3');

  /** Test 1 uses Pay and Back on main and drops Back for a voucher field on feature/voucher; test 2 uses Pay on main. */
  async function seedTwoBranches() {
    await db.update(schema.projects).set({ defaultBranch: 'main' }).where(eq(schema.projects.id, 1));
    await seedCase(1, 'pays by card');
    await seedCase(2, 'pays again');
    const main = await seedRun({ branch: 'main' });
    const feature = await seedRun({ branch: 'feature/voucher' });
    const mainExecution = await seedExecution(main, 1, [pay, back], { status: 'passed' });
    await seedExecution(main, 2, [pay], { status: 'passed' });
    const featureExecution = await seedExecution(feature, 1, [pay, voucher], { status: 'failed' });
    await upsertLocatorUsages(db as never, 1, [exec(main, [pay, back]), exec(main, [pay], { caseId: 2 })]);
    await upsertLocatorUsages(db as never, 1, [exec(feature, [pay, voucher])]);
    return { mainExecution, featureExecution };
  }

  const uses = (index: Awaited<ReturnType<typeof getLocatorIndex>>, locator: string) =>
    index!.locators
      .find((l) => l.locator === locator)
      ?.uses.map((u) => ({ test: index!.tests[u.test]!.id, branches: [...u.branches].sort() }))
      .sort((a, b) => a.test - b.test) ?? null;

  test('a branch keeps its own uses, and its complete runs remove only them', async () => {
    await seedTwoBranches();
    const rows = (await usages()).map((r) => `${r.testCaseId} ${r.branch || '(default)'} ${r.locator}`).sort();
    expect(rows).toEqual(
      [
        `1 (default) ${BACK}`,
        `1 (default) ${PAY}`,
        `1 feature/voucher ${PAY}`,
        `1 feature/voucher ${VOUCHER}`,
        `2 (default) ${PAY}`,
      ].sort(),
    );
  });

  test('runs on the default branch, or with no branch, are stored as the default branch', async () => {
    await db.update(schema.projects).set({ defaultBranch: 'main' }).where(eq(schema.projects.id, 1));
    await seedCase(1, 'pays by card');
    await upsertLocatorUsages(db as never, 1, [exec(await seedRun({ branch: 'main' }), [pay], { complete: false })]);
    await upsertLocatorUsages(db as never, 1, [exec(await seedRun({ branch: null }), [back], { complete: false })]);
    expect((await usages()).map((r) => r.branch)).toEqual(['', '']);
  });

  test("a branch view replaces the default branch's uses of the tests that ran on it", async () => {
    await seedTwoBranches();

    const main = await getLocatorIndex(db as never, 1);
    expect(main).toMatchObject({ branch: 'main', defaultBranch: 'main' });
    expect(main!.branches).toEqual([{ name: 'feature/voucher', lastSeenAt: expect.any(String), tests: 1 }]);
    expect(main!.locators.map((l) => l.locator)).toEqual([PAY, BACK]);
    expect(main!.tests.find((t) => t.id === 1)!.status).toBe('passed');

    const feature = await getLocatorIndex(db as never, 1, { branch: 'feature/voucher' });
    expect(feature!.branch).toBe('feature/voucher');
    expect(feature!.locators.map((l) => l.locator).sort()).toEqual([PAY, VOUCHER].sort());
    expect(uses(feature, PAY)).toEqual([
      { test: 1, branches: ['feature/voucher'] },
      { test: 2, branches: ['main'] },
    ]);
    expect(feature!.tests.find((t) => t.id === 1)!.status).toBe('failed');
    expect(feature!.tests.find((t) => t.id === 2)!.status).toBe('passed');

    const all = await getLocatorIndex(db as never, 1, { branch: '*' });
    expect(all!.branch).toBeNull();
    expect(all!.locators.map((l) => l.locator).sort()).toEqual([BACK, PAY, VOUCHER].sort());
    expect(uses(all, PAY)).toEqual([
      { test: 1, branches: ['feature/voucher', 'main'] },
      { test: 2, branches: ['main'] },
    ]);

    // The default branch asked by name is the default view.
    expect((await getLocatorIndex(db as never, 1, { branch: 'main' }))!.locators.map((l) => l.locator)).toEqual([
      PAY,
      BACK,
    ]);
  });

  test('"Who uses this?" answers in the view asked for', async () => {
    await seedTwoBranches();
    expect((await getLocatorUsages(db as never, 1, 'locator', BACK)).testCount).toBe(1);
    const onFeature = await getLocatorUsages(db as never, 1, 'locator', BACK, { branch: 'feature/voucher' });
    expect(onFeature).toMatchObject({ branch: 'feature/voucher', testCount: 0 });
    expect((await getLocatorUsages(db as never, 1, 'locator', PAY, { branch: 'feature/voucher' })).testCount).toBe(2);
    expect((await getLocatorUsages(db as never, 1, 'locator', VOUCHER, { branch: '*' })).testCount).toBe(1);
  });

  test("an execution's counts come from its own branch", async () => {
    const { mainExecution, featureExecution } = await seedTwoBranches();
    const onFeature = await getExecutionLocators(db as never, featureExecution);
    expect(onFeature!.branch).toBe('feature/voucher');
    expect(onFeature!.uses.map((u) => [u.locator, u.sameLocatorTests])).toEqual([
      [PAY, 2],
      [VOUCHER, 1],
    ]);
    const onMain = await getExecutionLocators(db as never, mainExecution);
    expect(onMain!.uses.map((u) => [u.locator, u.sameLocatorTests])).toEqual([
      [PAY, 2],
      [BACK, 1],
    ]);
  });

  test('a rebuild indexes one execution per branch, and reset drops uses no stored execution has', async () => {
    await seedTwoBranches();
    await db.insert(schema.locatorUsages).values({
      projectId: 1,
      testCaseId: 2,
      locator: "getByText('Gone')",
      target: "getByText('Gone')",
      action: 'click',
      browserName: 'chromium',
      callSite: '',
      lastSeenAt: new Date(Date.UTC(2025, 0, 1)),
    });
    await backfillLocatorUsages(db as never, 1, { reset: true });
    const rows = (await usages()).map((r) => `${r.testCaseId} ${r.branch || '(default)'} ${r.locator}`).sort();
    expect(rows).toEqual(
      [
        `1 (default) ${BACK}`,
        `1 (default) ${PAY}`,
        `1 feature/voucher ${PAY}`,
        `1 feature/voucher ${VOUCHER}`,
        `2 (default) ${PAY}`,
      ].sort(),
    );
  });
});

describe('parseLocatorBranchQuery', () => {
  test('reads a branch, every branch, or nothing for the default branch', async () => {
    const { parseLocatorBranchQuery } = await import('../../shared/locator-usages.types');
    expect(parseLocatorBranchQuery(undefined)).toEqual({ branch: undefined });
    expect(parseLocatorBranchQuery('')).toEqual({ branch: undefined });
    expect(parseLocatorBranchQuery(' feature/x ')).toEqual({ branch: 'feature/x' });
    expect(parseLocatorBranchQuery('*')).toEqual({ branch: '*' });
    expect(parseLocatorBranchQuery(['a', 'b'])).toHaveProperty('error');
    expect(parseLocatorBranchQuery('   ')).toHaveProperty('error');
    expect(parseLocatorBranchQuery('x'.repeat(256))).toHaveProperty('error');
  });
});

describe('pages', () => {
  /** A `piwi-locator-pages` entry for a call at `location` (project-relative) on `page` of the shop. */
  const onPage = (location: string, locator: string, page: string, arrival = true, origin = 'https://shop.test') => ({
    location: `${ROOT}${location}`,
    locator,
    origin,
    page,
    arrival,
  });
  const shopRun = () =>
    seedRun({ metadata: { htmlReport: { projects: [{ use: { baseURL: 'https://shop.test' } }] } } });

  test('a use made on two pages is a row per page, with whether it ran there on arrival', async () => {
    await seedCase(1, 'pays by card');
    const runId = await shopRun();
    await upsertLocatorUsages(db as never, 1, [
      exec(
        runId,
        [step('Click', PAY, 'pages/pay.ts:9:5'), step('Select option', COUNTRY, 'tests/checkout.spec.ts:21:3')],
        {
          locatorPages: [
            onPage('pages/pay.ts:9:5', PAY, '/checkout', true),
            onPage('pages/pay.ts:9:5', PAY, '/orders/:id', false),
            // Another column on the same line: the wrapper's stack and the step can disagree.
            onPage('tests/checkout.spec.ts:21:9', COUNTRY, '/checkout', false),
          ],
        },
      ),
    ]);
    const rows = (await usages()).map((r) => [r.locator, r.page, r.arrival]).sort();
    expect(rows).toEqual(
      [
        [COUNTRY, '/checkout', false],
        [PAY, '/checkout', true],
        [PAY, '/orders/:id', false],
      ].sort(),
    );
  });

  test('a call with no recorded page is stored with an unknown page, and a third-party page keeps its origin', async () => {
    await seedCase(1, 'pays by card');
    const runId = await shopRun();
    await upsertLocatorUsages(db as never, 1, [
      exec(
        runId,
        [
          step('Click', PAY, 'tests/checkout.spec.ts:20:3'),
          step('Fill', "getByLabel('Card')", 'tests/checkout.spec.ts:22:3'),
        ],
        {
          locatorPages: [
            onPage('tests/checkout.spec.ts:22:3', "getByLabel('Card')", '/pay', true, 'https://pay.example'),
          ],
        },
      ),
    ]);
    const rows = new Map((await usages()).map((r) => [r.locator, r.page]));
    expect(rows.get(PAY)).toBe('');
    expect(rows.get("getByLabel('Card')")).toBe('https://pay.example/pay');
  });

  test('a complete run that moved a use to another page drops the old page', async () => {
    await seedCase(1, 'pays by card');
    const first = await shopRun();
    const steps = [step('Click', PAY, 'tests/checkout.spec.ts:20:3')];
    await upsertLocatorUsages(db as never, 1, [
      exec(first, steps, { locatorPages: [onPage('tests/checkout.spec.ts:20:3', PAY, '/cart')] }),
    ]);
    const second = await shopRun();
    await upsertLocatorUsages(db as never, 1, [
      exec(second, steps, { locatorPages: [onPage('tests/checkout.spec.ts:20:3', PAY, '/checkout')] }),
    ]);
    expect((await usages()).map((r) => r.page)).toEqual(['/checkout']);
  });

  test('the index lists the pages, most used first, and each use its pages and arrivals', async () => {
    await seedCase(1, 'pays by card');
    await seedCase(2, 'pays with a voucher');
    const runId = await shopRun();
    const pay = step('Click', PAY, 'tests/checkout.spec.ts:20:3');
    await upsertLocatorUsages(db as never, 1, [
      exec(runId, [pay], {
        locatorPages: [
          onPage('tests/checkout.spec.ts:20:3', PAY, '/checkout', true),
          onPage('tests/checkout.spec.ts:20:3', PAY, '/cart', false),
        ],
      }),
      exec(runId, [pay], { caseId: 2, locatorPages: [onPage('tests/checkout.spec.ts:20:3', PAY, '/checkout', false)] }),
    ]);
    const index = await getLocatorIndex(db as never, 1);
    expect(index!.pages).toEqual(['/checkout', '/cart']);
    const [entry] = index!.locators;
    const byTest = new Map(entry!.uses.map((u) => [index!.tests[u.test]!.title, u]));
    expect(byTest.get('pays by card')).toMatchObject({ pages: [0, 1], arrival: [0] });
    expect(byTest.get('pays with a voucher')).toMatchObject({ pages: [0] });
    expect(byTest.get('pays with a voucher')!.arrival).toBeUndefined();

    const usagesResult = await getLocatorUsages(db as never, 1, 'locator', PAY);
    expect(usagesResult.sites[0]!.pages?.sort()).toEqual(['/cart', '/checkout']);
  });

  test('an index without any recorded page says nothing about pages', async () => {
    await seedCase(1, 'pays by card');
    const runId = await seedRun();
    await upsertLocatorUsages(db as never, 1, [exec(runId, [step('Click', PAY, 'tests/checkout.spec.ts:20:3')])]);
    const index = await getLocatorIndex(db as never, 1);
    expect(index!.pages).toBeUndefined();
    expect(index!.locators[0]!.uses[0]!.pages).toBeUndefined();
  });

  test('a rebuild reads the pages stored with each execution', async () => {
    await seedCase(1, 'pays by card');
    const runId = await shopRun();
    const [payload] = await db
      .insert(schema.casePayloads)
      .values({
        projectId: 1,
        hash: 'h1',
        content: JSON.stringify([onPage('tests/checkout.spec.ts:20:3', PAY, '/checkout')]),
        size: 10,
      })
      .returning({ id: schema.casePayloads.id });
    const executionId = await seedExecution(runId, 1, [step('Click', PAY, 'tests/checkout.spec.ts:20:3')]);
    await db
      .update(schema.testRunsCases)
      .set({ locatorPagesPayloadId: payload!.id })
      .where(eq(schema.testRunsCases.id, executionId));

    await backfillLocatorUsages(db as never, 1, { reset: true });
    expect((await usages()).map((r) => [r.page, r.arrival])).toEqual([['/checkout', true]]);
    const locators = await getExecutionLocators(db as never, executionId);
    expect(locators!.uses[0]!.pages).toEqual(['/checkout']);
  });
});
