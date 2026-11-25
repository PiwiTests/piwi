import type { Suite, TestCase } from '@playwright/test/reporter';
import { describe, expect, it } from 'vitest';
import {
  balancedShardsRefusal,
  keepShardTests,
  listShardTests,
  readShardSplit,
  roughDuration,
  type ShardTestInfo,
} from '../src/internal/support/shard-split.js';
import { changeableProjects, deadline, setupProjects, untilAborted } from '../src/internal/support/test-run-edits.js';

const RUNNER = ['node', 'playwright', 'test'];
const testRun = { skipSharding: () => undefined, exclude: () => undefined };

/** A suite tree as Playwright builds it, with the fields the helpers read. */
function suite(title: string, type: Suite['type'], children: Array<Suite | TestCase> = []): Suite {
  const node = {
    title,
    type,
    suites: children.filter((child): child is Suite => 'suites' in child),
    tests: children.filter((child): child is TestCase => !('suites' in child)),
    allTests(): TestCase[] {
      return [...node.tests, ...node.suites.flatMap((child) => child.allTests())];
    },
  };
  return node as unknown as Suite;
}

function testCase(id: string, extra: Partial<TestCase> = {}): TestCase {
  return {
    id,
    title: id,
    repeatEachIndex: 0,
    expectedStatus: 'passed',
    location: { file: `/work/${id}.spec.ts`, line: 1, column: 1 },
    ...extra,
  } as unknown as TestCase;
}

describe('balancedShardsRefusal', () => {
  it('asks the dashboard for a run Playwright lets the reporter shard', () => {
    expect(balancedShardsRefusal(testRun, [...RUNNER, '--shard=1/2'])).toBeNull();
  });

  it('stands aside below Playwright 1.62, and for a selection that differs per machine', () => {
    expect(balancedShardsRefusal({}, RUNNER)).toMatch(/needs Playwright 1.62/);
    expect(balancedShardsRefusal(testRun, [...RUNNER, '--last-failed', '--shard=1/2'])).toMatch(
      /stands aside for --last-failed, whose selection differs per machine/,
    );
    expect(balancedShardsRefusal(testRun, [...RUNNER, '--only-changed', '--test-list', 'a.txt'])).toMatch(
      /--only-changed and --test-list/,
    );
    expect(balancedShardsRefusal(testRun, [...RUNNER, '--test-list-invert=a.txt'])).toMatch(/--test-list-invert/);
  });
});

describe('listShardTests', () => {
  it('lists the tests in a stable order, numbering each group as first met, empty fields left out', () => {
    const info: Record<string, ShardTestInfo> = {
      b: { project: 'chromium', file: 'tests/b.spec.ts', suitePath: [], locks: [], group: 'B' },
      a2: { project: 'chromium', file: 'tests/a.spec.ts', suitePath: ['cart'], locks: ['db'], group: 'A' },
      a1: { project: 'chromium', file: 'tests/a.spec.ts', suitePath: ['cart'], locks: [], group: 'A' },
      f: { project: 'firefox', file: 'tests/a.spec.ts', suitePath: [], locks: [], group: 'F' },
    };
    const tests = [
      testCase('f'),
      testCase('b', { expectedStatus: 'skipped' }),
      testCase('a2', { title: 'pays' }),
      testCase('a1', { title: 'adds' }),
    ];
    const { listed, order } = listShardTests(tests, (test) => info[test.id]!);
    expect(order.map((test) => test.id)).toEqual(['a1', 'a2', 'b', 'f']);
    expect(listed).toEqual([
      { project: 'chromium', file: 'tests/a.spec.ts', suitePath: ['cart'], title: 'adds', group: 0 },
      { project: 'chromium', file: 'tests/a.spec.ts', suitePath: ['cart'], title: 'pays', locks: ['db'], group: 0 },
      { project: 'chromium', file: 'tests/b.spec.ts', title: 'b', group: 1, skipped: true },
      { project: 'firefox', file: 'tests/a.spec.ts', title: 'f', group: 2 },
    ]);
    // Another order of the same tests lists them alike.
    expect(listShardTests([...tests].reverse(), (test) => info[test.id]!).listed).toEqual(listed);
  });

  it('keeps the repetitions of a test apart', () => {
    const info: ShardTestInfo = { project: null, file: 'a.spec.ts', suitePath: [], locks: [], group: 'g' };
    const { listed } = listShardTests([testCase('a', { repeatEachIndex: 1 }), testCase('a')], () => info);
    expect(listed.map((test) => test.repeatEachIndex)).toEqual([undefined, 1]);
  });
});

describe('readShardSplit', () => {
  it('takes an answer that names one shard for each listed test', () => {
    expect(readShardSplit({ shards: [1, 2, 2] }, 3, 2)).toEqual([1, 2, 2]);
  });

  it('refuses one that does not cover the listed tests, or names a shard outside the run', () => {
    expect(() => readShardSplit({ shards: [1, 2] }, 3, 2)).toThrow(/does not cover the 3 listed tests/);
    expect(() => readShardSplit({ shards: [1, 3, 2] }, 3, 2)).toThrow(/outside 1 to 2/);
    expect(() => readShardSplit({ shards: [1, 1.5, 2] }, 3, 2)).toThrow(/outside 1 to 2/);
    expect(() => readShardSplit({}, 3, 2)).toThrow(/does not cover/);
  });
});

describe('keepShardTests', () => {
  it('excludes the other shards’ tests, a whole suite at once when none of its tests is kept', () => {
    const [a1, a2, b1, c1] = ['a1', 'a2', 'b1', 'c1'].map((id) => testCase(id));
    const describeA = suite('cart', 'describe', [a1!, a2!]);
    const fileA = suite('a.spec.ts', 'file', [describeA]);
    const fileB = suite('b.spec.ts', 'file', [b1!]);
    const chromium = suite('chromium', 'project', [fileA, fileB]);
    const firefox = suite('firefox', 'project', [suite('c.spec.ts', 'file', [c1!])]);
    const excluded: string[] = [];
    keepShardTests({ exclude: (target) => excluded.push(target.title) }, [chromium, firefox], new Set([a1!]));
    expect(excluded).toEqual(['a2', 'b.spec.ts', 'firefox']);
  });
});

describe('the tests a TestRun can change', () => {
  it('leaves out the setup and teardown projects, directly or not', () => {
    const root = suite(
      '',
      'root',
      ['setup', 'db', 'cleanup', 'chromium', 'alone'].map((name) => suite(name, 'project')),
    );
    const config = {
      projects: [
        { name: 'setup', dependencies: ['db'], teardown: 'cleanup' },
        { name: 'db', dependencies: [] },
        { name: 'cleanup', dependencies: [] },
        { name: 'chromium', dependencies: ['setup'] },
        { name: 'alone', dependencies: [] },
      ],
    } as never;
    expect([...setupProjects(config, root)].sort()).toEqual(['cleanup', 'db', 'setup']);
    expect(changeableProjects(config, root).map((project) => project.title)).toEqual(['chromium', 'alone']);
  });
});

describe('the deadline of preprocess', () => {
  it('ends the wait with the reason it names', async () => {
    const { signal, clear } = deadline(10);
    await expect(untilAborted(new Promise(() => undefined), signal)).rejects.toThrow(
      'the dashboard did not answer within 0 s',
    );
    clear();
    const later = deadline(1000);
    await expect(untilAborted(Promise.resolve(3), later.signal)).resolves.toBe(3);
    later.clear();
  });
});

describe('roughDuration', () => {
  it('says a duration in seconds under a minute, else in minutes', () => {
    expect(roughDuration(400)).toBe('1 s');
    expect(roughDuration(42_000)).toBe('42 s');
    expect(roughDuration(250_000)).toBe('4 min');
  });
});
