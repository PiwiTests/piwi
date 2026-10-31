import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from '@playwright/test';
import { parseLocatorChain } from '@piwitests/core/locator-chain';
import { chainToStructured, groundElement, refLocator } from '../src/internal/ai/ground.js';
import { ariaSnapshotBestEffort } from '../src/internal/capture/capture-fixtures.js';
import { buildLocator } from '../src/internal/ai/interpreter.js';
import { playwrightAtLeast } from './_helpers.js';

const PAGE = `
  <main>
    <h1>Welcome, Ada</h1>
    <button>Save</button>
    <dialog open aria-label="Edit profile">
      <button>Save</button>
      <label>Email <input></label>
      <input data-testid="nickname">
    </dialog>
    <ul><li>Apples <button>Remove</button></li><li>Pears <button>Remove</button></li></ul>
  </main>`;

let browser: Browser | null = null;

beforeAll(async () => {
  try {
    browser = await chromium.launch();
  } catch {
    browser = null;
  }
}, 60_000);

afterAll(async () => {
  await browser?.close();
});

/** A page showing `PAGE`, and the ref of each snapshot line matching `pattern`, in order. */
async function pageWithRefs(pattern: RegExp): Promise<{ page: Page; refs: string[] }> {
  const page = await browser!.newPage();
  await page.setContent(PAGE);
  const snapshot = (await ariaSnapshotBestEffort(page.locator('body'))) ?? '';
  const refs = snapshot
    .split('\n')
    .filter((line) => pattern.test(line))
    .map((line) => /\[ref=(\w+)\]/.exec(line)?.[1] ?? '');
  return { page, refs };
}

describe('chainToStructured', () => {
  it('keeps a chain of builder calls, masking param values', () => {
    const chain = parseLocatorChain("getByRole('dialog', { name: 'Edit Ada' }).getByRole('button', { name: 'Save' })");
    expect(chainToStructured(chain.calls, { name: 'Ada' })).toEqual({
      method: 'getByRole',
      args: ['dialog', { name: 'Edit {{name}}' }],
      chain: [{ method: 'getByRole', args: ['button', { name: 'Save' }] }],
    });
  });

  it('refuses positions, filters, CSS selectors and regexes', () => {
    for (const expr of [
      "getByRole('button', { name: 'Save' }).first()",
      "locator('#mui-1234').getByRole('button', { name: 'Save' })",
      "getByRole('listitem').filter({ hasText: 'Pears' }).getByRole('button')",
      'getByText(/save/i)',
    ]) {
      expect(chainToStructured(parseLocatorChain(expr).calls)).toBeNull();
    }
  });

  it('keeps a test id verbatim, even when it contains a param value', () => {
    const chain = parseLocatorChain("getByTestId('nickname')");
    expect(chainToStructured(chain.calls, { name: 'nick' })).toEqual({ method: 'getByTestId', args: ['nickname'] });
  });
});

describe('groundElement', () => {
  it('keeps the role + name locator when it matches the referenced element alone', async (ctx) => {
    if (!browser) return ctx.skip();
    const { page, refs } = await pageWithRefs(/textbox "Email"/);
    const compiled = await groundElement(page, { role: 'textbox', name: 'Email', ref: refs[0] }, {});
    expect(compiled?.locator).toEqual({ method: 'getByRole', args: ['textbox', { name: 'Email' }] });
    await page.close();
  });

  it('scopes an ambiguous role + name to the element the model chose', async (ctx) => {
    if (!browser) return ctx.skip();
    const { page, refs } = await pageWithRefs(/button "Save"/);
    expect(refs).toHaveLength(2);
    const compiled = await groundElement(page, { role: 'button', name: 'Save', ref: refs[1] }, {});
    // The scope is Playwright's normalize(): the dialog's role from 1.63, its label before.
    const scope = playwrightAtLeast('1.63')
      ? { method: 'getByRole', args: ['dialog', { name: 'Edit profile' }] }
      : { method: 'getByLabel', args: ['Edit profile'] };
    expect(compiled?.locator).toEqual({
      ...scope,
      chain: [{ method: 'getByRole', args: ['button', { name: 'Save' }] }],
    });
    expect(compiled?.fingerprint).toMatchObject({ role: 'button', name: 'Save' });
    expect(await buildLocator(page, compiled!.locator).evaluate((el) => !!el.closest('dialog'))).toBe(true);
    await page.close();
  });

  it('addresses an element without an accessible name through its ref', async (ctx) => {
    if (!browser) return ctx.skip();
    const { page, refs } = await pageWithRefs(/textbox \[ref=/);
    const compiled = await groundElement(page, { role: 'textbox', ref: refs[0] }, {});
    expect(compiled?.locator).toEqual({ method: 'getByTestId', args: ['nickname'] });
    await page.close();
  });

  it('masks a param value in the grounded locator', async (ctx) => {
    if (!browser) return ctx.skip();
    const { page, refs } = await pageWithRefs(/heading "Welcome, Ada"/);
    const compiled = await groundElement(
      page,
      { role: 'heading', name: 'Welcome, {{name}}', ref: refs[0] },
      { name: 'Ada' },
    );
    expect(JSON.stringify(compiled?.locator)).toContain('{{name}}');
    await page.close();
  });

  it('keeps the role + name locator when the ref names no element or only a position tells them apart', async (ctx) => {
    if (!browser) return ctx.skip();
    const { page, refs } = await pageWithRefs(/button "Remove"/);
    const byRole = { method: 'getByRole', args: ['button', { name: 'Remove' }] };
    expect((await groundElement(page, { role: 'button', name: 'Remove', ref: 'e999' }, {}))?.locator).toEqual(byRole);
    expect((await groundElement(page, { role: 'button', name: 'Remove', ref: refs[1] }, {}))?.locator).toEqual(byRole);
    expect(await groundElement(page, { role: 'textbox', ref: 'e999' }, {})).toBeNull();
    await page.close();
  });

  it('keeps the role + name locator when it does not match the referenced element at all', async (ctx) => {
    if (!browser) return ctx.skip();
    const { page, refs } = await pageWithRefs(/button "Save"/);
    const compiled = await groundElement(page, { role: 'button', name: 'Remove', ref: refs[1] }, {});
    expect(compiled?.locator).toEqual({ method: 'getByRole', args: ['button', { name: 'Remove' }] });
    await page.close();
  });
});

describe('refLocator', () => {
  it('refuses a ref that is not a plain token', async (ctx) => {
    if (!browser) return ctx.skip();
    const page = await browser.newPage();
    expect(await refLocator(page, 'e1 >> css=body')).toBeNull();
    await page.close();
  });
});
