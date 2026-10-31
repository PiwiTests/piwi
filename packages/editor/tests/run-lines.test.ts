/**
 * The lines of a file a run stopped in, followed from the run's start through the editor's edits, and the files it
 * refuses to follow.
 */
import { describe, expect, test } from 'vitest';
import { RunLines, type LineChange } from '../src/run-lines';

const TEXT = [
  "import { test } from '@playwright/test';",
  '',
  "test('pays', async ({ page }) => {",
  "  await page.goto('/cart');",
  '});',
  '',
].join('\n');
const FILE = '/work/shop/tests/cart.spec.ts';
const DISK = { text: TEXT, mtime: 100 };

/** A change of a range of `[line, character]` to `text`. */
function at(start: [number, number], end: [number, number], text: string): LineChange {
  return { range: { start: { line: start[0], character: start[1] }, end: { line: end[0], character: end[1] } }, text };
}

/** Lines with a clock the test moves, a run started at 1000, and the spec open since 500 as it is on disk. */
function lines() {
  let now = 500;
  const map = new RunLines(() => now);
  map.opened(FILE, TEXT, DISK);
  now = 1000;
  map.started('ed-1');
  now = 2000;
  return { map, tick: (to: number) => (now = to), line: (line: number) => map.lineNow('ed-1', FILE, line, true, null) };
}

describe('the line a run stopped at, where it stands now', () => {
  test('is the same line while nothing changed, and moves with the lines written above it', () => {
    const { map, line } = lines();
    expect(line(3)).toEqual({ line: 3 });
    // An import line, then a block of three lines right above the stopped one, as Piwi writes them.
    map.changed(FILE, TEXT, [
      at([3, 0], [3, 0], '  a;\n  b;\n  c;\n'),
      at([1, 0], [1, 0], "import { expect } from '@playwright/test';\n"),
    ]);
    expect(line(3)).toEqual({ line: 7 });
    // An edit below it, or in the line past its start (a pick replacing its locator), leaves it where it is.
    map.changed(FILE, null, [at([8, 0], [8, 2], ''), at([7, 8], [7, 12], 'page.locator')]);
    expect(line(3)).toEqual({ line: 7 });
    // Lines removed above it.
    map.changed(FILE, null, [at([4, 0], [7, 0], '')]);
    expect(line(3)).toEqual({ line: 4 });
  });

  test('ignores the edits made before the run started', () => {
    let now = 500;
    const map = new RunLines(() => now);
    map.opened(FILE, TEXT, DISK);
    map.changed(FILE, TEXT, [at([0, 0], [0, 0], '// one\n')]);
    now = 1000;
    map.started('ed-1');
    now = 2000;
    map.changed(FILE, null, [at([0, 0], [0, 0], '// two\n')]);
    expect(map.lineNow('ed-1', FILE, 4, true, null)).toEqual({ line: 5 });
  });

  test('follows a whole new text by its line diff with the text before', () => {
    const { map, line } = lines();
    const after = TEXT.replace("test('pays'", "// Pays.\ntest('pays'");
    map.changed(FILE, TEXT, [{ text: after }]);
    expect(line(3)).toEqual({ line: 4 });
  });

  test('refuses a stopped line an edit removed or rewrote from its start, and a whole text whose text before it lacks', () => {
    const { map, line } = lines();
    map.changed(FILE, null, [at([2, 10], [3, 6], 'x')]);
    expect(line(3)).toEqual({
      refusal:
        'The stopped line of cart.spec.ts was removed or rewritten since the run started: run the test again to write code at its stop.',
    });
    const other = lines();
    other.map.changed(FILE, null, [at([0, 0], [0, 0], '// a\n'), { text: TEXT }]);
    expect(other.line(3)).toMatchObject({ refusal: expect.stringMatching(/^The stopped line of cart.spec.ts/) });
  });

  test('takes a file no editor held since the run started from disk, unchanged while it is older than the run', () => {
    const map = new RunLines(() => 1000);
    map.started('ed-1');
    expect(map.lineNow('ed-1', FILE, 3, false, DISK)).toEqual({ line: 3 });
    expect(map.lineNow('ed-1', FILE, 3, false, { text: TEXT, mtime: 1500 })).toEqual({
      refusal:
        'cart.spec.ts was written on disk since the run started, which Piwi cannot follow: run the test again to write code at its stop.',
    });
    expect(map.lineNow('ed-1', FILE, 3, true, null)).toMatchObject({
      refusal: expect.stringMatching(/cannot follow the edits/),
    });
    expect(map.lineNow('ed-2', FILE, 3, false, DISK)).toMatchObject({
      refusal: expect.stringMatching(/^Piwi does not know/),
    });
  });

  test('follows a file the editor opened after the run started as it was on disk, as Piwi’s first code opens it', () => {
    let now = 1000;
    const map = new RunLines(() => now);
    map.started('ed-1');
    now = 2000;
    map.opened(FILE, TEXT, DISK);
    map.changed(FILE, TEXT, [at([3, 0], [3, 0], '  a;\n')]);
    expect(map.lineNow('ed-1', FILE, 3, true, null)).toEqual({ line: 4 });
    // Closed and saved as it stood, it is followed still; written on disk once more, it is not.
    map.closed(FILE, 'saved');
    expect(map.lineNow('ed-1', FILE, 3, false, { text: 'saved', mtime: 2500 })).toEqual({ line: 4 });
    expect(map.lineNow('ed-1', FILE, 3, false, { text: 'other', mtime: 2600 })).toMatchObject({
      refusal: expect.stringMatching(/changed since the editor closed it/),
    });
    // Opened with a text other than the disk's.
    map.opened('/work/b.ts', 'edited', { text: 'disk', mtime: 10 });
    expect(map.lineNow('ed-1', '/work/b.ts', 3, true, null)).toMatchObject({
      refusal: expect.stringMatching(/changed before the editor opened it/),
    });
  });

  test('refuses a file held with changes not saved as the run started, which the run does not have', () => {
    const map = new RunLines(() => 1000);
    map.opened(FILE, TEXT, DISK);
    map.started('ed-1', () => [FILE]);
    expect(map.lineNow('ed-1', FILE, 3, true, null)).toMatchObject({
      refusal: expect.stringMatching(/^cart.spec.ts had changes not saved when the run started/),
    });
    // A run whose start was heard first keeps it.
    map.started('ed-1', () => [], true);
    expect(map.lineNow('ed-1', FILE, 3, true, null)).toMatchObject({ refusal: expect.stringMatching(/not saved/) });
  });

  test('starts a run started in a terminal from the files as they stand as its first worker attaches', () => {
    let now = 500;
    const map = new RunLines(() => now);
    map.opened(FILE, TEXT, DISK);
    // Edits before the run attached are its code already.
    map.changed(FILE, TEXT, [at([0, 0], [0, 0], '// one\n')]);
    now = 1000;
    map.started('terminal-41-1', () => [], true);
    now = 2000;
    expect(map.lineNow('terminal-41-1', FILE, 4, true, null)).toEqual({ line: 4 });
    map.changed(FILE, null, [at([0, 0], [0, 0], '// two\n')]);
    expect(map.lineNow('terminal-41-1', FILE, 4, true, null)).toEqual({ line: 5 });
    // A later worker of the same run keeps that start.
    now = 3000;
    map.started('terminal-41-1', () => [FILE], true);
    expect(map.lineNow('terminal-41-1', FILE, 4, true, null)).toEqual({ line: 5 });
  });

  test('refuses a file edited more times since the run started than it keeps', () => {
    const { map, line } = lines();
    for (let i = 0; i < 2001; i++) map.changed(FILE, null, [at([0, 0], [0, 1], 'i')]);
    expect(line(3)).toMatchObject({ refusal: expect.stringMatching(/edited too many times/) });
  });
});
