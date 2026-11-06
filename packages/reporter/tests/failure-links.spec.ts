import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  FailureLinks,
  caseLocateUrl,
  failureHeadline,
  formatFailureLine,
} from '../src/internal/support/failure-links.js';
import { Logger } from '../src/internal/support/logger.js';
import { PiwiDashboardReporter } from '../src/public/reporter.js';
import { startServer, jsonRes, fakeConfig, fakeSuite, fakeTestCase, fakeResult } from './_helpers.js';

const TEST = {
  title: 'applies the discount',
  file: 'tests/checkout.spec.ts',
  retry: 2,
  browser: 'chromium',
  headline: null,
};

describe('caseLocateUrl', () => {
  it('builds the resolver URL from the run id and the test identity', () => {
    expect(caseLocateUrl('https://dash.example.com/test-runs/42', TEST)).toBe(
      'https://dash.example.com/test-runs/42/locate?file=tests%2Fcheckout.spec.ts&title=applies%20the%20discount&retry=2&browser=chromium',
    );
  });

  it('omits the browser when the test ran under no project', () => {
    expect(caseLocateUrl('https://dash.example.com/test-runs/42', { ...TEST, browser: null })).toBe(
      'https://dash.example.com/test-runs/42/locate?file=tests%2Fcheckout.spec.ts&title=applies%20the%20discount&retry=2',
    );
  });

  it('names the `--repeat-each` repetition past the first', () => {
    expect(caseLocateUrl('https://dash.example.com/test-runs/42', { ...TEST, repeatEachIndex: 3 })).toBe(
      'https://dash.example.com/test-runs/42/locate?file=tests%2Fcheckout.spec.ts&title=applies%20the%20discount&retry=2&browser=chromium&repeat=3',
    );
    expect(caseLocateUrl('https://dash.example.com/test-runs/42', { ...TEST, repeatEachIndex: 0 })).not.toContain(
      'repeat=',
    );
  });

  it('encodes characters a title may carry', () => {
    const url = caseLocateUrl('https://dash.example.com/test-runs/1', { ...TEST, title: 'a+b & c=d #1' });
    expect(url).toContain('title=a%2Bb%20%26%20c%3Dd%20%231');
  });
});

describe('failureHeadline', () => {
  it('explains the error in one line, naming the failed step on a test timeout', () => {
    expect(
      failureHeadline(
        "TimeoutError: locator.click: Timeout 30000ms exceeded.\nCall log:\n  - waiting for getByRole('button', { name: 'Pay' })\n",
      ),
    ).toBe("getByRole('button', { name: 'Pay' }) was not found on the page — click timed out after 30 s");
    expect(
      failureHeadline('Test timeout of 30000ms exceeded.', [
        { title: "page.goto('/checkout')" },
        { title: 'fillPaymentDetails(page)', failed: true },
      ]),
    ).toBe('Test timed out after 30 s while "fillPaymentDetails(page)"');
    expect(failureHeadline(null)).toBeNull();
  });
});

describe('formatFailureLine', () => {
  it('puts the headline between the title and the link, and omits it when there is none', () => {
    const url = 'https://dash.example.com/test-runs/1/locate?file=a';
    expect(formatFailureLine({ ...TEST, url, headline: 'Navigation to /users timed out after 30 s' })).toBe(
      `✗ applies the discount — Navigation to /users timed out after 30 s → ${url}`,
    );
    expect(formatFailureLine({ ...TEST, url })).toBe(`✗ applies the discount → ${url}`);
  });
});

describe('FailureLinks', () => {
  it('prints one line per failure, each only once', () => {
    const logger = new Logger(false);
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {});
    const links = new FailureLinks('https://dash.example.com', logger);

    links.add(TEST);
    links.add({ ...TEST, title: 'second' });
    links.printPending(7);
    links.printPending(7);
    links.add({ ...TEST, title: 'third' });
    links.printPending(7);

    expect(info.mock.calls.map((c) => c[0])).toEqual([
      formatFailureLine({ ...TEST, url: caseLocateUrl('https://dash.example.com/test-runs/7', TEST) }),
      `✗ second → ${caseLocateUrl('https://dash.example.com/test-runs/7', { ...TEST, title: 'second' })}`,
      `✗ third → ${caseLocateUrl('https://dash.example.com/test-runs/7', { ...TEST, title: 'third' })}`,
    ]);
    expect(links.count).toBe(3);
  });

  it('resolves every failure against the run id it is given', () => {
    const links = new FailureLinks('https://dash.example.com', new Logger(false));
    links.add(TEST);
    expect(links.resolve(9)).toEqual([{ ...TEST, url: caseLocateUrl('https://dash.example.com/test-runs/9', TEST) }]);
  });

  it('leads under the page the instance named for the run, where it named one', () => {
    const links = new FailureLinks('http://piwi.internal:3000', new Logger(false));
    links.add(TEST);
    links.knowPage(9, 'https://piwi.example.com/test-runs/9');
    expect(links.resolve(9)[0]!.url).toMatch(/^https:\/\/piwi\.example\.com\/test-runs\/9\/locate\?/);
    expect(links.resolve(10)[0]!.url).toMatch(/^http:\/\/piwi\.internal:3000\/test-runs\/10\/locate\?/);
  });
});

describe('the failures the reporter links', () => {
  /** The title and retry of each failure the run output links, once `attempts` of the tests of `suite` ended. */
  async function linkedFailures(
    suite: any,
    tests: any[],
    attempts: Array<[any, number, string]>,
    config: Record<string, unknown> = {},
  ): Promise<Array<[string, number]>> {
    const server = await startServer((_req, res) => jsonRes(res, 200, { runId: 5, projectId: 1 }));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-failure-links-'));
    const outputFile = path.join(dir, 'run.json');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const reporter = new PiwiDashboardReporter({
        serverUrl: server.url,
        projectName: 'piwi-failure-links-' + process.pid,
        streaming: false,
        uploadReport: false,
        uploadTraces: false,
        liveFileUploads: false,
        captureResources: false,
        outputFile,
      });
      suite.allTests = () => tests;
      reporter.onBegin({ ...fakeConfig(), ...config }, suite);
      for (const [t, retry, status] of attempts) {
        reporter.onTestBegin(t, fakeResult({ retry }));
        reporter.onTestEnd(t, fakeResult({ status, retry, error: status === 'failed' ? new Error('no') : null }));
      }
      await reporter.onEnd({ status: 'failed' } as any);

      const { failures } = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
      return failures.map((f: any) => [f.title, f.retry]).sort();
    } finally {
      vi.restoreAllMocks();
      fs.rmSync(dir, { recursive: true, force: true });
      await server.close();
    }
  }

  it('links a test whose retry the run never made, as Playwright counts it failed', async () => {
    const suite = fakeSuite();
    const test = (title: string, line: number) => ({
      ...fakeTestCase({ id: title, title, line, parent: suite }),
      retries: 2,
    });
    const fast = test('fails fast', 1);
    const slow = test('fails slowly', 2);
    const cut = test('is cut short', 3);
    // As Playwright ends a run whose `maxFailures` is reached: "fails fast" failed its three attempts, the run
    // stopped before the third attempt of "fails slowly", and it interrupted the retry of "is cut short".
    const attempts: Array<[any, number, string]> = [
      [fast, 0, 'failed'],
      [slow, 0, 'failed'],
      [cut, 0, 'failed'],
      [fast, 1, 'failed'],
      [slow, 1, 'failed'],
      [fast, 2, 'failed'],
      [cut, 1, 'interrupted'],
    ];
    expect(await linkedFailures(suite, [fast, slow, cut], attempts, { maxFailures: 1 })).toEqual([
      ['fails fast', 2],
      ['fails slowly', 1],
      ['is cut short', 0],
    ]);
  });

  it('links a failed test whose retry did not run, as Playwright counts it failed', async () => {
    const suite = fakeSuite();
    const test = (title: string, line: number) => ({
      ...fakeTestCase({ id: title, title, line, parent: suite }),
      retries: 1,
    });
    const pays = test('pays', 1);
    const refunds = test('refunds', 2);
    // A `describe.serial` group: "refunds" fails, and the group's retry stops at "pays", so "refunds" is skipped there.
    const attempts: Array<[any, number, string]> = [
      [pays, 0, 'passed'],
      [refunds, 0, 'failed'],
      [pays, 1, 'failed'],
      [refunds, 1, 'skipped'],
    ];
    expect(await linkedFailures(suite, [pays, refunds], attempts)).toContainEqual(['refunds', 0]);
  });
});
