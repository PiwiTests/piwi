/**
 * The test tree of one Playwright config (`piwi/testItems`): its folders, its specs, their describe blocks, their tests
 * and, for a test that runs in several Playwright projects, a node per project; then the catalog's tests that no test
 * of the checkout is, in the **Not in this checkout** group. Built from what the service read of each spec, whichever
 * source gave it (the listing or the spec's text), so a node's id stays as one source replaces the other.
 */
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { specPattern } from '@piwitests/core/spec-filter';
import { locationSpec } from './commands.js';
import { CONFIG_NODE, type TestTreeNode, type TreeTest } from './protocol.js';

/** The label of the group of the catalog's tests that the checkout does not hold. */
export const NOT_IN_CHECKOUT = 'Not in this checkout';

/** What a project's node says after its name when the project runs only when `--project` names it. */
export const ONLY_NAMED = '(only with --project)';

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
 * same describe blocks are told apart by their order; a test that runs in several projects has a node per project, its
 * label saying so where `onlyNamed` holds Playwright's id of the test in that project.
 */
function addTests(
  parent: TestTreeNode,
  prefix: string,
  uri: string | null,
  entries: TreeEntry[],
  runnable: boolean,
  onlyNamed: ReadonlySet<string>,
) {
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
          label: onlyNamed.has(p.id) ? `${p.project} ${ONLY_NAMED}`.trim() : p.project,
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

/**
 * The tree of one config: its folders and specs, then the Not in this checkout group when it holds a test. `onlyNamed`:
 * Playwright's ids of the tests whose project runs only when `--project` names it (`onlyNamedIds`).
 */
export function configTree(
  root: string,
  specs: readonly TreeSpec[],
  missing: readonly MissingTest[],
  onlyNamed: ReadonlySet<string> = new Set(),
): TestTreeNode[] {
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
    addTests(specNode, specNode.id, spec.uri, spec.entries, true, onlyNamed);
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
      addTests(specNode, id, null, entries, false, onlyNamed);
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
  /** The projects it runs in alone, by name (empty for an unnamed one); those that run by default when empty. */
  projects: string[];
  grep: string | null;
  grepInvert: string | null;
}

/** The longest the locations of one run may be together: past it, the run is split (`cmd.exe` stops at 8,191). */
const MAX_LOCATIONS_CHARS = 8000;

/** The tags Playwright's `--grep` reads after a spec's name and after a describe block's title: ` @` words. */
const TAG_GAP = '( @[^ ]+)*';

/**
 * A title as Playwright's `--grep` reads it, a regular expression with no character a shell expands, written as
 * `specPattern` writes a path (`[(]` for a character a regular expression reads apart, `.` for one a shell expands), a
 * backslash and a control character as `.` too.
 */
export function titlePattern(title: string): string {
  return specPattern(title.replace(/[\\\p{Cc}]/gu, '.'));
}

/**
 * An absolute path as a file filter anchored at its start, written as `specPattern` writes a path: Playwright tests a
 * filter, a regular expression, against a file's whole path, `/`-separated, and on Windows (up to 1.62) against its
 * `file:` URL instead, so on Windows the URL's spelling is an alternative.
 */
function anchoredPath(absolute: string, windows: boolean): string {
  const spelled = specPattern(absolute);
  if (!windows) return `^${spelled}`;
  return `^(?:${spelled}|${specPattern(pathToFileURL(absolute, { windows: true }).href)})`;
}

/**
 * The file filter of a folder: its whole path anchored at its start (`anchoredPath`), then `/.`, as a filter ending in
 * `/` reads as `/…/` syntax.
 */
export function folderFilter(folder: string, windows = process.platform === 'win32'): string {
  return `${anchoredPath(folder, windows)}/.`;
}

/**
 * A location of a run (relative to the config's folder: `tests/`, `tests/cart.spec.ts`, `tests/cart.spec.ts:12`) as
 * the command line writes it, from the config's folder `folder` as the file system spells it: a folder by
 * `folderFilter`, a spec by its whole path anchored at its start, then its `:line`. The end of a spec's path is not
 * anchored, as `$` is a character a shell expands: `cart.spec.ts` also takes `cart.spec.tsx` beside it.
 */
export function locationArg(folder: string, location: string, windows = process.platform === 'win32'): string {
  const join = windows ? path.win32.join : path.posix.join;
  if (location.endsWith('/')) return folderFilter(join(folder, location.slice(0, -1)), windows);
  const spec = locationSpec(location);
  return anchoredPath(join(folder, spec), windows) + location.slice(spec.length);
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
 * also runs by its spec's name, describe blocks and title (`--grep`), without the others of that line this matches
 * (`--grep-invert`), in a run of its own; when two tests of the line match each other, the whole line runs.
 *
 * A test runs only when `--project` names it when the context's `onlyNamed` holds Playwright's id of it in every project
 * it runs in (`default: false`, and no project a run without `--project` runs depends on that one); a test the listing
 * gives no project goes by its spec's other tests. A node holding only such tests runs with `--project` naming their
 * projects (`--project=` for an unnamed one). A node holding others too runs as Playwright runs it without `--project`
 * (a test of both kinds of projects in the others), and such tests under it run apart, in their projects, each by the
 * widest node holding none of the others: no picked test is left to a run that leaves it out.
 *
 * One run per config, set of projects and titles; a node that is not runnable runs nothing. A run is split where its
 * locations, as `locationArg` writes them from the context's `folder` (its root by default), would make too long a
 * command.
 */
export function nodeRuns(
  contexts: ReadonlyArray<{
    root: string;
    folder?: string;
    nodes: readonly TestTreeNode[];
    onlyNamed?: ReadonlySet<string>;
  }>,
  picked: readonly string[],
  excluded: readonly string[] = [],
): NodeRun[] {
  const out = new Set(excluded);
  const folders = new Map(contexts.map((c) => [c.root, c.folder ?? c.root]));
  const onlyNamedOf = new Map(contexts.flatMap((c) => (c.onlyNamed?.size ? [[c.root, c.onlyNamed] as const] : [])));
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
    // Playwright matches `--grep` against the project, the spec and each describe block, each followed by its tags,
    // then the title and the test's tags, joined by spaces. The pattern starts at the spec's name and lets the tags of
    // the spec and of each describe block through. The tests of the line it also matches are left out, unless one of them matches this one's pattern back:
    // their titles cannot be told apart, and the whole line runs.
    const file = fileOf(spec, root);
    const base = file.slice(file.lastIndexOf('/') + 1);
    const titled = (t: TestTreeNode) =>
      [
        titlePattern(base) + TAG_GAP,
        ...t.test!.suite.map((s) => titlePattern(s) + TAG_GAP),
        titlePattern(t.test!.title),
      ].join(' ');
    // Whether `t`'s pattern matches the start of `o`'s spec name, describe blocks and title, as the grep reads them.
    const matches = (t: TestTreeNode, o: TestTreeNode) =>
      new RegExp(`^(?:${titled(t)})`, 'i').test([base, ...o.test!.suite, o.test!.title].join(' '));
    const taken = others.filter((o) => matches(test, o));
    const apart = others.length > 0 && !taken.some((o) => matches(o, test));
    push(root, spec.uri, `${file}:${line + 1}`, {
      projects,
      ...(apart ? { grep: titled(test) } : {}),
      ...(apart && taken.length ? { grepInvert: taken.map(titled).join('|') } : {}),
    });
  };

  /** The projects a test runs in, with its ids: those the listing gives it, else those of its spec's other tests. */
  const specEntries = new Map<string, TreeTest['playwright']>();
  const entriesOf = (test: TestTreeNode, spec: TestTreeNode | null): TreeTest['playwright'] => {
    if (test.test!.playwright.length) return test.test!.playwright;
    if (!spec) return [];
    let found = specEntries.get(spec.id);
    if (!found) {
      const all: TreeTest['playwright'] = [];
      const collect = (nodes: readonly TestTreeNode[]) => {
        for (const n of nodes) {
          if (n.kind === 'test') all.push(...(n.test?.playwright ?? []));
          else collect(n.children);
        }
      };
      collect(spec.children);
      found = all;
      specEntries.set(spec.id, found);
    }
    return found;
  };

  /**
   * What the tests under `nodes` need: the projects of those that run only when `--project` names them, and whether
   * another runs without it.
   */
  const reachOf = (nodes: readonly TestTreeNode[], root: string, spec: TestTreeNode | null) => {
    const named = new Set<string>();
    let byDefault = false;
    const onlyNamed = onlyNamedOf.get(root);
    const visit = (n: TestTreeNode, own: TestTreeNode | null) => {
      if (!n.runnable || out.has(n.id) || n.kind === 'project') return;
      if (n.kind !== 'test') {
        for (const c of n.children) visit(c, n.kind === 'spec' ? n : own);
        return;
      }
      const entries = entriesOf(n, own);
      if (onlyNamed && entries.length && entries.every((p) => onlyNamed.has(p.id))) {
        for (const p of entries) named.add(p.project);
      } else byDefault = true;
    };
    for (const n of nodes) visit(n, spec);
    return { named: [...named], byDefault };
  };

  /** A node's own filter, in `projects` alone (every project that runs by default when empty). */
  const filterOf = (n: TestTreeNode, root: string, spec: TestTreeNode | null, projects: string[]) => {
    switch (n.kind) {
      case 'folder':
        push(root, firstUri(n), `${n.id.slice(folderId(root, '').length)}/`, { projects });
        return;
      case 'spec':
        push(root, n.uri, fileOf(n, root), { projects });
        return;
      case 'describe':
        push(root, n.uri, `${fileOf(spec!, root)}:${n.range!.start + 1}`, { projects });
        return;
      case 'test':
        testFilter(n, root, spec!, projects);
        return;
      default:
        return;
    }
  };

  /** Whether a node runs by its children's filters rather than its own. */
  const byChildren = (n: TestTreeNode) => holdsExcluded(n) || (n.kind === 'describe' && !n.range);

  /**
   * The tests under `n` that run only when `--project` names them, in their projects: by the widest node holding no
   * test that runs without it.
   */
  const addNamed = (n: TestTreeNode, root: string, spec: TestTreeNode | null) => {
    if (!n.runnable || out.has(n.id) || n.kind === 'project') return;
    const own = n.kind === 'spec' ? n : spec;
    const reach = reachOf([n], root, own);
    if (!reach.named.length) return;
    if (!reach.byDefault && !byChildren(n)) filterOf(n, root, own, reach.named);
    else for (const c of n.children) addNamed(c, root, own);
  };

  const add = (n: TestTreeNode, root: string, spec: TestTreeNode | null, parent: TestTreeNode | null) => {
    if (!n.runnable || out.has(n.id)) return;
    const own = n.kind === 'spec' ? n : spec;
    if (byChildren(n)) {
      for (const c of n.children) add(c, root, own, n);
      return;
    }
    if (n.kind === 'project') {
      if (parent?.test) testFilter(parent, root, spec!, [n.project!]);
      return;
    }
    const reach = reachOf([n], root, own);
    if (reach.named.length && !reach.byDefault) {
      filterOf(n, root, own, reach.named);
      return;
    }
    filterOf(n, root, own, []);
    if (reach.named.length) for (const c of n.children) addNamed(c, root, own);
  };

  for (const id of picked) {
    const context = contexts.find((c) => id === `${CONFIG_NODE}${c.root}`);
    if (context) {
      if (context.nodes.some((n) => out.has(n.id) || holdsExcluded(n))) {
        for (const n of context.nodes) add(n, context.root, null, null);
        continue;
      }
      const reach = reachOf(context.nodes, context.root, null);
      if (reach.named.length && !reach.byDefault) {
        push(context.root, null, null, { projects: reach.named });
        continue;
      }
      push(context.root, null, null);
      if (reach.named.length) for (const n of context.nodes) addNamed(n, context.root, null);
      continue;
    }
    const placed = index.get(id);
    if (placed) add(placed.node, placed.root, placed.spec, placed.parent);
  }

  const runs = new Map<string, NodeRun>();
  for (const f of filters) {
    const projects = [...new Set(f.projects)].sort();
    const key = JSON.stringify([f.root, projects, f.grep, f.grepInvert]);
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
      // The location, quoted, and a space.
      const cost = locationArg(folders.get(run.root) ?? run.root, location).length + 3;
      if (length + cost > MAX_LOCATIONS_CHARS && parts[parts.length - 1]!.length) {
        parts.push([]);
        length = 0;
      }
      parts[parts.length - 1]!.push(location);
      length += cost;
    }
    return parts.map((locations) => ({ ...run, locations }));
  });
}
