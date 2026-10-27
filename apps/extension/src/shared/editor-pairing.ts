/**
 * Send to editor: the editor Piwi Picker is paired with (VS Code or a JetBrains
 * IDE on this computer). Its address and token are kept together in the secret
 * area (`secret-store.ts`), which only the background worker and the options
 * page read; `chrome.storage.local` keeps the address alone, so a content
 * script knows an editor is paired, with the time it was paired, so that
 * pairing again at the same address is a change the worker hears. The request
 * a content script makes to send to it is in `editor-send.ts`.
 */
import { parsePairing, type EditorPairing } from '@piwitests/core/editor-send';
import { isExtensionContext, moveLegacySecret, secretArea, type SecretArea } from './secret-store.js';
import { hostPattern } from './web-origin.js';

/** The editor's address in `chrome.storage.local`, without its token, and when it was paired (`at`). */
export const EDITOR_PAIRING_KEY = 'piwiEditorPairing';

/** The loopback names a pairing may be typed with, which stand for 127.0.0.1, the address both editors listen on. */
const LOOPBACK_NAMES = new Set(['localhost', '[::1]']);

/**
 * An editor's address on 127.0.0.1, as both editors hand it out. The editor proves it holds the token for its port
 * alone, so under another loopback name the address could reach another program on that port (`localhost` on
 * `[::1]`), which would relay the challenge to the editor and pass its proof back.
 */
export function canonicalEditorUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (!LOOPBACK_NAMES.has(parsed.hostname)) return url;
    parsed.hostname = '127.0.0.1';
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

/** A pasted pairing address (`parsePairing`), its address on 127.0.0.1; null unless it is one. */
export function parseEditorPairing(text: string): EditorPairing | null {
  const pairing = parsePairing(text);
  return pairing ? { url: canonicalEditorUrl(pairing.url), token: pairing.token } : null;
}

function coercePairing(value: unknown): EditorPairing | null {
  const v = value as Partial<EditorPairing> | null | undefined;
  return v && typeof v.url === 'string' && typeof v.token === 'string' && v.token
    ? { url: canonicalEditorUrl(v.url), token: v.token }
    : null;
}

/**
 * The paired editor. In the background worker and the options page it carries
 * the token; a content script, which cannot read it, gets the address with an
 * empty token, enough to know that an editor is paired.
 */
export async function getEditorPairing(area?: SecretArea): Promise<EditorPairing | null> {
  if (!area && !isExtensionContext()) {
    const stored = (await chrome.storage.local.get(EDITOR_PAIRING_KEY))[EDITOR_PAIRING_KEY] as
      | { url?: unknown }
      | undefined;
    return stored && typeof stored.url === 'string' ? { url: canonicalEditorUrl(stored.url), token: '' } : null;
  }
  const secrets = area ?? secretArea();
  await moveLegacyEditorPairing(secrets);
  return coercePairing(await secrets.get('editor'));
}

export async function setEditorPairing(pairing: EditorPairing | null, area: SecretArea = secretArea()): Promise<void> {
  if (pairing) {
    const url = canonicalEditorUrl(pairing.url);
    await area.set('editor', { url, token: pairing.token });
    // `at` changes with every pairing, the same address paired again with another token included.
    await chrome.storage.local.set({ [EDITOR_PAIRING_KEY]: { url, at: Date.now() } });
  } else {
    await area.remove('editor');
    // The run hubs the pairing found go with it.
    await area.remove('hubs');
    await chrome.storage.local.remove(EDITOR_PAIRING_KEY);
  }
}

/** Moves the token an older version kept in `chrome.storage.local` into the secret area, leaving the address. */
export async function moveLegacyEditorPairing(area: SecretArea = secretArea()): Promise<void> {
  const stored = (await chrome.storage.local.get(EDITOR_PAIRING_KEY))[EDITOR_PAIRING_KEY] as
    | { url?: unknown }
    | undefined;
  if (!stored || typeof stored !== 'object' || !('token' in stored)) return;
  await moveLegacySecret(area, 'editor', coercePairing(stored), () =>
    typeof stored.url === 'string'
      ? chrome.storage.local.set({ [EDITOR_PAIRING_KEY]: { url: stored.url } })
      : chrome.storage.local.remove(EDITOR_PAIRING_KEY),
  );
}

/** The host permission pattern for an editor's endpoint: its origin only. */
export function editorOriginPattern(pairing: EditorPairing): string {
  return hostPattern(new URL(pairing.url).origin);
}
