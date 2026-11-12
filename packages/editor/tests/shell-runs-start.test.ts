import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { ToolResult } from '../src/run-host';
import { ShellRuns, type ShellRunStart, type ShellRunsOptions, type ShellRunsWords } from '../src/shell-runs';
import { EDITOR_AGENT_WORDS, MAX_AGENT_RUNS } from '../src/run-agent';
import type { DesktopRunEvent } from '../src/shell-run-events';

/**
 * An agent's `run_start` on a desktop shell's hub (`ShellRuns`): the spec of a linked folder, checked by the hub, and
 * started by the host's window as a person's run, labeled with the agent's name; refused outside every linked folder
 * and as the host refuses it (no window open).
 */

const TOKEN = `pd_${'d'.repeat(64)}`;
const SPEC =
  "import { test } from '@playwright/test';\n\ntest('pays', async ({ page }) => {\n  await page.goto('/');\n});\n";

const WORDS: ShellRunsWords = {
  host: 'the test host',
  surfaces: "the test host's window",
  client: 'Test host',
  presence: { kind: 'desktop', name: 'the test host' },
  declined: {},
  picked: (locator) => locator,
  codeSent: (what, at) => `${what} ${at}`,
  outside: (file) => `${file} is not in a linked folder.`,
  noWindowToStop: "The test host's window is closed.",
  stopping: 'The test host stops the run.',
  closing: 'The test host stopped.',
  log: '[test-runs]',
};

let folder: string;
let other: string;
let runs: ShellRuns | null = null;
/** What the host's window was asked to start, and what it answers. */
let asked: ShellRunStart[] = [];
let answer: { ref: string } | { refused: string } = { ref: 'desktop-12' };
/** How long the host's window takes to answer, in milliseconds. */
let answerMs = 0;

async function open(options: Partial<ShellRunsOptions> = {}): Promise<ShellRuns> {
  runs = await ShellRuns.start({
    token: TOKEN,
    version: '1.2.3',
    folders: () => [{ id: 7, path: folder }],
    words: WORDS,
    agent: { words: EDITOR_AGENT_WORDS, unattended: 'nobody attends it.', noWindow: 'No window is open.' },
    folderPrefix: 'piwi-test-shell-start-',
    startRun: async (start) => {
      asked.push(start);
      const now = answer;
      if (answerMs) await new Promise((resolve) => setTimeout(resolve, answerMs));
      return now;
    },
    ...options,
  });
  return runs;
}

async function call(name: string, args: Record<string, unknown>): Promise<{ piwi: any; isError: boolean }> {
  const result: ToolResult = await runs!.agent!.call(name, args);
  const first = result.content[0];
  return { piwi: JSON.parse(first?.type === 'text' ? first.text : '{}'), isError: !!result.isError };
}

beforeEach(() => {
  folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-shell-start-')));
  other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-shell-other-')));
  fs.mkdirSync(path.join(folder, 'tests'));
  fs.writeFileSync(path.join(folder, 'tests', 'cart.spec.ts'), SPEC);
  fs.writeFileSync(path.join(folder, 'tests', 'helpers.ts'), 'export {};\n');
  fs.writeFileSync(path.join(other, 'cart.spec.ts'), SPEC);
  asked = [];
  answer = { ref: 'desktop-12' };
  answerMs = 0;
});

afterEach(() => {
  runs?.close();
  runs = null;
  fs.rmSync(folder, { recursive: true, force: true });
  fs.rmSync(other, { recursive: true, force: true });
});

describe('an agent’s run_start on a desktop shell’s hub', () => {
  test('is offered by a host that starts runs, and by no other', async () => {
    await open();
    expect(runs!.agent!.definitions().map((tool) => tool.name)[0]).toBe('run_start');
    runs!.close();
    await open({ startRun: undefined });
    expect(runs!.agent!.definitions().map((tool) => tool.name)).not.toContain('run_start');
    expect((await call('run_start', { file: 'tests/cart.spec.ts' })).piwi.message).toBe(
      'Piwi has no tool "run_start" here.',
    );
  });

  test('has the window start a spec of a linked folder as a person’s run, labeled with the agent, at the test of a line', async () => {
    await open();
    const started = await call('run_start', {
      file: 'tests/cart.spec.ts',
      line: 4,
      headed: true,
      agent: 'Claude Code',
    });
    expect(started).toEqual({
      piwi: {
        ok: true,
        message:
          'tests/cart.spec.ts:3 started in the test host\'s window, as "Started by Claude Code". Follow it with run_follow.',
        run: 'desktop-12',
      },
      isError: false,
    });
    expect(asked).toEqual([
      {
        projectId: 7,
        file: 'tests/cart.spec.ts',
        line: 3,
        headed: true,
        hold: true,
        title: 'Started by Claude Code',
      },
    ]);
    // Hold failures is the agent's, on by default, before the run's workers connect.
    expect(runs!.sessions.holdOf('desktop-12')).toEqual({ on: true, by: 'agent' });

    // An absolute path, the whole spec, and a hold turned off.
    answer = { ref: 'desktop-13' };
    await call('run_start', { file: path.join(folder, 'tests', 'cart.spec.ts'), hold: false });
    expect(asked[1]).toMatchObject({ file: 'tests/cart.spec.ts', line: null, headed: false, hold: false });
    expect(asked[1]!.title).toBe('Started by An agent');
    expect(runs!.sessions.holdOf('desktop-13')).toEqual({ on: false, by: 'agent' });
  });

  test('refuses a file outside every linked folder, one that is no spec, and one that is not there', async () => {
    await open();
    const outside = await call('run_start', { file: path.join(other, 'cart.spec.ts') });
    expect(outside.piwi.message).toBe(
      `${path.join(other, 'cart.spec.ts')} is in no folder linked to a project: the test host runs the specs of its linked folders alone.`,
    );
    expect((await call('run_start', { file: '../cart.spec.ts' })).piwi.message).toMatch(/in no folder linked/);
    expect((await call('run_start', { file: 'tests/helpers.ts' })).piwi.message).toBe(
      'tests/helpers.ts is no spec file (`*.spec.ts`, `*.test.ts`).',
    );
    expect((await call('run_start', { file: 'tests/gone.spec.ts' })).piwi.message).toMatch(/in no folder linked/);
    expect(asked).toEqual([]);
  });

  test('says why the host did not start it, a window that is not open among them', async () => {
    await open();
    answer = { refused: 'No window is open: open it to start a run.' };
    expect(await call('run_start', { file: 'tests/cart.spec.ts' })).toEqual({
      piwi: { ok: false, message: 'No window is open: open it to start a run.' },
      isError: true,
    });
    // A run nobody attends is not the agent's to follow.
    answer = { ref: 'desktop-14-unattended' };
    expect((await call('run_start', { file: 'tests/cart.spec.ts' })).piwi).toEqual({
      ok: false,
      message:
        "tests/cart.spec.ts started in the test host's window, but it is not served to agents: nobody attends it.",
    });
  });

  test('ends a run as the window says its process ended, whose workers never connected, and frees its place', async () => {
    await open();
    for (const id of [21, 22, 23]) {
      answer = { ref: `desktop-${id}` };
      expect((await call('run_start', { file: 'tests/cart.spec.ts' })).isError).toBe(false);
    }
    answer = { ref: 'desktop-24' };
    expect((await call('run_start', { file: 'tests/cart.spec.ts' })).piwi.message).toBe(
      '3 runs agents started have not ended (desktop-21, desktop-22, desktop-23): follow one to its end, or let its stops go on, before starting another.',
    );
    expect(runs!.ended('desktop-22', 1)).toBeNull();
    const followed = await call('run_follow', { run: 'desktop-22', wait: 0 });
    expect(followed.piwi.events).toEqual([expect.objectContaining({ kind: 'run-ended', exitCode: 1 })]);
    expect((await call('run_start', { file: 'tests/cart.spec.ts' })).piwi).toMatchObject({
      ok: true,
      run: 'desktop-24',
    });
    // A run the shell did not start is no ref of this hub's.
    expect(runs!.ended('terminal-1', 0)).toBe('The ref names no run the shell starts.');
    expect(runs!.ended('desktop-25', 'x')).toBe('exitCode is a whole number, or null.');
  });

  test(`counts the starts still waiting for the window, ${MAX_AGENT_RUNS} at once at most`, async () => {
    await open();
    answerMs = 30;
    let next = 30;
    const startOne = () => {
      answer = { ref: `desktop-${next++}` };
      return call('run_start', { file: 'tests/cart.spec.ts' });
    };
    const answers = await Promise.all(Array.from({ length: 6 }, startOne));
    expect(answers.filter((a) => !a.isError)).toHaveLength(MAX_AGENT_RUNS);
    expect(asked).toHaveLength(MAX_AGENT_RUNS);
    // A start the window refused gives its place back.
    runs!.close();
    asked = [];
    await open();
    answer = { refused: 'No window is open.' };
    for (let i = 0; i < MAX_AGENT_RUNS + 1; i++) {
      expect((await call('run_start', { file: 'tests/cart.spec.ts' })).piwi.message).toBe('No window is open.');
    }
    expect(asked).toHaveLength(MAX_AGENT_RUNS + 1);
  });

  test('counts a run the window started that nobody attends, and has the window stop it', async () => {
    await open();
    const heard: DesktopRunEvent[] = [];
    await runs!.openWindow({ send: (event) => heard.push(event as DesktopRunEvent), buffered: () => 0, close() {} });
    for (const id of [41, 42, 43]) {
      answer = { ref: `desktop-${id}-unattended` };
      expect((await call('run_start', { file: 'tests/cart.spec.ts' })).isError).toBe(true);
    }
    expect(heard.filter((event) => event.type === 'stop-run')).toEqual([
      { type: 'stop-run', ref: 'desktop-41-unattended' },
      { type: 'stop-run', ref: 'desktop-42-unattended' },
      { type: 'stop-run', ref: 'desktop-43-unattended' },
    ]);
    answer = { ref: 'desktop-44' };
    expect((await call('run_start', { file: 'tests/cart.spec.ts' })).piwi.message).toMatch(/^3 runs agents started/);
    // Not listed to agents, and its place freed once its process ended.
    expect((await call('run_list', {})).piwi.runs).toEqual([]);
    runs!.ended('desktop-42', 0);
    expect((await call('run_start', { file: 'tests/cart.spec.ts' })).piwi).toMatchObject({
      ok: true,
      run: 'desktop-44',
    });
  });

  test('refuses a line of no test, a spec Playwright would read as an option and a path it cannot read', async () => {
    await open();
    expect((await call('run_start', { file: 'tests/cart.spec.ts', line: 999 })).piwi.message).toBe(
      'Line 999 of tests/cart.spec.ts is in no test: name a line of a test, or leave out line to run the whole spec.',
    );
    expect((await call('run_start', { file: 'tests/cart.spec.ts', line: 1 })).piwi.message).toBe(
      'Line 1 of tests/cart.spec.ts is in no test: name a line of a test, or leave out line to run the whole spec.',
    );
    fs.writeFileSync(path.join(folder, '-cart.spec.ts'), SPEC);
    expect((await call('run_start', { file: '-cart.spec.ts' })).piwi.message).toBe(
      '-cart.spec.ts starts with "-", which Playwright reads as an option: rename the spec to run it.',
    );
    const long = `${'a'.repeat(300)}.spec.ts`;
    expect((await call('run_start', { file: long })).piwi.message).toBe(`Piwi cannot read ${long}: ENAMETOOLONG.`);
    expect(asked).toEqual([]);
  });

  test('names a run’s command only where every shell reads its words as they are', async () => {
    await open();
    const command = (ref: string, args: string[]) => {
      expect(runs!.started(ref, args)).toBeNull();
      return (runs as unknown as { commandOf(ref: string): string | null }).commandOf(ref);
    };
    expect(command('desktop-1', ['tests/cart.spec.ts:3', '--grep', 'pays (card); by | card'])).toBe(
      'npx playwright test tests/cart.spec.ts:3 --grep "pays (card); by | card"',
    );
    for (const arg of ['$(calc)', '`calc`', '"x"', 'a\\b', '%PATH%', 'x‮y', 'x​y', 'wow!']) {
      expect(command('desktop-2', ['--grep', arg])).toBeNull();
    }
  });
});
