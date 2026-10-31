import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The package manager answers as a successful install would, so `init` reports
// what a first run prints rather than spawning npm.
vi.mock('../../../../packages/reporter/src/internal/support/playwright-spawn', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runPackageManager: () => 0,
}));

// The reporter's own `init`, from source.
const { runInit } = await import('../../../../packages/reporter/src/cli/init');
const { evaluateGatePolicy, formatGateResult } = await import('@piwitests/core/gate');
const { renderOpenMetrics } = await import('#shared/handlers/analytics/open-metrics');
const { formatSummary } = await import('../../../../packages/reporter/src/cli/coverage');

// The docs quote what Piwi prints at each step of the setup, so a reader can
// tell it worked. Each quote is a snippet the docs include; this test holds it
// to the code that prints it.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const snippet = (name: string) => readFileSync(join(repoRoot, 'apps/docs/snippets', name), 'utf8').trim();

describe('docs checkpoints', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'piwi-docs-init-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  test('init-output.txt is what init prints for the Getting started command', async () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'my-project' }));
    writeFileSync(
      join(root, 'playwright.config.ts'),
      `import { defineConfig } from '@playwright/test'\n\nexport default defineConfig({\n  testDir: './tests',\n})\n`,
    );
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => void lines.push(args.join(' ')));
    const code = await runInit(
      ['--server-url', 'http://localhost:3000', '--project', 'my-project'],
      {} as NodeJS.ProcessEnv,
      root,
    );
    expect(code).toBe(0);
    expect(snippet('init-output.txt'), 'apps/docs/snippets/init-output.txt').toBe(lines.join('\n').trim());
  });

  test('reporter-not-enabled.txt is the line the reporter prints with no server', () => {
    const source = readFileSync(join(repoRoot, 'packages/reporter/src/public/reporter.ts'), 'utf8');
    const prefix = /private readonly prefix = '([^']+)'/.exec(
      readFileSync(join(repoRoot, 'packages/reporter/src/internal/support/logger.ts'), 'utf8'),
    )?.[1];
    const message = /this\.logger\.info\('(Not enabled[^']*)'\)/.exec(source)?.[1];
    expect(prefix && message, 'the reporter still logs a Not enabled line').toBeTruthy();
    expect(snippet('reporter-not-enabled.txt')).toBe(`${prefix}${message}`);
  });

  test('gate-output.txt is what piwi gate prints for the CI page policy', () => {
    const result = evaluateGatePolicy(
      {
        runId: 412,
        runUrl: 'https://piwi.example.com/test-runs/412',
        projectName: 'checkout',
        status: 'failed',
        totalTests: 248,
        failedTests: 3,
        newRegressions: 1,
        newFlaky: 0,
        newClusters: 1,
        failingByTag: {
          critical: [{ title: 'pays by card', filePath: 'tests/checkout.spec.ts', executionId: 9031 }],
        },
        unmatchedTags: [],
        quarantinedFailures: 1,
        quarantinedTotal: 2,
        flakyTests: 2,
      },
      { requireTags: ['critical'], maxNewRegressions: 0 },
    );
    expect(snippet('gate-output.txt'), 'apps/docs/snippets/gate-output.txt').toBe(formatGateResult(result));
  });

  test('metrics-output.txt is what /api/metrics serves for two projects', () => {
    const sample = (projectId: number, project: string, values: Record<string, number>) => ({
      projectId,
      project,
      values: new Map(Object.entries(values)),
    });
    const text = renderOpenMetrics(
      [
        sample(1, 'checkout', { 'test-pass-rate': 97.8, runs: 42, 'wasted-ci-minutes': 18.5 }),
        sample(2, 'search', { 'test-pass-rate': 99.4, runs: 31, 'wasted-ci-minutes': 2 }),
      ] as Parameters<typeof renderOpenMetrics>[0],
      { ids: ['test-pass-rate', 'runs', 'wasted-ci-minutes'], periodLabel: 'last 7 days', cost: null },
    );
    expect(snippet('metrics-output.txt'), 'apps/docs/snippets/metrics-output.txt').toBe(text.trim());
  });

  test('coverage-upload-output.txt is what coverage upload prints for the unit-front suite', () => {
    const text = formatSummary(
      {
        commit: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
        branch: 'main',
        suite: 'unit-front',
        reports: ['coverage/cobertura-coverage.xml'],
        files: 214,
        unmatched: 0,
        outOfScope: 12,
        inventoryFiles: 388,
        requests: 1,
        reportFiles: 214,
      },
      false,
    );
    expect(snippet('coverage-upload-output.txt'), 'apps/docs/snippets/coverage-upload-output.txt').toBe(text);
  });
});
