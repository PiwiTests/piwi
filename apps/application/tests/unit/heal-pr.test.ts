import { describe, test, expect } from 'vitest';
import {
  buildHealBranchVerifiedComment,
  buildHealPrTitle,
  buildHealPrBody,
  HEAL_BRANCH_VERIFIED_MARKER,
  HEAL_PR_MARKER,
} from '#shared/heal-pr';
import type { HealActionPayload, HealEditPayload } from '#shared/auto-heal';

const edit = (over: Partial<HealEditPayload> = {}): HealEditPayload => ({
  filePath: 'tests/checkout.spec.ts',
  line: 42,
  oldLine: "  await page.getByRole('button', { name: 'Pay' }).click();",
  newLine: "  await page.getByTestId('pay-btn').click();",
  failingLocator: "getByRole('button', { name: 'Pay' })",
  suggestedLocator: "getByTestId('pay-btn')",
  score: 100,
  source: 'prior-run',
  pickedByUser: false,
  clusterId: 7,
  executionId: 1,
  testTitle: 'checkout pays',
  owner: '@checkout-team',
  ...over,
});

const payload = (edits: HealEditPayload[]): HealActionPayload => ({
  repositoryUrl: 'https://github.com/acme/app',
  provider: 'github',
  baseBranch: 'main',
  baseSha: 'abc123',
  branch: 'piwi/heal/9-deadbeef',
  commitMessage: 'test: heal broken locators',
  title: 'test: heal broken locators',
  draft: true,
  verifyCommand: 'npx playwright test "tests/checkout.spec.ts" -g "checkout pays"',
  edits,
});

describe('buildHealPrTitle', () => {
  test('is the configured (conventional-commit) message', () => {
    expect(buildHealPrTitle(payload([edit()]))).toBe('test: heal broken locators');
  });
});

describe('buildHealPrBody', () => {
  test('carries the marker, a per-edit row, owners, clusters and the verify command', () => {
    const body = buildHealPrBody(payload([edit()]), 'https://piwi.example.com');
    expect(body.startsWith(HEAL_PR_MARKER)).toBe(true);
    expect(body).toContain('healed 1 broken locator in 1 file');
    expect(body).toContain('`tests/checkout.spec.ts`');
    expect(body).toContain("getByTestId('pay-btn')");
    expect(body).toContain('last passing run');
    expect(body).toContain('@checkout-team');
    expect(body).toContain('[#7](https://piwi.example.com/failure-clusters/7)');
    expect(body).toContain('npx playwright test "tests/checkout.spec.ts" -g "checkout pays"');
  });

  test('labels a user pick and omits cluster links without a site URL', () => {
    const body = buildHealPrBody(payload([edit({ pickedByUser: true, clusterId: null })]), null);
    expect(body).toContain('your confirmed pick');
    expect(body).not.toContain('failure-clusters');
  });

  test('names each source in plain words, never its raw value', () => {
    const sources = {
      fingerprint: 'prior run (line shifted)',
      'cross-test': 'another test',
      'diff-rename': 'rename in the change',
    };
    for (const [source, label] of Object.entries(sources)) {
      const body = buildHealPrBody(payload([edit({ source })]), null);
      expect(body).toContain(label);
      expect(body).not.toContain(`| ${source} |`);
    }
  });

  test('collapses a long edit list', () => {
    const edits = Array.from({ length: 25 }, (_, i) => edit({ line: i + 1, executionId: i + 1 }));
    const body = buildHealPrBody(payload(edits), null);
    expect(body).toContain('…and 5 more');
  });
});

describe('buildHealBranchVerifiedComment', () => {
  test('links the run, names the commit and leaves marking a draft ready to the reader', () => {
    const body = buildHealBranchVerifiedComment({
      runId: 31,
      commit: 'abcdef123456',
      testCount: 2,
      siteUrl: 'https://piwi.example/',
      draft: true,
    });
    expect(body.startsWith(HEAL_BRANCH_VERIFIED_MARKER)).toBe(true);
    expect(body).toContain('[run #31](https://piwi.example/test-runs/31) passed the 2 healed tests at `abcdef1`.');
    expect(body).toContain('Mark the pull request ready for review');
  });

  test('without a site URL, a commit or a draft', () => {
    const body = buildHealBranchVerifiedComment({ runId: 5, commit: null, testCount: 1, siteUrl: null, draft: false });
    expect(body).toContain('run #5 passed the 1 healed test.');
    expect(body).not.toContain('ready for review');
  });
});
