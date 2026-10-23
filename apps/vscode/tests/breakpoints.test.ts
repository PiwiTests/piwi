import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, test } from 'vitest';
import { runBreakpoints, type BreakpointLike } from '../src/breakpoints';

const root = path.resolve('/work/shop');

/** A line breakpoint as `vscode.debug.breakpoints` lists one. */
function at(file: string, line: number, enabled = true, scheme = 'file'): BreakpointLike {
  const href = pathToFileURL(file).href;
  return {
    enabled,
    location: { uri: { scheme, fsPath: file, toString: () => href }, range: { start: { line } } },
  };
}

describe('the breakpoints a run pauses at', () => {
  test('are the enabled line breakpoints in script files under a Playwright config', () => {
    const spec = path.join(root, 'tests', 'login.spec.ts');
    const page = path.join(root, 'tests', 'pages', 'checkout.page.mjs');
    expect(
      runBreakpoints(
        [
          at(spec, 41),
          at(page, 8),
          at(spec, 50, false),
          at(path.join(root, 'README.md'), 3),
          at(path.resolve('/work/other/a.spec.ts'), 1),
          at(spec, 2, true, 'untitled'),
          { enabled: true },
        ],
        [root],
      ),
    ).toEqual([
      { uri: pathToFileURL(spec).href, line: 41 },
      { uri: pathToFileURL(page).href, line: 8 },
    ]);
  });

  test('are none without a Playwright config', () => {
    expect(runBreakpoints([at(path.join(root, 'tests', 'a.spec.ts'), 1)], [])).toEqual([]);
  });
});
