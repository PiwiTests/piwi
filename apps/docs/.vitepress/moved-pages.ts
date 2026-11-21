import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Old URL → the page that replaced it, for every page that moved or never had
 * a page of its own. GitHub Pages has no server-side redirects, so the build
 * writes a redirect page at each old URL (`writeRedirectPages`): a 200 with an
 * instant meta refresh and a canonical link, which search engines take as a
 * permanent redirect. A key ending in `/` is a directory URL (`old/index.html`);
 * any other key also answers with `.html` appended. A target is a page path
 * without `.html`, with an optional `#anchor`.
 */
export const MOVED_PAGES: Record<string, string> = {
  '/deployment': '/operate/deployment',
  '/production-checklist': '/operate/production-checklist',
  '/upgrading': '/operate/upgrading',
  '/backup-restore': '/operate/backup-restore',
  '/authentication': '/operate/authentication',
  '/database': '/operate/database',
  '/storage': '/operate/storage',
  '/ui-overview': '/features/ui-overview',
  '/evidence': '/features/evidence',
  '/failure-clusters': '/features/failure-clusters',
  '/ai-diagnosis': '/features/ai-diagnosis',
  '/fix-plans': '/features/fix-plans',
  '/run-changes': '/features/run-changes',
  '/flaky-tests': '/features/flaky-tests',
  '/slow-tests': '/features/slow-tests',
  '/branches': '/features/branches',
  '/analytics': '/features/analytics',
  '/timeline-markers': '/features/timeline-markers',
  '/notifications': '/features/notifications',
  '/locator-healing': '/features/locator-healing',
  '/auto-heal': '/features/auto-heal',
  '/offline-export': '/features/offline-export',
  '/share-links': '/features/share-links',
  '/what-piwi-does': '/guide/what-piwi-does',
  '/getting-started': '/guide/getting-started',
  '/concepts': '/guide/concepts',
  '/first-failure': '/guide/first-failure',
  '/comparison': '/guide/comparison',
  '/privacy': '/guide/privacy',
  '/reporter': '/guide/reporter',
  '/capture-fixtures': '/guide/capture-fixtures',
  '/ai-steps': '/features/ai-steps',
  '/ci': '/guide/ci',
  '/test-selection': '/features/test-selection',
  '/backend-logs': '/guide/backend-logs',
  '/importing-runs': '/guide/importing-runs',
  '/desktop': '/features/desktop',
  '/extension': '/features/extension',
  '/mcp': '/features/mcp',
  '/ide-integration': '/features/ide-integration',
  '/test-functions': '/features/test-functions',
  '/cli': '/reference/cli',
  '/configuration': '/reference/configuration',
  '/configuration/generator': '/reference/configuration/generator',
  '/guide/ai-steps': '/features/ai-steps',
  '/guide/test-selection': '/features/test-selection',
  '/features/analytics-widgets': '/reference/analytics-widgets',
  '/reference/feature-map': '/reference/features',
  '/recipes': '/#something-is-red-right-now',
  '/recipes/': '/#something-is-red-right-now',
  '/operate/': '/operate/deployment',
  // The site's address on GitHub Pages before it had its own domain.
  '/piwi/': '/',
}

/** The URL a target page is published at: `.html` pages, `/` for the home page. */
export function movedTargetUrl(siteUrl: string, target: string): string {
  const [path, anchor] = target.split('#')
  const page = path === '/' ? '/' : `${path}.html`
  return `${siteUrl}${page}${anchor ? `#${anchor}` : ''}`
}

/** The files a moved key is answered from, relative to the site root. */
export function redirectFiles(from: string): string[] {
  return from.endsWith('/') ? [`${from.slice(1)}index.html`] : [`${from.slice(1)}.html`]
}

function redirectPage(url: string): string {
  // A target with its own anchor keeps it; any other carries the visitor's query and hash.
  const destination = url.includes('#') ? `'${url}'` : `'${url}' + location.search + location.hash`
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="0; url=${url}">
<link rel="canonical" href="${url}">
<title>Moved</title>
<script>location.replace(${destination})</script>
</head>
<body><p>This page has moved to <a href="${url}">${url}</a>.</p></body>
</html>
`
}

/** Writes a redirect page for every moved URL into the built site; a real page at a moved URL is an error. */
export function writeRedirectPages(outDir: string, siteUrl: string): void {
  for (const [from, target] of Object.entries(MOVED_PAGES)) {
    const html = redirectPage(movedTargetUrl(siteUrl, target))
    for (const file of redirectFiles(from)) {
      const path = join(outDir, file)
      if (existsSync(path)) throw new Error(`moved-pages: ${from} is a page of the site, not a moved URL`)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, html)
    }
  }
}
