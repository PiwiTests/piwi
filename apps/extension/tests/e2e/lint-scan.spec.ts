import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(here, '..', '..', 'dist');

interface ExposedFinding {
  tag: string;
  role: string;
  accessibleName: string | null;
  bestScore: number;
  suggestion: {
    kind: 'element' | 'container' | 'scope';
    attribute: string;
    value: string;
    locator: string;
    source?: string;
    container?: string;
    text?: string;
  };
}

const values = (findings: ExposedFinding[]) => findings.map((f) => f.suggestion.value);

/**
 * `scanForLintIssues` calls @piwitests/core's `generateAlternatives`, which
 * has its own web of private module-level helpers (`attr`, `esc`, etc.) —
 * unlike `derivePattern`, stringifying it alone via
 * `Function.prototype.toString()` can't carry those along, and they aren't
 * exported to install individually either. Driving the real built
 * `lint-overlay.js` and reading the findings it bridges out to
 * `globalThis.__piwiLintFindings` (see that file) exercises the real,
 * fully-bundled function instead.
 */
async function scan(page: Page): Promise<ExposedFinding[]> {
  await page.addScriptTag({ path: path.join(DIST, 'lint-overlay.js') });
  const findings = (await (
    await page.waitForFunction(() => (globalThis as any).__piwiLintFindings as ExposedFinding[] | undefined)
  ).jsonValue()) as ExposedFinding[];
  // Tear the overlay back down so each test starts clean and to mirror how
  // a real user would dismiss it — a second trigger of the same script toggles it off.
  await page.addScriptTag({ path: path.join(DIST, 'lint-overlay.js') });
  return findings;
}

test.describe('scanForLintIssues (via the real built lint-overlay.js)', () => {
  test('does not flag a button with a test id', async ({ context }) => {
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body>
      <button data-testid="submit-btn">Submit</button>
    </body></html>`);
    expect(await scan(page)).toEqual([]);
  });

  test('does not flag a button with an accessible name (text content)', async ({ context }) => {
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body>
      <button>Submit</button>
    </body></html>`);
    expect(await scan(page)).toEqual([]);
  });

  test('flags duplicate anonymous buttons with no test id, name, or unique structural anchor', async ({ context }) => {
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body>
      <button></button>
      <button></button>
    </body></html>`);
    const findings = await scan(page);
    expect(findings).toHaveLength(2);
    for (const f of findings) {
      expect(f.tag).toBe('button');
      expect(f.role).toBe('button');
      expect(f.accessibleName).toBeNull();
      expect(f.bestScore).toBeLessThan(50);
    }
    // No name, label, placeholder or heading: the role, made unique.
    expect(findings.map((f) => f.suggestion)).toEqual([
      { kind: 'element', attribute: 'data-testid', value: 'button', source: 'role', locator: "getByTestId('button')" },
      {
        kind: 'element',
        attribute: 'data-testid',
        value: 'button-2',
        source: 'role',
        locator: "getByTestId('button-2')",
      },
    ]);
  });

  test('flags buttons sharing a name no locator tells apart but by position', async ({ context }) => {
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body>
      <button aria-label="Show popup"></button>
      <button aria-label="Show popup"></button>
    </body></html>`);
    const findings = await scan(page);
    expect(findings).toHaveLength(2);
    for (const f of findings) {
      expect(f.accessibleName).toBe('Show popup');
      expect(f.bestScore).toBeLessThan(50);
    }
  });

  test('does not flag buttons sharing a name but showing different text', async ({ context }) => {
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body>
      <button aria-label="Show popup">Details</button>
      <button aria-label="Show popup">History</button>
    </body></html>`);
    expect(await scan(page)).toEqual([]);
  });

  test('suffixes a suggested test id per slug, not with one counter shared across roles', async ({ context }) => {
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body>
      <button></button>
      <input type="checkbox" />
      <button></button>
      <input type="checkbox" />
    </body></html>`);
    const findings = await scan(page);
    expect(values(findings)).toEqual(['button', 'checkbox', 'button-2', 'checkbox-2']);
  });

  test('names a suggested test id after the accessible name, accents and punctuation dropped', async ({ context }) => {
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body>
      <button>Submit order</button>
      <button>Submit order</button>
      <a href="#" aria-label="Café & thé, à emporter !"></a>
      <a href="#" aria-label="Café & thé, à emporter !"></a>
    </body></html>`);
    const findings = await scan(page);
    expect(values(findings)).toEqual([
      'submit-order',
      'submit-order-2',
      'cafe-the-a-emporter',
      'cafe-the-a-emporter-2',
    ]);
    expect(findings.map((f) => f.suggestion.source)).toEqual(['name', 'name', 'name', 'name']);
    expect(findings[0]!.suggestion.locator).toBe("getByTestId('submit-order')");
  });

  test('names a field after its placeholder, and an unnamed button after the nearest heading', async ({ context }) => {
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body>
      <input placeholder="Email address"><input placeholder="Email address">
      <section>
        <h2>Billing</h2>
        <section><h2>Shipping address</h2><button></button><button></button></section>
        <h2>Payment</h2>
      </section>
    </body></html>`);
    const findings = await scan(page);
    expect(values(findings)).toEqual([
      'email-address',
      'email-address-2',
      'shipping-address-button',
      'shipping-address-button-2',
    ]);
    expect(findings.map((f) => f.suggestion.source)).toEqual(['name', 'name', 'heading', 'heading']);
  });

  test('reads the headings once per scan, not once per finding', async ({ context }) => {
    const page = await context.newPage();
    const sections = Array.from(
      { length: 200 },
      (_, i) => `<section><button></button><h2>Order ${i}</h2><div><button></button></div></section>`,
    );
    await page.setContent(`<!doctype html><html><body><main><h1>Orders</h1>${sections.join('')}</main></body></html>`);
    await page.evaluate(() => {
      const g = globalThis as unknown as { __headingQueries: number };
      g.__headingQueries = 0;
      for (const proto of [Element.prototype, Document.prototype, DocumentFragment.prototype]) {
        const original = proto.querySelectorAll;
        proto.querySelectorAll = function (this: ParentNode, selectors: string) {
          if (/\bh2\b/.test(selectors)) g.__headingQueries++;
          return original.call(this, selectors);
        } as typeof original;
      }
    });
    const findings = await scan(page);
    expect(findings).toHaveLength(400);
    // The first button of a section comes before its heading, the second after it.
    expect(values(findings).slice(0, 4)).toEqual([
      'order-0-button',
      'order-0-button-2',
      'order-1-button',
      'order-1-button-2',
    ]);
    expect(findings.every((f) => f.suggestion.source === 'heading')).toBe(true);
    expect(
      await page.evaluate(() => (globalThis as unknown as { __headingQueries: number }).__headingQueries),
    ).toBeLessThanOrEqual(1);
  });

  test('names a button inside a web component after the heading beside it there', async ({ context }) => {
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body><h2>Page</h2><tool-bar></tool-bar><script>
      customElements.define('tool-bar', class extends HTMLElement {
        constructor() {
          super();
          this.attachShadow({ mode: 'open' }).innerHTML = '<div><h3>Formatting</h3><button></button><button></button></div>';
        }
      });
    </script></body></html>`);
    expect(values(await scan(page))).toEqual(['formatting-button', 'formatting-button-2']);
  });

  test('never suggests a test id the page already uses', async ({ context }) => {
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body>
      <a href="/help" data-testid="show-popup">Help</a>
      <button aria-label="Show popup"></button>
      <button aria-label="Show popup"></button>
    </body></html>`);
    expect(values(await scan(page))).toEqual(['show-popup-2', 'show-popup-3']);
  });

  test('puts the test id on the repeated container, named after the text that tells it apart', async ({ context }) => {
    // Generated class names give the ranking no container to scope by, so the buttons stay ambiguous.
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body>
      <div class="grid">
        <div class="css-1q8k3fz"><img alt=""><span class="price">12 €</span><span>Blue mug</span><button>Add to cart</button></div>
        <div class="css-1q8k3fz"><img alt=""><span class="price">12 €</span><span>Red mug</span><button>Add to cart</button></div>
        <div class="css-1q8k3fz"><img alt=""><span class="price">14 €</span><span>Green mug</span><button>Add to cart</button></div>
      </div>
    </body></html>`);
    const findings = await scan(page);
    expect(findings.map((f) => f.suggestion)).toEqual([
      {
        kind: 'container',
        attribute: 'data-testid',
        value: 'blue-mug',
        container: 'div',
        text: 'Blue mug',
        locator: "getByTestId('blue-mug').getByRole('button', { name: 'Add to cart' })",
      },
      expect.objectContaining({ kind: 'container', value: 'red-mug', text: 'Red mug' }),
      // "14 €" is this card's alone too, but a text with words names it better.
      expect.objectContaining({ kind: 'container', value: 'green-mug', text: 'Green mug' }),
    ]);
  });

  test('prefers a heading of the repeated container, and shares one test id among the findings inside it', async ({
    context,
  }) => {
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body>
      <div>
        <div class="row"><span>Draft</span><h3>Invoice 12</h3><button><svg></svg></button><a href="#"><svg></svg></a></div>
        <div class="row"><span>Draft</span><h3>Invoice 13</h3><button><svg></svg></button><a href="#"><svg></svg></a></div>
      </div>
    </body></html>`);
    const findings = await scan(page);
    expect(findings.map((f) => [f.role, f.suggestion.kind, f.suggestion.value, f.suggestion.locator])).toEqual([
      ['button', 'container', 'invoice-12', "getByTestId('invoice-12').getByRole('button')"],
      ['link', 'container', 'invoice-12', "getByTestId('invoice-12').getByRole('link')"],
      ['button', 'container', 'invoice-13', "getByTestId('invoice-13').getByRole('button')"],
      ['link', 'container', 'invoice-13', "getByTestId('invoice-13').getByRole('link')"],
    ]);
  });

  test('scopes by the test id the repeated containers already share, filtered by their text', async ({ context }) => {
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body>
      <div>
        <div data-testid="product-card"><span>Blue mug</span><button><svg></svg></button></div>
        <div data-testid="product-card"><span>Red mug</span><button><svg></svg></button></div>
      </div>
    </body></html>`);
    const findings = await scan(page);
    expect(findings.map((f) => f.suggestion)).toEqual([
      {
        kind: 'scope',
        attribute: 'data-testid',
        value: 'product-card',
        container: 'div',
        text: 'Blue mug',
        locator: "getByTestId('product-card').filter({ hasText: 'Blue mug' }).getByRole('button')",
      },
      expect.objectContaining({ kind: 'scope', text: 'Red mug' }),
    ]);
    // The locator finds that button alone in real Playwright.
    await expect(page.getByTestId('product-card').filter({ hasText: 'Red mug' }).getByRole('button')).toHaveCount(1);
  });

  test('scopes by the text the pick results filter the container by, which no other copy contains', async ({
    context,
  }) => {
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body>
      <div>
        <div data-testid="product-card"><span>Red mug</span><span>12 €</span><button><svg></svg></button></div>
        <div data-testid="product-card"><span>Red mug XL</span><span>14 €</span><button><svg></svg></button></div>
      </div>
    </body></html>`);
    const findings = await scan(page);
    // "Red mug" is in the other card's "Red mug XL" too: filtering by it would find both cards.
    expect(findings.map((f) => [f.suggestion.kind, f.suggestion.text, f.suggestion.locator])).toEqual([
      ['scope', '12 €', "getByTestId('product-card').filter({ hasText: '12 €' }).getByRole('button')"],
      ['scope', 'Red mug XL', "getByTestId('product-card').filter({ hasText: 'Red mug XL' }).getByRole('button')"],
    ]);
    await expect(page.getByTestId('product-card').filter({ hasText: '12 €' }).getByRole('button')).toHaveCount(1);
  });

  test('names the container after a text it shows before one hidden in it', async ({ context }) => {
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body>
      <div class="css-1q8k3fz">
        <div class="css-7tkz2b"><span hidden>n1</span><span>Groceries</span><button><svg></svg></button></div>
        <div class="css-7tkz2b"><span hidden>n2</span><span>Packing list</span><button><svg></svg></button></div>
      </div>
    </body></html>`);
    const findings = await scan(page);
    expect(findings.map((f) => [f.suggestion.kind, f.suggestion.value])).toEqual([
      ['container', 'groceries'],
      ['container', 'packing-list'],
    ]);
  });

  test('keeps the test id on the element when no text tells its container apart', async ({ context }) => {
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body>
      <div>
        <div class="card"><span>Red mug</span><button>Add to cart</button></div>
        <div class="card"><span>Red mug</span><button>Add to cart</button></div>
      </div>
    </body></html>`);
    const findings = await scan(page);
    expect(findings.map((f) => [f.suggestion.kind, f.suggestion.value])).toEqual([
      ['element', 'add-to-cart'],
      ['element', 'add-to-cart-2'],
    ]);
  });

  test('copies a checklist naming each fix', async ({ context }) => {
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body>
      <button>Submit order</button><button>Submit order</button>
      <div>
        <div class="card"><span>Blue mug</span><button><svg></svg></button></div>
        <div class="card"><span>Red mug</span><button><svg></svg></button></div>
      </div>
    </body></html>`);
    await page.addScriptTag({ path: path.join(DIST, 'lint-overlay.js') });
    const checklist = await (
      await page.waitForFunction(() => (globalThis as any).__piwiLintChecklist as string | undefined)
    ).jsonValue();
    expect(checklist!.split('\n')).toEqual([
      '- [ ] `button` (role: button "Submit order"): add `data-testid="submit-order"`',
      '- [ ] `button` (role: button "Submit order"): add `data-testid="submit-order-2"`',
      '- [ ] `button` (role: button): add `data-testid="blue-mug"` to the repeated `<div>` holding "Blue mug", then `getByTestId(\'blue-mug\').getByRole(\'button\')`',
      '- [ ] `button` (role: button): add `data-testid="red-mug"` to the repeated `<div>` holding "Red mug", then `getByTestId(\'red-mug\').getByRole(\'button\')`',
    ]);
  });

  test('checks every button of a long table, its rows and cells aside', async ({ context }) => {
    const page = await context.newPage();
    const rows = Array.from({ length: 300 }, () => '<tr><td>Item</td><td>12 €</td><td><button></button></td></tr>');
    await page.setContent(`<!doctype html><html><body><table><tbody>${rows.join('')}</tbody></table></body></html>`);
    const findings = await scan(page);
    expect(findings).toHaveLength(300);
    expect(findings[findings.length - 1]).toMatchObject({ role: 'button', suggestion: { value: 'button-300' } });
  });

  test('checks a 1,000-row table with a Delete button per row', async ({ context }) => {
    const page = await context.newPage();
    // Twenty texts a row, every one but the name shared with other rows: each row's Delete button is narrowed by
    // the row showing its name, after the shared texts are tried against every row.
    const shared = ['Active', 'Admin', 'France', 'Paris', 'EUR', 'Premium', 'Yes', 'No', 'Monthly', 'Card'];
    const rows = Array.from({ length: 1000 }, (_, i) => {
      const cells = [`Customer ${i}`, ...shared, ...shared.map((s) => `${s} plan`).slice(0, 9)];
      return `<tr>${cells.map((c) => `<td>${c}</td>`).join('')}<td><button>Delete</button></td></tr>`;
    });
    await page.setContent(`<!doctype html><html><body><table><tbody>${rows.join('')}</tbody></table></body></html>`);
    // The ranking finds each button through its row: nothing to lint. How many texts the narrowing reads is
    // counted in multi-pick-derive.spec.ts; the time a runner takes is not checked here.
    expect(await scan(page)).toEqual([]);
  });

  test('checks the elements inside a web component', async ({ context }) => {
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body><toolbar-buttons></toolbar-buttons><script>
      customElements.define('toolbar-buttons', class extends HTMLElement {
        constructor() {
          super();
          this.attachShadow({ mode: 'open' }).innerHTML = '<button></button><button></button>';
        }
      });
    </script></body></html>`);
    const findings = await scan(page);
    expect(values(findings)).toEqual(['button', 'button-2']);
  });

  test('leaves the page responsive while it checks a long table', async ({ context }) => {
    const page = await context.newPage();
    const rows = Array.from({ length: 300 }, () => '<tr><td>Item</td><td><button></button></td></tr>');
    await page.setContent(`<!doctype html><html><body><table><tbody>${rows.join('')}</tbody></table></body></html>`);
    await page.evaluate(() => {
      const g = globalThis as unknown as { __longTasks: number[] };
      g.__longTasks = [];
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) g.__longTasks.push(entry.duration);
      }).observe({ type: 'longtask', buffered: true });
    });
    expect(await scan(page)).toHaveLength(300);
    const longest = await page.evaluate(() =>
      Math.max(0, ...(globalThis as unknown as { __longTasks: number[] }).__longTasks),
    );
    expect(longest).toBeLessThan(500);
  });

  test('leaves out the elements hidden from the accessibility tree, as getByRole does', async ({ context }) => {
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body>
      <div style="display:none"><button></button><button></button></div>
      <div aria-hidden="true"><button></button></div>
      <button data-testid="submit-btn">Submit</button>
    </body></html>`);
    expect(await scan(page)).toEqual([]);
  });

  test('ignores non-interactive roles (headings, regions) even when anonymous', async ({ context }) => {
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body>
      <h2></h2>
      <nav></nav>
    </body></html>`);
    expect(await scan(page)).toEqual([]);
  });
});
