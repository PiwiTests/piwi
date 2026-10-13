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
  /Record actions/,
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
    await page.keyboard.press('7');
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

  test('on a page that is not a web page, Record and Report a bug say they cannot record, and park nothing', async ({
    context,
    extensionId,
  }) => {
    // The popup opened as a tab is itself the active tab: an extension page, which no host permission covers.
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    await page.getByRole('button', { name: /Record actions/ }).click();
    await expect(page.getByRole('status')).toHaveText('Piwi Picker can’t record on this page.');
    await page.evaluate(() => {
      document.getElementById('status')!.textContent = '';
    });
    await page.getByRole('button', { name: /Report a bug/ }).click();
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
    const replay = page.getByRole('button', { name: /Replay a bug report/ });
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
    await expect(page.locator('#status')).toHaveText('Piwi Picker can’t replay a report on this page.');
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
    await expect(page.locator('#coverage-hint')).toHaveText(
      'Connect to your Piwi instance to see what your tests reach',
    );
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
    await expect(page.locator('#coverage-hint')).toHaveText('What your tests reach on this page, and what they miss');
  });
});

test.describe('Report a bug tile', () => {
  test('answers to B and says what it does in each recording state', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    const tile = page.getByRole('button', { name: /Report a bug/ });
    await expect(tile).toBeEnabled();
    await expect(tile).toHaveAttribute('aria-keyshortcuts', 'B');
    await expect(page.locator('#report-bug-hint')).toHaveText("Steps and what's wrong → a failing test");
    await page.evaluate(() => {
      (globalThis as unknown as { clicked: string[] }).clicked = [];
      document.getElementById('report-bug')!.addEventListener(
        'click',
        (e) => {
          e.stopImmediatePropagation();
          (globalThis as unknown as { clicked: string[] }).clicked.push('report-bug');
        },
        { capture: true },
      );
    });
    await page.keyboard.press('b');
    expect(await page.evaluate(() => (globalThis as unknown as { clicked: string[] }).clicked)).toEqual(['report-bug']);

    // During a bug recording the tile takes a screenshot, and the record tile finishes the report.
    await page.evaluate(() =>
      chrome.storage.session.set({
        piwiRecording: { active: true, events: [], startedAt: 1, grantedOriginPattern: null, mode: 'bug' },
      }),
    );
    await page.reload();
    await expect(page.locator('#report-bug-label')).toHaveText('Take a screenshot');
    await expect(page.locator('#record-label')).toHaveText('Finish bug report (0)');

    // A recording of actions in progress has to end first.
    await page.evaluate(() =>
      chrome.storage.session.set({
        piwiRecording: { active: true, events: [], startedAt: 1, grantedOriginPattern: null, mode: 'actions' },
      }),
    );
    await page.reload();
    await expect(page.locator('#report-bug-hint')).toHaveText('Finish or discard the current recording first');
    await page.locator('#report-bug').click();
    await expect(page.locator('#status')).toHaveText('Finish or discard the current recording before reporting a bug.');
  });
});

test.describe('Record tile', () => {
  test('stays Record over a bug report not exported yet, and records over it on a second click', async ({
    context,
    extensionId,
  }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    await page.evaluate(() =>
      chrome.storage.session.set({
        piwiRecording: {
          active: false,
          events: [{ type: 'click', timestamp: 2 }],
          startedAt: 1,
          grantedOriginPattern: null,
          mode: 'bug',
        },
      }),
    );
    await page.reload();
    await expect(page.locator('#report-bug-label')).toHaveText('Review bug report');
    await expect(page.locator('#record-label')).toHaveText('Record actions');
    await expect(page.locator('#record-hint')).toHaveText('Replaces the bug report');

    // The first click asks; nothing starts.
    await page.locator('#record').click();
    await expect(page.locator('#record-label')).toHaveText('Discard the bug report?');
    await expect(page.locator('#record-hint')).toHaveText('Click again to confirm');
    await expect(page.locator('#status')).toHaveText('');

    // The second asks for the site, as Record does: here an extension page, which cannot be recorded.
    await page.locator('#record').click();
    await expect(page.getByRole('status')).toHaveText('Piwi Picker can’t record on this page.');
    expect(await page.evaluate(() => chrome.storage.session.get('piwiRecordIntent'))).toEqual({});
  });
});

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

    // Connected: the project row shows too.
    await page.evaluate(() =>
      chrome.storage.local.set({
        piwiConnection: {
          instanceUrl: 'https://piwi.test',
          apiKey: 'k',
          projectMappings: [{ urlPattern: 'https://elsewhere.test/**', projectId: 1, projectLabel: 'Shop' }],
          serverSyncedAt: 1,
        },
      }),
    );
    await page.reload();
    await expect(page.locator('#active-project-row')).toBeVisible();
    const height = await page.locator('.popup').evaluate((el) => el.getBoundingClientRect().height);
    expect(height).toBeLessThanOrEqual(600);
  });
});
