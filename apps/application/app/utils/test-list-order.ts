/**
 * How the test lists — a run's Tests tab and a project's Tests catalog — order
 * tests and build the File and File + Describe groupings, so both read the same.
 *
 * Two orders follow the suite itself: **file order** is the order tests are
 * declared in (file, then line, then column — what `playwright test --list`
 * prints), and **run order** is the order they started in a run. In the File +
 * Describe grouping the describe blocks keep their place in the file, and under
 * either of those two orders they sit among the file's other tests exactly
 * where they are declared.
 */

/** Where a test sits: what ordering and grouping read from a row. */
export interface TestPosition {
  filePath: string;
  suitePath: readonly string[];
  line: number | null;
  column: number | null;
  /** When the test first started in the run (ms); null when it never did. */
  startedAt: number | null;
}

function compareNullable(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

/** File order: file path, then line, then column; a test with no line goes last in its file. */
export function compareFileOrder(a: TestPosition, b: TestPosition): number {
  return a.filePath.localeCompare(b.filePath) || compareNullable(a.line, b.line) || compareNullable(a.column, b.column);
}

/** Run order: when each test first started; the tests that never started follow, in file order. */
export function compareRunOrder(a: TestPosition, b: TestPosition): number {
  return compareNullable(a.startedAt, b.startedAt) || compareFileOrder(a, b);
}

export function fileGroupKey(filePath: string): string {
  return `file:${filePath}`;
}

export function describeGroupKey(filePath: string, suitePath: readonly string[]): string {
  return `describe:${filePath}\x1f${suitePath.join('\x1f')}`;
}

/** Every group key a test sits under in the File + Describe grouping, outermost first. */
export function describeGroupKeys(position: Pick<TestPosition, 'filePath' | 'suitePath'>): string[] {
  const keys = [fileGroupKey(position.filePath)];
  for (let i = 1; i <= position.suitePath.length; i++) {
    keys.push(describeGroupKey(position.filePath, position.suitePath.slice(0, i)));
  }
  return keys;
}

/** A group header row: a file, or a describe block inside one. */
export interface TestListGroupRow<T> {
  kind: 'group';
  key: string;
  label: string;
  /** Nesting depth: 0 for a file, 1 for a describe block directly in it, and so on. */
  depth: number;
  filePath: string;
  /** The group is a file rather than a describe block. */
  isFile: boolean;
  /** Every test under the group, nested blocks included. */
  tests: T[];
}

export interface TestListTestRow<T> {
  kind: 'test';
  key: string;
  test: T;
  /** Nesting depth of the row's group, so a test indents under it. */
  depth: number;
}

export type TestListRow<T> = TestListGroupRow<T> | TestListTestRow<T>;

export interface FileGroupingOptions<T> {
  /** Nest the describe blocks under each file (File + Describe). */
  describe: boolean;
  position: (test: T) => TestPosition;
  /** The list's sort, applied within each group. */
  compare: (a: T, b: T) => number;
  /** The sort follows where tests sit (file or run order): describe blocks then sit among the tests. */
  positional: boolean;
  isOpen: (key: string) => boolean;
  testKey: (test: T) => string;
}

/** A test or a describe block at one level of a file, with the test that places it. */
type LevelChild<T> = ({ kind: 'test'; test: T } | { kind: 'group'; name: string; tests: T[] }) & { lead: T };

/**
 * The rows of the File or File + Describe grouping: a header per file (files in
 * path order), then — under an open header — its tests, or its describe blocks
 * and the tests declared directly in it, each block with its own header.
 */
export function fileGroupRows<T>(tests: readonly T[], options: FileGroupingOptions<T>): TestListRow<T>[] {
  const { position, compare, positional, isOpen, testKey } = options;
  const rows: TestListRow<T>[] = [];

  const first = (members: T[], by: (a: T, b: T) => number): T => members.reduce((min, t) => (by(t, min) < 0 ? t : min));
  const byPosition = (a: T, b: T) => compareFileOrder(position(a), position(b));

  function addLevel(levelTests: T[], filePath: string, parentPath: string[], depth: number): void {
    const direct: T[] = [];
    const nested = new Map<string, T[]>();
    for (const test of levelTests) {
      const suitePath = position(test).suitePath;
      if (suitePath.length <= parentPath.length) {
        direct.push(test);
      } else {
        const name = suitePath[parentPath.length]!;
        const members = nested.get(name) ?? [];
        members.push(test);
        nested.set(name, members);
      }
    }
    const testChildren = direct.map((test): LevelChild<T> => ({ kind: 'test', test, lead: test }));
    let children: LevelChild<T>[];
    if (positional) {
      // A block sits where its first test (in the list's order) does.
      const groups = [...nested].map(([name, members]): LevelChild<T> => ({
        kind: 'group',
        name,
        tests: members,
        lead: first(members, compare),
      }));
      children = [...testChildren, ...groups].sort((a, b) => compare(a.lead, b.lead));
    } else {
      // Blocks keep their place in the file, ahead of the tests declared outside any block.
      const groups = [...nested].map(([name, members]): LevelChild<T> => ({
        kind: 'group',
        name,
        tests: members,
        lead: first(members, byPosition),
      }));
      groups.sort((a, b) => byPosition(a.lead, b.lead));
      children = [...groups, ...testChildren.sort((a, b) => compare(a.lead, b.lead))];
    }
    for (const child of children) {
      if (child.kind === 'test') {
        rows.push({ kind: 'test', key: testKey(child.test), test: child.test, depth });
        continue;
      }
      const suitePath = [...parentPath, child.name];
      const key = describeGroupKey(filePath, suitePath);
      rows.push({ kind: 'group', key, label: child.name, depth, filePath, isFile: false, tests: child.tests });
      if (isOpen(key)) addLevel(child.tests, filePath, suitePath, depth + 1);
    }
  }

  const byFile = new Map<string, T[]>();
  for (const test of tests) {
    const filePath = position(test).filePath;
    const members = byFile.get(filePath) ?? [];
    members.push(test);
    byFile.set(filePath, members);
  }
  for (const [filePath, fileTests] of [...byFile.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const key = fileGroupKey(filePath);
    rows.push({ kind: 'group', key, label: filePath, depth: 0, filePath, isFile: true, tests: fileTests });
    if (!isOpen(key)) continue;
    if (options.describe) {
      addLevel(fileTests, filePath, [], 1);
    } else {
      for (const test of [...fileTests].sort(compare)) rows.push({ kind: 'test', key: testKey(test), test, depth: 0 });
    }
  }
  return rows;
}
