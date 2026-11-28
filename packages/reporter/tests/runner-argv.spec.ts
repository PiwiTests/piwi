import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PiwiDashboardReporter } from '../src/public/reporter.js';
import { recoveryFiles } from '../src/internal/streaming/crash-recovery.js';
import { privateTempDir } from '../src/internal/support/private-file.js';
import { hashForProject } from '../src/internal/support/instance-id.js';
import { fakeConfig, fakeSuite, jsonRes, startServer, textRes, type FakeServer } from './_helpers.js';

/**
 * The reporter reads the runner's command line from Playwright's snapshot of it (`config.argv`, Playwright 1.61 and
 * later), this process's `process.argv` standing in where Playwright gives none: the filters that make a run partial,
 * and `--list`, under which it registers nothing.
 */
describe("the runner's command line", () => {
  const projectName = `piwi-runner-argv-${process.pid}`;
  const NODE = ['/usr/bin/node', '/path/to/playwright/cli.js'];
  let server: FakeServer | undefined;
  let requests: string[] = [];
  let submitBody: any;

  function cleanup(): void {
    const hash = hashForProject(projectName);
    for (const f of fs.readdirSync(privateTempDir())) {
      if ((f.startsWith('piwi-dashboard-stream-') || f.startsWith('piwi-dashboard-setup-')) && f.includes(hash)) {
        fs.rmSync(path.join(privateTempDir(), f), { force: true });
      }
    }
    if (server) for (const file of recoveryFiles(server.url, projectName)) fs.rmSync(file, { force: true });
  }

  beforeEach(async () => {
    requests = [];
    submitBody = undefined;
    server = await startServer((req, res) => {
      requests.push(req.url ?? '');
      if (req.url === '/api/test-runs/submit') {
        submitBody = JSON.parse(req.body);
        jsonRes(res, 200, { runId: 8, projectId: 1 });
      } else textRes(res, 404, 'nope');
    });
    cleanup();
  });

  afterEach(async () => {
    cleanup();
    await server?.close();
    server = undefined;
  });

  const reporter = () =>
    new PiwiDashboardReporter({
      serverUrl: server!.url,
      projectName,
      streaming: false,
      uploadReport: false,
      uploadTraces: false,
    });

  it("makes the run partial with the filters of Playwright's config.argv", async () => {
    const piwi = reporter();
    const argv = [...NODE, 'test', 'tests/cart.spec.ts', '--grep', '@smoke'];
    piwi.onBegin({ ...fakeConfig(), argv }, fakeSuite());
    await piwi.onEnd({ status: 'passed' } as any);

    expect(submitBody.isFullRun).toBe(false);
    expect(submitBody.filterDetails).toEqual({ grep: '@smoke', files: ['tests/cart.spec.ts'] });
  });

  it('registers nothing under --list on that command line', async () => {
    const piwi = reporter();
    piwi.onBegin({ ...fakeConfig(), argv: [...NODE, 'test', '--list'] }, fakeSuite());
    await piwi.onEnd({ status: 'passed' } as any);

    expect(requests).toEqual([]);
  });

  it("reads this process's command line where Playwright gives none (watch mode, an editor's test server)", async () => {
    const own = process.argv;
    process.argv = [...NODE, 'test', 'tests/login.spec.ts'];
    try {
      const piwi = reporter();
      piwi.onBegin({ ...fakeConfig(), argv: [] }, fakeSuite());
      await piwi.onEnd({ status: 'passed' } as any);
    } finally {
      process.argv = own;
    }

    expect(submitBody.isFullRun).toBe(false);
    expect(submitBody.filterDetails).toEqual({ files: ['tests/login.spec.ts'] });
  });
});
