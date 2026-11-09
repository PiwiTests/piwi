import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../../server/database/schema.sqlite';
import { parseReproRequest, reproRequestPatchSchema } from '#shared/desktop-repro';
import { createReproRequest, getReproRequest, updateReproRequest } from '../../server/utils/desktop-repro';
import { getProjectLatestRun } from '#shared/handlers/test-runs';
import { runOrigin } from '#shared/run-eligibility';
import {
  desktopJobVerdict,
  flakeLabJobReport,
  localRunOriginKind,
  newLocalRunRef,
  type JobRunOutcome,
} from '../../app/utils/desktop-job';
import { parseRunOriginRef } from '@piwitests/core/wire';
import { openTempDb, type TempDb } from './temp-db';

delete process.env.PIWI_DATABASE_URL;

const BAD = 'b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0';
const GOOD = 'a0a0a0a';

const bisectJob = {
  kind: 'bisect',
  commit: BAD.toUpperCase(),
  good: GOOD,
  tests: [{ filePath: 'tests\\cart.spec.ts', title: 'applies the coupon', line: 12, projectName: 'chromium' }],
  browser: 'chromium',
  title: 'applies the coupon',
  instanceUrl: 'https://piwi.example.com/',
  clusterId: 214,
};

describe('an editor job request', () => {
  it('reads a bisect: commits lower-cased, paths with forward slashes, the instance without its trailing slash', () => {
    const parsed = parseReproRequest('application/json', bisectJob);
    expect(parsed).toEqual({
      ok: true,
      request: {
        kind: 'bisect',
        job: {
          commit: BAD,
          good: GOOD,
          tests: [{ filePath: 'tests/cart.spec.ts', title: 'applies the coupon', line: 12, projectName: 'chromium' }],
          browser: 'chromium',
          clusterId: 214,
          plan: null,
        },
        title: 'applies the coupon',
        instanceUrl: 'https://piwi.example.com',
      },
    });
  });

  it('refuses what is not a commit, a test path that could be a flag or leave the folder, and a bisect with no good end', () => {
    const refused = (patch: Record<string, unknown>) =>
      parseReproRequest('application/json', { ...bisectJob, ...patch });
    expect(refused({ commit: 'HEAD~3' })).toMatchObject({ ok: false, statusCode: 400 });
    expect(refused({ good: null })).toMatchObject({ ok: false, statusCode: 400 });
    expect(refused({ instanceUrl: 'file:///etc' })).toMatchObject({ ok: false, statusCode: 400 });
    expect(refused({ tests: [] })).toMatchObject({ ok: false, statusCode: 400 });
    for (const filePath of ['--config=evil.ts', '/etc/passwd', 'C:\\x.spec.ts', '../outside.spec.ts']) {
      expect(refused({ tests: [{ filePath, title: 't' }] })).toMatchObject({ ok: false, statusCode: 400 });
    }
    expect(
      refused({ tests: [{ filePath: 'a.spec.ts', title: 't', projectName: 'x --config=evil.ts' }] }),
    ).toMatchObject({ ok: false });
    expect(parseReproRequest('text/plain', bisectJob)).toMatchObject({ ok: false, statusCode: 415 });
  });

  it('reads a reproduction without a good commit', () => {
    const parsed = parseReproRequest('application/json', { ...bisectJob, kind: 'reproduce', good: undefined });
    expect(parsed).toMatchObject({ ok: true, request: { kind: 'reproduce', job: { commit: BAD, good: null } } });
  });

  it('waits for the window, then carries the verdict for the editor to read', () => {
    const parsed = parseReproRequest('application/json', bisectJob);
    if (!parsed.ok) throw new Error(parsed.message);
    const request = createReproRequest(parsed.request);
    expect(request).toMatchObject({ kind: 'bisect', status: 'waiting', steps: null, jobVerdict: null });
    expect(updateReproRequest(request.id, { status: 'running', projectId: 3 })?.status).toBe('running');
    const commit = { sha: BAD, subject: 'Drop the coupon cache', author: 'Ada', date: null };
    updateReproRequest(request.id, { status: 'done', jobVerdict: { kind: 'first-bad', commit } });
    expect(getReproRequest(request.id)).toMatchObject({
      status: 'done',
      jobVerdict: { kind: 'first-bad', commit },
      job: { clusterId: 214 },
      instanceUrl: 'https://piwi.example.com',
    });
  });
});

const DELAY = { kind: 'delay', route: 'GET /api/cart', ms: 1800, match: 'all' };

const arm = (id: string, conditions: unknown[], runs = 10) => ({
  id,
  label: id === 'control' ? 'control' : 'delay GET /api/cart 1.8 s',
  suspectId: id === 'control' ? null : 'slow-route:GET /api/cart',
  rank: id === 'control' ? null : 1,
  conditions,
  runs,
  stopAt: id === 'control' ? null : 3,
});

/** A reproduce plan as the team instance answers it, suspects' text included. */
const labPlan = {
  version: 1,
  experimentId: '77',
  kind: 'reproduce',
  projectId: 7,
  testCaseId: 9,
  test: { file: 'tests\\cart.spec.ts', title: 'applies the coupon', suite: ['cart'], project: 'chromium' },
  displayTitle: 'cart › applies the coupon',
  windowDays: 14,
  failures: 6,
  passes: 40,
  failureCommit: BAD.toUpperCase(),
  medianDurationMs: 1800,
  errorSignatures: ['Expected <n> to be <n>'],
  suspects: [
    { rank: 1, id: 'slow-route:GET /api/cart', label: 'slow GET /api/cart', sentence: 'Slower when it fails.' },
  ],
  control: arm('control', []),
  arms: [arm('suspect-1', [DELAY])],
  combined: null,
  verifies: null,
};

const labJob = {
  kind: 'flake-lab',
  commit: BAD,
  plan: labPlan,
  title: 'cart › applies the coupon',
  instanceUrl: 'https://piwi.example.com/',
  clusterId: 214,
};

describe("an editor's Flake Lab job", () => {
  it('reads the plan the lab runs: paths with forward slashes, the commit lower-cased, no suspects to print', () => {
    const parsed = parseReproRequest('application/json', labJob);
    expect(parsed).toEqual({
      ok: true,
      request: {
        kind: 'flake-lab',
        job: {
          commit: BAD,
          good: null,
          tests: [
            { filePath: 'tests/cart.spec.ts', title: 'cart › applies the coupon', line: null, projectName: 'chromium' },
          ],
          browser: null,
          clusterId: 214,
          plan: {
            ...labPlan,
            test: { ...labPlan.test, file: 'tests/cart.spec.ts' },
            failureCommit: BAD,
            suspects: [],
            verifies: null,
          },
        },
        title: 'cart › applies the coupon',
        instanceUrl: 'https://piwi.example.com',
      },
    });
  });

  it('refuses a plan that could put a flag or a path outside the folder on the command line', () => {
    const refused = (plan: Record<string, unknown>) =>
      parseReproRequest('application/json', { ...labJob, plan: { ...labPlan, ...plan } });
    const other = (file: string) => ({ kind: 'alongside', test: { file, title: 'resets the catalog', suite: [] } });
    expect(refused({ test: { ...labPlan.test, file: '--config=evil.ts' } })).toMatchObject({
      ok: false,
      statusCode: 400,
    });
    expect(refused({ test: { ...labPlan.test, project: 'x --config=evil.ts' } })).toMatchObject({ ok: false });
    for (const file of ['--config=evil.ts', '/etc/passwd', 'C:\\x.spec.ts', '../outside.spec.ts']) {
      expect(refused({ arms: [arm('suspect-1', [other(file)])] })).toMatchObject({ ok: false, statusCode: 400 });
    }
    expect(refused({ arms: [arm('suspect-1', [{ kind: 'project', name: 'x --config=evil.ts' }])] })).toMatchObject({
      ok: false,
    });
    expect(refused({ arms: [arm('suspect-1', [{ kind: 'shell', command: 'rm -rf /' }])] })).toMatchObject({
      ok: false,
    });
    expect(refused({ arms: [arm('--grep', [DELAY])] })).toMatchObject({ ok: false });
    expect(refused({ control: arm('control', [DELAY]) })).toMatchObject({ ok: false });
    expect(refused({ kind: 'verify' })).toMatchObject({ ok: false });
    expect(refused({ arms: [arm('suspect-1', [DELAY], 1000)] })).toMatchObject({ ok: false });
    expect(parseReproRequest('application/json', { ...labJob, commit: 'HEAD~3' })).toMatchObject({ ok: false });
    expect(parseReproRequest('application/json', { ...labJob, plan: undefined })).toMatchObject({ ok: false });
    // A test that runs alongside, named inside the folder, is a condition like any other.
    expect(refused({ arms: [arm('suspect-1', [other('tests/catalog.spec.ts')])] })).toMatchObject({ ok: true });
  });

  it('carries what the lab measured for the editor to read, and refuses a report that is not one', () => {
    const parsed = parseReproRequest('application/json', labJob);
    if (!parsed.ok) throw new Error(parsed.message);
    const request = createReproRequest(parsed.request);
    expect(request).toMatchObject({
      kind: 'flake-lab',
      status: 'waiting',
      steps: null,
      job: { plan: { experimentId: '77' } },
    });
    updateReproRequest(request.id, { status: 'running', projectId: 3 });
    const report = {
      verdict: 'reproduced' as const,
      reproducingArm: 'suspect-1',
      commit: BAD,
      arms: [
        { id: 'control', runs: 10, matchingFailures: 0, otherFailures: 0, discardedRounds: 0, stoppedEarly: false },
        { id: 'suspect-1', runs: 4, matchingFailures: 3, otherFailures: 1, discardedRounds: 0, stoppedEarly: true },
      ],
    };
    const patch = reproRequestPatchSchema.parse({ status: 'done', jobVerdict: { kind: 'lab', report } });
    updateReproRequest(request.id, patch);
    expect(getReproRequest(request.id)).toMatchObject({ status: 'done', jobVerdict: { kind: 'lab', report } });
    expect(
      reproRequestPatchSchema.safeParse({
        status: 'done',
        jobVerdict: { kind: 'lab', report: { ...report, verdict: 'verified' } },
      }).success,
    ).toBe(false);
    expect(
      reproRequestPatchSchema.safeParse({
        status: 'done',
        jobVerdict: { kind: 'lab', report: { ...report, arms: [] } },
      }).success,
    ).toBe(false);
  });

  it("reads `piwi flake --json`'s report into the arms that ran", () => {
    const printed = {
      kind: 'reproduce',
      testCaseId: 9,
      experimentId: '77',
      commit: BAD,
      verdict: 'not-reproduced',
      reproducingArm: null,
      uploaded: false,
      arms: [
        {
          id: 'control',
          label: 'control',
          runs: 10,
          matchingFailures: 0,
          otherFailures: 1,
          discardedRounds: 0,
          stoppedEarly: false,
          skipped: null,
        },
        {
          id: 'suspect-1',
          label: 'delay',
          runs: 10,
          matchingFailures: 1,
          otherFailures: 0,
          discardedRounds: 2,
          stoppedEarly: false,
          skipped: null,
        },
        {
          id: 'suspect-2',
          label: 'after',
          runs: 0,
          matchingFailures: 0,
          otherFailures: 0,
          discardedRounds: 0,
          stoppedEarly: false,
          skipped: 'budget spent',
        },
      ],
    };
    expect(flakeLabJobReport(printed)).toEqual({
      verdict: 'not-reproduced',
      reproducingArm: null,
      commit: BAD,
      arms: [
        { id: 'control', runs: 10, matchingFailures: 0, otherFailures: 1, discardedRounds: 0, stoppedEarly: false },
        { id: 'suspect-1', runs: 10, matchingFailures: 1, otherFailures: 0, discardedRounds: 2, stoppedEarly: false },
      ],
    });
    expect(flakeLabJobReport(null)).toBeNull();
    expect(flakeLabJobReport({ ...printed, kind: 'verify', verdict: 'verified' })).toBeNull();
    expect(flakeLabJobReport({ ...printed, arms: printed.arms.slice(1) })).toBeNull();
    expect(flakeLabJobReport({ ...printed, commit: 'not a sha' })?.commit).toBeNull();
  });
});

describe('desktopJobVerdict', () => {
  const run = (patch: Partial<JobRunOutcome>): JobRunOutcome => ({
    kind: 'reproduce',
    status: 'failed',
    phase: 'test',
    bisect: null,
    lines: [],
    ...patch,
  });

  it('reads a reproduction from how its tests ended', () => {
    expect(desktopJobVerdict(run({ status: 'failed' }))).toEqual({ kind: 'reproduced' });
    expect(desktopJobVerdict(run({ status: 'passed' }))).toEqual({ kind: 'not-reproduced' });
    expect(desktopJobVerdict(run({ status: 'stopped' }))).toEqual({ kind: 'stopped' });
    expect(desktopJobVerdict(run({ phase: 'install', lines: [{ text: 'npm ci failed', error: true }] }))).toEqual({
      kind: 'error',
      reason: 'npm ci failed',
    });
  });

  it("reads a Flake Lab job from the lab's report, and an error when it printed none", () => {
    const labReport = {
      verdict: 'amplified' as const,
      reproducingArm: null,
      commit: BAD,
      arms: [
        { id: 'control', runs: 10, matchingFailures: 0, otherFailures: 0, discardedRounds: 0, stoppedEarly: false },
      ],
    };
    expect(desktopJobVerdict(run({ kind: 'flake', phase: 'lab', labReport }))).toEqual({
      kind: 'lab',
      report: labReport,
    });
    expect(
      desktopJobVerdict(run({ kind: 'flake', phase: 'lab', lines: [{ text: 'piwi flake: no plan', error: true }] })),
    ).toEqual({ kind: 'error', reason: 'piwi flake: no plan' });
    expect(desktopJobVerdict(run({ kind: 'flake', status: 'stopped', labReport }))).toEqual({ kind: 'stopped' });
  });

  it('reads a bisect from the commit it named', () => {
    const firstBad = { sha: BAD, subject: 'Drop the cache', author: null, date: null };
    expect(desktopJobVerdict(run({ kind: 'bisect', phase: 'bisect', bisect: { firstBad } }))).toEqual({
      kind: 'first-bad',
      commit: firstBad,
    });
    expect(desktopJobVerdict(run({ kind: 'bisect', bisect: { firstBad: null } }))).toMatchObject({ kind: 'error' });
  });
});

describe('linking a local run by its origin reference', () => {
  let db: TempDb;
  let close: () => Promise<void>;

  beforeEach(async () => {
    ({ db, close } = await openTempDb());
    await db.insert(schema.projects).values({ id: 1, name: 'shop' });
  });
  afterEach(async () => {
    await close();
  });

  it('finds the run stamped with the reference, not the newest run of the project', async () => {
    const mine = newLocalRunRef('desktop');
    const theirs = newLocalRunRef('desktop');
    expect(parseRunOriginRef(mine)).toBe(mine);
    expect(mine).not.toBe(theirs);
    const at = (s: number) => new Date(Date.UTC(2026, 9, 3, 10, 0, s));
    await db.insert(schema.testRuns).values(
      [
        {
          id: 10,
          projectId: 1,
          status: 'passed',
          startTime: at(1),
          metadata: { piwiOrigin: { kind: 'desktop', ref: mine } },
        },
        {
          id: 11,
          projectId: 1,
          status: 'failed',
          startTime: at(2),
          metadata: { piwiOrigin: { kind: 'desktop', ref: theirs } },
        },
        {
          id: 12,
          projectId: 1,
          status: 'failed',
          startTime: at(3),
          metadata: { piwiOrigin: { kind: 'reproduce', ref: '7' } },
        },
        {
          id: 13,
          projectId: 1,
          status: 'failed',
          startTime: at(4),
          metadata: { piwiOrigin: { kind: 'bisect', ref: '7' } },
        },
      ].map((row) => ({ ...row, origin: runOrigin(row.metadata) })),
    );
    expect(await getProjectLatestRun(db, 1)).toEqual({ id: 13, status: 'failed' });
    expect(await getProjectLatestRun(db, 1, { kind: 'desktop', ref: mine })).toEqual({
      id: 10,
      status: 'passed',
      name: null,
    });
    expect(await getProjectLatestRun(db, 1, { kind: 'reproduce', ref: '7' })).toEqual({
      id: 12,
      status: 'failed',
      name: null,
    });
    expect(await getProjectLatestRun(db, 1, { kind: 'desktop', ref: 'desktop:none' })).toBeNull();
    expect(await getProjectLatestRun(db, 1, { kind: 'desktop', ref: '%' })).toBeNull();
    await db.insert(schema.projects).values({ id: 2, name: 'empty' });
    expect(await getProjectLatestRun(db, 2)).toBeNull();
    await expect(getProjectLatestRun(db, 3)).rejects.toThrow('Project not found');
    await expect(getProjectLatestRun(db, 3, { kind: 'desktop', ref: mine })).rejects.toThrow('Project not found');
  });

  it('stamps a test run as desktop, a reproduction and a repro request as reproduce, and links no lab session', () => {
    expect(localRunOriginKind('tests')).toBe('desktop');
    expect(localRunOriginKind('reproduce')).toBe('reproduce');
    expect(localRunOriginKind('repro')).toBe('reproduce');
    expect(localRunOriginKind('bisect')).toBe('bisect');
    expect(localRunOriginKind('flake')).toBeNull();
  });
});
