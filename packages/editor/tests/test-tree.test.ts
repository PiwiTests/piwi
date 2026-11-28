import { describe, expect, test } from 'vitest';
import type { TestTreeNode, TreeTest } from '../src/protocol';
import { CONFIG_NODE } from '../src/protocol';
import {
  configTree,
  folderFilter,
  locationArg,
  nodeRuns,
  NOT_IN_CHECKOUT,
  ONLY_NAMED,
  titlePattern,
  type TreeEntry,
  type TreeSpec,
} from '../src/test-tree';

const ROOT = '/w';

const tree = (fields: Partial<TreeTest>): TreeTest => ({
  title: 'pays',
  suite: [],
  line: 2,
  endLine: 4,
  location: 'tests/checkout.spec.ts:3',
  testCaseId: null,
  status: null,
  failure: null,
  url: null,
  tags: [],
  owner: null,
  quarantined: false,
  resultDurationMs: null,
  root: ROOT,
  uri: 'file:///w/tests/checkout.spec.ts',
  playwright: [],
  ...fields,
});

const entry = (fields: Partial<TreeTest>, suiteRanges: TreeEntry['suiteRanges'] = []): TreeEntry => ({
  test: tree(fields),
  suiteRanges,
});

/** Each node as `kind label id`, children indented. */
function shape(nodes: readonly TestTreeNode[], depth = 0): string[] {
  return nodes.flatMap((n) => [
    `${'  '.repeat(depth)}${n.kind} ${n.label}${n.runnable ? '' : ' (not runnable)'}`,
    ...shape(n.children, depth + 1),
  ]);
}

describe('a config’s tree', () => {
  test('folders, specs, describe blocks, tests, and a node per project of a test that runs in several', () => {
    const uri = 'file:///w/tests/cart/checkout.spec.ts';
    const nodes = configTree(
      ROOT,
      [
        {
          uri,
          file: 'tests/cart/checkout.spec.ts',
          entries: [
            entry(
              {
                uri,
                suite: ['checkout'],
                line: 3,
                endLine: 5,
                playwright: [
                  { project: 'chromium', id: 'c1' },
                  { project: 'firefox', id: 'f1' },
                ],
              },
              [{ start: 2, end: 9 }],
            ),
            entry({ uri, suite: ['checkout'], title: 'refunds', line: 6, endLine: 8 }, [{ start: 2, end: 9 }]),
          ],
        },
        { uri: 'file:///w/home.spec.ts', file: 'home.spec.ts', entries: [entry({ uri: 'file:///w/home.spec.ts' })] },
      ],
      [],
    );
    // In the files' order; the editors order siblings by `sortText`.
    expect(shape(nodes)).toEqual([
      'spec home.spec.ts',
      '  test pays',
      'folder tests',
      '  folder cart',
      '    spec checkout.spec.ts',
      '      describe checkout',
      '        test pays',
      '          project chromium',
      '          project firefox',
      '        test refunds',
    ]);
    const describe = nodes[1]!.children[0]!.children[0]!.children[0]!;
    expect(describe).toMatchObject({
      id: `spec\x1f${ROOT}\x1ftests/cart/checkout.spec.ts\x1echeckout`,
      uri,
      range: { start: 2, end: 9 },
    });
    const pays = describe.children[0]!;
    expect(pays).toMatchObject({
      id: `spec\x1f${ROOT}\x1ftests/cart/checkout.spec.ts\x1fcheckout\x1fpays`,
      range: { start: 3, end: 5 },
      test: { title: 'pays' },
    });
    expect(pays.children.map((p) => [p.id, p.project, p.range])).toEqual([
      [`${pays.id}\x1dchromium`, 'chromium', { start: 3, end: 5 }],
      [`${pays.id}\x1dfirefox`, 'firefox', { start: 3, end: 5 }],
    ]);
    // Folders before specs, a spec's content in the file's order.
    expect(nodes.map((n) => n.sortText)).toEqual(['1home.spec.ts', '0tests']);
    expect(describe.children.map((n) => n.sortText)).toEqual(['000003.00000', '000006.00001']);
  });

  test('tests of one line, as a loop gives them, in their order; two of one title told apart', () => {
    const nodes = configTree(
      ROOT,
      [
        {
          uri: 'file:///w/a.spec.ts',
          file: 'a.spec.ts',
          entries: [
            entry({ title: 'adds mug 1', line: 1 }),
            entry({ title: 'adds mug 2', line: 1 }),
            entry({ title: 'same', line: 3 }),
            entry({ title: 'same', line: 5 }),
          ],
        },
      ],
      [],
    );
    const tests = nodes[0]!.children;
    expect(tests.map((t) => [t.label, t.sortText])).toEqual([
      ['adds mug 1', '000001.00000'],
      ['adds mug 2', '000001.00001'],
      ['same', '000003.00002'],
      ['same', '000005.00003'],
    ]);
    expect(tests[3]!.id).toBe(`${tests[2]!.id}\x1f2`);
  });

  test('tells a describe block from a test of the same title beside it', () => {
    const nodes = configTree(
      ROOT,
      [
        {
          uri: 'file:///w/login.spec.ts',
          file: 'login.spec.ts',
          entries: [entry({ title: 'login', line: 1 }), entry({ title: 'with SSO', suite: ['login'], line: 5 })],
        },
      ],
      [],
    );
    const children = nodes[0]!.children;
    expect(children.map((n) => n.kind)).toEqual(['test', 'describe']);
    expect(new Set(children.map((n) => n.id)).size).toBe(2);
  });

  test('the catalog’s tests the checkout does not hold, last, by spec path then describe block, none runnable', () => {
    const nodes = configTree(
      ROOT,
      [{ uri: 'file:///w/a.spec.ts', file: 'a.spec.ts', entries: [entry({})] }],
      [
        { file: 'tests/gone.spec.ts', test: tree({ title: 'was deleted', uri: '', testCaseId: 9 }) },
        { file: 'a.spec.ts', test: tree({ title: 'renamed', suite: ['cart'], uri: '', testCaseId: 4 }) },
      ],
    );
    expect(shape(nodes)).toEqual([
      'spec a.spec.ts',
      '  test pays',
      `notInCheckout ${NOT_IN_CHECKOUT} (not runnable)`,
      '  spec a.spec.ts (not runnable)',
      '    describe cart (not runnable)',
      '      test renamed (not runnable)',
      '  spec tests/gone.spec.ts (not runnable)',
      '    test was deleted (not runnable)',
    ]);
    const group = nodes[1]!;
    expect(group.sortText > nodes[0]!.sortText).toBe(true);
    expect(group.children[1]!.children[0]).toMatchObject({ uri: null, range: null, test: { testCaseId: 9 } });
    // No node of the group shares an id with one of the checkout.
    expect(group.children[0]!.id).not.toBe(nodes[0]!.id);
  });
});

describe('the runs of the nodes picked', () => {
  const CART = 'file:///w/tests/cart/checkout.spec.ts';
  const MUGS = 'file:///w/tests/mugs.spec.ts';
  const two = [
    { project: 'chromium', id: 'c' },
    { project: 'firefox', id: 'f' },
  ];
  const nodes = configTree(
    ROOT,
    [
      {
        uri: CART,
        file: 'tests/cart/checkout.spec.ts',
        entries: [
          entry({ uri: CART, suite: ['checkout'], line: 3, playwright: two }, [{ start: 2, end: 9 }]),
          entry({ uri: CART, suite: ['checkout'], title: 'refunds', line: 6 }, [{ start: 2, end: 9 }]),
        ],
      },
      {
        uri: MUGS,
        file: 'tests/mugs.spec.ts',
        entries: [
          entry({ uri: MUGS, title: 'adds mug 1', line: 1 }),
          entry({ uri: MUGS, title: 'adds mug 10', line: 1 }),
          entry({ uri: MUGS, title: 'adds mug 2 (large)', line: 1 }),
        ],
      },
    ],
    [{ file: 'tests/gone.spec.ts', test: tree({ title: 'was deleted', uri: '' }) }],
  );
  const contexts = [{ root: ROOT, nodes }];
  const find = (pick: (n: TestTreeNode) => boolean, from: readonly TestTreeNode[] = nodes): TestTreeNode => {
    for (const n of from) {
      if (pick(n)) return n;
      const found = n.children.length ? find(pick, n.children) : undefined;
      if (found) return found;
    }
    return undefined as unknown as TestTreeNode;
  };
  const byLabel = (label: string) => find((n) => n.label === label);
  const runs = (picked: TestTreeNode[], excluded: TestTreeNode[] = []) =>
    nodeRuns(
      contexts,
      picked.map((n) => n.id),
      excluded.map((n) => n.id),
    ).map((r) => [r.all ? 'all' : r.locations.join(' '), r.projects.join(','), r.grep, r.grepInvert]);

  test('each node by the narrowest filter, in one run per config', () => {
    expect(runs([byLabel('tests'), byLabel('checkout.spec.ts'), byLabel('checkout'), byLabel('refunds')])).toEqual([
      [
        'tests/ tests/cart/checkout.spec.ts tests/cart/checkout.spec.ts:3 tests/cart/checkout.spec.ts:7',
        '',
        null,
        null,
      ],
    ]);
    expect(nodeRuns(contexts, [`${CONFIG_NODE}${ROOT}`])).toEqual([
      { root: ROOT, uri: null, locations: [], all: true, projects: [], grep: null, grepInvert: null },
    ]);
    // A folder's run names a spec of it, for the config.
    expect(nodeRuns(contexts, [byLabel('cart').id])[0]!.uri).toBe(CART);
  });

  test('a project’s node runs its test in that project alone, in a run of its own', () => {
    const pays = find((n) => n.kind === 'test' && n.label === 'pays');
    const firefox = pays.children[1]!;
    expect(runs([firefox, byLabel('refunds')])).toEqual([
      ['tests/cart/checkout.spec.ts:4', 'firefox', null, null],
      ['tests/cart/checkout.spec.ts:7', '', null, null],
    ]);
  });

  test('a test of a line that holds others runs by its spec’s name and title too, without those its title matches', () => {
    expect(runs([byLabel('adds mug 1')])).toEqual([
      ['tests/mugs.spec.ts:2', '', 'mugs.spec.ts( @[^ ]+)* adds mug 1', 'mugs.spec.ts( @[^ ]+)* adds mug 10'],
    ]);
    expect(runs([byLabel('adds mug 10')])).toEqual([
      ['tests/mugs.spec.ts:2', '', 'mugs.spec.ts( @[^ ]+)* adds mug 10', null],
    ]);
    expect(runs([byLabel('adds mug 2 (large)')])).toEqual([
      ['tests/mugs.spec.ts:2', '', 'mugs.spec.ts( @[^ ]+)* adds mug 2 [(]large[)]', null],
    ]);
    // The spec whole needs none.
    expect(runs([byLabel('mugs.spec.ts')])).toEqual([['tests/mugs.spec.ts', '', null, null]]);
  });

  test('a test of a line that holds others lets a describe block’s tags through, and runs with the others of its line when their titles cannot be told apart', () => {
    const LOOP = 'file:///w/tests/loop.spec.ts';
    const cart = [{ start: 1, end: 6 }];
    const loop = configTree(
      ROOT,
      [
        {
          uri: LOOP,
          file: 'tests/loop.spec.ts',
          entries: [
            entry({ uri: LOOP, suite: ['cart'], title: 'costs $5', line: 2 }, cart),
            entry({ uri: LOOP, suite: ['cart'], title: 'costs 15', line: 2 }, cart),
            entry({ uri: LOOP, suite: ['cart'], title: 'is a%b', line: 4 }, cart),
            entry({ uri: LOOP, suite: ['cart'], title: 'is a!b', line: 4 }, cart),
            entry({ uri: LOOP, suite: ['group 1'], title: 'x', line: 9 }, [{ start: 8, end: 10 }]),
            entry({ uri: LOOP, suite: ['group 2'], title: 'x', line: 9 }, [{ start: 8, end: 10 }]),
            entry({ uri: LOOP, suite: ['bag'], title: 'adds', line: 12 }, [{ start: 11, end: 13 }]),
            entry({ uri: LOOP, suite: ['bag @slow'], title: 'adds', line: 12 }, [{ start: 11, end: 13 }]),
          ],
        },
      ],
      [],
    );
    const pick = (suite: string, title: string, from: readonly TestTreeNode[] = loop): TestTreeNode[] =>
      from.flatMap((n) =>
        n.kind === 'test' && n.test!.title === title && n.test!.suite[0] === suite
          ? [n]
          : pick(suite, title, n.children),
      );
    const loopRuns = (suite: string, title: string) =>
      nodeRuns(
        [{ root: ROOT, nodes: loop }],
        pick(suite, title).map((n) => n.id),
      ).map((r) => [r.locations.join(' '), r.grep, r.grepInvert]);
    expect(loopRuns('cart', 'costs $5')).toEqual([
      [
        'tests/loop.spec.ts:3',
        'loop.spec.ts( @[^ ]+)* cart( @[^ ]+)* costs .5',
        'loop.spec.ts( @[^ ]+)* cart( @[^ ]+)* costs 15',
      ],
    ]);
    expect(loopRuns('cart', 'costs 15')).toEqual([
      ['tests/loop.spec.ts:3', 'loop.spec.ts( @[^ ]+)* cart( @[^ ]+)* costs 15', null],
    ]);
    expect(loopRuns('cart', 'is a%b')).toEqual([['tests/loop.spec.ts:5', null, null]]);
    // A describe block's title that ends in a tag, which the tag gap lets through, is left out.
    expect(loopRuns('bag', 'adds')).toEqual([
      [
        'tests/loop.spec.ts:13',
        'loop.spec.ts( @[^ ]+)* bag( @[^ ]+)* adds',
        'loop.spec.ts( @[^ ]+)* bag @slow( @[^ ]+)* adds',
      ],
    ]);
    expect(loopRuns('group 1', 'x')).toEqual([
      ['tests/loop.spec.ts:10', 'loop.spec.ts( @[^ ]+)* group 1( @[^ ]+)* x', null],
    ]);
  });

  test('a node holding an excluded one runs by its children’s filters; a node no run takes runs nothing', () => {
    expect(runs([byLabel('checkout.spec.ts')], [byLabel('refunds')])).toEqual([
      ['tests/cart/checkout.spec.ts:4', '', null, null],
    ]);
    const pays = find((n) => n.kind === 'test' && n.label === 'pays');
    expect(
      runs(
        [`${CONFIG_NODE}${ROOT}`].map((id) => ({ id }) as TestTreeNode),
        [pays.children[0]!],
      ),
    ).toEqual([
      ['tests/cart/checkout.spec.ts:4', 'firefox', null, null],
      ['tests/cart/checkout.spec.ts:7 tests/mugs.spec.ts', '', null, null],
    ]);
    expect(runs([byLabel(NOT_IN_CHECKOUT), byLabel('was deleted')])).toEqual([]);
    expect(nodeRuns(contexts, ['no such node'])).toEqual([]);
  });

  test('a run whose locations would make too long a command is split, never widened', () => {
    const many = configTree(
      ROOT,
      Array.from({ length: 400 }, (_, i) => ({
        uri: `file:///w/tests/a-rather-long-folder-name/spec-${i}.spec.ts`,
        file: `tests/a-rather-long-folder-name/spec-${i}.spec.ts`,
        entries: [entry({ line: 2 })],
      })),
      [],
    );
    const specs = many[0]!.children[0]!.children;
    const split = nodeRuns(
      [{ root: ROOT, nodes: many }],
      specs.map((n) => n.id),
    );
    expect(split.length).toBeGreaterThan(1);
    expect(split.flatMap((r) => r.locations)).toHaveLength(400);
    for (const run of split) expect(run.locations.join(' ').length).toBeLessThanOrEqual(8000);
    // A location counts as written, from the config's folder.
    const deep = '/w/プロジェクト my repository';
    const folders = configTree(
      deep,
      Array.from({ length: 200 }, (_, i) => ({
        uri: `file://${deep}/tests/folder-${i}/a.spec.ts`,
        file: `tests/folder-${i}/a.spec.ts`,
        entries: [entry({ line: 2, root: deep })],
      })),
      [],
    );
    const byFolder = nodeRuns(
      [{ root: deep, nodes: folders }],
      folders[0]!.children.map((n) => n.id),
    );
    expect(byFolder.flatMap((r) => r.locations)).toHaveLength(200);
    expect(byFolder.length).toBeGreaterThan(1);
    for (const run of byFolder) {
      const written = run.locations.reduce((sum, l) => sum + locationArg(deep, l).length + 3, 0);
      expect(written).toBeLessThanOrEqual(8000);
    }
  });

  test('a location by its whole path anchored at its start, and on Windows by its file: URL too', () => {
    /** Whether Playwright takes `file`, spelled as one of its versions tests it, for the location `arg`. */
    const takes = (arg: string, file: string) => new RegExp(arg.replace(/:\d+$/, ''), 'gi').test(file);
    // POSIX: the path alone.
    expect(folderFilter('/w/tests', false)).toBe('^/w/tests/.');
    expect(locationArg('/w', 'tests/', false)).toBe('^/w/tests/.');
    const cart = locationArg('/w', 'tests/cart.spec.ts:3', false);
    expect(cart).toBe('^/w/tests/cart.spec.ts:3');
    expect(takes(cart, '/w/tests/cart.spec.ts')).toBe(true);
    for (const other of ['/w/sub/tests/cart.spec.ts', '/w/xtests/cart.spec.ts', '/x/w/tests/cart.spec.ts']) {
      expect(takes(cart, other), other).toBe(false);
    }
    expect(takes(locationArg('/w', 'tests/', false), '/w/e2e-tests/a.spec.ts')).toBe(false);
    // Windows: the `/`-separated path (Playwright 1.63 on), or the `file:` URL (up to 1.62).
    const spaced = locationArg('C:\\w\\my repo', 'tests/my cart (1).spec.ts:3', true);
    expect(spaced).toBe(
      '^(?:C:/w/my repo/tests/my cart [(]1[)].spec.ts|file:///C:/w/my.20repo/tests/my.20cart.20[(]1[)].spec.ts):3',
    );
    expect(takes(spaced, 'C:/w/my repo/tests/my cart (1).spec.ts')).toBe(true);
    expect(takes(spaced, 'file:///C:/w/my%20repo/tests/my%20cart%20(1).spec.ts')).toBe(true);
    expect(takes(spaced, 'C:/w/my repo/e2e/tests/my cart (1).spec.ts')).toBe(false);
    expect(takes(spaced, 'C:\\w\\my repo\\tests\\my cart (1).spec.ts')).toBe(false);
    expect(locationArg('C:\\w', 'tests/panier é.spec.ts', true)).toBe(
      '^(?:C:/w/tests/panier é.spec.ts|file:///C:/w/tests/panier.20.C3.A9.spec.ts)',
    );
    expect(folderFilter('C:\\w\\tests', true)).toBe('^(?:C:/w/tests|file:///C:/w/tests)/.');
  });

  test('a title as --grep reads it, with no character a shell expands', () => {
    expect(titlePattern('pays (by card) $5 + 10% off!')).toBe('pays [(]by card[)] .5 [+] 10. off.');
    expect(titlePattern('a|b [c] {d} *e? ^f "g" \\h `i`')).toBe('a[|]b [[]c] [{]d[}] [*]e[?] .f .g. .h .i.');
  });
});

describe('the runs of projects with default: false', () => {
  const CART = 'file:///w/tests/cart.spec.ts';
  const BIG = 'file:///w/tests/slow/big.spec.ts';
  let ids = 0;
  /** A test's listed projects, each with an id of its own. */
  const pw = (...projects: string[]) => projects.map((project) => ({ project, id: `${project}#${ids++}` }));
  const checkout = [{ start: 3, end: 9 }];
  const specs: TreeSpec[] = [
    {
      uri: CART,
      file: 'tests/cart.spec.ts',
      entries: [
        entry({ uri: CART, title: 'adds', line: 1, playwright: pw('chromium') }),
        entry({ uri: CART, suite: ['checkout'], title: 'pays', line: 4, playwright: pw('chromium', 'slow') }, checkout),
        entry({ uri: CART, suite: ['checkout'], title: 'waits', line: 6, playwright: pw('slow') }, checkout),
      ],
    },
    {
      uri: BIG,
      file: 'tests/slow/big.spec.ts',
      entries: [
        entry({ uri: BIG, title: 'loads', line: 1, playwright: pw('slow', 'nightly') }),
        // Written since the listing: in its spec's projects.
        entry({ uri: BIG, title: 'new', line: 3 }),
      ],
    },
  ];
  /** The listed tests of `slow` and `nightly`, which run only when `--project` names them. */
  const onlyNamed = new Set(
    specs.flatMap((s) =>
      s.entries.flatMap((e) => e.test.playwright.filter((p) => p.project !== 'chromium').map((p) => p.id)),
    ),
  );
  const nodes = configTree(ROOT, specs, [], onlyNamed);
  const find = (label: string, from: readonly TestTreeNode[] = nodes): TestTreeNode | undefined => {
    for (const n of from) {
      if (n.label === label) return n;
      const found = find(label, n.children);
      if (found) return found;
    }
    return undefined;
  };
  const id = (label: string) => find(label)!.id;
  const runs = (picked: string[], excluded: string[] = [], named: ReadonlySet<string> | null = onlyNamed) =>
    nodeRuns([{ root: ROOT, nodes, ...(named ? { onlyNamed: named } : {}) }], picked, excluded).map(
      (r) => `${r.all ? 'all' : r.locations.join(' ')}${r.projects.map((p) => ` --project=${p}`).join('')}`,
    );

  test('a project’s node says it runs only with --project, and runs in it', () => {
    const pays = find('pays')!;
    expect(pays.children.map((n) => [n.label, n.project])).toEqual([
      ['chromium', 'chromium'],
      [`slow ${ONLY_NAMED}`, 'slow'],
    ]);
    expect(runs([pays.children[1]!.id])).toEqual(['tests/cart.spec.ts:5 --project=slow']);
  });

  test('a test of such projects alone runs with --project naming them; one of a default project too, as without', () => {
    expect(runs([id('waits')])).toEqual(['tests/cart.spec.ts:7 --project=slow']);
    expect(runs([id('loads')])).toEqual(['tests/slow/big.spec.ts:2 --project=nightly --project=slow']);
    expect(runs([id('new')])).toEqual(['tests/slow/big.spec.ts:4 --project=nightly --project=slow']);
    expect(runs([id('pays')])).toEqual(['tests/cart.spec.ts:5']);
    expect(runs([id('adds')])).toEqual(['tests/cart.spec.ts:2']);
  });

  test('a node of such tests alone runs with --project naming their projects', () => {
    expect(runs([id('big.spec.ts')])).toEqual(['tests/slow/big.spec.ts --project=nightly --project=slow']);
    expect(runs([id('slow')])).toEqual(['tests/slow/ --project=nightly --project=slow']);
  });

  test('a node holding both runs as Playwright does without --project, and the others apart in their projects', () => {
    expect(runs([id('checkout')])).toEqual(['tests/cart.spec.ts:4', 'tests/cart.spec.ts:7 --project=slow']);
    expect(runs([id('cart.spec.ts')])).toEqual(['tests/cart.spec.ts', 'tests/cart.spec.ts:7 --project=slow']);
    expect(runs([id('tests')])).toEqual([
      'tests/',
      'tests/cart.spec.ts:7 --project=slow',
      'tests/slow/ --project=nightly --project=slow',
    ]);
    expect(runs([`${CONFIG_NODE}${ROOT}`])).toEqual([
      'all',
      'tests/cart.spec.ts:7 --project=slow',
      'tests/slow/ --project=nightly --project=slow',
    ]);
    // Without the one that runs by default, the config runs in the projects its tests need.
    expect(runs([`${CONFIG_NODE}${ROOT}`], [id('adds'), id('pays')])).toEqual([
      'tests/cart.spec.ts:7 --project=slow',
      'tests/slow/ --project=nightly --project=slow',
    ]);
    expect(runs([`${CONFIG_NODE}${ROOT}`], [id('adds')])).toEqual([
      'tests/cart.spec.ts:4',
      'tests/cart.spec.ts:7 --project=slow',
      'tests/slow/ --project=nightly --project=slow',
    ]);
  });

  test('a config of such tests alone runs with --project naming every project they run in', () => {
    const listed = [{ project: 'slow', id: 'only' }];
    const slow = configTree(
      ROOT,
      [{ uri: BIG, file: 'tests/slow/big.spec.ts', entries: [entry({ uri: BIG, line: 1, playwright: listed })] }],
      [],
      new Set(['only']),
    );
    expect(nodeRuns([{ root: ROOT, nodes: slow, onlyNamed: new Set(['only']) }], [`${CONFIG_NODE}${ROOT}`])).toEqual([
      { root: ROOT, uri: null, locations: [], all: true, projects: ['slow'], grep: null, grepInvert: null },
    ]);
  });

  test('without the projects a listing names, every node runs as Playwright does without --project', () => {
    expect(runs([id('waits'), id('big.spec.ts'), `${CONFIG_NODE}${ROOT}`], [], null)).toEqual(['all']);
    expect(runs([id('waits'), id('big.spec.ts')], [], new Set())).toEqual([
      'tests/cart.spec.ts:7 tests/slow/big.spec.ts',
    ]);
  });

  test('a test of a project that runs only when named runs with --project, whatever other project shares its name', () => {
    const X = 'file:///w/a/x.spec.ts';
    const Y = 'file:///w/b/y.spec.ts';
    const shared = configTree(
      ROOT,
      [
        {
          uri: X,
          file: 'a/x.spec.ts',
          entries: [entry({ uri: X, title: 'x', line: 1, playwright: [{ project: 'e2e', id: 'x' }] })],
        },
        {
          uri: Y,
          file: 'b/y.spec.ts',
          entries: [entry({ uri: Y, title: 'y', line: 1, playwright: [{ project: 'e2e', id: 'y' }] })],
        },
      ],
      [],
      new Set(['y']),
    );
    const spec = (label: string) => find(label, shared)!.id;
    expect(
      nodeRuns([{ root: ROOT, nodes: shared, onlyNamed: new Set(['y']) }], [spec('x.spec.ts'), spec('y.spec.ts')]).map(
        (r) => [r.locations.join(' '), r.projects],
      ),
    ).toEqual([
      ['a/x.spec.ts', []],
      ['b/y.spec.ts', ['e2e']],
    ]);
  });

  test('a test of an unnamed project that runs only when named runs in a run of its own, with --project=', () => {
    const A = 'file:///w/tests/a.spec.ts';
    const V = 'file:///w/visual/v.spec.ts';
    const unnamed = configTree(
      ROOT,
      [
        {
          uri: A,
          file: 'tests/a.spec.ts',
          entries: [entry({ uri: A, title: 'adds', line: 1, playwright: [{ project: 'chromium', id: 'a' }] })],
        },
        {
          uri: V,
          file: 'visual/v.spec.ts',
          entries: [entry({ uri: V, title: 'looks', line: 1, playwright: [{ project: '', id: 'v' }] })],
        },
      ],
      [],
      new Set(['v']),
    );
    const picked = [find('a.spec.ts', unnamed)!.id, find('v.spec.ts', unnamed)!.id];
    expect(
      nodeRuns([{ root: ROOT, nodes: unnamed, onlyNamed: new Set(['v']) }], picked).map((r) => [
        r.locations.join(' '),
        r.projects,
      ]),
    ).toEqual([
      ['tests/a.spec.ts', []],
      ['visual/v.spec.ts', ['']],
    ]);
  });
});
