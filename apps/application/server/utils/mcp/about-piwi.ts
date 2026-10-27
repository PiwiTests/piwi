/**
 * The MCP tools that describe Piwi itself: `describe_piwi` (what it is, its
 * pieces, the setup decisions, configuration, feedback and the documentation)
 * and `get_release_notes` (what changed in each release).
 *
 * Both read material bundled into the server build — the docs pages and
 * CHANGELOG.md, through `nitro.serverAssets` — so they answer for the running
 * version, offline. The structured topics come from the registries the docs
 * site renders (feature catalog, ecosystem, env vars), so the tools say nothing
 * the docs do not. How this instance is configured is deployment shape, not
 * test data: like the Setup page, it is shown to administrators only.
 */
import { MCP_TOOL_DEFS, DESKTOP_MCP_TOOL_DEFS, type McpToolDef } from '#shared/mcp-tools';
import { MCP_PROMPT_DEFS } from '#shared/mcp-prompts';
import { CAPABILITIES, CAPABILITY_PRESETS, type CapabilityId, type CapabilityState } from '#shared/capabilities';
import { PIWI_FEATURE_GROUPS, FEATURE_NEED_LABELS, type FeatureNeed } from '#shared/piwi-features';
import {
  DESCRIBE_PIWI_TOPICS,
  ECOSYSTEM_PIECES,
  FEEDBACK_CHANNELS,
  POSITIONING,
  PROJECT_LINKS,
  QUOTED_DOCS_SECTIONS,
  SETUP_DECISIONS,
  type DescribePiwiTopic,
} from '#shared/piwi-ecosystem';
import {
  PIWI_ENV_CATEGORIES,
  PIWI_ENV_VARS,
  compareVersions,
  type PiwiEnvVarCategory,
  type PiwiEnvVarMeta,
  type PiwiEnvVarName,
} from '#shared/piwi-env-vars';
import { GENERATED_DOCS_PAGES, type GeneratedDocsPage } from '#shared/docs-generated-pages';
import {
  DOCS_GROUPS,
  buildDocsCorpus,
  docsMarkdown,
  docsOutline,
  docsSectionItems,
  docsPageUrl,
  findDocsPage,
  parseDocsRef,
  plainText,
  queryTerms,
  searchDocs,
  suggestDocsPages,
  type DocsCorpus,
} from '#shared/docs-corpus';
import { CHANGELOG_ENTRY_KINDS, parseChangelog, type ChangelogRelease } from '#shared/changelog';
import { resolveInstanceStates } from '#shared/handlers/setup-status';
import { DOCS_BASE_URL } from '#shared/docs';
import { isAdministrator } from '#shared/permissions';
import { getDialect, type DbClient } from '../../database';
import { isAuthEnabled } from '../auth';
import { dropNulls } from './json';
import { serveableTools } from './served';
import type { McpContext } from './tools';

// ── Bundled material ──────────────────────────────────────────────────────────

/** Server-asset mounts declared in nuxt.config.ts. */
const DOCS_STORAGE = 'assets:piwi-docs';
const CHANGELOG_STORAGE = 'assets:piwi-changelog';

/** A bundled asset as text: production builds hand non-text types back as bytes. */
function assetText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  return null;
}

let docsCache: Promise<DocsCorpus | null> | null = null;
let changelogCache: Promise<ChangelogRelease[] | null> | null = null;

/** The bundled docs, parsed once per process — re-read on every call in dev, so edits show up. */
function bundledDocs(): Promise<DocsCorpus | null> {
  if (docsCache && !import.meta.dev) return docsCache;
  docsCache = (async () => {
    const storage = useStorage(DOCS_STORAGE);
    const keys = (await storage.getKeys()).filter((key) => key.endsWith('.md') || key.startsWith('snippets:'));
    const files: Record<string, string> = {};
    await Promise.all(
      keys.map(async (key) => {
        const text = assetText(await storage.getItemRaw(key));
        if (text !== null) files[key.replace(/:/g, '/')] = text;
      }),
    );
    const corpus = buildDocsCorpus(files);
    return corpus.pages.length ? corpus : null;
  })().catch(() => null);
  return docsCache;
}

/** The bundled changelog, parsed once per process. */
function bundledChangelog(): Promise<ChangelogRelease[] | null> {
  if (changelogCache && !import.meta.dev) return changelogCache;
  changelogCache = (async () => {
    const text = assetText(await useStorage(CHANGELOG_STORAGE).getItemRaw('CHANGELOG.md'));
    const releases = text ? parseChangelog(text) : [];
    return releases.length ? releases : null;
  })().catch(() => null);
  return changelogCache;
}

const DOCS_NOT_BUNDLED = `This server was built without its documentation; read it at ${DOCS_BASE_URL}.`;

// ── Small helpers ─────────────────────────────────────────────────────────────

function optionalString(raw: unknown): string | null {
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

function appVersion(): string {
  return String(useRuntimeConfig().public.appVersion ?? '');
}

/** The feature catalog's words for a list of prerequisites; an empty list means the reporter alone. */
function needsLabels(needs: readonly FeatureNeed[]): string[] {
  return needs.length ? needs.map((n) => FEATURE_NEED_LABELS[n]) : ['the reporter'];
}

// ── This instance ─────────────────────────────────────────────────────────────

/** What a capability state means, in the words the overview uses. */
const CAPABILITY_STATE_MEANING: Record<CapabilityState, string> = {
  active: 'set up and in use here',
  available: 'ready, with nothing recorded yet',
  undecided: 'not set up yet',
  'not-applicable': 'does not apply to this setup',
  declined: 'declined here: hidden in the dashboard, and its MCP tools are not served',
};

interface InstanceFacts {
  version: string;
  surface: 'server' | 'desktop app';
  database: 'SQLite' | 'PostgreSQL';
  authentication: 'on' | 'off';
  /** Only administrators (and everyone, with authentication off) see how the instance is configured. */
  admin: boolean;
}

export function instanceFacts(ctx: McpContext): InstanceFacts {
  return {
    version: appVersion(),
    surface: process.env.PIWI_DESKTOP_TOKEN ? 'desktop app' : 'server',
    database: getDialect() === 'postgres' ? 'PostgreSQL' : 'SQLite',
    authentication: isAuthEnabled() ? 'on' : 'off',
    admin: isAdministrator(ctx.access),
  };
}

interface AdminFacts {
  storage: string;
  retention: string;
  states: Record<CapabilityId, CapabilityState>;
}

export async function adminFacts(db: DbClient): Promise<AdminFacts> {
  const days = Number(process.env.PIWI_RETENTION_DAYS);
  return {
    storage: process.env.PIWI_STORAGE_TYPE === 's3' ? 'S3-compatible bucket' : 'local disk',
    retention:
      Number.isFinite(days) && days > 0 ? `runs older than ${days} days are pruned nightly` : 'keeps every run',
    states: await resolveInstanceStates(db),
  };
}

/** Capability ids grouped by their state here. */
export function capabilitiesByState(states: Record<CapabilityId, CapabilityState>) {
  const grouped: Partial<Record<CapabilityState, CapabilityId[]>> = {};
  for (const def of CAPABILITIES) (grouped[states[def.id]] ??= []).push(def.id);
  return grouped;
}

const ADMIN_ONLY_NOTE =
  "How this instance is configured (its storage, retention and each capability's state) is shown to administrators only.";

async function thisInstance(db: DbClient, facts: InstanceFacts) {
  const base = {
    version: facts.version,
    surface: facts.surface,
    database: facts.database,
    authentication: facts.authentication,
  };
  if (!facts.admin) return { ...base, note: ADMIN_ONLY_NOTE };
  const admin = await adminFacts(db);
  return {
    ...base,
    storage: admin.storage,
    retention: admin.retention,
    capabilities: capabilitiesByState(admin.states),
    capabilityStates: CAPABILITY_STATE_MEANING,
  };
}

// ── describe_piwi ─────────────────────────────────────────────────────────────

async function overviewTopic(db: DbClient, facts: InstanceFacts) {
  const corpus = await bundledDocs();
  return dropNulls({
    ...POSITIONING,
    thisInstance: await thisInstance(db, facts),
    jobs: docsSectionItems(corpus, QUOTED_DOCS_SECTIONS.jobs),
    rules: docsSectionItems(corpus, QUOTED_DOCS_SECTIONS.rules),
    limits: docsSectionItems(corpus, QUOTED_DOCS_SECTIONS.limits),
    ecosystem: ECOSYSTEM_PIECES.map(({ id, name, summary }) => ({ id, name, summary })),
    topics: DESCRIBE_PIWI_TOPICS,
    docs: corpus
      ? `${corpus.pages.length} documentation pages ship with this server, matching version ${facts.version}: read one with \`page\`, search them with \`query\`, list them with topic "docs". Each page is also online at ${DOCS_BASE_URL}/<page>.`
      : DOCS_NOT_BUNDLED,
    releaseNotes: 'get_release_notes lists what changed in each release, up to this version.',
    links: { docs: PROJECT_LINKS.docs, demo: PROJECT_LINKS.demo, repository: PROJECT_LINKS.repository },
  });
}

function ecosystemTopic() {
  return {
    pieces: ECOSYSTEM_PIECES.map((piece) =>
      dropNulls({
        id: piece.id,
        name: piece.name,
        summary: piece.summary,
        get: piece.get,
        when: piece.when,
        needs: piece.needs.length ? needsLabels(piece.needs) : null,
        page: piece.doc,
      }),
    ),
    note: 'Read any `page` with describe_piwi for the details.',
  };
}

/** What this instance chose for each decision the caller may see. */
async function currentChoices(db: DbClient, facts: InstanceFacts): Promise<Record<string, string>> {
  const current: Record<string, string> = {
    where: facts.surface === 'desktop app' ? 'the desktop app' : 'a server (Docker, npx or a deploy template)',
    database: facts.database,
    auth: facts.authentication,
  };
  if (!facts.admin) return current;
  const admin = await adminFacts(db);
  const declined = CAPABILITIES.filter((c) => admin.states[c.id] === 'declined').map((c) => c.id);
  return {
    ...current,
    storage: admin.storage,
    fixtures: CAPABILITY_STATE_MEANING[admin.states.fixtures],
    ai: CAPABILITY_STATE_MEANING[admin.states.ai],
    scm: CAPABILITY_STATE_MEANING[admin.states.scm],
    'mcp-modules': declined.length ? `declined capabilities: ${declined.join(', ')}` : 'no capability declined',
    retention: admin.retention,
  };
}

async function choicesTopic(db: DbClient, facts: InstanceFacts) {
  const current = await currentChoices(db, facts);
  return dropNulls({
    decisions: SETUP_DECISIONS.map((d) =>
      dropNulls({
        id: d.id,
        question: d.question,
        default: d.default,
        current: current[d.id] ?? null,
        options: d.options,
        page: d.doc,
      }),
    ),
    note: facts.admin ? null : ADMIN_ONLY_NOTE,
  });
}

async function featuresTopic(db: DbClient, facts: InstanceFacts) {
  const states = facts.admin ? (await adminFacts(db)).states : null;
  return dropNulls({
    groups: PIWI_FEATURE_GROUPS.map((group) => ({
      title: group.title,
      intro: group.intro,
      features: group.features.map((f) => ({
        title: f.title,
        summary: f.summary,
        needs: needsLabels(f.needs),
        where: f.where,
        page: f.doc,
      })),
    })),
    capabilities: states
      ? CAPABILITIES.map((c) => ({
          id: c.id,
          module: c.module,
          state: states[c.id],
          needs: c.needs.length ? needsLabels(c.needs) : null,
          page: c.doc,
        })).map((c) => dropNulls(c))
      : null,
    capabilityStates: states ? CAPABILITY_STATE_MEANING : null,
    note: facts.admin ? null : ADMIN_ONLY_NOTE,
  });
}

/** Env vars the reference documents: removed ones and internal categories left out. */
function documentedVariables(version: string): Array<{ category: PiwiEnvVarCategory; name: PiwiEnvVarName }> {
  const sections = Object.entries(PIWI_ENV_CATEGORIES)
    .filter(([, meta]) => !meta.internal && !meta.mergeInto)
    .sort(([, a], [, b]) => a.order - b.order)
    .map(([category]) => category as PiwiEnvVarCategory);
  const sectionOf = (category: PiwiEnvVarCategory) => PIWI_ENV_CATEGORIES[category].mergeInto ?? category;
  const names = Object.keys(PIWI_ENV_VARS) as PiwiEnvVarName[];
  return sections.flatMap((section) =>
    names
      .filter((name) => {
        const meta: PiwiEnvVarMeta = PIWI_ENV_VARS[name];
        if (PIWI_ENV_CATEGORIES[meta.category].internal || sectionOf(meta.category) !== section) return false;
        return !(meta.until && compareVersions(version, meta.until) >= 0);
      })
      .map((name) => ({ category: section, name })),
  );
}

function variableEntry(name: PiwiEnvVarName, detailed: boolean) {
  const meta: PiwiEnvVarMeta = PIWI_ENV_VARS[name];
  return dropNulls({
    name,
    default: meta.default ?? null,
    description: detailed && meta.notes ? `${meta.description} ${meta.notes}` : meta.description,
    values: meta.enum ? [...meta.enum] : null,
    secret: meta.secret ? true : null,
    page: detailed && meta.docs ? meta.docs : null,
  });
}

/** Variables whose name, description or notes hold every term of the query, name matches first. */
function matchingVariables(query: string, version: string): PiwiEnvVarName[] {
  const terms = queryTerms(query);
  if (!terms.length) return [];
  const haystack = (name: PiwiEnvVarName) => {
    const meta: PiwiEnvVarMeta = PIWI_ENV_VARS[name];
    return `${name} ${meta.description} ${meta.notes ?? ''}`.toLowerCase();
  };
  const inName = (name: PiwiEnvVarName) => terms.filter((t) => name.toLowerCase().includes(t)).length;
  return documentedVariables(version)
    .map(({ name }) => name)
    .filter((name) => terms.every((t) => haystack(name).includes(t)))
    .sort((a, b) => inName(b) - inName(a));
}

function configurationTopic(version: string, query: string | null) {
  const how =
    'Piwi is configured through PIWI_* environment variables, and runs with none set: SQLite and local file storage under .data/. Where the Settings UI can set a value too, the environment variable wins and the UI shows it read-only. The reporter has its own options, each listed with its PIWI_* equivalent on page "guide/reporter".';
  const base = {
    how,
    reference: `${DOCS_BASE_URL}/reference/configuration`,
    generator: `${DOCS_BASE_URL}/reference/configuration/generator`,
  };
  if (query) {
    const names = matchingVariables(query, version);
    return { ...base, query, variables: names.map((name) => variableEntry(name, true)) };
  }
  const categories = new Map<PiwiEnvVarCategory, PiwiEnvVarName[]>();
  for (const { category, name } of documentedVariables(version)) {
    categories.set(category, [...(categories.get(category) ?? []), name]);
  }
  return {
    ...base,
    categories: [...categories].map(([category, names]) => ({
      category: PIWI_ENV_CATEGORIES[category].title,
      variables: names.map((name) => variableEntry(name, false)),
    })),
    note: 'Pass `query` with topic "configuration" for matching variables with their fine print and docs page.',
  };
}

async function mcpTopic(db: DbClient, facts: InstanceFacts) {
  const desktop = facts.surface === 'desktop app';
  const catalog: McpToolDef[] = desktop ? [...MCP_TOOL_DEFS, ...DESKTOP_MCP_TOOL_DEFS] : [...MCP_TOOL_DEFS];
  const served = new Set((await serveableTools(db, catalog)).map((t) => t.name));
  const notServed = catalog.filter((t) => !served.has(t.name)).map((t) => t.name);
  return dropNulls({
    endpoint:
      'POST /mcp on this dashboard: Streamable HTTP, JSON-RPC 2.0, with the same pd_ API keys as the REST API (Authorization: Bearer pd_…).',
    modules: CAPABILITY_PRESETS.map((preset) => ({
      module: preset.module,
      label: preset.label,
      description: preset.description,
      tools: catalog
        .filter((t) => t.module === preset.module)
        .map((t) => (t.capability ? `${t.name} (needs ${t.capability})` : t.name)),
    })),
    notServedHere: notServed.length ? notServed : null,
    desktopOnly: {
      tools: DESKTOP_MCP_TOOL_DEFS.map((t) => t.name),
      note: desktop
        ? 'Served here: this is the desktop app, running on the machine that holds the files.'
        : 'Served only by the desktop app, which runs on the machine that holds the files.',
    },
    narrowing:
      'Append ?modules=core (any comma-separated set of core, workflow, healing, agents) to the MCP URL to list only those modules; declining a capability drops the tools that need it for every client.',
    prompts: MCP_PROMPT_DEFS.map(({ name, description }) => ({ name, description })),
    skills:
      '`npx @piwitests/reporter skills add` installs the agent skills that drive these tools — page "features/agent-skills".',
    page: 'features/mcp',
  });
}

async function feedbackTopic(facts: InstanceFacts) {
  const corpus = await bundledDocs();
  const deployment = `dashboard ${facts.version}, ${facts.surface}, ${facts.database}, authentication ${facts.authentication}`;
  return dropNulls({
    bug: FEEDBACK_CHANNELS.bug,
    idea: FEEDBACK_CHANNELS.idea,
    translation: FEEDBACK_CHANNELS.translation,
    question: FEEDBACK_CHANNELS.question,
    security: { url: FEEDBACK_CHANNELS.security, note: 'Report vulnerabilities privately, never in a public issue.' },
    docsFix: FEEDBACK_CHANNELS.docs,
    thisInstance: `${deployment} — for a bug report's Version and Deployment fields (add the storage backend and the reporter version).`,
    direction: docsSectionItems(corpus, QUOTED_DOCS_SECTIONS.jobs),
    fitTest:
      'Every feature serves one of the jobs above; an idea that strengthens none of them is an argument against building it.',
    nonGoals: FEEDBACK_CHANNELS.nonGoals,
    roadmap: PROJECT_LINKS.roadmap,
    contributing: PROJECT_LINKS.contributing,
  });
}

function docsIndex(corpus: DocsCorpus | null, version: string) {
  if (!corpus) return { note: DOCS_NOT_BUNDLED };
  const firstSentence = (text: string) => {
    const end = text.search(/[.!?](\s|$)/);
    return end > 0 && end < 200 ? text.slice(0, end + 1) : text;
  };
  const groups = [{ id: 'home', title: 'Home', intro: 'The landing page.' }, ...DOCS_GROUPS];
  return {
    version,
    site: `${DOCS_BASE_URL}/<page>`,
    groups: groups
      .map((group) => ({
        group: group.title,
        about: group.intro,
        pages: corpus.pages
          .filter((p) => p.group === group.id)
          .map((p) => ({ page: p.path, title: p.title, summary: firstSentence(p.summary) })),
      }))
      .filter((g) => g.pages.length),
    generated: (Object.keys(GENERATED_DOCS_PAGES) as GeneratedDocsPage[]).map((page) => ({
      page,
      read: GENERATED_PAGE_ANSWERS[page] ?? `${docsPageUrl(page)} (generated from ${GENERATED_DOCS_PAGES[page]})`,
    })),
    read: 'Pass `page` with a path, or "path#anchor" for one section; `query` searches every page.',
  };
}

/**
 * Where describe_piwi answers for a generated page from the page's own registry.
 * The other generated pages are only on the published site.
 */
const GENERATED_PAGE_ANSWERS: Partial<Record<GeneratedDocsPage, string>> = {
  'reference/configuration': 'topic "configuration"',
  'reference/features': 'topics "features", "ecosystem" and "choices"',
  'reference/mcp-tools': 'topic "mcp"',
  'reference/whats-new': 'the get_release_notes tool',
};

/** Longest Markdown a page read returns before pointing at its sections. */
const MAX_PAGE_CHARS = 60_000;

async function readDocsPage(ref: string, db: DbClient, facts: InstanceFacts) {
  const { path, anchor } = parseDocsRef(ref);
  const generated = (Object.keys(GENERATED_DOCS_PAGES) as GeneratedDocsPage[]).find(
    (p) => p === path || p.endsWith(`/${path}`),
  );
  if (generated) {
    const url = docsPageUrl(generated);
    const note = `Generated from ${GENERATED_DOCS_PAGES[generated]}.`;
    // The topic's own fields first, so the answer names the page that was read.
    if (generated === 'reference/configuration')
      return { ...configurationTopic(facts.version, null), page: generated, url, note };
    if (generated === 'reference/features') return { ...(await featuresTopic(db, facts)), page: generated, url, note };
    if (generated === 'reference/mcp-tools') return { ...(await mcpTopic(db, facts)), page: generated, url, note };
    if (generated === 'reference/whats-new') return { page: generated, url, note: `${note} Call get_release_notes.` };
    return {
      page: generated,
      url,
      note: `${note} It is built with the docs site and not bundled here; read it at the URL.`,
    };
  }

  const corpus = await bundledDocs();
  if (!corpus) return { page: path, url: docsPageUrl(path, anchor), note: DOCS_NOT_BUNDLED };
  const page = findDocsPage(corpus, path);
  if (!page) {
    const near = suggestDocsPages(corpus, path);
    throw new Error(
      `No docs page "${path}"${near.length ? ` — did you mean ${near.join(', ')}?` : ''}. Call describe_piwi with topic "docs" for the index.`,
    );
  }
  if (anchor) {
    const section = page.sections.find((s) => s.anchor === anchor);
    if (!section) {
      const anchors = docsOutline(page).map((h) => h.anchor);
      throw new Error(`No section #${anchor} on ${page.path}. Its sections: ${anchors.join(', ')}`);
    }
    return {
      page: page.path,
      title: page.title,
      section: section.text,
      url: docsPageUrl(page.path, section.anchor),
      markdown: docsMarkdown(page, section),
    };
  }
  const markdown = docsMarkdown(page);
  const clipped = markdown.length > MAX_PAGE_CHARS;
  return dropNulls({
    page: page.path,
    title: page.title,
    url: docsPageUrl(page.path),
    outline: docsOutline(page),
    markdown: clipped ? markdown.slice(0, markdown.lastIndexOf('\n', MAX_PAGE_CHARS)) : markdown,
    truncated: clipped ? 'The page is longer than this; read the rest one section at a time with "page#anchor".' : null,
  });
}

async function searchAll(query: string, version: string) {
  const corpus = await bundledDocs();
  const variables = matchingVariables(query, version).slice(0, 5);
  return dropNulls({
    query,
    hits: corpus ? searchDocs(corpus, query) : [],
    variables: variables.map((name) => variableEntry(name, true)),
    next: corpus ? 'Read a hit with page "<page>#<anchor>".' : DOCS_NOT_BUNDLED,
  });
}

/** `describe_piwi` — Piwi itself, from its documentation. */
export async function describePiwi(db: DbClient, params: Record<string, unknown>, ctx: McpContext): Promise<unknown> {
  const page = optionalString(params.page);
  const query = optionalString(params.query);
  const topic = optionalString(params.topic) ?? 'overview';
  if (!(topic in DESCRIBE_PIWI_TOPICS)) {
    throw new Error(`Unknown topic "${topic}" — one of: ${Object.keys(DESCRIBE_PIWI_TOPICS).join(', ')}`);
  }
  const facts = instanceFacts(ctx);
  if (page) return readDocsPage(page, db, facts);
  if (topic === 'configuration') return configurationTopic(facts.version, query);
  if (query) return searchAll(query, facts.version);

  switch (topic as DescribePiwiTopic) {
    case 'ecosystem':
      return ecosystemTopic();
    case 'choices':
      return choicesTopic(db, facts);
    case 'features':
      return featuresTopic(db, facts);
    case 'mcp':
      return mcpTopic(db, facts);
    case 'feedback':
      return feedbackTopic(facts);
    case 'docs':
      return docsIndex(await bundledDocs(), facts.version);
    default:
      return overviewTopic(db, facts);
  }
}

// ── get_release_notes ─────────────────────────────────────────────────────────

/** The GitHub release page of a single release, or the header's link for a grouped entry. */
function releaseUrl(release: ChangelogRelease): string | null {
  return release.from === release.to ? `${PROJECT_LINKS.releases}/tag/v${release.to}` : release.url;
}

/** True when `version` (`0.36.0`, or `0.36` for a minor) names this release. */
function releaseMatches(release: ChangelogRelease, version: string): boolean {
  if (/^\d+\.\d+$/.test(version)) return release.to.startsWith(`${version}.`) || release.from.startsWith(`${version}.`);
  return compareVersions(release.from, version) <= 0 && compareVersions(version, release.to) <= 0;
}

function plainEntries(entries: string[]): string[] | null {
  return entries.length ? entries.map(plainText) : null;
}

function fullRelease(release: ChangelogRelease) {
  return dropNulls({
    version: release.version,
    date: release.date,
    url: releaseUrl(release),
    intro: release.intro ? plainText(release.intro) : null,
    highlights: plainEntries(release.entries.highlights),
    breaking: plainEntries(release.entries.breaking),
    features: plainEntries(release.entries.features),
    fixes: plainEntries(release.entries.fixes),
    performance: plainEntries(release.entries.performance),
    other: plainEntries(release.entries.other),
  });
}

/** One line on a release: its first highlight, else its intro, else its first feature or fix. */
function headline(release: ChangelogRelease): string | null {
  const { highlights, features, fixes } = release.entries;
  const text = highlights[0] ?? release.intro ?? features[0] ?? fixes[0];
  return text ? plainText(text).slice(0, 240) : null;
}

/** Most features a range summary lists per release before counting the rest. */
const SUMMARY_FEATURES = 10;

function releaseSummary(release: ChangelogRelease) {
  const { highlights, features, fixes } = release.entries;
  const listed = highlights.length ? highlights : features.slice(0, SUMMARY_FEATURES);
  return dropNulls({
    version: release.version,
    date: release.date,
    url: releaseUrl(release),
    intro: release.intro ? plainText(release.intro) : null,
    [highlights.length ? 'highlights' : 'features']: plainEntries(listed),
    moreFeatures: !highlights.length && features.length > SUMMARY_FEATURES ? features.length - SUMMARY_FEATURES : null,
    fixes: fixes.length || null,
  });
}

/** `get_release_notes` — what changed in each release, from the changelog shipped with this server. */
export async function getReleaseNotes(params: Record<string, unknown>): Promise<unknown> {
  const version = optionalString(params.version)?.replace(/^v/i, '') ?? null;
  const since = optionalString(params.since)?.replace(/^v/i, '') ?? null;
  const query = optionalString(params.query);
  const running = appVersion();
  const context = { runningVersion: running, releasesPage: PROJECT_LINKS.releases };

  const releases = await bundledChangelog();
  if (!releases) {
    return { ...context, note: `This server was built without its changelog; read it at ${PROJECT_LINKS.changelog}.` };
  }
  const newest = releases[0]!;
  const oldest = releases[releases.length - 1]!;
  const covers = `${oldest.from} to ${newest.to}`;

  let selected = releases;
  if (version) {
    if (!/^\d+\.\d+(\.\d+)?$/.test(version)) throw new Error('version must look like "0.36.0", or "0.36" for a minor');
    selected = releases.filter((r) => releaseMatches(r, version));
    if (!selected.length) {
      throw new Error(
        `No release ${version} in the changelog shipped with ${running} (it covers ${covers}). Newer releases: ${PROJECT_LINKS.releases}`,
      );
    }
  } else if (since) {
    if (!/^\d+\.\d+\.\d+$/.test(since)) throw new Error('since must look like "0.30.0"');
    selected = releases.filter((r) => compareVersions(r.to, since) > 0);
  }

  if (query) {
    const terms = queryTerms(query);
    const matches = selected.flatMap((release) => {
      const entries = [
        ...(release.intro ? [{ kind: 'intro', text: release.intro }] : []),
        ...CHANGELOG_ENTRY_KINDS.flatMap((kind) => release.entries[kind].map((text) => ({ kind, text }))),
      ];
      return entries
        .filter(({ text }) => terms.every((t) => text.toLowerCase().includes(t)))
        .map(({ kind, text }) => ({ version: release.version, date: release.date, kind, text: plainText(text) }));
    });
    return dropNulls({ ...context, query, version, since, total: matches.length, matches: matches.slice(0, 40) });
  }

  if (version) return { ...context, releases: selected.map(fullRelease) };

  if (since) {
    return dropNulls({
      ...context,
      since,
      to: newest.to,
      count: selected.length,
      breaking: selected.flatMap((r) =>
        r.entries.breaking.map((text) => ({ version: r.version, text: plainText(text) })),
      ),
      releases: selected.map(releaseSummary),
      upgrading: 'Pre-1.0: read page "operate/upgrading" before moving across releases.',
    });
  }

  const current = releases.find((r) => releaseMatches(r, running)) ?? newest;
  return dropNulls({
    ...context,
    newestShipped: newest.version,
    current: fullRelease(current),
    recent: releases.slice(0, 10).map((r) => dropNulls({ version: r.version, date: r.date, headline: headline(r) })),
    earlier:
      releases.length > 10
        ? `${releases.length - 10} earlier releases back to ${oldest.version}: ask with \`version\`, \`since\` or \`query\`.`
        : null,
  });
}
