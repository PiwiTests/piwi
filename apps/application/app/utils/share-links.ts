/** What `GET /api/share-links/settings` answers. */
export interface ShareLinkSettings {
  enabled: boolean;
  /** The longest link lifetime in days; `0` allows links with no expiry. */
  maxTtlDays: number;
}

/**
 * Whether the dashboard offers share links: the **Share** button, the *Live
 * dashboard links* menu item and the switches that put a link in a report or
 * an issue. Only where the instance turns them on (`PIWI_SHARE_LINKS_ENABLED`),
 * and never in the desktop app, whose server has no public address, nor in the
 * demo, which has no server to open a link.
 */
export function shareLinksOffered(where: { enabled: boolean; desktop: boolean; demo: boolean }): boolean {
  return where.enabled && !where.desktop && !where.demo;
}
