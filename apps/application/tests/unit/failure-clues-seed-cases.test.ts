import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test, expect } from 'vitest';
import { buildFailureClues, type FailureCluesReport, type FailureClueInput } from '#shared/failure-clues';

/**
 * A frozen baseline of the ordered clue ranking for four seeded executions. The
 * inputs are captured verbatim from a freshly generated demo seed
 * (`loadFailureClueInput`, the loader behind `/api/test-run-cases/:id/clues`)
 * and committed under `fixtures/`, so the test runs the real
 * `buildFailureClues` against real evidence with no database. The expected
 * `(rule, strength)` pairs are written out literally: a change to the ranking
 * rules surfaces here as a readable diff of what each failure now says on its
 * first screen.
 *
 * After a seed change, recapture the fixtures, then format them:
 *   PIWI_CAPTURE_CLUE_FIXTURES=1 npx vitest run tests/unit/failure-clues-seed-cases.test.ts
 */

const SEEDED_EXECUTIONS = [37, 13, 781, 587];

function fixturePath(executionId: number): string {
  return fileURLToPath(new URL(`./fixtures/failure-clues/exec-${executionId}.json`, import.meta.url));
}

function loadInput(executionId: number): FailureClueInput {
  return JSON.parse(readFileSync(fixturePath(executionId), 'utf8')) as FailureClueInput;
}

describe.runIf(process.env.PIWI_CAPTURE_CLUE_FIXTURES)('capture the fixtures from a fresh demo seed', () => {
  test('writes the clue input of each seeded execution', async () => {
    // The schema barrel picks PostgreSQL at import time when PIWI_DATABASE_URL is set.
    delete process.env.PIWI_DATABASE_URL;
    const { createClient } = await import('@libsql/client');
    const { drizzle } = await import('drizzle-orm/libsql');
    const schema = await import('~~/server/database/schema.sqlite');
    const { loadFailureClueInput } = await import('#shared/handlers/test-cases');

    const outDir = mkdtempSync(join(tmpdir(), 'piwi-clue-fixtures-'));
    try {
      execFileSync('node', ['scripts/generate-demo-seed.mjs'], {
        cwd: fileURLToPath(new URL('../..', import.meta.url)),
        stdio: 'ignore',
        env: { ...process.env, PIWI_DEMO_SEED_OUTPUT_DIR: outDir },
      });
      const client = createClient({ url: ':memory:' });
      await client.executeMultiple(readFileSync(join(outDir, 'seed.sql'), 'utf8'));
      const db = drizzle(client, { schema });
      for (const id of SEEDED_EXECUTIONS) {
        const input = await loadFailureClueInput(db as never, id);
        expect(input, `execution ${id}`).not.toBeNull();
        writeFileSync(fixturePath(id), `${JSON.stringify(input, null, 2)}\n`);
      }
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  }, 120_000);
});

/** The ranked clue output reduced to the two fields the baseline pins. */
function ranking(report: FailureCluesReport): Array<[string, string]> {
  return report.clues.map((clue) => [clue.rule, clue.strength]);
}

describe('buildFailureClues — seeded failure ranking baseline', () => {
  test('#37 — checkout, Pay click timeout', () => {
    const report = buildFailureClues(loadInput(37));
    // The disabled button and the confirm dialog lead; the Pay click ran almost
    // the whole test timeout, so the budget clue joins the story members; the
    // resolved-locator page-structure change stays medium, and the slow quote's
    // history as a flake suspect comes last.
    expect(ranking(report)).toEqual([
      ['element-present-but-blocked', 'strong'],
      ['dialog-open-on-failure', 'strong'],
      ['console-mentions-target', 'medium'],
      ['slow-request-overlapping-failure', 'medium'],
      ['timeout-budget', 'medium'],
      ['page-structure-changed', 'medium'],
      ['known-flake-suspect', 'weak'],
    ]);
    expect(report.story?.id).toBe('blocked-by-pending-request');
    expect(report.story?.sentence).toContain('the console said so 7.8 s before the click gave up');
  });

  test('#13 — same cluster, earlier run', () => {
    const report = buildFailureClues(loadInput(13));
    expect(ranking(report)).toEqual([
      ['element-present-but-blocked', 'strong'],
      ['dialog-open-on-failure', 'strong'],
      ['console-mentions-target', 'medium'],
      ['slow-request-overlapping-failure', 'medium'],
      ['timeout-budget', 'medium'],
      ['page-structure-changed', 'medium'],
      ['environment-changed', 'weak'],
      ['known-flake-suspect', 'weak'],
    ]);
    expect(report.story?.id).toBe('blocked-by-pending-request');
  });

  test("#781 — cluster #10's latest occurrence, toHaveCount on getByRole('row')", () => {
    const report = buildFailureClues(loadInput(781));
    // A Playwright-version and color-scheme diff only, so environment stays weak.
    expect(ranking(report)).toEqual([
      ['environment-changed', 'weak'],
      ['known-flake-suspect', 'weak'],
    ]);
    expect(report.story).toBeNull();
  });

  test("#587 — cluster #5's latest occurrence, .modal.is-open timeout", () => {
    const report = buildFailureClues(loadInput(587));
    // The modal's locator matched nothing; the test is flaky, so no replacement is named and the clue stays medium,
    // above the other modal test failing alongside it on another worker.
    expect(ranking(report)).toEqual([
      ['locator-matched-nothing', 'medium'],
      ['known-flake-suspect', 'weak'],
    ]);
    expect(report.clues[0]!.detail).toBe(
      "No element matched `locator('.modal.is-open')` at the failure: the page did not show it, or the locator names it differently.",
    );
    expect(report.story).toBeNull();
  });
});
