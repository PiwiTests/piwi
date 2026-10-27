import { beforeEach, describe, expect, it } from 'vitest';
import { fromExtensionPage, mayNameOrigin } from '../../src/background/senders';

const EXTENSION = 'chrome-extension://piwipicker/';
const SHOP = 'https://shop.test';

/** A content script in a tab of the shop, as the recorder's finish panel and the replay panel send. */
const shopTab = { url: `${SHOP}/cart`, tab: { id: 1, url: `${SHOP}/cart` } } as chrome.runtime.MessageSender;
/** An extension page opened in a tab, as the replay lab and the e2e specs start a replay. */
const extensionTab = {
  url: `${EXTENSION}popup.html`,
  tab: { id: 2, url: `${EXTENSION}popup.html` },
} as chrome.runtime.MessageSender;

beforeEach(() => {
  (globalThis as any).chrome = { runtime: { getURL: (path: string) => `${EXTENSION}${path}` } };
});

describe('the origin a sender may name', () => {
  it('lets a content script name its own tab origin', () => {
    expect(fromExtensionPage(shopTab)).toBe(false);
    expect(mayNameOrigin(shopTab, SHOP)).toBe(true);
  });

  it('refuses a content script naming another origin', () => {
    expect(mayNameOrigin(shopTab, 'https://bank.test')).toBe(false);
    expect(mayNameOrigin(shopTab, 'http://shop.test')).toBe(false);
    expect(mayNameOrigin(shopTab, 'https://shop.test:8443')).toBe(false);
  });

  it('refuses a content script whose tab address is unknown', () => {
    expect(mayNameOrigin({ url: `${SHOP}/cart`, tab: { id: 1 } } as chrome.runtime.MessageSender, SHOP)).toBe(false);
    expect(mayNameOrigin({ url: `${SHOP}/cart` } as chrome.runtime.MessageSender, SHOP)).toBe(false);
  });

  it('refuses a frame naming its own origin inside a tab of another', () => {
    const frame = {
      url: 'https://ads.test/frame',
      tab: { id: 1, url: `${SHOP}/cart` },
    } as chrome.runtime.MessageSender;
    expect(mayNameOrigin(frame, 'https://ads.test')).toBe(false);
  });

  it('lets an extension page name any origin', () => {
    expect(mayNameOrigin(extensionTab, SHOP)).toBe(true);
    expect(mayNameOrigin(extensionTab, 'https://bank.test')).toBe(true);
    expect(mayNameOrigin({ url: `${EXTENSION}options.html` } as chrome.runtime.MessageSender, SHOP)).toBe(true);
  });
});
