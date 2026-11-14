import { describe, test, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, posix, relative } from 'node:path';
import { isGeneratedDocsPage } from '#shared/docs-generated-pages';
import { MAX_CONTROLS_PER_PAGE } from '#shared/graph';
import { exposureFactorsFor, type DetectedGap } from '#shared/handlers/scenario-gaps';
import { PIWI_ENV_VARS, type PiwiEnvVarMeta } from '#shared/piwi-env-vars';
import { PROJECT_COVERAGE_VIEWS, PROJECT_MENU_PAGES, PROJECT_TABS, RUN_TABS, type PlaceTab } from '#shared/app-places';
import { PIWI_FEATURE_GROUPS } from '#shared/piwi-features';
import { actionTitle, EDITOR_ACTIONS } from '../../../../packages/editor/src/actions';
import { piwiActionTitle } from '../../../../packages/editor/src/analysis';
import { ALL_SKILLS, WORKFLOW_SKILLS } from '../../../../packages/reporter/src/cli/skills';

// The agent guide of a directory and the file that loads it for Claude Code: not docs pages.
const AGENT_GUIDES = ['AGENTS.md', 'CLAUDE.md'];

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const read = (path: string) => readFileSync(join(repoRoot, path), 'utf8');

const FRONT_MATTER = /^---\n[\s\S]*?\n---\n/;
// A fence may be indented, inside a list item.
const FENCED_CODE = /^[ \t]*(`{3,}|~{3,})[\s\S]*?^[ \t]*\1/gm;
const INLINE_CODE = /`[^`\n]*`/g;

// The pages a person writes: every Markdown page of the docs site but the ones `docs:gen` writes from a registry.
const handWrittenPages = (function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path);
    return entry.name.endsWith('.md') && !AGENT_GUIDES.includes(entry.name) ? [relative(repoRoot, path)] : [];
  });
})(join(repoRoot, 'apps/docs')).filter((page) => !isGeneratedDocsPage(page.slice('apps/docs/'.length, -'.md'.length)));

// An HTML or Vue tag with its attributes, and a character written as an entity.
const MARKUP = /<\/?[a-zA-Z][^>]*>|&#?\w+;/g;

/** What a reader reads of a page: no front matter, no code block, no inline code, no markup. */
const proseOf = (page: string) =>
  read(page).replace(FRONT_MATTER, '').replace(FENCED_CODE, ' ').replace(INLINE_CODE, ' ').replace(MARKUP, ' ');

describe('counts in prose', () => {
  // A count copied into a sentence goes stale when its list grows. A number before one of COUNTED_NOUNS is
  // therefore tied here to the list it counts, and a sentence whose list no test can read names no number.
  const NUMBER_WORDS = [
    'two',
    'three',
    'four',
    'five',
    'six',
    'seven',
    'eight',
    'nine',
    'ten',
    'eleven',
    'twelve',
    'thirteen',
    'fourteen',
    'fifteen',
    'sixteen',
    'seventeen',
    'eighteen',
    'nineteen',
    'twenty',
  ];
  const COUNTED_NOUNS = ['tabs', 'views', 'tools', 'skills', 'routes', 'sections', 'factors', 'controls', 'commands'];
  // The number, at most one word, the noun: "six skills", "six workflow skills".
  const COUNT = new RegExp(
    `\\b(\\d+|${NUMBER_WORDS.join('|')})\\s+(?:[\\w'’-]+\\s+)?(?:${COUNTED_NOUNS.join('|')})\\b`,
    'gi',
  );
  const numberOf = (phrase: string) => {
    const number = phrase.split(' ')[0]!;
    return /^\d+$/.test(number) ? Number(number) : NUMBER_WORDS.indexOf(number) + 2;
  };
  /** Each count a page states, in lower case on one line, once. */
  const countsOf = (page: string) => [
    ...new Set([...proseOf(page).matchAll(COUNT)].map((m) => m[0].toLowerCase().replace(/\s+/g, ' '))),
  ];

  /** The sections of the JetBrains plugin's Tools → Piwi menu: the groups inside `Piwi.Actions`. */
  const jetbrainsMenuSections = () => {
    const xml = read('apps/jetbrains/src/main/resources/META-INF/plugin.xml');
    const menu = xml.slice(xml.indexOf('<group id="Piwi.Actions"'), xml.indexOf('<group id="Piwi.StatusActions"'));
    return [...menu.matchAll(/<group id="/g)].length - 1;
  };
  const exposureFactors = () => Object.keys(exposureFactorsFor({} as DetectedGap, {})).length;

  // Each count the pages state: the page, the phrase as countsOf reads it, and the list that holds the true number.
  const COUNTS: { page: string; phrase: string; list: string; count: () => number }[] = [
    {
      page: 'apps/docs/features/agent-skills.md',
      phrase: 'six workflow skills',
      list: 'WORKFLOW_SKILLS (packages/reporter/src/cli/skills.ts)',
      count: () => WORKFLOW_SKILLS.length,
    },
    {
      page: 'apps/docs/reference/cli.md',
      phrase: 'six workflow skills',
      list: 'WORKFLOW_SKILLS (packages/reporter/src/cli/skills.ts)',
      count: () => WORKFLOW_SKILLS.length,
    },
    {
      page: 'apps/docs/reference/cli.md',
      phrase: 'seven skills',
      list: 'ALL_SKILLS (packages/reporter/src/cli/skills.ts)',
      count: () => ALL_SKILLS.length,
    },
    {
      page: 'apps/docs/features/jetbrains.md',
      phrase: 'six sections',
      list: 'the groups of Piwi.Actions (apps/jetbrains/src/main/resources/META-INF/plugin.xml)',
      count: jetbrainsMenuSections,
    },
    {
      page: 'apps/docs/features/scenario-gaps.md',
      phrase: 'three views',
      list: 'PROJECT_COVERAGE_VIEWS (shared/app-places.ts)',
      count: () => PROJECT_COVERAGE_VIEWS.length,
    },
    {
      page: 'apps/docs/features/ui-overview.md',
      phrase: 'three views',
      list: 'PROJECT_COVERAGE_VIEWS (shared/app-places.ts)',
      count: () => PROJECT_COVERAGE_VIEWS.length,
    },
    {
      page: 'apps/docs/reference/gap-detectors.md',
      phrase: 'four factors',
      list: 'the factors of exposureFactorsFor (shared/handlers/scenario-gaps.ts)',
      count: exposureFactors,
    },
    {
      page: 'apps/docs/reference/gap-detectors.md',
      phrase: '200 controls',
      list: 'MAX_CONTROLS_PER_PAGE (shared/graph.ts)',
      count: () => MAX_CONTROLS_PER_PAGE,
    },
  ];

  test('a count is read in digits and in words, with one word before the noun', () => {
    const counts = (text: string) => [...text.matchAll(COUNT)].map((m) => m[0]);
    expect(counts('It has 4 tabs, six workflow skills and twenty routes.')).toEqual([
      '4 tabs',
      'six workflow skills',
      'twenty routes',
    ]);
    expect(counts('Three of its many open tabs, and one tab.')).toEqual([]);
    expect(numberOf('six workflow skills')).toBe(6);
    expect(numberOf('200 controls')).toBe(200);
  });

  test.each(handWrittenPages)('%s states no count that no list backs', (page) => {
    const tied = (phrase: string) => COUNTS.find((entry) => entry.page === page && entry.phrase === phrase);
    expect(
      countsOf(page).filter((phrase) => !tied(phrase)),
      `${page} states a count: tie the number to its list in COUNTS (tests/unit/docs-claims.test.ts), or write the sentence without the number`,
    ).toEqual([]);
    for (const phrase of countsOf(page)) {
      const { list, count } = tied(phrase)!;
      expect(numberOf(phrase), `${page} says "${phrase}" and ${list} holds ${count()}: correct the number`).toBe(
        count(),
      );
    }
  });

  test.each(COUNTS)('$page still says "$phrase"', ({ page, phrase }) => {
    expect(
      countsOf(page),
      `COUNTS ties "${phrase}" to a list and ${page} does not say it: remove the row, or correct its phrase`,
    ).toContain(phrase);
  });
});

describe('quoted editor commands', () => {
  // A command quoted as **Piwi: …** is what a reader types in the command palette, so it is a title one of the
  // editors shows: the action catalog in each editor's words, the VS Code manifest and the JetBrains plugin
  // descriptor, which `packages/editor/tests/actions.test.ts` holds to the catalog.
  //
  // One normalization, on both sides: white space collapses (a title wraps in Markdown), a typographic apostrophe
  // is a straight one, and a trailing ellipsis is dropped, since a title ends with one only in the editor that asks
  // for a choice first.
  const normalize = (title: string) =>
    title
      .replace(/\s+/g, ' ')
      .replace(/’/g, "'")
      .trim()
      .replace(/(?:…|\.\.\.)$/, '');

  const decode = (text: string) =>
    text
      .replace(/&apos;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');

  const vscodeTitles = (
    JSON.parse(read('apps/vscode/package.json')) as { contributes: { commands: { title: string }[] } }
  ).contributes.commands.map((command) => command.title);

  // Each `<action>` of plugin.xml. An action a menu of the IDE's own lists among others' leads its text with
  // `Piwi: `, which the page writes once.
  const jetbrainsTitles = [
    ...read('apps/jetbrains/src/main/resources/META-INF/plugin.xml').matchAll(/<action\b((?:[^>"]|"[^"]*")*)>/g),
  ].map(([, attributes]) => decode(/\btext="([^"]*)"/.exec(attributes!)?.[1] ?? '').replace(/^Piwi: /, ''));

  const titles = new Set(
    [
      ...EDITOR_ACTIONS.flatMap((action) => [actionTitle(action, 'vscode'), actionTitle(action, 'jetbrains')]),
      ...vscodeTitles,
      ...jetbrainsTitles,
    ]
      .filter(Boolean)
      .map(normalize),
  );

  test('the titles of both editors are read', () => {
    expect(vscodeTitles).toContain('Run the test at the cursor');
    expect(jetbrainsTitles).toContain('Run to the caret');
    expect(titles).toContain('Copy the MCP server configuration');
    expect(normalize('Record a new\n  test file…')).toBe('Record a new test file');
  });

  // A quick fix's title is built from the code under the cursor (`piwiActionTitle` in packages/editor/src/analysis.ts):
  // its words after `Piwi: ` start lower-case, where a command's start upper-case.
  const isQuickFix = (title: string) => /^[a-z]/.test(title);

  test('a command title starts upper-case, a quick fix title lower-case', () => {
    expect([...titles].filter(isQuickFix)).toEqual([]);
    expect(isQuickFix(piwiActionTitle("Use getByTestId('pay')").replace(/^Piwi: /, ''))).toBe(true);
  });

  test.each(handWrittenPages)('%s quotes only commands the editors have', (page) => {
    const quoted = [
      ...read(page)
        .replace(FRONT_MATTER, '')
        .replace(FENCED_CODE, ' ')
        .matchAll(/\*\*Piwi: ([^*]+)\*\*/g),
    ].map((m) => normalize(m[1]!));
    expect(
      quoted.filter((title) => !isQuickFix(title) && !titles.has(title)),
      `${page} quotes as **Piwi: …** what neither editor has as a command: use a title of packages/editor/src/actions.ts, or write text that is no command (a status bar label, a panel's name) as inline code`,
    ).toEqual([]);
  });
});

describe('recipes state no figure', () => {
  // A recipe sends the reader to the feature pages; a threshold, a formula or a number of runs copied into it is
  // a second copy that drifts. A step's number is its place, not a figure: the number that opens a heading or an
  // ordered list item is left out, with the code and the link targets.
  const LINK_TARGET = /\]\([^)\s]*\)|\b(?:src|href|poster)="[^"]*"/g;
  const STEP_NUMBER = /^(\s*(?:#{1,6}\s+)?)\d+\.(?=\s)/gm;

  const figuresOf = (markdown: string) =>
    markdown
      .replace(FRONT_MATTER, '')
      .replace(FENCED_CODE, ' ')
      .replace(INLINE_CODE, ' ')
      .replace(LINK_TARGET, ' ')
      .replace(MARKUP, ' ')
      .replace(STEP_NUMBER, '$1')
      .split('\n')
      .filter((line) => /\d/.test(line))
      .map((line) => line.trim());

  test('a figure is read in prose, not in code, a link target or a step number', () => {
    expect(figuresOf('## 2. Check `retries: 2`\n\n1. See [the score](/features/flaky-tests#top-5).\n')).toEqual([]);
    expect(figuresOf('Red at 30 minutes or more.\n')).toEqual(['Red at 30 minutes or more.']);
  });

  const recipes = handWrittenPages.filter((page) => page.startsWith('apps/docs/recipes/'));

  test.each(recipes)('%s states no figure', (page) => {
    expect(
      figuresOf(read(page)),
      `${page} states a figure: a threshold or a formula belongs on the feature page the recipe links, so link the section that states it`,
    ).toEqual([]);
  });
});

describe('the privacy page lists every destination', () => {
  // The privacy page promises that every outbound call of the server is in its table. A registry variable that
  // points the server at a host carries the destination's name as the table writes it.
  const PAGE = 'apps/docs/guide/privacy.md';
  const HEADING = 'What leaves your server';

  // The first cell of each row of the table under the heading.
  const section =
    read(PAGE)
      .split(/^## /m)
      .find((part) => part.startsWith(`${HEADING}\n`)) ?? '';
  const listed = [...section.matchAll(/^\| *([^|\n]+?) *\|/gm)]
    .map((m) => m[1]!)
    .filter((cell) => cell !== 'Destination' && !/^-+$/.test(cell));

  const marked = (Object.entries(PIWI_ENV_VARS) as [string, PiwiEnvVarMeta][]).filter(([, meta]) => meta.destination);

  // The destinations no registry variable names: the place that sets each one, and the file that calls it.
  const UNREGISTERED = [
    {
      destination: 'Your OpenTelemetry collector',
      setBy: 'OTEL_EXPORTER_OTLP_ENDPOINT',
      calledBy: 'apps/application/server/utils/otel.ts',
    },
    {
      destination: "A project's OpenAPI URL",
      setBy: "the project's OpenAPI URL",
      calledBy: 'apps/application/server/utils/openapi-surface.ts',
    },
    {
      destination: 'Slack, Teams or your webhook URLs',
      setBy: 'a notification channel',
      calledBy: 'apps/application/server/utils/notifications/dispatch.ts',
    },
    {
      destination: 'A URL you attach as a link',
      setBy: 'a link added to a run, a test or a cluster',
      calledBy: 'apps/application/server/utils/unfurl',
    },
  ];

  // A variable that takes an address either names the destination it points the server at, or is one of these: the
  // server's own address, which it never calls.
  const OWN_ADDRESS = ['PIWI_SITE_URL'];
  const addresses = (Object.entries(PIWI_ENV_VARS) as [string, PiwiEnvVarMeta][]).filter(
    ([name, meta]) => meta.type === 'url' && !OWN_ADDRESS.includes(name),
  );

  test.each(addresses)('%s, an address, names its destination', (name, meta) => {
    expect(
      meta.destination,
      `${name} takes an address: give it the \`destination\` the table "${HEADING}" of ${PAGE} lists for the host it points the server at, or add it to OWN_ADDRESS when the server never calls it`,
    ).toBeTruthy();
  });

  test('the table and the marked variables are read', () => {
    expect(listed).toContain('Your AI provider');
    expect(marked.map(([name]) => name)).toContain('PIWI_SMTP_HOST');
  });

  test.each(marked)('%s points at a destination the table lists', (name, meta) => {
    expect(
      listed,
      `${name} points the server at "${meta.destination}", which the table "${HEADING}" of ${PAGE} does not list: add its row, or name the row's destination in the registry`,
    ).toContain(meta.destination);
  });

  test.each(UNREGISTERED)('$destination is in the table', ({ destination, setBy, calledBy }) => {
    expect(
      existsSync(join(repoRoot, calledBy)),
      `${calledBy} is gone: point UNREGISTERED at the file that calls the host ${setBy} names, or remove its row there and on ${PAGE} when nothing does`,
    ).toBe(true);
    expect(
      listed,
      `${calledBy} calls the host ${setBy} names, which the table "${HEADING}" of ${PAGE} does not list as "${destination}": add its row`,
    ).toContain(destination);
  });
});

describe('a concepts entry is a definition', () => {
  // `guide/concepts.md` names each word and says what it is; the rule behind the word (its thresholds, its order, its
  // cases) is on the feature page the entry links. An entry is the prose under one `###` heading, counted as the word
  // budgets count a page: split on white space after the inline code is taken out, a link counting as the words it wraps.
  const PAGE = 'apps/docs/guide/concepts.md';
  const MAX_WORDS = 80;

  const entries = proseOf(PAGE)
    .split(/^(?=#{1,3} )/m)
    .filter((section) => section.startsWith('### '))
    .map((section) => {
      const [heading, ...body] = section.split('\n');
      return { heading: heading!.slice(4).trim(), words: body.join(' ').trim().split(/\s+/).filter(Boolean).length };
    });

  test('the entries are read', () => {
    expect(entries.map((entry) => entry.heading)).toContain('Error fingerprint & failure cluster');
  });

  test.each(entries)('$heading is at most 80 words', ({ heading, words }) => {
    expect(
      words,
      `The entry "${heading}" of ${PAGE} is ${words} words, over ${MAX_WORDS}: keep the definition there and move the rule to the feature page the entry links`,
    ).toBeLessThanOrEqual(MAX_WORDS);
  });
});

describe('a shared rule has one owner', () => {
  // A rule several features share is explained on one page, its owner. Any other hand-written page that names the
  // rule states its effect in a sentence and links the owner page (any section of it), so a change to the rule is
  // made in one place. A pattern names the rule in prose; the words inside code and an image's markup do not count.
  const OWNERS: { rule: string; pattern: RegExp; owner: string }[] = [
    { rule: 'the CI merge gate', pattern: /\b(?:merge|CI) gate\b/i, owner: 'features/merge-gate' },
    { rule: 'Hold failures', pattern: /\bhold failures\b/i, owner: 'features/watch-a-run' },
    { rule: 'quarantine', pattern: /\bquarantin(?:e|es|ed|ing)\b/i, owner: 'features/flaky-tests' },
    { rule: 'the error fingerprint', pattern: /\berror fingerprint/i, owner: 'features/failure-clusters' },
    { rule: 'brittle locators', pattern: /\bbrittle\b/i, owner: 'reference/locator-stability' },
    { rule: 'wasted time', pattern: /\bwasted time\b/i, owner: 'features/slow-tests' },
    // "Baseline" alone also names a pinned commit, a visual snapshot and a plain starting point: the run baseline is
    // named by its rule or by the run it compares with.
    {
      rule: 'the baseline',
      pattern: /\bbaseline (?:rule|ladder)\b|\b(?:against|since|from) (?:its |the )?last green run\b/i,
      owner: 'features/run-changes',
    },
    { rule: 'the live view', pattern: /\blive view\b/i, owner: 'features/live-view' },
    // The line's name, in bold as the page shows it: "most likely" in lower case is ordinary prose.
    { rule: 'Most likely', pattern: /\*\*Most likely\*\*/, owner: 'reference/clues' },
  ];

  // An <img> or <video> tag, a Markdown image, and the figure tags around them: alt text is not prose a reader reads.
  const IMAGE_MARKUP = /<(?:img|video|source)\b[^>]*>|!\[[^\]]*\]\([^)]*\)/g;
  const LINK_TARGET = /\]\(([^)\s]+)\)|\bhref="([^"]+)"/g;

  /** The page, without `apps/docs/` and `.md`, each link of a page points at: `features/merge-gate`. */
  const linkedPages = (page: string) => {
    const dir = posix.dirname(page.slice('apps/docs/'.length));
    const markdown = read(page).replace(FRONT_MATTER, '').replace(FENCED_CODE, ' ');
    return new Set(
      [...markdown.matchAll(LINK_TARGET)]
        .map((m) => (m[1] ?? m[2])!.split('#')[0]!)
        .filter((target) => target && !/^[a-z]+:/i.test(target))
        .map((target) =>
          (target.startsWith('/') ? target.slice(1) : posix.join(dir, target)).replace(/\.(?:md|html)$/, ''),
        ),
    );
  };

  const cases = OWNERS.flatMap(({ rule, pattern, owner }) =>
    handWrittenPages
      .filter((page) => !page.startsWith('apps/docs/blog/') && page !== `apps/docs/${owner}.md`)
      .filter((page) => pattern.test(proseOf(page).replace(IMAGE_MARKUP, ' ')))
      .map((page) => ({ page, rule, owner })),
  );

  test('the rules are named and the links resolved', () => {
    expect(OWNERS.every(({ owner }) => existsSync(join(repoRoot, `apps/docs/${owner}.md`)))).toBe(true);
    expect(cases.map(({ page }) => page)).toContain('apps/docs/features/branches.md');
    expect(linkedPages('apps/docs/features/branches.md')).toContain('features/run-changes');
  });

  test.each(cases)('$page links the owner of $rule', ({ page, rule, owner }) => {
    expect(
      linkedPages(page).has(owner),
      `${page} names ${rule}, whose rule apps/docs/${owner}.md owns: state its effect in a sentence and link that page at the first mention`,
    ).toBe(true);
  });
});

describe('a place named in the docs is a place of the dashboard', () => {
  // A path such as "Project → Coverage → Gaps" or "Test run → Changes" names a tab the page has, by the label it has
  // in shared/app-places.ts, which the pages and the command palette read too. After a tab with views comes one of
  // its views; after the More actions menu, one of its pages; after any other tab, what the tab holds.
  const MENU = 'More actions';
  // The controls of the project page that sit outside its tabs.
  const PROJECT_CONTROLS = ['Filters', 'Export', 'Import'];
  const PATH = /\b(Project|Test run|Run) → ([A-Z][A-Za-z -]*[A-Za-z])(?: → ([A-Z][A-Za-z -]*[A-Za-z]))?/g;

  const names = (segment: string, labels: readonly string[]) =>
    labels.some((label) => segment === label || segment.startsWith(`${label} `));

  const problemsOf = (text: string): string[] =>
    [...text.matchAll(PATH)].flatMap(([path, page, first, second]) => {
      if (page !== 'Project') {
        const tabs = RUN_TABS.map((tab) => tab.label);
        return names(first!, tabs) ? [] : [`"${path}": a run's tabs are ${tabs.join(', ')}`];
      }
      if (names(first!, [MENU])) {
        const pages = PROJECT_MENU_PAGES.map((menuPage) => menuPage.label);
        return !second || names(second, pages) ? [] : [`"${path}": the ${MENU} menu opens ${pages.join(', ')}`];
      }
      if (names(first!, PROJECT_CONTROLS)) return [];
      const tab: PlaceTab | undefined = PROJECT_TABS.find((projectTab) => names(first!, [projectTab.label]));
      if (!tab) {
        const tabs = PROJECT_TABS.map((projectTab) => projectTab.label);
        return [`"${path}": a project's tabs are ${tabs.join(', ')}, and its other pages open from ${MENU}`];
      }
      const views = (tab.views ?? []).map((view) => view.label);
      return !second || views.length === 0 || names(second, views)
        ? []
        : [`"${path}": the views of ${tab.label} are ${views.join(', ')}`];
    });

  test('a path is read to its tab, its view or its menu page', () => {
    expect(problemsOf('**Project → Coverage → Gaps**, then Test run → Changes.')).toEqual([]);
    expect(problemsOf('Project → More actions → Locators')).toEqual([]);
    expect(problemsOf('Project → Timeline')).toHaveLength(1);
    expect(problemsOf('Project → Failures → Gaps')).toHaveLength(1);
    expect(problemsOf('Test run → Failures')).toHaveLength(1);
  });

  const entries = PIWI_FEATURE_GROUPS.flatMap((group) => group.features).map(
    (feature) => [feature.title, feature.where] as const,
  );

  test.each(entries)('the catalog entry "%s" says where it is', (title, where) => {
    expect(
      problemsOf(where),
      `shared/piwi-features.ts, "${title}": name the place by its label in shared/app-places.ts`,
    ).toEqual([]);
  });

  test.each(handWrittenPages)('%s names places the dashboard has', (page) => {
    expect(problemsOf(proseOf(page)), `${page}: name the place by its label in shared/app-places.ts`).toEqual([]);
  });
});
