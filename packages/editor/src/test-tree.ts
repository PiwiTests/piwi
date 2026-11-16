/**
 * The test tree of one Playwright config (`piwi/testItems`): its folders, its specs, their describe blocks, their tests
 * and, for a test that runs in several Playwright projects, a node per project; then the catalog's tests that no test
 * of the checkout is, in the **Not in this checkout** group. Built from what the service read of each spec, whichever
 * source gave it (the listing or the spec's text), so a node's id stays as one source replaces the other.
 */
import type { TestTreeNode, TreeTest } from './protocol.js';

/** The label of the group of the catalog's tests that the checkout does not hold. */
export const NOT_IN_CHECKOUT = 'Not in this checkout';

/** A test of a spec, with the 0-based lines each of its describe blocks starts and ends on, where known. */
export interface TreeEntry {
  test: TreeTest;
  /** Aligned with `test.suite`; null for a block whose lines are not known. */
  suiteRanges: Array<{ start: number; end: number } | null>;
}

/** A spec of the config, relative to its folder with forward slashes. */
export interface TreeSpec {
  uri: string;
  file: string;
  entries: TreeEntry[];
}

/** A test of the catalog that no test of the checkout is, under its spec's stored path. */
export interface MissingTest {
  file: string;
  test: TreeTest;
}

/** A line as text that sorts in its order, then a position among the nodes of that line. */
function sortLine(line: number, index = 0): string {
  return `${String(line).padStart(6, '0')}.${String(index).padStart(5, '0')}`;
}

function node(fields: Partial<TestTreeNode> & Pick<TestTreeNode, 'id' | 'label' | 'kind' | 'sortText'>): TestTreeNode {
  return { uri: null, range: null, runnable: true, test: null, project: null, children: [], ...fields };
}

/**
 * The describe blocks and tests of one spec under `parent`, ids prefixed with `prefix`. Two tests of one title in the
 * same describe blocks are told apart by their order; a test that runs in several projects has a node per project.
 */
function addTests(parent: TestTreeNode, prefix: string, uri: string | null, entries: TreeEntry[], runnable: boolean) {
  const suites = new Map<string, TestTreeNode>();
  const seen = new Map<string, number>();
  entries.forEach(({ test, suiteRanges }, index) => {
    let at = parent;
    for (let i = 0; i < test.suite.length; i++) {
      const key = test.suite.slice(0, i + 1).join('\x1f');
      let suite = suites.get(key);
      const range = suiteRanges[i] ?? null;
      if (!suite) {
        // `\x1e`, not `\x1f`: a describe block and a test of the same title side by side are two nodes.
        suite = node({
          id: `${prefix}\x1e${key}`,
          label: test.suite[i]!,
          kind: 'describe',
          uri,
          range,
          sortText: sortLine(range?.start ?? test.line, index),
          runnable,
        });
        suites.set(key, suite);
        at.children.push(suite);
      } else if (!suite.range && range) suite.range = range;
      at = suite;
    }
    const key = [...test.suite, test.title].join('\x1f');
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    const id = `${prefix}\x1f${key}${count > 1 ? `\x1f${count}` : ''}`;
    const range = uri ? { start: test.line, end: test.endLine } : null;
    const testNode = node({
      id,
      label: test.title,
      kind: 'test',
      uri,
      range,
      sortText: sortLine(test.line, index),
      runnable,
      test,
    });
    if (test.playwright.length > 1) {
      testNode.children = test.playwright.map((p, i) =>
        node({
          // `\x1d`: no title holds it, so a project's node is never a test's.
          id: `${id}\x1d${p.project}`,
          label: p.project,
          kind: 'project',
          uri,
          range,
          sortText: sortLine(0, i),
          runnable: false,
          project: p.project,
        }),
      );
    }
    at.children.push(testNode);
  });
}

/** The tree of one config: its folders and specs, then the Not in this checkout group when it holds a test. */
export function configTree(root: string, specs: readonly TreeSpec[], missing: readonly MissingTest[]): TestTreeNode[] {
  const top: TestTreeNode[] = [];
  const folders = new Map<string, TestTreeNode>();
  /** The node a spec's folder is, created with the folders above it. */
  const folderOf = (parts: string[]): TestTreeNode[] => {
    let children = top;
    for (let i = 0; i < parts.length; i++) {
      const key = parts.slice(0, i + 1).join('/');
      let folder = folders.get(key);
      if (!folder) {
        folder = node({
          id: `folder\x1f${root}\x1f${key}`,
          label: parts[i]!,
          kind: 'folder',
          sortText: `0${parts[i]}`,
        });
        folders.set(key, folder);
        children.push(folder);
      }
      children = folder.children;
    }
    return children;
  };
  for (const spec of [...specs].sort((a, b) => a.file.localeCompare(b.file))) {
    const parts = spec.file.split('/');
    const name = parts.pop()!;
    const specNode = node({
      id: `spec\x1f${root}\x1f${spec.file}`,
      label: name,
      kind: 'spec',
      uri: spec.uri,
      sortText: `1${name}`,
    });
    addTests(specNode, specNode.id, spec.uri, spec.entries, true);
    folderOf(parts).push(specNode);
  }
  if (missing.length) {
    const group = node({
      id: `missing\x1f${root}`,
      label: NOT_IN_CHECKOUT,
      kind: 'notInCheckout',
      sortText: '2',
      runnable: false,
    });
    const byFile = new Map<string, TreeEntry[]>();
    for (const m of missing) byFile.set(m.file, [...(byFile.get(m.file) ?? []), { test: m.test, suiteRanges: [] }]);
    for (const [file, entries] of [...byFile].sort(([a], [b]) => a.localeCompare(b))) {
      const id = `${group.id}\x1f${file}`;
      const specNode = node({ id, label: file, kind: 'spec', sortText: `1${file}`, runnable: false });
      addTests(specNode, id, null, entries, false);
      group.children.push(specNode);
    }
    top.push(group);
  }
  return top;
}
