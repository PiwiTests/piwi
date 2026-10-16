import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
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
import { PiwiContext } from '../src/context';
import {
  BlobTexts,
  chooseVersion,
  coverageIndexFor,
  coverageMarks,
  coverageVersions,
  gitBlobId,
  mayHaveCoverage,
  textBlobIds,
} from '../src/coverage';
import type { CodeIndex, FileCoverage } from '../src/piwi-client';
import { startServer } from '../src/server';
import type { CoverageResult, FileSummary, RunCommand, StatusResult, TestsForFile } from '../src/protocol';

/** A server file of the application, as committed: the version the tests' coverage recorded. */
const BASKET = [
  'using System;',
  '',
  'namespace Web.Services;',
  '',
  'public class BasketService',
  '{',
  '    public int AddItem(int basketId, int quantity)',
  '    {',
  '        if (quantity <= 0)',
  '        {',
  '            throw new ArgumentException("quantity");',
  '        }',
  '        return basketId + quantity;',
  '    }',
  '',
  '    public int RemoveItem(int basketId)',
  '    {',
  '        return basketId - 1;',
  '    }',
  '}',
  '',
].join('\n');

/** The same file edited since: a line above, and the line `AddItem` returns on rewritten. */
const BASKET_EDITED = BASKET.replace('using System;\n', 'using System;\nusing System.Linq;\n').replace(
  'return basketId + quantity;',
  'return basketId + quantity * 2;',
);

const ORDER = 'namespace Web.Services;\n\npublic class OrderService\n{\n    public int Total() => 3;\n}\n';

const BASKET_FILE = 'src/Web/Services/BasketService.cs';
const ORDER_FILE = 'src/Web/Services/OrderService.cs';
const UNREACHED_FILE = 'src/Web/Services/Unreached.cs';
/** A blob no repository holds: a version of the order service recorded elsewhere. */
const FOREIGN_BLOB = 'ab'.repeat(20);

const TESTS = [
  { id: 11, title: 'adds an item', file: 'tests/basket.spec.ts', suite: [], status: 'passed' as const },
  { id: 12, title: 'removes an item', file: 'tests/basket.spec.ts', suite: [], status: 'failed' as const },
];

const INDEX: LocatorIndex = {
  projectId: 7,
  projectName: 'Shop',
  branch: null,
  defaultBranch: 'main',
  branches: [],
  builtAt: null,
  generatedAt: '2026-10-14T00:00:00Z',
  testIdAttributes: null,
  pages: [],
  tests: TESTS,
  locators: [],
  truncated: false,
};

const CODE_INDEX: CodeIndex = {
  files: [BASKET_FILE, ORDER_FILE, 'src/Web/Program.cs'],
  tests: TESTS,
  reach: [
    { file: 0, tests: [0, 1], origin: 'server', runtime: 'server', via: 'coverage' },
    { file: 1, tests: [0], origin: 'server', runtime: 'server', via: 'coverage' },
    { file: 2, tests: [0], origin: 'server', runtime: 'server', via: 'route' },
  ],
  builtAt: null,
  truncated: false,
};

let basketBlob = '';

/** The basket service's coverage: two tests ran `AddItem` but its throw, the second `RemoveItem` too. */
function basketCoverage(executable = true): FileCoverage {
  return {
    file: BASKET_FILE,
    branch: 'main',
    fragments: [
      {
        path: BASKET_FILE,
        runtime: 'server',
        blob: basketBlob,
        functions: [[7, 14]],
        lines: [
          [8, 9],
          [13, 14],
        ],
        tests: [0, 1],
      },
      {
        path: BASKET_FILE,
        runtime: 'server',
        blob: basketBlob,
        functions: [
          [7, 14],
          [16, 19],
        ],
        lines: [
          [8, 9],
          [13, 14],
          [17, 19],
        ],
        tests: [1],
      },
    ],
    tests: TESTS,
    ...(executable
      ? {
          executable: [
            {
              path: BASKET_FILE,
              runtime: 'server' as const,
              blob: basketBlob,
              lines: [
                [8, 9],
                [11, 11],
                [13, 14],
                [17, 19],
              ] as Array<[number, number]>,
            },
          ],
        }
      : {}),
  };
}

const ORDER_COVERAGE: FileCoverage = {
  file: ORDER_FILE,
  branch: 'main',
  fragments: [
    { path: ORDER_FILE, runtime: 'server', blob: FOREIGN_BLOB, functions: [[5, 5]], lines: [[5, 5]], tests: [0] },
  ],
  tests: [TESTS[0]!],
};

/** The API key of a service whose instance has no coverage route. */
const NO_ROUTE_KEY = 'pd_no_route';

/** What the stub answers for the basket service, and the `ETag` it comes with. */
let basket: { body: FileCoverage; etag: string } = { body: basketCoverage(), etag: '"basket-1"' };
/** The latest run the stub answers. */
let runId = 50;
/** The coverage requests the stub received, by file and API key, and those answered 304. */
const coverageAsks: Array<{ file: string; key: string; etag: string | null; status: number }> = [];

let dir = '';
let server: http.Server;
let url = '';
let client: MessageConnection;
let stop: () => void;
const pushed: CoverageResult[] = [];

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

/** A service on the fixture repository, connected once its indexes are read. */
async function startService(apiKey?: string): Promise<{ client: MessageConnection; stop: () => void }> {
  const toServer = new PassThrough();
  const toClient = new PassThrough();
  const stopService = startServer(createConnection(toServer, toClient), {
    env: {
      PIWI_DASHBOARD_URL: url,
      PIWI_PROJECT_NAME: 'Shop',
      PIWI_DESKTOP_CONFIG: '/nonexistent',
      ...(apiKey ? { PIWI_API_KEY: apiKey } : {}),
    },
    debounceMs: 10,
    runPollMs: 60 * 60_000,
  });
  const connection = createMessageConnection(new StreamMessageReader(toClient), new StreamMessageWriter(toServer));
  connection.listen();
  await connection.sendRequest('initialize', {
    processId: null,
    rootUri: null,
    capabilities: {},
    workspaceFolders: [{ uri: pathToFileURL(dir).href, name: 'shop' }],
  });
  await connection.sendNotification('initialized', {});
  await waitFor(async () => {
    const status = (await connection.sendRequest('piwi/status')) as StatusResult;
    return status.contexts[0]?.connected ? true : undefined;
  });
  return { client: connection, stop: stopService };
}

function open(connection: MessageConnection, file: string, text: string, version = 1) {
  return connection.sendNotification('textDocument/didOpen', {
    textDocument: { uri: uri(file), languageId: 'csharp', version, text },
  });
}

function change(connection: MessageConnection, file: string, text: string, version: number) {
  return connection.sendNotification('textDocument/didChange', {
    textDocument: { uri: uri(file), version },
    contentChanges: [{ text }],
  });
}

const coverageOf = (connection: MessageConnection, file: string) =>
  connection.sendRequest('piwi/coverage', { uri: uri(file) }) as Promise<CoverageResult>;

async function hover(file: string, line: number): Promise<string> {
  const answer = (await client.sendRequest('textDocument/hover', {
    textDocument: { uri: uri(file) },
    position: { line, character: 8 },
  })) as { contents: { value: string } } | null;
  return answer?.contents.value ?? '';
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const u = req.url ?? '';
    const key = String(req.headers['x-api-key'] ?? '');
    if (u === '/api/projects/menu') return res.end(JSON.stringify({ items: [{ id: 7, name: 'Shop' }] }));
    if (u.startsWith('/api/projects/7/locator-index')) return res.end(JSON.stringify(INDEX));
    if (u.startsWith('/api/projects/7/code-index')) return res.end(JSON.stringify(CODE_INDEX));
    if (u.startsWith('/api/projects/7/branch-failures?')) {
      const run = {
        id: runId,
        status: 'passed',
        branch: 'main',
        startTime: '2026-10-14T10:00:00.000Z',
        origin: 'ci',
        commit: null,
        totalTests: 2,
        passedTests: 2,
        failedTests: 0,
        flakyTests: 0,
        skippedTests: 0,
      };
      return res.end(JSON.stringify({ run, overlays: [], failures: [], resolved: [] }));
    }
    if (u.startsWith('/api/projects/7/coverage?')) {
      const query = new URL(u, url).searchParams;
      const file = query.get('file') ?? '';
      const etag = (req.headers['if-none-match'] as string | undefined) ?? null;
      const answer =
        key === NO_ROUTE_KEY
          ? null
          : file === BASKET_FILE
            ? basket
            : file === ORDER_FILE
              ? { body: ORDER_COVERAGE, etag: '"order-1"' }
              : { body: { file, branch: 'main', fragments: [], tests: [] }, etag: '"none"' };
      const status = !answer ? 404 : etag === answer.etag ? 304 : 200;
      coverageAsks.push({ file, key, etag, status });
      res.statusCode = status;
      if (!answer || status === 304) return res.end(status === 304 ? undefined : '{}');
      expect(query.get('branch')).toBe('main');
      res.setHeader('ETag', answer.etag);
      return res.end(JSON.stringify(answer.body));
    }
    if (u === '/api/projects/7/selections/preview') {
      return res.end(
        JSON.stringify({
          materialization: { args: ['tests/basket.spec.ts'], command: 'npx playwright test tests/basket.spec.ts' },
        }),
      );
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-coverage-')));
  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  };
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], {
      cwd: dir,
      encoding: 'utf-8',
    });
  git('init', '-q', '-b', 'main');
  write('playwright.config.ts', 'export default {};\n');
  write('tests/basket.spec.ts', "import { test } from '@playwright/test';\n\ntest('adds an item', async () => {});\n");
  write(BASKET_FILE, BASKET);
  write(ORDER_FILE, ORDER);
  write(UNREACHED_FILE, 'namespace Web.Services;\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  basketBlob = git('hash-object', BASKET_FILE).trim();
  basket = { body: basketCoverage(), etag: '"basket-1"' };

  ({ client, stop } = await startService());
  client.onNotification('piwi/coverageChanged', (result: CoverageResult) => {
    pushed.push(result);
  });
});

afterAll(async () => {
  stop?.();
  client?.dispose();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('the blob id of a file', () => {
  test('is the one git gives it, with its line endings and byte order mark as git stores them', () => {
    expect(gitBlobId(BASKET)).toBe(basketBlob);
    // A checkout with CRLF line endings, a document without the byte order mark the file starts with.
    expect(textBlobIds(BASKET.replace(/\n/g, '\r\n'))).toContain(basketBlob);
    expect(textBlobIds(BASKET)).toContain(gitBlobId(`\uFEFF${BASKET}`));
  });
});

describe('the version the marks come from', () => {
  const versions = (blobs: Array<[string, number]>) =>
    coverageVersions({
      file: BASKET_FILE,
      branch: 'main',
      fragments: blobs.map(([blob, tests]) => ({
        path: BASKET_FILE,
        runtime: 'server',
        blob,
        lines: [[1, 1]],
        tests: Array.from({ length: tests }, (_, i) => i),
      })),
      tests: [],
    });
  const none = () => {};

  test('is the file as it stands, else the version the most tests recorded that the repository holds', async () => {
    const recorded = versions([
      ['c'.repeat(40), 5],
      [basketBlob, 1],
      ['d'.repeat(40), 3],
    ]);
    expect(recorded.map((v) => v.blob)).toEqual(['c'.repeat(40), 'd'.repeat(40), basketBlob]);
    const exact = await chooseVersion(
      recorded,
      BASKET,
      () => BASKET,
      () => Promise.resolve(null),
      none,
    );
    expect(exact).toMatchObject({ state: 'exact', version: { blob: basketBlob } });
    const held = new Map([
      ['d'.repeat(40), 'older'],
      ['c'.repeat(40), 'newer'],
    ]);
    const mapped = await chooseVersion(
      recorded,
      'edited',
      () => null,
      (b) => Promise.resolve(held.get(b) ?? null),
      none,
    );
    expect(mapped).toMatchObject({ state: 'mapped', version: { blob: 'c'.repeat(40) }, base: 'newer' });
    const lost = await chooseVersion(
      recorded,
      'edited',
      () => null,
      () => Promise.resolve(null),
      none,
    );
    expect(lost).toMatchObject({ state: 'other-version', version: null });
    expect(
      await chooseVersion(
        [],
        BASKET,
        () => null,
        () => Promise.resolve(null),
        none,
      ),
    ).toMatchObject({
      state: 'none',
    });
  });

  test('of a document edited since it was saved is the version it was saved as', async () => {
    const recorded = versions([
      ['c'.repeat(40), 5],
      [basketBlob, 1],
    ]);
    const texts = new BlobTexts(() => Promise.resolve('the newer version'));
    const chosen = await chooseVersion(
      recorded,
      BASKET_EDITED,
      () => BASKET,
      (b) => texts.textOf(dir, b),
      (t, b) => texts.remember(t, b),
    );
    expect(chosen).toMatchObject({ state: 'mapped', version: { blob: basketBlob }, base: BASKET });
    // Its text is kept: once the file is saved with other edits, its lines still come from that version.
    expect(await texts.textOf(dir, basketBlob)).toBe(BASKET);
  });

  test('is asked of the instance only for a file the code index says coverage reaches, or cannot tell', () => {
    expect(mayHaveCoverage(CODE_INDEX, BASKET_FILE)).toBe(true);
    expect(mayHaveCoverage(CODE_INDEX, UNREACHED_FILE)).toBe(false);
    // Reached through the routes its tests call only: no coverage recorded it.
    expect(mayHaveCoverage(CODE_INDEX, 'src/Web/Program.cs')).toBe(false);
    expect(mayHaveCoverage(null, UNREACHED_FILE)).toBe(true);
    expect(mayHaveCoverage({ ...CODE_INDEX, truncated: true }, UNREACHED_FILE)).toBe(true);
    // An older instance says nothing of how a file is reached.
    const older = {
      ...CODE_INDEX,
      reach: CODE_INDEX.reach.map(({ file, tests, origin }) => ({ file, tests, origin })),
    };
    expect(mayHaveCoverage(older, 'src/Web/Program.cs')).toBe(true);
  });

  test('is gated by a code index of the branch the coverage is read for only', () => {
    expect(coverageIndexFor(CODE_INDEX, null, null, 'main')).toBe(CODE_INDEX);
    expect(coverageIndexFor(CODE_INDEX, null, 'main', 'main')).toBe(CODE_INDEX);
    expect(coverageIndexFor(CODE_INDEX, 'feature/x', 'feature/x', 'main')).toBe(CODE_INDEX);
    // The default branch's index may lack a file only the checked-out branch's coverage reaches: the instance is asked.
    expect(mayHaveCoverage(coverageIndexFor(CODE_INDEX, null, 'feature/x', 'main'), UNREACHED_FILE)).toBe(true);
  });
});

describe('the marks of a version', () => {
  test('recorded by function count the lines of the functions that ran', () => {
    const text = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n');
    const blob = gitBlobId(text);
    const coverage = {
      file: BASKET_FILE,
      branch: 'main',
      fragments: [
        {
          path: BASKET_FILE,
          runtime: 'server' as const,
          blob,
          functions: [[5, 8]] as Array<[number, number]>,
          tests: [0],
        },
      ],
      tests: [],
      executable: [
        { path: BASKET_FILE, runtime: 'server' as const, blob, lines: [[5, 12]] as Array<[number, number]> },
      ],
    };
    const versions = coverageVersions(coverage);
    const marks = coverageMarks(coverage, versions, { state: 'exact', version: versions[0]!, base: null }, text);
    expect([...marks.executed.keys()]).toEqual([5, 6, 7, 8]);
    expect([...marks.notRun].sort((a, b) => a - b)).toEqual([9, 10, 11, 12]);
    expect(marks.executableLines).toBe(8);
  });
});

describe('coverage in the editor', () => {
  test('marks the lines tests ran, how many ran each, and the executable lines none runs', async () => {
    await open(client, BASKET_FILE, BASKET);
    const result = await coverageOf(client, BASKET_FILE);
    expect(result).toEqual({
      uri: uri(BASKET_FILE),
      state: 'exact',
      executed: [
        { start: 7, end: 8, tests: 2 },
        { start: 12, end: 13, tests: 2 },
        { start: 16, end: 18, tests: 1 },
      ],
      notRun: [{ start: 10, end: 10 }],
      changed: [],
      tests: 2,
      executedLines: 7,
      executableLines: 8,
      blob: basketBlob,
      label: '7 of 8 lines run by 2 tests',
    });
  });

  test('puts a lens on each function that ran, which runs its tests recording the backend’s coverage', async () => {
    const summary = (await client.sendRequest('piwi/fileSummary', { uri: uri(BASKET_FILE) })) as FileSummary;
    expect(summary.file).toMatchObject({
      line: 0,
      title: 'Reached by 2 tests · 1 failing · 7 of 8 lines run',
      command: { command: 'piwi.runTests', arguments: [{ testIds: [11, 12], coverage: 'server' }] },
    });
    expect(summary.lines).toEqual([
      {
        line: 6,
        title: 'Reached by 2 tests · 1 failing',
        command: {
          title: 'Run them',
          command: 'piwi.runTests',
          arguments: [{ uri: uri(BASKET_FILE), testIds: [11, 12], coverage: 'server' }],
        },
      },
      expect.objectContaining({ line: 15, title: 'Reached by 1 test · 1 failing' }),
    ]);

    const recording = (await client.sendRequest('piwi/runArgs', {
      uri: uri(BASKET_FILE),
      testIds: [11, 12],
      coverage: 'server',
    })) as RunCommand;
    expect(recording.env).toMatchObject({ PIWI_ORIGIN: 'editor', PIWI_COVERAGE_SERVER: 'lines' });
    const plain = (await client.sendRequest('piwi/runArgs', { uri: uri(BASKET_FILE), testIds: [11] })) as RunCommand;
    expect(plain.env).not.toHaveProperty('PIWI_COVERAGE_SERVER');
    const browser = (await client.sendRequest('piwi/runArgs', {
      uri: uri(BASKET_FILE),
      testIds: [11],
      coverage: 'browser',
    })) as RunCommand;
    expect(browser.env).toMatchObject({ PIWI_COVERAGE_BROWSER: 'functions' });
    expect(browser.env).not.toHaveProperty('PIWI_COVERAGE_SERVER');

    const reached = (await client.sendRequest('piwi/testsForFile', { uri: uri(BASKET_FILE) })) as TestsForFile;
    expect(reached).toMatchObject({ basis: 'reach', tests: [{ id: 11 }, { id: 12 }] });
  });

  test('the hover lists the tests behind a line, or says no test runs it', async () => {
    const ran = await hover(BASKET_FILE, 7);
    expect(ran).toContain('**Piwi coverage** · run by 2 tests');
    expect(ran).toContain(`- ✓ [adds an item](${url}/test-cases/11) · \`tests/basket.spec.ts\``);
    expect(ran).toContain(`- ✗ [removes an item](${url}/test-cases/12)`);
    expect(await hover(BASKET_FILE, 10)).toBe('**Piwi coverage** · no test runs this line');
    expect(await hover(BASKET_FILE, 0)).toBe('');
  });

  test('an edit places the marks through the diff, and marks the lines changed since the coverage run', async () => {
    pushed.length = 0;
    await change(client, BASKET_FILE, BASKET_EDITED, 2);
    const moved = await waitFor(() => pushed.find((p) => p.uri === uri(BASKET_FILE)));
    expect(moved).toMatchObject({
      state: 'mapped',
      blob: basketBlob,
      executed: [
        { start: 8, end: 9, tests: 2 },
        { start: 14, end: 14, tests: 2 },
        { start: 17, end: 19, tests: 1 },
      ],
      notRun: [{ start: 11, end: 11 }],
      changed: [
        { start: 1, end: 1 },
        { start: 13, end: 13 },
      ],
      executedLines: 6,
      executableLines: 7,
      label: '6 of 7 lines run by 2 tests · 2 lines changed since the coverage run',
    });
    expect(await hover(BASKET_FILE, 13)).toContain('changed since the coverage run');
    const summary = (await client.sendRequest('piwi/fileSummary', { uri: uri(BASKET_FILE) })) as FileSummary;
    expect(summary.file?.title).toBe(
      'Reached by 2 tests · 1 failing · 6 of 7 lines run · 2 lines changed since the coverage run',
    );
    expect(summary.lines.map((l) => l.line)).toEqual([7, 16]);
    // The client holds the pushed answer: asking again finds the same.
    expect(await coverageOf(client, BASKET_FILE)).toEqual(moved);
  });

  test('coverage of a version the repository lacks marks no line, and says so on the file', async () => {
    await open(client, ORDER_FILE, ORDER);
    expect(await coverageOf(client, ORDER_FILE)).toMatchObject({
      state: 'other-version',
      executed: [],
      notRun: [],
      changed: [],
      tests: 1,
      blob: null,
      label: '1 test ran another version of this file',
    });
    const summary = (await client.sendRequest('piwi/fileSummary', { uri: uri(ORDER_FILE) })) as FileSummary;
    expect(summary).toEqual({
      file: expect.objectContaining({ title: 'Reached by 1 test · coverage recorded on another version' }),
      lines: [],
    });
    expect(await hover(ORDER_FILE, 4)).toBe('');
  });

  test('a file no coverage reaches shows nothing, and the instance is not asked', async () => {
    await open(client, UNREACHED_FILE, 'namespace Web.Services;\n');
    expect(await coverageOf(client, UNREACHED_FILE)).toMatchObject({ state: 'none', label: null, executed: [] });
    expect(await client.sendRequest('piwi/fileSummary', { uri: uri(UNREACHED_FILE) })).toEqual({
      file: null,
      lines: [],
    });
    expect(coverageAsks.filter((a) => a.file === UNREACHED_FILE)).toEqual([]);
    // A test file has no coverage marks.
    expect(await coverageOf(client, 'tests/basket.spec.ts')).toMatchObject({ state: 'none' });
  });

  test('is asked again with its ETag on a refresh: an unchanged answer pushes nothing, a new one its marks', async () => {
    pushed.length = 0;
    const asked = coverageAsks.length;
    await client.sendRequest('piwi/refresh');
    await waitFor(() => (coverageAsks.slice(asked).some((a) => a.file === BASKET_FILE) ? true : undefined));
    expect(coverageAsks.slice(asked).filter((a) => a.file === BASKET_FILE)).toEqual([
      { file: BASKET_FILE, key: '', etag: '"basket-1"', status: 304 },
    ]);
    await new Promise((r) => setTimeout(r, 100));
    expect(pushed).toEqual([]);

    // A run ends that recorded no executable lines: the marks lose the lines no test runs.
    basket = { body: basketCoverage(false), etag: '"basket-2"' };
    runId = 51;
    await client.sendRequest('piwi/refreshRun');
    const next = await waitFor(() => pushed.find((p) => p.uri === uri(BASKET_FILE)));
    expect(next).toMatchObject({ state: 'mapped', notRun: [], executableLines: null, executedLines: 6 });
    expect(next.label).toBe('6 lines run by 2 tests · 2 lines changed since the coverage run');
  });

  test('a 304 keeps the coverage read before, the same object', async () => {
    basket = { body: basketCoverage(), etag: '"basket-3"' };
    const context = new PiwiContext(dir);
    await context.refresh(
      { PIWI_DASHBOARD_URL: url, PIWI_PROJECT_NAME: 'Shop', PIWI_DESKTOP_CONFIG: '/nonexistent' },
      {},
    );
    const first = await context.coverage(BASKET_FILE);
    expect(first?.fragments).toHaveLength(2);
    context.staleCoverage();
    const asked = coverageAsks.length;
    const second = await context.coverage(BASKET_FILE);
    expect(coverageAsks.slice(asked)).toEqual([{ file: BASKET_FILE, key: '', etag: '"basket-3"', status: 304 }]);
    expect(second).toBe(first);
    // Not stale: answered from what is kept.
    expect(await context.coverage(BASKET_FILE)).toBe(first);
    expect(coverageAsks).toHaveLength(asked + 1);
  });
});

describe('an instance without coverage', () => {
  test('shows no coverage, is asked once, and costs no request per keystroke', async () => {
    const other = await startService(NO_ROUTE_KEY);
    const pushes: CoverageResult[] = [];
    other.client.onNotification('piwi/coverageChanged', (result: CoverageResult) => {
      pushes.push(result);
    });
    try {
      await open(other.client, BASKET_FILE, BASKET);
      expect(await coverageOf(other.client, BASKET_FILE)).toMatchObject({ state: 'none', label: null });
      for (let version = 2; version < 6; version++) {
        await change(other.client, BASKET_FILE, `${BASKET}// ${version}\n`, version);
        await new Promise((r) => setTimeout(r, 30));
      }
      expect(await coverageOf(other.client, BASKET_FILE)).toMatchObject({ state: 'none' });
      expect(coverageAsks.filter((a) => a.key === NO_ROUTE_KEY)).toEqual([
        { file: BASKET_FILE, key: NO_ROUTE_KEY, etag: null, status: 404 },
      ]);
      // The file's lens comes from the code index alone.
      const summary = (await other.client.sendRequest('piwi/fileSummary', { uri: uri(BASKET_FILE) })) as FileSummary;
      expect(summary).toEqual({
        file: {
          line: 0,
          title: 'Reached by 2 tests · 1 failing',
          command: {
            title: 'Run them',
            command: 'piwi.runTests',
            arguments: [{ uri: uri(BASKET_FILE), testIds: [11, 12] }],
          },
        },
        lines: [],
      });
      expect(pushes).toEqual([]);
    } finally {
      other.stop();
      other.client.dispose();
    }
  });
});
