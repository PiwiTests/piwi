import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import type * as ChildProcess from 'node:child_process';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { formatPlanReasons, isPlannedRun, runPlanCommand, runPlannedRun } from '../src/cli/plan.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return { ...actual, spawn: vi.fn() };
});

describe('isPlannedRun', () => {
  it('is true for --reuse and --plan before the Playwright arguments', () => {
    expect(isPlannedRun(['smoke', '--reuse'])).toBe(true);
    expect(isPlannedRun(['--plan', '5'])).toBe(true);
    expect(isPlannedRun(['--plan=5'])).toBe(true);
    expect(isPlannedRun(['smoke'])).toBe(false);
    expect(isPlannedRun(['smoke', '--', '--reuse'])).toBe(false);
  });
});

describe('formatPlanReasons', () => {
  it('lists the reasons tests run, never the reused ones', () => {
    expect(formatPlanReasons({ reused: 9, changed: 2, flaky: 1 })).toBe('2 changed, 1 flaky');
    expect(formatPlanReasons({ reused: 3 })).toBe('');
  });
});

describe('planned runs', () => {
  const env = { PIWI_DASHBOARD_URL: 'https://dash.example', PIWI_API_KEY: 'k', PIWI_PROJECT_NAME: 'Web' };
  const SOURCE = 'a'.repeat(40);
  const SUMMARY = {
    selection: { key: 'full', version: null },
    counts: { candidates: 5, run: 2, reused: 3 },
    reasons: { reused: 3, changed: 2 },
  };
  const SKIP = ['[chromium] › tests/a.spec.ts › adds to cart', '[firefox] › tests/a.spec.ts › adds to cart'];
  let dir: string;
  let cwd: string;
  /** The commit of the test's checkout. */
  let head: string;
  let requests: Array<{ url: string; body: unknown }>;

  /** A dashboard that plans `full`, serves plan 9, or answers `status` to every plan route. */
  function dashboard(
    options: { up?: boolean; skip?: string[]; commit?: string | null; worktree?: string; status?: number } = {},
  ): void {
    requests = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        requests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (options.up === false) throw new TypeError('fetch failed');
        if (url.endsWith('/api/projects/menu')) {
          return new Response(JSON.stringify({ items: [{ id: 7, name: 'Web' }] }), { status: 200 });
        }
        if (url.includes('/run-plans') && options.status) {
          return new Response(JSON.stringify({ message: 'Pass reuse is off for this project' }), {
            status: options.status,
          });
        }
        if (url.endsWith('/api/projects/7/run-plans/sources')) {
          return new Response(JSON.stringify({ candidates: 5, commits: [{ commit: SOURCE, tests: 3 }] }), {
            status: 200,
          });
        }
        if (url.endsWith('/api/projects/7/run-plans')) {
          return new Response(
            JSON.stringify({
              id: 9,
              expiresAt: '',
              ...SUMMARY,
              estimate: { runDurationMs: 0, reusedDurationMs: 0 },
            }),
            { status: 200 },
          );
        }
        if (url.includes('/api/projects/7/run-plans/9')) {
          const plan = {
            id: 9,
            commit: options.commit === undefined ? head : options.commit,
            worktree: options.worktree ?? 'clean',
            expiresAt: '',
            ...SUMMARY,
            args: [],
            skip: options.skip ?? SKIP,
            reused: [],
          };
          return new Response(JSON.stringify(plan), { status: 200 });
        }
        return new Response('{}', { status: 404 });
      }),
    );
  }

  /** The content of each run's skip list, read while Playwright would be running. */
  let lists: string[];

  function spawned(): Array<{ args: string[]; env: NodeJS.ProcessEnv }> {
    return vi.mocked(spawn).mock.calls.map((c) => {
      const call = c as unknown as [string, string[], { env: NodeJS.ProcessEnv }];
      return { args: call[1].slice(call[1].indexOf('test') + 1), env: call[2].env };
    });
  }

  beforeEach(() => {
    // A clean checkout of one commit, which the source commit of the stub dashboard is not in.
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-plan-')));
    cwd = process.cwd();
    process.chdir(dir);
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf-8' }).trim();
    git('init', '-q');
    git('commit', '-q', '--allow-empty', '-m', 'init');
    head = git('rev-parse', 'HEAD');
    lists = [];
    vi.mocked(spawn).mockImplementation(((_cmd: string, args: string[]) => {
      const at = args.indexOf('--test-list-invert');
      if (at !== -1) lists.push(fs.readFileSync(args[at + 1]!, 'utf-8'));
      const child = new EventEmitter();
      setImmediate(() => child.emit('exit', 0));
      return child;
    }) as unknown as typeof spawn);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.chdir(cwd);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.mocked(spawn).mockReset();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('runs the selection less the reused tests, sharded by Playwright, and removes the list after', async () => {
    dashboard();
    expect(await runPlannedRun(['--plan', '9', '--shard', '2/3', '--', '--workers=1'], env)).toBe(0);
    expect(requests[requests.length - 1]!.url).toBe('https://dash.example/api/projects/7/run-plans/9');
    const [run] = spawned();
    const listPath = run!.args[run!.args.indexOf('--test-list-invert') + 1]!;
    expect(run!.args).toEqual(['--test-list-invert', listPath, '--shard=2/3', '--workers=1']);
    expect(lists).toEqual([`${SKIP.join('\n')}\n`]);
    expect(fs.existsSync(listPath)).toBe(false);
  });

  it('runs the selection plain when the plan reuses nothing', async () => {
    dashboard({ skip: [] });
    expect(await runPlannedRun(['--plan', '9'], env)).toBe(0);
    expect(spawned()[0]!.args).toEqual([]);
  });

  it('runs the whole suite in a shard whose checkout is not at the plan’s commit', async () => {
    dashboard({ commit: 'b'.repeat(40) });
    expect(await runPlannedRun(['--plan', '9', '--shard', '1/2'], env)).toBe(0);
    expect(spawned()[0]!.args).toEqual([]);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('was made at bbbbbbbbbbbb'));
  });

  it('does not use a plan made in a dirty checkout, nor one in a dirty checkout', async () => {
    dashboard({ worktree: 'dirty' });
    await runPlannedRun(['--plan', '9'], env);
    expect(spawned()[0]!.args).toEqual([]);

    dashboard();
    fs.writeFileSync(path.join(dir, 'new.spec.ts'), '');
    await runPlannedRun(['--plan', '9'], env);
    expect(spawned()[1]!.args).toEqual([]);
  });

  it('refuses --plan without an id', async () => {
    dashboard();
    expect(await runPlannedRun(['smoke', '--plan'], env)).toBe(2);
    expect(spawned()).toEqual([]);
  });

  it('runs the whole suite, not a shard of it, when the plan cannot be read', async () => {
    dashboard({ up: false });
    expect(await runPlannedRun(['--plan', '9', '--shard', '2/3'], env)).toBe(0);
    expect(spawned()[0]!.args).toEqual([]);
  });

  it('exits 2 instead with --strict', async () => {
    dashboard({ up: false });
    expect(await runPlannedRun(['--plan', '9', '--strict'], env)).toBe(2);
    expect(spawned()).toEqual([]);
  });

  it('plans with --reuse, sending no diff for a commit it cannot read, then runs the plan', async () => {
    dashboard();
    expect(await runPlannedRun(['full', '--reuse'], env)).toBe(0);
    const created = requests.find((r) => r.url.endsWith('/run-plans'))!;
    expect(created.body).toMatchObject({ selection: 'full', diffs: [], commit: head, worktree: 'clean' });
    expect(spawned()[0]!.args[0]).toBe('--test-list-invert');
  });

  it('runs the selection without reuse when the dashboard refuses to plan', async () => {
    dashboard({ status: 403 });
    expect(await runPlannedRun(['full', '--reuse'], env)).toBe(0);
    expect(spawned()[0]!.args).toEqual([]);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Pass reuse is off for this project'));
  });

  it('refuses --reuse in a sharded job', async () => {
    dashboard();
    expect(await runPlannedRun(['full', '--reuse', '--shard', '1/2'], env)).toBe(2);
    expect(spawned()).toEqual([]);
  });

  it('piwi plan prints the plan id on stdout', async () => {
    dashboard();
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await runPlanCommand(['full'], env)).toBe(0);
    expect(stdout).toHaveBeenCalledWith('9');
  });
});
