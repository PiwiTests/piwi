import { describe, test, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, posix, relative } from 'node:path';
import { isGeneratedDocsPage } from '#shared/docs-generated-pages';
import { MAX_CONTROLS_PER_PAGE } from '#shared/graph';
import { exposureFactorsFor, type DetectedGap } from '#shared/handlers/scenario-gaps';
import { PIWI_ENV_VARS, type PiwiEnvVarMeta } from '#shared/piwi-env-vars';
import {
  PROJECT_COVERAGE_VIEWS,
  PROJECT_MENU_PAGES,
  PROJECT_SETTINGS_SECTIONS,
  PROJECT_TABS,
  RUN_TABS,
  SETTINGS_PAGE_PLACES,
  type PlaceTab,
} from '#shared/app-places';
import { PIWI_FEATURE_GROUPS } from '#shared/piwi-features';
import { QUOTED_DOCS_SECTIONS } from '#shared/piwi-ecosystem';
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
  //
  // COUNTED_NOUNS holds the nouns that, on these pages, always count a list the code keeps. A number before any other
  // noun passes, and so does a number with no noun ("Piwi ships seven"): most such numbers count what the sentence
  // itself goes on to name ("two widgets read it: …", "two modes" for the two just described) or a limit
  // ("8 levels deep"), and a check that read them would fail on every one. A noun joins the list once every count
  // the pages put before it is a list's length.
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
  const COUNTED_NOUNS = [
    'tabs',
    'views',
    'tools',
    'skills',
    'routes',
    'sections',
    'factors',
    'controls',
    'commands',
    'categories',
    'roles',
    'queues',
  ];
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
  /** The members of a union of string literals, `export type Name = 'a' | 'b';`, in a TypeScript file. */
  const unionMembers = (file: string, name: string) => {
    const declaration = new RegExp(`export type ${name} =([^;]*);`).exec(read(file))?.[1] ?? '';
    return [...declaration.matchAll(/'[^']*'/g)].length;
  };

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
      page: 'apps/docs/features/flaky-tests.md',
      phrase: 'six categories',
      list: 'FlakyRootCause (shared/flaky-classify.ts)',
      count: () => unionMembers('apps/application/shared/flaky-classify.ts', 'FlakyRootCause'),
    },
    {
      page: 'apps/docs/guide/ai-provider.md',
      phrase: 'four roles',
      list: 'AiModelRole (types/api.ts)',
      count: () => unionMembers('apps/application/types/api.ts', 'AiModelRole'),
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
    expect(unionMembers('apps/application/shared/flaky-classify.ts', 'FlakyRootCause')).toBeGreaterThan(1);
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

  // A list read from source text, such as a union of string literals, reads as empty once its declaration is written
  // another way.
  test.each(COUNTS)('$list is read', ({ list, count }) => {
    expect(
      count(),
      `COUNTS cannot read ${list}: it counts ${count()}, so the declaration is no longer written as the row's reader expects; read it another way`,
    ).toBeGreaterThan(1);
  });

  // Piwi's jobs are the numbered list under the jobs' heading of What Piwi does. A number right before "jobs" counts
  // that list, on the docs pages and on the repository files that name the jobs.
  const JOBS_COUNT = new RegExp(`\\b(\\d+|${NUMBER_WORDS.join('|')})\\s+jobs\\b`, 'gi');
  const jobsListed = () => {
    const page = read('apps/docs/guide/what-piwi-does.md');
    const anchor = QUOTED_DOCS_SECTIONS.jobs.split('#')[1];
    const section = page.slice(page.indexOf(`{#${anchor}}`)).split('\n## ')[0]!;
    return [...section.matchAll(/^\d+\. \*\*/gm)].length;
  };

  test('a count of the jobs is the length of their list on What Piwi does', () => {
    const listed = jobsListed();
    expect(listed, 'the jobs are no longer a numbered list under their heading: read them another way').toBeGreaterThan(
      1,
    );
    const wrong = [...handWrittenPages, 'README.md', 'ROADMAP.md', 'DOCKER_HUB.md'].flatMap((page) =>
      [...proseOf(page).matchAll(JOBS_COUNT)]
        .map((m) => m[0].toLowerCase().replace(/\s+/g, ' '))
        .filter((phrase) => numberOf(phrase) !== listed)
        .map((phrase) => `${page}: "${phrase}"`),
    );
    expect(wrong, `What Piwi does lists ${listed} jobs: correct the number`).toEqual([]);
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

  test('the Editor commands page names every action of both editors', () => {
    // Each title is a bold span of its own, `**Piwi: X**` or `**X**`, so a title found inside another's words counts not.
    const named = new Set(
      [...read('apps/docs/reference/editor-commands.md').matchAll(/\*\*([^*]+)\*\*/g)].map((m) =>
        normalize(m[1]!).replace(/^Piwi: /, ''),
      ),
    );
    const missing = EDITOR_ACTIONS.filter(
      (action) =>
        !named.has(normalize(actionTitle(action, 'vscode'))) && !named.has(normalize(actionTitle(action, 'jetbrains'))),
    ).map((action) => action.title);
    expect(
      missing,
      'apps/docs/reference/editor-commands.md leaves out these actions of packages/editor/src/actions.ts',
    ).toEqual([]);
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

describe("Piwi Picker's quoted labels", () => {
  // A label of Piwi Picker is quoted as **Label** right after "Piwi Picker's": what the reader looks for in the
  // extension, so it is one of the strings the extension shows, its English messages. Bold elsewhere is emphasis or
  // another tool's label, which nothing in the syntax tells apart, so only this form is read.
  const normalizeLabel = (label: string) =>
    label
      .replace(/\s+/g, ' ')
      .replace(/’/g, "'")
      .trim()
      .replace(/(?:…|\.\.\.)$/, '');

  const messages = new Set(
    Object.values(
      JSON.parse(read('apps/extension/public/_locales/en/messages.json')) as Record<string, { message: string }>,
    ).map(({ message }) => normalizeLabel(message)),
  );

  const quotedLabels = (markdown: string) =>
    [
      ...markdown
        .replace(FRONT_MATTER, '')
        .replace(FENCED_CODE, ' ')
        .matchAll(/Piwi Picker['’]s \*\*([^*]+)\*\*/g),
    ].map((m) => normalizeLabel(m[1]!));

  test('the messages and the quoted labels are read', () => {
    expect(messages).toContain('Record actions');
    expect(quotedLabels("Open Piwi Picker's **Record actions**, then **Stop**.")).toEqual(['Record actions']);
  });

  test.each(handWrittenPages)('%s quotes only labels Piwi Picker shows', (page) => {
    expect(
      quotedLabels(read(page)).filter((label) => !messages.has(label)),
      `${page} quotes as Piwi Picker's **…** what is no message of apps/extension/public/_locales/en/messages.json: use the label the extension shows, or write the words without the possessive`,
    ).toEqual([]);
  });
});

describe('recipes state no figure', () => {
  // A recipe sends the reader to the feature pages; a threshold, a formula or a number of runs copied into it is
  // a second copy that drifts. A step's number is its place, not a figure, and is left out with the code and the
  // link targets: the number that opens a heading counts the page's numbered headings from 1, the one that opens an
  // ordered list item counts its list from 1. Any other number at the start of a heading or an item is a figure.
  const LINK_TARGET = /\]\([^)\s]*\)|\b(?:src|href|poster)="[^"]*"/g;
  const STEP_NUMBER = /^(\s*)(#{1,6}\s+)?(\d+)\.(?=\s)/;

  /** The text with each step's number taken out, and a number out of its step's sequence left in. */
  const withoutStepNumbers = (markdown: string) => {
    // The last number of the numbered headings at each level, and of the open ordered list at each indentation.
    const headings = new Map<number, number>();
    const items = new Map<number, number>();
    /** A heading of a level closes the lists and the numbering of the deeper headings. */
    const enterHeading = (level: number) => {
      items.clear();
      for (const deeper of [...headings.keys()]) if (deeper > level) headings.delete(deeper);
    };
    return markdown
      .split('\n')
      .map((line) => {
        const step = STEP_NUMBER.exec(line);
        if (!step) {
          const heading = /^(#{1,6})\s/.exec(line);
          if (heading) enterHeading(heading[1]!.length);
          return line;
        }
        const [numbered, indent, hashes, digits] = step;
        const number = Number(digits);
        if (hashes) {
          const level = hashes.trim().length;
          enterHeading(level);
          if (number !== (headings.get(level) ?? 0) + 1) return line;
          headings.set(level, number);
        } else {
          if (number !== 1 && number !== (items.get(indent!.length) ?? 0) + 1) return line;
          items.set(indent!.length, number);
        }
        return `${indent}${hashes ?? ''}${line.slice(numbered.length)}`;
      })
      .join('\n');
  };

  const figuresOf = (markdown: string) =>
    withoutStepNumbers(
      markdown
        .replace(FRONT_MATTER, '')
        .replace(FENCED_CODE, ' ')
        .replace(INLINE_CODE, ' ')
        .replace(LINK_TARGET, ' ')
        .replace(MARKUP, ' '),
    )
      .split('\n')
      .filter((line) => /\d/.test(line))
      .map((line) => line.trim());

  test('a figure is read in prose, not in code, a link target or a step number', () => {
    expect(
      figuresOf(
        '## 1. Open it\n\n## 2. Check `retries: 2`\n\n1. See [the score](/features/flaky-tests#top-5).\n2. Fix.\n',
      ),
    ).toEqual([]);
    expect(figuresOf('Red at 30 minutes or more.\n')).toEqual(['Red at 30 minutes or more.']);
    expect(figuresOf('## 1. Open it\n\n## 30. minutes is the limit\n')).toEqual(['## 30. minutes is the limit']);
    expect(figuresOf('1. Open it\n5. retries at most\n')).toEqual(['5. retries at most']);
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

  // Each file of the server that sends a request names the destination it reaches, so a call a feature adds in a new
  // file, to a host set in the dashboard as well as by a variable, fails here until its destination is placed in the
  // table. A file that only sends what its callers give it is a helper. The S3, PostgreSQL and OpenTelemetry clients
  // are libraries this pattern does not see: their rows come from the registry and UNREGISTERED. A new call in a file
  // already listed is not seen either.
  const CALL = /\bfetch\(|\$fetch\b|\bofetch\b|\bsafeFetch\(|\bfetchPublicImage\(|\bcreateTransport\(/;
  // A comment names calls it does not make, and a `$fetch` of a path that starts with `/` is the server calling itself.
  const COMMENT = /\/\*[\s\S]*?\*\/|(^|[^:'"`\\])\/\/.*$/gm;
  const INTERNAL_CALL = /\$fetch(?:<[^>]*>)?\(\s*['"`]\//g;
  const sendsRequest = (source: string) => CALL.test(source.replace(COMMENT, '$1').replace(INTERNAL_CALL, ' '));
  const OUTBOUND: Record<string, string> = {
    'server/api/settings/ai/models.post.ts': 'Your AI provider',
    'server/utils/ai-embeddings.ts': 'Your AI provider',
    'server/utils/ai-provider.ts': 'Your AI provider',
    'server/utils/ai-tool-calls.ts': 'Your AI provider',
    'server/utils/ci-server-dispatch.ts': 'Your CI server',
    'server/utils/email.ts': 'Your SMTP server',
    'server/utils/integrations/jira/check.ts': 'Your issue tracker (Jira)',
    'server/utils/integrations/jira/client.ts': 'Your issue tracker (Jira)',
    'server/utils/integrations/jira/icons.ts': 'Your issue tracker (Jira)',
    'server/utils/integrations/test-management/zephyr-scale.ts': 'Zephyr Scale Cloud',
    'server/utils/notifications/channel-test.ts': 'Slack, Teams or your webhook URLs',
    'server/utils/notifications/dispatch.ts': 'Slack, Teams or your webhook URLs',
    'server/utils/notifications/slack-api.ts': 'Slack, Teams or your webhook URLs',
    'server/utils/oauth.ts': 'Google / GitHub',
    'server/utils/user-avatar.ts': 'Google / GitHub',
    'server/utils/openapi-surface.ts': "A project's OpenAPI URL",
    'server/utils/scm/BitbucketProvider.ts': 'Your git host',
    'server/utils/scm/GitHubProvider.ts': 'Your git host',
    'server/utils/scm/GitLabProvider.ts': 'Your git host',
    'server/utils/unfurl/GenericUnfurlProvider.ts': 'A URL you attach as a link',
  };
  const HELPERS = ['server/utils/safe-fetch.ts', 'server/utils/public-image.ts'];

  const callers = (function walk(dir: string): string[] {
    return readdirSync(join(repoRoot, 'apps/application', dir), { withFileTypes: true }).flatMap((entry) => {
      const path = posix.join(dir, entry.name);
      if (entry.isDirectory()) return walk(path);
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.d.ts')) return [];
      return sendsRequest(read(`apps/application/${path}`)) ? [path] : [];
    });
  })('server');

  test('the calls of the server are found', () => {
    expect(callers).toContain('server/utils/scm/GitHubProvider.ts');
    expect(sendsRequest('await $fetch<Answer>(url)')).toBe(true);
    expect(sendsRequest('const prefetch = 1')).toBe(false);
    expect(sendsRequest('// a fetch( in a comment\nconst url = "https://example.com";')).toBe(false);
    expect(sendsRequest("await $fetch<Run>('/api/test-runs/1')")).toBe(false);
  });

  test.each(callers)('%s names the destination it calls', (file) => {
    if (HELPERS.includes(file)) return;
    expect(
      OUTBOUND[file],
      `apps/application/${file} sends a request: add it to OUTBOUND (tests/unit/docs-claims.test.ts) with the row of the table "${HEADING}" of ${PAGE} that lists its destination, adding the row when none does, or to HELPERS when it only sends what its callers give it`,
    ).toBeDefined();
    expect(listed, `apps/application/${file} reaches "${OUTBOUND[file]}", which the table does not list`).toContain(
      OUTBOUND[file],
    );
  });

  test.each(Object.keys(OUTBOUND))('%s still sends a request', (file) => {
    expect(callers, `apps/application/${file} no longer sends a request: remove it from OUTBOUND`).toContain(file);
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
  // its views; after the Settings tab, one of its sections; after the More actions menu, one of its pages; after any
  // other tab, what the tab holds.
  const MENU = 'More actions';
  // The controls of the project page that sit outside its tabs.
  const PROJECT_CONTROLS = ['Filters', 'Quality report', 'Import'];
  const PATH = /\b(Project|Test run|Run) → ([A-Z][A-Za-z -]*[A-Za-z])(?: → ([A-Z][A-Za-z -]*[A-Za-z]))?/g;
  // A path into Settings has one form for each place, read here once bold and the "›" separator are set aside:
  // "Project → Settings → Members" for a section of a project's Settings tab (read by PATH), "Settings → Source
  // control" for a page of Settings (SETTINGS_PAGES in shared/settings-metadata.ts). A label is matched whole: the
  // longest page or section label the path starts with, so "Settings → AI diagnosis" names a project's section.
  // Another product's settings are named by the start of their own path (OTHER_SETTINGS), or by what comes before
  // "Settings" (OTHER_SETTINGS_OWNERS: the JetBrains IDEs' "System Settings", Piwi Picker's own Settings).
  const OTHER_SETTINGS = [
    'Tools → Piwi',
    'Tools →',
    'Keymap',
    'Editor →',
    'Plugins',
    'Appearance & Behavior →',
    'Languages & Frameworks',
    'Build → Debugger',
    'Developer settings →',
    'System → Webhooks',
    'Connectors →',
    'Sites Piwi Picker may run on',
  ];
  const OTHER_SETTINGS_OWNERS = ['System', 'Browser extension →'];
  const SETTINGS_MARK = /\bSettings → /g;

  const names = (segment: string, labels: readonly string[]) =>
    labels.some((label) => segment === label || segment.startsWith(`${label} `));

  const tabProblemsOf = (text: string): string[] =>
    [...text.matchAll(PATH)].flatMap(([path, page, first, second]) => {
      if (page !== 'Project') {
        const tabs = RUN_TABS.map((tab) => tab.label);
        return names(first!, tabs) ? [] : [`"${path}": a run's tabs are ${tabs.join(', ')} (shared/app-places.ts)`];
      }
      if (names(first!, [MENU])) {
        const pages = PROJECT_MENU_PAGES.map((menuPage) => menuPage.label);
        return !second || names(second, pages)
          ? []
          : [`"${path}": the ${MENU} menu opens ${pages.join(', ')} (shared/app-places.ts)`];
      }
      if (names(first!, PROJECT_CONTROLS)) return [];
      const tab: PlaceTab | undefined = PROJECT_TABS.find((projectTab) => names(first!, [projectTab.label]));
      if (!tab) {
        const tabs = PROJECT_TABS.map((projectTab) => projectTab.label);
        return [
          `"${path}": a project's tabs are ${tabs.join(', ')}, and its other pages open from ${MENU} (shared/app-places.ts)`,
        ];
      }
      if (tab.value === 'settings') {
        const sections = PROJECT_SETTINGS_SECTIONS.map((section) => section.label);
        return !second || longestLabel(second, sections)
          ? []
          : [`"${path}": the sections of a project's Settings are ${sections.join(', ')} (shared/app-places.ts)`];
      }
      const views = (tab.views ?? []).map((view) => view.label);
      return !second || views.length === 0 || names(second, views)
        ? []
        : [`"${path}": the views of ${tab.label} are ${views.join(', ')} (shared/app-places.ts)`];
    });

  /** The longest label of `labels` that `rest` starts with, ended at a word boundary. */
  const longestLabel = (rest: string, labels: readonly string[]): string | undefined =>
    labels
      .filter((label) => rest.startsWith(label) && !/^[\p{L}\p{N}]/u.test(rest.slice(label.length)))
      .sort((a, b) => b.length - a.length)[0];

  const settingsProblemsOf = (text: string): string[] =>
    [...text.matchAll(SETTINGS_MARK)].flatMap((match) => {
      const before = text.slice(Math.max(0, match.index - 40), match.index);
      const rest = text
        .slice(match.index + match[0].length, match.index + match[0].length + 80)
        .replace(/\s*\n\s*/g, ' ');
      const path = `Settings → ${rest.slice(0, 40)}`;
      if (!/^[A-Z]/.test(rest)) return [];
      if (/\bProject → $/.test(before)) return [];
      if (/\bproject(?:['’]s)? (?:→ )?$/i.test(before)) {
        return [
          `"${before.trim().split(/\s+/).pop()} ${path}": write a project's Settings path as "Project → Settings → …"`,
        ];
      }
      if (OTHER_SETTINGS_OWNERS.some((owner) => before.endsWith(`${owner} `))) return [];
      if (OTHER_SETTINGS.some((root) => rest.startsWith(root))) return [];
      const pages = SETTINGS_PAGE_PLACES.map((place) => place.label);
      const sections = PROJECT_SETTINGS_SECTIONS.map((section) => section.label);
      const page = longestLabel(rest, pages);
      const section = longestLabel(rest, sections);
      if (section && (!page || section.length > page.length)) {
        return [`"${path}": ${section} is a section of a project's Settings: write "Project → Settings → ${section}"`];
      }
      return page
        ? []
        : [`"${path}": the pages of Settings (SETTINGS_PAGES, shared/settings-metadata.ts) are ${pages.join(', ')}`];
    });

  /** Prose with bold set aside and a "›" path written with "→", the one form the checks read. */
  const normalized = (text: string) => text.replace(/\*\*/g, '').replace(/ › /g, ' → ');

  const problemsOf = (text: string): string[] => {
    const prose = normalized(text);
    return [...tabProblemsOf(prose), ...settingsProblemsOf(prose)];
  };

  test('a path is read to its tab, its view or its menu page', () => {
    expect(problemsOf('**Project → Coverage → Gaps**, then Test run → Changes.')).toEqual([]);
    expect(problemsOf('Project → More actions → Locators')).toEqual([]);
    expect(problemsOf('Project → Timeline')).toHaveLength(1);
    expect(problemsOf('Project → Failures → Gaps')).toHaveLength(1);
    expect(problemsOf('Test run → Failures')).toHaveLength(1);
  });

  test('a path into Settings is read to a page of Settings or a section of a project’s Settings', () => {
    expect(problemsOf('Set it in **Settings → Source control**, then in Project → **Settings** → Members.')).toEqual(
      [],
    );
    expect(
      problemsOf('In **Settings** → **AI**, then Settings › Storage, which Settings → Account takes too.'),
    ).toEqual([]);
    expect(problemsOf('under Settings → Tools → Piwi in a JetBrains IDE')).toEqual([]);
    expect(problemsOf('Appearance & Behavior → System Settings → HTTP Proxy')).toEqual([]);
    expect(problemsOf('In Settings → Repository')).toHaveLength(1);
    expect(problemsOf('Open Settings → System health')).toHaveLength(1);
    expect(problemsOf('Global instructions (Settings → AI diagnosis)')).toHaveLength(1);
    expect(problemsOf('Project → Settings → Repository')).toHaveLength(1);
    expect(problemsOf("the project's Settings → Source control")).toHaveLength(1);
    expect(problemsOf("Set it in the project's **Settings › Coverage**")).toHaveLength(1);
    expect(problemsOf('under project → Settings → Members')).toHaveLength(1);
  });

  const entries = PIWI_FEATURE_GROUPS.flatMap((group) => group.features).map(
    (feature) => [feature.title, feature.where] as const,
  );

  test.each(entries)('the catalog entry "%s" says where it is', (title, where) => {
    expect(
      problemsOf(where),
      `shared/piwi-features.ts, "${title}": name the place by its label, in the form the problem gives`,
    ).toEqual([]);
  });

  test.each(handWrittenPages)('%s names places the dashboard has', (page) => {
    expect(problemsOf(proseOf(page)), `${page}: name the place by its label, in the form the problem gives`).toEqual(
      [],
    );
  });
});
