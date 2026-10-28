import type { Browser, ElementHandle, Locator, Page } from '@playwright/test';
import { hideSecretsInText, hideSecretsInUrl } from '@piwitests/core/mask';
import {
  MAX_AGENT_SNAPSHOT,
  type ActAnswer,
  type BindAnswer,
  type PausedImage,
  type RankedRefLocator,
  type RefElement,
  type RefLocatorAnswer,
  type RunActAction,
  type SnapshotAnswer,
} from '@piwitests/core/run-channel';
import { resolveAriaRole } from '@piwitests/core/locator-generation';
import { errorMessage } from '../support/errors.js';
import { MAX_CHECKED, findsAlone, rankedCandidates } from './pick-at.js';
import type { PickerProbe } from './pick-on-failure.js';

/**
 * A stopped page as an agent reads it and acts on it, through the editor's MCP server: its ARIA snapshot in AI mode
 * (`page.ariaSnapshot({ mode: 'ai', depth })`, a ref per element), with an image of it when asked; an element of it by
 * its ref (`page.getByRef`, Playwright 1.64), ranked as the pause bar's Pick a locator ranks one, with the project's test
 * id attribute and the locator `locator.normalize()` writes among the candidates, and what it holds; an action on that
 * element, one of a closed set, played as trusted input by Playwright's own action; and the worker's browser bound for
 * Playwright's own tools (`browser.bind`, 1.59), until the test ends. The page's text, its address and its errors have
 * their credentials hidden (`@piwitests/core/mask`), and an image masks the page's password fields. Every call is the
 * caller's to make internal.
 */

/** How long an action, and a read of an element, may take on a stopped page. */
const ACT_MS = 5000;
/** What an image of the page masks: the fields whose value is a secret. */
const SECRET_FIELDS = 'input[type="password"], input[autocomplete="cc-number"], input[autocomplete="cc-csc"]';
/** The pause bar, hidden in an image of the stopped page. */
const BAR_HIDDEN = '#__piwi-pause-bar { display: none !important; }';

export const AGENT_NEEDS =
  'An agent reads and acts on a stopped page with Playwright 1.64 or later (page.getByRef and the AI snapshot): update @playwright/test.';

type ByRef = { getByRef?: (ref: string) => Locator };

/** Whether this Playwright lets an agent act by a ref: `page.getByRef` (1.64). */
export function canActByRef(page: Page): boolean {
  return typeof (page as unknown as ByRef).getByRef === 'function';
}

function byRef(page: Page, ref: string): Locator {
  return (page as unknown as Required<ByRef>).getByRef(ref);
}

/**
 * Why a page's call failed: the first line of Playwright's error alone, since its call log quotes the element's HTML
 * (the page's own text, which goes to the agent as Piwi's answer here), its credentials hidden.
 */
function failed(prefix: string, error: unknown): string {
  const first = errorMessage(error).split('\n')[0]!.trim();
  return hideSecretsInText(`${prefix}: ${first}`).slice(0, 300);
}

/** The most frames whose secret fields are read before a snapshot goes. */
const MAX_FRAMES = 32;

/** The values of the page's secret fields (a password, a card's number), in each of its frames: none goes in a snapshot. */
async function fieldSecrets(page: Page): Promise<string[]> {
  const values = await Promise.all(
    page
      .frames()
      .slice(0, MAX_FRAMES)
      .map((frame) =>
        frame
          .locator(SECRET_FIELDS)
          .evaluateAll((fields) => fields.map((field) => (field as unknown as { value?: unknown }).value))
          .catch(() => [] as unknown[]),
      ),
  );
  return [...new Set(values.flat().filter((v): v is string => typeof v === 'string' && v.length > 0))];
}

/**
 * A snapshot with the values of the page's secret fields written as `<hidden>`: where a field's line shows its value
 * (`- textbox "Password" [ref=e8]: hunter2`), and anywhere else for a value of 8 characters or more.
 */
export function withoutFieldSecrets(snapshot: string, secrets: readonly string[]): string {
  let out = snapshot;
  for (const secret of secrets) {
    const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`(: )${escaped}$`, 'gm'), '$1<hidden>');
    if (secret.length >= 8) out = out.split(secret).join('<hidden>');
  }
  return out;
}

/**
 * The stopped page's ARIA snapshot in AI mode, `depth` levels deep at most (the whole tree for null), its address and
 * title, and an image of it when `image` is true, its password fields masked and Piwi's pause bar hidden.
 */
export async function readSnapshot(page: Page, depth: number | null, image: boolean): Promise<SnapshotAnswer> {
  const none = { url: '', title: '', snapshot: null, cut: false, image: null };
  if (page.isClosed()) return { ok: false, message: 'The stopped page closed.', ...none };
  const url = hideSecretsInUrl(page.url()).slice(0, 8192);
  const title = hideSecretsInText(await page.title().catch(() => '')).slice(0, 1000);
  let snapshot: string;
  try {
    snapshot = await page.ariaSnapshot({ mode: 'ai', timeout: ACT_MS, ...(depth === null ? {} : { depth }) });
  } catch (error) {
    return { ok: false, message: failed('The stopped page could not be read', error), ...none, url, title };
  }
  const hidden = withoutFieldSecrets(hideSecretsInText(snapshot), await fieldSecrets(page));
  const cut = hidden.length > MAX_AGENT_SNAPSHOT;
  let shot: PausedImage | null = null;
  if (image) {
    const data = await page
      .screenshot({
        type: 'jpeg',
        quality: 60,
        style: BAR_HIDDEN,
        mask: [page.locator(SECRET_FIELDS)],
        timeout: ACT_MS,
      })
      .catch(() => null);
    const viewport = page.viewportSize();
    if (data) shot = { mime: 'image/jpeg', data: data.toString('base64'), ...viewport };
  }
  return {
    ok: true,
    message: image && !shot ? 'The stopped page, without an image: none could be taken.' : 'The stopped page.',
    url,
    title,
    snapshot: cut ? hidden.slice(0, MAX_AGENT_SNAPSHOT) : hidden,
    cut,
    image: shot,
  };
}

/** What an element is and holds, read in the page: its type, its value and whether it is checked. */
interface Held {
  type: string | null;
  value: string | null;
  checked: boolean | null;
}

/** In the page: an element's input type, its value (a form control's) and whether it is checked. Self-contained. */
const heldIn = (el: unknown): Held => {
  const field = el as { type?: unknown; value?: unknown; checked?: unknown; tagName?: string };
  const tag = (field.tagName ?? '').toLowerCase();
  const control = tag === 'input' || tag === 'textarea' || tag === 'select';
  const type = typeof field.type === 'string' ? field.type.toLowerCase() : null;
  return {
    type,
    value: control && typeof field.value === 'string' ? field.value : null,
    checked: tag === 'input' && (type === 'checkbox' || type === 'radio') ? field.checked === true : null,
  };
};

/** The element and its locators, ranked: those that find it alone first, each as Pick ranks it. */
async function ranked(
  page: Page,
  probe: PickerProbe,
  locator: Locator,
  handle: ElementHandle,
  testIdAttribute: string | null,
): Promise<{ element: RefElement; locators: RankedRefLocator[] }> {
  const { attrs, accessibleName, candidates } = await rankedCandidates(probe, locator, handle, testIdAttribute);
  const held = await handle.evaluate(heldIn);
  const checked: RankedRefLocator[] = [];
  for (const candidate of candidates.slice(0, MAX_CHECKED)) {
    checked.push({
      locator: candidate.locator,
      method: candidate.method,
      score: candidate.score,
      unique: await findsAlone(page, candidate.locator, handle),
    });
  }
  const locators = [...checked.filter((l) => l.unique), ...checked.filter((l) => !l.unique)];
  const secret = held.type === 'password';
  const text = attrs.textContent ? attrs.textContent.replace(/\s+/g, ' ').trim().slice(0, 120) || null : null;
  const role = resolveAriaRole({ ...attrs, accessibleName });
  return {
    element: {
      tagName: attrs.tagName.toLowerCase(),
      role,
      name: accessibleName ? hideSecretsInText(accessibleName).slice(0, 1000) : null,
      testId: attrs.attributes[testIdAttribute ?? 'data-testid'] ?? null,
      text: text && hideSecretsInText(text),
      value: secret || held.value === null ? null : hideSecretsInText(held.value).slice(0, 10_000),
      checked: held.checked,
      secret,
    },
    locators,
  };
}

/** Why a ref names no element, in a sentence. */
const NO_REF = (ref: string) =>
  `No element of the stopped page has the ref ${ref}: take the page's snapshot again, its refs may have changed.`;

/** The element `ref` names, as the snapshot gave it; null when none does. */
async function handleOf(page: Page, ref: string): Promise<ElementHandle | null> {
  return byRef(page, ref)
    .elementHandle({ timeout: 2000 })
    .catch(() => null);
}

/** The element `ref` names on the stopped page, and its locators ranked; why not otherwise. */
export async function refLocators(
  page: Page,
  probe: PickerProbe,
  ref: string,
  testIdAttribute: string | null,
): Promise<RefLocatorAnswer> {
  if (!canActByRef(page)) return { ok: false, message: AGENT_NEEDS, element: null, locators: [] };
  const handle = await handleOf(page, ref);
  if (!handle) return { ok: false, message: NO_REF(ref), element: null, locators: [] };
  try {
    const { element, locators } = await ranked(page, probe, byRef(page, ref), handle, testIdAttribute);
    const alone = locators.filter((l) => l.unique).length;
    return {
      ok: true,
      message: alone
        ? `${alone === 1 ? '1 locator finds' : `${alone} locators find`} that element alone.`
        : 'No locator Piwi tried finds that element alone on the page.',
      element,
      locators,
    };
  } catch (error) {
    return { ok: false, message: failed('The element could not be read', error), element: null, locators: [] };
  } finally {
    await handle.dispose().catch(() => undefined);
  }
}

/** Play an action on a locator as Playwright does, which a person's input in the page would be. */
async function play(locator: Locator, action: RunActAction, value: string | null): Promise<void> {
  const options = { timeout: ACT_MS };
  switch (action) {
    case 'click':
      return locator.click(options);
    case 'fill':
      return locator.fill(value ?? '', options);
    case 'press':
      return locator.press(value ?? '', options);
    case 'check':
      return locator.check(options);
    case 'uncheck':
      return locator.uncheck(options);
    case 'select':
      await locator.selectOption(value ?? '', options);
  }
}

/** What an action did, as its answer says it. */
const PLAYED: Record<RunActAction, string> = {
  click: 'Clicked',
  fill: 'Filled',
  press: 'Pressed a key on',
  check: 'Checked',
  uncheck: 'Unchecked',
  select: 'Selected an option of',
};

/**
 * Act on the element `ref` names, as trusted input (Playwright's own action, scrolled into view, waiting for the
 * element to take it, `ACT_MS` at most), with the element as it stood before, ranked, for the step it makes; why not
 * otherwise.
 */
export async function actOnRef(
  page: Page,
  probe: PickerProbe,
  act: { ref: string; action: RunActAction; value: string | null },
  testIdAttribute: string | null,
): Promise<ActAnswer> {
  if (!canActByRef(page)) return { ok: false, message: AGENT_NEEDS, element: null, locators: [] };
  const handle = await handleOf(page, act.ref);
  if (!handle) return { ok: false, message: NO_REF(act.ref), element: null, locators: [] };
  let before: { element: RefElement; locators: RankedRefLocator[] };
  try {
    before = await ranked(page, probe, byRef(page, act.ref), handle, testIdAttribute);
  } catch (error) {
    return { ok: false, message: failed('The element could not be read', error), element: null, locators: [] };
  } finally {
    await handle.dispose().catch(() => undefined);
  }
  try {
    await play(byRef(page, act.ref), act.action, act.value);
  } catch (error) {
    return { ok: false, message: failed(`${PLAYED[act.action]} ${act.ref} failed`, error), ...before };
  }
  return { ok: true, message: `${PLAYED[act.action]} ${act.ref}.`, ...before };
}

type Bindable = Browser & {
  bind?: (title: string, options?: { workspaceDir?: string }) => Promise<{ endpoint: string }>;
  unbind?: () => Promise<void>;
};

/** Whether this Playwright binds a browser for its own tools: `browser.bind` (1.59). */
export function canBind(browser: Browser | null): boolean {
  return typeof (browser as Bindable | null)?.bind === 'function';
}

/**
 * Bind the worker's browser for Playwright's own tools under `name` (`playwright-cli attach <name>`), naming the run's
 * working directory as its workspace, or unbind it (`on` false); why not otherwise.
 */
export async function bindBrowser(
  browser: Browser | null,
  name: string,
  workspaceDir: string,
  on: boolean,
): Promise<BindAnswer> {
  const bindable = browser as Bindable | null;
  if (!bindable || !canBind(browser)) {
    return {
      ok: false,
      message: 'Sharing with Playwright tools needs Playwright 1.59 or later (browser.bind): update @playwright/test.',
      name: null,
      endpoint: null,
    };
  }
  try {
    if (!on) {
      await bindable.unbind?.();
      return {
        ok: true,
        message: 'The browser is no longer shared with Playwright tools.',
        name: null,
        endpoint: null,
      };
    }
    const { endpoint } = await bindable.bind!(name, { workspaceDir });
    return {
      ok: true,
      message: `The browser is shared with Playwright tools as ${name} until the test ends: any process of yours can drive it.`,
      name,
      endpoint: endpoint.slice(0, 4096),
    };
  } catch (error) {
    return { ok: false, message: failed('The browser could not be shared', error), name: null, endpoint: null };
  }
}
