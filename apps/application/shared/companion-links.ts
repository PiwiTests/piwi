/**
 * Where Piwi's separately installed tools are published: the store listings and
 * download pages the dashboard links to (the user menu's Piwi tools, the Setup
 * page's companion-tools card, the Open in IDE dialog).
 */

/** Piwi Picker for Chrome, Edge and other Chromium browsers. */
export const PICKER_CHROME_URL =
  'https://chromewebstore.google.com/detail/piwi-picker/pakhnokpjboejcghgcmkjlpnogfjihhe';
/** Piwi Picker for Firefox; the link without a language opens AMO in the visitor's own. */
export const PICKER_FIREFOX_URL = 'https://addons.mozilla.org/firefox/addon/piwi-picker/';
export const VSCODE_EXTENSION_URL = 'https://marketplace.visualstudio.com/items?itemName=PiwiTests.piwi';
export const JETBRAINS_PLUGIN_URL = 'https://plugins.jetbrains.com/plugin/34674-piwi';
export const DESKTOP_DOWNLOAD_URL = 'https://github.com/piwitests/piwi/releases/latest';
export const REPORTER_NPM_URL = 'https://www.npmjs.com/package/@piwitests/reporter';

/** Where Piwi Picker installs from in one browser: the store's name and the listing. */
export interface PickerStore {
  name: 'Chrome Web Store' | 'Firefox Add-ons';
  url: string;
}

/**
 * The store Piwi Picker installs from in the browser `userAgent` names: the
 * Chrome Web Store for Chrome, Edge and the other Chromium browsers, Firefox
 * Add-ons for Firefox, on the desktop only; null for every other browser
 * (Safari, a phone's or a tablet's), which it does not exist for.
 */
export function pickerStoreFor(userAgent: string): PickerStore | null {
  if (/Mobi|Android|iPhone|iPad/.test(userAgent)) return null;
  if (userAgent.includes('Firefox/')) return { name: 'Firefox Add-ons', url: PICKER_FIREFOX_URL };
  if (/Chrome\/|Chromium\//.test(userAgent)) return { name: 'Chrome Web Store', url: PICKER_CHROME_URL };
  return null;
}
