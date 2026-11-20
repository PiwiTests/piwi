import type { Page } from '@playwright/test';
import { test, expect, openOptions } from './fixtures.js';

/**
 * Playwright has no API to click the browser's own toolbar icon, so this
 * opens `popup.html` directly (the standard way to test an MV3 popup's own
 * rendering) rather than simulating a real toolbar click end-to-end — a
 * page opened this way becomes the active tab itself, which would make
 * `chrome.tabs.query({ active: true })` target the popup page instead of a
 * real tab, so the injection buttons aren't exercised here (see
 * `pick.spec.ts` / `lint-overlay.spec.ts` for the content scripts they
 * inject, tested directly).
 */
const ACTION_BUTTON_NAMES = [
  /Record/,
  /Pick an element/,
  /Multi-pick/,
  /Assertions/,
  /Lint overlay/,
  /Agent context/,
  /Test functions/,
];

test.describe('popup.html', () => {
  test('renders every action button and the keyboard-shortcut hint', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    for (const name of ACTION_BUTTON_NAMES) {
      await expect(page.getByRole('button', { name })).toBeVisible();
    }
    // The hint reports whatever the browser actually bound, not the key the
    // manifest asked for — a suggested key is only assigned when it is free.
    await expect(page.locator('#pick-shortcut')).not.toBeEmpty();
  });

  test('the pick-shortcut hint states the binding the browser actually made', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    const assigned = await page.evaluate(async () => {
      const commands = await chrome.commands.getAll();
      return commands.find((c) => c.name === 'pick-element')?.shortcut ?? '';
    });
    const hint = page.locator('#pick-shortcut');
    if (assigned) {
      await expect(hint.locator('kbd')).toHaveText(assigned);
    } else {
      // Nothing bound: offer a way to fix it rather than naming a dead key.
      await expect(hint.locator('a')).toContainText('set one');
    }
  });

  test('every tool tile carries a digit shortcut, 1 through 7, in render order', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    // The tiles under Tests have a letter each: Replay, Take a screenshot, Runs and Tested elements.
    const keys = await page.locator('.actions button').evaluateAll((buttons) =>
      buttons.map((b) => ({
        id: b.id,
        badge: b.querySelector('.key')?.textContent ?? null,
        announced: b.getAttribute('aria-keyshortcuts'),
      })),
    );
    expect(keys.map((k) => k.badge)).toEqual(['1', '2', '3', '4', '5', '6', '7']);
    // The visible badge and the announced shortcut must agree, or screen-reader
    // users get told a key that does nothing.
    for (const k of keys) expect(k.announced, `${k.id}`).toBe(k.badge);
  });

  test('pressing a digit runs that tile, and a modified digit is left to the browser', async ({
    context,
    extensionId,
  }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    await page.evaluate(() => {
      (globalThis as unknown as { clicked: string[] }).clicked = [];
      for (const b of document.querySelectorAll<HTMLElement>('.actions button')) {
        b.addEventListener('click', () => (globalThis as unknown as { clicked: string[] }).clicked.push(b.id));
      }
    });

    await page.keyboard.press('3');
    await page.keyboard.press('6');
    await page.keyboard.press('Control+5');
    await page.keyboard.press('8');

    expect(await page.evaluate(() => (globalThis as unknown as { clicked: string[] }).clicked)).toEqual([
      'multi-pick',
      'test-function-panel',
    ]);
  });

  test('digits typed into the project select drive its own typeahead, not the shortcuts', async ({
    context,
    extensionId,
  }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          chrome.storage.local.set(
            {
              piwiConnection: {
                instanceUrl: 'https://piwi.test',
                apiKey: '',
                projectMappings: [{ urlPattern: '**', projectId: 1, projectLabel: '2024 release' }],
              },
            },
            resolve,
          );
        }),
    );
    await page.reload();
    // The select's row shows once the popup has read the connection: a hidden select takes no focus.
    const select = page.locator('#active-project');
    await expect(select).toBeVisible();
    await page.evaluate(() => {
      (globalThis as unknown as { clicked: string[] }).clicked = [];
      for (const b of document.querySelectorAll<HTMLElement>('.actions button')) {
        b.addEventListener('click', () => (globalThis as unknown as { clicked: string[] }).clicked.push(b.id));
      }
    });
    await select.focus();
    await expect(select).toBeFocused();
    await page.keyboard.press('2');
    expect(await page.evaluate(() => (globalThis as unknown as { clicked: string[] }).clicked)).toEqual([]);
  });

  test('every compact tile says what it is for in a visible line, not a tooltip', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.setViewportSize({ width: 480, height: 600 });
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    const hints = {
      'multi-pick': '2–3 items → a list',
      'assertion-panel': 'Ranked expect(…) lines',
      'lint-overlay': 'Hard-to-test elements',
      'agent-context-panel': 'Summary for an AI',
      'test-function-panel': 'Check the catalog here',
    };
    for (const [id, hint] of Object.entries(hints)) {
      const tile = page.locator(`#${id}`);
      await expect(tile.locator('.hint')).toHaveText(hint);
      await expect(tile.locator('.hint')).toBeVisible();
      // Read with the label by a screen reader, as the big tiles' hints are.
      await expect(tile).toHaveAccessibleName(new RegExp(hint.replace(/[()…]/g, '.')));
      await expect(tile).not.toHaveAttribute('title');
      // One line, under the label.
      const box = await tile.locator('.hint').evaluate((el) => {
        const rect = el.getBoundingClientRect();
        return { height: rect.height, clipped: el.scrollWidth > el.clientWidth + 1 };
      });
      expect(box, id).toEqual({ height: 14, clipped: false });
    }
  });

  test('shows a config button that opens the options page', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible();
  });

  test('hides the active-project row when not connected to a Piwi instance', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    await expect(page.locator('#active-project-row')).toBeHidden();
  });

  test('shows the active-project row with the mapped project once connected', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          chrome.storage.local.set(
            {
              piwiConnection: {
                instanceUrl: 'https://piwi.test',
                apiKey: '',
                projectMappings: [{ urlPattern: '**', projectId: 1, projectLabel: 'Demo project' }],
              },
            },
            resolve,
          );
        }),
    );
    await page.reload();

    await expect(page.locator('#active-project-row')).toBeVisible();
    await expect(page.locator('#active-project')).toHaveValue('');
    const optionTexts = await page.locator('#active-project option').allTextContents();
    expect(optionTexts).toContain('Demo project');
  });

  test('dedupes multiple URL patterns mapped to the same project into one option', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          chrome.storage.local.set(
            {
              piwiConnection: {
                instanceUrl: 'https://piwi.test',
                apiKey: '',
                projectMappings: [
                  { urlPattern: 'https://shop.example.com/**', projectId: 1, projectLabel: 'Demo project' },
                  { urlPattern: 'https://admin.example.com/**', projectId: 1, projectLabel: 'Demo project' },
                ],
              },
            },
            resolve,
          );
        }),
    );
    await page.reload();

    await expect(page.locator('#active-project-row')).toBeVisible();
    const optionTexts = await page.locator('#active-project option').allTextContents();
    expect(optionTexts.filter((t) => t === 'Demo project')).toHaveLength(1);
  });

  test('on a page that is not a web page, Record says it cannot record, and parks nothing', async ({
    context,
    extensionId,
  }) => {
    // The popup opened as a tab is itself the active tab: an extension page, which no host permission covers.
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    await page.getByRole('button', { name: /Record/ }).click();
    await expect(page.getByRole('status')).toHaveText('Piwi Picker can’t record on this page.');
    expect(await page.evaluate(() => chrome.storage.session.get('piwiRecordIntent'))).toEqual({});
  });

  test('Replay and Tested elements wait for the tab and the connection they act on', async ({
    context,
    extensionId,
  }) => {
    const page = await context.newPage();
    // The tab is read only once the spec lets it be.
    await page.addInitScript(() => {
      const query = chrome.tabs.query.bind(chrome.tabs);
      const held = new Promise<void>((resolve) => {
        (globalThis as unknown as { releaseTabs: () => void }).releaseTabs = resolve;
      });
      chrome.tabs.query = ((info: chrome.tabs.QueryInfo) =>
        held.then(() => query(info))) as unknown as typeof chrome.tabs.query;
    });
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    const replay = page.getByRole('button', { name: /Replay/ });
    const tested = page.getByRole('button', { name: /Tested elements/ });
    await expect(replay).toBeDisabled();
    await expect(tested).toBeDisabled();
    const opened: string[] = [];
    context.on('page', (p) => opened.push(p.url()));
    await page.keyboard.press('r');
    await page.keyboard.press('t');
    await expect(page.locator('#status')).toBeEmpty();
    expect(opened).toEqual([]);

    await page.evaluate(() => (globalThis as unknown as { releaseTabs: () => void }).releaseTabs());
    await expect(replay).toBeEnabled();
    await expect(tested).toBeEnabled();
    await page.keyboard.press('r');
    await expect(page.locator('#status')).toHaveText('Piwi Picker can’t replay a recording on this page.');
  });

  test('Add this site, before the instance’s projects are read, fills a line of this browser in', async ({
    context,
    extensionId,
  }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    await page.evaluate(() =>
      chrome.storage.local.set({
        piwiConnection: {
          instanceUrl: 'https://piwi.invalid',
          apiKey: '',
          projectMappings: [{ urlPattern: 'https://elsewhere.test/**', projectId: 1, projectLabel: 'Shop' }],
          serverSyncedAt: 0,
        },
      }),
    );
    await openOptions(page, extensionId, `#add=${encodeURIComponent('https://staging.shop.example/**')}`);
    await expect(page.locator('#add-site')).toBeHidden();
    const patterns = page.locator('#mappings .mapping-pattern');
    await expect(patterns).toHaveCount(2);
    await expect(patterns.last()).toHaveValue('https://staging.shop.example/**');
    await expect(page.locator('#mappings .mapping-project').last()).toBeFocused();
  });
});

test.describe('the connection’s line', () => {
  test('says since when the instance refuses the key, on one line, with a link to the settings', async ({
    context,
    extensionId,
  }) => {
    const page = await context.newPage();
    await page.setViewportSize({ width: 480, height: 600 });
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    await seedRefusedConnection(page);
    await page.reload();
    const line = page.locator('#connection-health');
    await expect(line).toHaveText(/^piwi\.test has refused the API key since .+, connect again in the settings\.$/);
    await expect(line).toHaveClass(/failing/);
    expect(await line.evaluate((el) => el.getBoundingClientRect().height)).toBe(16);
    const [options] = await Promise.all([
      context.waitForEvent('page'),
      line.getByRole('link', { name: 'connect again in the settings' }).click(),
    ]);
    await expect(options).toHaveURL(new RegExp(`chrome-extension://${extensionId}/options.html`));
  });

  test('says nothing of a record kept for another instance, nor without a connection', async ({
    context,
    extensionId,
  }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    await page.evaluate(() =>
      chrome.storage.local.set({
        piwiConnectionHealth: { instanceUrl: 'https://piwi.test', outcome: 'ok', checkedAt: Date.now() },
      }),
    );
    await page.reload();
    await expect(page.locator('#connection-health')).toBeHidden();
    await page.evaluate(() =>
      chrome.storage.local.set({
        piwiConnection: {
          instanceUrl: 'https://elsewhere.test',
          projectMappings: [{ urlPattern: '**', projectId: 1, projectLabel: 'Shop' }],
        },
      }),
    );
    await page.reload();
    await expect(page.locator('#active-project-row')).toBeVisible();
    await expect(page.locator('#connection-health')).toBeHidden();
  });
});

test.describe('Tested elements tile', () => {
  test('answers to T', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    const tile = page.getByRole('button', { name: /Tested elements/ });
    await expect(tile).toBeEnabled();
    await expect(tile).toHaveAttribute('aria-keyshortcuts', 'T');
    await page.evaluate(() => {
      (globalThis as unknown as { clicked: string[] }).clicked = [];
      document.getElementById('coverage-overlay')!.addEventListener(
        'click',
        (e) => {
          e.stopImmediatePropagation();
          (globalThis as unknown as { clicked: string[] }).clicked.push('coverage-overlay');
        },
        { capture: true },
      );
    });
    await page.keyboard.press('t');
    expect(await page.evaluate(() => (globalThis as unknown as { clicked: string[] }).clicked)).toEqual([
      'coverage-overlay',
    ]);
  });

  test('without a connection it says so and opens the settings', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    await expect(page.locator('#coverage-hint')).toHaveText('Connect Piwi to see it');
    const [options] = await Promise.all([context.waitForEvent('page'), page.locator('#coverage-overlay').click()]);
    await expect(options).toHaveURL(new RegExp(`chrome-extension://${extensionId}/options.html`));
  });

  test('once connected it describes what it shows', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    await page.evaluate(() =>
      chrome.storage.local.set({
        piwiConnection: {
          instanceUrl: 'https://piwi.test',
          apiKey: '',
          projectMappings: [{ urlPattern: '**', projectId: 1, projectLabel: 'Demo project' }],
        },
      }),
    );
    await page.reload();
    await expect(page.locator('#coverage-hint')).toHaveText('What your tests reach here');
  });
});

/**
 * The popup opened over a web page, as it is over a tab of the browser: `chrome.tabs.query` answers that tab, and
 * `chrome.permissions` answers whether its site is granted and what its prompt does. `window.close` is kept as a mark.
 */
async function popupOver(
  page: Page,
  extensionId: string,
  tab: { id: number; url: string },
  site: { granted: boolean; answer?: boolean },
): Promise<void> {
  await page.addInitScript(
    ({ tab, site }) => {
      const g = globalThis as unknown as { closeCalled: boolean; started: unknown[] };
      g.closeCalled = false;
      g.started = [];
      window.close = () => {
        g.closeCalled = true;
      };
      chrome.tabs.query = (async () => [{ ...tab, active: true }]) as unknown as typeof chrome.tabs.query;
      chrome.permissions.contains = (async () => site.granted) as unknown as typeof chrome.permissions.contains;
      // An answer the prompt gives at once, or a prompt still on screen.
      chrome.permissions.request = (() =>
        site.answer === undefined
          ? new Promise(() => undefined)
          : Promise.resolve(site.answer)) as unknown as typeof chrome.permissions.request;
      const send = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = ((message: { type?: string }) => {
        if (message?.type !== 'piwi-start-recording') return send(message);
        g.started.push(message);
        return Promise.resolve({ ok: true });
      }) as typeof chrome.runtime.sendMessage;
    },
    { tab, site },
  );
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
}

const SHOP_TAB = { id: 4242, url: 'https://shop.test/cart' };
const marks = (page: Page) =>
  page.evaluate(() => {
    const g = globalThis as unknown as { closeCalled: boolean; started: unknown[] };
    return { closed: g.closeCalled, started: g.started.length };
  });
const parkedIntent = (page: Page) =>
  page.evaluate(async () => (await chrome.storage.session.get('piwiRecordIntent')).piwiRecordIntent ?? null);

test.describe('Record and the site’s permission prompt', () => {
  test('on a site not granted yet, parks the intent and gets out of the prompt’s way', async ({
    context,
    extensionId,
  }) => {
    const page = await context.newPage();
    await popupOver(page, extensionId, SHOP_TAB, { granted: false });
    await page.locator('#record').click();
    await expect.poll(() => marks(page)).toEqual({ closed: true, started: 0 });
    expect(await parkedIntent(page)).toMatchObject({ originPattern: 'https://shop.test/*', tabId: 4242 });
  });

  test('on a site granted already, starts the recording itself', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await popupOver(page, extensionId, SHOP_TAB, { granted: true, answer: true });
    await page.locator('#record').click();
    await expect.poll(() => marks(page)).toEqual({ closed: true, started: 1 });
    expect(await parkedIntent(page)).toBeNull();
  });

  test('a prompt answered No at once keeps the popup open, says why and parks nothing', async ({
    context,
    extensionId,
  }) => {
    const page = await context.newPage();
    await popupOver(page, extensionId, SHOP_TAB, { granted: false, answer: false });
    await page.locator('#record').click();
    await expect(page.getByRole('status')).toHaveText(
      'Piwi Picker needs access to this site to record from page to page.',
    );
    await page.waitForTimeout(800);
    expect(await marks(page)).toEqual({ closed: false, started: 0 });
    expect(await parkedIntent(page)).toBeNull();
  });

  test('opened after a refused prompt on that tab and site, it says the recording did not start', async ({
    context,
    extensionId,
  }) => {
    const page = await context.newPage();
    await popupOver(page, extensionId, SHOP_TAB, { granted: false });
    await page.evaluate(() =>
      chrome.storage.session.set({
        piwiRecordIntent: { originPattern: 'https://shop.test/*', tabId: 4242, createdAt: Date.now() },
      }),
    );
    await page.reload();
    await expect(page.getByRole('status')).toHaveText(
      'The recording did not start: Piwi Picker was not allowed on this site.',
    );
    expect(await parkedIntent(page)).toBeNull();
  });

  for (const [what, intent] of [
    ['another tab', { originPattern: 'https://shop.test/*', tabId: 7 }],
    ['another site in that tab', { originPattern: 'https://elsewhere.test/*', tabId: 4242 }],
  ] as const) {
    test(`says nothing of a refused prompt for ${what}, and lets its intent go`, async ({ context, extensionId }) => {
      const page = await context.newPage();
      await popupOver(page, extensionId, SHOP_TAB, { granted: false });
      await page.evaluate(
        (parked) => chrome.storage.session.set({ piwiRecordIntent: { ...parked, createdAt: Date.now() } }),
        intent,
      );
      await page.reload();
      await expect.poll(() => parkedIntent(page)).toBeNull();
      await expect(page.locator('#status')).toBeEmpty();
    });
  }

  test('says why a recording the grant should have started did not start, once, on its tab', async ({
    context,
    extensionId,
  }) => {
    const page = await context.newPage();
    await popupOver(page, extensionId, SHOP_TAB, { granted: true });
    await page.evaluate(() =>
      chrome.storage.session.set({ piwiRecordStartError: { tabId: 4242, error: 'Cannot access this page.' } }),
    );
    await page.reload();
    await expect(page.getByRole('status')).toHaveText('Cannot access this page.');
    await page.reload();
    await expect(page.locator('#status')).toBeEmpty();
  });
});

test.describe('Record tile', () => {
  test('says what it does in each recording state, and Take a screenshot takes Replay’s place while it records', async ({
    context,
    extensionId,
  }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    const record = page.locator('#record');
    await expect(record).toBeEnabled();
    await expect(page.locator('#record-hint')).toHaveText('A scenario or a bug');
    await expect(page.locator('#replay')).toBeVisible();
    await expect(page.locator('#screenshot')).toBeHidden();

    await page.evaluate(() =>
      chrome.storage.session.set({
        piwiRecording: { active: true, events: [], startedAt: 1, grantedOriginPattern: null, bugToken: 'a'.repeat(32) },
      }),
    );
    await page.reload();
    await expect(page.locator('#record-label')).toHaveText('Finish (0)');
    await expect(page.locator('#replay')).toBeHidden();
    const screenshot = page.locator('#screenshot');
    await expect(screenshot).toBeVisible();
    await expect(screenshot).toHaveAttribute('aria-keyshortcuts', 'S');
    await page.evaluate(() => {
      (globalThis as unknown as { clicked: string[] }).clicked = [];
      document.getElementById('screenshot')!.addEventListener(
        'click',
        (e) => {
          e.stopImmediatePropagation();
          (globalThis as unknown as { clicked: string[] }).clicked.push('screenshot');
        },
        { capture: true },
      );
    });
    await page.keyboard.press('s');
    expect(await page.evaluate(() => (globalThis as unknown as { clicked: string[] }).clicked)).toEqual(['screenshot']);

    await page.evaluate(() =>
      chrome.storage.session.set({
        piwiRecording: {
          active: false,
          events: [{ kind: 'click', timestamp: 1 }],
          startedAt: 1,
          grantedOriginPattern: null,
        },
      }),
    );
    await page.reload();
    await expect(page.locator('#record-label')).toHaveText('Review (1)');
    await expect(page.locator('#record-hint')).toHaveText('Not exported yet');
    await expect(page.locator('#screenshot')).toBeHidden();
  });
});

/** A connection kept, and the instance refusing its key since an hour ago: the longest line the popup says of it. */
function seedRefusedConnection(page: Page): Promise<void> {
  return page.evaluate(() =>
    chrome.storage.local.set({
      piwiConnection: {
        instanceUrl: 'https://piwi.test',
        apiKey: 'k',
        projectMappings: [{ urlPattern: 'https://elsewhere.test/**', projectId: 1, projectLabel: 'Shop' }],
        serverSyncedAt: 1,
      },
      piwiConnectionHealth: {
        instanceUrl: 'https://piwi.test',
        outcome: 'unauthorized',
        checkedAt: Date.now(),
        since: Date.now() - 3_600_000,
      },
    }),
  );
}

/**
 * The popup with a connection kept, its project row and the connection's line shown, and the Runs tile, which the
 * paired editor's runs show (`runs.spec.ts` shows it for real): the tallest it is without a recording. Measured in
 * DejaVu Sans, the wide font a Linux without other fonts falls back to, as CI draws it.
 */
async function connectedPopupHeight(page: Page, extensionId: string): Promise<number> {
  await page.setViewportSize({ width: 480, height: 600 });
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await seedRefusedConnection(page);
  await page.reload();
  await expect(page.locator('#active-project-row')).toBeVisible();
  await expect(page.locator('#connection-health')).toBeVisible();
  await page.locator('#runs').evaluate((tile: HTMLElement) => (tile.hidden = false));
  await expect(page.locator('#runs')).toBeVisible();
  // Tested elements running on the page, as its tile shows it then.
  await page.locator('#coverage-overlay').evaluate((tile) => tile.classList.add('running'));
  await page.addStyleTag({ content: 'body { font-family: "DejaVu Sans", sans-serif !important; }' });
  return page.locator('.popup').evaluate((el) => el.getBoundingClientRect().height);
}

/** The label or hint of a tile shown that is cut, or that takes more than one line. */
async function tilesCutOrWrapped(page: Page): Promise<string[]> {
  return page.locator('.tile:not([hidden])').evaluateAll((tiles) =>
    tiles.flatMap((tile) =>
      ['.label', '.hint'].flatMap((part) => {
        const el = tile.querySelector(part) as HTMLElement;
        const lineHeight = parseFloat(getComputedStyle(el).lineHeight);
        const cut = el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1;
        const wrapped = el.getBoundingClientRect().height > lineHeight * 1.5;
        return cut || wrapped ? [`${tile.id} ${part}`] : [];
      }),
    ),
  );
}

for (const language of ['en', 'de', 'fr', 'es', 'pt-BR']) {
  test.describe(`in ${language}`, () => {
    test.use({ browserLanguage: language });
    test('the popup fits a popup’s 600 pixels, and no tile’s label or hint is cut or wraps, recording or not', async ({
      context,
      extensionId,
    }) => {
      const page = await context.newPage();
      expect(await connectedPopupHeight(page, extensionId)).toBeLessThanOrEqual(600);
      expect(await tilesCutOrWrapped(page)).toEqual([]);
      // While a recording runs: Finish with its count, and Take a screenshot in Replay's place.
      await page.evaluate(() =>
        chrome.storage.session.set({
          piwiRecording: {
            active: true,
            events: [],
            startedAt: 1,
            grantedOriginPattern: null,
            bugToken: 'a'.repeat(32),
          },
        }),
      );
      expect(await connectedPopupHeight(page, extensionId)).toBeLessThanOrEqual(600);
      await expect(page.locator('#screenshot')).toBeVisible();
      expect(await tilesCutOrWrapped(page)).toEqual([]);
    });
  });
}

test.describe('the developer tools in DevTools', () => {
  test('are not in the popup, which says where they are, and it fits a popup’s 600 pixels', async ({
    context,
    extensionId,
  }) => {
    const page = await context.newPage();
    await page.setViewportSize({ width: 480, height: 600 });
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    for (const name of [/Playwright view/, /Save login/, /Hover-inspect/, /Locator console/, /^Session/]) {
      await expect(page.getByRole('button', { name })).toHaveCount(0);
    }
    await expect(page.getByRole('combobox', { name: 'Open this page at a viewport' })).toHaveCount(0);
    await expect(page.getByText(/are in DevTools, in the Piwi panel/)).toBeVisible();

    // Connected: the project row shows too, and the line saying how the instance answered.
    await seedRefusedConnection(page);
    await page.reload();
    await expect(page.locator('#active-project-row')).toBeVisible();
    await expect(page.locator('#connection-health')).toBeVisible();
    const height = await page.locator('.popup').evaluate((el) => el.getBoundingClientRect().height);
    expect(height).toBeLessThanOrEqual(600);
  });
});
