import { describe, expect, test } from 'vitest';
import { MAX_RUN_ID, parseBaselineChoice, runIdOf } from '../src/context';
import {
  failingCount,
  failureRunNote,
  failureTree,
  failuresAnswer,
  failuresDrawn,
  parseFailuresGrouping,
  rerunFailingArgs,
  runLabel,
  type ContextFailures,
} from '../src/failure-tree';
import type { FailuresResult, FailureTreeNode } from '../src/protocol';

const base = { url: 'http://piwi/test-run-cases/1', hasTrace: false, headline: 'Failed', isNew: false } as const;

const result: Pick<FailuresResult, 'items' | 'run' | 'overlays' | 'baseline'> = {
  items: [
    {
      ...base,
      uri: 'file:///w/tests/login.spec.ts',
      line: 41,
      title: 'logs in',
      headline: "getByRole('button') was not visible",
      executionId: 1,
      runId: 120,
      hasTrace: true,
      source: 'ci',
      state: 'failing',
      browserName: 'chromium',
      file: 'tests/login.spec.ts',
      testCaseId: 7,
      clusterId: 3,
      clusterTitle: 'Login button hidden',
      owner: '@team-auth',
      isNew: true,
      hasScreenshot: true,
    },
    {
      ...base,
      uri: 'file:///w/tests/login.spec.ts',
      line: 41,
      title: 'logs in',
      executionId: 2,
      runId: 120,
      source: 'ci',
      state: 'failing',
      browserName: 'firefox',
      file: 'tests/login.spec.ts',
      testCaseId: 7,
      clusterId: 3,
      clusterTitle: 'Login button hidden',
      owner: '@team-auth',
    },
    {
      ...base,
      uri: 'file:///w/tests/pages/checkout.page.ts',
      line: 4,
      title: 'pays',
      executionId: 3,
      runId: 124,
      source: 'own',
      state: 'edited',
      browserName: 'chromium',
      file: 'tests/checkout.spec.ts',
      testCaseId: 8,
      clusterId: null,
      owner: null,
    },
    {
      ...base,
      uri: 'file:///w/tests/checkout.spec.ts',
      line: 9,
      title: 'removes a row',
      headline: null,
      executionId: 4,
      runId: 124,
      source: 'own',
      state: 'fixed-locally',
      browserName: 'chromium',
      file: 'tests/checkout.spec.ts',
      testCaseId: 9,
    },
  ],
  run: {
    id: 120,
    branch: 'feature/x',
    status: 'failed',
    startTime: '2026-09-27T10:00:00.000Z',
    totalTests: 9,
    passedTests: 6,
    failedTests: 3,
    flakyTests: 0,
    skippedTests: 0,
    url: 'http://piwi/test-runs/120',
    origin: 'ci',
    own: false,
  },
  overlays: [
    {
      id: 124,
      origin: 'editor',
      startTime: '2026-09-27T10:02:00.000Z',
      status: 'failed',
      totalTests: 2,
      passedTests: 1,
      failedTests: 1,
      url: 'http://piwi/test-runs/124',
      own: true,
    },
  ],
};

const labels = (nodes: FailureTreeNode[]): unknown =>
  nodes.map((n) => (n.children.length ? [`${n.label} (${n.description})`, labels(n.children)] : n.label));

describe('the failures tree', () => {
  test('shows the run, the runs since, and the failures by file, failing first', () => {
    const [root] = failureTree(result, 'file');
    expect(root).toMatchObject({
      kind: 'run',
      label: 'Run #120 · CI · feature/x · 2 failing · 1 fixed locally',
      description: '',
      startTime: '2026-09-27T10:00:00.000Z',
      icon: 'run',
      expanded: true,
      url: 'http://piwi/test-runs/120',
    });
    expect(labels(root!.children)).toEqual([
      ['Your runs since (1 run)', ['#124 · your run · 1 passed, 1 failed']],
      ['tests/checkout.spec.ts (1 failing · 1 fixed locally)', ['pays', 'removes a row']],
      ['tests/login.spec.ts (1 failing)', ['logs in', 'logs in']],
    ]);
    expect(root!.children[0]).toMatchObject({ icon: 'history', expanded: false });
    expect(root!.children[0]!.children[0]).toMatchObject({
      kind: 'overlay',
      startTime: '2026-09-27T10:02:00.000Z',
      icon: 'failed',
      url: 'http://piwi/test-runs/124',
      tooltip: ['Run #124, your run: 1 passed, 1 failed of 2'],
    });
    expect(root!.children[1]).toMatchObject({ kind: 'group', icon: 'file', expanded: true });
  });

  test('the run names the baseline chosen; the local runs alone are the root without one', () => {
    const label = 'CI run #120 on feature/x';
    const [root] = failureTree({ ...result, baseline: { choice: { kind: 'ladder' }, label } }, 'file');
    expect(root!.tooltip).toEqual([
      'Baseline: CI run #120 on feature/x',
      'Run #120 of feature/x: 6 passed, 3 failed, 0 flaky, 0 skipped',
    ]);
    const local = { choice: { kind: 'local' as const }, label: 'your local runs only' };
    const [alone] = failureTree({ ...result, run: null, baseline: local }, 'file');
    expect(alone).toMatchObject({
      kind: 'run',
      label: 'Your local runs · 2 failing · 1 fixed locally',
      description: 'no baseline',
      startTime: null,
      tooltip: ['Baseline: your local runs only'],
      url: null,
    });
    expect(alone!.children.map((n) => n.label)).toEqual(['Your runs', 'tests/checkout.spec.ts', 'tests/login.spec.ts']);
  });

  test('a failure says where, on which project, and whether it is new, with its run in the tooltip', () => {
    const [root] = failureTree(result, 'flat');
    const [first, second, edited, fixed] = root!.children.slice(1);
    expect(first).toMatchObject({
      kind: 'failure',
      label: 'logs in',
      description: 'tests/login.spec.ts:42 · chromium · new',
      icon: 'failing',
      note: null,
      url: 'http://piwi/test-run-cases/1',
      executionId: 1,
    });
    expect(first!.tooltip).toEqual([
      'logs in',
      "getByRole('button') was not visible",
      'run #120',
      'Cluster: Login button hidden',
      'Owner: @team-auth',
    ]);
    expect(second!.description).toBe('tests/login.spec.ts:42 · firefox');
    // It shows in the page object its stack goes through.
    expect(edited).toMatchObject({
      icon: 'edited',
      description: 'checkout.page.ts:5 · chromium',
      note: 'edited since your run #124',
    });
    expect(fixed).toMatchObject({ icon: 'fixed', note: 'fixed locally in your run #124' });
    // A failure of a later CI run names it beside its title.
    const later = failureTree({ ...result, items: [{ ...result.items[0]!, runId: 125 }] }, 'flat')[0]!.children[1];
    expect(later!.note).toBe('run #125');
  });

  test('groups by cluster or owner, the failures without one last', () => {
    const [byCluster] = failureTree(result, 'cluster');
    expect(byCluster!.children.slice(1).map((g) => [g.label, g.description, g.icon])).toEqual([
      ['Login button hidden', '1 failing', 'cluster'],
      ['Ungrouped', '1 failing · 1 fixed locally', 'cluster'],
    ]);
    const [byOwner] = failureTree(result, 'owner');
    expect(byOwner!.children.slice(1).map((g) => g.label)).toEqual(['@team-auth', 'Unowned']);
  });

  test('without a failure, nothing; without a run, the groups alone', () => {
    expect(failureTree({ items: [], run: result.run }, 'file')).toEqual([]);
    const older = failureTree({ items: [{ ...result.items[0]!, file: undefined, testCaseId: undefined }] }, 'file');
    expect(older.map((n) => n.label)).toEqual(['login.spec.ts']);
    expect(failureTree({ items: result.items, overlays: result.overlays }, 'file').map((n) => n.kind)).toEqual([
      'group',
      'group',
    ]);
  });

  test('names the run with or without a failure', () => {
    expect(runLabel(result)).toBe('Run #120 · CI · feature/x · 2 failing · 1 fixed locally');
    expect(runLabel({ items: [], run: result.run })).toBe('Run #120 · CI · feature/x · 0 failing');
    expect(runLabel({ items: [], run: { ...result.run!, own: true, branch: null } })).toBe(
      'Run #120 · your run · 0 failing',
    );
    expect(runLabel({ items: result.items, run: null, overlays: result.overlays })).toBe(
      'Your local runs · 2 failing · 1 fixed locally',
    );
    expect(runLabel({ items: result.items })).toBeNull();
  });

  test('counts the failing tests, and re-runs them once per Playwright config', () => {
    expect(failingCount(result.items)).toBe(2);
    expect(rerunFailingArgs(result.items)).toEqual([{ uri: 'file:///w/tests/login.spec.ts', testIds: [7, 8] }]);
    expect(rerunFailingArgs([result.items[3]!])).toEqual([]);
    expect(rerunFailingArgs([])).toEqual([]);
    const [a, b] = result.items;
    const twoConfigs = [
      { ...a!, root: '/w/apps/shop' },
      { ...b!, root: '/w/apps/admin', uri: 'file:///w/shared/pages/admin.ts', testCaseId: 8 },
      { ...a!, root: '/w/apps/shop', testCaseId: 9 },
    ];
    expect(rerunFailingArgs(twoConfigs)).toEqual([
      { uri: a!.uri, root: '/w/apps/shop', testIds: [7, 9] },
      { uri: 'file:///w/shared/pages/admin.ts', root: '/w/apps/admin', testIds: [8] },
    ]);
  });

  test('a failure names its run', () => {
    const f = result.items[0]!;
    expect(failureRunNote(f)).toBe('run #120');
    expect(failureRunNote({ ...f, source: 'local', runId: 124 })).toBe('local run #124');
    expect(failureRunNote({ ...f, source: 'ci', state: 'fixed-locally', runId: 125 })).toBe('fixed in run #125');
    expect(failureRunNote({ ...f, source: 'local', state: 'fixed-locally', runId: 124 })).toBe(
      'fixed locally in run #124',
    );
  });

  test('what piwi/failures adds: the tree in its grouping, the run, the count and the re-run', () => {
    expect(failuresDrawn(result, 'owner')).toEqual({
      grouping: 'owner',
      tree: failureTree(result, 'owner'),
      runLabel: 'Run #120 · CI · feature/x · 2 failing · 1 fixed locally',
      failing: 2,
      rerun: rerunFailingArgs(result.items),
    });
    expect([parseFailuresGrouping('cluster'), parseFailuresGrouping('folder'), parseFailuresGrouping(null)]).toEqual([
      'cluster',
      null,
      null,
    ]);
  });
});

describe('the failures of several Playwright configs', () => {
  const shop: ContextFailures = {
    ...result,
    items: result.items.map((f) => ({ ...f, root: '/w' })),
    root: '/w',
    label: 'w',
    projectName: 'Shop',
    baseline: { choice: { kind: 'ladder' }, label: 'CI run #120 on feature/x' },
    updatedAt: '2026-09-27T10:05:00.000Z',
  };
  const admin: ContextFailures = {
    items: [
      {
        ...result.items[0]!,
        root: '/w/admin',
        executionId: 50,
        runId: 300,
        testCaseId: 70,
        file: 'tests/users.spec.ts',
      },
    ],
    run: { ...result.run!, id: 300, branch: 'main', url: 'http://piwi/test-runs/300' },
    overlays: [],
    root: '/w/admin',
    label: 'admin',
    projectName: 'Admin',
    updatedAt: '2026-09-27T10:07:00.000Z',
  };
  /** A config whose run fails nothing it holds. */
  const docs: ContextFailures = {
    items: [],
    run: { ...result.run!, id: 41, branch: 'main', failedTests: 0, url: 'http://piwi/test-runs/41' },
    overlays: [],
    root: '/w/docs',
    label: 'docs',
    projectName: 'Docs',
  };
  const idle: ContextFailures = { items: [], run: null, overlays: [], root: '/w/idle', label: 'idle' };

  test('one config with something to show: its tree as it stands, its run naming its config', () => {
    const answer = failuresAnswer([shop, idle], 'file');
    expect(answer).toEqual({
      items: shop.items,
      run: shop.run,
      overlays: shop.overlays,
      baseline: shop.baseline,
      updatedAt: '2026-09-27T10:05:00.000Z',
      ...failuresDrawn({ ...shop, root: '/w' }, 'file'),
    });
    expect(answer.tree.map((n) => [n.kind, n.key, n.root])).toEqual([['run', 'run', '/w']]);
    // Without one, nothing.
    expect(failuresAnswer([idle], 'file')).toEqual({ items: [], ...failuresDrawn({ items: [] }, 'file') });
  });

  test('several: one node per config, in their order, each over its own tree with its own counts', () => {
    const answer = failuresAnswer([shop, idle, admin, docs], 'file');
    expect(labels(answer.tree)).toEqual([
      [
        'w (Shop · 2 failing · 1 fixed locally)',
        [
          [
            'Run #120 · CI · feature/x · 2 failing · 1 fixed locally ()',
            [
              ['Your runs since (1 run)', ['#124 · your run · 1 passed, 1 failed']],
              ['tests/checkout.spec.ts (1 failing · 1 fixed locally)', ['pays', 'removes a row']],
              ['tests/login.spec.ts (1 failing)', ['logs in', 'logs in']],
            ],
          ],
        ],
      ],
      [
        'admin (Admin · 1 failing)',
        [['Run #300 · CI · main · 1 failing ()', [['tests/users.spec.ts (1 failing)', ['logs in']]]]],
      ],
      // Without a failure, its run alone.
      ['docs (Docs · 0 failing)', ['Run #41 · CI · main · 0 failing']],
    ]);
    const [first, second] = answer.tree;
    expect(first).toMatchObject({
      key: 'context:/w',
      kind: 'context',
      icon: 'context',
      expanded: true,
      url: 'http://piwi/test-runs/120',
      root: '/w',
      tooltip: [
        'Playwright config in /w',
        'Project: Shop',
        'Run #120 · CI · feature/x · 2 failing · 1 fixed locally',
        'Baseline: CI run #120 on feature/x',
      ],
    });
    // Each key under a config's node starts with its own: two configs never share one.
    expect(first!.children[0]).toMatchObject({
      key: 'context:/w\nrun',
      kind: 'run',
      root: '/w',
      startTime: shop.run!.startTime,
    });
    expect(first!.children[0]!.children[0]!.children[0]!.key).toBe('context:/w\noverlay:124');
    expect(second!.children[0]!.children[0]!.key).toBe('context:/w/admin\ngroup:file:tests/users.spec.ts');
    expect(second!.children[0]!.children[0]!.children[0]).toMatchObject({
      key: 'context:/w/admin\nfailure:50',
      executionId: 50,
    });
    // No run speaks for all of them: each node carries its own.
    expect(answer).not.toHaveProperty('run');
    expect(answer).not.toHaveProperty('overlays');
    expect(answer).not.toHaveProperty('baseline');
    expect(answer).toMatchObject({
      runLabel: null,
      failing: 3,
      updatedAt: '2026-09-27T10:07:00.000Z',
      rerun: [
        { uri: 'file:///w/tests/login.spec.ts', root: '/w', testIds: [7, 8] },
        { uri: 'file:///w/tests/login.spec.ts', root: '/w/admin', testIds: [70] },
      ],
    });
    expect(answer.items.map((f) => f.executionId)).toEqual([1, 2, 3, 4, 50]);
  });

  test('a config with runs laid over none, or failures without a run, has its node too', () => {
    const local: ContextFailures = {
      ...admin,
      run: null,
      overlays: result.overlays,
      baseline: { choice: { kind: 'local' }, label: 'your local runs only' },
    };
    const older: ContextFailures = { ...docs, run: null, items: [{ ...result.items[0]!, root: '/w/docs' }] };
    const tree = failuresAnswer([local, older], 'flat').tree;
    expect(labels(tree)).toEqual([
      [
        'admin (Admin · 1 failing)',
        [
          [
            'Your local runs · 1 failing (no baseline)',
            [['Your runs (1 run)', ['#124 · your run · 1 passed, 1 failed']], 'logs in'],
          ],
        ],
      ],
      ['docs (Docs · 1 failing)', ['logs in']],
    ]);
    expect(tree.map((n) => n.url)).toEqual([null, null]);
  });
});

describe('a run id typed for A run by id…', () => {
  test('is a whole number from 1 to the largest id a run of the instance can have, with or without its #', () => {
    expect([runIdOf('118'), runIdOf(' #118 '), runIdOf('#0042'), runIdOf('2147483647')]).toEqual([
      118,
      118,
      42,
      MAX_RUN_ID,
    ]);
    // Past a 32-bit run id, or 15 digits a number still holds exactly: not a run of the instance.
    expect([runIdOf('2147483648'), runIdOf('999999999999999'), runIdOf('1e3')]).toEqual([null, null, null]);
    expect([runIdOf('0'), runIdOf('-3'), runIdOf('run 118'), runIdOf('11 8'), runIdOf('')]).toEqual([
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  test('a stored baseline with a run id out of that range is refused', () => {
    expect(parseBaselineChoice({ kind: 'run', runId: 118 })).toEqual({ kind: 'run', runId: 118 });
    expect(parseBaselineChoice({ kind: 'run', runId: MAX_RUN_ID + 1 })).toBeNull();
    expect(parseBaselineChoice({ kind: 'run', runId: 0 })).toBeNull();
  });
});
