import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { Client } from '@libsql/client';
import type { DrizzleDB } from '#shared/handlers/db';
import { ORDER_FLAKE, SOURCE_FILES, sourceText } from '#shared/demo/failure-stories.mjs';
import { ORDER_SCENE, orderSceneSource } from '../../scripts/lib/coverage-insights-scene.mjs';
import { DEMO_EXAMPLES } from '#shared/demo/demo-examples.mjs';

/**
 * The coverage insights over a freshly generated demo seed: Web Dashboard's
 * `toggles dark mode` fails its first attempt in the runs where `updates the
 * organization name` had not finished when it started, so its path varies
 * with that test (an order dependency, the `order` root cause the seed
 * stores), each failed attempt took a path its last passing execution did
 * not, and its preferences code is run by no other test.
 */

const rootDir = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
let outDir: string;
let client: Client;
let db: DrizzleDB;

beforeAll(async () => {
  delete process.env.PIWI_DATABASE_URL;
  const { createClient } = await import('@libsql/client');
  const { drizzle } = await import('drizzle-orm/libsql');
  const schema = await import('~~/server/database/schema.sqlite');
  outDir = mkdtempSync(join(tmpdir(), 'piwi-demo-coverage-insights-'));
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

async function caseId(title: string): Promise<number> {
  const result = await client.execute({
    sql: 'select id from test_cases where project_id = ? and file_path = ? and title = ?',
    args: [ORDER_FLAKE.projectId, ORDER_FLAKE.specFile, title],
  });
  return Number(result.rows[0]!.id);
}

/** The test's failed executions with coverage, newest first. */
async function failedAttempts(testCaseId: number): Promise<number[]> {
  const result = await client.execute({
    sql: `select id from test_runs_cases where test_case_id = ? and status = 'failed' and coverage_payload_id is not null
          order by created_at desc, id desc`,
    args: [testCaseId],
  });
  return result.rows.map((row) => Number(row.id));
}

describe('the order-dependent flake', () => {
  test('its authored API files name the blobs of their text', () => {
    const files = Object.values(ORDER_FLAKE.coverage).flat();
    for (const file of files) {
      expect(SOURCE_FILES[file.path], file.path).toBeTruthy();
      const text = sourceText(file.path);
      const blob = createHash('sha1')
        .update(`blob ${Buffer.byteLength(text)}\0`)
        .update(text)
        .digest('hex');
      expect(file.blob, file.path).toBe(blob);
    }
  });

  test('its path varies with the organization test having finished, and its failures follow it', async () => {
    const { getPathVariation } = await import('#shared/handlers/coverage-insights');
    const toggle = await caseId(ORDER_FLAKE.test);
    const answer = (await getPathVariation(db, toggle))!;
    expect(answer.available).toBe(true);
    expect(answer.executions.failed).toBeGreaterThanOrEqual(ORDER_FLAKE.minRaces);
    expect(answer.orderDependent).toBe(true);
    const explanation = answer.explanation!;
    expect(explanation).toMatchObject({
      testCaseId: await caseId(ORDER_FLAKE.earlier),
      title: ORDER_FLAKE.earlier,
      relation: 'earlier-in-run',
      effect: 'prevents-code',
      agreement: 1,
    });
    expect(explanation.before.ranCode).toBe(0);
    expect(explanation.notBefore.ranCode).toBe(explanation.notBefore.executions);
    const varying = answer.varying[explanation.varying]!;
    expect(varying.files.map((f) => f.path)).toEqual([ORDER_FLAKE.conflictPath]);
    expect(answer.failuresFollow).toMatchObject({ varying: explanation.varying, side: 'ran' });
  });

  test('the flaky classification reads it as the order root cause the seed stores', async () => {
    const { classifyAndPersistFlakyRootCause } = await import('#shared/handlers/flaky-classify');
    const toggle = await caseId(ORDER_FLAKE.test);
    const stored = await client.execute({
      sql: 'select flaky_root_cause from test_cases where id = ?',
      args: [toggle],
    });
    expect(stored.rows[0]!.flaky_root_cause).toBe('order');
    const { rootCause } = await classifyAndPersistFlakyRootCause(db, ORDER_FLAKE.projectId, toggle);
    expect(rootCause).toBe('order');
  });

  test('each failed attempt with an earlier pass ran the conflict where the pass published the change', async () => {
    const { getCoverageDivergence } = await import('#shared/handlers/coverage-insights');
    const toggle = await caseId(ORDER_FLAKE.test);
    const attempts = await failedAttempts(toggle);
    expect(attempts.length).toBeGreaterThanOrEqual(ORDER_FLAKE.minRaces);
    const answers = await Promise.all(attempts.map((id) => getCoverageDivergence(db, id)));
    const compared = answers.filter((a) => a?.available);
    expect(compared.length).toBeGreaterThan(0);
    for (const answer of compared) {
      expect(answer!.baseline!.sameBranch).toBe(true);
      expect(answer!.files).toHaveLength(1);
      expect(answer!.files[0]).toMatchObject({ path: ORDER_FLAKE.conflictPath, status: 'diverged' });
      expect(answer!.files[0]!.linesOnlyHere?.length).toBeGreaterThan(0);
      expect(answer!.files[0]!.linesOnlyBaseline?.length).toBeGreaterThan(0);
    }
  });

  test('quarantining it leaves its preferences code run by no other trusted test', async () => {
    const { getCoverageLoss } = await import('#shared/handlers/coverage-insights');
    const toggle = await caseId(ORDER_FLAKE.test);
    const answer = (await getCoverageLoss(db, ORDER_FLAKE.projectId, [toggle]))!;
    expect(answer.available).toBe(true);
    expect(answer.summary.lines).toBeGreaterThan(0);
    expect(answer.files[0]).toMatchObject({ path: ORDER_FLAKE.conflictPath, status: 'only-these' });
    // The organization it reads is run by the organization test too.
    expect(answer.files.map((f) => f.path)).not.toContain('api/Organizations/OrganizationEndpoints.cs');
  });

  test('quarantining the organization test leaves its file to the flaky toggle alone', async () => {
    const { getCoverageLoss } = await import('#shared/handlers/coverage-insights');
    const answer = (await getCoverageLoss(db, ORDER_FLAKE.projectId, [await caseId(ORDER_FLAKE.earlier)]))!;
    expect(answer.available).toBe(true);
    const organization = answer.files.find((f) => f.path === 'api/Organizations/OrganizationEndpoints.cs')!;
    expect(organization).toMatchObject({ status: 'only-flaky', otherTests: { steady: 0, flaky: 1 } });
    expect(answer.summary.onlyFlakyLines).toBeGreaterThan(0);
  });

  test('the scenes open what the seed holds', async () => {
    const { getCoverageDivergence } = await import('#shared/handlers/coverage-insights');
    expect(ORDER_SCENE.testCaseId).toBe(await caseId(ORDER_FLAKE.test));
    expect(ORDER_SCENE.earlierTestCaseId).toBe(await caseId(ORDER_FLAKE.earlier));
    expect(await failedAttempts(ORDER_SCENE.testCaseId)).toContain(ORDER_SCENE.executionId);
    const answer = (await getCoverageDivergence(db, ORDER_SCENE.executionId))!;
    expect(answer.available).toBe(true);
    expect(answer.files.map((f) => [f.path, f.status])).toEqual([[ORDER_SCENE.path, 'diverged']]);
    expect(orderSceneSource(ORDER_SCENE.path, answer.files[0]!.blob!)?.content).toBe(sourceText(ORDER_SCENE.path));
    expect(orderSceneSource(ORDER_SCENE.path, 'f'.repeat(40))).toBeNull();
  });

  test('every demo example of an insight shows it', async () => {
    const { getCoverageDivergence, getPathVariation } = await import('#shared/handlers/coverage-insights');
    const examples = DEMO_EXAMPLES.filter((e) => e.expect.insight);
    expect(examples.length).toBeGreaterThan(0);
    for (const { id, expect: want } of examples) {
      if (want.insight === 'divergence') {
        const answer = (await getCoverageDivergence(db, want.execution!.id))!;
        expect(answer.available, id).toBe(true);
        expect(answer.files.length, id).toBeGreaterThan(0);
      } else {
        const answer = (await getPathVariation(db, want.testCase!.id))!;
        expect(answer.explanation, id).toBeTruthy();
        expect(answer.orderDependent, id).toBe(true);
      }
    }
  });
});
