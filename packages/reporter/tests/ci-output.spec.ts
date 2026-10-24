import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  emitResourceSummary,
  emitRunOutputs,
  ciBuildUrlFromMetadata,
  SUMMARY_MAX_FAILURES,
  type RunOutput,
} from '../src/internal/support/ci-output.js';
import type { FailureLink } from '../src/internal/support/failure-links.js';
import { Logger } from '../src/internal/support/logger.js';

const OUTPUT: RunOutput = {
  runUrl: 'https://dash.example.com/test-runs/42',
  runId: 42,
  projectId: 7,
  projectName: 'checkout',
  status: 'passed',
  ciBuildUrl: 'https://ci.example.com/build/9',
  failures: [],
};

function failure(i: number): FailureLink {
  return {
    title: `test ${i}`,
    file: 'tests/checkout.spec.ts',
    retry: 1,
    browser: 'chromium',
    headline: null,
    url: `https://dash.example.com/test-runs/42/locate?file=tests%2Fcheckout.spec.ts&title=test%20${i}&retry=1&browser=chromium`,
  };
}

let tmpDir: string;
const silentLogger = new Logger(false);

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-ci-output-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('emitRunOutputs — universal output file', () => {
  it('writes a JSON file with the run identity when outputFile is set', () => {
    const file = path.join(tmpDir, 'nested', 'piwi-run.json');
    emitRunOutputs(OUTPUT, silentLogger, file, {});
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(parsed).toEqual({
      runUrl: OUTPUT.runUrl,
      runId: 42,
      projectId: 7,
      projectName: 'checkout',
      status: 'passed',
      ciBuildUrl: 'https://ci.example.com/build/9',
      failedCount: 0,
      failures: [],
    });
  });

  it('lists the failed tests with their links in the file', () => {
    const file = path.join(tmpDir, 'piwi-run.json');
    emitRunOutputs({ ...OUTPUT, status: 'failed', failures: [failure(1)] }, silentLogger, file, {});
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(parsed.failedCount).toBe(1);
    expect(parsed.failures).toEqual([failure(1)]);
  });

  it('does not write a file when outputFile is not set', () => {
    emitRunOutputs(OUTPUT, silentLogger, undefined, {});
    expect(fs.readdirSync(tmpDir)).toEqual([]);
  });

  it('never throws when the output file path is unwritable', () => {
    const badPath = path.join(tmpDir, 'a-file');
    fs.writeFileSync(badPath, 'x');
    // Treating an existing file as a directory parent must be swallowed.
    expect(() => emitRunOutputs(OUTPUT, silentLogger, path.join(badPath, 'child.json'), {})).not.toThrow();
  });
});

describe('emitRunOutputs — GitHub Actions', () => {
  it('appends step outputs and a job-summary link, and prints an annotation', () => {
    const outputFile = path.join(tmpDir, 'gh-output');
    const summaryFile = path.join(tmpDir, 'gh-summary');
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    emitRunOutputs(OUTPUT, silentLogger, undefined, {
      GITHUB_ACTIONS: 'true',
      GITHUB_OUTPUT: outputFile,
      GITHUB_STEP_SUMMARY: summaryFile,
    });

    const outputs = fs.readFileSync(outputFile, 'utf8');
    expect(outputs).toContain('piwi_run_url=https://dash.example.com/test-runs/42');
    expect(outputs).toContain('piwi_run_id=42');
    expect(outputs).toContain('piwi_run_status=passed');
    expect(outputs).toContain('piwi_project_id=7');
    expect(outputs).toContain('piwi_failed_count=0');

    const summary = fs.readFileSync(summaryFile, 'utf8');
    expect(summary).toContain('[View run](https://dash.example.com/test-runs/42)');
    expect(summary).toContain('**passed**');
    expect(summary).not.toContain('❌');

    expect(stdout).toHaveBeenCalledWith('::notice title=Piwi test run::https://dash.example.com/test-runs/42\n');
  });

  it('lists each failed test with its link in the job summary and counts them in the outputs', () => {
    const outputFile = path.join(tmpDir, 'gh-output');
    const summaryFile = path.join(tmpDir, 'gh-summary');
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    emitRunOutputs({ ...OUTPUT, status: 'failed', failures: [failure(1), failure(2)] }, silentLogger, undefined, {
      GITHUB_ACTIONS: 'true',
      GITHUB_OUTPUT: outputFile,
      GITHUB_STEP_SUMMARY: summaryFile,
    });

    expect(fs.readFileSync(outputFile, 'utf8')).toContain('piwi_failed_count=2');
    const summary = fs.readFileSync(summaryFile, 'utf8');
    expect(summary).toContain(`- ❌ [test 1](${failure(1).url}) — \`tests/checkout.spec.ts\``);
    expect(summary).toContain(`- ❌ [test 2](${failure(2).url})`);
    expect(summary).not.toContain('more');
  });

  it('puts the failure headline between the link and the file in the job summary', () => {
    const summaryFile = path.join(tmpDir, 'gh-summary');
    const withHeadline = { ...failure(1), headline: "Expected 26 rows, found 51 — getByRole('row') toHaveCount" };
    emitRunOutputs({ ...OUTPUT, status: 'failed', failures: [withHeadline] }, silentLogger, undefined, {
      GITHUB_ACTIONS: 'true',
      GITHUB_STEP_SUMMARY: summaryFile,
    });
    const summary = fs.readFileSync(summaryFile, 'utf8');
    expect(summary).toContain(
      `- ❌ [test 1](${withHeadline.url}) — Expected 26 rows, found 51 — getByRole('row') toHaveCount — \`tests/checkout.spec.ts\``,
    );
  });

  it('caps the job summary list and counts the rest', () => {
    const summaryFile = path.join(tmpDir, 'gh-summary');
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const failures = Array.from({ length: SUMMARY_MAX_FAILURES + 3 }, (_, i) => failure(i));

    emitRunOutputs({ ...OUTPUT, status: 'failed', failures }, silentLogger, undefined, {
      GITHUB_ACTIONS: 'true',
      GITHUB_STEP_SUMMARY: summaryFile,
    });

    const summary = fs.readFileSync(summaryFile, 'utf8');
    expect(summary.match(/- ❌ /g)).toHaveLength(SUMMARY_MAX_FAILURES);
    expect(summary).toContain('- +3 more');
  });

  it('escapes markdown in a test title', () => {
    const summaryFile = path.join(tmpDir, 'gh-summary');
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    emitRunOutputs(
      { ...OUTPUT, status: 'failed', failures: [{ ...failure(1), title: 'renders [a] *b*' }] },
      silentLogger,
      undefined,
      { GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summaryFile },
    );

    expect(fs.readFileSync(summaryFile, 'utf8')).toContain('[renders \\[a\\] \\*b\\*](');
  });

  it('still prints the annotation when GITHUB_OUTPUT/SUMMARY files are absent', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    emitRunOutputs(OUTPUT, silentLogger, undefined, { GITHUB_ACTIONS: 'true' });
    expect(stdout).toHaveBeenCalledWith('::notice title=Piwi test run::https://dash.example.com/test-runs/42\n');
  });
});

describe('emitResourceSummary', () => {
  const lines = ['Resources: 1 leak', '  leaked   context     tests/cart.spec.ts:4 · 1 test · open 2.0 s past its test'];

  it('adds the resource summary to the GitHub job summary as preformatted text', () => {
    const summaryFile = path.join(tmpDir, 'gh-summary');
    emitResourceSummary(lines, silentLogger, { GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summaryFile });
    expect(fs.readFileSync(summaryFile, 'utf8')).toBe(['### Piwi resources', '', '```text', ...lines, '```', '', ''].join('\n'));
  });

  it('writes nothing outside GitHub Actions, or with nothing to report', () => {
    const summaryFile = path.join(tmpDir, 'gh-summary');
    emitResourceSummary(lines, silentLogger, { GITHUB_STEP_SUMMARY: summaryFile });
    emitResourceSummary([], silentLogger, { GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summaryFile });
    expect(fs.existsSync(summaryFile)).toBe(false);
  });
});

describe('emitRunOutputs — GitLab CI', () => {
  it('writes a dotenv report at the default path', () => {
    const cwd = process.cwd();
    process.chdir(tmpDir);
    try {
      emitRunOutputs(OUTPUT, silentLogger, undefined, { GITLAB_CI: 'true' });
      const dotenv = fs.readFileSync(path.join(tmpDir, 'piwi.env'), 'utf8');
      expect(dotenv).toContain('PIWI_RUN_URL=https://dash.example.com/test-runs/42');
      expect(dotenv).toContain('PIWI_RUN_ID=42');
      expect(dotenv).toContain('PIWI_RUN_STATUS=passed');
      expect(dotenv).toContain('PIWI_FAILED_COUNT=0');
      expect(dotenv).toContain('PIWI_PROJECT_ID=7');
      expect(dotenv).toContain('PIWI_CI_BUILD_URL=https://ci.example.com/build/9');
    } finally {
      process.chdir(cwd);
    }
  });

  it('honors PIWI_DOTENV_FILE for the dotenv path', () => {
    const file = path.join(tmpDir, 'custom.env');
    emitRunOutputs(OUTPUT, silentLogger, undefined, { GITLAB_CI: 'true', PIWI_DOTENV_FILE: file });
    expect(fs.readFileSync(file, 'utf8')).toContain('PIWI_RUN_URL=https://dash.example.com/test-runs/42');
  });
});

describe('ciBuildUrlFromMetadata', () => {
  it('prefers buildUrl, then pipelineUrl, then jobUrl', () => {
    expect(ciBuildUrlFromMetadata({ ci: { buildUrl: 'b', pipelineUrl: 'p', jobUrl: 'j' } })).toBe('b');
    expect(ciBuildUrlFromMetadata({ ci: { pipelineUrl: 'p', jobUrl: 'j' } })).toBe('p');
    expect(ciBuildUrlFromMetadata({ ci: { jobUrl: 'j' } })).toBe('j');
  });

  it('returns undefined when there is no CI metadata', () => {
    expect(ciBuildUrlFromMetadata(undefined)).toBeUndefined();
    expect(ciBuildUrlFromMetadata({})).toBeUndefined();
    expect(ciBuildUrlFromMetadata({ ci: {} })).toBeUndefined();
  });
});
