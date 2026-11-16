import { describe, expect, test } from 'vitest';
import type { TestTreeNode, TreeTest } from '../src/protocol';
import { CONFIG_NODE } from '../src/protocol';
import { configTree, nodeRuns, NOT_IN_CHECKOUT, titlePattern, type TreeEntry } from '../src/test-tree';

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

  test('a test of a line that holds others runs by its title too, without those whose title holds its own', () => {
    expect(runs([byLabel('adds mug 1')])).toEqual([['tests/mugs.spec.ts:2', '', 'adds mug 1', 'adds mug 10']]);
    expect(runs([byLabel('adds mug 10')])).toEqual([['tests/mugs.spec.ts:2', '', 'adds mug 10', null]]);
    expect(runs([byLabel('adds mug 2 (large)')])).toEqual([
      ['tests/mugs.spec.ts:2', '', 'adds mug 2 [(]large[)]', null],
    ]);
    // The spec whole needs none.
    expect(runs([byLabel('mugs.spec.ts')])).toEqual([['tests/mugs.spec.ts', '', null, null]]);
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
  });

  test('a title as --grep reads it, with no character a shell expands', () => {
    expect(titlePattern('pays (by card) $5 + 10% off!')).toBe('pays [(]by card[)] .5 [+] 10. off.');
    expect(titlePattern('a|b [c] {d} *e? ^f "g" \\h `i`')).toBe('a[|]b [[]c] [{]d[}] [*]e[?] .f .g. .h .i.');
  });
});
