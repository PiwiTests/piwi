import { test, expect, selectors, type Page } from '@playwright/test';
import { parseLocatorChain } from '@piwitests/core/locator-chain';
import { engineBundle, servePages, tagElements } from './engine-bundle.js';
import { CONTAINER_CASES, CONTAINER_NARROWING, EDGE_CASES, LOCATOR_CASES, SCOPING_CASES } from './locator-cases.js';
import { playwrightLocator } from './playwright-locator.js';

/**
 * The extension's locator engine against Playwright itself: every expression
 * is resolved by the real test runner and by the engine on the same page, and
 * the two must return the same elements in the same order, or both refuse the
 * expression. Elements are compared by a `data-eid` tag set on every element
 * of every frame beforehand.
 */

const ORIGIN = 'https://engine.test';

/** Expressions Playwright itself rejects; the engine must reject them too. */
const EXPECTED_REFUSALS = new Set([
  "getByRole('button', { checked: true })",
  "getByRole('link', { level: 1 })",
  "locator('invalid[[[')",
  "locator('button:nth-match(2)')",
  "frameLocator('#f1').filter({ hasText: 'Pay' })",
  "locator('#f2').contentFrame().or(getByRole('button', { name: 'Top' }))",
  "frameLocator('#f1')",
  "frameLocator('section').getByRole('button')",
  "locator('div:has-text(Payment)')",
  "locator('p:text(welcome)')",
  "locator('span:text-is(Only)')",
  'locator(\':text-matches("Hel+o", i)\')',
  "locator('div::before')",
  "locator('main > > article')",
  "frameLocator().getByRole('button')",
  "frameLocator().first().getByRole('button')",
  'frameLocator().owner()',
  "frameLocator().getByText('Enter the code sent to your phone')",
  "frameLocator().getByLabel('Code').or(frameLocator().getByText('Verify'))",
  "getByRole('button', { name: 'Submit' }).or(frameLocator('#child-frame').getByRole('button'))",
  "getByRole('button', { name: 'Submit' }).and(locator('#child-frame').contentFrame().getByRole('button'))",
  "locator('section').filter({ has: frameLocator('#child-frame').getByRole('button') })",
  "locator('body').filter({ hasNot: frameLocator('#child-frame').getByText('Cancel') })",
  "locator('main').locator(frameLocator('#child-frame').getByRole('button'))",
  "frameLocator('#child-frame').getByRole('button').or(frameLocator('iframe').getByText('Card details'))",
  "frameLocator('#child-frame').getByRole('button').or(frameLocator('#child-frame').frameLocator('#grandchild').getByRole('button'))",
]);

interface Outcome {
  ids?: Array<string | null>;
  error?: string;
}

async function playwrightOutcome(page: Page, expression: string): Promise<Outcome> {
  try {
    const locator = playwrightLocator(page, parseLocatorChain(expression));
    const ids = await Promise.race([
      locator.evaluateAll((elements) => elements.map((e) => e.getAttribute('data-eid'))),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out')), 5000)),
    ]);
    return { ids };
  } catch (error) {
    return { error: (error as Error).message.split('\n')[0] };
  }
}

async function engineOutcomes(
  page: Page,
  expressions: string[],
  testIdAttributes?: string[],
  strict = false,
): Promise<Outcome[]> {
  return page.evaluate(
    ([list, attributes, strictFrames]) =>
      (
        globalThis as unknown as {
          __piwiEngineQueryAll: (e: string[], a?: string[], s?: boolean) => Outcome[];
        }
      ).__piwiEngineQueryAll(list, attributes, strictFrames),
    [expressions, testIdAttributes, strict] as const,
  );
}

async function openFixture(page: Page, file = 'locator-kinds.html'): Promise<void> {
  await servePages(page, ORIGIN);
  await page.goto(`${ORIGIN}/${file}`);
  const frames: Record<string, string[]> = {
    'locator-kinds.html': ['#child-frame'],
    'locator-scoping.html': ['#f1', '#f2'],
  };
  for (const owner of frames[file] ?? []) {
    await page.frameLocator(owner).frameLocator('#grandchild').getByRole('button', { name: 'Verify' }).waitFor();
  }
  await tagElements(page);
  await page.addScriptTag({ path: await engineBundle() });
}

function describe(outcome: Outcome): string {
  return outcome.error !== undefined ? `error: ${outcome.error}` : JSON.stringify(outcome.ids);
}

async function compare(page: Page, expressions: string[], testIdAttributes?: string[]) {
  const engine = await engineOutcomes(page, expressions, testIdAttributes);
  const mismatches: string[] = [];
  let matchedSomething = 0;
  for (const [i, expression] of expressions.entries()) {
    const expected = await playwrightOutcome(page, expression);
    const actual = engine[i]!;
    if (expected.ids?.length) matchedSomething++;
    const agree =
      expected.error !== undefined
        ? actual.error !== undefined
        : actual.error === undefined && JSON.stringify(actual.ids) === JSON.stringify(expected.ids);
    if (expected.error !== undefined && !EXPECTED_REFUSALS.has(expression)) {
      mismatches.push(`${expression}\n    unexpectedly refused by Playwright: ${expected.error}`);
    }
    if (!agree) {
      mismatches.push(`${expression}\n    playwright: ${describe(expected)}\n    engine:     ${describe(actual)}`);
    }
  }
  return { mismatches, matchedSomething };
}

test.describe('locator engine matches Playwright', () => {
  for (const [group, expressions] of Object.entries(LOCATOR_CASES)) {
    test(group, async ({ page }) => {
      await openFixture(page);
      const { mismatches, matchedSomething } = await compare(page, expressions);
      expect(mismatches, mismatches.join('\n')).toEqual([]);
      // The fixture really loaded: most expressions of every group find something.
      expect(matchedSomething).toBeGreaterThan(expressions.length / 3);
    });
  }

  for (const [group, expressions] of Object.entries(EDGE_CASES)) {
    test(`edge cases: ${group}`, async ({ page }) => {
      await openFixture(page, 'locator-edge-cases.html');
      const { mismatches, matchedSomething } = await compare(page, expressions);
      expect(mismatches, mismatches.join('\n')).toEqual([]);
      expect(matchedSomething).toBeGreaterThan(expressions.length / 3);
    });
  }

  for (const [group, expressions] of Object.entries(SCOPING_CASES)) {
    test(`scoping: ${group}`, async ({ page }) => {
      await openFixture(page, 'locator-scoping.html');
      const { mismatches, matchedSomething } = await compare(page, expressions);
      expect(mismatches, mismatches.join('\n')).toEqual([]);
      expect(matchedSomething).toBeGreaterThan(expressions.length / 3);
    });
  }

  for (const [group, expressions] of Object.entries(CONTAINER_CASES)) {
    test(`containers: ${group}`, async ({ page }) => {
      await openFixture(page, 'locator-containers.html');
      const { mismatches, matchedSomething } = await compare(page, expressions);
      expect(mismatches, mismatches.join('\n')).toEqual([]);
      expect(matchedSomething).toBeGreaterThan(expressions.length / 3);
    });
  }

  test('a candidate is narrowed inside the repeated container it sits in, by a text of that container', async ({
    page,
  }) => {
    await openFixture(page, 'locator-containers.html');
    for (const { name, target, candidate, ...expected } of CONTAINER_NARROWING) {
      const checked = await page.evaluate(
        ([selector, locator]) =>
          (
            globalThis as unknown as {
              __piwiCheckLocators: (s: string, l: string[]) => Array<{ locator: string; verdict: string }>;
            }
          ).__piwiCheckLocators(selector, [locator]),
        [target, candidate] as const,
      );
      expect(checked, name).toEqual([expected]);
      expect(await playwrightOutcome(page, expected.locator), name).toEqual({
        ids: [await page.locator(target).getAttribute('data-eid')],
      });
    }
  });

  test('the top locator of a button in a card is scoped to the card, not taken by position', async ({ page }) => {
    await openFixture(page, 'locator-containers.html');
    for (const withEngine of [true, false]) {
      const ranked = await page.evaluate(
        (w) =>
          (
            globalThis as unknown as {
              __piwiRankTop: (s: string, w: boolean) => { role: string | null; locator: string | null };
            }
          ).__piwiRankTop('#add-red-mug', w),
        withEngine,
      );
      expect(ranked.locator, `counted by ${withEngine ? 'an engine' : 'the probe'}`).toBe(
        "getByTestId('product-card').filter({ hasText: 'Red mug' }).getByRole('button', { name: 'Add to cart' })",
      );
    }
  });

  test('a strict engine refuses several frame owners, as an action does', async ({ page }) => {
    await openFixture(page, 'locator-scoping.html');
    const expressions = [
      "frameLocator('iframe').getByRole('button', { name: 'Cancel' })",
      "frameLocator('iframe').first().getByRole('button', { name: 'Cancel' })",
      "frameLocator('#f2').getByRole('button', { name: 'Cancel' })",
    ];
    const engine = await engineOutcomes(page, expressions, undefined, true);
    expect(engine[0]!.error).toMatch(/strict mode violation/);
    for (const [i, expression] of expressions.entries()) {
      const action = await playwrightLocator(page, expression)
        .click({ trial: true, timeout: 2000 })
        .then(() => null)
        .catch((error: Error) => error.message.split('\n')[0]!);
      expect(engine[i]!.error !== undefined, `${expression}: playwright ${action ?? 'clicked'}`).toBe(action !== null);
      if (action === null) expect(engine[i]!.ids).toHaveLength(1);
    }
  });

  test('getByTestId reads the configured test id attribute', async ({ page }) => {
    await openFixture(page);
    const expressions = [
      "getByTestId('product')",
      "getByTestId('footer-cta')",
      "getByTestId('pay')",
      "getByRole('region').getByTestId('product').nth(1)",
    ];
    selectors.setTestIdAttribute('data-qa');
    try {
      const { mismatches, matchedSomething } = await compare(page, expressions, ['data-qa']);
      expect(mismatches, mismatches.join('\n')).toEqual([]);
      expect(matchedSomething).toBe(3);
    } finally {
      selectors.setTestIdAttribute('data-testid');
    }
  });

  test('the ranking gives each element the role Playwright gives it', async ({ page }) => {
    await openFixture(page);
    const cases = [
      { selector: 'thead th', role: 'columnheader', top: "getByRole('columnheader', { name: 'Order' })" },
      { selector: 'tbody th[scope=row]', role: 'rowheader', top: "getByRole('rowheader', { name: '#1001' })" },
      { selector: '[role=grid] td', role: 'gridcell', top: "getByRole('gridcell', { name: 'A1' })" },
    ];
    for (const { selector, role, top } of cases) {
      const eid = await page.locator(selector).first().getAttribute('data-eid');
      for (const withEngine of [true, false]) {
        const ranked = await page.evaluate(
          ([s, w]) =>
            (
              globalThis as unknown as {
                __piwiRankTop: (s: string, w: boolean) => { role: string | null; locator: string | null };
              }
            ).__piwiRankTop(s, w),
          [selector, withEngine] as const,
        );
        expect(ranked, `${selector}, counted by ${withEngine ? 'an engine' : 'the probe'}`).toEqual({
          role,
          locator: top,
        });
        expect(await playwrightOutcome(page, top)).toEqual({ ids: [eid] });
      }
    }
  });

  test('a scan scopes an item of a long list by its text, however many elements the page has', async ({ page }) => {
    const items = Array.from(
      { length: 1500 },
      (_, i) => `<li><h3>Product ${i} mug</h3><p>In stock</p><button type="button">Remove</button></li>`,
    );
    await servePages(page, ORIGIN, {
      'long-list.html': `<!doctype html><html><body><ul>${items.join('')}</ul></body></html>`,
    });
    await page.goto(`${ORIGIN}/long-list.html`);
    await page.addScriptTag({ path: await engineBundle() });
    const ranked = await page.evaluate(() =>
      (
        globalThis as unknown as {
          __piwiRankTop: (s: string, w: boolean) => { role: string | null; locator: string | null };
        }
      ).__piwiRankTop('li:nth-child(43) button', true),
    );
    const top = "getByRole('listitem').filter({ hasText: 'Product 42 mug' }).getByRole('button', { name: 'Remove' })";
    expect(ranked).toEqual({ role: 'button', locator: top });
    await tagElements(page);
    expect(await playwrightOutcome(page, top)).toEqual({
      ids: [await page.locator('li:nth-child(43) button').getAttribute('data-eid')],
    });
  });

  test('an element with a role and no name still gets a locator, kept by position', async ({ page }) => {
    await servePages(page, ORIGIN, {
      'unnamed.html': `<!doctype html><html><body>
        <form id="checkboxes"><input type="checkbox"> checkbox 1<br><input type="checkbox" checked> checkbox 2</form>
      </body></html>`,
    });
    await page.goto(`${ORIGIN}/unnamed.html`);
    await tagElements(page);
    await page.addScriptTag({ path: await engineBundle() });
    const cases = [
      { selector: 'input:first-of-type', role: 'checkbox', top: "getByRole('checkbox').first()" },
      { selector: 'input:last-of-type', role: 'checkbox', top: "getByRole('checkbox').nth(1)" },
    ];
    for (const { selector, role, top } of cases) {
      for (const withEngine of [true, false]) {
        const ranked = await page.evaluate(
          ([s, w]) =>
            (
              globalThis as unknown as {
                __piwiRankTop: (s: string, w: boolean) => { role: string | null; locator: string | null };
              }
            ).__piwiRankTop(s, w),
          [selector, withEngine] as const,
        );
        expect(ranked, `${selector}, counted by ${withEngine ? 'an engine' : 'the probe'}`).toEqual({
          role,
          locator: top,
        });
      }
      expect(await playwrightOutcome(page, top)).toEqual({
        ids: [await page.locator(selector).getAttribute('data-eid')],
      });
    }
  });

  test('an element named by a whole card is named by the start of its name', async ({ page }) => {
    const card = (title: string) =>
      `<a href="#${title.length}"><h1>${title}</h1><p>As practices evolve, video tutorials have emerged as the most efficient method for imparting knowledge.</p><span>Read more...</span></a>`;
    await servePages(page, ORIGIN, {
      'cards.html': `<!doctype html><html><body>
        ${card('The value of pre-recorded video classes and the most efficient approach')}
        ${card('The value of live classes')}
      </body></html>`,
    });
    await page.goto(`${ORIGIN}/cards.html`);
    await tagElements(page);
    await page.addScriptTag({ path: await engineBundle() });
    const top = "getByRole('link', { name: 'The value of pre-recorded video classes and the most' })";
    for (const withEngine of [true, false]) {
      const ranked = await page.evaluate(
        (w) =>
          (
            globalThis as unknown as {
              __piwiRankTop: (s: string, w: boolean) => { role: string | null; locator: string | null };
            }
          ).__piwiRankTop('a', w),
        withEngine,
      );
      expect(ranked, `counted by ${withEngine ? 'an engine' : 'the probe'}`).toEqual({ role: 'link', locator: top });
    }
    expect(await playwrightOutcome(page, top)).toEqual({
      ids: [await page.locator('a').first().getAttribute('data-eid')],
    });
  });

  test('a candidate is narrowed inside an ancestor carrying the configured test id attribute', async ({ page }) => {
    await servePages(page, ORIGIN, {
      'test-id-scopes.html': `<!doctype html><html><body><ul>
        <li data-qa="order-1001" data-testid="row">Order 1001 <button type="button">Delete</button></li>
        <li data-qa="order-1002" data-testid="row">Order 1002 <button type="button" id="target">Delete</button></li>
      </ul></body></html>`,
    });
    await page.goto(`${ORIGIN}/test-id-scopes.html`);
    await tagElements(page);
    await page.addScriptTag({ path: await engineBundle() });
    const checked = await page.evaluate(
      (candidates) =>
        (
          globalThis as unknown as {
            __piwiCheckLocators: (s: string, l: string[], a?: string[]) => Array<{ locator: string; verdict: string }>;
          }
        ).__piwiCheckLocators('#target', candidates, ['data-qa']),
      ["getByRole('button', { name: 'Delete' })"],
    );
    const narrowed = "getByTestId('order-1002').getByRole('button', { name: 'Delete', exact: true })";
    expect(checked).toEqual([{ locator: narrowed, verdict: 'narrowed', narrowedBy: 'scope' }]);
    selectors.setTestIdAttribute('data-qa');
    try {
      expect(await playwrightOutcome(page, narrowed)).toEqual({
        ids: [await page.locator('#target').getAttribute('data-eid')],
      });
    } finally {
      selectors.setTestIdAttribute('data-testid');
    }
  });

  test('a candidate that also finds the parent of a repeated container is checked, not thrown on', async ({ page }) => {
    // As the dashboard's tab bar: a class on the list and on each tab, each tab in a list item.
    await servePages(page, ORIGIN, {
      'tab-bar.html': `<!doctype html><html><body><ul class="flex">
        <li class="item"><button type="button" class="flex" id="runs">Runs (16)</button></li>
        <li class="item"><button type="button" class="flex" id="failures">Failures (6)</button></li>
      </ul></body></html>`,
    });
    await page.goto(`${ORIGIN}/tab-bar.html`);
    await tagElements(page);
    await page.addScriptTag({ path: await engineBundle() });
    const checked = await page.evaluate(
      (candidates) =>
        (
          globalThis as unknown as {
            __piwiCheckLocators: (s: string, l: string[]) => Array<{ locator: string; verdict: string }>;
          }
        ).__piwiCheckLocators('#failures', candidates),
      ["locator('.flex')"],
    );
    expect(checked).toHaveLength(1);
    expect(await playwrightOutcome(page, checked[0]!.locator)).toEqual({
      ids: [await page.locator('#failures').getAttribute('data-eid')],
    });
  });

  test('one engine answers the same expression identically, cached or not', async ({ page }) => {
    await openFixture(page);
    const expressions = Object.values(LOCATOR_CASES).flat();
    const shared = await engineOutcomes(page, expressions);
    const separate = await page.evaluate((list) => {
      const query = (globalThis as unknown as { __piwiEngineQueryAll: (e: string[]) => Outcome[] })
        .__piwiEngineQueryAll;
      return list.map((expression) => query([expression])[0]!);
    }, expressions);
    expect(shared).toEqual(separate);
  });
});
