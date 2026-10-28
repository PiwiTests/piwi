/**
 * An agent's MCP client and a real Playwright run the service built, through the built reporter: the client lists
 * the run, pauses it and is answered at the stop with the page's snapshot, clicks a button by its ref and reads the
 * page's change, ranks the button's locators, has the steps it took written through the editor's client
 * (`piwi/stopCode`), shares the browser with Playwright's own tools for a second client to join, and resumes the test
 * to its end. Headless Chromium. Skipped when the reporter is not built (`npm run reporter:build`) or Chromium is not
 * installed.
 */
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import type { AgentsResult, RunCommand, StopBindResult } from '../src/protocol';
import { service, waitFor, type Service } from './run-fixtures';

const requireHere = createRequire(import.meta.url);
const reporter = path.resolve(import.meta.dirname, '../../reporter/dist/index.js');
const project = path.join(import.meta.dirname, `.agent-run-${process.pid}`);
const chromium = (() => {
  try {
    const { chromium: browser } = requireHere('@playwright/test') as { chromium: { executablePath(): string } };
    return fs.existsSync(browser.executablePath());
  } catch {
    return false;
  }
})();
const runnable = fs.existsSync(reporter) && chromium;

const PAGE = `<!doctype html><meta charset="utf-8"><title>Shop</title>
<h1>Shop</h1><button onclick="document.querySelector('h1').textContent = 'Clicked'">Go</button>
${Array.from({ length: 12 }, (_, i) => `<p>Mug number ${i + 1}, a mug to drink from.</p>`).join('\n')}`;

const SPEC = (base: string) => `const { test, expect } = require('../fixture.cjs');

test('waits for a click', async ({ page }) => {
  await page.goto('${base}');
  for (let i = 0; i < 600; i++) {
    if ((await page.locator('h1').textContent()) === 'Clicked') return;
    await page.waitForTimeout(25);
  }
  throw new Error('nobody clicked');
});
`;

let server: http.Server;
let ide: Service;
let agents: AgentsResult;

let ids = 0;
async function call(name: string, args: Record<string, unknown> = {}) {
  const response = await fetch(agents.url!, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${agents.token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++ids, method: 'tools/call', params: { name, arguments: args } }),
  });
  const body = (await response.json()) as { result: { content: Array<{ type: string; text?: string }> } };
  const [piwi, ...rest] = body.result.content;
  return {
    piwi: JSON.parse(piwi!.text!) as Record<string, any>,
    page: rest.find((c) => c.type === 'text')?.text ?? '',
  };
}

beforeAll(async () => {
  if (!runnable) return;
  server = http.createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  fs.rmSync(project, { recursive: true, force: true });
  fs.mkdirSync(path.join(project, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(project, 'tests', 'cart.spec.cjs'), SPEC(base));
  fs.writeFileSync(
    path.join(project, 'fixture.cjs'),
    `const { test: base, expect } = require('@playwright/test');
const { extendPiwiFixtures } = require(${JSON.stringify(reporter)});
exports.test = extendPiwiFixtures(base);
exports.expect = expect;
`,
  );
  fs.writeFileSync(
    path.join(project, 'playwright.config.cjs'),
    `module.exports = { testDir: './tests', outputDir: './test-results', timeout: 20000, workers: 1, reporter: 'line',
  use: { headless: true, viewport: { width: 800, height: 600 } } };
`,
  );
  ide = await service(project, true, {}, { stopCode: true });
  agents = await ide.client.sendRequest<AgentsResult>('piwi/agents', { enabled: true });
}, 30_000);

afterAll(async () => {
  ide?.stop();
  await new Promise((resolve) => (server ? server.close(resolve) : resolve(null)));
  fs.rmSync(project, { recursive: true, force: true });
});

describe.skipIf(!runnable)('an agent and a real run of the editor window', () => {
  it('pauses, reads, clicks by a ref, writes the steps through the editor, shares the browser and resumes', async () => {
    // The command the editor's client runs: its environment names the run channel and the run's ref.
    let run: RunCommand | null = null;
    for (let i = 0; i < 250 && !run?.env?.PIWI_RUN_CHANNEL; i++) {
      // The channel opens once the service is initialized: a command built before names none.
      if (i) await new Promise((r) => setTimeout(r, 20));
      run = (await ide.client.sendRequest('piwi/runArgs', {
        uri: pathToFileURL(path.join(project, 'tests', 'cart.spec.cjs')).href,
        testIds: [],
        locations: ['tests/cart.spec.cjs:3'],
      })) as RunCommand | null;
    }
    if (!run?.env?.PIWI_RUN_CHANNEL) throw new Error('the service built no command for the spec');
    const ref = run.ref!;
    const env: NodeJS.ProcessEnv = { ...process.env, ...run.env };
    for (const name of ['CI', 'PWDEBUG', 'PIWI_DASHBOARD_URL', 'PIWI_API_KEY', 'PIWI_PAUSE_AT', 'PIWI_EDITOR_SEND']) {
      delete env[name];
    }
    let output = '';
    let child: ReturnType<typeof execFile> | null = null;
    const exited = new Promise<number | null>((resolve) => {
      child = execFile(
        process.execPath,
        [requireHere.resolve('@playwright/test/cli'), 'test'],
        { cwd: project, env, timeout: 90_000 },
        () => {},
      );
      child!.stdout?.on('data', (chunk) => (output += chunk));
      child!.stderr?.on('data', (chunk) => (output += chunk));
      child!.on('exit', (code) => resolve(code));
    });
    try {
      // The run is listed once its worker runs the test.
      await waitFor(() => ide.latest(ref)?.workers[0]?.test ?? undefined, 30_000).catch(() => {
        throw new Error(`no worker ran the test:\n${output}`);
      });
      const listed = await call('run_list');
      expect(listed.piwi.runs[0]).toMatchObject({
        run: ref,
        workers: [{ worker: 0, test: { title: 'waits for a click' } }],
      });

      // Paused: answered at the stop, said to be the agent's, with the page's snapshot.
      const paused = await call('run_control', { run: ref, action: 'pause', wait: 20 });
      expect(paused.piwi).toMatchObject({ ok: true, worker: 0, stop: { reason: 'pause', by: 'agent' } });
      expect(paused.piwi.snapshot).toBe('the whole snapshot');
      const go = /button "Go" \[ref=(e\d+)\]/.exec(paused.page)?.[1];
      expect(go, paused.page).toBeTruthy();
      const since = paused.piwi.stop.stop as string;

      const located = await call('page_locator', { run: ref, target: go });
      expect(located.page).toContain(`"locator": "getByRole('button', { name: 'Go' })"`);

      const clicked = await call('page_act', { run: ref, stop: since, target: go, action: 'click' });
      expect(clicked.piwi).toMatchObject({ ok: true, steps: 1, snapshot: 'the change since the last snapshot read' });
      expect(clicked.page).toMatch(/^\+ +- heading "Clicked"/m);

      const written = await call('code_write', { run: ref, stop: since, kind: 'steps' });
      expect(written.piwi.ok, written.piwi.message).toBe(true);
      const code = await waitFor(() => ide.codes.find((c) => c.ref === ref && c.action === 'steps'));
      expect(code.uri).toMatch(/cart\.spec\.cjs$/);
      expect(code.code).toContain("await page.getByRole('button', { name: 'Go' }).click();");

      // Shared with Playwright's own tools: a second client joins the stopped run's browser.
      const shared = await ide.client.sendRequest<StopBindResult>('piwi/stopBind', { ref, since, on: true });
      expect(shared).toMatchObject({
        ok: true,
        name: `piwi-${ref}-w0`,
        command: `npx playwright cli attach piwi-${ref}-w0`,
      });

      const resumed = await call('run_control', { run: ref, action: 'resume', stop: since, wait: 20 });
      expect(resumed.piwi.ok, resumed.piwi.message).toBe(true);
      expect(await exited, output).toBe(0);
      await ide.client.sendNotification('piwi/commandEnded', { ref, exitCode: 0 });
      const ended = await call('run_follow', { run: ref, after: -1, wait: 5 });
      expect(ended.piwi.state).toBe('ended');
      const kinds = ended.piwi.events.map((e: { kind: string }) => e.kind);
      expect(kinds).toEqual(
        expect.arrayContaining(['worker-joined', 'test-begin', 'stopped', 'went-on', 'call', 'test-end', 'run-ended']),
      );
    } finally {
      // A run left stopped by a failing check is stopped with it.
      (child as ReturnType<typeof execFile> | null)?.kill();
      await exited.catch(() => null);
    }
  }, 120_000);
});
