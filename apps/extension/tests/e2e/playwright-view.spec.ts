import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures.js';
import { stubChromeI18n } from './i18n-stub.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(here, '..', '..', 'dist');

const SHOP = `<!doctype html><html><body style="min-height:3000px;padding-top:200px">
  <nav><a href="/cart">Cart (2)</a></nav>
  <main>
    <label>Coupon <input name="coupon"></label>
    <button class="btn" data-testid="apply-coupon">Apply coupon</button>
    <button>Show popup</button>
    <button>Show popup</button>
    <button class="icon"><svg width="10" height="10"></svg></button>
    <div class="fake-button" onclick="void 0">Checkout</div>
    <div class="card" style="cursor:pointer"><span>Blue mug</span></div>
    <p>Plain text is not labelled.</p>
    <button hidden>Hidden</button>
  </main>
</body></html>`;

interface ViewSummary {
  tag: string;
  role: string | null;
  name: string;
  testId: string | null;
  mark: 'unreachable' | 'ambiguous' | null;
  count: number;
}

async function openView(page: Page): Promise<ViewSummary[]> {
  await page.addScriptTag({ path: path.join(DIST, 'playwright-view.js') });
  await expect
    .poll(() => page.evaluate(() => (globalThis as { __piwiPlaywrightView?: unknown }).__piwiPlaywrightView))
    .toBeTruthy();
  return page.evaluate(() => (globalThis as unknown as { __piwiPlaywrightView: ViewSummary[] }).__piwiPlaywrightView);
}

interface LabelRect {
  text: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** The boxes of the labels drawn, in page order. */
function labelBoxes(page: Page): Promise<LabelRect[]> {
  return page.locator('#piwi-playwright-view-host .tag').evaluateAll((nodes) =>
    nodes.map((node) => {
      const r = node.getBoundingClientRect();
      return { text: node.textContent ?? '', left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    }),
  );
}

/** Every pair of labels whose boxes intersect. */
function overlaps(boxes: LabelRect[]): string[] {
  const pairs: string[] = [];
  for (const [i, a] of boxes.entries()) {
    for (const b of boxes.slice(i + 1)) {
      if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) {
        pairs.push(`${a.text} / ${b.text}`);
      }
    }
  }
  return pairs;
}

test.describe('Playwright view', () => {
  test.beforeEach(async ({ context }) => {
    await context.addInitScript(() => {
      (globalThis as { __piwiTestOpenShadow?: boolean }).__piwiTestOpenShadow = true;
    });
    await stubChromeI18n(context);
  });

  test('labels what getByRole sees, and marks the unreachable and the ambiguous', async ({ context }) => {
    const page = await context.newPage();
    await page.setContent(SHOP);
    const labels = await openView(page);
    const find = (role: string | null, name: string) => labels.find((l) => l.role === role && l.name === name);

    expect(find('link', 'Cart (2)')).toMatchObject({ mark: null });
    expect(find('textbox', 'Coupon')).toMatchObject({ mark: null });
    expect(find('button', 'Apply coupon')).toMatchObject({ testId: 'apply-coupon', mark: null });
    expect(labels.filter((l) => l.role === 'button' && l.name === 'Show popup')).toEqual([
      expect.objectContaining({ mark: 'ambiguous', count: 2 }),
      expect.objectContaining({ mark: 'ambiguous', count: 2 }),
    ]);
    // A button with no name, a clickable div, a card with a pointer cursor: no stable locator reaches them.
    expect(find('button', '')).toMatchObject({ mark: 'unreachable' });
    expect(labels.filter((l) => l.role === null && l.mark === 'unreachable').map((l) => l.tag)).toEqual(['div', 'div']);
    // Its text inherits the pointer and is not marked again; hidden elements and plain text get no label.
    expect(labels.some((l) => l.tag === 'span' || l.tag === 'p' || l.name === 'Hidden')).toBe(false);

    // The same answers as real Playwright.
    await expect(page.getByRole('button', { name: 'Show popup' })).toHaveCount(2);
    await expect(page.getByRole('button', { name: 'Apply coupon' })).toHaveCount(1);

    const host = page.locator('#piwi-playwright-view-host');
    await expect(host.getByText('button · Apply coupon')).toBeVisible();
    await expect(host.getByText('apply-coupon', { exact: true })).toBeVisible();
    await expect(host.getByText('div · (no role)')).toHaveCount(2);
    await expect(host.getByText('3 no stable locator reaches (red)')).toBeVisible();
    await expect(host.getByText('2 whose role and name find others too (amber)')).toBeVisible();
  });

  test('counts what real Playwright counts: names inside others, any case, hidden copies, web components', async ({
    context,
  }) => {
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body>
      <nav><a href="/1">Product 1</a><a href="/10">Product 10</a><a href="/11">PRODUCT 11</a><a href="/2">Product 2</a></nav>
      <main>
        <button>Save</button><button>save   draft</button><button aria-label="Save all">x</button>
        <button style="display:none">Save</button><button aria-hidden="true">Save</button>
        <h2>Orders</h2><h2>Past orders</h2><h3>Orders today</h3>
        <form-buttons></form-buttons>
      </main>
      <script>
        customElements.define('form-buttons', class extends HTMLElement {
          constructor() {
            super();
            this.attachShadow({ mode: 'open' }).innerHTML = '<button>Save</button><a href="/3">Product 3</a>';
          }
        });
      </script>
    </body></html>`);
    const labels = await openView(page);
    await page.addScriptTag({ path: path.join(DIST, 'playwright-view.js') });
    await expect(page.locator('#piwi-playwright-view-host')).toHaveCount(0);

    const named = labels.filter((l) => l.role && l.name && l.mark !== 'unreachable');
    // Page order, the web component's own elements after the page's.
    expect(named.map((l) => `${l.role} · ${l.name} · ${l.count}`)).toEqual([
      'link · Product 1 · 3',
      'link · Product 10 · 1',
      'link · PRODUCT 11 · 1',
      'link · Product 2 · 1',
      'button · Save · 4',
      'button · save draft · 1',
      'button · Save all · 1',
      'heading · Orders · 3',
      'heading · Past orders · 1',
      'heading · Orders today · 1',
      'button · Save · 4',
      'link · Product 3 · 1',
    ]);
    for (const label of named) {
      await expect(page.getByRole(label.role as 'button', { name: label.name })).toHaveCount(label.count);
    }
  });

  test('labels a page of 4,000 links without a long freeze', async ({ context }) => {
    const page = await context.newPage();
    const links = Array.from({ length: 4000 }, (_, i) => `<li><a href="/p/${i}">Product ${i}</a></li>`).join('');
    await page.setContent(`<!doctype html><html><body><ul>${links}</ul></body></html>`);
    await page.evaluate(() => {
      const g = globalThis as unknown as { __longTasks: number[] };
      g.__longTasks = [];
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) g.__longTasks.push(entry.duration);
      }).observe({ type: 'longtask', buffered: true });
    });
    const labels = await openView(page);
    expect(labels).toHaveLength(4000);
    // "Product 1" finds "Product 10" to "Product 1999" too: 1 + 10 + 100 + 1,000 links.
    expect(labels.find((l) => l.name === 'Product 1')).toMatchObject({ mark: 'ambiguous', count: 1111 });
    expect(labels.filter((l) => l.mark === 'ambiguous')).toHaveLength(399);
    const longest = await page.evaluate(() =>
      Math.max(0, ...(globalThis as unknown as { __longTasks: number[] }).__longTasks),
    );
    expect(longest).toBeLessThan(500);
  });

  test('lays the labels of adjacent elements out so that none overlaps another', async ({ context }) => {
    const page = await context.newPage();
    await page.setViewportSize({ width: 1000, height: 700 });
    const stars = Array.from(
      { length: 5 },
      (_, i) => `<button aria-label="Rate ${i + 1} stars" style="width:20px;height:20px;padding:0">★</button>`,
    ).join('');
    await page.setContent(`<!doctype html><html><body style="margin:0;padding:40px 8px">
      <div style="display:flex;gap:4px"><a href="/products">Products</a><a href="/deals">Deals</a><a href="/account">Account</a></div>
      <div style="display:flex;gap:2px;margin-top:6px">${stars}</div>
      <form style="display:flex;gap:0;margin-top:2px"><input aria-label="Quantity" style="width:40px"><button>Add to cart</button><button>Save for later</button></form>
    </body></html>`);
    const labels = await openView(page);
    expect(labels).toHaveLength(11);

    const host = page.locator('#piwi-playwright-view-host');
    const tags = host.locator('.tag');
    await expect(tags).toHaveCount(11);
    await expect(host.locator('.crowded')).toBeHidden();
    const boxes = await labelBoxes(page);
    expect(overlaps(boxes)).toEqual([]);
    // The first label keeps its place above its element; the others stay within a few rows of theirs.
    const products = (await page.getByRole('link', { name: 'Products' }).boundingBox())!;
    expect(boxes[0]!.text).toBe('link · Products');
    expect(boxes[0]!.left).toBeCloseTo(products.x, 1);
    expect(boxes[0]!.bottom).toBeCloseTo(products.y, 1);
    const anchors = await page
      .locator('a, button, input')
      .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().top));
    for (const [i, box] of boxes.entries()) expect(Math.abs(box.top - anchors[i]!)).toBeLessThan(120);
  });

  test('leaves out the labels with no free place near their element, and says how many', async ({ context }) => {
    const page = await context.newPage();
    await page.setViewportSize({ width: 1000, height: 700 });
    const cells = Array.from(
      { length: 400 },
      (_, i) => `<button aria-label="Seat ${i + 1}" style="width:10px;height:10px;padding:0;border:0"></button>`,
    ).join('');
    await page.setContent(`<!doctype html><html><body style="margin:0;padding:200px">
      <div style="display:grid;grid-template-columns:repeat(20,10px);gap:0">${cells}</div>
    </body></html>`);
    await openView(page);

    const host = page.locator('#piwi-playwright-view-host');
    await expect(host.locator('.crowded')).toBeVisible();
    const drawn = await host.locator('.tag').count();
    const crowded = Number((await host.locator('.crowded').textContent())!.match(/\d+/)![0]);
    expect(drawn).toBeGreaterThan(0);
    expect(drawn + crowded).toBe(400);
    await expect(host.locator('.crowded')).toHaveText(
      `${crowded} labels left out, too close to others: choose a role to see them`,
    );
    expect(overlaps(await labelBoxes(page))).toEqual([]);
  });

  test('filters by role, follows scrolling, scans again after a change, and toggles off', async ({ context }) => {
    const page = await context.newPage();
    await page.setContent(SHOP);
    await openView(page);
    const host = page.locator('#piwi-playwright-view-host');

    await host.getByRole('combobox', { name: 'Role' }).selectOption('link');
    await expect(host.locator('.tag')).toHaveCount(1);
    await expect(host.locator('.tag')).toHaveText('link · Cart (2)');
    const before = await host.locator('.tag').boundingBox();
    await page.mouse.wheel(0, 40);
    await expect.poll(async () => (await host.locator('.tag').boundingBox())?.y).toBeLessThan(before!.y);

    await host.getByRole('combobox', { name: 'Role' }).selectOption('');
    await page.evaluate(() => {
      const button = document.createElement('button');
      button.textContent = 'Added later';
      document.querySelector('main')!.appendChild(button);
    });
    await expect(host.getByText('button · Added later')).toBeVisible();

    await page.addScriptTag({ path: path.join(DIST, 'playwright-view.js') });
    await expect(host).toHaveCount(0);
  });

  test('its panel is a named region, not a dialog, and its × turns the view off', async ({ context }) => {
    const page = await context.newPage();
    await page.setContent(SHOP);
    await openView(page);
    const host = page.locator('#piwi-playwright-view-host');
    const region = host.getByRole('region', { name: 'Playwright view' });
    await expect(region).toBeVisible();
    await expect(host.getByRole('dialog')).toHaveCount(0);
    await region.getByRole('button', { name: 'Close the Playwright view' }).click();
    await expect(host).toHaveCount(0);
  });
});
