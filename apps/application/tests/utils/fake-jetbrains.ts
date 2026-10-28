import type { Page, Route } from '@playwright/test';

/**
 * The Piwi JetBrains plugin's `/api/piwi/open` on every port a JetBrains IDE's
 * built-in server may take, faked by intercepting the requests in the browser,
 * so an IDE running on the machine never answers.
 */
const PLUGIN = /^http:\/\/127\.0\.0\.1:\d+\/api\/piwi\/open\?/;

export interface FakeIde {
  port: number;
  ide: string;
  holds: boolean;
  /** The answer to a request that is not a check, in place of the plugin's `opened`. */
  open?: { status: number; body: Record<string, unknown> };
}

/** Answer the plugin's requests as `ides` would; every other port refuses the connection. Returns the requests seen. */
export async function fakeJetbrainsIdes(page: Page, ides: FakeIde[]): Promise<URL[]> {
  const seen: URL[] = [];
  await page.route(PLUGIN, async (route: Route) => {
    const url = new URL(route.request().url());
    seen.push(url);
    const ide = ides.find((i) => String(i.port) === url.port);
    if (!ide) return route.abort('connectionrefused');
    const check = url.searchParams.has('check');
    const answer =
      !check && ide.holds && ide.open
        ? ide.open
        : {
            status: ide.holds ? 200 : 404,
            body: ide.holds
              ? {
                  found: true,
                  opened: !check,
                  ide: ide.ide,
                  project: 'shop',
                  file: `/home/me/shop/${url.searchParams.get('file')}`,
                }
              : { found: false, ide: ide.ide, projects: ['other-app'], error: 'not found' },
          };
    await route.fulfill({
      status: answer.status,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify(answer.body),
    });
  });
  // IDE Remote Control's endpoint, and the built-in server's root, which Auto asks after the plugin: nothing listens.
  await page.route(
    (url) => Number(url.port) >= 63342 && Number(url.port) <= 63361 && !url.pathname.startsWith('/api/piwi/'),
    (route) => route.abort('connectionrefused'),
  );
  return seen;
}
