/**
 * The sites Piwi Picker may run on: the host permissions granted from its
 * `optional_host_permissions`, one per site recorded, replayed, opened in
 * DevTools or whose login was saved, plus the instance, the desktop app and the
 * editor it talks to. The settings page lists them with a Revoke each; this is
 * the pure half, which says what each grant is used for and whether it can go.
 */

/** What else holds a grant: the instance connected, the desktop app or the editor paired. Each gives it back itself. */
export type GrantUse = 'instance' | 'desktop' | 'editor';

/** What runs on a site now and needs its grant until it ends. */
export type GrantBusy = 'recording' | 'replay';

export interface SiteGrant {
  /** The host permission pattern, as `chrome.permissions.getAll` lists it: `https://shop.example/*`. */
  pattern: string;
  uses: GrantUse[];
  busy: GrantBusy | null;
}

/** The host permission pattern each use and each running tool holds; null for none. */
export interface GrantHolders {
  instance: string | null;
  desktop: string | null;
  editor: string | null;
  recording: string | null;
  replay: string | null;
}

/** The host part of a pattern, for the order of the list: `shop.example` for `https://shop.example/*`. */
function hostOf(pattern: string): string {
  return pattern.replace(/^[^:]*:\/\//, '').replace(/\/.*$/, '');
}

/** Every granted pattern once, by host, with what holds it. */
export function siteGrants(origins: readonly string[], holders: GrantHolders): SiteGrant[] {
  const patterns = [...new Set(origins)].sort((a, b) => hostOf(a).localeCompare(hostOf(b)) || a.localeCompare(b));
  return patterns.map((pattern) => ({
    pattern,
    uses: (['instance', 'desktop', 'editor'] as const).filter((use) => holders[use] === pattern),
    busy: holders.recording === pattern ? 'recording' : holders.replay === pattern ? 'replay' : null,
  }));
}

/**
 * Whether Revoke may take the grant back here: not while a recording or a
 * replay runs on the site, which would stop following it from page to page,
 * and not while the instance or a pairing uses it, which Disconnect or Unpair
 * give back with the rest of what they hold.
 */
export function canRevoke(grant: SiteGrant): boolean {
  return grant.uses.length === 0 && grant.busy === null;
}
