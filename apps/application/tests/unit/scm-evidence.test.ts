import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import type { ScmChanges } from '../../server/utils/scm/ScmProvider';
import type { McpContext } from '../../server/utils/mcp/tools';
import type { User } from '../../server/database/schema';
import { InstanceRole, ProjectRole, buildAccessSummary } from '#shared/permissions';
import { PATCH_TRUNCATED_NOTE } from '#shared/patch';
import { openTempDb, type TempDb } from './temp-db';

/**
 * The source-control evidence the AI diagnosis and the MCP tools build from a
 * provider's diff: which range they ask for, what they say about a diff the
 * host cut, and which commit they name. The provider is a stub.
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

const scm = vi.hoisted(() => ({
  changes: null as ScmChanges | null,
  commitDiffs: new Map<string, ScmChanges>(),
  fetched: [] as Array<[string, string]>,
}));
vi.mock('../../server/utils/scm', () => ({
  detectScmProvider: () => 'github',
  resolveScmToken: async () => null,
  createScmProvider: async () => ({
    fetchChanges: async (from: string, to: string) => {
      scm.fetched.push([from, to]);
      return scm.changes;
    },
    fetchCommitDiff: async (sha: string) => scm.commitDiffs.get(sha) ?? null,
    fetchFileAtRef: async () => null,
    fetchTree: async () => [],
    getDefaultBranch: async () => 'main',
  }),
}));

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the modules under test load.
delete process.env.PIWI_DATABASE_URL;
const { buildDiagnosisContext } = await import('../../server/utils/ai-context');
const { MCP_TOOLS } = await import('../../server/utils/mcp/tools');

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 8, 1);
const REMOTE = 'https://github.com/acme/shop.git';
const SPEC = 'tests/cart.spec.ts';
const sha = (c: string) => c.repeat(40);

let db: TempDb;
let close: () => Promise<void>;

async function run(id: number, status: 'passed' | 'failed', commit: string, at: number) {
  await db.insert(schema.testRuns).values({
    id,
    projectId: 1,
    status,
    startTime: new Date(at),
    branch: 'main',
    isFullRun: 1,
    metadata: { scm: { commit, remoteUrl: REMOTE, branch: 'main' } },
    totalTests: 2,
  });
}

let executionId = 0;
async function execution(runId: number, testCaseId: number, status: 'passed' | 'failed', clusterId?: number) {
  executionId += 1;
  await db.insert(schema.testRunsCases).values({
    id: executionId,
    testRunId: runId,
    testCaseId,
    status,
    ...(status === 'failed' ? { error: "Error: locator('#total') expected 30, got -10" } : {}),
    ...(clusterId ? { failureClusterId: clusterId } : {}),
  });
}

async function cluster(id: number, firstSeenRunId: number) {
  await db.insert(schema.failureClusters).values({
    id,
    projectId: 1,
    fingerprint: `fp-${id}`,
    signature: 'expected 30, got -10',
    errorType: 'assertion',
    firstSeenRunId,
    lastSeenRunId: firstSeenRunId,
    occurrences: 1,
  });
}

const file = (filename: string, patch = '@@ -1 +1 @@\n-a\n+b') => ({
  filename,
  status: 'modified',
  additions: 1,
  deletions: 1,
  patch,
});

beforeEach(async () => {
  // The context limits read a stored setting through Nitro's auto-imported helper: none is stored.
  vi.stubGlobal('getAppSetting', async () => null);
  ({ db, close } = await openTempDb());
  executionId = 0;
  scm.changes = null;
  scm.commitDiffs.clear();
  scm.fetched.length = 0;
  await db
    .insert(schema.projects)
    .values({ id: 1, name: 'shop', defaultBranch: 'main', repositoryUrl: 'https://github.com/acme/shop' });
  await db.insert(schema.testCases).values([
    { id: 1, projectId: 1, filePath: SPEC, title: 'totals the cart' },
    { id: 2, projectId: 1, filePath: 'tests/other.spec.ts', title: 'other' },
  ]);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await close();
});

describe('the diff since the last green run', () => {
  beforeEach(async () => {
    await run(1, 'passed', sha('a'), T0);
    await execution(1, 1, 'passed');
    await run(2, 'failed', sha('b'), T0 + HOUR);
    await cluster(1, 2);
    await execution(2, 1, 'failed', 1);
  });

  test('names the newest commit of the range, the last one the provider lists', async () => {
    scm.changes = {
      commits: [
        { sha: 'aaaaaaa', message: 'Oldest change' },
        { sha: 'bbbbbbb', message: 'Newest change' },
      ],
      files: [file(SPEC)],
    };
    const context = await buildDiagnosisContext(db as never, { kind: 'cluster', clusterId: 1 });
    expect(scm.fetched).toEqual([[sha('a'), sha('b')]]);
    const top = context.sections.find((s) => s.id === 'topSuspectedCommit')!.markdown;
    expect(top).toContain('Most recent commit in range: `bbbbbbb` (Newest change)');
  });

  test('says the host listed only the first files, and marks the section truncated', async () => {
    scm.changes = {
      commits: [{ sha: 'bbbbbbb', message: 'Big change' }],
      files: [file('src/a.ts'), file('src/b.ts')],
      filesTruncated: true,
      totalChangedFiles: 412,
    };
    const context = await buildDiagnosisContext(db as never, { kind: 'cluster', clusterId: 1 });
    const diff = context.sections.find((s) => s.id === 'scmInvestigation')!;
    expect(diff.markdown).toContain('Changed files (the first 2, 412 in all):');
    expect(diff.truncated).toBe(true);
    expect(context.coverage.scm).toMatchObject({ filesTruncated: true, totalChangedFiles: 412 });
    expect(context.text).toContain('[scmInvestigation] SCM diff since last green: present (truncated)');
  });

  test('marks a patch the host cut short as truncated, and names the files that came with none', async () => {
    scm.changes = {
      commits: [{ sha: 'bbbbbbb', message: 'Change' }],
      files: [
        file('src/a.ts', `@@ -1 +1 @@\n-a\n+b\n${PATCH_TRUNCATED_NOTE}`),
        { ...file('logo.png'), patch: undefined },
      ],
    };
    const context = await buildDiagnosisContext(db as never, { kind: 'cluster', clusterId: 1 });
    const diff = context.sections.find((s) => s.id === 'scmInvestigation')!;
    expect(diff.truncated).toBe(true);
    expect(context.coverage.scm?.patchesTruncated).toBe(true);
    expect(diff.markdown).toContain('> Note: 1 changed file came with no patch');
  });

  test('says the host listed only the newest commits', async () => {
    scm.changes = {
      commits: [{ sha: 'bbbbbbb', message: 'Newest change' }],
      commitsTruncated: true,
      files: [file('src/a.ts')],
    };
    const context = await buildDiagnosisContext(db as never, { kind: 'cluster', clusterId: 1 });
    const diff = context.sections.find((s) => s.id === 'scmInvestigation')!;
    expect(diff.markdown).toContain('Commits (the newest 1, oldest first; the range has more):');
    expect(diff.truncated).toBe(true);
    expect(context.coverage.scm?.commitsTruncated).toBe(true);
  });

  test('a whole diff stays complete, whatever its patches say', async () => {
    scm.changes = {
      commits: [{ sha: 'bbbbbbb', message: 'Change' }],
      files: [file('src/log.ts', "@@ -1 +1 @@\n-a\n+return text.slice(0, 80) + ' [truncated]';")],
    };
    const context = await buildDiagnosisContext(db as never, { kind: 'cluster', clusterId: 1 });
    expect(context.sections.find((s) => s.id === 'scmInvestigation')!.truncated).toBe(false);
    expect(context.text).toContain('[scmInvestigation] SCM diff since last green: present\n');
  });

  test('sorts the files by relevance without reordering what the provider answered', async () => {
    const served: ScmChanges = {
      commits: [{ sha: 'bbbbbbb', message: 'Change' }],
      files: [file('docs/notes.md'), file(SPEC)],
    };
    scm.changes = served;
    const context = await buildDiagnosisContext(db as never, { kind: 'cluster', clusterId: 1 });
    expect(served.files.map((f) => f.filename)).toEqual(['docs/notes.md', SPEC]);
    const diff = context.sections.find((s) => s.id === 'scmInvestigation')!.markdown;
    expect(diff.indexOf(`--- ${SPEC}`)).toBeLessThan(diff.indexOf('--- docs/notes.md'));
  });

  test('gives a picked commit its subject and its renamed files their old path', async () => {
    scm.changes = { commits: [], files: [] };
    scm.commitDiffs.set(sha('c'), {
      commits: [{ sha: 'ccccccc', message: 'Rename the cart', fullMessage: 'Rename the cart\n\nBody' }],
      files: [{ ...file('src/basket.ts'), status: 'renamed', previousFilename: 'src/cart.ts' }],
    });
    const context = await buildDiagnosisContext(db as never, {
      kind: 'cluster',
      clusterId: 1,
      selectedCommitShas: [sha('c')],
    });
    const picked = context.sections.find((s) => s.id === 'selectedCommits')!;
    expect(picked.markdown).toContain('### ccccccc Rename the cart');
    expect(picked.markdown).toContain('- src/basket.ts (renamed from src/cart.ts, +1 -1)');
    expect(picked.truncated).toBe(false);
  });

  test('says a picked commit came without patches, and caps its file list', async () => {
    scm.changes = { commits: [], files: [] };
    scm.commitDiffs.set(sha('d'), {
      commits: [{ sha: 'ddddddd', message: 'Huge' }],
      files: Array.from({ length: 45 }, (_, i) => ({ ...file(`src/f${i}.ts`), patch: undefined })),
      patchesOmitted: true,
    });
    const context = await buildDiagnosisContext(db as never, {
      kind: 'cluster',
      clusterId: 1,
      selectedCommitShas: [sha('d')],
    });
    const picked = context.sections.find((s) => s.id === 'selectedCommits')!;
    expect(picked.markdown).toContain('Changed files (the first 30, 45 in all):');
    expect(picked.markdown).not.toContain('src/f30.ts');
    expect(picked.markdown).toContain('the host sent no patches for this diff');
    expect(picked.truncated).toBe(true);
  });
});

describe('the diff since the test last passed', () => {
  test('starts at the last pass before the failure appeared, never at a later one', async () => {
    scm.changes = { commits: [{ sha: 'ddddddd', message: 'Change' }], files: [file('src/a.ts')] };
    // No run passes as a whole: each has another test failing.
    await run(10, 'failed', sha('1'), T0);
    await execution(10, 1, 'passed');
    await execution(10, 2, 'failed');
    await run(11, 'failed', sha('2'), T0 + HOUR);
    await cluster(2, 11);
    await execution(11, 1, 'failed', 2);
    await run(12, 'failed', sha('3'), T0 + 2 * HOUR);
    await execution(12, 1, 'passed');
    await execution(12, 2, 'failed');

    const context = await buildDiagnosisContext(db as never, { kind: 'cluster', clusterId: 2 });
    expect(scm.fetched).toEqual([[sha('1'), sha('2')]]);
    expect(context.coverage.scm?.baselineKind).toBe('test-green');
  });

  test('skips a pass in a run that cannot be a baseline', async () => {
    scm.changes = { commits: [{ sha: 'ddddddd', message: 'Change' }], files: [file('src/a.ts')] };
    await run(10, 'failed', sha('1'), T0);
    await execution(10, 1, 'passed');
    await execution(10, 2, 'failed');
    // A later Flake Lab run, still before the failure, where the test passed.
    await run(11, 'failed', sha('4'), T0 + HOUR / 2);
    await db.update(schema.testRuns).set({ origin: 'flake-lab' }).where(eq(schema.testRuns.id, 11));
    await execution(11, 1, 'passed');
    await execution(11, 2, 'failed');
    await run(12, 'failed', sha('2'), T0 + HOUR);
    await cluster(2, 12);
    await execution(12, 1, 'failed', 2);

    await buildDiagnosisContext(db as never, { kind: 'cluster', clusterId: 2 });
    expect(scm.fetched).toEqual([[sha('1'), sha('2')]]);
  });
});

describe('get_repo_diff', () => {
  const ctx: McpContext = {
    user: { id: 2, role: InstanceRole.MEMBER, name: 'Robin', username: 'robin' } as User,
    access: buildAccessSummary(InstanceRole.MEMBER, [{ projectId: 1, role: ProjectRole.VIEWER }]),
    scope: new Set([1]),
  };
  const getRepoDiff = MCP_TOOLS.find((t) => t.name === 'get_repo_diff')!.handler;

  test('answers with the commit’s message and cuts the patches to one budget', async () => {
    const big = `@@ -1,3000 +1,3000 @@\n${'+'.padEnd(100, 'x')}\n`.repeat(1_200);
    scm.commitDiffs.set(sha('e'), {
      commits: [{ sha: 'eeeeeee', message: 'Big', fullMessage: 'Big\n\nBody' }],
      files: [file('src/a.ts', big), file('src/b.ts', big), file('src/c.ts', big)],
      filesTruncated: true,
    });
    const answer = (await getRepoDiff(db as never, { projectId: 1, sha: sha('e') }, ctx)) as {
      message: string;
      files: Array<{ filename: string; patch?: string }>;
      filesTruncated: boolean;
      patchesTruncated: boolean;
    };
    expect(answer.message).toBe('Big\n\nBody');
    expect(answer.filesTruncated).toBe(true);
    expect(answer.patchesTruncated).toBe(true);
    expect(answer.files[0]!.patch).toBe(big);
    expect(answer.files[1]!.patch!.endsWith(PATCH_TRUNCATED_NOTE)).toBe(true);
    expect(answer.files[2]!.patch).toBeUndefined();
    const total = answer.files.reduce((n, f) => n + (f.patch?.length ?? 0), 0);
    expect(total).toBeLessThanOrEqual(200_000 + 2 * PATCH_TRUNCATED_NOTE.length);
  });

  test('flags a patch the host already cut', async () => {
    scm.commitDiffs.set(sha('f'), {
      commits: [],
      files: [file('src/a.ts', `@@ -1 +1 @@\n-a\n+b\n${PATCH_TRUNCATED_NOTE}`)],
    });
    const answer = (await getRepoDiff(db as never, { projectId: 1, sha: sha('f') }, ctx)) as {
      patchesTruncated?: boolean;
    };
    expect(answer.patchesTruncated).toBe(true);
  });

  test('answers an error, not a crash, to a sha that is not a string', async () => {
    expect(await getRepoDiff(db as never, { projectId: 1, sha: 42 }, ctx)).toEqual({ error: 'sha is required' });
  });
});
