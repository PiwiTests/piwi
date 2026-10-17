import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  parseCoverageUploadArgs,
  runCoverage,
  splitUpload,
  uploadCoverage,
  type UploadPart,
} from '../src/cli/coverage.js';
import { hashPaths, readInventory } from '../src/internal/coverage-upload/git-inventory.js';
import { expandPattern } from '../src/internal/coverage-upload/report-files.js';
import { gitBlobId, gitHashObjects } from '../src/internal/collect/blob-ids.js';
import type * as BlobIdsModule from '../src/internal/collect/blob-ids.js';
import { jsonRes, startServerOnTestPort, textRes, type FakeServer } from './_helpers.js';

vi.mock('../src/internal/collect/blob-ids.js', async (importOriginal) => {
  const actual = await importOriginal<typeof BlobIdsModule>();
  return { ...actual, gitHashObjects: vi.fn(actual.gitHashObjects) };
});

const EMPTY_ENV = {} as NodeJS.ProcessEnv;

let repo: string;
let server: FakeServer | null = null;

function write(relative: string, text: string): void {
  const file = path.join(repo, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

const CART = 'export function add(a, b) {\n  return a + b;\n}\n';

beforeEach(() => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-coverage-cli-')));
  write('apps/web/src/cart.ts', CART);
  write('apps/web/src/cart.test.ts', 'test()\n');
  write('apps/web/src/idle.ts', 'export const x = 1;\n');
  write('README.md', '# shop\n');
  git('init', '--quiet');
  git('add', '.');
  git('-c', 'user.name=Piwi', '-c', 'user.email=piwi@example.com', 'commit', '--quiet', '-m', 'shop');
  // Vitest writes paths relative to its root, here apps/web, under coverage/.
  write(
    'apps/web/coverage/lcov.info',
    [
      'SF:src/cart.ts',
      'FN:1,add',
      'FNDA:1,add',
      'DA:2,1',
      'end_of_record',
      'SF:src/cart.test.ts',
      'DA:1,1',
      'end_of_record',
      'SF:src/gone.ts',
      'DA:1,0',
      'end_of_record',
      '',
    ].join('\n'),
  );
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(gitHashObjects).mockReset();
  await server?.close();
  server = null;
  fs.rmSync(repo, { recursive: true, force: true });
});

/** A dashboard with project 7, `shop`, answering an upload with `upload`. */
async function startDashboard(upload: Parameters<typeof startServerOnTestPort>[0]): Promise<FakeServer> {
  return startServerOnTestPort((req, res) => {
    if (req.url === '/api/projects/menu') jsonRes(res, 200, { items: [{ id: 7, name: 'shop' }] });
    else if (req.url === '/api/projects/7') jsonRes(res, 200, { id: 7, coverageScope: null });
    else if (req.url === '/api/projects/7/coverage-reports') upload(req, res);
    else textRes(res, 404, 'not found');
  });
}

describe('parseCoverageUploadArgs', () => {
  it('reads the patterns, the suite and the connection, flags before the environment', () => {
    const args = parseCoverageUploadArgs(
      ['coverage/*.info', '--suite', 'unit-front', '--kind=e2e', '--server-url', 'https://piwi.example.com/'],
      { PIWI_PROJECT_NAME: 'shop', PIWI_API_KEY: 'k', PIWI_DASHBOARD_URL: 'https://env.example.com' } as never,
    );
    expect(args).toMatchObject({
      patterns: ['coverage/*.info'],
      suite: 'unit-front',
      kind: 'e2e',
      serverUrl: 'https://piwi.example.com',
      project: 'shop',
      apiKey: 'k',
      dryRun: false,
    });
  });

  it('refuses a missing report, suite, URL or project, and an unknown option', () => {
    expect(() => parseCoverageUploadArgs(['--suite', 'unit'], EMPTY_ENV)).toThrow(/No report/);
    expect(() => parseCoverageUploadArgs(['a.xml'], EMPTY_ENV)).toThrow(/--suite/);
    expect(() => parseCoverageUploadArgs(['a.xml', '--suite', 'unit'], EMPTY_ENV)).toThrow(/dashboard URL/);
    expect(() => parseCoverageUploadArgs(['a.xml', '--suite', 'unit', '--server-url', 'http://x'], EMPTY_ENV)).toThrow(
      /project/,
    );
    expect(() => parseCoverageUploadArgs(['a.xml', '--suite', 'unit', '--dry-run', '--nope'], EMPTY_ENV)).toThrow(
      /Unknown option --nope/,
    );
    expect(() =>
      parseCoverageUploadArgs(['a.xml', '--suite', 'unit', '--format', 'xml', '--dry-run'], EMPTY_ENV),
    ).toThrow(/--format/);
  });
});

describe('expandPattern', () => {
  it('expands * and ** itself, and skips node_modules', () => {
    write('apps/web/node_modules/x/coverage/lcov.info', 'SF:x\n');
    write('apps/api/TestResults/1/coverage.cobertura.xml', '<coverage/>');
    expect(expandPattern('**/lcov.info', repo).map((f) => path.relative(repo, f))).toEqual([
      'apps/web/coverage/lcov.info',
    ]);
    expect(
      expandPattern('apps/*/TestResults/*/coverage.cobertura.xml', repo).map((f) => path.relative(repo, f)),
    ).toEqual(['apps/api/TestResults/1/coverage.cobertura.xml']);
    expect(expandPattern('apps/web/coverage/lcov.info', repo)).toHaveLength(1);
    expect(expandPattern('missing.xml', repo)).toEqual([]);
  });
});

describe('readInventory', () => {
  it('names each tracked file by its committed blob, a changed one by its content, and leaves a deleted one out', async () => {
    write('apps/web/src/idle.ts', 'export const x = 2;\n');
    fs.rmSync(path.join(repo, 'README.md'));
    const inventory = await readInventory(repo);
    expect(inventory.get('apps/web/src/cart.ts')).toBe(gitBlobId(Buffer.from(CART)));
    expect(inventory.get('apps/web/src/idle.ts')).toBe(gitBlobId(Buffer.from('export const x = 2;\n')));
    expect(inventory.has('README.md')).toBe(false);
    expect(inventory.has('apps/web/coverage/lcov.info')).toBe(false);
  });

  it('leaves out a changed file git cannot hash, and says so', async () => {
    write('apps/web/src/idle.ts', 'export const x = 2;\n');
    vi.mocked(gitHashObjects).mockResolvedValueOnce(null);
    const warnings: string[] = [];
    const inventory = await readInventory(repo, (message) => warnings.push(message));
    expect(inventory.has('apps/web/src/idle.ts')).toBe(false);
    expect(inventory.get('apps/web/src/cart.ts')).toBe(gitBlobId(Buffer.from(CART)));
    expect(warnings).toEqual(["git hash-object failed on 1 changed file: left out of the commit's inventory"]);
  });
});

describe('hashPaths', () => {
  it('hashes the paths 500 at a time', async () => {
    const paths = Array.from({ length: 1201 }, (_, i) => `gen/f${i}.ts`);
    for (const [i, file] of paths.entries()) write(file, `export const n = ${i};\n`);
    const ids = await hashPaths(repo, paths);
    expect(vi.mocked(gitHashObjects).mock.calls.map(([, batch]) => batch.length)).toEqual([500, 500, 201]);
    expect(ids.size).toBe(1201);
    expect(ids.get('gen/f1200.ts')).toBe(gitBlobId(Buffer.from('export const n = 1200;\n')));
  });

  it('keeps the ids of the batches git hashes when another fails', async () => {
    const paths = Array.from({ length: 501 }, (_, i) => `gen/f${i}.ts`);
    for (const file of paths) write(file, 'x\n');
    vi.mocked(gitHashObjects).mockResolvedValueOnce(null);
    const ids = await hashPaths(repo, paths);
    expect([...ids.keys()]).toEqual(['gen/f500.ts']);
  });
});

describe('splitUpload', () => {
  const head = { v: 1 as const, commit: 'a'.repeat(40), suite: 'unit', kind: 'unit' as const, tool: 'lcov' };
  const file = (i: number): UploadPart['files'][number] => ({ path: `src/f${i}.ts`, executable: [[1, 2]], lines: [] });

  it('splits the files at 5000 a request and carries the inventory in parts of 50000', () => {
    const files = Array.from({ length: 12_000 }, (_, i) => file(i));
    const inventory = Array.from({ length: 160_000 }, (_, i) => [`src/f${i}.ts`, 'b'.repeat(40)] as [string, string]);
    const parts = splitUpload(head, files, inventory);
    expect(parts.map((p) => [p.files.length, p.inventory?.length ?? 0])).toEqual([
      [5000, 50_000],
      [5000, 50_000],
      [2000, 50_000],
      [0, 10_000],
    ]);
  });

  it('sends one request for an empty report', () => {
    expect(splitUpload(head, [], [])).toEqual([{ ...head, files: [] }]);
  });

  it('keeps the bytes of the files and the inventory of each request within 8 MB, multi-byte paths counted', () => {
    const budget = 8 * 1024 * 1024;
    const files = Array.from({ length: 4000 }, (_, i) => ({
      path: `src/${'漢'.repeat(200)}${i}.ts`,
      executable: [[1, 2]] as UploadPart['files'][number]['executable'],
      lines: [],
    }));
    const inventory = Array.from(
      { length: 50_000 },
      (_, i) => [`src/${'字'.repeat(100)}${i}.ts`, 'b'.repeat(40)] as [string, string],
    );
    const parts = splitUpload(head, files, inventory);
    for (const part of parts) {
      expect(Buffer.byteLength(JSON.stringify(part))).toBeLessThan(budget + 1024);
    }
    expect(parts.length).toBeGreaterThan(2);
    expect(parts.flatMap((part) => part.files)).toEqual(files);
    expect(parts.flatMap((part) => part.inventory ?? [])).toEqual(inventory);
  });
});

describe('uploadCoverage', () => {
  it("resolves a Vitest report's paths from its root, keeps the files in scope and sends them with the inventory", async () => {
    server = await startServerOnTestPort((req, res) => {
      if (req.url === '/api/projects/menu') jsonRes(res, 200, { items: [{ id: 7, name: 'shop' }] });
      else if (req.url === '/api/projects/7') jsonRes(res, 200, { id: 7, coverageScope: null });
      else if (req.url === '/api/projects/7/coverage-reports') jsonRes(res, 200, { stored: 1, report: { files: 1 } });
      else textRes(res, 404, 'not found');
    });
    const args = parseCoverageUploadArgs(['apps/web/coverage/lcov.info', '--suite', 'unit-front'], {
      PIWI_DASHBOARD_URL: server.url,
      PIWI_PROJECT_NAME: 'shop',
      PIWI_API_KEY: 'secret',
      PIWI_BRANCH: 'feature/cart',
    } as never);
    const { summary, code } = await uploadCoverage(args, { PIWI_BRANCH: 'feature/cart' } as never, repo);
    expect(code).toBe(0);
    expect(summary).toMatchObject({ files: 1, unmatched: 1, outOfScope: 1, requests: 1, branch: 'feature/cart' });
    const post = server.requests.find((r) => r.method === 'POST')!;
    expect(post.headers['x-api-key']).toBe('secret');
    const body = JSON.parse(post.body) as UploadPart;
    expect(body).toEqual({
      v: 1,
      commit: git('rev-parse', 'HEAD'),
      branch: 'feature/cart',
      suite: 'unit-front',
      kind: 'unit',
      tool: 'lcov',
      incomplete: true,
      // The test file is out of the default scope; the README is in it.
      inventory: [
        ['README.md', gitBlobId(Buffer.from('# shop\n'))],
        ['apps/web/src/cart.ts', gitBlobId(Buffer.from(CART))],
        ['apps/web/src/idle.ts', gitBlobId(Buffer.from('export const x = 1;\n'))],
      ],
      files: [
        {
          path: 'apps/web/src/cart.ts',
          blob: gitBlobId(Buffer.from(CART)),
          executable: [[2, 2]],
          lines: [[2, 2]],
          functions: [[1, 1]],
          allFunctions: [[1, 1]],
        },
      ],
    });
  });

  it('reads --root as the one directory paths start from, and sends nothing on a dry run', async () => {
    const args = parseCoverageUploadArgs(
      ['apps/web/coverage/lcov.info', '--suite', 'unit-front', '--root', 'apps', '--dry-run'],
      EMPTY_ENV,
    );
    const { summary, code } = await uploadCoverage(args, EMPTY_ENV, repo);
    // Under apps/ the report's paths name no file.
    expect(code).toBe(1);
    expect(summary).toMatchObject({ files: 0, unmatched: 3 });
  });

  it("reads a .NET test host's Piwi report, its paths as the compiler recorded them", async () => {
    write(
      'TestResults/unit.json',
      JSON.stringify({
        v: 1,
        files: [
          {
            path: path.join(repo, 'apps/web/src/cart.ts'),
            runtime: 'server',
            functions: [[1, 3]],
            lines: [[2, 2]],
            executable: [[2, 2]],
            allFunctions: [[1, 3]],
            checksums: ['sha256:00'],
          },
          { path: '/_/apps/web/src/idle.ts', runtime: 'server', functions: [], lines: [], executable: [[1, 1]] },
        ],
      }),
    );
    const args = parseCoverageUploadArgs(['TestResults/unit.json', '--suite', 'unit-back', '--dry-run'], EMPTY_ENV);
    const { summary, code } = await uploadCoverage(args, EMPTY_ENV, repo);
    expect(code).toBe(0);
    expect(summary).toMatchObject({ files: 2, unmatched: 0 });
  });

  it('says when the dashboard refuses a part', async () => {
    server = await startServerOnTestPort((req, res) => {
      if (req.url === '/api/projects/menu') jsonRes(res, 200, { items: [{ id: 7, name: 'shop' }] });
      else if (req.url === '/api/projects/7') jsonRes(res, 200, { id: 7 });
      else textRes(res, 403, 'Insufficient permissions');
    });
    const args = parseCoverageUploadArgs(['apps/web/coverage/lcov.info', '--suite', 'unit'], {
      PIWI_DASHBOARD_URL: server.url,
      PIWI_PROJECT_NAME: 'shop',
    } as never);
    await expect(uploadCoverage(args, EMPTY_ENV, repo)).rejects.toThrow(/refused the upload \(403\): Insufficient/);
  });
});

describe('runCoverage', () => {
  let stdout: string[];
  let stderr: string[];
  const last = (lines: string[]) => lines[lines.length - 1];

  beforeEach(() => {
    stdout = [];
    stderr = [];
    vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => void stdout.push(parts.join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...parts: unknown[]) => void stderr.push(parts.join(' ')));
  });

  const upload = (...extra: string[]) => ['upload', 'apps/web/coverage/lcov.info', '--suite', 'unit-front', ...extra];

  it('exits 0 on help, and 2 without a subcommand, on an unknown one or on bad arguments', async () => {
    expect(await runCoverage(['--help'], EMPTY_ENV, repo)).toBe(0);
    expect(await runCoverage([], EMPTY_ENV, repo)).toBe(2);
    expect(await runCoverage(['download'], EMPTY_ENV, repo)).toBe(2);
    expect(last(stderr)).toMatch(/unknown subcommand "download"/);
    expect(await runCoverage(['upload', 'a.info'], EMPTY_ENV, repo)).toBe(2);
    expect(last(stderr)).toMatch(/--suite names the suite/);
  });

  it('exits 0 on a dry run with files, and 1 with no report or no file of the checkout', async () => {
    expect(await runCoverage(upload('--dry-run'), EMPTY_ENV, repo)).toBe(0);
    expect(last(stdout)).toMatch(/^Would upload unit-front for [0-9a-f]{7} .*: 1 file from 1 report/);
    expect(await runCoverage(['upload', 'missing.info', '--suite', 'unit', '--dry-run'], EMPTY_ENV, repo)).toBe(1);
    expect(last(stderr)).toMatch(/no report matched/);
    expect(await runCoverage(upload('--dry-run', '--root', 'apps'), EMPTY_ENV, repo)).toBe(1);
    expect(last(stderr)).toMatch(/none of the 3 files/);
  });

  it('exits 0 once uploaded, and 2 when the dashboard refuses a part', async () => {
    let status = 200;
    server = await startDashboard((_req, res) => {
      if (status === 200) jsonRes(res, 200, { stored: 1, report: { files: 1 } });
      else textRes(res, status, 'Insufficient permissions');
    });
    const env = { PIWI_DASHBOARD_URL: server.url, PIWI_PROJECT_NAME: 'shop' } as never;
    expect(await runCoverage(upload(), env, repo)).toBe(0);
    expect(last(stdout)).toMatch(/^Uploaded unit-front/);
    status = 403;
    expect(await runCoverage(upload(), env, repo)).toBe(2);
    expect(last(stderr)).toMatch(/refused the upload \(403\)/);
  });

  it('exits 2 and names the dashboard when a request fails on the network', async () => {
    server = await startDashboard((req) => req.raw.socket.destroy());
    const env = { PIWI_DASHBOARD_URL: server.url, PIWI_PROJECT_NAME: 'shop' } as never;
    expect(await runCoverage(upload(), env, repo)).toBe(2);
    expect(last(stderr)).toContain(`piwi coverage upload: Could not reach the dashboard at ${server.url}: `);
  });

  it('exits 2 outside a git checkout', async () => {
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-coverage-outside-')));
    try {
      expect(await runCoverage(upload('--dry-run'), EMPTY_ENV, outside)).toBe(2);
      expect(last(stderr)).toMatch(/is not inside a git checkout/);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('warns when git cannot hash an untracked file the reports name, and sends it without a blob', async () => {
    write('apps/web/src/fresh.ts', 'export const fresh = true;\n');
    write('apps/web/coverage/lcov.info', 'SF:src/fresh.ts\nDA:1,1\nend_of_record\n');
    vi.mocked(gitHashObjects).mockResolvedValueOnce(null);
    expect(await runCoverage(upload('--dry-run', '--json'), EMPTY_ENV, repo)).toBe(0);
    expect(stderr).toEqual([
      'piwi coverage upload: warning: git hash-object failed on 1 untracked file the reports name: sent without a blob id',
    ]);
    expect(JSON.parse(stdout.join('\n'))).toMatchObject({ files: 1 });
  });
});
