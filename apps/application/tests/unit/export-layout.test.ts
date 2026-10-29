import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  caseLabels,
  casePath,
  clusterOccurrences,
  errorRows,
  fmtDate,
  runFacts,
  runTestsByOutcome,
  statusTone,
  stepBars,
} from '../../shared/export/fields';
import { renderExportHtml } from '../../shared/export/render-html';
import { renderExportMarkdown } from '../../shared/export/render-markdown';
import { renderExportPdf } from '../../shared/export/render-pdf';
import type { ExportBundle, ExportCase } from '../../shared/export/types';

const ERROR = [
  'Error: expect(locator).toHaveCount(expected) failed',
  '',
  'Expected: 26',
  'Received: 51',
  '',
  'Call log:',
  "  - waiting for getByRole('row')",
  '',
  '    at tests/users.spec.ts:7:44',
].join('\n');

function exportCase(overrides: Partial<ExportCase> = {}): ExportCase {
  return {
    executionId: 37,
    testCaseId: 1,
    title: 'paginates the users',
    filePath: 'tests/users.spec.ts',
    location: 'tests/users.spec.ts:4:3',
    status: 'failed',
    slug: 'paginates-37',
    detail: {
      title: 'paginates the users',
      suitePath: ['Users', 'Table'],
      duration: 8700,
      startedAt: Date.UTC(2026, 9, 28, 13, 4, 43),
      error: ERROR,
      isNewRegression: true,
      tags: ['smoke'],
      testMeta: { owner: '@admin-team' },
      verdict: { headline: 'Expected 26 rows, found 51', detail: "getByRole('row')" },
      testRun: {
        id: 4,
        branch: 'main',
        environment: 'staging',
        commit: 'a1b2c3d4e5f6',
        playwrightVersion: '1.51.0',
        totalTests: 12,
        passedTests: 7,
        failedTests: 3,
        flakyTests: 1,
        skippedTests: 2,
        didNotRunTests: 0,
        metadata: {
          scm: { commitMessage: 'Paginate on the server\n\nbody', author: 'Eva' },
          ci: { provider: 'GitHub Actions', runNumber: '1192' },
        },
      },
      steps: [
        { title: 'Navigate', subtitle: '/users', category: 'navigation', duration: 1000, startTime: 1000 },
        { title: 'Expect "toHaveCount"', category: 'assertion', duration: 3000, startTime: 2000, failed: true },
      ],
      testSourceFrames: [
        { file: 'tests/users.spec.ts', line: 7, snippet: '   6 | // rows\n>  7 | await expect(rows).toHaveCount(26);' },
      ],
    },
    traces: [],
    diagnosis: null,
    assets: [],
    ...overrides,
  };
}

function bundle(overrides: Partial<ExportBundle> = {}): ExportBundle {
  return {
    kind: 'execution',
    generatedAt: '2026-10-29T16:24:05.126Z',
    piwiVersion: '0.62.0',
    sourceUrl: null,
    title: 'paginates the users',
    project: { id: 1, name: 'web', label: 'Web' },
    cluster: null,
    cases: [exportCase()],
    truncatedCases: [],
    omitted: [],
    ...overrides,
  };
}

const noAssets = { assetUrl: () => null };

describe('the facts an export states', () => {
  it('writes a moment in UTC as a reader reads it', () => {
    expect(fmtDate('2026-10-29T16:24:05.126Z')).toBe('Oct 29, 2026, 16:24 UTC');
    expect(fmtDate(Date.UTC(2026, 0, 5, 3, 7))).toBe('Jan 5, 2026, 03:07 UTC');
    expect(fmtDate('not a date')).toBeNull();
  });

  it('names the run with its branch, environment, commit and CI build', () => {
    expect(runFacts(exportCase().detail.testRun as Record<string, unknown>)).toEqual([
      ['Run', '#4'],
      ['Branch', 'main'],
      ['Environment', 'staging'],
      ['Commit', 'a1b2c3d Paginate on the server (Eva)'],
      ['CI build', 'GitHub Actions #1192'],
      ['Playwright', '1.51.0'],
    ]);
  });

  it("splits the run's tests by outcome, flaky ones apart from the passed", () => {
    expect(runTestsByOutcome(exportCase().detail.testRun as Record<string, unknown>)).toEqual({
      total: 12,
      segments: [
        { key: 'passed', label: 'passed', count: 6 },
        { key: 'failed', label: 'failed', count: 3 },
        { key: 'flaky', label: 'flaky', count: 1 },
        { key: 'skipped', label: 'skipped', count: 2 },
      ],
    });
    expect(runTestsByOutcome(undefined)).toBeNull();
    expect(runTestsByOutcome({ totalTests: 0 })).toBeNull();
  });

  it('names the test by its describe blocks, and labels what is new about it', () => {
    expect(casePath(exportCase())).toBe('Users › Table › paginates the users');
    expect(caseLabels(exportCase())).toEqual([
      { text: 'New regression', news: true },
      { text: 'Owner @admin-team', news: false },
      { text: 'smoke', news: false },
    ]);
  });

  it('tells the parts of an error apart', () => {
    expect(errorRows(ERROR).map((r) => r.kind)).toEqual([
      'head',
      'body',
      'expected',
      'received',
      'body',
      'log',
      'log',
      'body',
      'stack',
    ]);
  });

  it("places each step on the test's timeline, or against the longest without start times", () => {
    expect(stepBars(exportCase().detail.steps as Record<string, any>[])).toEqual([
      { offset: 0, width: 0.25 },
      { offset: 0.25, width: 0.75 },
    ]);
    expect(stepBars([{ duration: 50 }, { duration: 200 }])).toEqual([
      { offset: 0, width: 0.25 },
      { offset: 0, width: 1 },
    ]);
  });

  it('colors a status as the dashboard does', () => {
    const tones = (statuses: string[]) => statuses.map((status) => statusTone(status));
    expect(tones(['failed', 'timedOut', 'interrupted', 'open'])).toEqual(['failed', 'failed', 'failed', 'failed']);
    expect(tones(['passed', 'resolved', 'flaky', 'didNotRun', 'running'])).toEqual([
      'passed',
      'passed',
      'flaky',
      'didnotrun',
      'running',
    ]);
    expect(statusTone('passed', 2)).toBe('flaky');
    expect(tones(['skipped', 'unknown', 'cancelled', ''])).toEqual(['skipped', 'skipped', 'skipped', 'skipped']);
  });

  it("orders a cluster's recent runs oldest first", () => {
    const cluster = {
      occurrenceSeries: [
        { runId: 9, startedAt: '2026-10-29T00:00:00Z', occurrences: 2 },
        { runId: 8, startedAt: '2026-10-28T00:00:00Z', occurrences: 0 },
      ],
    };
    expect(clusterOccurrences(cluster)).toEqual([
      { runId: 8, count: 0 },
      { runId: 9, count: 2 },
    ]);
  });
});

describe('the HTML export', () => {
  const html = renderExportHtml(bundle(), noAssets);

  it("opens on the execution's outcome, full name and the reading of its failure", () => {
    expect(html).toContain('class="hero t-fail"');
    expect(html).toContain('Users › Table › paginates the users');
    expect(html).toContain('Expected 26 rows, found 51');
    expect(html).toContain('<span class="chip new">New regression</span>');
    expect(html).toContain('Exported Oct 29, 2026, 16:24 UTC');
  });

  it("draws the run's tests as a bar and says the same counts in words", () => {
    expect(html).toContain('aria-label="6 passed (50%) · 3 failed (25%) · 1 flaky (8.3%) · 2 skipped (17%)"');
    expect(html).toContain('a1b2c3d Paginate on the server (Eva)');
  });

  it('colors the expected and received values and marks the failing source line', () => {
    expect(html).toContain('<span class="e-expected">Expected: 26</span>');
    expect(html).toContain('<span class="e-received">Received: 51</span>');
    expect(html).toContain('<span class="fail-line"><span class="ln">&gt;  7 | </span>');
  });

  it('puts the steps on a timeline, the failed one in red', () => {
    expect(html).toContain('<tr class="failed slowest">');
    expect(html).toContain('left:25.00%;width:75.00%');
  });

  it('opens a cluster on its state and its recent runs', () => {
    const cluster = renderExportHtml(
      bundle({
        kind: 'cluster',
        title: 'Rows do not match',
        cluster: {
          signature: 'Rows do not match',
          status: 'open',
          clusterState: { sentence: 'Fixed in run #62 and verified, still marked open.' },
          occurrenceSeries: [
            { runId: 1, startedAt: '2026-10-27T00:00:00Z', occurrences: 0 },
            { runId: 2, startedAt: '2026-10-28T00:00:00Z', occurrences: 1 },
          ],
        },
      }),
      noAssets,
    );
    expect(cluster).toContain('Fixed in run #62 and verified, still marked open.');
    expect(cluster).toContain('Failed in 1 of the last 2 runs, oldest on the left.');
  });
});

describe('the Markdown export', () => {
  it('states the run and its tests by outcome', () => {
    const md = renderExportMarkdown(bundle());
    expect(md).toContain('### The run');
    expect(md).toContain('- **Commit:** a1b2c3d Paginate on the server (Eva)');
    expect(md).toContain('6 passed (50%) · 3 failed (25%) · 1 flaky (8.3%) · 2 skipped (17%)');
  });
});

describe('the PDF export', () => {
  const content = (bytes: Uint8Array): string => {
    const raw = Buffer.from(bytes).toString('latin1');
    let out = '';
    for (const m of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
      try {
        out += zlib.inflateSync(Buffer.from(m[1]!, 'latin1')).toString('latin1') + '\n';
      } catch {
        // Not a Flate stream.
      }
    }
    return out;
  };

  it('tints the failing source line and numbers every page', async () => {
    const pdf = content(await renderExportPdf(bundle(), { imageFor: () => null }));
    // The failed fill (#f43f5e) at a tenth over white, behind the `>`-marked line.
    expect(pdf).toContain('0.995686274509804 0.9247058823529413 0.9368627450980392 rg');
    // Standard fonts write text as hex: `1 / 1`.
    expect(pdf).toContain(`<${Buffer.from('1 / 1', 'latin1').toString('hex').toUpperCase()}> Tj`);
  });
});

/** The text a PDF draws, from its inflated content streams: standard fonts write each string as hex. */
function pdfText(bytes: Uint8Array): string[] {
  const raw = Buffer.from(bytes).toString('latin1');
  const out: string[] = [];
  for (const m of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    let content = '';
    try {
      content = zlib.inflateSync(Buffer.from(m[1]!, 'latin1')).toString('latin1');
    } catch {
      continue;
    }
    for (const t of content.matchAll(/<([0-9A-F]*)> Tj/g)) out.push(Buffer.from(t[1]!, 'hex').toString('latin1'));
  }
  return out;
}

describe('the PDF export, at its limits', () => {
  it('wraps a long row of labels instead of dropping the ones past the first line', async () => {
    const tags = Array.from({ length: 14 }, (_, i) => `tag-number-${i}`);
    const many = bundle({ cases: [exportCase({ detail: { ...exportCase().detail, tags } })] });
    const text = pdfText(await renderExportPdf(many, { imageFor: () => null }));
    for (const tag of tags) expect(text).toContain(tag);
  });

  it('keeps a header with a very long title to one page, its title ending with an ellipsis', async () => {
    const title = Array.from({ length: 400 }, (_, i) => `word${i}`).join(' ');
    const long = bundle({ title, cases: [exportCase({ title })] });
    const text = pdfText(await renderExportPdf(long, { imageFor: () => null }));
    // WinAnsi writes the ellipsis as 0x85.
    expect(text.some((t) => t.endsWith('\x85') && t.startsWith('word'))).toBe(true);
    expect(text).not.toContain('word399');
  });
});
