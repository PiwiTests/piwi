import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { ToolResult } from '../src/run-host';
import { ShellRuns, type ShellRunStart, type ShellRunsOptions, type ShellRunsWords } from '../src/shell-runs';
import { EDITOR_AGENT_WORDS } from '../src/run-agent';

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
      return answer;
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
});
