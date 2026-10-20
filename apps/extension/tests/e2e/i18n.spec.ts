import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { substitutePlaceholders, type RawCatalog } from '../../src/shared/i18n.js';
import { test, expect, openOptions, optionsReady } from './fixtures.js';
import { stubChromeI18n } from './i18n-stub.js';
import { TRANSLATION_ISSUE_URL } from '../../src/shared/languages.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const readCatalog = (code: string): RawCatalog =>
  JSON.parse(readFileSync(path.join(here, '..', '..', 'public', '_locales', code, 'messages.json'), 'utf8'));

/**
 * The arguments each message is tried with: one per placeholder, in
 * placeholder order, with a `$1` and a `$$` among them to show a value is
 * never read again.
 */
function calls(catalog: RawCatalog): Array<{ key: string; substitutions: string[] }> {
  return Object.entries(catalog).map(([key, entry]) => ({
    key,
    substitutions: Object.keys(entry.placeholders ?? {}).map((_, i) => (i === 0 ? `“$1 $$ ${key}”` : `v${i + 1}`)),
  }));
}

async function browserMessages(page: Page, list: Array<{ key: string; substitutions: string[] }>): Promise<string[]> {
  return page.evaluate(
    (items) => items.map(({ key, substitutions }) => chrome.i18n.getMessage(key, substitutions)),
    list,
  );
}

/** The text of every translated element and attribute of the page: none may be empty or show a placeholder. */
async function untranslated(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const bad: string[] = [];
    const check = (where: string, text: string | null) => {
      if (!text?.trim() || /[$]/.test(text)) bad.push(`${where}: ${JSON.stringify(text)}`);
    };
    for (const el of document.querySelectorAll<HTMLElement>('[data-i18n]')) check(el.dataset.i18n!, el.textContent);
    for (const [data, attribute] of [
      ['data-i18n-title', 'title'],
      ['data-i18n-placeholder', 'placeholder'],
      ['data-i18n-aria-label', 'aria-label'],
    ]) {
      for (const el of document.querySelectorAll(`[${data}]`))
        check(el.getAttribute(data)!, el.getAttribute(attribute));
    }
    return bad;
  });
}

/** Elements whose content is wider than their box: a label that clips. */
async function clipped(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('body *')]
      .filter((el) => el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1)
      .map((el) => `${el.tagName.toLowerCase()}#${el.id}.${el.className}: ${el.scrollWidth} > ${el.clientWidth}`),
  );
}

test.describe('in an English browser', () => {
  test('the Options override fills a message exactly as chrome.i18n does, for every English message', async ({
    context,
    extensionId,
  }) => {
    const english = readCatalog('en');
    const list = calls(english);
    const page = await context.newPage();
    await openOptions(page, extensionId);
    const fromBrowser = await browserMessages(page, list);
    const fromOverride = list.map(({ key, substitutions }) => substitutePlaceholders(english[key]!, substitutions));
    expect(fromOverride).toEqual(fromBrowser);

    // The stub the specs use for a faked `chrome` answers the same.
    await stubChromeI18n(context);
    const plain = await context.newPage();
    await plain.route('https://i18n.test/**', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<p>i18n</p>' }),
    );
    await plain.goto('https://i18n.test/');
    expect(await browserMessages(plain, list)).toEqual(fromBrowser);
  });

  test('the Language setting switches the popup to French without a restart, and back', async ({
    context,
    extensionId,
  }) => {
    const options = await context.newPage();
    await openOptions(options, extensionId);
    const language = options.getByLabel('Language');
    await expect(language.locator('option')).toHaveText([
      'Same as the browser (English)',
      'English',
      'Français',
      'Deutsch',
      'Español',
      'Português (Brasil)',
    ]);
    await expect(language).toHaveValue('');

    await language.selectOption('fr');
    await expect(options.locator('#language-status')).toHaveText('Langue enregistrée.');
    // The page redraws itself in the new language.
    await expect(options.getByRole('heading', { name: 'Connexion à Piwi' })).toBeVisible();
    await expect(options.locator('html')).toHaveAttribute('lang', 'fr');
    await expect(options.getByLabel('Langue')).toHaveValue('fr');
    await expect(options.getByLabel('Langue').locator('option').first()).toHaveText('Celle du navigateur (English)');

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await expect(popup.getByRole('button', { name: /Choisir un élément/ })).toBeVisible();
    await expect(popup.locator('html')).toHaveAttribute('lang', 'fr');
    expect(await untranslated(popup)).toEqual([]);

    await options.getByLabel('Langue').selectOption('');
    await expect(options.locator('#language-status')).toHaveText('Language saved.');
    await popup.reload();
    await expect(popup.getByRole('button', { name: /Pick an element/ })).toBeVisible();
    await expect(popup.locator('html')).toHaveAttribute('lang', /^en/);
  });

  test('the badge follows what runs, in the chosen language, whatever it said before', async ({
    context,
    extensionId,
  }) => {
    const page = await context.newPage();
    await openOptions(page, extensionId);
    await page.getByLabel('Language').selectOption('fr');
    await expect(page.locator('#language-status')).toHaveText('Langue enregistrée.');

    const replayFinished = () =>
      page.evaluate(async () => {
        await chrome.runtime.sendMessage({ type: 'piwi-replay-finished' });
        return chrome.action.getBadgeText({});
      });
    // A recording started while the replay ran keeps its badge.
    await page.evaluate(() =>
      chrome.storage.session.set({
        piwiRecording: { active: true, events: [], startedAt: 1, grantedOriginPattern: null, mode: 'actions' },
      }),
    );
    expect(await replayFinished()).toBe('ENR');
    await page.evaluate(() => chrome.storage.session.remove('piwiRecording'));
    expect(await replayFinished()).toBe('');
  });
});

test.describe('in a French browser', () => {
  test.use({ browserLanguage: 'fr' });

  test('the browser answers in French', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    expect(await page.evaluate(() => [chrome.i18n.getUILanguage(), chrome.i18n.getMessage('popup_pick')])).toEqual([
      'fr',
      'Choisir un élément',
    ]);
  });

  test('the popup is in French, with the same keys', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
    for (const name of [
      'Éléments testés',
      'Signaler un bug',
      'Rejouer un rapport de bug',
      'Enregistrer',
      'Choisir un élément',
    ]) {
      await expect(page.getByRole('button', { name: new RegExp(name) })).toBeVisible();
    }
    await expect(page.getByRole('button', { name: 'Réglages' })).toBeVisible();
    await expect(page.locator('#coverage-hint')).toHaveText('Connectez Piwi pour voir ce que vos tests atteignent');
    await expect(page.locator('.tile .key')).toHaveText(['1', '2', 'B', 'R', 'T', '3', '4', '5', '6', '7']);
    expect(await untranslated(page)).toEqual([]);
    expect(await clipped(page)).toEqual([]);

    // The single-key shortcuts are the same in every language.
    await page.evaluate(() => {
      (globalThis as unknown as { clicked: string[] }).clicked = [];
      for (const b of document.querySelectorAll<HTMLElement>('.actions button')) {
        b.addEventListener('click', () => (globalThis as unknown as { clicked: string[] }).clicked.push(b.id));
      }
    });
    await page.keyboard.press('2');
    expect(await page.evaluate(() => (globalThis as unknown as { clicked: string[] }).clicked)).toEqual(['pick']);
  });

  test('the options page is in French', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await openOptions(page, extensionId);
    await expect(page).toHaveTitle('Réglages de Piwi Picker');
    await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
    await expect(page.getByLabel('Langue').locator('option')).toHaveText([
      'Celle du navigateur (Français)',
      'English',
      'Français',
      'Deutsch',
      'Español',
      'Português (Brasil)',
    ]);
    await expect(page.getByRole('heading', { name: 'Projets par site' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Se connecter' })).toBeVisible();
    await expect(page.locator('#instance-pill')).toHaveText('Non connecté');
    await expect(page.locator('#desktop-pill')).toHaveText('Non associé');
    await expect(page.locator('#sites-connect-first')).toHaveText(
      'Les sites renvoient aux projets de votre instance : connectez-vous d’abord.',
    );
    await expect(page.locator('p.hint code')).toHaveText(['*', '**', 'develop']);
    expect(await untranslated(page)).toEqual([]);

    // Connected, the lines of this browser show.
    await page.evaluate(() =>
      chrome.storage.local.set({ piwiConnection: { instanceUrl: 'http://127.0.0.1:9', apiKey: 'k' } }),
    );
    await page.reload();
    await optionsReady(page);
    await expect(page.locator('#instance-pill')).toHaveText('Connecté');
    await expect(page.locator('#mappings .empty-mappings')).toHaveText(
      'Aucune ligne pour l’instant : ajoutez-en une ci-dessous.',
    );
    await page.getByRole('button', { name: 'Ajouter une ligne' }).click();
    await expect(page.getByRole('textbox', { name: 'Motif d’adresse' })).toHaveAttribute(
      'placeholder',
      'https://boutique.exemple.fr/**',
    );
    await expect(page.getByRole('button', { name: 'Enregistrer', exact: true })).toBeVisible();
    expect(await untranslated(page)).toEqual([]);
  });

  test('the Options override fills every French message exactly as chrome.i18n does', async ({
    context,
    extensionId,
  }) => {
    const french = readCatalog('fr');
    const list = calls(french);
    const page = await context.newPage();
    await openOptions(page, extensionId);
    expect(list.map(({ key, substitutions }) => substitutePlaceholders(french[key]!, substitutions))).toEqual(
      await browserMessages(page, list),
    );
  });
});

test.describe('in a German browser', () => {
  test.use({ browserLanguage: 'de' });

  test('the popup is in German and nothing in it clips', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    await expect(page.locator('html')).toHaveAttribute('lang', 'de');
    await expect(page.getByRole('button', { name: /Element wählen/ })).toBeVisible();
    expect(await untranslated(page)).toEqual([]);
    expect(await clipped(page)).toEqual([]);
  });

  test('the settings say German is a draft, and where to suggest a correction', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await openOptions(page, extensionId);
    await expect(page.locator('html')).toHaveAttribute('lang', 'de');
    const note = page.locator('#language-draft');
    await expect(note).toBeVisible();
    await expect(note).toContainText('Entwurf');
    await expect(note.getByRole('link')).toHaveAttribute('href', TRANSLATION_ISSUE_URL);
    // Each language by its own name.
    await expect(page.locator('#language option')).toHaveText([
      /\(Deutsch\)$/,
      'English',
      'Français',
      'Deutsch',
      'Español',
      'Português (Brasil)',
    ]);
    expect(await untranslated(page)).toEqual([]);
    expect(await clipped(page)).toEqual([]);

    // A reviewed language has no note.
    await page.locator('#language').selectOption('fr');
    await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
    await expect(note).toBeHidden();
  });
});

test('the Language setting reaches a panel through the stored catalog, whatever the browser says', async ({
  context,
}) => {
  // The browser answers in English; the stored choice is German, as the worker stores it.
  const choice = { code: 'de', messages: readCatalog('de') };
  await context.addInitScript((stored) => {
    (globalThis as { chrome?: unknown }).chrome = {
      storage: { local: { get: async () => ({ piwiLanguage: stored }) } },
    };
    const attach = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (init: ShadowRootInit) {
      return attach.call(this, { ...init, mode: 'open' });
    };
  }, choice);
  await stubChromeI18n(context);
  const page = await context.newPage();
  await page.setContent('<!doctype html><html lang="en"><body><button>Pay</button></body></html>');
  await page.addScriptTag({ path: path.join(here, '..', '..', 'dist', 'lint-overlay.js') });
  const panel = page.locator('#piwi-lint-overlay-host .panel');
  await expect(panel).toHaveAttribute('lang', 'de');
  await expect(panel).toHaveAttribute('aria-label', readCatalog('de').lint_dialog!.message);
});
