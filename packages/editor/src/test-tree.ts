/**
 * The test tree of one Playwright config (`piwi/testItems`): its folders, its specs, their describe blocks, their tests
 * and, for a test that runs in several Playwright projects, a node per project; then the catalog's tests that no test
 * of the checkout is, in the **Not in this checkout** group. Built from what the service read of each spec, whichever
 * source gave it (the listing or the spec's text), so a node's id stays as one source replaces the other.
 */
import { CONFIG_NODE, type TestTreeNode, type TreeTest } from './protocol.js';

/** The label of the group of the catalog's tests that the checkout does not hold. */
export const NOT_IN_CHECKOUT = 'Not in this checkout';

/** The id of a folder's node: its config's folder and its path. */
const folderId = (root: string, folder: string) => `folder\x1f${root}\x1f${folder}`;
/** The id of a spec's node: its config's folder and its path. */
const specId = (root: string, file: string) => `spec\x1f${root}\x1f${file}`;

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
          runnable,
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
          id: folderId(root, key),
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
      id: specId(root, spec.file),
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

/** A run of the nodes picked in the tree: the arguments of `piwi/runArgs` but the start options. */
export interface NodeRun {
  root: string;
  /** A spec of the run; null for a whole config, which `root` names. */
  uri: string | null;
  locations: string[];
  /** Every test of the config, in place of `locations`. */
  all: boolean;
  /** The projects it runs in alone; every project when empty. */
  projects: string[];
  grep: string | null;
  grepInvert: string | null;
}

/** The longest the locations of one run may be together: past it, the run is split (`cmd.exe` stops at 8,191). */
const MAX_LOCATIONS_CHARS = 8000;

/**
 * A title as Playwright's `--grep` reads it, a regular expression with no character a shell expands: a character a
 * regular expression reads apart in a class of its own (`[(]`), one a shell expands as `.`, as `specPattern` does a path.
 */
export function titlePattern(title: string): string {
  return title.replace(/[[(){}*+?|]/g, '[$&]').replace(/[$^`"%!\\“”„\p{Cc}]/gu, '.');
}

/** One node's filter. */
interface Filter {
  root: string;
  uri: string | null;
  /** Null for a whole config. */
  location: string | null;
  projects: string[];
  grep: string | null;
  grepInvert: string | null;
}

/**
 * The runs of the nodes picked in the trees of `contexts` (a config's node is `CONFIG_NODE` and its folder), without
 * the nodes `excluded` names: each node by the narrowest filter Playwright takes for it, a node holding an excluded one
 * by its children's. A config runs whole; a folder by its path and a slash; a spec by its path; a describe block, and a
 * test, by `file:line`; a project's node as its test, in that project alone. A test whose line holds others (a loop's)
 * also runs by its title (`--grep`), without the others of that line whose title holds its own (`--grep-invert`), so
 * it runs in a run of its own. One run per config, set of projects and titles; a node that is not runnable runs nothing.
 */
export function nodeRuns(
  contexts: ReadonlyArray<{ root: string; nodes: readonly TestTreeNode[] }>,
  picked: readonly string[],
  excluded: readonly string[] = [],
): NodeRun[] {
  const out = new Set(excluded);
  const index = new Map<
    string,
    { node: TestTreeNode; root: string; spec: TestTreeNode | null; parent: TestTreeNode | null }
  >();
  const walk = (
    nodes: readonly TestTreeNode[],
    root: string,
    spec: TestTreeNode | null,
    parent: TestTreeNode | null,
  ) => {
    for (const n of nodes) {
      const own = n.kind === 'spec' ? n : spec;
      index.set(n.id, { node: n, root, spec: own, parent });
      walk(n.children, root, own, n);
    }
  };
  for (const c of contexts) walk(c.nodes, c.root, null, null);
  const holdsExcluded = (n: TestTreeNode): boolean => n.children.some((c) => out.has(c.id) || holdsExcluded(c));
  const firstUri = (n: TestTreeNode): string | null =>
    n.kind === 'spec' ? n.uri : n.children.reduce<string | null>((found, c) => found ?? firstUri(c), null);
  const fileOf = (spec: TestTreeNode, root: string) => spec.id.slice(specId(root, '').length);
  const filters: Filter[] = [];
  const push = (root: string, uri: string | null, location: string | null, more: Partial<Filter> = {}) =>
    filters.push({ root, uri, location, projects: [], grep: null, grepInvert: null, ...more });

  /** A test's filter: its line, and its title when its line holds others. */
  const testFilter = (test: TestTreeNode, root: string, spec: TestTreeNode, projects: string[]) => {
    const line = test.test!.line;
    const others: TestTreeNode[] = [];
    const same = (nodes: readonly TestTreeNode[]) => {
      for (const n of nodes) {
        if (n.kind === 'test' && n !== test && n.test?.line === line) others.push(n);
        same(n.children);
      }
    };
    same(spec.children);
    const title = test.test!.title;
    const holding = others.filter((o) => o.test!.title.toLowerCase().includes(title.toLowerCase()));
    push(root, spec.uri, `${fileOf(spec, root)}:${line + 1}`, {
      projects,
      ...(others.length ? { grep: titlePattern(title) } : {}),
      ...(holding.length ? { grepInvert: holding.map((o) => titlePattern(o.test!.title)).join('|') } : {}),
    });
  };

  const add = (n: TestTreeNode, root: string, spec: TestTreeNode | null, parent: TestTreeNode | null) => {
    if (!n.runnable || out.has(n.id)) return;
    const own = n.kind === 'spec' ? n : spec;
    if (holdsExcluded(n) || (n.kind === 'describe' && !n.range)) {
      for (const c of n.children) add(c, root, own, n);
      return;
    }
    switch (n.kind) {
      case 'folder':
        push(root, firstUri(n), `${n.id.slice(folderId(root, '').length)}/`);
        return;
      case 'spec':
        push(root, n.uri, fileOf(n, root));
        return;
      case 'describe':
        push(root, n.uri, `${fileOf(spec!, root)}:${n.range!.start + 1}`);
        return;
      case 'test':
        testFilter(n, root, spec!, []);
        return;
      case 'project':
        if (parent?.test) testFilter(parent, root, spec!, [n.project!]);
        return;
      default:
        return;
    }
  };

  for (const id of picked) {
    const context = contexts.find((c) => id === `${CONFIG_NODE}${c.root}`);
    if (context) {
      if (context.nodes.some((n) => out.has(n.id) || holdsExcluded(n))) {
        for (const n of context.nodes) add(n, context.root, null, null);
      } else push(context.root, null, null);
      continue;
    }
    const placed = index.get(id);
    if (placed) add(placed.node, placed.root, placed.spec, placed.parent);
  }

  const runs = new Map<string, NodeRun>();
  for (const f of filters) {
    const projects = [...new Set(f.projects)].sort();
    const key = [f.root, projects.join('\x1f'), f.grep ?? '', f.grepInvert ?? ''].join('\0');
    let run = runs.get(key);
    if (!run) {
      run = { root: f.root, uri: f.uri, locations: [], all: false, projects, grep: f.grep, grepInvert: f.grepInvert };
      runs.set(key, run);
    }
    run.uri ??= f.uri;
    if (f.location === null) run.all = true;
    else if (!run.locations.includes(f.location)) run.locations.push(f.location);
  }
  return [...runs.values()].flatMap((run) => {
    if (run.all) return [{ ...run, locations: [] }];
    const parts: string[][] = [[]];
    let length = 0;
    for (const location of run.locations) {
      if (length + location.length + 1 > MAX_LOCATIONS_CHARS && parts[parts.length - 1]!.length) {
        parts.push([]);
        length = 0;
      }
      parts[parts.length - 1]!.push(location);
      length += location.length + 1;
    }
    return parts.map((locations) => ({ ...run, locations }));
  });
}
