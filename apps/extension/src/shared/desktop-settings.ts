import { moveLegacySecret, secretArea, type SecretArea } from './secret-store.js';

/**
 * The optional pairing with the Piwi Dashboard desktop app: its loopback
 * address and access token, which **Pair** receives once the developer allows
 * it in the app's window, or which are pasted from the app's **Connect Piwi
 * Picker** (the extension cannot read `~/.piwi/desktop.json`). Kept together in
 * the secret area (`secret-store.ts`), so the token only goes to the address it
 * was paired with. Used only by the background worker, for **Run with
 * Playwright**, and by the options page.
 */
export interface DesktopSettings {
  /** The app's origin, such as `http://127.0.0.1:4318`. */
  url: string;
  token: string;
}

const DESKTOP_KEY = 'piwiDesktop';

/**
 * The address the desktop app takes when it is free (`PREFERRED_PORT` in
 * `apps/desktop/src-tauri/src/lib.rs`); another program on that port moves the
 * app to one its Setup page shows.
 */
export const DESKTOP_DEFAULT_URL = 'http://127.0.0.1:3000';

/**
 * The origin of a desktop app address, on 127.0.0.1, or null for anything that
 * is not plain http on this machine's loopback. The app binds 127.0.0.1 alone,
 * so `localhost` and `[::1]` are read as 127.0.0.1: the token never goes to
 * whatever listens on the IPv6 loopback on the app's port, which could relay
 * the app's proof for that port.
 */
export function desktopOrigin(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:') return null;
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return null;
  url.hostname = '127.0.0.1';
  return url.origin;
}

export function coerceDesktopSettings(value: unknown): DesktopSettings | null {
  const v = value as Partial<DesktopSettings> | null;
  if (!v || typeof v.url !== 'string' || typeof v.token !== 'string') return null;
  const url = desktopOrigin(v.url);
  const token = v.token.trim();
  return url && token ? { url, token } : null;
}

export async function getDesktopSettings(area: SecretArea = secretArea()): Promise<DesktopSettings | null> {
  await moveLegacyDesktopSettings(area);
  return coerceDesktopSettings(await area.get('desktop'));
}

export async function setDesktopSettings(settings: DesktopSettings, area: SecretArea = secretArea()): Promise<void> {
  await area.set('desktop', settings);
}

export async function clearDesktopSettings(area: SecretArea = secretArea()): Promise<void> {
  await area.remove('desktop');
  await chrome.storage.local.remove(DESKTOP_KEY);
}

/** Moves the pairing an older version kept in `chrome.storage.local` (`piwiDesktop`) into the secret area. */
export async function moveLegacyDesktopSettings(area: SecretArea = secretArea()): Promise<void> {
  const stored = await chrome.storage.local.get(DESKTOP_KEY);
  if (stored[DESKTOP_KEY] === undefined) return;
  await moveLegacySecret(area, 'desktop', coerceDesktopSettings(stored[DESKTOP_KEY]), () =>
    chrome.storage.local.remove(DESKTOP_KEY),
  );
}
