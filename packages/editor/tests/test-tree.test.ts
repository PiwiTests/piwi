import { describe, expect, test } from 'vitest';
import type { TestTreeNode, TreeTest } from '../src/protocol';
import { configTree, NOT_IN_CHECKOUT, type TreeEntry } from '../src/test-tree';

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
      '          project chromium (not runnable)',
      '          project firefox (not runnable)',
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
