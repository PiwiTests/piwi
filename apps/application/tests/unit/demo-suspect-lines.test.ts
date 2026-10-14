import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import type { Client } from '@libsql/client';
import type { DrizzleDB } from '#shared/handlers/db';
import { createHash } from 'node:crypto';
import { canonicalCoverageFile, decodeFunctionRanges, decodeLineRanges } from '@piwitests/core/coverage';
import { FAILURE_STORIES, SCM_REPOS, sourceText, storyCoverageFiles } from '#shared/demo/failure-stories.mjs';
import { DEMO_EXAMPLES } from '#shared/demo/demo-examples.mjs';
import * as scene from '../../scripts/lib/suspect-lines-scene.mjs';
import * as coverageScene from '../../scripts/lib/coverage-scene.mjs';

/**
 * The demo's suspect lines over a freshly generated seed: the stories that
 * carry coverage give their cluster and its failing executions suspect lines,
 * joined with the canned changes the cluster's What changed card shows, and
 * every other cluster answers that its tests recorded no coverage. The modal
 * story's browser coverage names files, the users story's server coverage
 * names lines, against the version of the file the canned history ends on.
 */

// The context's trace and DOM views read the in-browser database, which a test has none of.
vi.mock('~~/app/demo/api/dom-snapshot', () => ({ apiGetDemoDomSnapshot: async () => ({ status: 'none' }) }));
vi.mock('~~/app/demo/api/trace-insights', () => ({
  apiGetDemoTraceStacks: async () => ({ available: false }),
  apiGetDemoTraceNetwork: async () => ({ available: false, requests: [] }),
  apiGetDemoTraceNetworkBody: async () => null,
}));

const rootDir = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
let outDir: string;
let client: Client;
let db: DrizzleDB;

beforeAll(async () => {
  delete process.env.PIWI_DATABASE_URL;
  const { createClient } = await import('@libsql/client');
  const { drizzle } = await import('drizzle-orm/libsql');
  const schema = await import('~~/server/database/schema.sqlite');
  outDir = mkdtempSync(join(tmpdir(), 'piwi-demo-suspect-lines-'));
  execFileSync('node', ['scripts/generate-demo-seed.mjs'], {
    cwd: rootDir,
    stdio: 'ignore',
    env: { ...process.env, PIWI_DEMO_SEED_OUTPUT_DIR: outDir },
  });
  client = createClient({ url: `file:${join(outDir, 'piwi.db')}` });
  await client.executeMultiple(readFileSync(join(outDir, 'seed.sql'), 'utf8'));
  db = drizzle(client, { schema }) as unknown as DrizzleDB;
}, 120_000);

afterAll(() => {
  client?.close();
  if (outDir) rmSync(outDir, { recursive: true, force: true });
});

const covered = FAILURE_STORIES.filter((s) => s.coverage);

describe('demo suspect lines', () => {
  test('at least one story carries coverage', () => {
    expect(covered.length).toBeGreaterThan(0);
  });

  test("a covered story's cluster has the changed hunks its failing tests reached, ranked", async () => {
    const { demoClusterSuspectLines } = await import('~~/app/demo/api/suspect-lines');
    const { getDemoDefaultRange } = await import('~~/app/demo/demo-scm');
    for (const story of covered) {
      const answer = await demoClusterSuspectLines(db, story.clusterId);
      expect(answer.available, story.key).toBe(true);
      expect(answer.range).toEqual(getDemoDefaultRange(story.projectId));
      expect(answer.suspects.length, story.key).toBeGreaterThan(0);
      // The story's own app files are what its failing tests ran.
      expect(story.appFiles).toContain(answer.suspects[0]!.path);
      expect(answer.summary.failingWithCoverage).toBe(story.failingCases.length);
    }
  });

  test('a demo example that names a suspect opens a cluster whose suspect lines start with it', async () => {
    const { demoClusterSuspectLines } = await import('~~/app/demo/api/suspect-lines');
    const examples = DEMO_EXAMPLES.filter((e) => e.expect.suspects);
    expect(examples.length).toBeGreaterThan(0);
    for (const example of examples) {
      const answer = await demoClusterSuspectLines(db, example.expect.cluster!.id);
      expect(answer.suspects[0]?.path, example.id).toBe(example.expect.suspects!.path);
      if (example.expect.suspects!.granularity) {
        expect(answer.suspects[0]?.granularity, example.id).toBe(example.expect.suspects!.granularity);
      }
    }
  });

  test('the users story: the ASP.NET Core API’s users endpoints are the one suspect, at the lines the failing test ran', async () => {
    const { demoClusterSuspectLines } = await import('~~/app/demo/api/suspect-lines');
    const answer = await demoClusterSuspectLines(db, 10);
    // ListUsers' three paging statements: the failing test and the two passing
    // users tests ran them, so the score is 1 / sqrt(1 × 3).
    expect(answer.suspects).toEqual([
      {
        path: 'api/Users/UsersEndpoints.cs',
        runtime: 'server',
        hunk: [40, 42],
        lines: [[40, 42]],
        granularity: 'lines',
        failing: 1,
        passing: 2,
        score: 0.577,
      },
    ]);
    // The pagination commit's constant and parameters are not statements, and
    // the stylesheet is no code coverage reads; package.json and the reports
    // page changed with no patch.
    expect(answer.summary).toEqual({
      changedFiles: 2,
      changedLines: 13,
      hunks: 4,
      executedHunks: 1,
      executedLines: 3,
      failingWithCoverage: 1,
      passingWithCoverage: 2,
    });
    expect(answer.unreadFiles).toBe(2);
  });

  test('server coverage names the blob of the version the canned history ends on', () => {
    const story = FAILURE_STORIES.find((s) => s.key === 'users-table-page-size')!;
    const servers = story.failingCases
      .flatMap((fc) => storyCoverageFiles(story, fc.frames.at(-1)!.file, fc.title))
      .filter((entry) => typeof entry !== 'string');
    expect(servers.length).toBeGreaterThan(0);
    for (const file of servers) {
      const text = sourceText(file.path);
      const blob = createHash('sha1')
        .update(`blob ${Buffer.byteLength(text)}\0`)
        .update(text)
        .digest('hex');
      expect(file.blob, file.path).toBe(blob);
      // A file the canned history changes names the same blob on its change.
      const changes = SCM_REPOS[story.projectId]!.commits.flatMap((c) => c.files).filter(
        (f) => f.filename === file.path,
      );
      if (changes.length > 0)
        expect(
          changes.map((f) => f.blob),
          file.path,
        ).toEqual([blob]);
    }
    for (const file of story.runCoverage ?? []) {
      const text = sourceText(file.path);
      const blob = createHash('sha1')
        .update(`blob ${Buffer.byteLength(text)}\0`)
        .update(text)
        .digest('hex');
      expect(file.blob, file.path).toBe(blob);
    }
  });

  test('every seeded coverage fragment is stored under the hash the ingest gives it', async () => {
    const rows = (await client.execute('SELECT hash, runtime, path, blob, functions, lines FROM coverage_fragments'))
      .rows;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const canonical = canonicalCoverageFile({
        path: String(row.path),
        runtime: row.runtime as 'browser' | 'server',
        ...(row.blob ? { blob: String(row.blob) } : {}),
        functions: decodeFunctionRanges(row.functions as string | null),
        lines: decodeLineRanges(row.lines as string | null),
      });
      expect(row.hash, String(row.path)).toBe(createHash('sha256').update(canonical).digest('hex'));
    }
  });

  test('a stored diagnosis that cites the suspect lines quotes what the demo answers', async () => {
    const { demoClusterSuspectLines } = await import('~~/app/demo/api/suspect-lines');
    const rows = (await client.execute('SELECT cluster_id, details FROM failure_diagnoses')).rows;
    const citing = rows.filter((row) => String(row.details).includes('[suspectLines]'));
    expect(citing.length).toBeGreaterThan(0);
    for (const row of citing) {
      const { summary, suspects } = await demoClusterSuspectLines(db, Number(row.cluster_id));
      const details = String(row.details);
      expect(details, `cluster ${row.cluster_id}`).toContain(
        `${summary.executedLines} of the ${summary.changedLines} changed lines`,
      );
      const top = suspects[0]!;
      const lines = top.lines.map(([start, end]) => (start === end ? `${start}` : `${start} to ${end}`)).join(', ');
      expect(details, `cluster ${row.cluster_id}`).toContain(`${top.path.split('/').pop()} ${lines}`);
    }
  });

  test("the users cluster's fix plan lists its suspect lines", async () => {
    const { demoClusterSuspectLines } = await import('~~/app/demo/api/suspect-lines');
    const { buildFixPlan } = await import('~~/server/utils/fix-plan');
    const { fixPlanSuspectLines } = await import('#shared/suspect-lines');
    const { fixPlanToMarkdown } = await import('#shared/fix-plan-markdown');
    const built = await buildFixPlan(db, 10);
    const plan = { ...built!, suspectLines: fixPlanSuspectLines(await demoClusterSuspectLines(db, 10)) };
    expect(fixPlanToMarkdown(plan)).toContain(
      '- `api/Users/UsersEndpoints.cs` 40-42 (server): executed lines, 1 failing test, 2 passing tests, score 0.58',
    );
  });

  test('the modal story: the controller is the one suspect, reached only by the failing tests', async () => {
    const { demoClusterSuspectLines } = await import('~~/app/demo/api/suspect-lines');
    const answer = await demoClusterSuspectLines(db, 5);
    expect(answer.suspects).toEqual([
      {
        path: 'src/components/modal-controller.ts',
        runtime: 'browser',
        hunk: [4, 5],
        lines: [[4, 5]],
        granularity: 'files',
        failing: 2,
        passing: 0,
        score: 1,
      },
    ]);
    expect(answer.summary).toMatchObject({ changedFiles: 2, hunks: 2, executedHunks: 1 });
  });

  test('every failing execution of the covered run answers the same suspect for itself', async () => {
    const { demoExecutionSuspectLines, demoClusterSuspectLines } = await import('~~/app/demo/api/suspect-lines');
    for (const story of covered) {
      const cluster = await demoClusterSuspectLines(db, story.clusterId);
      const rows = (
        await client.execute(
          `SELECT id FROM test_runs_cases WHERE failure_cluster_id = ${story.clusterId} AND test_run_id = ${cluster.runId} AND status = 'failed'`,
        )
      ).rows;
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        const answer = await demoExecutionSuspectLines(db, Number(row.id));
        expect(answer?.available).toBe(true);
        expect(answer?.suspects[0]?.path).toBe(cluster.suspects[0]?.path);
        expect(answer?.summary.failingWithCoverage).toBe(1);
      }
    }
  });

  test("the cluster's context lists them, puts their files first, and names the head the card marks them on", async () => {
    const { getClusterContext } = await import('~~/app/demo/api/diagnosis-context');
    const { demoClusterSuspectLines } = await import('~~/app/demo/api/suspect-lines');
    for (const story of covered) {
      const answer = await demoClusterSuspectLines(db, story.clusterId);
      const context = await getClusterContext(db, story.clusterId);
      const section = context.sections.find((s) => s.id === 'suspectLines');
      expect(section?.markdown).toContain(`\`${answer.suspects[0]!.path}\``);
      expect(context.coverage.suspectLines).toMatchObject({ suspects: answer.suspects.length });
      expect(context.scmChanges?.files[0]?.filename).toBe(answer.suspects[0]!.path);
      expect(answer.range!.to.startsWith(context.coverage.scm!.range!.to)).toBe(true);
    }
  });

  test('the screenshot scenes serve what the demo answers', async () => {
    const { demoClusterSuspectLines, demoExecutionSuspectLines } = await import('~~/app/demo/api/suspect-lines');
    const { getClusterContext } = await import('~~/app/demo/api/diagnosis-context');
    expect(await demoClusterSuspectLines(db, scene.SUSPECT_SCENE_CLUSTER.id)).toEqual(
      scene.SUSPECT_SCENE_CLUSTER.answer,
    );
    expect(await demoExecutionSuspectLines(db, scene.SUSPECT_SCENE_EXECUTION.id)).toEqual(
      scene.SUSPECT_SCENE_EXECUTION.answer,
    );
    const context = await getClusterContext(db, scene.SUSPECT_SCENE_CLUSTER.id);
    const shown = scene.withSceneChanges({ coverage: { scm: null } });
    expect(shown.scmChanges).toEqual(context.scmChanges);
    expect(shown.coverage.scm.range).toEqual(context.coverage.scm?.range);
  });

  test('the Coverage section scenes serve what the demo answers', async () => {
    const { demoExecutionSuspectLines } = await import('~~/app/demo/api/suspect-lines');
    const { getDemoSourceAtBlob } = await import('~~/app/demo/demo-scm');
    expect(await demoExecutionSuspectLines(db, coverageScene.COVERAGE_SCENE_EXECUTION)).toEqual(
      coverageScene.COVERAGE_SCENE_SUSPECT_LINES,
    );
    const rows = (
      await client.execute(
        `SELECT path, blob FROM run_coverage WHERE run_id = (SELECT test_run_id FROM test_runs_cases WHERE id = ${coverageScene.COVERAGE_SCENE_EXECUTION})`,
      )
    ).rows;
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) {
      const [path, blob] = [String(row.path), String(row.blob)];
      expect(coverageScene.coverageSceneSource(path, blob), path).toEqual(
        await getDemoSourceAtBlob(coverageScene.COVERAGE_SCENE_PROJECT, path, blob),
      );
    }
  });

  test('a cluster whose tests recorded no coverage answers so', async () => {
    const { demoClusterSuspectLines } = await import('~~/app/demo/api/suspect-lines');
    for (const story of FAILURE_STORIES.filter((s) => !s.coverage)) {
      const answer = await demoClusterSuspectLines(db, story.clusterId);
      expect(answer, story.key).toMatchObject({ available: false, reason: 'no-coverage' });
    }
  });
});
