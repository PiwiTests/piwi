import { describe, test, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, posix, relative } from 'node:path';
import { CAPABILITY_MODULES } from '#shared/capabilities';
import { MCP_TOOL_DEFS } from '#shared/mcp-tools';
import { NOTIFICATION_EVENTS, REPORT_READY_EVENT } from '#shared/notification-events';
import { FEATURE_NEED_DOCS, PIWI_FEATURE_GROUPS } from '#shared/piwi-features';
import { PIWI_ENV_VARS } from '#shared/piwi-env-vars';
import { HELP_TOPICS } from '~/utils/help-content';
import { TOUR_COPY } from '~/utils/demo-tour/copy';
import { TOUR_LANGUAGE_INFO, TOUR_LANGUAGES } from '~/utils/demo-tour/languages';
import { TOUR_PROFILES } from '~/utils/demo-tour/profiles';
import { LOCATOR_STABILITY_RULES } from '#shared/locator-stability';
import { TEST_SEARCH_FIELD_DEFS } from '#shared/test-search';
import { DEMO_EXAMPLES } from '#shared/demo/demo-examples.mjs';
import { headingAnchor, sidebars } from '../../../docs/.vitepress/navigation';
import { QUOTED_DOCS_SECTIONS } from '#shared/piwi-ecosystem';
import { buildDocsCorpus } from '#shared/docs-corpus';
import { GENERATED_DOCS_PAGES } from '#shared/docs-generated-pages';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const read = (relative: string) => readFileSync(join(repoRoot, relative), 'utf8');

// Pages the docs build writes from a registry; they are gitignored, so they are
// only on disk once `docs:gen` has run, and a check skips them rather than fail.
const GENERATED_PAGES = new Set<string>(Object.keys(GENERATED_DOCS_PAGES));

const FRONT_MATTER = /^---\n[\s\S]*?\n---\n/;
// A fence may be indented, inside a list item.
const FENCED_CODE = /^[ \t]*(`{3,}|~{3,})[\s\S]*?^[ \t]*\1/gm;

// Every anchor a docs page offers, as the docs build assigns them: one per
// heading at any level (a heading's own `{#id}`, or its text slugified, with
// -1, -2 appended to a repeat), plus the `id` of any HTML element.
const anchorsOf = (path: string) => {
  const contents = readFileSync(path, 'utf8').replace(FRONT_MATTER, '').replace(FENCED_CODE, '');
  const seen = new Set<string>();
  const unique = (anchor: string) => {
    let candidate = anchor;
    for (let i = 1; seen.has(candidate); i++) candidate = `${anchor}-${i}`;
    seen.add(candidate);
    return candidate;
  };
  return [
    ...[...contents.matchAll(/^#{1,6} (.+?)\s*$/gm)].map((m) => {
      const custom = /\{#([\w-]+)\}$/.exec(m[1]!);
      if (!custom) return unique(headingAnchor(m[1]!.replace(/\s*\{[^}]*\}$/, '')));
      seen.add(custom[1]!);
      return custom[1]!;
    }),
    ...[...contents.matchAll(/<[a-z][\w-]*\s[^>]*\bid="([\w-]+)"/g)].map((m) => m[1]!),
  ];
};

// Every Markdown page of the docs site, generated pages included once built.
const docsPages = (function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path);
    return entry.name.endsWith('.md') && entry.name !== 'AGENTS.md' ? [relative(repoRoot, path)] : [];
  });
})(join(repoRoot, 'apps/docs'));

// The one line the project describes itself with. AGENTS.md names the surfaces
// that must carry it; these are the ones that live in the repository.
const POSITIONING = [
  'CI throws away every report it makes.',
  'Piwi keeps them',
  'groups the failures by root cause',
  'scores the flaky tests',
  'finds the locator you should have used',
  'Self-hosted, zero telemetry',
];

const POSITIONING_SURFACES = [
  'README.md',
  'DOCKER_HUB.md',
  'apps/docs/index.md',
  'apps/docs/.vitepress/config.mts',
  'apps/application/shared/piwi-ecosystem.ts',
];

describe('positioning line', () => {
  test.each(POSITIONING_SURFACES)('%s carries every clause', (relative) => {
    // Prose wraps, so compare against a single-spaced copy: a clause split
    // across two source lines is still the same sentence to a reader.
    const contents = read(relative).replace(/\s+/g, ' ');
    for (const clause of POSITIONING) {
      expect(contents, `${relative} is missing "${clause}" — see AGENTS.md#documentation`).toContain(clause);
    }
  });
});

describe('documented counts', () => {
  // The tool count lives on one page, the generated MCP tools page, where it
  // is right by construction. A count copied into a narrative page goes stale
  // with the next tool, so every other page and the repository-level pages
  // name no count. The generated What's new page repeats historical changelog
  // counts (e.g. "from 14 to 38 tools") that were correct for that release, so
  // it is left out too.
  const COUNT_SURFACES = [
    ...docsPages.filter((p) => !['apps/docs/reference/mcp-tools.md', 'apps/docs/reference/whats-new.md'].includes(p)),
    'apps/docs/AGENTS.md',
    'README.md',
    'ROADMAP.md',
    'DOCKER_HUB.md',
  ];

  test.each(COUNT_SURFACES)('%s states no MCP tool count', (relative) => {
    const claims = [...read(relative).matchAll(/\b\d+ (?:MCP )?tools\b/g)].map((m) => m[0]);
    expect(
      claims,
      `${relative} states an MCP tool count: link the [MCP tools](/reference/mcp-tools) page instead`,
    ).toEqual([]);
  });

  // The MCP tools page is generated from MCP_TOOL_DEFS, one section per module,
  // so a tool is listed by construction unless its module has no section.
  test('every registered MCP tool is on the generated MCP tools page', () => {
    for (const { name, module } of MCP_TOOL_DEFS) {
      expect(
        CAPABILITY_MODULES,
        `MCP tool \`${name}\` is in module "${module}", which the page has no section for`,
      ).toContain(module);
    }
    const page = join(repoRoot, 'apps/docs/reference/mcp-tools.md');
    if (!existsSync(page)) return;
    const contents = readFileSync(page, 'utf8');
    for (const { name } of MCP_TOOL_DEFS) {
      expect(contents, `apps/docs/reference/mcp-tools.md has no entry for \`${name}\``).toContain(`id="${name}"`);
    }
  });
});

describe('docs pages the app deep-links into', () => {
  // help-content.ts, the capability registry and a handful of components build
  // docs URLs from bare string literals that nothing else validates, so a
  // renamed heading breaks them silently in production.

  // Every .vue/.ts/.mjs file under app/ and shared/ — any of them may carry a
  // `doc: '…'` registry field or a static `DocLink to="…"`.
  const walkSources = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return walkSources(path);
      return /\.(vue|ts|mjs)$/.test(entry.name) ? [relative(repoRoot, path)] : [];
    });
  const sources = [
    ...walkSources(join(repoRoot, 'apps/application/app')),
    ...walkSources(join(repoRoot, 'apps/application/shared')),
  ];

  const targets = [
    ...new Set([
      ...sources.flatMap((source) => {
        const contents = read(source);
        return [
          ...[...contents.matchAll(/doc: '([^']+)'/g)].map((m) => m[1]!),
          ...[...contents.matchAll(/DocLink\s+to="([^"]+)"/g)].map((m) => m[1]!),
          // Markdown links in registry text, such as the env-var notes the
          // configuration reference prints.
          ...[...contents.matchAll(/\]\(\/((?:guide|features|operate|reference|recipes)\/[^)\s]+)\)/g)].map(
            (m) => m[1]!,
          ),
        ];
      }),
      // The All features page (apps/docs/reference/features.md) is generated from
      // this catalog, so every `doc` in it must resolve just like an in-app link.
      ...PIWI_FEATURE_GROUPS.flatMap((group) => group.features.map((feature) => feature.doc)),
      // The <Needs> chips link each prerequisite to its setup page.
      ...Object.values(FEATURE_NEED_DOCS),
      // The configuration reference links each variable to its details.
      ...Object.values(PIWI_ENV_VARS).flatMap((meta) => (meta.docs ? [meta.docs] : [])),
      // The MCP describe_piwi overview quotes these sections of the docs.
      ...Object.values(QUOTED_DOCS_SECTIONS),
    ]),
  ];

  test('there are links to check', () => {
    expect(targets.length).toBeGreaterThan(0);
  });

  test.each(targets)('%s resolves to a page and heading', (target) => {
    const [page, anchor] = target.split('#');
    const path = join(repoRoot, 'apps/docs', `${page}.md`);
    if (GENERATED_PAGES.has(page!) && !existsSync(path)) return;

    expect(existsSync(path), `no apps/docs/${page}.md`).toBe(true);
    if (!anchor) return;

    expect(anchorsOf(path), `apps/docs/${page}.md has no heading anchored #${anchor}`).toContain(anchor);
  });
});

describe('the docs bundled for the MCP describe_piwi tool', () => {
  // The server bundles the hand-written pages and leaves the generated ones out
  // (nuxt.config.ts reads the same list); the Docker build context must do the
  // same, and git must not track a generated page.
  test.each(Object.keys(GENERATED_DOCS_PAGES))('%s is generated, gitignored and kept out of the image', (page) => {
    expect(read('.gitignore'), `.gitignore does not list apps/docs/${page}.md`).toContain(`apps/docs/${page}.md`);
    expect(read('.dockerignore'), `.dockerignore does not exclude apps/docs/${page}.md`).toContain(
      `\napps/docs/${page}.md\n`,
    );
  });

  // describe_piwi hands out `page#anchor` addresses from its own parser; each
  // must be the anchor the docs build gives that heading.
  test('the tool parses every heading to the anchor the docs build assigns', () => {
    const files = Object.fromEntries(docsPages.map((path) => [path.replace(/^apps\/docs\//, ''), read(path)] as const));
    const corpus = buildDocsCorpus(files);
    expect(corpus.pages.length).toBeGreaterThan(50);
    for (const page of corpus.pages) {
      const built = anchorsOf(join(repoRoot, 'apps/docs', `${page.path}.md`));
      for (const section of page.sections) {
        expect(
          built,
          `apps/docs/${page.path}.md: describe_piwi anchors "${section.text}" as #${section.anchor}`,
        ).toContain(section.anchor);
      }
    }
  });
});

describe('single-source snippets', () => {
  // Shared blocks live once under apps/docs/snippets/ and are pulled into docs
  // pages with VitePress code includes (`<<< @/snippets/…`). Surfaces that
  // cannot include a file — the repo README, the npm package READMEs, the
  // Docker Hub page, and inline references in prose — carry a literal copy
  // instead; this guard fails when such a copy drifts from the canonical
  // snippet, the same way the positioning check keeps that one line in sync
  // across surfaces. The canonical text is compared trimmed, so a one-liner
  // embedded inline in a sentence still matches.
  const SNIPPET_COPIES: Record<string, readonly string[]> = {
    'apps/docs/snippets/fixtures.ts': ['README.md', 'packages/reporter/README.md'],
    'apps/docs/snippets/secret.sh': ['README.md', 'DOCKER_HUB.md', 'packages/server/README.md'],
  };

  for (const [snippet, surfaces] of Object.entries(SNIPPET_COPIES)) {
    const canonical = read(snippet).trim();
    test.each(surfaces)(`${snippet} → %s carries it verbatim`, (surface) => {
      expect(
        read(surface),
        `${surface} has drifted from ${snippet} — paste the snippet in byte for byte, or convert the surface to a VitePress include`,
      ).toContain(canonical);
    });
  }
});

describe('no leaked version history or planned work', () => {
  // Version history belongs on the generated What's new page (from the
  // changelog), not scattered through the feature pages as "since version X" /
  // "now supports Y" asides that go stale. This bans only the phrasings that are
  // unambiguously changelog-speak — "no longer" / "used to" / "previously" are
  // left out because they have too many legitimate uses ("a mark it no longer
  // needs", "the tags used to organize projects").
  const BANNED = [/\bsince version\b/i, /\bsince v\d/i, /\bnow supports\b/i];
  // A page describes what a default install does today, so planned work
  // stays in ROADMAP.md (adr/docs-revamp.md, principle 5). "Planned" alone
  // has honest uses (Playwright's planned test list), so only the phrasings
  // that announce future work are banned. An **Experimental** section, which
  // documents something that ships behind a switch, stays allowed.
  const PLANNED = [
    /\b(?:is|are|was|were|still|currently) planned\b/i,
    /\bplanned (?:for|in|as|feature|work|support)\b/i,
    /\(planned\)/i,
    /\bnot yet (?:wired|implemented|available|supported|shipped|released)\b/i,
    /\bcoming soon\b/i,
    /\bunreleased\b/i,
    /\b(?:in|with) (?:a future|an upcoming|the next) (?:release|version)\b/i,
    /\bupcoming (?:release|version|feature)s?\b/i,
  ];

  // Hand-written docs pages only: the generated pages (What's new is literally
  // the version history) and the blog essay are allowed to talk about releases.
  const pages = (function walk(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      if (entry.name === 'node_modules' || entry.name === 'blog' || entry.name.startsWith('.')) return [];
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return walk(path);
      return entry.name.endsWith('.md') && entry.name !== 'AGENTS.md' ? [relative(repoRoot, path)] : [];
    });
  })(join(repoRoot, 'apps/docs')).filter((p) => ![...GENERATED_PAGES].some((gen) => p === `apps/docs/${gen}.md`));

  test.each(pages)('%s carries no changelog-speak', (page) => {
    const contents = read(page);
    for (const pattern of BANNED) {
      expect(pattern.test(contents), `${page} uses "${pattern.source}" — move it to the changelog / What's new`).toBe(
        false,
      );
    }
  });

  test.each(pages)('%s announces no planned work', (page) => {
    const contents = read(page);
    for (const pattern of PLANNED) {
      expect(
        contents.match(pattern)?.[0],
        `${page} describes planned work: describe what ships, and move the plan to ROADMAP.md`,
      ).toBeUndefined();
    }
  });
});

describe('no endpoint paths in prose', () => {
  // The API reference is the one place endpoints are documented: the in-app
  // `/docs` page, generated from each handler's OpenAPI metadata. A path
  // copied into a docs page goes stale when the route changes, so prose links
  // the API reference instead. Code examples keep their paths, and so do the
  // two endpoints an operator's tooling calls by name.
  const ALLOWED = new Set(['/api/health', '/api/metrics']);

  // Every route under server/api, one pattern per handler file: `[id]` is a
  // parameter and `[...path]` a catch-all. The catch-all at the root (the
  // unknown-route handler) would match any path, so it is left out.
  const routeSegments = (function walk(dir: string, prefix: string[]): string[][] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      if (entry.isDirectory()) return walk(join(dir, entry.name), [...prefix, entry.name]);
      const name = entry.name.replace(/(\.(get|post|put|patch|delete))?\.ts$/, '');
      return [name === 'index' ? prefix : [...prefix, name]];
    });
  })(join(repoRoot, 'apps/application/server/api'), []).filter((route) => route.join('/') !== '[...path]');

  const isPiwiEndpoint = (path: string) => {
    const segments = path
      .replace(/^\/api\/?/, '')
      .replace(/\/$/, '')
      .split('/');
    return routeSegments.some(
      (route) =>
        (route.length === segments.length || route.at(-1)?.startsWith('[...')) &&
        route.every((part, i) => part.startsWith('[') || part === segments[i]),
    );
  };

  test('the route list is read', () => {
    expect(isPiwiEndpoint('/api/projects/:id/quarantine')).toBe(true);
    expect(isPiwiEndpoint('/api/orders')).toBe(false);
  });

  const pages = docsPages.filter((p) => !GENERATED_PAGES.has(p.replace(/^apps\/docs\//, '').replace(/\.md$/, '')));

  test.each(pages)('%s names no Piwi endpoint outside a code example', (page) => {
    const prose = read(page).replace(FRONT_MATTER, '').replace(FENCED_CODE, '');
    const paths = [...prose.matchAll(/\/api\/[\w:{}.*-]+(?:\/[\w:{}.*-]+)*/g)]
      .map((m) => m[0].replace(/\.$/, ''))
      .filter((path) => !ALLOWED.has(path) && isPiwiEndpoint(path));
    expect(
      paths,
      `${page} names Piwi endpoints in prose: link the [API docs](https://piwitests.dev/demo/docs) instead (apps/docs/AGENTS.md, "The API reference")`,
    ).toEqual([]);
  });
});

describe('hand-written reference pages match the code', () => {
  // These pages list what a code list holds but are written by hand, because
  // the code has no descriptions to generate them from. Each check fails when
  // the code gains an entry the page does not name.

  // One `## ` section of a page, found by a heading that contains `heading`.
  const sectionOf = (page: string, heading: string) =>
    read(page)
      .split(/^## /m)
      .find((part) => part.split('\n', 1)[0]!.includes(heading)) ?? '';

  test('every notification event is on the Notification events page', () => {
    const page = read('apps/docs/reference/notification-events.md');
    for (const event of [...NOTIFICATION_EVENTS, REPORT_READY_EVENT]) {
      expect(page, `apps/docs/reference/notification-events.md does not name \`${event}\``).toContain(`\`${event}\``);
    }
  });

  test('every clue rule is on the Clue rules page', () => {
    const union = /export type FailureClueRule =([^;]+);/.exec(read('apps/application/shared/failure-clues.ts'))?.[1];
    const rules = [...(union ?? '').matchAll(/'([\w-]+)'/g)].map((m) => m[1]!);
    expect(rules.length, 'FailureClueRule was not found in shared/failure-clues.ts').toBeGreaterThan(0);
    const page = read('apps/docs/reference/clues.md');
    for (const rule of rules) {
      expect(page, `apps/docs/reference/clues.md does not show the rule id \`${rule}\``).toContain(`\`${rule}\``);
    }
  });

  test('every locator stability rule is on the Locator stability rules page', () => {
    const page = read('apps/docs/reference/locator-stability.md');
    for (const rule of LOCATOR_STABILITY_RULES) {
      expect(page, `apps/docs/reference/locator-stability.md does not show the rule id \`${rule.id}\``).toContain(
        `\`${rule.id}\``,
      );
    }
  });

  test('every shortcut the app registers is on the Keyboard shortcuts page', () => {
    const page = 'apps/docs/reference/keyboard-shortcuts.md';
    // The go-to chords, `'g-h': () => …` in defineShortcuts.
    const chords = [...read('apps/application/app/composables/useDashboard.ts').matchAll(/'(\w)-(\w)':/g)];
    expect(chords.length, 'no defineShortcuts chords found in app/composables/useDashboard.ts').toBeGreaterThan(0);
    const anywhere = sectionOf(page, 'Anywhere');
    for (const [, first, second] of chords) {
      expect(anywhere, `${page} does not list the chord ${first} then ${second}`).toContain(
        `\`${first}\` then \`${second}\``,
      );
    }
    // The failure inbox's keys, the `case 'x':` branches of its keydown handler.
    const inbox = read('apps/application/app/components/home/OpenFailuresCard.vue');
    const handler = /function onKeydown[\s\S]*?\n}\n/.exec(inbox)?.[0] ?? '';
    const keys = [
      ...[...handler.matchAll(/case '(\w)':/g)].map((m) => m[1]!),
      ...(handler.includes("'Escape'") ? ['Esc'] : []),
    ];
    expect(keys.length, 'no keys found in the failure inbox keydown handler').toBeGreaterThan(0);
    const section = sectionOf(page, 'Failure inbox');
    for (const key of keys) {
      expect(section, `${page} does not list the failure inbox key \`${key}\``).toContain(`\`${key}\``);
    }
    // The test lists' search box: Ctrl+F reaches it, and the keys its keydown handler takes.
    const lists = sectionOf(page, 'Test lists');
    expect(read('apps/application/app/composables/useFindShortcut.ts')).toContain("!== 'f'");
    expect(lists, `${page} does not list the Ctrl + F find shortcut`).toContain('`Ctrl` + `F`');
    const search = read('apps/application/app/components/shared/TestSearchInput.vue');
    const searchHandler = /function onKeydown[\s\S]*?\n}\n/.exec(search)?.[0] ?? '';
    const KEY_NAMES: Record<string, string> = { ArrowDown: '↓', ArrowUp: '↑', Escape: 'Esc' };
    const searchKeys = [...searchHandler.matchAll(/case '(\w+)':/g)].map((m) => KEY_NAMES[m[1]!] ?? m[1]!);
    expect(searchKeys.length, 'no keys found in the test search keydown handler').toBeGreaterThan(0);
    for (const key of searchKeys) {
      expect(lists, `${page} does not list the test search key \`${key}\``).toContain(`\`${key}\``);
    }
  });

  test('every test search qualifier is on the Test search page', () => {
    const page = sectionOf('apps/docs/reference/test-search.md', 'Qualifiers');
    for (const def of TEST_SEARCH_FIELD_DEFS) {
      for (const key of [def.key, ...def.aliases]) {
        expect(page, `apps/docs/reference/test-search.md does not name the qualifier \`${key}:\``).toContain(
          `\`${key}:\``,
        );
      }
    }
  });

  // Each command's `--help` text is its USAGE constant; the page has one
  // section per command. A flag counts as listed when the section names it.
  const CLI_COMMANDS: Record<string, string> = {
    init: '`init`',
    skills: '`skills`',
    gate: '`gate`',
    'quality-report': '`report`',
    select: '{#select-run}',
    probe: '`probe`',
    flake: '`flake`',
    ai: '`ai`',
    codegen: '`codegen`',
    preflight: '`preflight`',
    coverage: '`coverage`',
  };

  test.each(Object.entries(CLI_COMMANDS))('every flag of %s --help is in the Piwi CLI reference', (source, heading) => {
    const usage = /const USAGE = `([\s\S]*?)`/.exec(read(`packages/reporter/src/cli/${source}.ts`))?.[1] ?? '';
    const flags = [...new Set([...usage.matchAll(/(?<![\w-])--[a-z][a-z\d-]*/g)].map((m) => m[0]))];
    expect(flags.length, `no flags found in packages/reporter/src/cli/${source}.ts`).toBeGreaterThan(0);
    const section = sectionOf('apps/docs/reference/cli.md', heading);
    expect(section, `apps/docs/reference/cli.md has no section headed ${heading}`).not.toBe('');
    const missing = flags.filter((flag) => !new RegExp(`${flag}(?![a-z\\d-])`).test(section));
    expect(missing, `apps/docs/reference/cli.md, section ${heading}, does not list these flags`).toEqual([]);
  });

  // The UI overview's Live demo paragraph names the guided tour's roles and
  // languages, as the tour registry and its English copy spell them.
  test('every guided tour role and language is in the Live demo section of the UI overview', () => {
    const page = 'apps/docs/features/ui-overview.md';
    // Prose wraps, so a label split across two source lines still counts.
    const section = sectionOf(page, 'Live demo').replace(/\s+/g, ' ');
    expect(section, `${page} has no section headed Live demo`).not.toBe('');
    for (const { id } of TOUR_PROFILES) {
      const label = TOUR_COPY.en.profiles[id].label;
      expect(section, `${page}, section Live demo, does not name the guided tour role "${label}"`).toContain(label);
    }
    for (const code of TOUR_LANGUAGES) {
      const { englishName } = TOUR_LANGUAGE_INFO[code];
      expect(section, `${page}, section Live demo, does not name the guided tour language ${englishName}`).toContain(
        englishName,
      );
    }
  });
});

describe('word budget per page type', () => {
  // Every page is one type (adr/docs-revamp.md, "One type per page"),
  // and each type has one budget, with no allowlist: a page over its budget is
  // cut or split, never excused. A page's type is its folder; PAGE_TYPE_EXCEPTIONS
  // lists the few pages whose folder says otherwise. Reference pages list values
  // and have no budget. Blog posts are essays, not one of the five types.
  const BUDGETS = { setup: 1500, feature: 1500, recipe: 1000, 'self-hosting': 1500, reference: Infinity } as const;
  type PageType = keyof typeof BUDGETS;
  const FOLDER_TYPES: Record<string, PageType> = {
    guide: 'setup',
    features: 'feature',
    recipes: 'recipe',
    operate: 'self-hosting',
    reference: 'reference',
  };
  const PAGE_TYPE_EXCEPTIONS: Record<string, PageType> = {
    // The vocabulary: a list of terms, read by lookup.
    'guide/concepts': 'reference',
    // The home page opens Get started.
    index: 'setup',
  };

  const typedPages = docsPages
    .map((p) => p.replace(/^apps\/docs\//, '').replace(/\.md$/, ''))
    .filter((page) => !page.startsWith('blog/') && !GENERATED_PAGES.has(page));

  test.each(typedPages)('%s is within the budget of its page type', (page) => {
    const type = PAGE_TYPE_EXCEPTIONS[page] ?? FOLDER_TYPES[page.split('/')[0]!];
    expect(type, `apps/docs/${page}.md has no page type: add its folder to FOLDER_TYPES`).toBeDefined();
    // The page as a reader sees it: the front matter is metadata, not reading.
    const words = read(`apps/docs/${page}.md`).replace(FRONT_MATTER, '').trim().split(/\s+/).length;
    expect(
      words,
      `apps/docs/${page}.md is ${words} words, over the ${BUDGETS[type!]}-word budget of a ${type} page: cut it or split it`,
    ).toBeLessThanOrEqual(BUDGETS[type!]);
  });
});

describe('docs site structure', () => {
  // The feature catalog is the site's one grouping: the Features sidebar, the
  // landing cards and the All features page are all rendered from it, so a
  // feature page it does not list is a page no reader can find by browsing.
  const catalogPages = new Set(
    PIWI_FEATURE_GROUPS.flatMap((group) => group.features.map((feature) => feature.doc.split('#')[0])),
  );
  const featurePages = docsPages
    .filter((p) => p.startsWith('apps/docs/features/'))
    .map((p) => p.replace(/^apps\/docs\//, '').replace(/\.md$/, ''));

  test.each(featurePages)('%s is an entry in the feature catalog', (page) => {
    expect(catalogPages.has(page), `${page} is missing from shared/piwi-features.ts`).toBe(true);
  });

  // In a feature group a catalog entry is a page: one feature, one page, one
  // set of <Needs> chips. Only the Self-hosting group may point into a section
  // of an operator page.
  const featureEntries = PIWI_FEATURE_GROUPS.filter((group) => group.title !== 'Self-hosting').flatMap((group) =>
    group.features.map((feature) => [`${group.title} → ${feature.title}`, feature.doc] as const),
  );

  test.each(featureEntries)('%s points to a whole page', (_entry, doc) => {
    expect(
      doc,
      `a feature entry links a whole page, not a section: give it a page or fold it into another entry`,
    ).not.toContain('#');
  });

  // The description is the page's search snippet and its social-card text.
  // The home page uses the site description in config.mts instead.
  test.each(docsPages)('%s has a description', (page) => {
    const frontMatter = /^---\n([\s\S]*?)\n---\n/.exec(read(page))?.[1] ?? '';
    if (/^layout: home$/m.test(frontMatter)) return;
    expect(frontMatter, `${page} has no description in its front matter`).toMatch(/^description: \S/m);
  });

  // A page has one name: its sidebar label is its H1. A recipe is the
  // exception, since its H1 is the question the reader arrives with.
  const h1Of = (path: string) =>
    /^# (.+)$/m.exec(
      readFileSync(path, 'utf8')
        .replace(/^---\n[\s\S]*?\n---\n/, '')
        .replace(/```[\s\S]*?```/g, ''),
    )?.[1];
  const sidebarEntries = [
    ...new Map(
      Object.values(sidebars())
        .flat()
        .flatMap((group) => group.items)
        .filter((item) => item.link.startsWith('/'))
        .map((item) => [`${item.link} ${item.text}`, [item.link, item.text] as const]),
    ).values(),
  ];

  test.each(sidebarEntries)('sidebar entry %s resolves to a page titled "%s"', (link, text) => {
    const [route, anchor] = link.split('#');
    const page = route!.replace(/^\//, '').replace(/\/$/, '/index');
    const path = join(repoRoot, 'apps/docs', `${page}.md`);
    if (GENERATED_PAGES.has(page) && !existsSync(path)) return;

    expect(existsSync(path), `the sidebar links ${link}, and there is no apps/docs/${page}.md`).toBe(true);
    if (anchor) {
      expect(anchorsOf(path), `apps/docs/${page}.md has no heading anchored #${anchor}`).toContain(anchor);
      return;
    }
    if (page.startsWith('recipes/')) return;
    expect(h1Of(path), `apps/docs/${page}.md: the H1 and the sidebar label differ`).toBe(text);
  });

  // The READMEs and the Docker Hub page link into the site from outside it, so
  // nothing but this check notices when a page or heading they point at moves.
  const SURFACES = [
    'README.md',
    'DOCKER_HUB.md',
    'ROADMAP.md',
    ...readdirSync(join(repoRoot, 'packages')).map((dir) => `packages/${dir}/README.md`),
    ...readdirSync(join(repoRoot, 'integrations')).map((dir) => `integrations/${dir}/README.md`),
    'apps/extension/README.md',
    'apps/desktop/README.md',
    'apps/vscode/README.md',
    'apps/jetbrains/README.md',
  ].filter((surface) => existsSync(join(repoRoot, surface)));
  const surfaceLinks = [
    ...new Set(
      SURFACES.flatMap((surface) =>
        [...read(surface).matchAll(/https:\/\/piwitests\.dev(\/[^\s)"'<>`]*)?/g)]
          .map((m) => m[1] ?? '/')
          // The demo is the app itself, and files under public/ are not pages.
          .filter((url) => !url.startsWith('/demo') && !/\.[a-z0-9]+(#.*)?$/i.test(url))
          .map((url) => `${surface} ${url}`),
      ),
    ),
  ];

  test.each(surfaceLinks)('%s resolves to a page and heading', (entry) => {
    const [surface, url] = entry.split(' ');
    const [route, anchor] = url!.split('#');
    const page = route!.replace(/^\//, '').replace(/\/$/, '') || 'index';
    const path = [`${page}.md`, `${page}/index.md`].map((file) => join(repoRoot, 'apps/docs', file)).find(existsSync);
    if (GENERATED_PAGES.has(page) && !path) return;

    expect(path, `${surface} links ${url}, and the docs have no such page`).toBeDefined();
    if (!anchor) return;
    expect(anchorsOf(path!), `${surface} links ${url}, and the page has no such heading`).toContain(anchor);
  });

  // The docs build fails on a link to a missing page but not on one to a
  // missing heading, so a section that moves breaks every link to it silently.
  // Generated pages are left out: their links come from registries checked above.
  const handWrittenPages = docsPages.filter(
    (p) => !GENERATED_PAGES.has(p.replace(/^apps\/docs\//, '').replace(/\.md$/, '')),
  );
  const brokenLinksFrom = (source: string) => {
    const contents = read(source);
    const frontMatter = FRONT_MATTER.exec(contents)?.[0] ?? '';
    const body = contents
      .slice(frontMatter.length)
      .replace(FENCED_CODE, '')
      .replace(/`[^`\n]*`/g, '')
      .replace(/<!--[\s\S]*?-->/g, '');
    const links = [
      ...[...frontMatter.matchAll(/^\s*link: (\S+)$/gm)].map((m) => m[1]!),
      ...[...body.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map((m) => m[1]!),
      ...[...body.matchAll(/\bhref="([^"]+)"/g)].map((m) => m[1]!),
    ];
    const from = source.replace(/^apps\/docs\//, '').replace(/\.md$/, '');
    return links.flatMap((link) => {
      // Other sites, and files under public/ rather than pages.
      if (/^([a-z][a-z\d+.-]*:|\/\/)/i.test(link)) return [];
      const [route = '', anchor] = link.split('?')[0]!.split('#');
      if (/\.(?!md$|html$)[a-z\d]+$/i.test(route)) return [];
      const page = !route
        ? from
        : posix
            .join('/', route.startsWith('/') ? '' : posix.dirname(from), route)
            .slice(1)
            .replace(/\.(md|html)$/, '')
            .replace(/(^|\/)$/, '$1index');
      const path = [`${page}.md`, `${page}/index.md`].map((file) => join(repoRoot, 'apps/docs', file)).find(existsSync);
      if (!path) return GENERATED_PAGES.has(page) ? [] : [`${link} (no such page)`];
      if (!anchor || anchorsOf(path).includes(decodeURIComponent(anchor))) return [];
      return [`${link} (no such heading)`];
    });
  };

  test.each(handWrittenPages)('links from %s resolve to a page and heading', (page) => {
    expect(brokenLinksFrom(page)).toEqual([]);
  });

  // A recipe answers a question a reader meets on a feature page or on a screen
  // of the dashboard, so it is linked from both: a feature page's "Related"
  // footer and the `recipe` of an in-app help topic.
  const recipes = docsPages
    .filter((p) => p.startsWith('apps/docs/recipes/'))
    .map((p) => p.replace(/^apps\/docs\//, '').replace(/\.md$/, ''));
  const featurePageSources = docsPages.filter((p) => p.startsWith('apps/docs/features/')).map((p) => read(p));
  const helpRecipes = new Set(
    Object.values(HELP_TOPICS).flatMap((topic) => ('recipe' in topic ? [topic.recipe.doc] : [])),
  );

  test.each(recipes)('%s is linked from a feature page and a help topic', (recipe) => {
    const link = new RegExp(`\\]\\((?:/|\\.\\./)${recipe}(?:#[^)]*)?\\)`);
    expect(
      featurePageSources.some((contents) => link.test(contents)),
      `no features/ page links /${recipe}`,
    ).toBe(true);
    expect(helpRecipes.has(recipe), `no help topic in app/utils/help-content.ts has recipe.doc '${recipe}'`).toBe(true);
  });
});

describe('demo examples', () => {
  // A page renders its own examples (shared/demo/demo-examples.mjs) with
  // <DemoExamples />, in its "Try it in the demo" section, the last one before
  // Related, and a page that renders the list has entries to fill it.
  const DEMO_HEADING = '## Try it in the demo';
  const TAG = /^<DemoExamples\b[^>]*\/>\s*$/;
  const linesOf = (page: string) =>
    read(`apps/docs/${page}.md`).replace(FRONT_MATTER, '').replace(FENCED_CODE, '').split('\n');
  const examplePages = [...new Set(DEMO_EXAMPLES.map((e) => e.doc))];

  test.each(examplePages)(
    '%s renders its demo examples in its "Try it in the demo" section, before Related',
    (page) => {
      expect(existsSync(join(repoRoot, `apps/docs/${page}.md`)), `apps/docs/${page}.md exists`).toBe(true);
      const lines = linesOf(page);
      const at = lines.findIndex((line) => TAG.test(line));
      expect(at, `apps/docs/${page}.md renders <DemoExamples />`).toBeGreaterThanOrEqual(0);
      const heading = lines
        .slice(0, at)
        .reverse()
        .find((line) => /^#{1,6} /.test(line));
      expect(heading, `the heading above <DemoExamples /> in apps/docs/${page}.md`).toBe(DEMO_HEADING);
      const next = lines.slice(at + 1).find((line) => /^## /.test(line));
      expect(next, `the section after "Try it in the demo" in apps/docs/${page}.md`).toBe('## Related');
    },
  );

  test('every page that renders <DemoExamples /> has examples', () => {
    const rendering = docsPages
      .map((p) => p.replace(/^apps\/docs\//, '').replace(/\.md$/, ''))
      .filter((page) => linesOf(page).some((line) => TAG.test(line)));
    expect(rendering.filter((page) => !examplePages.includes(page))).toEqual([]);
  });

  // A page links the demo's home or its API reference by hand; a concrete
  // screen only through the registry, whose entries the seed is checked against.
  test('no page links a demo screen by hand', () => {
    const handLinks = docsPages.flatMap((page) =>
      [...read(page).matchAll(/piwitests\.dev\/demo\/([^)\s"'`>]*)/g)]
        .map((m) => m[1]!)
        .filter((path) => path !== '' && path !== 'docs')
        .map((path) => `${page}: /demo/${path}`),
    );
    expect(handLinks).toEqual([]);
  });

  test('every example route is a demo route, from the demo root', () => {
    for (const example of DEMO_EXAMPLES) expect(example.route, example.id).toMatch(/^\/(?!demo\/)\S+$/);
  });
});
