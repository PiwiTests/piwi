import { fileURLToPath, URL } from 'node:url'
import { defineConfig, type HeadConfig } from 'vitepress'
import { landingCards, nav, sidebars } from './navigation'
import { pageMeta } from './page-meta.mts'

// https://vitepress.dev/reference/site-config
const ogImage = 'https://piwitests.dev/og-image.png'
const siteUrl = 'https://piwitests.dev'

// Names the site in search results (the line above each result's title).
const websiteJsonLd: HeadConfig = [
  'script',
  { type: 'application/ld+json' },
  JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: 'Piwi Dashboard',
    alternateName: ['Piwi', 'PiwiTests'],
    url: `${siteUrl}/`,
  }),
]

export default defineConfig({
  title: 'Piwi Dashboard',
  description:
    'CI throws away every report it makes. Piwi keeps them, then groups the failures by root cause, scores the flaky tests, and finds the locator you should have used. Self-hosted, zero telemetry.',
  base: '/',
  // AGENTS.md is the agent guide for this directory, not a page of the site:
  // it links to sibling guides outside the docs root, so building it as a page
  // both publishes the wrong thing and fails the dead-link check.
  srcExclude: ['AGENTS.md'],
  // Example values in the generated configuration reference (PIWI_SITE_URL,
  // Ollama base URLs) are intentionally unreachable localhost URLs.
  ignoreDeadLinks: [/^https?:\/\/localhost/],
  sitemap: {
    hostname: siteUrl,
  },
  transformPageData(pageData, { siteConfig }) {
    // The landing page's cards are the catalog groups, one card each, so the
    // landing page, the sidebar and the All features page share one grouping.
    if (pageData.relativePath === 'index.md') pageData.frontmatter.features = landingCards()
    const { description, head } = pageMeta(pageData, siteConfig, siteUrl)
    pageData.frontmatter.head = [...(pageData.frontmatter.head ?? []), ...head]
    if (pageData.frontmatter.layout === 'home') pageData.frontmatter.head.push(websiteJsonLd)
    return description ? { description } : undefined
  },
  // VitePress writes the page description into the HTML unescaped; as a head
  // tag it is escaped, so a quote in a description cannot break the markup.
  transformHead: ({ description }) => [['meta', { name: 'description', content: description }]],
  vite: {
    // The #shared modules imported below live outside the docs root, and their
    // nearest tsconfig (application/tsconfig.json) references Nuxt-generated
    // .nuxt/tsconfig.*.json files that only exist after the app has been
    // installed. Inline an empty tsconfig so the docs build never reads
    // on-disk tsconfigs and stays independent of the app's install state.
    esbuild: {
      tsconfigRaw: '{}',
    },
    resolve: {
      alias: {
        // The env-var registry and format emitters are imported straight from
        // the application's shared modules — same alias the app uses, so the
        // docs (reference page + generator) can never drift from the code.
        '#shared': fileURLToPath(new URL('../../application/shared', import.meta.url)),
      },
    },
  },
  // The site-wide card is the home page's; every other page replaces its
  // title, description and URL with its own (page-meta.mts).
  head: [
    ['link', { rel: 'icon', href: '/favicon.ico', sizes: '16x16 32x32 48x48' }],
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/logo.svg' }],
    ['link', { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:site_name', content: 'Piwi Dashboard' }],
    ['meta', { property: 'og:title', content: 'Piwi Dashboard — Your Playwright results, kept and explained' }],
    [
      'meta',
      {
        property: 'og:description',
        content:
          'CI throws away every report it makes. Piwi keeps them, then groups the failures by root cause, scores the flaky tests, and finds the locator you should have used. Self-hosted, zero telemetry.',
      },
    ],
    ['meta', { property: 'og:image', content: ogImage }],
    ['meta', { property: 'og:image:width', content: '1200' }],
    ['meta', { property: 'og:image:height', content: '630' }],
    // X reads og:title, og:description and og:image when the twitter: ones are absent.
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
  ],
  themeConfig: {
    logo: '/logo.svg',
    outline: 'deep',
    search: {
      provider: 'local',
    },

    // Top navigation and sidebars live in navigation.ts, plain data the docs
    // drift test also reads. The Features sidebar is rendered from the feature
    // catalog there, so it cannot disagree with the All features page.
    nav,
    sidebar: sidebars(),

    editLink: {
      pattern: 'https://github.com/PiwiTests/platform/edit/main/apps/docs/:path',
      text: 'Edit this page on GitHub',
    },

    lastUpdated: {
      text: 'Updated at',
      formatOptions: {
        dateStyle: 'full',
        timeStyle: 'medium',
      },
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/PiwiTests/platform' },
    ],

    externalLinkIcon: true,

    footer: {
      message:
        'Fair source, released under the <a href="/guide/license">FSL-1.1-MIT license</a>; the reporter and integrations are MIT. Zero telemetry — Piwi never phones home.<br>Piwi Dashboard is not affiliated with, endorsed by, or connected to Microsoft Corporation. Playwright is a trademark of Microsoft.',
      copyright: 'Copyright © 2025-present Fabien Ménager',
    },
  },
})
