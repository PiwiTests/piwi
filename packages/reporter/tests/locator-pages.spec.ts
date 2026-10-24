import { describe, it, expect, vi } from 'vitest';
import { piwiFixtures } from '../src/internal/capture/capture-fixtures.js';
import { ATTACHMENT_NAMES } from '../src/internal/capture/attachments.js';
import {
  LocatorPageLog,
  MAX_LOCATOR_PAGE_ENTRIES,
  isOnArrival,
  noteLocatorCall,
  noteNavigation,
  pageOf,
} from '../src/internal/capture/locator-pages.js';
import type { LocatorPageUse } from '@piwitests/core/wire';

describe('pageOf', () => {
  it('keeps the origin and the normalized path, never the query or the hash', () => {
    expect(pageOf('https://shop.test/orders/123?token=abc#details')).toEqual({
      origin: 'https://shop.test',
      page: '/orders/:id',
    });
    expect(pageOf('http://localhost:3000/')).toEqual({ origin: 'http://localhost:3000', page: '/' });
  });

  it('is null off an http(s) page', () => {
    expect(pageOf('about:blank')).toBeNull();
    expect(pageOf('data:text/html,<p>')).toBeNull();
    expect(pageOf('chrome-error://chromewebdata/')).toBeNull();
  });
});

describe('LocatorPageLog', () => {
  const call = (overrides: Partial<Parameters<LocatorPageLog['record']>[0]> = {}) => ({
    location: '/work/shop/tests/cart.spec.ts:4:5',
    locator: "getByRole('button', { name: 'Pay' })",
    url: 'https://shop.test/checkout',
    arrival: false,
    ...overrides,
  });

  it('keeps one entry per call site, chain and page, on arrival if any call was', () => {
    const log = new LocatorPageLog();
    log.record(call({ arrival: false }));
    log.record(call({ arrival: true }));
    log.record(call({ url: 'https://shop.test/cart' }));
    expect(log.list()).toEqual([
      {
        location: '/work/shop/tests/cart.spec.ts:4:5',
        locator: "getByRole('button', { name: 'Pay' })",
        origin: 'https://shop.test',
        page: '/checkout',
        arrival: true,
      },
      {
        location: '/work/shop/tests/cart.spec.ts:4:5',
        locator: "getByRole('button', { name: 'Pay' })",
        origin: 'https://shop.test',
        page: '/cart',
        arrival: false,
      },
    ]);
  });

  it('skips a call without a call site, off an http(s) page, or with a very long chain', () => {
    const log = new LocatorPageLog();
    log.record(call({ location: null }));
    log.record(call({ url: 'about:blank' }));
    log.record(call({ locator: `getByText('${'x'.repeat(1000)}')` }));
    expect(log.size).toBe(0);
  });

  it('stops adding past its limit', () => {
    const log = new LocatorPageLog();
    for (let i = 0; i < MAX_LOCATOR_PAGE_ENTRIES + 5; i++) log.record(call({ url: `https://shop.test/p${i}x` }));
    expect(log.size).toBe(MAX_LOCATOR_PAGE_ENTRIES);
  });
});

describe('arrival', () => {
  it('holds until the first locator interaction on the page, and again after each navigation', () => {
    const page = {};
    expect(isOnArrival(page)).toBe(true);
    // An assertion and a wait leave the page as it was.
    expect(noteLocatorCall(page, '_expect', true)).toBe(true);
    expect(noteLocatorCall(page, 'waitFor')).toBe(true);
    // A click changes it: the call itself is on arrival, what follows is not.
    expect(noteLocatorCall(page, 'click')).toBe(true);
    expect(noteLocatorCall(page, 'fill')).toBe(false);
    expect(isOnArrival(page)).toBe(false);
    noteNavigation(page);
    expect(isOnArrival(page)).toBe(true);
  });
});

describe('capture fixtures record the page of each locator call', () => {
  const FAKE_ATTRS = {
    tagName: 'div',
    attributes: {},
    textContent: 'Pay',
    center: { x: 10, y: 20 },
    hasLabel: false,
    selectorCounts: {},
    rolePosition: null,
    ancestors: [],
  };

  it('attaches the call site, the chain, the page and whether it was on arrival', async () => {
    let url = 'https://shop.test/cart';
    let onNavigated: ((frame: unknown) => void) | undefined;
    const mainFrame = {};
    const makeLocator = (chain: string) => ({
      toString: () => chain,
      click: vi.fn(async () => undefined),
      _expect: vi.fn(async () => ({ matches: true })),
      evaluate: vi.fn(async () => FAKE_ATTRS),
    });
    const rootLocator = { ariaSnapshot: async () => null };
    const fakePage = {
      getByRole: (_role: string, opts: { name: string }) => makeLocator(`getByRole('button', { name: '${opts.name}' })`),
      getByTestId: () => makeLocator("getByTestId('x')"),
      getByText: () => makeLocator("getByText('x')"),
      getByLabel: () => makeLocator("getByLabel('x')"),
      getByPlaceholder: () => makeLocator("getByPlaceholder('x')"),
      getByAltText: () => makeLocator("getByAltText('x')"),
      getByTitle: () => makeLocator("getByTitle('x')"),
      locator: (sel: string) => (sel === ':root' ? rootLocator : makeLocator(`locator('${sel}')`)),
      on: (event: string, handler: (frame: unknown) => void) => {
        if (event === 'framenavigated') onNavigated = handler;
      },
      mainFrame: () => mainFrame,
      url: () => url,
      evaluate: async () => null,
    };
    const testInfo = {
      status: 'passed',
      attach: vi.fn(async (_name: string, _body: { body: Buffer }) => {}),
      annotations: [] as unknown[],
    };
    const pageFixture = piwiFixtures.page as unknown as (
      args: { page: unknown },
      use: (page: typeof fakePage) => Promise<void>,
    ) => Promise<void>;
    const [captureFixture] = piwiFixtures.piwiCapture as unknown as [
      (args: object, use: () => Promise<void>, testInfo: unknown) => Promise<void>,
    ];

    await captureFixture(
      {},
      () =>
        pageFixture({ page: fakePage }, async (page) => {
          type Loc = { click(): Promise<unknown>; _expect(e: string, o: object): Promise<unknown> };
          const getByRole = page.getByRole as unknown as (role: string, opts: { name: string }) => Loc;
          // On /cart: an assertion and a click as the page loads, then a click after one.
          await getByRole('heading', { name: 'Your cart' })._expect('to.be.visible', { isNot: false });
          await getByRole('button', { name: 'Checkout' }).click();
          await getByRole('button', { name: 'Remove' }).click();
          // The click navigated to /checkout: calls there start on arrival again.
          url = 'https://shop.test/checkout?step=1';
          onNavigated?.(mainFrame);
          await getByRole('button', { name: 'Pay' })._expect('to.be.visible', { isNot: true });
        }),
      testInfo,
    );

    const attached = testInfo.attach.mock.calls.find((c) => c[0] === ATTACHMENT_NAMES.locatorPages);
    expect(attached).toBeDefined();
    const entries = JSON.parse(attached![1].body.toString()) as LocatorPageUse[];
    expect(entries.map(({ locator, page, arrival, origin }) => ({ locator, page, arrival, origin }))).toEqual([
      { locator: "getByRole('button', { name: 'Your cart' })", page: '/cart', arrival: true, origin: 'https://shop.test' },
      { locator: "getByRole('button', { name: 'Checkout' })", page: '/cart', arrival: true, origin: 'https://shop.test' },
      { locator: "getByRole('button', { name: 'Remove' })", page: '/cart', arrival: false, origin: 'https://shop.test' },
      // A negated assertion records its page too.
      { locator: "getByRole('button', { name: 'Pay' })", page: '/checkout', arrival: true, origin: 'https://shop.test' },
    ]);
    // Each call site is this spec file, as the step location reports it.
    for (const entry of entries) expect(entry.location).toMatch(/tests\/locator-pages\.spec\.ts:\d+:\d+$/);
  });
});
