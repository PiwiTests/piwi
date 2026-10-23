import { describe, expect, test } from 'vitest';
import {
  expectModuleOf,
  importInsertion,
  importStatementEnds,
  importedNames,
  missingImports,
  requireForm,
  testImportOf,
} from '../src/recorder/imports';

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

  test('side-effect imports, dynamic imports, import.meta and code inside blocks or strings bind nothing', () => {
    const text = file(
      "import './setup';",
      "const lazy = await import('./lazy');",
      'const here = import.meta.url;',
      'const text = "import { Fake } from \'x\';";',
      '// import { Commented } from "y";',
      "declare module 'z' {",
      "  import { Inner } from 'inner';",
      '}',
    );
    expect(names(text)).toEqual([]);
  });

  test('the names of require declarations: a destructuring, a whole module, a renamed export, a member', () => {
    const text = file(
      "const { test, expect } = require('@playwright/test');",
      "const base = require('./base');",
      "let { test: it, 'odd-name': odd } = require('./fixtures'), helpers = require('./helpers');",
      "var only = require('./pages').OnlyPage;",
      "require('./setup');",
      "const fs = require('node:fs'), count = 1;",
      'function run() {',
      "  const inner = require('./inner');",
      '}',
      'const text = \'const { fake } = require("x")\';',
      "// const { commented } = require('y');",
    );
    expect(names(text)).toEqual(['base', 'expect', 'fs', 'helpers', 'it', 'odd', 'only', 'test'].sort());
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

  test('a require declaration binds its names, in the file and as a line', () => {
    const text = "const { test, expect } = require('@playwright/test');\n";
    expect(
      missingImports(text, [
        "import { expect } from '@playwright/test';",
        "const { CartPage } = require('./pages/cart.page');",
      ]),
    ).toEqual(["const { CartPage } = require('./pages/cart.page');"]);
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

  test('skips what is not a statement: in a string, a comment or a block, an alias with no module, a require', () => {
    const text = file(
      "// import { a } from './a';",
      'const s = "import { b } from \'./b\';";',
      "if (x) { import('./c'); }",
      'import Alias = Name.Space;',
      "const { expect } = require('@playwright/test');",
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

  test('in a file loading its modules with require: require declarations, after the last of them', () => {
    const text = file(
      "const { test } = require('@playwright/test');",
      "const base = require('./base');",
      '',
      "test('t', async ({ page }) => {});",
    );
    expect(importInsertion(text, ["import { expect } from '@playwright/test';", cart])).toEqual(
      insertAt(
        2,
        "const { expect } = require('@playwright/test');\nconst { CartPage } = require('./pages/cart.page');\n",
      ),
    );
    const both = file("import { test } from '@playwright/test';", "const base = require('./base');", '');
    expect(importInsertion(both, [cart])).toEqual(insertAt(1, `${cart}\n`));
    const inner = file('function f() {', "  const x = require('./x');", '}');
    expect(importInsertion(inner, [cart])).toEqual(insertAt(0, `${cart}\n\n`));
  });

  test('adds each line once, and nothing without a line', () => {
    expect(importInsertion("import { b } from './b';\n", [cart, ` ${cart} `, ''])).toEqual(insertAt(1, `${cart}\n`));
    expect(importInsertion("import { b } from './b';\n", [])).toBeNull();
    expect(importInsertion("import { b } from './b';\n", ['  '])).toBeNull();
  });
});

describe('requireForm', () => {
  test('an import line as a require declaration of the same shape', () => {
    expect(requireForm("import { CartPage } from './pages/cart.page';")).toBe(
      "const { CartPage } = require('./pages/cart.page');",
    );
    expect(requireForm("import { test as it, expect } from '@playwright/test'")).toBe(
      "const { test: it, expect } = require('@playwright/test');",
    );
    expect(requireForm("import base from './base';")).toBe("const base = require('./base');");
    expect(requireForm("import * as pages from './pages';")).toBe("const pages = require('./pages');");
    expect(requireForm("import './setup';")).toBe("require('./setup');");
    expect(requireForm("import type { Page } from '@playwright/test';")).toBe('');
    expect(requireForm("const { expect } = require('@playwright/test');")).toBe(
      "const { expect } = require('@playwright/test');",
    );
  });
});

describe('testImportOf', () => {
  test('the module the file takes test from: named, renamed, as a default, or through require', () => {
    expect(testImportOf("import { test, expect } from '@playwright/test';\n\ntest('t', () => {});\n")).toBe(
      '@playwright/test',
    );
    expect(testImportOf("import { expect, test } from './fixtures';\n")).toBe('./fixtures');
    expect(testImportOf("import fixtures, { test } from '../support';\n")).toBe('../support');
    expect(testImportOf("import { test as it } from './fixtures';\nit('x', async ({ page }) => {});")).toBe(
      './fixtures',
    );
    expect(testImportOf("import test from './fixtures';\n")).toBe('./fixtures');
    expect(testImportOf("const { test, expect } = require('@playwright/test');\n")).toBe('@playwright/test');
    expect(testImportOf("const { test: it } = require('./fixtures');\n")).toBe('./fixtures');
    expect(testImportOf("const test = require('@playwright/test').test;\n")).toBe('@playwright/test');
  });

  test('none when the file declares its own test, imports it as a type only, or takes it from nothing', () => {
    expect(
      testImportOf("import { test as base } from '@playwright/test';\nexport const test = base.extend({});"),
    ).toBeNull();
    expect(testImportOf("const base = require('@playwright/test');\nconst test = base.test.extend({});")).toBeNull();
    expect(testImportOf("import { test } from './fixtures';\nfunction test() {}")).toBeNull();
    expect(testImportOf("import type { test } from './fixtures';")).toBeNull();
    expect(testImportOf("// import { test } from './fixtures';\nconst x = 1;")).toBeNull();
    expect(testImportOf('')).toBeNull();
  });
});

describe('expectModuleOf', () => {
  test('the module test comes from when it is @playwright/test, or when the file or a spec beside it imports expect from it', () => {
    expect(expectModuleOf("import { test } from '@playwright/test';")).toBe('@playwright/test');
    expect(expectModuleOf("import { test, expect } from './fixtures';")).toBe('./fixtures');
    expect(expectModuleOf("import { test } from './fixtures';")).toBe('@playwright/test');
    const fixtures = "import { test } from './fixtures';";
    expect(expectModuleOf(fixtures, { siblings: () => ["import { test, expect } from './fixtures';"] })).toBe(
      './fixtures',
    );
    expect(
      expectModuleOf(fixtures, {
        siblings: () => ["import { test, expect } from '@playwright/test';", "import { expect } from './other';"],
      }),
    ).toBe('@playwright/test');
    expect(
      expectModuleOf("const { test } = require('./fixtures');", {
        siblings: () => ["const { test, expect } = require('./fixtures');"],
      }),
    ).toBe('./fixtures');
    expect(expectModuleOf('')).toBe('@playwright/test');
  });

  test('the specs beside the file are read only when the module could export expect', () => {
    let read = 0;
    const siblings = () => {
      read++;
      return [];
    };
    expectModuleOf("import { test } from '@playwright/test';", { siblings });
    expectModuleOf("import { test, expect } from './fixtures';", { siblings });
    expect(read).toBe(0);
    expectModuleOf("import { test } from './fixtures';", { siblings });
    expect(read).toBe(1);
  });
});
