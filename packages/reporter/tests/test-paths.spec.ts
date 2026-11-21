import { afterEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { PiwiDashboardReporter } from '../src/public/reporter.js';
import { configDirFromConfig, relativeTestPath } from '../src/internal/support/test-paths.js';
import { fakeConfig, fakeResult, fakeSuite, fakeTestCase, jsonRes, startServer, type FakeServer } from './_helpers.js';

describe('the folder test files are named relative to', () => {
  it("is the config file's, else rootDir, else the working directory", () => {
    expect(configDirFromConfig({ configFile: '/repo/e2e/playwright.config.ts', rootDir: '/repo/e2e/tests' })).toBe(
      '/repo/e2e',
    );
    expect(configDirFromConfig({ rootDir: '/repo/tests' })).toBe('/repo/tests');
    expect(configDirFromConfig(undefined)).toBe(process.cwd());
  });

  it('names a file with POSIX separators', () => {
    expect(relativeTestPath(path.join('/repo', 'tests', 'a', 'login.spec.ts'), '/repo')).toBe('tests/a/login.spec.ts');
  });
});

describe('the location the reporter sends for a test, which the dashboard reads its file from', () => {
  let server: FakeServer | null = null;
  afterEach(async () => {
    await server?.close();
    server = null;
  });

  /** The test case the reporter submits for one test of `file`, under a config at `configFile`. */
  async function submittedCase(configFile: string, file: string): Promise<{ location: string }> {
    const bodies: any[] = [];
    server = await startServer((req, res) => {
      if (req.url === '/api/test-runs/submit') bodies.push(JSON.parse(req.body));
      jsonRes(res, 200, { runId: 1, projectId: 1 });
    });
    const reporter = new PiwiDashboardReporter({
      serverUrl: server.url,
      projectName: 'piwi-test-paths-' + process.pid,
      streaming: false,
      uploadReport: false,
      uploadTraces: false,
      liveFileUploads: false,
    });
    const suite = fakeSuite();
    const test = fakeTestCase({ title: 'logs in', file, line: 3, column: 5, parent: suite });
    suite.allTests = () => [test];
    reporter.onBegin(fakeConfig({ configFile }), suite);
    reporter.onTestBegin(test, fakeResult({ workerIndex: 0 }));
    reporter.onTestEnd(test, fakeResult({ status: 'passed', duration: 5, workerIndex: 0 }));
    await reporter.onEnd({ status: 'passed' } as any);
    return bodies[0].testCases[0];
  }

  it('is what it was for a config at the root of the working directory', async () => {
    const file = path.join(process.cwd(), 'tests', 'login.spec.ts');
    const sent = await submittedCase(path.join(process.cwd(), 'playwright.config.ts'), file);
    const cwdRelative = path.relative(process.cwd(), file).split(path.sep).join('/');
    expect(sent.location).toBe(`${cwdRelative}:3:5`);
    expect(sent.location).toBe('tests/login.spec.ts:3:5');
  });

  it("is relative to the config's folder, whatever directory Playwright runs from", async () => {
    const project = path.join(path.parse(process.cwd()).root, 'elsewhere', 'e2e');
    const sent = await submittedCase(
      path.join(project, 'playwright.config.ts'),
      path.join(project, 'tests', 'a.spec.ts'),
    );
    expect(sent.location).toBe('tests/a.spec.ts:3:5');
  });
});
