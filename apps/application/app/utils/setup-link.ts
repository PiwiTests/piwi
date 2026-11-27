/**
 * The token a setup link carries in its address fragment (`/login#setup=<token>`), which no request sends to the
 * server: `undefined` when the fragment holds no `setup` key, `null` when its value is empty. The value is
 * percent-decoded only, so a `+` in a token stays a `+`.
 */
export function setupLinkToken(fragment: string): string | null | undefined {
  for (const part of fragment.replace(/^#/, '').split('&')) {
    if (part !== 'setup' && !part.startsWith('setup=')) continue;
    const raw = part.slice('setup='.length);
    let token = raw;
    try {
      token = decodeURIComponent(raw);
    } catch {
      // A malformed escape: the text as written.
    }
    return token.trim() || null;
  }
  return undefined;
}
