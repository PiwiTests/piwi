import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Old URL → the page that replaced it, for every page that moved or never had
 * a page of its own. The build writes a redirect page at each old URL
 * (`writeRedirectPages`): an instant meta refresh and a canonical link, which
 * search engines take as a permanent redirect. A key without a trailing slash
 * answers as `old`, `old.html` and `old/`; a key ending in `/` as that directory
 * only. A target is a page path without `.html` (or a directory ending in `/`),
 * with an optional `#anchor`.
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
  '/operate/': '/operate/deployment',
}

/** The path a target page is published at: `.html` pages, directories as they are. */
export function movedTargetPath(target: string): string {
  const [path, anchor] = target.split('#')
  const page = path!.endsWith('/') ? path! : `${path}.html`
  return `${page}${anchor ? `#${anchor}` : ''}`
}

/** The files a moved key is answered from, relative to the site root. */
export function redirectFiles(from: string): string[] {
  const path = from.slice(1)
  return from.endsWith('/') ? [`${path}index.html`] : [`${path}.html`, `${path}/index.html`]
}

function redirectPage(path: string, siteUrl: string): string {
  // A target with its own anchor keeps it; any other carries the visitor's query and hash.
  const destination = path.includes('#') ? `'${path}'` : `'${path}' + location.search + location.hash`
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="0; url=${path}">
<link rel="canonical" href="${siteUrl}${path}">
<title>Moved</title>
<script>location.replace(${destination})</script>
</head>
<body><p>This page has moved to <a href="${path}">${siteUrl}${path}</a>.</p></body>
</html>
`
}

/** Writes a redirect page for every moved URL into the built site; a real page at a moved URL is an error. */
export function writeRedirectPages(outDir: string, siteUrl: string): void {
  for (const [from, target] of Object.entries(MOVED_PAGES)) {
    const html = redirectPage(movedTargetPath(target), siteUrl)
    for (const file of redirectFiles(from)) {
      const path = join(outDir, file)
      if (existsSync(path)) throw new Error(`moved-pages: ${from} is a page of the site, not a moved URL`)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, html)
    }
  }
}
