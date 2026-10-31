import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatEditorDiscovery, type EditorDiscovery } from '@piwitests/core/editor-discovery';
import { lineReader } from '@piwitests/core/ide-recorder';
import { parseRunToHub, type HubToRun, type RunToHub } from '@piwitests/core/run-channel';
import { terminalRunSkip } from '../src/internal/config/editors.js';

/**
 * A run started in a terminal, through the built package: no `PIWI_RUN_CHANNEL`, a fake editor service listed in a
 * folder of discovery files (`PIWI_EDITORS_DIR`) whose workspace holds the run. The run follows it, is steered and
 * ends there; so does one an editor's test runner starts (`PW_TEST_REPORTER` naming its reporter file), which says so.
 * It follows none when told not to, under CI, with no terminal nor test runner, or when the only files are another
 * machine's or another user's.
 */

const pkgRoot = path.join(import.meta.dirname, '..');
const dist = path.join(pkgRoot, 'dist', 'index.js');
const project = path.join(pkgRoot, 'tests', `.terminal-run-${process.pid}`);
const TOKEN = 'terminal-run-token-0123456789';

const SPEC = `const { test } = require('../fixture.cjs');
test('steered', async ({ page }) => {
  await page.setContent('<button>Go</button>');
  await page.getByRole('button').click(); // bp:steered
});
test('ended', async ({ page }) => {
  await page.setContent('<button>Go</button>');
  await page.getByRole('button').click(); // bp:ended
});
`;

interface Connection {
  socket: net.Socket;
  heard: RunToHub[];
}

let folder = '';
let editors = '';
let hub: net.Server;
const connections: Connection[] = [];
const lines: Record<string, number> = {};

function send(connection: Connection, message: HubToRun): void {
  connection.socket.write(`${JSON.stringify(message)}\n`);
}

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
  fs.writeFileSync(path.join(project, file), text);
}

/** The discovery file of the fake service, as an editor service writes it. */
function discovery(patch: Partial<EditorDiscovery> = {}): EditorDiscovery {
  return {
    pid: process.pid,
    host: os.hostname(),
    version: '0.62.0',
    client: 'Test Editor',
    startedAt: new Date().toISOString(),
    roots: [project],
    hub: null,
    runChannel: { path: path.join(folder, 'channel.sock'), token: TOKEN },
    recorderBundle: null,
    ...patch,
  };
}

/** Write the folder's discovery files afresh, as `files` names them. */
function listEditors(files: Record<string, EditorDiscovery>): void {
  for (const name of fs.readdirSync(editors)) fs.rmSync(path.join(editors, name));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(editors, name), formatEditorDiscovery(content), { mode: 0o600 });
  }
}

/** Run the suite with `env` over a plain environment; resolves with its output and the connections it opened. */
async function run(env: NodeJS.ProcessEnv): Promise<{ output: string; opened: Connection[] }> {
  const before = connections.length;
  const base: NodeJS.ProcessEnv = { ...process.env, PIWI_EDITORS_DIR: editors };
  for (const name of [
    'CI',
    'GITHUB_ACTIONS',
    'PWDEBUG',
    'PIWI_DASHBOARD_URL',
    'PIWI_RUN_CHANNEL',
    'PIWI_RECORD_CHANNEL',
    'PIWI_EDITOR_SEND',
    'PIWI_ORIGIN',
    'PIWI_ORIGIN_REF',
    'PIWI_RUN_REF',
    'PIWI_PAUSE_AT',
    'PIWI_EDITOR',
    'PW_TEST_REPORTER',
  ]) {
    delete base[name];
  }
  const output = await new Promise<string>((resolve) => {
    execFile(
      process.execPath,
      [createRequire(import.meta.url).resolve('@playwright/test/cli'), 'test'],
      { cwd: project, env: { ...base, ...env }, timeout: 60_000 },
      (_error, stdout, stderr) => resolve(`${stdout}\n${stderr}`),
    );
  });
  return { output, opened: connections.slice(before) };
}

beforeAll(async () => {
  if (!fs.existsSync(dist)) throw new Error(`${dist} is missing: run \`npm run reporter:build\` before this spec`);
  folder = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-terminal-run-'));
  editors = path.join(folder, 'editors');
  fs.mkdirSync(editors, { mode: 0o700 });
  hub = net.createServer((socket) => {
    const connection: Connection = { socket, heard: [] };
    connections.push(connection);
    socket.setEncoding('utf8');
    socket.on('error', () => socket.destroy());
    socket.on(
      'data',
      lineReader(
        (line) => {
          const message = parseRunToHub(line);
          if (!message) return;
          connection.heard.push(message);
          // The editor's breakpoints, which a run started in a terminal starts with.
          if (message.type === 'run-attach') {
            send(connection, {
              type: 'breakpoints',
              places: [
                { file: 'tests/a.spec.cjs', line: lines.steered! },
                { file: 'tests/a.spec.cjs', line: lines.ended! },
              ],
            });
          }
          if (message.type === 'stopped') {
            const begun = [...connection.heard].reverse().find((m) => m.type === 'test-begin');
            const title = begun?.type === 'test-begin' ? begun.title[begun.title.length - 1] : '';
            send(connection, { type: 'control', action: title === 'ended' ? 'end' : 'resume', stop: message.stop });
          }
        },
        () => socket.destroy(),
      ),
    );
  });
  await new Promise<void>((resolve) => hub.listen(path.join(folder, 'channel.sock'), resolve));

  SPEC.split('\n').forEach((line, i) => {
    const marker = /\/\/ bp:([\w-]+)$/.exec(line)?.[1];
    if (marker) lines[marker] = i + 1;
  });
  write('tests/a.spec.cjs', SPEC);
  // The reporter an editor's test runner adds through PW_TEST_REPORTER: it reports nothing here.
  write('ide-reporter.cjs', 'module.exports = class { printsToStdio() { return false; } };\n');
  write(
    'fixture.cjs',
    `const { test: base } = require('@playwright/test');
const { extendPiwiFixtures } = require(${JSON.stringify(dist)});
exports.test = extendPiwiFixtures(base);
`,
  );
  write(
    'playwright.config.cjs',
    `const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  testDir: './tests',
  outputDir: './test-results',
  timeout: 5000,
  workers: 1,
  reporter: [[${JSON.stringify(dist)}, {}], ['list']],
  use: { headless: true },
});
`,
  );
});

afterAll(async () => {
  fs.rmSync(project, { recursive: true, force: true });
  await new Promise<void>((resolve) => hub?.close(() => resolve()));
  for (const connection of connections) connection.socket.destroy();
  if (folder) fs.rmSync(folder, { recursive: true, force: true });
});

describe('a run started in a terminal', () => {
  it('follows the editor whose workspace holds it: steered from its breakpoints, and ended there', async () => {
    listEditors({ [`${process.pid}.json`]: discovery() });
    const { output, opened } = await run({ PIWI_EDITOR: 'on' });
    expect(output).toContain(
      `Following this run in Test Editor (pid ${process.pid}), whose breakpoints stop it: PIWI_EDITOR=off runs it alone.`,
    );
    expect(opened).toHaveLength(1);
    const [attach] = opened[0]!.heard;
    expect(attach).toMatchObject({ type: 'run-attach', token: TOKEN, ref: expect.stringMatching(/^terminal-\d+-\d+$/) });
    // It carries no record channel nor pairing: Pick a locator, Record here and Assert are not offered.
    expect(attach?.type === 'run-attach' ? attach.takes : []).not.toEqual(
      expect.arrayContaining(['pick', 'record', 'assert']),
    );
    expect(attach?.type === 'run-attach' ? attach.takes : []).toContain('end');
    const stops = opened[0]!.heard.filter((m): m is Extract<RunToHub, { type: 'stopped' }> => m.type === 'stopped');
    expect(stops.map((s) => s.place.line)).toEqual([lines.steered, lines.ended]);
    const ends = opened[0]!.heard.filter((m) => m.type === 'test-end').map((m) => m.type === 'test-end' && m.status);
    expect(ends).toEqual(['passed', 'skipped']);
    // A terminal's run is no test runner's.
    expect(attach).not.toHaveProperty('runner');
  }, 60_000);

  it('follows the editor from its own test runner, whose output goes to no terminal, and says so', async () => {
    listEditors({ [`${process.pid}.json`]: discovery() });
    const { output, opened } = await run({ PW_TEST_REPORTER: path.join(project, 'ide-reporter.cjs') });
    expect(output).toContain(`Following this run in Test Editor (pid ${process.pid})`);
    expect(opened).toHaveLength(1);
    const [attach] = opened[0]!.heard;
    expect(attach).toMatchObject({ type: 'run-attach', ref: expect.stringMatching(/^terminal-\d+-\d+$/), runner: true });
    const stops = opened[0]!.heard.filter((m): m is Extract<RunToHub, { type: 'stopped' }> => m.type === 'stopped');
    expect(stops.map((s) => s.place.line)).toEqual([lines.steered, lines.ended]);
  }, 60_000);

  it('follows none with PIWI_EDITOR=off, under CI, or with no terminal nor test runner unless PIWI_EDITOR=on', async () => {
    listEditors({ [`${process.pid}.json`]: discovery() });
    for (const env of [{ PIWI_EDITOR: 'off' }, { PIWI_EDITOR: 'on', CI: 'true' }, {}]) {
      const { output, opened } = await run(env);
      expect(opened, JSON.stringify(env)).toEqual([]);
      expect(output, JSON.stringify(env)).not.toContain('Following this run');
    }
  }, 120_000);

  it('follows none whose file is another machine’s, another user’s, or holds another workspace', async () => {
    const files: Record<string, EditorDiscovery> = {
      [`${process.pid}.json`]: discovery({ host: 'build-agent' }),
      [`${process.ppid}.json`]: discovery({ pid: process.ppid, roots: [path.join(folder, 'elsewhere')] }),
    };
    // Another user's file, where this one may give a file to another user.
    const root = typeof process.getuid === 'function' && process.getuid() === 0;
    if (root) files['2.json'] = discovery({ pid: 1 });
    listEditors(files);
    if (root) fs.chownSync(path.join(editors, '2.json'), 4242, 4242);
    const { opened } = await run({ PIWI_EDITOR: 'on' });
    expect(opened).toEqual([]);
  }, 60_000);

  it('follows none whose file was written before this machine started, or whose channel other users reach', async () => {
    // Its process went with the restart: another process may have its id since.
    const booted = Date.now() - os.uptime() * 1000;
    listEditors({ [`${process.pid}.json`]: discovery({ startedAt: new Date(booted - 3_600_000).toISOString() }) });
    expect((await run({ PIWI_EDITOR: 'on' })).opened).toEqual([]);
    // A named pipe tells no owner.
    if (process.platform === 'win32') return;
    // A socket in a folder other users can enter may be another user's, serving the name a stale file holds.
    const shared = path.join(folder, 'shared');
    fs.mkdirSync(shared);
    fs.chmodSync(shared, 0o755);
    let reached = 0;
    const squatter = net.createServer((socket) => {
      reached++;
      socket.destroy();
    });
    await new Promise<void>((resolve) => squatter.listen(path.join(shared, 'channel.sock'), resolve));
    try {
      const runChannel = { path: path.join(shared, 'channel.sock'), token: TOKEN };
      listEditors({ [`${process.pid}.json`]: discovery({ runChannel }) });
      const { output, opened } = await run({ PIWI_EDITOR: 'on' });
      expect(opened).toEqual([]);
      expect(reached).toBe(0);
      expect(output).not.toContain('Following this run');
    } finally {
      await new Promise<void>((resolve) => squatter.close(() => resolve()));
    }
  }, 120_000);

  it('looks for no editor where a launcher, a run channel or Playwright’s debugger runs it', () => {
    const gate = (env: NodeJS.ProcessEnv, argv: string[] = ['node', 'cli.js', 'test']) =>
      terminalRunSkip({ env, argv, terminal: true });
    expect(gate({})).toBeNull();
    expect(gate({ PIWI_RUN_CHANNEL: 'off' })).toBe('the run names its PIWI_RUN_CHANNEL');
    expect(gate({ PIWI_ORIGIN: 'desktop' })).toBe('a launcher started the run');
    expect(gate({ GITHUB_ACTIONS: 'true' })).toBe('running under CI');
    expect(gate({ PWDEBUG: '1' })).toBe("Playwright's Inspector runs it");
    expect(gate({ PWDEBUG: 'console' })).toBeNull();
    expect(gate({}, ['node', 'cli.js', 'test', '--debug=cli'])).toBe("Playwright's debugger or UI mode runs it");
    expect(gate({}, ['node', 'cli.js', 'test', '--ui'])).toBe("Playwright's debugger or UI mode runs it");
    // Playwright opens UI mode for a UI host or port too.
    for (const ui of [['--ui-port=0'], ['--ui-port', '0'], ['--ui-host=127.0.0.1']]) {
      expect(gate({}, ['node', 'cli.js', 'test', ...ui]), ui.join(' ')).toBe("Playwright's debugger or UI mode runs it");
    }
    expect(gate({}, ['node', 'cli.js', 'merge-reports', 'blob-report'])).toBe('it merges reports, running no test');
    expect(terminalRunSkip({ env: {}, argv: [], terminal: false })).toBe('its output goes to no terminal');
  });

  it('looks for an editor from a test runner that adds its reporter file, as a terminal’s run does', () => {
    const gate = (env: NodeJS.ProcessEnv) => terminalRunSkip({ env, argv: ['node', 'cli.js', 'test'], terminal: false });
    expect(gate({ PW_TEST_REPORTER: '/ide/plugins/javascript/playwright-reporter.js' })).toBeNull();
    expect(gate({ PW_TEST_REPORTER: 'C:\\ide\\plugins\\playwright-reporter.js' })).toBeNull();
    // One of Playwright's own reporters, named: no test runner of an editor.
    expect(gate({ PW_TEST_REPORTER: 'dot' })).toBe('its output goes to no terminal');
    expect(gate({ PW_TEST_REPORTER: ' ' })).toBe('its output goes to no terminal');
    // The rest of the gate holds for it too.
    const runner = { PW_TEST_REPORTER: '/ide/playwright-reporter.js' };
    expect(gate({ ...runner, PIWI_EDITOR: 'off' })).toBe('PIWI_EDITOR=off');
    expect(gate({ ...runner, CI: 'true' })).toBe('running under CI');
    expect(gate({ ...runner, PIWI_ORIGIN: 'desktop' })).toBe('a launcher started the run');
  });
});
