import { describe, expect, test } from 'vitest';
import type {
  CoverageResult,
  DesktopJobUpdate,
  DesktopResult,
  FailuresResult,
  FailureTreeNode,
  FileEdit,
  LiveRun,
  RunEnded,
  RunStatusResult,
  StatusResult,
} from '@piwitests/editor/protocol';
import {
  DOCUMENT_PATTERN,
  baselinePicks,
  coalesced,
  coverageDecorations,
  hasCoverageMarks,
  pickNotice,
  configTestDir,
  connectChoices,
  desktopJobNotice,
  disconnectQuestion,
  failureNodes,
  followBlock,
  followEdit,
  importChange,
  recordInto,
  mcpConfiguration,
  newTestFileName,
  placedBlock,
  recordedBlockText,
  recordingSummary,
  recordingView,
  refreshingText,
  relativeTime,
  failureRunArgs,
  runsInFiles,
  filesRedraw,
  ownLiveRun,
  runVerdict,
  serviceEnvironment,
  sourceLabel,
  statusBarView,
  testDecorations,
  withBaseline,
  writeBlock,
  type RecordedBlock,
  type TextChange,
  type TextSpan,
} from '../src/glue';

const connected: StatusResult = {
  contexts: [
    {
      root: '/w',
      connected: true,
      serverUrl: 'http://piwi',
      source: 'dotenv',
      projectId: 7,
      projectName: 'Acme',
      branch: 'main',
      locators: 2,
      reachedFiles: 1,
      problem: null,
    },
  ],
};

const run = (over: Partial<NonNullable<RunStatusResult['contexts'][number]['run']>>): RunStatusResult => ({
  contexts: [
    {
      root: '/w',
      branch: 'feature/pay',
      failures: over.failedTests ?? 0,
      run: {
        id: 41,
        status: 'passed',
        startTime: '2026-09-27T10:00:00.000Z',
        totalTests: 120,
        passedTests: 118,
        failedTests: 0,
        flakyTests: 2,
        skippedTests: 0,
        url: 'http://piwi/test-runs/41',
        ...over,
      },
    },
  ],
});

describe('statusBarView', () => {
  const FROM = 'http://piwi, from the workspace .env';
  const LINKS =
    '[Open run #41](command:piwi.openRun) · [Open in dashboard](command:piwi.openInDashboard) · [Compare with…](command:piwi.compareWith) · [Connect](command:piwi.connect)';

  test('without a Playwright config, says so', () => {
    expect(statusBarView({ contexts: [] }, null)).toMatchObject({ text: '$(beaker) Piwi', action: 'none' });
  });

  test('when not connected, offers Connect with the reason', () => {
    const view = statusBarView(
      { contexts: [{ ...connected.contexts[0]!, connected: false, problem: 'No project chosen.' }] },
      null,
    );
    expect(view).toMatchObject({
      text: '$(plug) Piwi: connect',
      tooltip: 'No project chosen.\n\n[Connect](command:piwi.connect)',
      action: 'connect',
    });
  });

  test('when the instance does not answer, says so and offers to read it again rather than Connect', () => {
    const problem = 'Could not reach http://piwi: fetch failed';
    const view = statusBarView(
      { contexts: [{ ...connected.contexts[0]!, connected: false, problem, problemKind: 'unreachable' }] },
      null,
    );
    expect(view).toEqual({
      text: '$(debug-disconnect) Piwi: unreachable',
      tooltip: `${problem}\n\nPiwi reads it again on its own.\n\n[Retry](command:piwi.refresh) · [Connect](command:piwi.connect)`,
      action: 'retry',
      url: null,
      error: false,
    });
    const refused = statusBarView(
      { contexts: [{ ...connected.contexts[0]!, connected: false, problem: 'Refused.', problemKind: 'refused' }] },
      null,
    );
    expect(refused).toMatchObject({ text: '$(plug) Piwi: connect', action: 'connect' });
  });

  test('a passing run, with its flaky tests; a click reads it again', () => {
    expect(statusBarView(connected, run({}))).toEqual({
      text: '$(pass) Piwi: 118 passed · 2 flaky',
      tooltip: `Run #41 of Acme on feature/pay: 118 passed, 0 failed, 2 flaky, 0 skipped\n\n${FROM}\n\n${LINKS}`,
      action: 'refresh',
      url: 'http://piwi/test-runs/41',
      error: false,
    });
  });

  test('the tooltip names the reporter the project installs', () => {
    const withReporter: RunStatusResult = { contexts: [{ ...run({}).contexts[0]!, reporterVersion: '0.47.0' }] };
    expect(statusBarView(connected, withReporter).tooltip).toBe(
      `Run #41 of Acme on feature/pay: 118 passed, 0 failed, 2 flaky, 0 skipped\n\n${FROM}\n\nreporter 0.47.0\n\n${LINKS}`,
    );
    const unknown: RunStatusResult = { contexts: [{ ...run({}).contexts[0]!, reporterVersion: null }] };
    expect(statusBarView(connected, unknown).tooltip).not.toContain('reporter');
  });

  test('the tooltip says when the run was read, and whether the next one is pushed or polled', () => {
    const now = Date.parse('2026-09-27T12:00:12.000Z');
    const read = (stream?: 'live' | 'polling'): RunStatusResult => ({
      contexts: [{ ...run({}).contexts[0]!, updatedAt: '2026-09-27T12:00:00.000Z', stream }],
    });
    expect(statusBarView(connected, read('live'), false, now).tooltip.split('\n\n')).toEqual([
      'Run #41 of Acme on feature/pay: 118 passed, 0 failed, 2 flaky, 0 skipped',
      'Updated 12 s ago · live',
      FROM,
      LINKS,
    ]);
    expect(statusBarView(connected, read('polling'), false, now).tooltip).toContain(
      '\n\nUpdated 12 s ago · read every minute\n\n',
    );
    // From a service that does not say when.
    expect(statusBarView(connected, run({}), false, now).tooltip).not.toContain('Updated');
  });

  test('the tooltip shows the names it holds as they are written', () => {
    const named: StatusResult = { contexts: [{ ...connected.contexts[0]!, projectName: 'Shop_*Web*' }] };
    expect(statusBarView(named, run({})).tooltip).toMatch(/^Run #41 of Shop\\_\\\*Web\\\* on feature\/pay: /);
  });

  test('a failing run is an error', () => {
    expect(statusBarView(connected, run({ status: 'failed', failedTests: 3, passedTests: 115 }))).toMatchObject({
      text: '$(error) Piwi: 3 failing · 2 flaky',
      action: 'refresh',
      error: true,
    });
  });

  test('counts the tests still failing after the local runs, and those they fixed', () => {
    const local = (counts: { failingTests: number; resolved: number; overlays: number }): RunStatusResult => {
      const runs = run({ status: 'failed', failedTests: 3, passedTests: 115, flakyTests: 0 });
      return { contexts: [{ ...runs.contexts[0]!, ...counts }] };
    };
    const view = statusBarView(connected, local({ failingTests: 2, resolved: 1, overlays: 2 }));
    expect(view).toMatchObject({ text: '$(error) Piwi: 2 failing · 1 fixed locally', error: true });
    expect(view.tooltip).toBe(
      `Run #41 of Acme on feature/pay: 115 passed, 3 failed, 0 flaky, 0 skipped\n\n2 local runs since · 1 test fixed locally\n\n${FROM}\n\n${LINKS}`,
    );
    expect(statusBarView(connected, local({ failingTests: 0, resolved: 3, overlays: 1 }))).toMatchObject({
      text: '$(pass) Piwi: 3 fixed locally',
      error: false,
    });
    expect(statusBarView(connected, local({ failingTests: 1, resolved: 0, overlays: 1 }))).toMatchObject({
      text: '$(error) Piwi: 1 failing',
      tooltip: expect.stringContaining('\n\n1 local run since · 0 tests fixed locally\n\n'),
    });
    expect(statusBarView(connected, local({ failingTests: 3, resolved: 0, overlays: 0 })).tooltip).not.toContain(
      'local run',
    );
  });

  test('a run in progress, the editor’s own or one on the branch, in the item and beside the latest run', () => {
    const inProgress: LiveRun = {
      runId: 124,
      status: 'running',
      done: 4,
      total: 9,
      failed: 1,
      startedAt: '2026-09-27T11:00:00.000Z',
      own: true,
    };
    const live = (over: Partial<LiveRun> | null): RunStatusResult => {
      const runs = run({ status: 'failed', failedTests: 3, passedTests: 115, flakyTests: 0 });
      return { contexts: [{ ...runs.contexts[0]!, failingTests: 3, live: over && { ...inProgress, ...over } }] };
    };
    expect(statusBarView(connected, live({}))).toMatchObject({
      text: '$(sync~spin) Piwi: 4/9 · 1 failing · your run',
      tooltip: `Run #41 of Acme on feature/pay: 115 passed, 3 failed, 0 flaky, 0 skipped\n\nYour run #124 is running: 4/9 · 1 failing\n\n${FROM}\n\n${LINKS}`,
      action: 'refresh',
      error: false,
    });
    expect(statusBarView(connected, live({ own: false, failed: 0 }))).toMatchObject({
      text: '$(sync~spin) Piwi: 4/9',
      tooltip: expect.stringContaining('\n\nRun #124 is running: 4/9\n\n'),
    });
    // Once it ended, the latest run again.
    expect(statusBarView(connected, live(null)).text).toBe('$(error) Piwi: 3 failing');
    // On a branch without a run yet.
    const first: RunStatusResult = {
      contexts: [{ root: '/w', branch: 'wip', run: null, failures: 0, live: { ...inProgress, done: 0, failed: 0 } }],
    };
    expect(statusBarView(connected, first)).toMatchObject({
      text: '$(sync~spin) Piwi: 0/9 · your run',
      tooltip: `No run of Acme on wip yet\n\nYour run #124 is running: 0/9\n\n${FROM}\n\n[Open in dashboard](command:piwi.openInDashboard) · [Compare with…](command:piwi.compareWith) · [Connect](command:piwi.connect)`,
      action: 'refresh',
    });
  });

  test('the files are drawn again when the latest run changes, not while a run in progress moves', () => {
    const latest = run({ status: 'failed', failedTests: 1 });
    const moving: RunStatusResult = {
      contexts: [
        {
          ...latest.contexts[0]!,
          live: { runId: 124, status: 'running', done: 1, total: 9, failed: 0, startedAt: '', own: true },
          stream: 'live',
          updatedAt: '2026-09-27T11:00:00.000Z',
        },
      ],
    };
    expect(runsInFiles(moving)).toBe(runsInFiles(latest));
    expect(runsInFiles(run({}))).not.toBe(runsInFiles(latest));
    // A test of the run in progress that begins or ends draws the tests' lines again.
    const testing = {
      contexts: [{ ...moving.contexts[0]!, liveTests: [{ testCaseId: 1, status: 'running' as const }] }],
    };
    expect(runsInFiles(testing)).not.toBe(runsInFiles(moving));
    expect(filesRedraw(latest, moving)).toBe('none');
    expect(filesRedraw(moving, testing)).toBe('tests');
    expect(
      filesRedraw(testing, {
        contexts: [{ ...testing.contexts[0]!, liveTests: [{ testCaseId: 1, status: 'passed' }] }],
      }),
    ).toBe('tests');
    expect(filesRedraw(testing, run({}))).toBe('all');
    expect(filesRedraw(null, latest)).toBe('all');
    expect(filesRedraw(null, null)).toBe('none');
    // The failures view's first node follows the editor's own run alone.
    expect(ownLiveRun(moving)).not.toBe(ownLiveRun(latest));
    const other = { contexts: [{ ...moving.contexts[0]!, live: { ...moving.contexts[0]!.live!, own: false } }] };
    expect(ownLiveRun(other)).toBe(ownLiveRun(latest));
  });

  test('a running run shows its progress', () => {
    expect(
      statusBarView(connected, run({ status: 'running', passedTests: 40, failedTests: 1, flakyTests: 0 })),
    ).toMatchObject({ text: '$(sync~spin) Piwi: 41/120 · 1 failing', action: 'refresh' });
  });

  test('an interrupted run names its status', () => {
    expect(statusBarView(connected, run({ status: 'interrupted' })).text).toBe('$(warning) Piwi: interrupted');
  });

  test('a branch without a run', () => {
    const view = statusBarView(connected, { contexts: [{ root: '/w', branch: 'wip', run: null, failures: 0 }] });
    expect(view).toMatchObject({
      text: '$(beaker) Piwi: no run',
      tooltip: `No run of Acme on wip yet\n\n${FROM}\n\n[Open in dashboard](command:piwi.openInDashboard) · [Compare with…](command:piwi.compareWith) · [Connect](command:piwi.connect)`,
      action: 'refresh',
    });
  });

  test('while a click reads the run again, the item’s icon spins', () => {
    expect(refreshingText('$(error) Piwi: 2 failing')).toBe('$(sync~spin) Piwi: 2 failing');
    expect(refreshingText('Piwi')).toBe('$(sync~spin) Piwi');
  });
});

describe('relativeTime', () => {
  test('in seconds, minutes, hours, then days', () => {
    const at = '2026-09-27T12:00:00.000Z';
    const ago = (ms: number) => relativeTime(at, Date.parse(at) + ms);
    expect(ago(400)).toBe('just now');
    expect(ago(-5_000)).toBe('just now');
    expect(ago(12_000)).toBe('12 s ago');
    expect(ago(59_999)).toBe('59 s ago');
    expect(ago(60_000)).toBe('1 min ago');
    expect(ago(4 * 60_000 + 30_000)).toBe('4 min ago');
    expect(ago(2 * 3_600_000)).toBe('2 h ago');
    expect(ago(3 * 86_400_000 + 5)).toBe('3 d ago');
    expect(relativeTime('not a time', 0)).toBe('just now');
  });
});

describe('mcpConfiguration', () => {
  test('is a VS Code mcp.json with the key in a header', () => {
    expect(
      JSON.parse(
        mcpConfiguration([
          { label: 'Piwi (a)', url: 'https://a/mcp', headers: { Authorization: 'Bearer pd_x' } },
          { label: 'Piwi (b)', url: 'http://b/mcp', headers: {} },
        ]),
      ),
    ).toEqual({
      servers: {
        piwi: { type: 'http', url: 'https://a/mcp', headers: { Authorization: 'Bearer pd_x' } },
        'piwi-2': { type: 'http', url: 'http://b/mcp' },
      },
    });
  });
});

describe('Piwi: Disconnect', () => {
  test('asks about what is saved, and nothing when nothing is', () => {
    expect(disconnectQuestion('https://piwi.corp', 'Shop')).toBe(
      'forget https://piwi.corp, the project, and the API key saved for it?',
    );
    expect(disconnectQuestion(null, 'Shop')).toBe('forget the project Shop saved for the desktop app?');
    expect(disconnectQuestion(null, null)).toBeNull();
    expect(disconnectQuestion(null, null, true)).toBe('forget the choice of the desktop app?');
    expect(disconnectQuestion('https://piwi.corp', 'Shop', true)).toBe(
      'forget https://piwi.corp, the project, and the API key saved for it, and the choice of the desktop app?',
    );
  });

  test('the desktop app is named as a source', () => {
    expect(sourceLabel('desktop')).toBe('the Piwi desktop app');
  });
});

describe('the desktop app beside another instance', () => {
  const desktop: DesktopResult = {
    url: 'http://127.0.0.1:3000',
    projects: [{ id: 3, name: 'Shop' }],
    linked: { id: 3, name: 'Shop' },
  };
  const team = { ...connected, desktopUrl: 'http://127.0.0.1:3000' };
  team.contexts = [{ ...connected.contexts[0]!, instance: { serverUrl: 'http://piwi', source: 'dotenv' } }];

  test('Connect offers the app, the instance the workspace names, and another one', () => {
    expect(connectChoices(team, desktop, null)).toEqual([
      {
        target: 'desktop',
        label: '$(device-desktop) The Piwi desktop app',
        description: 'http://127.0.0.1:3000',
        detail: 'Runs on this machine; this folder is linked there to the project Shop.',
        serverUrl: null,
      },
      {
        target: 'instance',
        label: '$(server) http://piwi',
        description: 'in use',
        detail: 'From the workspace .env.',
        serverUrl: 'http://piwi',
      },
      {
        target: 'other',
        label: '$(globe) Another instance…',
        description: '',
        detail: 'A Piwi server, by its address.',
        serverUrl: null,
      },
    ]);
  });

  test('with the app in use, Connect still offers the instance to go back to', () => {
    const onDesktop: StatusResult = {
      ...team,
      contexts: [{ ...team.contexts[0]!, serverUrl: 'http://127.0.0.1:3000', source: 'desktop' }],
    };
    const [app, instance] = connectChoices(onDesktop, desktop, null);
    expect(app).toMatchObject({ description: 'http://127.0.0.1:3000 · in use' });
    expect(instance).toMatchObject({ target: 'instance', serverUrl: 'http://piwi', description: '' });
    // Only saved in the settings: offered from there.
    const saved = { ...onDesktop, contexts: [{ ...onDesktop.contexts[0]!, instance: null }] };
    expect(connectChoices(saved, desktop, 'https://piwi.corp')[1]).toMatchObject({
      serverUrl: 'https://piwi.corp',
      detail: 'From the Piwi settings.',
    });
  });

  test('the status bar says when the app runs unused, or was chosen and does not run', () => {
    expect(statusBarView(team, run({})).tooltip).toMatch(/desktop app runs on this machine: Piwi: Connect to use it/);
    expect(statusBarView(connected, run({}), true).tooltip).toMatch(/chosen with Piwi: Connect, is not running/);
    expect(statusBarView(connected, run({})).tooltip).not.toMatch(/desktop/);
  });
});

describe('the coverage marks of a file', () => {
  const mapped: CoverageResult = {
    uri: 'file:///shop/src/Web/Services/BasketService.cs',
    state: 'mapped',
    executed: [
      { start: 8, end: 9, tests: 2 },
      { start: 17, end: 30, tests: 1 },
    ],
    notRun: [{ start: 11, end: 11 }],
    changed: [{ start: 13, end: 13 }],
    tests: 2,
    executedLines: 6,
    executableLines: 7,
    blob: 'a'.repeat(40),
    label: '6 of 7 lines run by 2 tests · 1 line changed since the coverage run',
  };

  test('are the lines run, not run and changed since the coverage run, within the file', () => {
    expect(coverageDecorations(mapped, 20, true)).toEqual({
      run: [
        { start: 8, end: 9 },
        { start: 17, end: 19 },
      ],
      notRun: [{ start: 11, end: 11 }],
      changed: [{ start: 13, end: 13 }],
    });
    // Lines past the end of the file as it stands now are not drawn.
    expect(coverageDecorations(mapped, 10, true).run).toEqual([{ start: 8, end: 9 }]);
  });

  test('are none while hidden, and none for a file whose coverage marks no line', () => {
    const none = { run: [], notRun: [], changed: [] };
    expect(coverageDecorations(mapped, 20, false)).toEqual(none);
    expect(coverageDecorations(null, 20, true)).toEqual(none);
    const other = { ...mapped, state: 'other-version' as const, executed: [], notRun: [], changed: [], blob: null };
    expect(coverageDecorations(other, 20, true)).toEqual(none);
    expect(hasCoverageMarks(mapped)).toBe(true);
    expect(hasCoverageMarks(other)).toBe(false);
    expect(hasCoverageMarks({ ...other, state: 'none' })).toBe(false);
  });

  test('are read in C# files too', () => {
    expect(DOCUMENT_PATTERN).toMatch(/[{,]cs[,}]/);
    expect(DOCUMENT_PATTERN).toContain('cshtml');
    expect(DOCUMENT_PATTERN).toContain('razor');
  });
});

describe('the tests of a file', () => {
  test('are drawn with their latest result, a failing one over its whole body', () => {
    expect(
      testDecorations([
        { line: 0, title: '2 tests in Piwi' },
        {
          line: 3,
          title: 'passed 1/4 · failed',
          status: 'failed',
          endLine: 6,
          failure: {
            line: 5,
            headline: 'not found',
            message: null,
            executionId: 90,
            url: 'http://piwi/test-run-cases/90',
          },
          command: {
            title: 'Open in dashboard',
            command: 'piwi.openInDashboard',
            arguments: ['http://piwi/test-cases/9'],
          },
        },
        { line: 8, title: 'passed 4/4', status: 'passed', endLine: 10 },
      ]),
    ).toEqual([
      {
        status: 'failed',
        line: 3,
        failingUntil: 6,
        failingLine: 5,
        hover: '**Piwi**: failing · passed 1/4 · failed',
        dashboardUrl: 'http://piwi/test-cases/9',
      },
      {
        status: 'passed',
        line: 8,
        failingUntil: null,
        failingLine: null,
        hover: '**Piwi**: passing · passed 4/4',
        dashboardUrl: null,
      },
    ]);
  });

  test('a test the run in progress runs shows it, without a tint', () => {
    expect(testDecorations([{ line: 2, title: 'passed 4/4', status: 'running', endLine: 4 }])).toEqual([
      {
        status: 'running',
        line: 2,
        failingUntil: null,
        failingLine: null,
        hover: '**Piwi**: running · passed 4/4',
        dashboardUrl: null,
      },
    ]);
  });

  test('a failing test whose failing line changed since the run keeps its tint, and its hover says so', () => {
    const failure = {
      line: 5,
      headline: 'not found',
      message: null,
      executionId: 90,
      url: 'http://piwi/test-run-cases/90',
    };
    const [edited] = testDecorations([
      { line: 3, title: 'passed 1/4 · failed', status: 'failed', endLine: 6, failure: { ...failure, state: 'edited' } },
    ]);
    expect(edited).toMatchObject({ status: 'failed', failingUntil: 6, failingLine: 5 });
    expect(edited!.hover).toBe('**Piwi**: failing · edited since the run · passed 1/4 · failed');
    const [failing] = testDecorations([
      {
        line: 3,
        title: 'passed 1/4 · failed',
        status: 'failed',
        endLine: 6,
        failure: { ...failure, state: 'failing' },
      },
    ]);
    expect(failing!.hover).toBe('**Piwi**: failing · passed 1/4 · failed');
  });

  test('a test’s hover shows the instance’s text as written', () => {
    const [test] = testDecorations([
      {
        line: 2,
        title: 'passed 3/4 · flaky score 40 · [timing](command:piwi.openInDashboard) · in __smoke__',
        status: 'flaky',
      },
    ]);
    expect(test!.hover).toBe(
      '**Piwi**: flaky · passed 3/4 · flaky score 40 · \\[timing\\](command:piwi.openInDashboard) · in \\_\\_smoke\\_\\_',
    );
  });

  test('the status bar says when the checked-out branch has no run yet', () => {
    const onMain: RunStatusResult = {
      contexts: [{ ...run({}).contexts[0]!, branch: 'main', checkedOut: 'feature/cart' }],
    };
    expect(statusBarView(connected, onMain).tooltip).toMatch(
      /^Run #41 of Acme on main \(feature\/cart has no run yet\)/,
    );
    expect(statusBarView(connected, run({})).tooltip).not.toMatch(/no run yet/);
  });
});

describe('Compare with…', () => {
  const at = (baseline: NonNullable<RunStatusResult['contexts'][number]['baseline']>): RunStatusResult => ({
    contexts: [{ ...run({}).contexts[0]!, branch: 'main', checkedOut: 'feature/cart', baseline }],
  });

  test('offers the ladder, the default branch and the branches with runs, a run by id and the local runs', () => {
    const picks = baselinePicks({ ...run({}).contexts[0]!, branches: ['main', 'feature/x'] });
    expect(picks.map((p) => [p.label, p.description])).toEqual([
      ['CI on the checked-out branch, else main (default)', 'current'],
      ['main', 'default branch'],
      ['feature/x', ''],
      ['A run by id…', ''],
      ['My local runs only', ''],
    ]);
    expect(picks.map((p) => p.choice)).toEqual([
      { kind: 'ladder' },
      { kind: 'branch', branch: 'main' },
      { kind: 'branch', branch: 'feature/x' },
      'run-by-id',
      { kind: 'local' },
    ]);
  });

  test('marks the choice in force, and keeps a chosen branch the list no longer names', () => {
    const picks = baselinePicks({
      ...run({}).contexts[0]!,
      branches: ['main'],
      baseline: { choice: { kind: 'branch', branch: 'release' }, label: 'release (no run)' },
    });
    expect(picks.map((p) => [p.label, p.description])).toEqual([
      ['CI on the checked-out branch, else main (default)', ''],
      ['main', 'default branch'],
      ['release', 'current'],
      ['A run by id…', ''],
      ['My local runs only', ''],
    ]);
    const byId = baselinePicks({
      ...run({}).contexts[0]!,
      baseline: { choice: { kind: 'run', runId: 118 }, label: 'CI run #118 on main' },
    });
    expect(byId[0]!.label).toBe('CI on the checked-out branch, else the default branch (default)');
    expect(byId.find((p) => p.choice === 'run-by-id')!.description).toBe('current: run #118');
  });

  test('keeps a choice per root, the ladder as none', () => {
    const kept = withBaseline({ '/a': { kind: 'local' } }, '/b', { kind: 'run', runId: 118 });
    expect(kept).toEqual({ '/a': { kind: 'local' }, '/b': { kind: 'run', runId: 118 } });
    expect(withBaseline(kept, '/a', { kind: 'ladder' })).toEqual({ '/b': { kind: 'run', runId: 118 } });
  });

  test('the tooltip names the baseline, and a chosen branch is not a fallback', () => {
    const view = statusBarView(
      connected,
      at({ choice: { kind: 'branch', branch: 'main' }, label: 'CI run #41 on main' }),
    );
    expect(view.tooltip).toMatch(/^Run #41 of Acme on main: 118 passed.*\n\nBaseline: CI run #41 on main\n\n/);
    expect(view.tooltip).not.toMatch(/no run yet/);
    expect(view.tooltip).toContain('[Compare with…](command:piwi.compareWith)');
  });

  test('a choice with no run says so', () => {
    const none: RunStatusResult = {
      contexts: [
        {
          root: '/w',
          branch: 'release',
          failures: 0,
          run: null,
          baseline: { choice: { kind: 'branch', branch: 'release' }, label: 'release (no run)' },
        },
      ],
    };
    expect(statusBarView(connected, none)).toMatchObject({
      text: '$(beaker) Piwi: no run',
      tooltip: expect.stringContaining('No run of Acme on release yet\n\nBaseline: release (no run)'),
    });
  });

  test('the local runs alone count their failures', () => {
    const local: RunStatusResult = {
      contexts: [
        {
          root: '/w',
          branch: 'main',
          failures: 2,
          failingTests: 1,
          overlays: 2,
          run: null,
          baseline: { choice: { kind: 'local' }, label: 'your local runs only' },
        },
      ],
    };
    expect(statusBarView(connected, local)).toMatchObject({
      text: '$(error) Piwi: 1 failing',
      tooltip: expect.stringMatching(/^2 local runs of Acme on main, 1 test failing\n\nBaseline: your local runs only/),
      error: true,
    });
  });
});

describe('desktopJobNotice', () => {
  const update = (patch: Partial<DesktopJobUpdate>): DesktopJobUpdate => ({
    jobId: 'f00d',
    kind: 'bisect',
    status: 'done',
    message: 'The bisect names c1c1c1c as the first bad commit.',
    share: null,
    ...patch,
  });

  test('offers the share button on a verdict that can be shared', () => {
    expect(desktopJobNotice(update({ share: { label: 'Share on piwi.example.com' } }))).toEqual({
      severity: 'information',
      text: 'Piwi: The bisect names c1c1c1c as the first bad commit.',
      actions: ['Share on piwi.example.com'],
    });
  });

  test('warns when the job ended without a verdict', () => {
    expect(desktopJobNotice(update({ status: 'declined', message: 'Declined.' })).severity).toBe('warning');
    expect(desktopJobNotice(update({ message: 'The desktop app could not bisect "t": npm ci failed' })).severity).toBe(
      'warning',
    );
    expect(desktopJobNotice(update({ status: 'running', message: 'Bisecting.' }))).toMatchObject({
      severity: 'information',
      actions: [],
    });
  });

  test("offers to share a Flake Lab run's results, and warns when the lab could not run", () => {
    const lab = { kind: 'flake-lab' as const, share: { label: 'Share on piwi.example.com' } };
    expect(desktopJobNotice(update({ ...lab, message: 'Flake Lab reproduced "t" at b0b0b0b.' }))).toEqual({
      severity: 'information',
      text: 'Piwi: Flake Lab reproduced "t" at b0b0b0b.',
      actions: ['Share on piwi.example.com'],
    });
    expect(
      desktopJobNotice(
        update({ kind: 'flake-lab', message: 'The desktop app could not run Flake Lab on "t": npm ci failed' }),
      ).severity,
    ).toBe('warning');
  });
});

const at = (line: number, character: number) => ({ line, character });
const span = (startLine: number, startCharacter: number, endLine: number, endCharacter: number): TextSpan => ({
  start: at(startLine, startCharacter),
  end: at(endLine, endCharacter),
});
const change = (range: TextSpan, text: string): TextChange => ({ range, text });
/** The service's edit inserting `newText` at the start of `line`. */
const insert = (line: number, newText: string): FileEdit => ({ range: span(line, 0, line, 0), newText });

/** Applies changes made in one edit to a text, as the editor does: at the same position, in the order given. */
function applied(text: string, changes: TextChange[]): string {
  const lines = text.split('\n');
  const offset = (p: { line: number; character: number }) =>
    lines.slice(0, p.line).reduce((n, l) => n + l.length + 1, 0) + p.character;
  return changes
    .map((c, i) => ({ c, i, start: offset(c.range.start), end: offset(c.range.end) }))
    .sort((a, b) => b.start - a.start || b.i - a.i)
    .reduce((out, { c, start, end }) => out.slice(0, start) + c.text + out.slice(end), text);
}

describe('the recorded block', () => {
  test('is the update’s code with every non-empty line indented', () => {
    expect(recordedBlockText("await page.goto('/');\n\nawait page.reload();", '    ')).toBe(
      "    await page.goto('/');\n\n    await page.reload();",
    );
    expect(recordedBlockText('', '  ')).toBe('');
  });

  test('starts at the line its placement names', () => {
    expect(placedBlock({ line: 4, newLine: true, indent: '  ' })).toEqual({ range: span(4, 0, 4, 0), first: 'insert' });
    expect(placedBlock({ line: 2, newLine: false, indent: '' })).toEqual({ range: span(2, 0, 2, 0), first: 'replace' });
  });
});

describe('following the recorded block', () => {
  // Lines 3 to 5, the last one 30 characters long.
  const block = span(3, 0, 5, 30);

  test('lines added or removed above move it', () => {
    expect(followBlock(block, change(span(1, 4, 1, 4), 'x'))).toEqual({ where: 'above', block });
    expect(followBlock(block, change(span(1, 0, 1, 0), 'one\ntwo\n'))).toEqual({
      where: 'above',
      block: span(5, 0, 7, 30),
    });
    // Enter at the end of the line above, and a line deleted with its line break.
    expect(followBlock(block, change(span(2, 12, 2, 12), '\n  ')).block).toEqual(span(4, 0, 6, 30));
    expect(followBlock(block, change(span(2, 0, 3, 0), ''))).toEqual({ where: 'above', block: span(2, 0, 4, 30) });
    // A line pasted at the start of the block's first line goes above it.
    expect(followBlock(block, change(span(3, 0, 3, 0), "await page.goto('/');\n"))).toEqual({
      where: 'above',
      block: span(4, 0, 6, 30),
    });
  });

  test('changes below leave it, Enter at the end of its last line included', () => {
    expect(followBlock(block, change(span(6, 0, 6, 0), 'x'))).toEqual({ where: 'below', block });
    expect(followBlock(block, change(span(5, 30, 5, 30), '\n  '))).toEqual({ where: 'below', block });
    expect(followBlock(block, change(span(5, 30, 5, 30), '\r\n  '))).toEqual({ where: 'below', block });
  });

  test('typing inside it changes it', () => {
    expect(followBlock(block, change(span(4, 6, 4, 6), 'abc'))).toEqual({ where: 'inside', block });
    expect(followBlock(block, change(span(4, 6, 4, 6), 'a\nb')).block).toEqual(span(3, 0, 6, 30));
    expect(followBlock(block, change(span(5, 30, 5, 30), ';'))).toEqual({ where: 'inside', block: span(3, 0, 5, 31) });
    expect(followBlock(block, change(span(3, 0, 3, 0), ' '))).toEqual({ where: 'inside', block: span(3, 0, 5, 30) });
  });

  test('an edit across one of its edges takes in what it wrote', () => {
    // Backspace at the start of its first line joins it to the line above.
    expect(followBlock(block, change(span(2, 9, 3, 0), ''))).toEqual({ where: 'inside', block: span(2, 9, 4, 30) });
    // Delete at the end of its last line joins the next line to it.
    expect(followBlock(block, change(span(5, 30, 6, 0), ''))).toEqual({ where: 'inside', block: span(3, 0, 5, 30) });
    expect(followBlock(block, change(span(1, 0, 4, 2), 'x'))).toEqual({ where: 'inside', block: span(1, 0, 2, 30) });
    // The whole block deleted, with its last line break: nothing left of it but its place.
    expect(followBlock(block, change(span(3, 0, 6, 0), ''))).toEqual({ where: 'inside', block: span(3, 0, 3, 0) });
  });
});

describe('where a recording writes', () => {
  test('outside every test, function and class, a new test; anywhere else, the steps there', () => {
    expect(recordInto('test')).toBe('steps');
    expect(recordInto('function')).toBe('steps');
    expect(recordInto('class')).toBe('steps');
    expect(recordInto('file')).toBe('test');
  });
});

describe('writing the recorded block', () => {
  const spec = [
    "import { test } from '@playwright/test';",
    '',
    "test('pays', async ({ page }) => {",
    "  await page.goto('/cart');",
    '});',
    '',
  ];
  const text = spec.join('\n');
  const steps = recordedBlockText(
    "await page.getByRole('button', { name: 'Pay' }).click();\nawait page.reload();",
    '  ',
  );

  test('the first write puts the block on a new line where the placement says', () => {
    const write = writeBlock(spec, placedBlock({ line: 4, newLine: true, indent: '  ' }), steps, null);
    expect(write.block).toEqual(span(4, 0, 5, 22));
    expect(applied(text, write.changes).split('\n')).toEqual([
      "import { test } from '@playwright/test';",
      '',
      "test('pays', async ({ page }) => {",
      "  await page.goto('/cart');",
      "  await page.getByRole('button', { name: 'Pay' }).click();",
      '  await page.reload();',
      '});',
      '',
    ]);
  });

  test('or in place of the blank line it names, unless something was typed there since', () => {
    const lines = ['a', '   ', 'b'];
    const write = writeBlock(lines, placedBlock({ line: 1, newLine: false, indent: '' }), 'one\ntwo', null);
    expect(applied(lines.join('\n'), write.changes)).toBe('a\none\ntwo\nb');
    expect(write.block).toEqual(span(1, 0, 2, 3));
    const typed = ['a', 'typed', 'b'];
    const kept = writeBlock(typed, placedBlock({ line: 1, newLine: false, indent: '' }), 'one', null);
    expect(applied(typed.join('\n'), kept.changes)).toBe('a\none\ntyped\nb');
  });

  test('a placement past the last line goes after it', () => {
    const write = writeBlock(['a', 'b'], placedBlock({ line: 2, newLine: true, indent: '' }), 'c', null);
    expect(applied('a\nb', write.changes)).toBe('a\nb\nc');
    expect(write.block).toEqual(span(2, 0, 2, 1));
  });

  test('later writes replace the block, and the service’s import edit goes in the same edit', () => {
    const lines = [...spec.slice(0, 4), ...steps.split('\n'), ...spec.slice(4)];
    const block: RecordedBlock = { range: span(4, 0, 5, 22), first: null };
    const next = recordedBlockText('const cartPage = new CartPage(page);\nawait cartPage.pay();', '  ');
    const write = writeBlock(lines, block, next, insert(1, "import { CartPage } from './pages/cart.page';\n"));
    expect(applied(lines.join('\n'), write.changes).split('\n')).toEqual([
      "import { test } from '@playwright/test';",
      "import { CartPage } from './pages/cart.page';",
      '',
      "test('pays', async ({ page }) => {",
      "  await page.goto('/cart');",
      '  const cartPage = new CartPage(page);',
      '  await cartPage.pay();',
      '});',
      '',
    ]);
    expect(write.block).toEqual(span(5, 0, 6, 23));
  });

  test('a whole file holds its imports itself', () => {
    const file = "import { test } from '@playwright/test';\nimport { CartPage } from './pages/cart.page';\n\ntest();";
    const write = writeBlock([''], placedBlock({ line: 0, newLine: false, indent: '' }), file, null);
    expect(write.changes).toEqual([change(span(0, 0, 0, 0), file)]);
    expect(write.block).toEqual(span(0, 0, 3, 7));
  });

  test('the block keeps lines of its own when an edit left other code on its first or last line', () => {
    const lines = ['before();', 'x = 1; old();', 'after();'];
    const block: RecordedBlock = { range: span(1, 7, 1, 13), first: null };
    const write = writeBlock(lines, block, 'one();', null);
    expect(applied(lines.join('\n'), write.changes)).toBe('before();\nx = 1; \none();\nafter();');
    expect(write.block).toEqual(span(2, 0, 2, 6));
    const emptied: RecordedBlock = { range: span(1, 0, 1, 0), first: null };
    expect(applied('a\nb', writeBlock(['a', 'b'], emptied, 'one', null).changes)).toBe('a\none\nb');
  });

  test('through a recording: written, moved by an edit above, then written again in its new place', () => {
    let lines = spec;
    let block = placedBlock({ line: 4, newLine: true, indent: '  ' });
    const first = writeBlock(lines, block, recordedBlockText('await page.reload();', '  '), null);
    lines = applied(lines.join('\n'), first.changes).split('\n');
    block = { range: first.block, first: null };
    const above = change(span(1, 0, 1, 0), '// the cart\n');
    lines = applied(lines.join('\n'), [above]).split('\n');
    block = { ...block, range: followBlock(block.range, above).block };
    const second = writeBlock(lines, block, steps, null);
    expect(applied(lines.join('\n'), second.changes).split('\n')).toEqual([
      "import { test } from '@playwright/test';",
      '// the cart',
      '',
      "test('pays', async ({ page }) => {",
      "  await page.goto('/cart');",
      "  await page.getByRole('button', { name: 'Pay' }).click();",
      '  await page.reload();',
      '});',
      '',
    ]);
  });
});

describe('the import edit of an update', () => {
  const spec = ["import { test } from '@playwright/test';", '', "test('pays', async ({ page }) => {", '', '});'];

  test('on the first write, at the line the block goes on, goes above the block', () => {
    const write = writeBlock(
      spec,
      placedBlock({ line: 1, newLine: true, indent: '' }),
      'x();',
      insert(1, 'import a;\n'),
    );
    expect(applied(spec.join('\n'), write.changes).split('\n')).toEqual([
      "import { test } from '@playwright/test';",
      'import a;',
      'x();',
      '',
      "test('pays', async ({ page }) => {",
      '',
      '});',
    ]);
    expect(write.block).toEqual(span(2, 0, 2, 4));
  });

  test('inside the range the block replaces, it is left out', () => {
    const lines = ['a', '  one();', '  two();', 'b'];
    const block: RecordedBlock = { range: span(1, 0, 2, 8), first: null };
    const write = writeBlock(lines, block, '  three();', insert(2, 'import a;\n'));
    expect(write.changes).toHaveLength(1);
    expect(importChange(null)).toBeNull();
  });

  test('a write made again follows it through the changes made meanwhile', () => {
    const edit = insert(1, 'import a;\n');
    expect(followEdit(edit, [change(span(0, 0, 0, 0), '// head\n')]).range).toEqual(span(2, 0, 2, 0));
    expect(followEdit(edit, [change(span(3, 0, 3, 0), 'x();\n')]).range).toEqual(span(1, 0, 1, 0));
  });
});

describe('the recording’s controls', () => {
  test('say its state and step count, with Stop and Pause or Resume', () => {
    expect(recordingView('recording', 6, false, 'checkout.spec.ts')).toEqual({
      title: '$(record) Recording · 6 steps',
      actions: [
        { title: 'Stop', command: 'piwi.stopRecording' },
        { title: 'Pause', command: 'piwi.pauseRecording' },
      ],
      status: '$(record) Piwi: recording · 6 steps',
      tooltip: 'Recording into checkout.spec.ts. Click to stop.',
    });
    expect(recordingView('paused', 1, false, 'a.spec.ts')).toMatchObject({
      title: '$(debug-pause) Paused · 1 step',
      actions: [
        { title: 'Stop', command: 'piwi.stopRecording' },
        { title: 'Resume', command: 'piwi.resumeRecording' },
      ],
    });
    expect(recordingView('starting', 0, false, 'a.spec.ts').actions).toEqual([
      { title: 'Stop', command: 'piwi.stopRecording' },
    ]);
  });

  test('an edit in the block pauses it, with Resume and Keep my edits', () => {
    expect(recordingView('recording', 2, true, 'a.spec.ts')).toMatchObject({
      title: '$(debug-pause) Paused while you edit · 2 steps',
      actions: [
        { title: 'Resume', command: 'piwi.resumeRecording' },
        { title: 'Keep my edits', command: 'piwi.stopRecording' },
      ],
    });
  });

  test('once stopped, a notification counts the steps and the warnings', () => {
    const step = { words: 'Click Pay', line: 0, locators: [], chosen: null };
    const warning = { step: 0, line: 0, message: 'Brittle locator' };
    expect(recordingSummary({ steps: [step, step], warnings: [warning], message: null }, false)).toBe(
      'Piwi: recording stopped, 2 steps written, 1 warning to check.',
    );
    expect(recordingSummary({ steps: [step], warnings: [], message: 'The browser was closed' }, false)).toBe(
      'Piwi: The browser was closed. 1 step written.',
    );
    expect(recordingSummary({ steps: [step], warnings: [], message: null }, true)).toBe(
      'Piwi: recording stopped. The recorded block keeps your edits.',
    );
  });
});

describe('a new test file', () => {
  test('goes in the folder the Playwright config tests', () => {
    expect(configTestDir("export default defineConfig({\n  testDir: './e2e',\n  use: {} });")).toBe('./e2e');
    expect(configTestDir('export default defineConfig({ testDir: path.join(__dirname, "e2e") });')).toBeNull();
  });

  test('is named after the test files around it', () => {
    expect(newTestFileName('/w/tests/cart.test.js')).toBe('recorded.test.js');
    expect(newTestFileName('/w/playwright.config.mjs')).toBe('recorded.spec.js');
    expect(newTestFileName('/w/playwright.config.ts')).toBe('recorded.spec.ts');
    expect(newTestFileName(null)).toBe('recorded.spec.ts');
  });
});

describe('the failures view', () => {
  const now = Date.parse('2026-09-27T10:04:00.000Z');
  const base = { url: 'http://piwi/test-run-cases/1', hasTrace: false, isNew: false } as const;
  const failing = {
    ...base,
    uri: 'file:///w/tests/login.spec.ts',
    line: 41,
    title: 'logs in',
    headline: "getByRole('button') was not visible",
    executionId: 1,
    runId: 120,
    source: 'ci' as const,
    state: 'failing' as const,
    root: '/w/apps/shop',
    testCaseId: 7,
  };
  const leaf = (over: Partial<FailureTreeNode>): FailureTreeNode => ({
    key: 'failure:1',
    kind: 'failure',
    label: 'logs in',
    description: 'tests/login.spec.ts:42 · chromium · new',
    tooltip: ['logs in', "getByRole('button') was not visible", 'run #120', 'Owner: @team_auth'],
    note: null,
    icon: 'failing',
    expanded: false,
    url: 'http://piwi/test-run-cases/1',
    executionId: 1,
    children: [],
    ...over,
  });
  const result: FailuresResult = {
    items: [failing, { ...failing, executionId: 3, title: 'pays', state: 'edited', source: 'own', runId: 124 }],
    grouping: 'file',
    runLabel: 'Run #120 · CI · feature/x · 2 failing',
    failing: 2,
    rerun: [{ uri: failing.uri, root: '/w/apps/shop', testIds: [7] }],
    tree: [
      {
        key: 'run',
        kind: 'run',
        label: 'Run #120 · CI · feature/x · 2 failing',
        description: '',
        startTime: '2026-09-27T10:00:00.000Z',
        tooltip: [
          'Baseline: CI run #120 on feature/x',
          'Run #120 of feature/x: 6 passed, 3 failed, 0 flaky, 0 skipped',
        ],
        icon: 'run',
        expanded: true,
        url: 'http://piwi/test-runs/120',
        children: [
          {
            key: 'runs',
            kind: 'runs',
            label: 'Your runs since',
            description: '1 run',
            tooltip: ['The runs of feature/x since run #120, laid over it test by test'],
            icon: 'history',
            expanded: false,
            url: null,
            children: [
              {
                key: 'overlay:124',
                kind: 'overlay',
                label: '#124 · your run · 1 passed, 1 failed',
                description: '',
                startTime: '2026-09-27T10:02:00.000Z',
                tooltip: ['Run #124, your run: 1 passed, 1 failed of 2'],
                icon: 'failed',
                expanded: false,
                url: 'http://piwi/test-runs/124',
                children: [],
              },
            ],
          },
          {
            key: 'group:file:tests/login.spec.ts',
            kind: 'group',
            label: 'tests/login.spec.ts',
            description: '2 failing',
            tooltip: ['tests/login.spec.ts'],
            icon: 'file',
            expanded: true,
            url: null,
            children: [
              leaf({}),
              leaf({
                key: 'failure:3',
                label: 'pays',
                icon: 'edited',
                executionId: 3,
                note: 'edited since your run #124',
              }),
            ],
          },
        ],
      },
    ],
  };

  test('draws the service’s tree: ages after the descriptions, codicons, and what opens each node', () => {
    const [root] = failureNodes(result, { now });
    expect(root).toMatchObject({
      key: 'run',
      kind: 'run',
      label: 'Run #120 · CI · feature/x · 2 failing',
      description: '4 min ago',
      icon: 'beaker',
      state: 'expanded',
      url: 'http://piwi/test-runs/120',
    });
    const [runs, group] = root!.children;
    expect(runs).toMatchObject({ icon: 'history', state: 'collapsed', description: '1 run' });
    expect(runs!.children[0]).toMatchObject({
      label: '#124 · your run · 1 passed, 1 failed',
      description: '2 min ago',
      icon: 'error',
      state: 'none',
    });
    expect(group).toMatchObject({ icon: 'file', state: 'expanded', description: '2 failing' });
    const [first, edited] = group!.children;
    expect(first).toMatchObject({ kind: 'failure', icon: 'error', state: 'none', failure: failing });
    expect(edited).toMatchObject({ icon: 'edit', failure: { executionId: 3, state: 'edited' } });
  });

  test('a hover is the service’s lines as Markdown, a failure’s title in bold', () => {
    const [root] = failureNodes(result, { now });
    expect(root!.tooltip).toBe(
      'Baseline: CI run #120 on feature/x\n\nRun #120 of feature/x: 6 passed, 3 failed, 0 flaky, 0 skipped',
    );
    expect(root!.children[1]!.children[0]!.tooltip).toBe(
      "**logs in**\n\ngetByRole('button') was not visible\n\nrun #120\n\nOwner: @team\\_auth",
    );
  });

  test('while the editor’s own run is live, the run counts it', () => {
    const live: LiveRun = {
      runId: 125,
      status: 'running',
      done: 4,
      total: 9,
      failed: 1,
      startedAt: '2026-09-27T10:03:00.000Z',
      own: true,
    };
    const [root] = failureNodes(result, { now, live });
    expect(root!.description).toBe('running 4/9');
    expect(root!.tooltip).toMatch(/\n\nYour run #125 is running: 4\/9$/);
    expect(failureNodes(result, { now, live: { ...live, own: false } })[0]!.description).toBe('4 min ago');
  });

  test('without a tree, nothing', () => {
    expect(failureNodes(null)).toEqual([]);
    expect(failureNodes({ ...result, tree: [] })).toEqual([]);
  });

  test('Run this test names the failure’s config', () => {
    expect(failureRunArgs({ ...failing, root: '/w/apps/admin', uri: 'file:///w/shared/pages/admin.ts' })).toEqual({
      uri: 'file:///w/shared/pages/admin.ts',
      root: '/w/apps/admin',
      testIds: [7],
    });
  });
});

describe('the verdict of a run started from the editor', () => {
  const ended: RunEnded = {
    root: '/w',
    runId: 124,
    url: 'http://piwi/test-runs/124',
    passed: 1,
    failed: 2,
    flaky: 0,
    skipped: 0,
    fixed: 1,
    stillFailing: ['login.spec.ts › logs in', 'checkout.spec.ts › pays'],
    newFailures: [],
    stillFailingCount: 2,
    newFailureCount: 0,
  };

  test('says how many CI failures it fixed and names those still failing, with Re-run failing', () => {
    expect(runVerdict(ended)).toEqual({
      severity: 'warning',
      text: 'Piwi: run #124 · 1 of 3 CI failures fixed, 2 still failing (login.spec.ts › logs in, checkout.spec.ts › pays)',
      actions: ['Open the failures', 'Open in dashboard', 'Re-run failing'],
    });
  });

  test('names its new failures, and how many more past the first five', () => {
    const titles = ['a.spec.ts › 1', 'a.spec.ts › 2', 'a.spec.ts › 3', 'a.spec.ts › 4', 'a.spec.ts › 5'];
    const verdict = runVerdict({
      ...ended,
      fixed: 0,
      stillFailing: [],
      stillFailingCount: 0,
      newFailures: titles,
      newFailureCount: 7,
    });
    expect(verdict?.text).toBe(`Piwi: run #124 · 7 new failures (${titles.join(', ')} and 2 more)`);
  });

  test('a run that fixed everything it ran is an information, without Re-run failing', () => {
    expect(runVerdict({ ...ended, failed: 0, passed: 3, stillFailing: [], stillFailingCount: 0 })).toEqual({
      severity: 'information',
      text: 'Piwi: run #124 · 1 of 1 CI failure fixed',
      actions: ['Open the failures', 'Open in dashboard'],
    });
  });

  test('a run that touched no failure gives its counts', () => {
    const quiet = { ...ended, fixed: 0, stillFailing: [], stillFailingCount: 0, passed: 4, failed: 0, flaky: 1 };
    expect(runVerdict(quiet)?.text).toBe('Piwi: run #124 · 4 passed, 0 failed, 1 flaky');
  });

  test('the setting keeps it quiet: always, only when something fails, or never', () => {
    const passing = { ...ended, failed: 0, stillFailing: [], stillFailingCount: 0 };
    expect(runVerdict(passing, 'failures')).toBeNull();
    expect(runVerdict(ended, 'failures')).not.toBeNull();
    expect(runVerdict(ended, 'never')).toBeNull();
  });
});

describe('a locator picked at a breakpoint', () => {
  const at = { file: 'tests/login.spec.ts', line: 42 };

  test('says where it went', () => {
    expect(pickNotice(at, 'replaced')).toBe('Piwi: the picked locator replaced the one at line 42 of login.spec.ts.');
    expect(pickNotice(at, 'no-locator')).toBe(
      'Piwi: the picked locator was inserted at the cursor: line 42 of login.spec.ts holds no locator anymore.',
    );
    expect(pickNotice(at, 'no-file')).toBe(
      'Piwi: the picked locator was inserted at the cursor: tests/login.spec.ts is not in this workspace.',
    );
  });
});

describe('calls coalesced into one', () => {
  test('the calls made before the scheduled run join it, and a call after it schedules the next', () => {
    const runs: Array<() => void> = [];
    let drawn = 0;
    const draw = coalesced(
      () => drawn++,
      (run) => runs.push(run),
    );
    draw();
    draw();
    draw();
    expect(runs).toHaveLength(1);
    expect(drawn).toBe(0);
    runs[0]();
    expect(drawn).toBe(1);
    draw();
    expect(runs).toHaveLength(2);
    runs[1]();
    expect(drawn).toBe(2);
  });
});

describe('the environment the editor service starts with', () => {
  const env = { PATH: '/usr/bin', NODE_EXTRA_CA_CERTS: '/etc/ssl/corp.pem' };

  test('is the editor’s, with Node reading its proxy variables', () => {
    expect(serviceEnvironment({}, { ...env, https_proxy: 'http://shell:3128' })).toEqual({
      ...env,
      https_proxy: 'http://shell:3128',
      NODE_USE_ENV_PROXY: '1',
    });
    expect(serviceEnvironment({ proxy: ' ', noProxy: [], proxyStrictSSL: true }, env)).toEqual({
      ...env,
      NODE_USE_ENV_PROXY: '1',
    });
  });

  test('the editor’s proxy replaces the environment’s, for http and https alike', () => {
    const shell = { ...env, https_proxy: 'http://shell:3128', http_proxy: 'http://shell:3128' };
    expect(serviceEnvironment({ proxy: ' http://proxy.corp:3128 ' }, shell)).toEqual({
      ...env,
      NODE_USE_ENV_PROXY: '1',
      HTTPS_PROXY: 'http://proxy.corp:3128',
      HTTP_PROXY: 'http://proxy.corp:3128',
    });
  });

  test('a Basic authorization goes in the proxy’s URL as its credentials, encoded', () => {
    const basic = `Basic ${Buffer.from('ann:p@ss:w0rd').toString('base64')}`;
    const made = serviceEnvironment({ proxy: 'http://proxy.corp:3128', proxyAuthorization: basic }, {});
    expect(made.HTTPS_PROXY).toBe('http://ann:p%40ss%3Aw0rd@proxy.corp:3128/');
    expect(made.HTTP_PROXY).toBe(made.HTTPS_PROXY);
  });

  test('another authorization, or a URL with credentials of its own, leaves the URL as given', () => {
    const basic = `Basic ${Buffer.from('ann:secret').toString('base64')}`;
    const negotiate = { proxy: 'http://proxy.corp:3128', proxyAuthorization: 'Negotiate YIIBxg==' };
    expect(serviceEnvironment(negotiate, {}).HTTPS_PROXY).toBe('http://proxy.corp:3128');
    const own = { proxy: 'http://bob:pw@proxy.corp:3128', proxyAuthorization: basic };
    expect(serviceEnvironment(own, {}).HTTPS_PROXY).toBe('http://bob:pw@proxy.corp:3128');
  });

  test('names the hosts reached without the proxy, and leaves certificates unverified only when asked', () => {
    const made = serviceEnvironment(
      { proxy: 'http://proxy.corp:3128', noProxy: [' localhost', '.corp', ''], proxyStrictSSL: false },
      { ...env, no_proxy: 'shell' },
    );
    expect(made.NO_PROXY).toBe('localhost,.corp');
    expect(made.no_proxy).toBeUndefined();
    expect(made.NODE_TLS_REJECT_UNAUTHORIZED).toBe('0');
    expect(serviceEnvironment({ proxyStrictSSL: true }, env).NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined();
  });
});
