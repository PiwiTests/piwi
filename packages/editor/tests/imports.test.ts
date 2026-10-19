import { describe, expect, test } from 'vitest';
import { importInsertion, importStatementEnds, importedNames, missingImports } from '../src/recorder/imports';

const file = (...lines: string[]) => lines.join('\n');
const names = (text: string) => [...importedNames(text)].sort();

describe('importedNames', () => {
  test('defaults, namespaces, named imports under their local names, and import type', () => {
    const text = file(
      "import Default from 'a';",
      "import Other, { one, two as second } from 'b';",
      "import Third, * as ns from 'c';",
      "import * as all from 'd';",
      "import type { Page, Locator as L } from '@playwright/test';",
      "import { type Shape, default as fallback, 'odd-name' as odd } from 'e';",
      "import type Config from 'f';",
      "import type * as types from 'g';",
      "import legacy = require('h');",
    );
    expect(names(text)).toEqual(
      [
        'Default',
        'Other',
        'one',
        'second',
        'Third',
        'ns',
        'all',
        'Page',
        'L',
        'Shape',
        'fallback',
        'odd',
        'Config',
        'types',
        'legacy',
      ].sort(),
    );
  });

  test('a statement across lines, with comments and trailing commas', () => {
    const text = file(
      'import {',
      '  CartPage, // the cart',
      '  /* the checkout */ CheckoutPage as Checkout,',
      "} from './pages';",
      "import type from 'type-module';",
    );
    expect(names(text)).toEqual(['CartPage', 'Checkout', 'type']);
  });

  test('side-effect imports, dynamic imports, import.meta, require and code inside blocks or strings bind nothing', () => {
    const text = file(
      "import './setup';",
      "const lazy = await import('./lazy');",
      'const here = import.meta.url;',
      "const fs = require('node:fs');",
      'const text = "import { Fake } from \'x\';";',
      '// import { Commented } from "y";',
      "declare module 'z' {",
      "  import { Inner } from 'inner';",
      '}',
    );
    expect(names(text)).toEqual([]);
  });
});

describe('missingImports', () => {
  test('keeps the lines whose names the file does not bind, whatever its spacing, quotes or renames', () => {
    const text = file(
      'import {',
      '  CartPage,',
      '} from "./pages/cart.page"',
      "import { SignInPage as Login } from './pages/sign-in.page';",
      "test('t', async ({ page }) => {});",
    );
    expect(
      missingImports(text, [
        "import { CartPage } from './pages/cart.page';",
        "import { SignInPage } from './pages/sign-in.page';",
        "import { fill } from './helpers';",
      ]),
    ).toEqual(["import { SignInPage } from './pages/sign-in.page';", "import { fill } from './helpers';"]);
    expect(missingImports(text, [])).toEqual([]);
  });
});

/** An insertion of `newText` at 0-based `line` and `character`. */
const insertAt = (line: number, newText: string, character = 0) => ({
  range: { start: { line, character }, end: { line, character } },
  newText,
});

describe('importStatementEnds', () => {
  test('each top-level statement ends at its module, its attributes and its semicolon, over several lines too', () => {
    const text = file(
      "import { test } from '@playwright/test';",
      'import {',
      '  CartPage,',
      "  type Checkout as C, 'odd-name' as odd,",
      '} from',
      "  './pages/cart.page'",
      "import data from './data.json' with { type: 'json' };",
      "import './setup';",
      "import legacy = require('legacy');",
      '',
      "test('pays', async () => { const m = await import('./lazy'); import.meta.url; });",
    );
    const ends = importStatementEnds(text);
    expect(ends.map((end) => text.slice(0, end).split('\n').pop())).toEqual([
      "import { test } from '@playwright/test';",
      "  './pages/cart.page'",
      "import data from './data.json' with { type: 'json' };",
      "import './setup';",
      "import legacy = require('legacy');",
    ]);
  });

  test('skips what is not a statement: in a string, a comment or a block, and an alias with no module', () => {
    const text = file(
      "// import { a } from './a';",
      'const s = "import { b } from \'./b\';";',
      "if (x) { import('./c'); }",
      'import Alias = Name.Space;',
    );
    expect(importStatementEnds(text)).toEqual([]);
  });
});

describe('importInsertion', () => {
  const cart = "import { CartPage } from './pages/cart.page';";

  test('goes on the line after the last import statement, a statement over several lines included', () => {
    const text = file(
      "import { test } from '@playwright/test';",
      'import {',
      '  expect,',
      "} from '@playwright/test';",
      '',
      "test('pays', async ({ page }) => {});",
    );
    expect(importInsertion(text, [cart])).toEqual(insertAt(4, `${cart}\n`));
    const cutAfterFrom = file('import {', '  expect,', '} from', "  '@playwright/test';", "test('t', () => {});");
    expect(importInsertion(cutAfterFrom, [cart])).toEqual(insertAt(4, `${cart}\n`));
  });

  test('after a last statement that ends the file, on a new line', () => {
    expect(importInsertion("import { b } from './b';", [cart])).toEqual(insertAt(0, `\n${cart}`, 24));
    expect(importInsertion("import { b } from './b';\r\nimport {\r\n  c,\r\n} from './c';", [cart])).toEqual(
      insertAt(3, `\n${cart}`, 13),
    );
  });

  test('without an import statement, at the top, followed by an empty line unless the file starts with one', () => {
    expect(importInsertion("test('t', async () => {});\n", [cart])).toEqual(insertAt(0, `${cart}\n\n`));
    expect(importInsertion("\ntest('t', async () => {});\n", [cart])).toEqual(insertAt(0, `${cart}\n`));
    expect(importInsertion("import('./x');\nimport.meta.url;\n", [cart])).toEqual(insertAt(0, `${cart}\n\n`));
    expect(importInsertion('', [cart])).toEqual(insertAt(0, `${cart}\n\n`));
  });

  test('adds each line once, and nothing without a line', () => {
    expect(importInsertion("import { b } from './b';\n", [cart, ` ${cart} `, ''])).toEqual(insertAt(1, `${cart}\n`));
    expect(importInsertion("import { b } from './b';\n", [])).toBeNull();
    expect(importInsertion("import { b } from './b';\n", ['  '])).toBeNull();
  });
});
