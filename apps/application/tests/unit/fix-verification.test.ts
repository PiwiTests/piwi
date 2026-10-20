import { describe, test, expect, beforeAll, beforeEach, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import { eq, sql } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';

/**
 * Fix verification against an in-memory SQLite database: the verdict, the
 * triage-status transitions it drives, the system lines it appends to the
 * triage note, and the notifications it emits. SCM is mocked so the diff can
 * corroborate (or not) the diagnosis without a network.
 */

const emitted: Array<{ event: string; payload: Record<string, unknown> }> = [];
vi.mock('../../server/utils/notifications/emit', () => ({
  emitNotification: async (_db: unknown, event: string, payload: Record<string, unknown>) => {
    emitted.push({ event, payload });
  },
}));

let changedFiles: string[] = [];
let changedCommits: Array<{ sha: string; message: string; fullMessage?: string }> = [];
let commitAuthor: { name: string; email: string } | null = null;
// The repository's files at the run's commit, by repo-relative path.
let filesAtRef: Record<string, string> = {};
vi.mock('../../server/utils/scm', () => ({
  createScmProvider: async () => ({
    fetchChanges: async () => ({ commits: changedCommits, files: changedFiles.map((filename) => ({ filename })) }),
    getCommitAuthor: async () => commitAuthor,
    getDefaultBranch: async () => 'main',
    fetchFileAtRef: async (path: string) =>
      path in filesAtRef ? { path, content: filesAtRef[path]!, truncated: false } : null,
  }),
}));

// The schema barrel (server/database/schema.ts) picks the PostgreSQL schema at
// import time when PIWI_DATABASE_URL is set, so clear it before the module
// under test (which imports the barrel) is loaded.
delete process.env.PIWI_DATABASE_URL;
const { verifyClusterFixes, appendTriageNote, classifyQuietRun, healKeysFromCommits } =
  await import('../../server/utils/fix-verification');
const { getClusterPatchFacts, getFailureCluster } = await import('../../shared/handlers/failure-clusters');

type Db = ReturnType<typeof drizzle<typeof schema>>;
let db: Db;
let runSeq = 0;
let clusterSeq = 0;

const REMOTE = 'https://github.com/acme/shop.git';

async function insertRun(
  status: 'passed' | 'failed',
  commit: string,
  opts: { isFullRun?: boolean; branch?: string; origin?: string } = {},
) {
  const id = ++runSeq;
  const branch = opts.branch ?? 'main';
  await db.insert(schema.testRuns).values({
    id,
    projectId: 1,
    status,
    startTime: new Date(Date.UTC(2026, 0, 1) + id * 3_600_000),
    isFullRun: opts.isFullRun === false ? 0 : 1,
    environment: 'staging',
    branch,
    metadata: {
      scm: { commit, remoteUrl: REMOTE, branch },
      ...(opts.origin ? { piwiOrigin: { kind: opts.origin } } : {}),
    },
  });
  return id;
}

async function insertCluster(opts: { status?: string; triageNote?: string | null; firstSeenRunId: number }) {
  const id = ++clusterSeq;
  await db.insert(schema.failureClusters).values({
    id,
    projectId: 1,
    fingerprint: `fp-${id}`,
    signature: `Error: card declined ${id}`,
    errorType: 'unknown',
    firstSeenRunId: opts.firstSeenRunId,
    lastSeenRunId: opts.firstSeenRunId,
    status: opts.status ?? 'open',
    triageNote: opts.triageNote ?? null,
  });
  return id;
}

async function insertCase(runId: number, status: 'passed' | 'failed', clusterId: number | null, testCaseId = 1) {
  await db.insert(schema.testRunsCases).values({ testRunId: runId, testCaseId, status, failureClusterId: clusterId });
}

async function markSeen(clusterId: number, runId: number) {
  await db.update(schema.failureClusters).set({ lastSeenRunId: runId }).where(eq(schema.failureClusters.id, clusterId));
}

/**
 * A completed cluster diagnosis whose patch changes the line `a` into `b` in
 * `file`, with the validation it stored when it was made, if any.
 */
async function insertDiagnosis(clusterId: number, file: string, opts: { validated?: 'applies' } = {}) {
  await db.insert(schema.failureDiagnoses).values({
    clusterId,
    scope: 'cluster',
    status: 'completed',
    details: {
      suggestedFix: { patch: `--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-a\n+b\n` },
      ...(opts.validated
        ? { patchValidation: { status: opts.validated, filesChecked: 1, filesInPatch: 1, errors: [] } }
        : {}),
    },
  });
}

async function cluster(id: number) {
  const [row] = await db.select().from(schema.failureClusters).where(eq(schema.failureClusters.id, id));
  return row!;
}

beforeAll(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrate(db, {
    migrationsFolder: fileURLToPath(new URL('../../server/database/migrations', import.meta.url)),
  });
  await db.insert(schema.projects).values({ id: 1, name: 'shop', label: 'Shop' });
  await db.insert(schema.testCases).values([
    { id: 1, projectId: 1, filePath: 'tests/checkout.spec.ts', title: 'pays' },
    { id: 2, projectId: 1, filePath: 'tests/checkout.spec.ts', title: 'refunds' },
  ]);
});

beforeEach(() => {
  emitted.length = 0;
  changedFiles = [];
  changedCommits = [];
  commitAuthor = null;
  filesAtRef = {};
});

describe('appendTriageNote', () => {
  test('keeps what a person wrote and adds the system line below it', () => {
    expect(appendTriageNote('Closed by hand', 'Reopened automatically: regressed in run #3')).toBe(
      'Closed by hand\nReopened automatically: regressed in run #3',
    );
    expect(appendTriageNote('  ', 'line')).toBe('line');
    expect(appendTriageNote(null, 'line')).toBe('line');
  });
});

describe('verifyClusterFixes — status transitions', () => {
  test('a diagnosis-verified fix resolves an open cluster, notes why, and emits cluster.fixed', async () => {
    const failing = await insertRun('failed', 'aaa111');
    const clusterId = await insertCluster({ firstSeenRunId: failing });
    await insertCase(failing, 'failed', clusterId);
    await insertDiagnosis(clusterId, 'src/checkout.ts');
    changedFiles = ['src/checkout.ts'];

    const green = await insertRun('passed', 'bbb222');
    await insertCase(green, 'passed', null);

    const fixed = await verifyClusterFixes(db, green);
    expect(fixed.map((f) => [f.clusterId, f.verification])).toEqual([[clusterId, 'diagnosis-verified']]);

    const row = await cluster(clusterId);
    expect(row.fixVerification).toBe('diagnosis-verified');
    expect(row.fixLandedRunId).toBe(green);
    expect(row.status).toBe('resolved');
    expect(row.triageNote).toBe(`Resolved automatically: diagnosis verified in run #${green}`);

    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.event).toBe('cluster.fixed');
    expect(emitted[0]!.payload).toMatchObject({
      clusterId,
      projectId: 1,
      projectName: 'Shop',
      runId: green,
      branch: 'main',
      environment: 'staging',
      verification: 'diagnosis-verified',
      commit: 'bbb222',
      resolved: true,
      testCount: 1,
    });
  });

  test('a stopped-failing fix leaves the triage status alone but still emits cluster.fixed', async () => {
    const failing = await insertRun('failed', 'ccc333');
    const clusterId = await insertCluster({ firstSeenRunId: failing, triageNote: 'Looking into it' });
    await insertCase(failing, 'failed', clusterId);
    // The diagnosis names a file the fixing commit did not touch.
    await insertDiagnosis(clusterId, 'src/checkout.ts');
    changedFiles = ['README.md'];

    const green = await insertRun('passed', 'ddd444');
    await insertCase(green, 'passed', null);
    await verifyClusterFixes(db, green);

    const row = await cluster(clusterId);
    expect(row.fixVerification).toBe('stopped-failing');
    expect(row.status).toBe('open');
    expect(row.triageNote).toBe('Looking into it');
    expect(emitted.map((e) => e.event)).toEqual(['cluster.fixed']);
    expect(emitted[0]!.payload).toMatchObject({ verification: 'stopped-failing', resolved: false });
  });

  test('a diagnosis-verified fix never touches an ignored cluster', async () => {
    const failing = await insertRun('failed', 'eee555');
    const clusterId = await insertCluster({ firstSeenRunId: failing, status: 'ignored', triageNote: 'Known, ignore' });
    await insertCase(failing, 'failed', clusterId);
    await insertDiagnosis(clusterId, 'src/checkout.ts');
    changedFiles = ['src/checkout.ts'];

    const green = await insertRun('passed', 'fff666');
    await insertCase(green, 'passed', null);
    await verifyClusterFixes(db, green);

    const row = await cluster(clusterId);
    expect(row.fixVerification).toBe('diagnosis-verified');
    expect(row.status).toBe('ignored');
    expect(row.triageNote).toBe('Known, ignore');
    expect(emitted[0]!.payload).toMatchObject({ resolved: false });
  });

  test('a regression reopens a resolved cluster with a note and emits cluster.regressed', async () => {
    const failing = await insertRun('failed', '111aaa');
    const clusterId = await insertCluster({ firstSeenRunId: failing });
    await insertCase(failing, 'failed', clusterId);
    await insertDiagnosis(clusterId, 'src/checkout.ts');
    changedFiles = ['src/checkout.ts'];

    const green = await insertRun('passed', '222bbb');
    await insertCase(green, 'passed', null);
    await verifyClusterFixes(db, green);
    expect((await cluster(clusterId)).status).toBe('resolved');
    emitted.length = 0;

    const red = await insertRun('failed', '333ccc');
    await insertCase(red, 'failed', clusterId);
    await markSeen(clusterId, red);
    const fixed = await verifyClusterFixes(db, red);
    expect(fixed).toEqual([]);

    const row = await cluster(clusterId);
    expect(row.fixVerification).toBe('regressed');
    expect(row.status).toBe('open');
    expect(row.triageNote).toBe(
      `Resolved automatically: diagnosis verified in run #${green}\nReopened automatically: regressed in run #${red}`,
    );

    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.event).toBe('cluster.regressed');
    expect(emitted[0]!.payload).toMatchObject({
      clusterId,
      projectName: 'Shop',
      runId: red,
      branch: 'main',
      environment: 'staging',
      fixLandedRunId: green,
      reopened: true,
    });
  });

  test('a regression on a cluster that was still open only records the verdict', async () => {
    const failing = await insertRun('failed', '444ddd');
    const clusterId = await insertCluster({ firstSeenRunId: failing });
    await insertCase(failing, 'failed', clusterId);
    changedFiles = [];

    const green = await insertRun('passed', '555eee');
    await insertCase(green, 'passed', null);
    await verifyClusterFixes(db, green);
    expect((await cluster(clusterId)).status).toBe('open');
    emitted.length = 0;

    const red = await insertRun('failed', '666fff');
    await insertCase(red, 'failed', clusterId);
    await markSeen(clusterId, red);
    await verifyClusterFixes(db, red);

    const row = await cluster(clusterId);
    expect(row.fixVerification).toBe('regressed');
    expect(row.status).toBe('open');
    expect(row.triageNote).toBeNull();
    expect(emitted.map((e) => e.event)).toEqual(['cluster.regressed']);
    expect(emitted[0]!.payload).toMatchObject({ reopened: false });
  });

  test('a partial run that covers every affected test records the fix', async () => {
    // Cluster on test case 2 so it does not collide with the many case-1
    // clusters this serial suite accumulates.
    const failing = await insertRun('failed', '777aaa');
    const clusterId = await insertCluster({ firstSeenRunId: failing });
    await insertCase(failing, 'failed', clusterId, 2);

    // A filtered re-run of exactly the affected test, passing, is enough.
    const partial = await insertRun('passed', '888bbb', { isFullRun: false });
    await insertCase(partial, 'passed', null, 2);

    const fixed = await verifyClusterFixes(db, partial);
    expect(fixed.some((f) => f.clusterId === clusterId)).toBe(true);
    expect((await cluster(clusterId)).fixLandedRunId).toBe(partial);
  });

  test('a partial run that misses an affected test records nothing', async () => {
    const failing = await insertRun('failed', '999aaa');
    const clusterId = await insertCluster({ firstSeenRunId: failing });
    // The cluster covers two tests (1 and 2).
    await insertCase(failing, 'failed', clusterId, 1);
    await insertCase(failing, 'failed', clusterId, 2);

    // A filtered run that ran only one of them proves nothing: the other was
    // never shown to pass.
    const partial = await insertRun('passed', '999bbb', { isFullRun: false });
    await insertCase(partial, 'passed', null, 1);

    const fixed = await verifyClusterFixes(db, partial);
    expect(fixed.some((f) => f.clusterId === clusterId)).toBe(false);
    expect((await cluster(clusterId)).fixLandedRunId).toBeNull();
  });

  test('cluster.fixed carries the resolved fix author on the payload', async () => {
    const failing = await insertRun('failed', 'a10aaa');
    const clusterId = await insertCluster({ firstSeenRunId: failing });
    await insertCase(failing, 'failed', clusterId, 2);
    commitAuthor = { name: 'Ada Lovelace', email: 'ada@example.com' };

    const green = await insertRun('passed', 'a10bbb');
    await insertCase(green, 'passed', null, 2);
    await verifyClusterFixes(db, green);

    const mine = emitted.find((e) => (e.payload as { clusterId?: number }).clusterId === clusterId);
    expect(mine?.event).toBe('cluster.fixed');
    expect(mine?.payload).toMatchObject({ fixAuthor: { name: 'Ada Lovelace', email: 'ada@example.com' } });
  });
});

describe('verifyClusterFixes — a cluster that cannot be verified', () => {
  test('leaves the other clusters of the run verified', async () => {
    const failing = await insertRun('failed', 'eee555');
    const broken = await insertCluster({ firstSeenRunId: failing });
    const healthy = await insertCluster({ firstSeenRunId: failing });
    await insertCase(failing, 'failed', broken, 1);
    await insertCase(failing, 'failed', healthy, 2);
    // The database refuses the broken cluster's write, as PostgreSQL refused a time to resolution past int4.
    await db.run(
      sql.raw(
        `create trigger refuse_fix_${broken} before update of fix_landed_run_id on failure_clusters ` +
          `when new.id = ${broken} begin select raise(abort, 'integer out of range'); end`,
      ),
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const green = await insertRun('passed', 'fff666');
      await insertCase(green, 'passed', null, 1);
      await insertCase(green, 'passed', null, 2);

      const fixed = (await verifyClusterFixes(db, green)).map((f) => f.clusterId);
      expect(fixed).toContain(healthy);
      expect(fixed).not.toContain(broken);
      expect((await cluster(healthy)).fixLandedRunId).toBe(green);
      expect((await cluster(broken)).fixLandedRunId).toBeNull();
      expect(emitted.filter((e) => e.event === 'cluster.fixed').map((e) => e.payload.clusterId)).toContain(healthy);
    } finally {
      vi.mocked(console.error).mockRestore();
      await db.run(sql.raw(`drop trigger refuse_fix_${broken}`));
      // The tests below share the database: the broken cluster must not wait for their runs.
      await db.delete(schema.testRunsCases).where(eq(schema.testRunsCases.failureClusterId, broken));
      await db.delete(schema.failureClusters).where(eq(schema.failureClusters.id, broken));
    }
  });
});

describe('classifyQuietRun', () => {
  const base = { runBranch: 'main', runCommit: 'b', failedBranch: 'main', failedCommit: 'a', defaultBranch: 'main' };

  test('a new commit on the failing branch is a fix', () => {
    expect(classifyQuietRun(base)).toBe('fix');
  });

  test('the failing commit is flake evidence, whatever the branch', () => {
    expect(classifyQuietRun({ ...base, runCommit: 'a' })).toBe('same-commit');
  });

  test('another branch counts only when it is the default branch', () => {
    expect(classifyQuietRun({ ...base, runBranch: 'feature/x' })).toBe('other-branch');
    expect(classifyQuietRun({ ...base, failedBranch: 'feature/x' })).toBe('fix');
    expect(classifyQuietRun({ ...base, runBranch: null })).toBe('other-branch');
  });

  test('unknown commits and branches on both sides are not compared', () => {
    expect(classifyQuietRun({ ...base, runCommit: null })).toBe('fix');
    expect(classifyQuietRun({ ...base, runBranch: null, failedBranch: null, defaultBranch: null })).toBe('fix');
  });
});

describe('verifyClusterFixes — which quiet runs count', () => {
  test('a pass at the failing commit is flake evidence; a pass at a new default-branch commit is the fix', async () => {
    const failing = await insertRun('failed', 'c0ffee1');
    const clusterId = await insertCluster({ firstSeenRunId: failing });
    await insertCase(failing, 'failed', clusterId);

    const rerun = await insertRun('passed', 'c0ffee1');
    await insertCase(rerun, 'passed', null);
    expect(await verifyClusterFixes(db, rerun)).toEqual([]);
    let row = await cluster(clusterId);
    expect(row.fixLandedRunId).toBeNull();
    expect(row.status).toBe('open');
    expect(row.flakeEvidenceRunId).toBe(rerun);
    expect(emitted.filter((e) => e.event === 'cluster.fixed')).toEqual([]);

    const next = await insertRun('passed', 'c0ffee2');
    await insertCase(next, 'passed', null);
    const fixed = await verifyClusterFixes(db, next);
    expect(fixed.map((f) => f.clusterId)).toEqual([clusterId]);
    row = await cluster(clusterId);
    expect(row.fixLandedRunId).toBe(next);
    expect(row.fixCommit).toBe('c0ffee2');
  });

  test('a pass on another branch records nothing; a pass on the cluster’s own branch records the fix', async () => {
    const failing = await insertRun('failed', 'dd00001', { branch: 'feature/cart' });
    const clusterId = await insertCluster({ firstSeenRunId: failing });
    await insertCase(failing, 'failed', clusterId);

    const elsewhere = await insertRun('passed', 'dd00002', { branch: 'feature/other' });
    await insertCase(elsewhere, 'passed', null);
    expect(await verifyClusterFixes(db, elsewhere)).toEqual([]);
    expect((await cluster(clusterId)).fixLandedRunId).toBeNull();

    const sameBranch = await insertRun('passed', 'dd00003', { branch: 'feature/cart' });
    await insertCase(sameBranch, 'passed', null);
    expect((await verifyClusterFixes(db, sameBranch)).map((f) => f.clusterId)).toEqual([clusterId]);
  });

  test.each(['bisect', 'reproduce'])('a %s run at a new commit records no fix and no regression', async (origin) => {
    const failing = await insertRun('failed', `ee0000${origin.length}`);
    const clusterId = await insertCluster({ firstSeenRunId: failing });
    await insertCase(failing, 'failed', clusterId);

    const step = await insertRun('passed', `ee1111${origin.length}`, { origin });
    await insertCase(step, 'passed', null);
    expect(await verifyClusterFixes(db, step)).toEqual([]);
    const row = await cluster(clusterId);
    expect(row.fixLandedRunId).toBeNull();
    expect(row.flakeEvidenceRunId).toBeNull();

    const local = await insertRun('passed', `ee2222${origin.length}`, { origin: 'local' });
    await insertCase(local, 'passed', null);
    expect((await verifyClusterFixes(db, local)).map((f) => f.clusterId)).toEqual([clusterId]);
  });
});

describe('verifyClusterFixes — diagnosis outcomes', () => {
  const diagnosisOutcomes = async (clusterId: number) =>
    (await db.select().from(schema.handbackOutcomes))
      .filter((o) => o.kind === 'diagnosis' && o.subjectId === clusterId)
      .map((o) => ({ outcome: o.outcome, key: o.suggestionKey, runId: o.runId, channel: o.channel }));

  test('a diagnosis-verified fix verifies the diagnosis version current when it landed, and a regression regresses it', async () => {
    const failing = await insertRun('failed', 'd1a000');
    const clusterId = await insertCluster({ firstSeenRunId: failing });
    await insertCase(failing, 'failed', clusterId);
    await insertDiagnosis(clusterId, 'src/checkout.ts');
    const [diagnosis] = await db
      .select()
      .from(schema.failureDiagnoses)
      .where(eq(schema.failureDiagnoses.clusterId, clusterId));
    const key = `${diagnosis!.id}@${diagnosis!.createdAt.getTime()}`;
    changedFiles = ['src/checkout.ts'];

    const green = await insertRun('passed', 'd1b000');
    await insertCase(green, 'passed', null);
    await verifyClusterFixes(db, green);
    expect(await diagnosisOutcomes(clusterId)).toEqual([
      { outcome: 'verified', key, runId: green, channel: 'inferred' },
    ]);

    // A re-verified diagnosis is a new version: it starts again, so it carries a new key.
    await db
      .update(schema.failureDiagnoses)
      .set({ createdAt: new Date(diagnosis!.createdAt.getTime() + 60_000) })
      .where(eq(schema.failureDiagnoses.id, diagnosis!.id));

    const red = await insertRun('failed', 'd1c000');
    await insertCase(red, 'failed', clusterId);
    await markSeen(clusterId, red);
    await verifyClusterFixes(db, red);
    expect(await diagnosisOutcomes(clusterId)).toEqual([
      { outcome: 'verified', key, runId: green, channel: 'inferred' },
      { outcome: 'regressed', key, runId: red, channel: 'inferred' },
    ]);
  });

  test('a stopped-failing fix and its regression record no diagnosis outcome', async () => {
    const failing = await insertRun('failed', 'd2a000');
    const clusterId = await insertCluster({ firstSeenRunId: failing });
    await insertCase(failing, 'failed', clusterId);
    await insertDiagnosis(clusterId, 'src/checkout.ts');
    changedFiles = ['README.md'];

    const green = await insertRun('passed', 'd2b000');
    await insertCase(green, 'passed', null);
    await verifyClusterFixes(db, green);
    const red = await insertRun('failed', 'd2c000');
    await insertCase(red, 'failed', clusterId);
    await markSeen(clusterId, red);
    await verifyClusterFixes(db, red);

    expect(await diagnosisOutcomes(clusterId)).toEqual([]);
  });
});

describe("verifyClusterFixes — the diagnosed patch at the fix's commit", () => {
  // A diagnosis-verified fix on a cluster whose diagnosis validated its patch
  // against the code the model was shown, before the fix. The cluster is then
  // reopened, as the state line and the next step speak about open clusters.
  async function verifiedFix(commit: string, files: { changed: string[]; atFix: Record<string, string> }) {
    const failing = await insertRun('failed', `${commit}-red`);
    const clusterId = await insertCluster({ firstSeenRunId: failing });
    await insertCase(failing, 'failed', clusterId);
    await insertDiagnosis(clusterId, 'src/checkout.ts', { validated: 'applies' });
    changedFiles = files.changed;
    filesAtRef = files.atFix;

    const green = await insertRun('passed', commit);
    await insertCase(green, 'passed', null);
    await verifyClusterFixes(db, green);
    await db.update(schema.failureClusters).set({ status: 'open' }).where(eq(schema.failureClusters.id, clusterId));
    const [diagnosis] = await db
      .select({ details: schema.failureDiagnoses.details })
      .from(schema.failureDiagnoses)
      .where(eq(schema.failureDiagnoses.clusterId, clusterId));
    const check = (diagnosis!.details as { patchValidationAtFix?: Record<string, unknown> }).patchValidationAtFix;
    return { clusterId, green, check };
  }

  test('the fix is the diagnosed change: the patch validated before it says nothing, the cluster reads fixed', async () => {
    const { clusterId, green, check } = await verifiedFix('fa1000', {
      changed: ['src/checkout.ts'],
      atFix: { 'src/checkout.ts': 'b\n' },
    });
    expect(check).toMatchObject({ status: 'stale-file', inCode: true, runId: green, commit: 'fa1000' });

    const facts = await getClusterPatchFacts(db as never, clusterId, { fixLandedRunId: green });
    // Validated when it was diagnosed, before the fix: it applied then.
    expect(facts.patchAppliesCleanly).toBe(true);
    expect(facts.patchAppliesAtFix).toBe(false);

    const detail = (await getFailureCluster(db as never, clusterId))!;
    expect(detail.clusterState.kind).toBe('fix-verified-open');
    expect(detail.clusterState.action).toBe('mark-resolved');
    expect(detail.nextStep.kind).toBe('mark-resolved');
  });

  test('another change fixed it: the patch still applies at the fix, so the fix is unconfirmed', async () => {
    // The patch names the path relative to a package root; the range's changed
    // files give its repository path.
    const { clusterId, green, check } = await verifiedFix('fa2000', {
      changed: ['apps/web/src/checkout.ts'],
      atFix: { 'apps/web/src/checkout.ts': 'a\n' },
    });
    expect(check).toMatchObject({ status: 'applies', inCode: false, runId: green, commit: 'fa2000' });

    expect((await getClusterPatchFacts(db as never, clusterId, { fixLandedRunId: green })).patchAppliesAtFix).toBe(
      true,
    );
    // The check belongs to that fix: another fix run is not covered by it.
    expect((await getClusterPatchFacts(db as never, clusterId, { fixLandedRunId: green + 1 })).patchAppliesAtFix).toBe(
      false,
    );

    const detail = (await getFailureCluster(db as never, clusterId))!;
    expect(detail.clusterState.kind).toBe('fix-unconfirmed');
    expect(detail.clusterState.action).toBeNull();
    expect(detail.nextStep.kind).toBe('apply-patch');
    expect(detail.nextStep.secondary.map((a) => a.action)).toContain('mark-resolved');
  });

  test('a file the check cannot read claims nothing', async () => {
    const { clusterId, green, check } = await verifiedFix('fa3000', { changed: ['src/checkout.ts'], atFix: {} });
    expect(check).toMatchObject({ status: 'unchecked', inCode: false, runId: green });
    expect((await getClusterPatchFacts(db as never, clusterId, { fixLandedRunId: green })).patchAppliesAtFix).toBe(
      false,
    );
  });
});

describe('verifyClusterFixes — the auto-heal PR that landed the fix', () => {
  async function insertHealAction(dedupeKey: string, clusterId: number, prNumber: number, status = 'merged') {
    await db.insert(schema.healActions).values({
      projectId: 1,
      dedupeKey,
      status,
      payload: { repositoryUrl: REMOTE, branch: `piwi/heal/1-${prNumber}`, edits: [{ clusterId, executionId: 1 }] },
      result: { prNumber, prUrl: `https://github.com/acme/shop/pull/${prNumber}`, commitSha: 'h', branch: 'b' },
    });
  }

  test('a Piwi-Heal trailer in the commits since the last failure names the PR on the fix and the event', async () => {
    const failing = await insertRun('failed', 'b1aaaa');
    const clusterId = await insertCluster({ firstSeenRunId: failing });
    await insertCase(failing, 'failed', clusterId, 2);
    await insertHealAction('heal:v1:1:trailer1', clusterId, 41);
    changedCommits = [
      { sha: 'c1', message: 'chore: unrelated' },
      {
        sha: 'c2',
        message: 'test: heal broken locators',
        fullMessage: 'test: heal broken locators\n\nPiwi-Heal: heal:v1:1:trailer1',
      },
    ];

    const green = await insertRun('passed', 'b1bbbb');
    await insertCase(green, 'passed', null, 2);
    const fixed = await verifyClusterFixes(db, green);

    const mine = fixed.find((f) => f.clusterId === clusterId);
    expect(mine?.verification).toBe('stopped-failing');
    expect(mine?.healPr).toMatchObject({ number: 41, url: 'https://github.com/acme/shop/pull/41' });
    const event = emitted.find((e) => (e.payload as { clusterId?: number }).clusterId === clusterId);
    expect(event?.event).toBe('cluster.fixed');
    expect(event?.payload).toMatchObject({ verification: 'stopped-failing', healPr: { number: 41 } });
  });

  test('a trailer naming a heal PR whose edits are about another cluster names no PR', async () => {
    const failing = await insertRun('failed', 'b2aaaa');
    const clusterId = await insertCluster({ firstSeenRunId: failing });
    await insertCase(failing, 'failed', clusterId, 2);
    await insertHealAction('heal:v1:1:trailer2', clusterId + 1000, 42);
    changedCommits = [{ sha: 'c3', message: 'x', fullMessage: 'x\n\nPiwi-Heal: heal:v1:1:trailer2' }];

    const green = await insertRun('passed', 'b2bbbb');
    await insertCase(green, 'passed', null, 2);
    const fixed = await verifyClusterFixes(db, green);

    const mine = fixed.find((f) => f.clusterId === clusterId);
    expect(mine).toBeDefined();
    expect(mine?.healPr).toBeUndefined();
    const event = emitted.find((e) => (e.payload as { clusterId?: number }).clusterId === clusterId);
    expect(event?.payload.healPr).toBeUndefined();
  });

  test('reads the keys from full messages, falling back to the subject', () => {
    expect(
      healKeysFromCommits([
        { sha: 'a', message: 'fix: a', fullMessage: 'fix: a\n\nPiwi-Heal: k1\nCo-authored-by: Ada <a@b.c>' },
        { sha: 'b', message: 'fix: b' },
        { sha: 'c', message: 'fix: c', fullMessage: 'fix: c\n\npiwi-heal: k1' },
      ]),
    ).toEqual(['k1']);
  });
});
