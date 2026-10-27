/**
 * The documentation corpus behind the MCP `describe_piwi` tool: the docs site's
 * Markdown pages, bundled into the server build (`nitro.serverAssets` in
 * nuxt.config.ts), so an agent reads the documentation of the version it is
 * talking to, with no network.
 *
 * Pure functions over a `relative path → file text` map, unit-tested against the
 * real `apps/docs` tree: parse each page into a title, a one-line summary and its
 * heading sections, read one page or one section, and rank sections for a query.
 * Anchors are slugged the way VitePress slugs them, so `page#anchor` here is the
 * same address as on the site.
 */
import { DOCS_BASE_URL } from '#shared/docs';
import { FEATURE_NEED_LABELS, type FeatureNeed } from '#shared/piwi-features';
import { isGeneratedDocsPage } from '#shared/docs-generated-pages';
import { demoExamplesFor } from '#shared/demo/demo-examples.mjs';

/** The top-level sections of the site, keyed by path prefix, in reading order. */
export const DOCS_GROUPS = [
  {
    id: 'guide',
    title: 'Guide',
    intro: 'Getting a first run in; setting up the reporter, fixtures, CI, source control and AI; and what Piwi is.',
  },
  { id: 'features', title: 'Features', intro: 'Every feature, one page each, in the groups of the feature catalog.' },
  { id: 'recipes', title: 'Recipes', intro: 'One question each, answered across several features.' },
  {
    id: 'operate',
    title: 'Self-hosting',
    intro: 'Running your own instance: install, configure, keep the data, upgrade.',
  },
  {
    id: 'reference',
    title: 'Reference',
    intro: 'Lookups: all features, configuration, the CLI, file formats and rules.',
  },
] as const;

export type DocsGroupId = (typeof DOCS_GROUPS)[number]['id'] | 'home';

/** True for a bundled file that is a docs page (not a snippet, the blog, or an agent guide). */
export function isDocsPageFile(path: string): boolean {
  if (!path.endsWith('.md') || path.startsWith('blog/') || path.endsWith('AGENTS.md') || path.endsWith('CLAUDE.md'))
    return false;
  return !isGeneratedDocsPage(path.replace(/\.md$/, ''));
}

export interface DocsHeading {
  /** VitePress anchor of the heading. */
  anchor: string;
  /** The heading as a reader sees it, markdown stripped. */
  text: string;
  level: number;
}

export interface DocsSection extends DocsHeading {
  /** First line of the section (its heading line) in the page's line array. */
  start: number;
  /** End (exclusive) of the section's own text, up to the next heading of any level. */
  ownEnd: number;
  /** End (exclusive) of the section with its sub-sections, up to the next heading of the same or a higher level. */
  end: number;
}

export interface DocsPage {
  /** Path without extension, e.g. `guide/reporter`; the landing page is `index`. */
  path: string;
  group: DocsGroupId;
  title: string;
  /** The page's first paragraph as plain text — what the page is for. */
  summary: string;
  /** Served Markdown lines: front matter dropped, snippet includes and components rendered as text. */
  lines: string[];
  /** Every heading from level 2 down, in page order. The lead (title to first `##`) is not listed. */
  sections: DocsSection[];
}

export interface DocsCorpus {
  pages: DocsPage[];
  byPath: Map<string, DocsPage>;
}

// ── Slugs ─────────────────────────────────────────────────────────────────────

// VitePress's default slugify (@mdit-vue/shared), character for character.
// eslint-disable-next-line no-control-regex
const SLUG_CONTROL = /[\u0000-\u001f]/g;
const SLUG_SPECIAL = /[\s~`!@#$%^&*()\-_+=[\]{}|\\;:"'“”‘’<>,.?/]+/g;
const SLUG_COMBINING = /[̀-ͯ]/g;

/** The anchor VitePress gives a heading's plain text. */
export function slugifyHeading(text: string): string {
  return text
    .normalize('NFKD')
    .replace(SLUG_COMBINING, '')
    .replace(SLUG_CONTROL, '')
    .replace(SLUG_SPECIAL, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^(\d)/, '_$1')
    .toLowerCase();
}

/**
 * A heading's text as rendered — code spans keep their content, HTML tags and
 * link targets go — plus its explicit `{#anchor}` when it declares one.
 */
export function parseHeadingText(raw: string): { text: string; explicitAnchor: string | null } {
  let source = raw.trim();
  const explicit = source.match(/\s*\{#([\w-]+)\}\s*$/);
  if (explicit) source = source.slice(0, explicit.index).trim();
  const text = source
    .replace(/`([^`]*)`|<[^>]*>/g, (match, code: string | undefined) => (code === undefined ? '' : code))
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .trim();
  return { text, explicitAnchor: explicit?.[1] ?? null };
}

// ── Markdown → served text ────────────────────────────────────────────────────

const SNIPPET_LANGUAGES: Record<string, string> = { sh: 'bash', ps1: 'powershell', ts: 'ts', js: 'js', json: 'json' };

/** `<<< @/snippets/file.ext{lang} [Tab label]` — a VitePress code include. */
const SNIPPET_INCLUDE = /^(\s*)<<<\s+@\/(\S+?)(?:\{([^}]*)\})?(?:\s+\[([^\]]+)\])?\s*$/;

function snippetFence(line: string, files: Record<string, string>): string[] | null {
  const match = line.match(SNIPPET_INCLUDE);
  if (!match) return null;
  const [, indent = '', file = '', braces, label] = match;
  const content = files[file];
  if (content === undefined) return null;
  const ext = file.split('.').pop() ?? '';
  const lang = braces?.split(/\s+/).find((token) => /^[a-z]+$/i.test(token)) ?? SNIPPET_LANGUAGES[ext] ?? ext;
  const fence = [`\`\`\`${lang}${label ? ` [${label}]` : ''}`, ...content.replace(/\s+$/, '').split('\n'), '```'];
  return fence.map((l) => (l ? indent + l : l));
}

/** The `<Needs …/>` prerequisite row, as the words the feature map uses. */
function needsLine(line: string): string | null {
  const match = line.match(/^\s*<Needs\b([^>]*)\/>\s*$/);
  if (!match) return null;
  const props = (match[1] ?? '').trim().split(/\s+/).filter(Boolean);
  const labels = props.map((p) => (p === 'reporter' ? 'the reporter' : (FEATURE_NEED_LABELS[p as FeatureNeed] ?? p)));
  return `**Needs:** ${labels.join(', ')}`;
}

/**
 * Render one source line for an agent: Vue components and layout-only HTML
 * become the text they stand for, or disappear. Returns null to drop the line.
 */
function renderLine(line: string): string | null {
  const needs = needsLine(line);
  if (needs) return needs;
  if (/^\s*<\/?(div|figure|ConfigModeSwitch|EnvWizard)\b[^>]*>\s*$/.test(line)) return null;
  if (/^\s*<ConfigModeSwitch\b|^\s*<EnvWizard\b/.test(line)) return null;
  return line
    .replace(/<video\b[^>]*>\s*<\/video>/g, '')
    .replace(/<img\b[^>]*?\balt="([^"]*)"[^>]*>/g, '[Image: $1]')
    .replace(/<figcaption>([\s\S]*?)<\/figcaption>/g, '*$1*')
    .replace(/<p class="[^"]*">([\s\S]*?)<\/p>/g, '$1');
}

/**
 * Split a page into its front matter and its body lines. `fields` holds the
 * top-level keys; `nested` the first value of every key at any depth (the
 * landing page keeps its tagline under `hero:`).
 */
function splitFrontMatter(text: string): {
  fields: Record<string, string>;
  nested: Record<string, string>;
  body: string[];
} {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const fields: Record<string, string> = {};
  const nested: Record<string, string> = {};
  if (lines[0] !== '---') return { fields, nested, body: lines };
  const close = lines.indexOf('---', 1);
  if (close === -1) return { fields, nested, body: lines };
  for (const line of lines.slice(1, close)) {
    const field = line.match(/^(\s*)(?:- )?(\w+):\s*(.*)$/);
    if (!field) continue;
    const value = field[3]!.replace(/^["']|["']$/g, '').trim();
    if (!field[1]) fields[field[2]!] = value;
    nested[field[2]!] ??= value;
  }
  return { fields, nested, body: lines.slice(close + 1) };
}

/** Markdown inline syntax stripped to the words a reader sees; code spans keep their content verbatim. */
export function plainText(markdown: string): string {
  const code: string[] = [];
  return markdown
    .replace(/`([^`]*)`/g, (_match, span: string) => `\uE000${code.push(span) - 1}\uE001`)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|[\s(])[*_]([^*_\s][^*_]*)[*_](?=[\s).,;:!?]|$)/g, '$1$2')
    .replace(/\uE000(\d+)\uE001/g, (_match, index: string) => code[Number(index)] ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Clip text to about `max` characters, preferring a sentence end. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const window = text.slice(0, max);
  const sentenceEnd = window.lastIndexOf('. ');
  return sentenceEnd > max * 0.5 ? window.slice(0, sentenceEnd + 1) : `${window.replace(/\s+\S*$/, '')}…`;
}

const FENCE = /^\s*(`{3,}|~{3,})/;

/** The first prose paragraph of some lines — skipping headings, code, tables, quotes, lists, containers and components. */
function firstParagraph(lines: string[]): string {
  let fence: string | null = null;
  let inContainer = false;
  const paragraph: string[] = [];
  for (const line of lines) {
    const marker = line.match(FENCE)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      continue;
    }
    const trimmed = line.trim();
    if (marker || trimmed.startsWith(':::') || inContainer) {
      if (paragraph.length) break;
      if (marker) fence = marker;
      else if (trimmed.startsWith(':::')) inContainer = trimmed !== ':::';
      continue;
    }
    const prose = trimmed && !/^(#|\||>|<|\*\*Needs:\*\*|!\[|- |\* |\d+\. |\[Image)/.test(trimmed);
    if (prose) paragraph.push(trimmed);
    else if (paragraph.length) break;
  }
  return clip(plainText(paragraph.join(' ')), 280);
}

/**
 * What a page is for, in a sentence or two: its lead paragraph, else the first
 * paragraph directly under its first `##`, else the list of its `##` headings.
 */
function pageSummary(lines: string[], sections: DocsSection[]): string {
  const lead = firstParagraph(lines.slice(0, sections[0]?.start ?? lines.length));
  if (lead) return lead;
  const first = sections.find((s) => s.level === 2);
  const own = first ? firstParagraph(lines.slice(first.start + 1, first.ownEnd)) : '';
  if (own) return own;
  const covers = sections.filter((s) => s.level === 2).map((s) => s.text);
  return covers.length ? clip(`Covers: ${covers.join(', ')}.`, 280) : '';
}

/** Headings and sections of a page, with VitePress anchors (deduped the way VitePress dedupes them). */
function parseSections(lines: string[]): { title: string | null; sections: DocsSection[] } {
  const found: Array<Omit<DocsSection, 'ownEnd' | 'end'>> = [];
  const used = new Set<string>();
  const unique = (slug: string) => {
    let candidate = slug;
    for (let i = 1; used.has(candidate); i++) candidate = `${slug}-${i}`;
    used.add(candidate);
    return candidate;
  };
  let title: string | null = null;
  let fence: string | null = null;

  lines.forEach((line, index) => {
    const marker = line.match(FENCE)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      return;
    }
    if (marker) {
      fence = marker;
      return;
    }
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (!heading) return;
    const level = heading[1]!.length;
    const { text, explicitAnchor } = parseHeadingText(heading[2]!);
    const anchor = unique(explicitAnchor ?? slugifyHeading(text));
    if (level === 1) {
      title ??= text;
      return;
    }
    found.push({ anchor, text, level, start: index });
  });

  const sections = found.map((section, i) => {
    const next = found[i + 1];
    const sibling = found.slice(i + 1).find((s) => s.level <= section.level);
    return { ...section, ownEnd: next?.start ?? lines.length, end: sibling?.start ?? lines.length };
  });
  return { title, sections };
}

function groupOf(path: string): DocsGroupId {
  const prefix = path.split('/')[0];
  return DOCS_GROUPS.find((g) => g.id === prefix)?.id ?? 'home';
}

/** Parse every page in a bundled docs tree. `files` maps relative paths (`guide/ci.md`, `snippets/x.sh`) to text. */
export function buildDocsCorpus(files: Record<string, string>): DocsCorpus {
  const pages: DocsPage[] = [];
  for (const [file, text] of Object.entries(files)) {
    if (!isDocsPageFile(file)) continue;
    const path = file.replace(/\.md$/, '');
    const { fields, nested, body } = splitFrontMatter(text);
    const lines: string[] = [];
    for (const line of body) {
      const snippet = snippetFence(line, files);
      if (snippet) {
        lines.push(...snippet);
        continue;
      }
      // The page's live-demo examples, from the registry the docs component reads.
      if (/^\s*<DemoExamples\b[^>]*\/>\s*$/.test(line)) {
        lines.push(...demoExamplesFor(path).map((e) => `- [${e.title}](${DOCS_BASE_URL}/demo${e.route}): ${e.shows}`));
        continue;
      }
      const rendered = renderLine(line);
      if (rendered !== null) lines.push(rendered);
    }
    while (lines.length && !lines[0]!.trim()) lines.shift();
    const { title, sections } = parseSections(lines);
    pages.push({
      path,
      group: groupOf(path),
      title: fields.title || title || (path === 'index' ? 'Home' : path),
      summary: (path === 'index' && nested.tagline) || pageSummary(lines, sections),
      lines,
      sections,
    });
  }
  const order = (p: DocsPage) => {
    const group = DOCS_GROUPS.findIndex((g) => g.id === p.group);
    return group === -1 ? -1 : group;
  };
  pages.sort((a, b) => order(a) - order(b) || a.path.localeCompare(b.path));
  return { pages, byPath: new Map(pages.map((p) => [p.path, p])) };
}

// ── Addressing ────────────────────────────────────────────────────────────────

/** The public URL of a page (and anchor) on the docs site. */
export function docsPageUrl(path: string, anchor?: string | null): string {
  const route = path === 'index' ? '' : path.replace(/(^|\/)index$/, '$1');
  return `${DOCS_BASE_URL}/${route}${anchor ? `#${anchor}` : ''}`;
}

/**
 * Normalize whatever an agent passes for a page — `guide/ci`, `/guide/ci.md`,
 * `guide/ci#sharding`, a full docs URL, `/recipes/` — to a path and an anchor.
 */
export function parseDocsRef(ref: string): { path: string; anchor: string | null } {
  let value = ref.trim();
  value = value.replace(/^https?:\/\/[^/]+/i, '');
  const hash = value.indexOf('#');
  const anchor = hash === -1 ? null : value.slice(hash + 1).trim() || null;
  if (hash !== -1) value = value.slice(0, hash);
  value = value
    .replace(/^\.?\/+/, '')
    .replace(/\.(md|html)$/i, '')
    .trim()
    .toLowerCase();
  if (!value) return { path: 'index', anchor };
  if (value.endsWith('/')) value = `${value}index`;
  return { path: value, anchor: anchor?.toLowerCase() ?? null };
}

/** Find a page by exact path, else by a unique path suffix (`reporter` → `guide/reporter`). */
export function findDocsPage(corpus: DocsCorpus, path: string): DocsPage | null {
  const exact = corpus.byPath.get(path);
  if (exact) return exact;
  const suffix = corpus.pages.filter((p) => p.path.endsWith(`/${path}`));
  return suffix.length === 1 ? suffix[0]! : null;
}

/** Pages whose path or title mentions the last segment of a failed lookup, for the error message. */
export function suggestDocsPages(corpus: DocsCorpus, path: string, limit = 5): string[] {
  const needle = path.split('/').pop() ?? path;
  if (!needle) return [];
  return corpus.pages
    .filter((p) => p.path.includes(needle) || p.title.toLowerCase().includes(needle.replace(/-/g, ' ')))
    .slice(0, limit)
    .map((p) => p.path);
}

/** A page's heading outline — its `##` and `###` headings with their anchors. */
export function docsOutline(page: DocsPage): DocsHeading[] {
  return page.sections.filter((s) => s.level <= 3).map(({ anchor, text, level }) => ({ anchor, text, level }));
}

/**
 * The list items of one section (`page#anchor`), as plain text — how the MCP
 * tool quotes a docs list rather than restating it. Empty when the page, the
 * section or the corpus is missing.
 */
export function docsSectionItems(corpus: DocsCorpus | null, ref: string): string[] {
  const { path, anchor } = parseDocsRef(ref);
  const page = corpus?.byPath.get(path);
  const section = page?.sections.find((s) => s.anchor === anchor);
  if (!page || !section) return [];
  return page.lines
    .slice(section.start + 1, section.ownEnd)
    .map((line) => line.match(/^\s*(?:\d+\.|[-*])\s+(.*)$/)?.[1])
    .filter((item): item is string => Boolean(item))
    .map(plainText);
}

/** The Markdown of a whole page, or of one section with its sub-sections. */
export function docsMarkdown(page: DocsPage, section?: DocsSection | null): string {
  const lines = section ? page.lines.slice(section.start, section.end) : page.lines;
  return lines.join('\n').trim();
}

// ── Search ────────────────────────────────────────────────────────────────────

const STOP_WORDS = new Set(
  'a an and are as at be by can do does for from how i if in into is it its me my no not of on or should so that the this to use what when where which who why with you your'.split(
    ' ',
  ),
);

/** Lower-case search terms from a free-text query; stop words go unless nothing else is left. */
export function queryTerms(query: string): string[] {
  const words = [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}_]+/u))].filter((w) => w.length >= 2);
  const meaningful = words.filter((w) => !STOP_WORDS.has(w));
  return meaningful.length ? meaningful : words;
}

function occurrences(haystack: string, needle: string, cap: number): number {
  let count = 0;
  for (let at = haystack.indexOf(needle); at !== -1 && count < cap; at = haystack.indexOf(needle, at + needle.length)) {
    count++;
  }
  return count;
}

export interface DocsSearchHit {
  page: string;
  title: string;
  /** Present when the hit is inside a section rather than a page's lead. */
  anchor?: string;
  heading?: string;
  /** The matching line, as plain text. */
  snippet: string;
  url: string;
  /** How many of the query's terms the section contains. */
  matched: number;
}

/**
 * Rank every section (and every page lead) against the query: sections holding
 * more of the terms come first, then heading and title matches, then how often
 * the terms occur. At most two hits per page, so one long page cannot crowd out
 * the rest.
 */
export function searchDocs(corpus: DocsCorpus, query: string, limit = 8): DocsSearchHit[] {
  const terms = queryTerms(query);
  if (!terms.length) return [];

  const scored: Array<DocsSearchHit & { score: number }> = [];
  for (const page of corpus.pages) {
    const title = page.title.toLowerCase();
    const leadEnd = page.sections[0]?.start ?? page.lines.length;
    const chunks: Array<{ section: DocsSection | null; start: number; end: number }> = [
      { section: null, start: 0, end: leadEnd },
      ...page.sections.map((s) => ({ section: s, start: s.start, end: s.ownEnd })),
    ];
    for (const { section, start, end } of chunks) {
      const bodyLines = page.lines.slice(section ? start + 1 : start, end);
      const body = bodyLines.join('\n').toLowerCase();
      const heading = section?.text.toLowerCase() ?? '';
      let matched = 0;
      let score = 0;
      for (const term of terms) {
        const inHeading = heading.includes(term);
        const inTitle = title.includes(term);
        const count = occurrences(body, term, 5);
        if (!inHeading && !inTitle && !count) continue;
        matched++;
        score += (inHeading ? 8 : 0) + (inTitle ? 3 : 0) + count;
      }
      if (!matched) continue;
      const line = bodyLines.find(
        (l) => !FENCE.test(l) && !/^\s*#/.test(l) && terms.some((t) => l.toLowerCase().includes(t)) && plainText(l),
      );
      scored.push({
        page: page.path,
        title: page.title,
        ...(section ? { anchor: section.anchor, heading: section.text } : {}),
        snippet: line ? clip(plainText(line.replace(/^\s*(?:[-*]|\d+\.)\s+/, '')), 220) : firstParagraph(bodyLines),
        url: docsPageUrl(page.path, section?.anchor),
        matched,
        score,
      });
    }
  }

  scored.sort((a, b) => b.matched - a.matched || b.score - a.score);
  const perPage = new Map<string, number>();
  const hits: DocsSearchHit[] = [];
  for (const { score: _score, ...hit } of scored) {
    const taken = perPage.get(hit.page) ?? 0;
    if (taken >= 2) continue;
    perPage.set(hit.page, taken + 1);
    hits.push(hit);
    if (hits.length >= limit) break;
  }
  return hits;
}
