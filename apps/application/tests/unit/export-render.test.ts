import zlib from 'node:zlib';
import { describe, it, expect } from 'vitest';
import { buildExport } from '../../shared/export/build';
import { renderExportHtml } from '../../shared/export/render-html';
import { parseZipSync } from '../utils/zip';
import type { ExportAsset, ExportBundle, ExportCase } from '../../shared/export/types';

const decoder = new TextDecoder();

function asset(overrides: Partial<ExportAsset> = {}): ExportAsset {
  return {
    storagePath: 'project-1/shot.png',
    zipPath: 'evidence/login-1/screenshots/shot.png',
    kind: 'screenshot',
    name: 'shot.png',
    contentType: 'image/png',
    size: 4,
    ...overrides,
  };
}

function exportCase(overrides: Partial<ExportCase> = {}): ExportCase {
  return {
    executionId: 1,
    testCaseId: 7,
    title: 'login works',
    filePath: 'tests/login.spec.ts',
    location: 'tests/login.spec.ts:10:5',
    status: 'failed',
    slug: 'login-1',
    detail: { duration: 1200, error: 'boom' },
    traces: [],
    diagnosis: null,
    assets: [],
    ...overrides,
  };
}

function bundle(overrides: Partial<ExportBundle> = {}): ExportBundle {
  return {
    kind: 'execution',
    generatedAt: '2026-01-01T00:00:00.000Z',
    piwiVersion: '0.19.0',
    sourceUrl: null,
    title: 'login works',
    project: { id: 1, name: 'web', label: 'Web' },
    cluster: null,
    cases: [exportCase()],
    truncatedCases: [],
    omitted: [],
    ...overrides,
  };
}

const noAssets = { assetUrl: () => null };

describe('renderExportHtml', () => {
  it('escapes hostile text from a test run', () => {
    const hostile = '<script>alert(1)</script>';
    const html = renderExportHtml(
      bundle({
        title: hostile,
        cases: [
          exportCase({
            title: hostile,
            detail: {
              error: hostile,
              consoleLogs: [{ type: 'error', text: hostile }],
              ariaSnapshot: hostile,
              testSource: hostile,
              networkRequests: [{ method: 'GET', status: 200, url: hostile }],
            },
          }),
        ],
      }),
      noAssets,
    );

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('strips ANSI escapes from error text', () => {
    const html = renderExportHtml(
      bundle({ cases: [exportCase({ detail: { error: '\x1b[31mExpected true\x1b[39m' } })] }),
      noAssets,
    );
    expect(html).toContain('Expected true');
    expect(html).not.toContain('\x1b[31m');
  });

  it('syntax-highlights call stack snippets behind a plain line-number gutter', () => {
    const snippet = ['     9 | const total = 1;', '>   10 | await page.getByRole("button").click();'].join('\n');
    const html = renderExportHtml(
      bundle({
        cases: [exportCase({ detail: { testSourceFrames: [{ file: 'tests/login.spec.ts', line: 10, snippet }] } })],
      }),
      noAssets,
    );
    expect(html).toContain('<span class="ln">&gt;   10 | </span>');
    expect(html).toContain('<span class="hljs-keyword">await</span>');
  });

  it('references nothing outside the document', () => {
    const html = renderExportHtml(bundle({ sourceUrl: 'https://piwi.example.com/test-run-cases/1' }), noAssets);
    // The source URL is recorded as text, never as a fetchable reference.
    expect(html).not.toMatch(/(?:src|href)\s*=\s*["']https?:/i);
    expect(html).not.toMatch(/(?:src|href)\s*=\s*["']\/\//);
    expect(html).toContain('https://piwi.example.com/test-run-cases/1');
  });

  it('colors a timed-out case as a failure and a case that did not run as a warning, matching the dashboard', () => {
    const html = renderExportHtml(
      bundle({ cases: [exportCase({ status: 'timedout' }), exportCase({ status: 'didnotrun' })] }),
      noAssets,
    );
    expect(html).toContain('class="badge s-timedout"');
    expect(html).toContain('class="badge s-didnotrun"');
    // getStatusColor maps timedout to error and didnotrun to warning.
    expect(html).toMatch(/\.s-timedout[^}]*var\(--fail\)/);
    expect(html).toMatch(/\.s-didnotrun[^}]*var\(--warn\)/);
  });

  it('carries a restrictive content security policy', () => {
    expect(renderExportHtml(bundle(), noAssets)).toContain("default-src 'none'");
  });

  it('keeps a print button in the standalone report but never auto-prints', () => {
    const html = renderExportHtml(bundle(), noAssets);
    // The HTML file offers its own print button, but nothing prints on load —
    // the dashboard's PDF export is a real generated file, not a print.
    expect(html).toContain('data-action="print"');
    expect(html).not.toContain("window.addEventListener('load'");
  });

  it('lists omitted evidence with a reason', () => {
    const html = renderExportHtml(
      bundle({ omitted: [{ name: 'video.webm', kind: 'video', bytes: 90_000_000, reason: 'too-large' }] }),
      noAssets,
    );
    expect(html).toContain('Omitted from this export');
    expect(html).toContain('video.webm');
    expect(html).toContain('larger than the per-file inline limit');
  });

  it('lists cluster members that were not expanded', () => {
    const html = renderExportHtml(
      bundle({
        kind: 'cluster',
        cluster: { signature: 'Timeout', errorType: 'timeout', occurrences: 12 },
        truncatedCases: [{ testCaseId: 9, title: 'checkout works', filePath: 'tests/checkout.spec.ts' }],
      }),
      noAssets,
    );
    expect(html).toContain('Other affected tests (1, evidence not included)');
    expect(html).toContain('checkout works');
  });
});

describe('buildExport', () => {
  const reader = { read: async () => new Uint8Array([1, 2, 3, 4]) };
  const budget = { maxInlineBytes: 1024, maxTotalBytes: 1024 * 1024 };

  it('inlines a screenshot as a data URI in HTML', async () => {
    const built = await buildExport(bundle({ cases: [exportCase({ assets: [asset()] })] }), 'html', 1, {
      reader,
      budget,
    });
    expect(built.contentType).toBe('text/html; charset=utf-8');
    expect(decoder.decode(built.bytes)).toContain('src="data:image/png;base64,AQIDBA=="');
  });

  it('omits an oversized screenshot from HTML and says so', async () => {
    const b = bundle({ cases: [exportCase({ assets: [asset({ size: 99_999 })] })] });
    const html = decoder.decode((await buildExport(b, 'html', 1, { reader, budget })).bytes);
    expect(html).not.toContain('data:image/png');
    expect(html).toContain('larger than the per-file inline limit');
    expect(b.omitted[0]).toMatchObject({ name: 'shot.png', reason: 'too-large' });
  });

  it('keeps traces out of HTML but carries them in the ZIP', async () => {
    const traceAsset = asset({
      kind: 'trace',
      name: 'trace.zip',
      zipPath: 'evidence/login-1/traces/trace.zip',
      contentType: 'application/zip',
      storagePath: 'project-1/trace.zip',
    });

    const htmlBundle = bundle({ cases: [exportCase({ assets: [traceAsset] })] });
    await buildExport(htmlBundle, 'html', 1, { reader, budget });
    expect(htmlBundle.omitted[0]).toMatchObject({ reason: 'html-format' });

    const zipBundle = bundle({ cases: [exportCase({ assets: [traceAsset] })] });
    const built = await buildExport(zipBundle, 'zip', 1, { reader, budget });
    const names = parseZipSync(Buffer.from(built.bytes)).map((e) => e.name);
    expect(names).toContain('evidence/login-1/traces/trace.zip');
    expect(zipBundle.omitted).toHaveLength(0);
  });

  it('lays out the ZIP with a report, data and per-case evidence', async () => {
    const b = bundle({
      cases: [
        exportCase({
          assets: [asset()],
          detail: {
            error: 'boom',
            consoleLogs: [{ type: 'error', text: 'bad' }],
            networkRequests: [{ method: 'GET', status: 500, url: '/api/x' }],
            ariaSnapshot: 'button "Save"',
            testSource: 'await expect(page).toHaveTitle();',
          },
        }),
      ],
    });
    const entries = parseZipSync(Buffer.from((await buildExport(b, 'zip', 1, { reader, budget })).bytes));
    const names = entries.map((e) => e.name);

    expect(names).toContain('report.html');
    expect(names).toContain('data.json');
    expect(names).toContain('README.txt');
    expect(names).toContain('evidence/login-1/screenshots/shot.png');
    expect(names).toContain('evidence/login-1/console.log');
    expect(names).toContain('evidence/login-1/network.json');
    expect(names).toContain('evidence/login-1/aria-snapshot.txt');
    expect(names).toContain('evidence/login-1/source.txt');
    expect(names).toContain('evidence/login-1/error.txt');
  });

  it("points the ZIP's report at relative paths, never data URIs", async () => {
    const b = bundle({ cases: [exportCase({ assets: [asset()] })] });
    const entries = parseZipSync(Buffer.from((await buildExport(b, 'zip', 1, { reader, budget })).bytes));
    const report = entries.find((e) => e.name === 'report.html')!.data.toString('utf8');

    expect(report).toContain('src="evidence/login-1/screenshots/shot.png"');
    expect(report).not.toContain('data:image/png');
  });

  it('records omissions in the ZIP report, which is rendered after every read', async () => {
    const failing = { read: async () => null };
    const b = bundle({ cases: [exportCase({ assets: [asset()] })] });
    const entries = parseZipSync(Buffer.from((await buildExport(b, 'zip', 1, { reader: failing, budget })).bytes));
    const report = entries.find((e) => e.name === 'report.html')!.data.toString('utf8');

    expect(report).toContain('Omitted from this export');
    expect(report).toContain('could not be read from storage');
  });

  it('stops adding evidence once the total budget is spent', async () => {
    // Bytes match the declared size, as they do in storage — the cheap
    // pre-check and the real accounting then agree.
    const sized = { read: async (a: ExportAsset) => new Uint8Array(a.size ?? 0) };
    const b = bundle({
      cases: [
        exportCase({
          assets: [
            asset({ name: 'a.png', storagePath: 'p/a.png', zipPath: 'evidence/login-1/screenshots/a.png', size: 400 }),
            asset({ name: 'b.png', storagePath: 'p/b.png', zipPath: 'evidence/login-1/screenshots/b.png', size: 400 }),
          ],
        }),
      ],
    });
    await buildExport(b, 'zip', 1, { reader: sized, budget: { maxInlineBytes: 1024, maxTotalBytes: 500 } });
    expect(b.omitted).toEqual([{ name: 'b.png', kind: 'screenshot', bytes: 400, reason: 'budget-exhausted' }]);
  });

  it('names the file after the kind, id and title', async () => {
    const built = await buildExport(bundle({ title: 'login works!' }), 'zip', 42, { reader, budget });
    expect(built.fileName).toBe('piwi-execution-42-login-works.zip');
  });

  it('produces a real PDF document', async () => {
    const built = await buildExport(
      bundle({
        cases: [
          exportCase({
            detail: {
              error: 'boom',
              steps: [{ title: 'click', category: 'action', duration: 12 }],
              consoleLogs: [{ type: 'error', text: 'bad' }],
              networkRequests: [{ method: 'GET', status: 500, url: '/api/x' }],
              testSource: 'await expect(page).toHaveTitle();',
              ariaSnapshot: 'button "Save"',
            },
          }),
        ],
      }),
      'pdf',
      7,
      { reader, budget },
    );
    expect(built.contentType).toBe('application/pdf');
    expect(built.fileName).toBe('piwi-execution-7-login-works.pdf');
    // A valid PDF begins with the %PDF- signature.
    expect(decoder.decode(built.bytes.subarray(0, 5))).toBe('%PDF-');
    expect(built.bytes.length).toBeGreaterThan(500);
  });

  // pdf-lib Flate-compresses its content streams; inflate them back to the text
  // and drawing operators so a test can assert what the page actually paints.
  const pdfContent = (bytes: Uint8Array): string => {
    const raw = Buffer.from(bytes).toString('latin1');
    let content = '';
    for (const m of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
      try {
        content += zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1') + '\n';
      } catch {
        // Not a Flate stream (an embedded image, say) — nothing to read here.
      }
    }
    return content;
  };

  it('syntax-highlights source blocks with token colors', async () => {
    const built = await buildExport(
      bundle({ cases: [exportCase({ detail: { testSource: 'const answer = 42;' } })] }),
      'pdf',
      1,
      { reader, budget },
    );
    // 0.486 0.227 0.929 is the keyword purple; a plain monospace block, drawn in
    // the near-black foreground, never sets it. `const` is a TypeScript keyword.
    expect(pdfContent(built.bytes)).toContain('0.486 0.227 0.929 rg');
  });

  it('syntax-highlights call stack snippets', async () => {
    const built = await buildExport(
      bundle({
        cases: [
          exportCase({
            detail: {
              testSourceFrames: [{ file: 'tests/login.spec.ts', line: 3, snippet: '>    3 | const answer = 42;' }],
            },
          }),
        ],
      }),
      'pdf',
      1,
      { reader, budget },
    );
    expect(pdfContent(built.bytes)).toContain('0.486 0.227 0.929 rg');
  });

  it('lists evidence a PDF cannot carry as omitted', async () => {
    const traceAsset = asset({
      kind: 'trace',
      name: 'trace.zip',
      zipPath: 'evidence/login-1/traces/trace.zip',
      contentType: 'application/zip',
      storagePath: 'project-1/trace.zip',
    });
    const b = bundle({ cases: [exportCase({ assets: [traceAsset] })] });
    await buildExport(b, 'pdf', 1, { reader, budget });
    expect(b.omitted[0]).toMatchObject({ name: 'trace.zip', reason: 'pdf-format' });
  });

  it('reads back as JSON and Markdown without touching storage', async () => {
    const throwing = {
      read: async () => {
        throw new Error('storage must not be read for text formats');
      },
    };
    const json = await buildExport(bundle({ cases: [exportCase({ assets: [asset()] })] }), 'json', 1, {
      reader: throwing,
      budget,
    });
    expect(JSON.parse(decoder.decode(json.bytes)).title).toBe('login works');

    const md = await buildExport(bundle({ cases: [exportCase({ assets: [asset()] })] }), 'md', 1, {
      reader: throwing,
      budget,
    });
    expect(decoder.decode(md.bytes)).toContain('# login works');
  });
});
