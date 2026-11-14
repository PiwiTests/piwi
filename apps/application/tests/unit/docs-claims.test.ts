import { describe, test, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { isGeneratedDocsPage } from '#shared/docs-generated-pages';
import { MAX_CONTROLS_PER_PAGE } from '#shared/graph';
import { exposureFactorsFor, type DetectedGap } from '#shared/handlers/scenario-gaps';
import { PIWI_ENV_VARS, type PiwiEnvVarMeta } from '#shared/piwi-env-vars';
import { COVERAGE_VIEWS } from '~/utils/coverage-tab';
import { actionTitle, EDITOR_ACTIONS } from '../../../../packages/editor/src/actions';
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

/** What a reader reads of a page: no front matter, no code block, no inline code. */
const proseOf = (page: string) =>
  read(page).replace(FRONT_MATTER, '').replace(FENCED_CODE, ' ').replace(INLINE_CODE, ' ');

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
      list: 'COVERAGE_VIEWS (app/utils/coverage-tab.ts)',
      count: () => COVERAGE_VIEWS.length,
    },
    {
      page: 'apps/docs/features/ui-overview.md',
      phrase: 'three views',
      list: 'COVERAGE_VIEWS (app/utils/coverage-tab.ts)',
      count: () => COVERAGE_VIEWS.length,
    },
    {
      page: 'apps/docs/guide/concepts.md',
      phrase: 'four factors',
      list: 'the factors of exposureFactorsFor (shared/handlers/scenario-gaps.ts)',
      count: exposureFactors,
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

  test.each(handWrittenPages)('%s quotes only commands the editors have', (page) => {
    const quoted = [
      ...read(page)
        .replace(FRONT_MATTER, '')
        .replace(FENCED_CODE, ' ')
        .matchAll(/\*\*Piwi: ([^*]+)\*\*/g),
    ].map((m) => normalize(m[1]!));
    expect(
      quoted.filter((title) => !titles.has(title)),
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
  ];

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
