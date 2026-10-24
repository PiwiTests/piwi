import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import type * as ChildProcess from 'node:child_process';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseSelectArgs, parseDuration, runRun, runSelect } from '../src/cli/select.js';
import { readSelectionStamp } from '../src/internal/support/selection-env.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return { ...actual, spawn: vi.fn() };
});

describe('parseDuration', () => {
  it('parses units and plain millisecond counts', () => {
    expect(parseDuration('5m')).toBe(300_000);
    expect(parseDuration('90s')).toBe(90_000);
    expect(parseDuration('1h')).toBe(3_600_000);
    expect(parseDuration('250ms')).toBe(250);
    expect(parseDuration('300000')).toBe(300_000);
  });

  it('rejects nonsense', () => {
    expect(parseDuration('soon')).toBeNull();
    expect(parseDuration('0')).toBeNull();
    expect(parseDuration('-5m')).toBeNull();
  });
});

describe('parseSelectArgs', () => {
  const env = { PIWI_DASHBOARD_URL: 'https://dash.example', PIWI_API_KEY: 'k', PIWI_PROJECT_NAME: 'web' };

  it('reads the key, flags and env fallbacks', () => {
    const args = parseSelectArgs(['smoke', '--format', 'grep', '--budget', '5m', '--strict'], env);
    expect(args.key).toBe('smoke');
    expect(args.serverUrl).toBe('https://dash.example');
    expect(args.apiKey).toBe('k');
    expect(args.project).toBe('web');
    expect(args.format).toBe('grep');
    expect(args.budgetMs).toBe(300_000);
    expect(args.strict).toBe(true);
  });

  it('splits playwright passthrough args after --', () => {
    const args = parseSelectArgs(['smoke', '--', '--workers=1', '--headed'], env);
    expect(args.key).toBe('smoke');
    expect(args.extra).toEqual(['--workers=1', '--headed']);
  });

  it('requires a server URL and a key', () => {
    expect(() => parseSelectArgs(['smoke'], {})).toThrow(/dashboard URL/);
    expect(() => parseSelectArgs(['--format', 'grep'], env)).toThrow(/selection key/);
  });

  it('rejects an unparseable budget', () => {
    expect(() => parseSelectArgs(['smoke', '--budget', 'soon'], env)).toThrow(/--budget/);
  });

  it('accepts a well-formed shard and rejects a malformed one', () => {
    expect(parseSelectArgs(['smoke', '--shard', '2/4'], env).shard).toBe('2/4');
    expect(parseSelectArgs(['smoke'], env).shard).toBeNull();
    expect(() => parseSelectArgs(['smoke', '--shard', '2of4'], env)).toThrow(/--shard/);
  });

  it('reads the impact base ref and keeps the key as impact', () => {
    const args = parseSelectArgs(['impact', '--base', 'origin/main'], env);
    expect(args.key).toBe('impact');
    expect(args.base).toBe('origin/main');
    expect(parseSelectArgs(['smoke'], env).base).toBeNull();
  });

  it('maps --fail-fast to a failure-first order', () => {
    expect(parseSelectArgs(['smoke', '--fail-fast'], env).order).toBe('failureLikelihood');
    expect(parseSelectArgs(['smoke'], env).order).toBeNull();
  });
});

describe('readSelectionStamp', () => {
  it('returns a stamp only when every field is present and well-formed', () => {
    expect(
      readSelectionStamp({
        PIWI_SELECTION: 'smoke',
        PIWI_SELECTION_VERSION: '7',
        PIWI_SELECTION_HASH: 'abc123',
        PIWI_SELECTION_COUNT: '42',
      }),
    ).toEqual({ key: 'smoke', version: 7, resolvedHash: 'abc123', resolvedCount: 42 });
  });

  it('returns null without a key or with a malformed field', () => {
    expect(readSelectionStamp({})).toBeNull();
    expect(readSelectionStamp({ PIWI_SELECTION: 'smoke', PIWI_SELECTION_VERSION: 'x' })).toBeNull();
    expect(
      readSelectionStamp({ PIWI_SELECTION: 'smoke', PIWI_SELECTION_VERSION: '1', PIWI_SELECTION_COUNT: '2' }),
    ).toBeNull(); // no hash
  });
});

describe('runRun', () => {
  const env = { PIWI_DASHBOARD_URL: 'https://dash.example', PIWI_API_KEY: 'k' };
  const RESOLUTION = {
    key: 'smoke',
    version: 3,
    tests: [],
    resolvedHash: 'hash-1',
    estimate: { count: 2, totalDurationMs: null },
    warnings: [],
    materialization: { format: 'args', args: ['a.spec.ts:3', 'b.spec.ts:9'], command: '' },
  };
  let dir: string;
  let cwd: string;
  let stderr: ReturnType<typeof vi.spyOn>;

  /** A dashboard that lists project "Web" as id 7 and resolves `smoke`, or one that cannot be reached. */
  function dashboard(up: boolean): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (!up) throw new TypeError('fetch failed');
        if (url.endsWith('/api/projects/menu')) {
          return new Response(JSON.stringify({ items: [{ id: 7, name: 'Web' }] }), { status: 200 });
        }
        if (url.includes('/api/projects/7/selections/smoke/resolve')) {
          return new Response(JSON.stringify(RESOLUTION), { status: 200 });
        }
        return new Response('{}', { status: 404 });
      }),
    );
  }

  /** The Playwright arguments and environment of the last spawn. */
  function lastSpawn(): { args: string[]; env: NodeJS.ProcessEnv } {
    const calls = vi.mocked(spawn).mock.calls;
    const call = calls[calls.length - 1] as unknown as [string, string[], { env: NodeJS.ProcessEnv }];
    return { args: call[1].slice(call[1].indexOf('test') + 1), env: call[2].env };
  }

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-select-')));
    cwd = process.cwd();
    process.chdir(dir);
    vi.mocked(spawn).mockImplementation((() => {
      const child = new EventEmitter();
      setImmediate(() => child.emit('exit', 0));
      return child;
    }) as unknown as typeof spawn);
    stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.chdir(cwd);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.mocked(spawn).mockReset();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('uses the cached selection when the dashboard is unreachable and the project is a name', async () => {
    dashboard(true);
    expect(await runRun(['smoke', '--project', 'web'], env)).toBe(0);
    expect(lastSpawn().args).toEqual(['a.spec.ts:3', 'b.spec.ts:9']);

    dashboard(false);
    expect(await runRun(['smoke', '--project', 'WEB', '--', '--workers=1'], env)).toBe(0);
    const { args, env: childEnv } = lastSpawn();
    expect(args).toEqual(['a.spec.ts:3', 'b.spec.ts:9', '--workers=1']);
    expect(childEnv.PIWI_SELECTION).toBe('smoke');
    expect(childEnv.PIWI_SELECTION_HASH).toBe('hash-1');
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('using cached resolution'));
  });

  it('takes the project from PIWI_PROJECT_NAME', async () => {
    const named = { ...env, PIWI_PROJECT_NAME: 'Web' };
    dashboard(true);
    await runRun(['smoke'], named);
    dashboard(false);
    await runRun(['smoke'], named);
    expect(lastSpawn().args).toEqual(['a.spec.ts:3', 'b.spec.ts:9']);
  });

  it('runs the full suite when the dashboard is unreachable and nothing is cached', async () => {
    dashboard(false);
    expect(await runRun(['smoke', '--project', 'web', '--', '--workers=1'], env)).toBe(0);
    expect(lastSpawn().args).toEqual(['--workers=1']);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('no cached resolution, running the full suite'));
  });

  it('keeps an id and a name for the same project apart', async () => {
    dashboard(true);
    await runRun(['smoke', '--project', 'web'], env);

    dashboard(false);
    await runRun(['smoke', '--project', '7'], env);
    expect(lastSpawn().args).toEqual([]);

    dashboard(true);
    await runRun(['smoke', '--project', '7'], env);
    dashboard(false);
    await runRun(['smoke', '--project', '7'], env);
    expect(lastSpawn().args).toEqual(['a.spec.ts:3', 'b.spec.ts:9']);
  });

  it('keeps a shard, a format and a budget apart', async () => {
    dashboard(true);
    await runRun(['smoke', '--project', 'web', '--shard', '1/2'], env);

    dashboard(false);
    await runRun(['smoke', '--project', 'web', '--shard', '2/2'], env);
    expect(lastSpawn().args).toEqual([]);
    await runRun(['smoke', '--project', 'web', '--shard', '1/2'], env);
    expect(lastSpawn().args).toEqual(['a.spec.ts:3', 'b.spec.ts:9']);
  });

  it('stops with exit 2 under --strict, cache or not', async () => {
    dashboard(true);
    await runRun(['smoke', '--project', 'web'], env);
    vi.mocked(spawn).mockClear();

    dashboard(false);
    expect(await runRun(['smoke', '--project', 'web', '--strict'], env)).toBe(2);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('runs the full suite for a project the dashboard does not know, when nothing is cached', async () => {
    dashboard(true);
    expect(await runRun(['smoke', '--project', 'other', '--', '--workers=1'], env)).toBe(0);
    expect(lastSpawn().args).toEqual(['--workers=1']);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('No project named "other"'));
  });

  it('tells the reporter which shard the run is, and gives Playwright no --shard of its own', async () => {
    dashboard(true);
    expect(await runRun(['smoke', '--project', 'web', '--shard', '2/4'], env)).toBe(0);
    const { args, env: childEnv } = lastSpawn();
    expect(childEnv.PIWI_SHARD).toBe('2/4');
    expect(args.some((arg) => arg.startsWith('--shard'))).toBe(false);
  });

  it('tells the reporter the shard of a cached selection too', async () => {
    dashboard(true);
    await runRun(['smoke', '--project', 'web', '--shard', '2/4'], env);
    dashboard(false);
    await runRun(['smoke', '--project', 'web', '--shard', '2/4'], env);
    expect(lastSpawn().env.PIWI_SHARD).toBe('2/4');
  });

  it('sets no shard for a run that is not sharded', async () => {
    dashboard(true);
    await runRun(['smoke', '--project', 'web'], env);
    expect(lastSpawn().env.PIWI_SHARD).toBeUndefined();
  });

  it('impact sends every changed file, and the changed base lines of modified files', async () => {
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { stdio: 'pipe' })
        .toString()
        .trim();
    git('init', '-q', '-b', 'main');
    fs.writeFileSync(
      'cart.ts',
      'export function total(items) {\n  let sum = 0;\n  for (const i of items) sum += i;\n  return sum;\n}\n',
    );
    fs.writeFileSync('old-name.ts', 'export const a = 1;\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    const base = git('rev-parse', 'HEAD:cart.ts');
    fs.writeFileSync(
      'cart.ts',
      'export function total(items) {\n  let sum = 0;\n  for (const i of items) sum += i * 2;\n  return sum;\n}\n',
    );
    git('mv', 'old-name.ts', 'new-name.ts');

    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/api/projects/menu')) {
          return new Response(JSON.stringify({ items: [{ id: 7, name: 'Web' }] }), { status: 200 });
        }
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(
          JSON.stringify({
            ...RESOLUTION,
            key: 'impact',
            impact: { changedFiles: 3, mappedFiles: 1, widened: false, unmappedSourceFiles: [], lineLevelFiles: 1 },
          }),
          { status: 200 },
        );
      }),
    );
    // A git config that renames the diff's path prefixes changes no path.
    vi.stubEnv('GIT_CONFIG_COUNT', '1');
    vi.stubEnv('GIT_CONFIG_KEY_0', 'diff.mnemonicPrefix');
    vi.stubEnv('GIT_CONFIG_VALUE_0', 'true');
    try {
      expect(await runRun(['impact', '--base', 'HEAD', '--project', 'web'], env)).toBe(0);
    } finally {
      vi.unstubAllEnvs();
    }
    expect((bodies[0]!.changedFiles as string[]).sort()).toEqual(['cart.ts', 'new-name.ts', 'old-name.ts']);
    expect(bodies[0]!.changes).toEqual([{ filePath: 'cart.ts', blob: base, lines: [[3, 3]] }]);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('1 file(s) narrowed by line coverage'));
  });

  it.each([
    ['no test is impacted', { count: 0, widened: false }, '--pass-with-no-tests --grep-invert .'],
    ['some are', { count: 2, widened: false }, 'a.spec.ts:3 b.spec.ts:9'],
    ['the change widened to the whole suite', { count: 2, widened: true }, ''],
  ])('select impact prints the Playwright arguments when %s', async (_case, { count, widened }, printed) => {
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { stdio: 'pipe' });
    git('init', '-q', '-b', 'main');
    fs.writeFileSync('README.md', 'one\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    fs.writeFileSync('README.md', 'two\n');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/api/projects/menu')) {
          return new Response(JSON.stringify({ items: [{ id: 7, name: 'Web' }] }), { status: 200 });
        }
        return new Response(
          JSON.stringify({
            ...RESOLUTION,
            key: 'impact',
            estimate: { count, totalDurationMs: null },
            materialization: count === 0 ? { format: 'args', args: [], command: '' } : RESOLUTION.materialization,
            impact: { changedFiles: 1, mappedFiles: 0, widened, unmappedSourceFiles: [] },
          }),
          { status: 200 },
        );
      }),
    );
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await runSelect(['impact', '--base', 'HEAD', '--project', 'web'], env)).toBe(0);
    // Composed as `playwright test $(piwi select impact …)`, an empty line runs the whole suite.
    expect(stdout).toHaveBeenCalledWith(printed);
  });
});
