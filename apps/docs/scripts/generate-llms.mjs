/**
 * Generates apps/docs/public/llms.txt and apps/docs/public/llms-full.txt, the
 * llms.txt convention for publishing docs to language models
 * (https://llmstxt.org): an agent reads one URL instead of scraping pages.
 *
 * - llms.txt lists every page in sidebar order: its title, URL and the
 *   `description` from its front matter.
 * - llms-full.txt is every hand-written page as one Markdown file, with the
 *   snippet includes inlined. The generated reference pages are left out: they
 *   restate code registries, and llms.txt links them.
 *
 * Both files are build artifacts (gitignored), written into public/ so the
 * build copies them to the site root. Run it after the other generators, since
 * llms.txt lists the pages they write.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createJiti } from 'jiti';

const here = dirname(fileURLToPath(import.meta.url));
const docsRoot = join(here, '..');
const SITE = 'https://piwitests.dev';

// The pages docs:gen writes from registries; see the table in apps/docs/AGENTS.md.
const GENERATED = new Set([
  'reference/analytics-widgets',
  'reference/configuration',
  'reference/features',
  'reference/mcp-tools',
  'reference/metrics',
  'reference/reporter-options',
  'reference/whats-new',
]);

const jiti = createJiti(import.meta.url);
const { featuresSidebar, guideSidebar, referenceSidebar, selfHostingSidebar, sidebarEntries, toolsSidebar } =
  await jiti.import(join(docsRoot, '.vitepress/navigation.ts'));
const { demoExamplesFor } = await jiti.import(join(docsRoot, '../application/shared/demo/demo-examples.mjs'));
const { downloadsMarkdown } = await jiti.import(join(docsRoot, '../application/shared/app-downloads.mjs'));

const config = readFileSync(join(docsRoot, '.vitepress/config.mts'), 'utf8');
const title = /^\s*title: '([^']+)'/m.exec(config)?.[1];
const summary = /^\s*description:\s*'([^']+)'/m.exec(config)?.[1];
if (!title || !summary) throw new Error('generate-llms: no site title or description in .vitepress/config.mts');

const FRONT_MATTER = /^---\n([\s\S]*?)\n---\n/;

/** Each sidebar's entries, nested ones included, in the order of the top navigation, one entry per page. */
const SECTIONS = [
  ['Guide', guideSidebar],
  ['Features', featuresSidebar()],
  ['Tools', toolsSidebar()],
  ['Self-hosting', selfHostingSidebar],
  ['Reference', referenceSidebar],
];
const seen = new Set();
const sections = SECTIONS.map(([name, sidebar]) => ({
  name,
  pages: sidebarEntries(sidebar)
    .filter((item) => item.link.startsWith('/'))
    .map((item) => ({ text: item.text, page: item.link.replace(/^\//, '').replace(/#.*$/, '') }))
    .filter(({ page }) => !seen.has(page) && seen.add(page)),
}));

const read = (page) => {
  const path = join(docsRoot, `${page}.md`);
  if (!existsSync(path)) throw new Error(`generate-llms: the sidebar links /${page}, and there is no ${page}.md`);
  const source = readFileSync(path, 'utf8');
  const frontMatter = FRONT_MATTER.exec(source)?.[1] ?? '';
  const description = /^description:\s*"?(.*?)"?\s*$/m.exec(frontMatter)?.[1] ?? '';
  return { description, body: source.replace(FRONT_MATTER, '') };
};

// llms.txt: an H1, a blockquote summary, then one H2 per section of links.
const index = [`# ${title}`, '', `> ${summary}`, ''];
for (const { name, pages } of sections) {
  index.push(`## ${name}`, '');
  for (const { text, page } of pages) {
    const { description } = read(page);
    index.push(`- [${text}](${SITE}/${page})${description ? `: ${description}` : ''}`);
  }
  index.push('');
}
index.push('## Optional', '', `- [Full documentation](${SITE}/llms-full.txt): every hand-written page in one file`, '');
writeFileSync(join(docsRoot, 'public/llms.txt'), index.join('\n'));

// llms-full.txt: the hand-written pages, each introduced by its URL. A snippet
// include (`<<< @/snippets/file{lang}` or `… [tab]`) becomes a fenced block,
// <DemoExamples /> becomes the page's list of demo links, <DownloadApps /> the installers' links, and the <Needs> chips
// and the configuration widgets render nothing as text.
const inline = (body, page) =>
  body
    .replace(/^<DemoExamples\b[^>]*\/>[ \t]*$/gm, () =>
      demoExamplesFor(page)
        .map((example) => `- [${example.title}](${SITE}/demo${example.route}): ${example.shows}`)
        .join('\n'),
    )
    .replace(/^[ \t]*<DownloadApps\b([^>]*)\/>[ \t]*$/gm, (_, attrs) => {
      const app = /\bapp="(\w+)"/.exec(attrs)?.[1];
      return downloadsMarkdown(app ? [app] : undefined).join('\n');
    })
    .replace(/^([ \t]*)<<< @\/snippets\/([\w.-]+)(?:\{(\w+)\})?(?: \[([^\]]+)\])?[ \t]*$/gm, (_, indent, file, lang, tab) => {
      const code = readFileSync(join(docsRoot, 'snippets', file), 'utf8').trimEnd();
      const fence = `\`\`\`${lang ?? file.split('.').pop()}${tab ? ` [${tab}]` : ''}`;
      return [fence, ...code.split('\n'), '```'].map((line) => `${indent}${line}`).join('\n');
    })
    .replace(/^<(Needs|ConfigModeSwitch|EnvWizard)\b[^>]*\/>\s*\n/gm, '')
    .replace(/<!--[\s\S]*?-->\n?/g, '')
    .trim();

const full = [`# ${title}`, '', `> ${summary}`, ''];
for (const { pages } of sections) {
  for (const { page } of pages) {
    if (GENERATED.has(page)) continue;
    full.push(`<!-- ${SITE}/${page} -->`, '', inline(read(page).body, page), '');
  }
}
writeFileSync(join(docsRoot, 'public/llms-full.txt'), full.join('\n'));

console.log(
  `generated apps/docs/public/llms.txt (${seen.size} pages) and llms-full.txt (${[...seen].filter((p) => !GENERATED.has(p)).length} pages)`,
);
