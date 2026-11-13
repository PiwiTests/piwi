import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HeadConfig, PageData, SiteConfig } from 'vitepress'

// Search engines show about 160 characters of a description; a couple of
// whole sentences up to this length reads better than one cut mid-word.
const MAX_DESCRIPTION = 200

/** The site's `<title>`: the page's title, then the project and the tool it works with. */
export const TITLE_TEMPLATE = ':title | Piwi for Playwright'

/**
 * The `<title>` VitePress writes, as its `createTitle` builds it: the title, or
 * the site's, put into a template holding `:title`; any other template string
 * follows ` | `, `true` or no template the site title, and `false` nothing.
 */
export function pageTitle(title: string, template: string | boolean | undefined, siteTitle: string): string {
  const shown = title || siteTitle
  if (typeof template === 'string' && template.includes(':title')) return template.replace(/:title/g, shown)
  const suffix =
    template === false ? '' : template === true || template === undefined ? siteTitle : template === siteTitle ? '' : template
  return suffix && suffix !== shown ? `${shown} | ${suffix}` : shown
}

/** The first paragraph of prose on the page: no heading, code, component, container or table. */
export function openingParagraph(markdown: string): string {
  const body = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')
  const paragraph: string[] = []
  let fence = false
  let block = ''
  let containers = 0
  for (const line of [...body.split(/\r?\n/), '']) {
    const text = line.trim()
    if (/^(```|~~~)/.test(text)) {
      fence = !fence
      continue
    }
    if (fence) continue
    if (block) {
      if (text.startsWith(`</${block}`)) block = ''
      continue
    }
    const open = /^<(script|style)\b/.exec(text)
    if (open) {
      if (!text.includes(`</${open[1]}`)) block = open[1]!
      continue
    }
    if (/^:::+\s*\S/.test(text)) {
      containers++
      continue
    }
    if (/^:::+$/.test(text)) {
      containers = Math.max(0, containers - 1)
      continue
    }
    if (containers) continue
    if (text === '') {
      if (paragraph.length) break
      continue
    }
    // A paragraph starts with a word; headings, lists, quotes, tables, images,
    // HTML and snippet imports all start with markup.
    if (paragraph.length === 0 && !/^[\p{L}\p{N}*_`[("“']/u.test(text)) continue
    paragraph.push(text)
  }
  return paragraph.join(' ')
}

/** Markdown inline markup reduced to the text a reader sees. */
export function toPlainText(markdown: string): string {
  const code: string[] = []
  return markdown
    .replace(/`([^`]+)`/g, (_, span: string) => `\u0000${code.push(span) - 1}\u0000`)
    .replace(/<[^>]+>/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(\*|_)(.+?)\1/g, '$2')
    .replace(/\u0000(\d+)\u0000/g, (_, index: string) => code[Number(index)]!)
    .replace(/\s+/g, ' ')
    .trim()
}

/** Whole sentences up to the length limit, or the first one cut at a word. */
export function clipDescription(text: string): string {
  let clipped = ''
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    const next = clipped ? `${clipped} ${sentence}` : sentence
    if (next.length > MAX_DESCRIPTION) break
    clipped = next
  }
  if (!clipped) clipped = `${text.slice(0, MAX_DESCRIPTION - 1).replace(/\s+\S*$/, '')}…`
  // A paragraph that leads into a list ends on a colon.
  return clipped.replace(/:$/, '.')
}

/** The frontmatter `description`, else a blog post's `excerpt`, else the page's opening paragraph. */
export function pageDescription(frontmatter: Record<string, unknown>, markdown: string): string {
  const written = frontmatter.description || frontmatter.excerpt
  if (typeof written === 'string') return written
  return clipDescription(toPlainText(openingParagraph(markdown)))
}

/** The page's published URL, as the sitemap lists it. */
export function pageUrl(siteUrl: string, relativePath: string, cleanUrls: boolean): string {
  const path = relativePath.replace(/(^|\/)index\.md$/, '$1').replace(/\.md$/, cleanUrls ? '' : '.html')
  return `${siteUrl}/${path}`
}

/**
 * Per-page search and link-preview metadata: the canonical URL, a description
 * of this page rather than of the whole site, and Open Graph tags that name the
 * page. The home page keeps the site-wide title, description and card.
 */
export function pageMeta(
  pageData: PageData,
  siteConfig: SiteConfig,
  siteUrl: string,
): { description?: string; head: HeadConfig[] } {
  const url = pageUrl(siteUrl, pageData.relativePath, siteConfig.cleanUrls)
  const head: HeadConfig[] = [
    ['link', { rel: 'canonical', href: url }],
    ['meta', { property: 'og:url', content: url }],
  ]
  const { frontmatter } = pageData
  if (frontmatter.layout === 'home') return { head }

  const description = pageDescription(frontmatter, readFileSync(join(siteConfig.srcDir, pageData.filePath), 'utf8'))
  const { title: siteTitle, titleTemplate } = siteConfig.site
  const title = pageTitle(pageData.title, frontmatter.titleTemplate ?? titleTemplate, siteTitle)
  head.push(['meta', { property: 'og:title', content: title }])
  if (description) head.push(['meta', { property: 'og:description', content: description }])
  if (frontmatter.date) head.push(['meta', { property: 'og:type', content: 'article' }])
  return { description: description || undefined, head }
}
