import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { desktopPagePath, desktopSessionTarget } from '#shared/desktop-handoff';
import {
  DESKTOP_HANDOFF_CSP,
  isOutsideNavigation,
  renderDesktopHandoffPage,
  requestDesktopOpen,
  subscribeDesktopOpenRequests,
} from '../../server/utils/desktop-handoff';

describe('desktopSessionTarget', () => {
  it('shows the page a link named once the window is signed in', () => {
    expect(desktopSessionTarget('/test-runs/146?tab=changes')).toBe('/test-runs/146?tab=changes');
    expect(desktopSessionTarget('/settings')).toBe('/settings');
  });

  it('shows the home page for anything that is not a dashboard page', () => {
    expect(desktopSessionTarget(undefined)).toBe('/');
    expect(desktopSessionTarget(['/settings', '/projects'])).toBe('/');
    expect(desktopSessionTarget('//evil.example/')).toBe('/');
    expect(desktopSessionTarget('https://evil.example/')).toBe('/');
    expect(desktopSessionTarget('/api/test-runs')).toBe('/');
    expect(desktopSessionTarget('/__piwi/session?token=x')).toBe('/');
    // A browser drops a tab or a line break from a URL: `/<tab>/host` would read as `//host`.
    expect(desktopSessionTarget('/\t/evil.example/x')).toBe('/');
    expect(desktopSessionTarget('/settings\r\nSet-Cookie: x=1')).toBe('/');
  });
});

describe('desktopPagePath', () => {
  it('keeps a dashboard page with its query', () => {
    expect(desktopPagePath('/test-runs/146')).toBe('/test-runs/146');
    expect(desktopPagePath('/test-runs/146?tab=changes')).toBe('/test-runs/146?tab=changes');
    expect(desktopPagePath('/')).toBe('/');
  });

  it('drops the fragment', () => {
    expect(desktopPagePath('/failure-clusters/3#evidence')).toBe('/failure-clusters/3');
  });

  it('refuses the API, build assets and desktop routes', () => {
    expect(desktopPagePath('/api/test-runs/146')).toBeNull();
    expect(desktopPagePath('/_nuxt/entry.js')).toBeNull();
    expect(desktopPagePath('/__piwi/session?token=x')).toBeNull();
    expect(desktopPagePath('/_openapi.json')).toBeNull();
  });

  it('refuses static files', () => {
    expect(desktopPagePath('/logo.svg')).toBeNull();
    expect(desktopPagePath('/favicon.ico')).toBeNull();
  });

  it('refuses anything that could leave the origin', () => {
    expect(desktopPagePath('//evil.example/test-runs/1')).toBeNull();
    expect(desktopPagePath('/\\evil.example')).toBeNull();
    expect(desktopPagePath('/\t/evil.example')).toBeNull();
    expect(desktopPagePath('/\n/evil.example')).toBeNull();
    expect(desktopPagePath('/settings\u007f')).toBeNull();
    expect(desktopPagePath('https://evil.example/')).toBeNull();
    expect(desktopPagePath('javascript:alert(1)')).toBeNull();
    expect(desktopPagePath('')).toBeNull();
  });
});

describe('isOutsideNavigation', () => {
  const outside = {
    method: 'GET',
    secFetchSite: 'none',
    secFetchMode: 'navigate',
    secFetchDest: 'document',
    purpose: undefined,
  };

  it('accepts a page load no web page started', () => {
    expect(isOutsideNavigation(outside)).toBe(true);
  });

  it('refuses a navigation a web page started', () => {
    expect(isOutsideNavigation({ ...outside, secFetchSite: 'cross-site' })).toBe(false);
    expect(isOutsideNavigation({ ...outside, secFetchSite: 'same-site' })).toBe(false);
    expect(isOutsideNavigation({ ...outside, secFetchSite: 'same-origin' })).toBe(false);
  });

  it('refuses frames, fetches and requests without fetch metadata', () => {
    expect(isOutsideNavigation({ ...outside, secFetchDest: 'iframe' })).toBe(false);
    expect(isOutsideNavigation({ ...outside, secFetchMode: 'cors', secFetchDest: 'empty' })).toBe(false);
    expect(
      isOutsideNavigation({
        method: 'GET',
        secFetchSite: undefined,
        secFetchMode: undefined,
        secFetchDest: undefined,
        purpose: undefined,
      }),
    ).toBe(false);
  });

  it('refuses a prefetch or a prerender', () => {
    expect(isOutsideNavigation({ ...outside, purpose: 'prefetch;prerender' })).toBe(false);
    expect(isOutsideNavigation({ ...outside, purpose: 'prefetch' })).toBe(false);
  });

  it('refuses anything but GET', () => {
    expect(isOutsideNavigation({ ...outside, method: 'POST' })).toBe(false);
  });
});

describe('desktop open requests', () => {
  it('reports that no window is listening', () => {
    expect(requestDesktopOpen('/test-runs/1')).toBe(false);
  });

  it('forwards a page to every listening window until it unsubscribes', () => {
    const received: string[] = [];
    const unsubscribe = subscribeDesktopOpenRequests((path) => received.push(path));

    expect(requestDesktopOpen('/test-runs/146')).toBe(true);
    expect(received).toEqual(['/test-runs/146']);

    unsubscribe();
    expect(requestDesktopOpen('/test-runs/147')).toBe(false);
    expect(received).toEqual(['/test-runs/146']);
  });
});

describe('renderDesktopHandoffPage', () => {
  /** Every `<script …>` tag of the page, as its opening tag and its body. */
  const scripts = (html: string) =>
    [...html.matchAll(/(<script\b[^>]*>)([\s\S]*?)<\/script>/gi)].map((m) => ({ tag: m[1]!, body: m[2]! }));
  const directive = (name: string) =>
    DESKTOP_HANDOFF_CSP.split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${name} `));

  it('tells the user the page is in the app', () => {
    const html = renderDesktopHandoffPage(true);
    expect(html).toContain('data-desktop-handoff="shown"');
    expect(html).toContain('Opened in Piwi Dashboard');
  });

  it('closes the tab with the one script its policy allows', () => {
    const found = scripts(renderDesktopHandoffPage(true));
    expect(found).toEqual([{ tag: '<script>', body: 'window.close();' }]);
    const hash = createHash('sha256').update(found[0]!.body).digest('base64');
    expect(directive('script-src')).toBe(`script-src 'sha256-${hash}'`);
    expect(directive('default-src')).toBe("default-src 'none'");
  });

  it('points to the tray when no window is listening, and keeps the tab open', () => {
    const html = renderDesktopHandoffPage(false);
    expect(html).toContain('data-desktop-handoff="not-ready"');
    expect(html).toContain('tray icon');
    expect(scripts(html)).toEqual([]);
    expect(html).not.toMatch(/<script\b/i);
  });
});
