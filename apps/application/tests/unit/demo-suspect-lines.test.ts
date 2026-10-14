import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import type { Client } from '@libsql/client';
import type { DrizzleDB } from '#shared/handlers/db';
import { FAILURE_STORIES } from '#shared/demo/failure-stories.mjs';
import * as scene from '../../scripts/lib/suspect-lines-scene.mjs';

/**
 * The demo's suspect lines over a freshly generated seed: the stories that
 * carry coverage give their cluster and its failing executions suspect lines,
 * joined with the canned changes the cluster's What changed card shows, and
 * every other cluster answers that its tests recorded no coverage.
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

  test('a cluster whose tests recorded no coverage answers so', async () => {
    const { demoClusterSuspectLines } = await import('~~/app/demo/api/suspect-lines');
    for (const story of FAILURE_STORIES.filter((s) => !s.coverage)) {
      const answer = await demoClusterSuspectLines(db, story.clusterId);
      expect(answer, story.key).toMatchObject({ available: false, reason: 'no-coverage' });
    }
  });
});
