import { webOrigin } from '../shared/web-origin.js';

/** A message from one of the extension's own pages (popup, options, DevTools), not from a content script. */
export function fromExtensionPage(sender: chrome.runtime.MessageSender): boolean {
  return !!sender.url?.startsWith(chrome.runtime.getURL(''));
}

/**
 * Whether a sender may name `origin` as the site to act on: an extension page
 * names any origin, a content script only the origin of its own tab.
 */
export function mayNameOrigin(sender: chrome.runtime.MessageSender, origin: string): boolean {
  if (fromExtensionPage(sender)) return true;
  return webOrigin(sender.tab?.url) === origin;
}
