/**
 * The issue a person files for a whole run, or for one execution that belongs to
 * no failure cluster, and the comment block every issue a person files can open
 * with. Pure: the server and the demo gather the facts
 * (`server/utils/integrations/documents.ts`) and render the same body here.
 */
import { doc, type DocNode, type Inline, type IssueDocument } from './document';
import { DEFAULT_LOCALE, formatNumber, t, type IssueLocale, type MessageKey } from './messages';
import type { BuiltIssue } from './build-issue';

/** The longest comment a person may write on an issue. */
export const MAX_ISSUE_COMMENT_LENGTH = 5000;

/** Whether `value` is a submission id the create route takes: a UUID, as zod's `uuid()` reads one. */
export function isSubmissionId(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

/** What a person wrote when filing, and who they are (null with authentication off). */
export interface IssueComment {
  text: string;
  author: string | null;
}

/** The comment's text, trimmed and cut to its limit, or null when nothing is left. */
export function normalizeIssueComment(text: string | null | undefined): string | null {
  const trimmed = (text ?? '').trim();
  return trimmed ? trimmed.slice(0, MAX_ISSUE_COMMENT_LENGTH) : null;
}

/**
 * The comment block: a heading naming the person, then one paragraph per line
 * they wrote. Empty for no comment.
 */
export function commentNodes(locale: IssueLocale, comment: IssueComment | null | undefined): DocNode[] {
  const text = normalizeIssueComment(comment?.text);
  if (!text) return [];
  const heading = comment?.author
    ? t(locale, 'section.commentFrom', { name: comment.author })
    : t(locale, 'section.comment');
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return [
    { type: 'heading', level: 2, text: heading },
    ...lines.map((line): DocNode => ({ type: 'paragraph', inlines: [line] })),
  ];
}

/** A document with the comment block first. */
export function withComment(document: IssueDocument, locale: IssueLocale, comment: IssueComment | null | undefined) {
  const nodes = commentNodes(locale, comment);
  return nodes.length ? { nodes: [...nodes, ...document.nodes] } : document;
}

/** A test's result as the issue names it. */
export type RunTestResult = 'passed' | 'failed' | 'timedOut' | 'flaky' | 'skipped' | 'interrupted' | 'didNotRun';

export interface RunTestFact {
  title: string;
  filePath: string | null;
  line: number | null;
  project: string | null;
  result: RunTestResult;
  url: string | null;
  /** The first lines of its error, for the issue of one execution. */
  errorExcerpt?: string | null;
}

export interface RunClusterFact {
  id: number;
  title: string;
  url: string | null;
  /** The issue already tracking the cluster, when it has one. */
  issueKey: string | null;
  issueUrl: string | null;
}

export interface RunIssueFacts {
  runId: number;
  projectName: string;
  branch: string | null;
  commit: string | null;
  environment: string | null;
  startedAt: string | null;
  counts: { total: number; passed: number; failed: number; flaky: number; skipped: number };
  /** The tests listed, failed first; the rest are counted in `moreTests`. */
  tests: RunTestFact[];
  moreTests: number;
  /** The clusters listed, those with the most failed tests first; the rest are counted in `moreClusters`. */
  clusters: RunClusterFact[];
  moreClusters?: number;
  runUrl: string | null;
  /** Set for the issue of one execution: the link to it. */
  executionUrl?: string | null;
  /** Who filed it from Piwi, when known. */
  filedBy: string | null;
}

/** How many tests a run's issue lists before it counts the rest. */
export const RUN_ISSUE_MAX_TESTS = 25;

/** How many failure clusters a run's issue lists before it counts the rest. */
export const RUN_ISSUE_MAX_CLUSTERS = 10;

const RESULT_ORDER: Record<RunTestResult, number> = {
  failed: 0,
  timedOut: 1,
  interrupted: 2,
  flaky: 3,
  didNotRun: 4,
  passed: 5,
  skipped: 6,
};

/** The tests an issue lists: failed first, then in their order, cut to {@link RUN_ISSUE_MAX_TESTS}. */
export function listedRunTests(tests: RunTestFact[]): { tests: RunTestFact[]; moreTests: number } {
  const ordered = tests
    .map((test, i) => ({ test, i }))
    .sort((a, b) => RESULT_ORDER[a.test.result] - RESULT_ORDER[b.test.result] || a.i - b.i)
    .map(({ test }) => test);
  return {
    tests: ordered.slice(0, RUN_ISSUE_MAX_TESTS),
    moreTests: Math.max(0, ordered.length - RUN_ISSUE_MAX_TESTS),
  };
}

function code(text: string): Inline {
  return { text, code: true };
}

function location(test: RunTestFact): string {
  if (!test.filePath) return '';
  return test.line ? `${test.filePath}:${test.line}` : test.filePath;
}

/** The title Piwi proposes for a run's issue: `Run #4213: 3 of 12 failed on main`. */
export function runIssueTitle(locale: IssueLocale, facts: RunIssueFacts): string {
  let title = t(locale, 'title.run', { id: facts.runId });
  if (facts.counts.failed > 0) {
    title += `: ${t(locale, 'title.failedOf', { failed: facts.counts.failed, total: facts.counts.total })}`;
  }
  if (facts.branch) title += ` ${t(locale, 'title.onBranch', { branch: facts.branch })}`;
  return title;
}

/** `piwi`, `piwi-run-<id>`: how the issues filed for a run are found again. */
export function runIssueLabels(runId: number): string[] {
  return ['piwi', `piwi-run-${runId}`];
}

/** The body of a run's issue, or of one execution's when `executionUrl` is set. */
export function buildRunIssueDocument(
  facts: RunIssueFacts,
  opts: { locale?: IssueLocale; comment?: IssueComment | null } = {},
): IssueDocument {
  const locale = opts.locale ?? DEFAULT_LOCALE;
  const b = doc();
  for (const node of commentNodes(locale, opts.comment)) b.push(node);

  b.heading(2, t(locale, 'section.theRun'));
  const n = (value: number) => formatNumber(locale, value);
  b.facts([
    [t(locale, 'fact.project'), [facts.projectName]],
    [t(locale, 'fact.branch'), facts.branch ? [code(facts.branch)] : []],
    [t(locale, 'fact.commit.run'), facts.commit ? [code(facts.commit)] : []],
    [t(locale, 'fact.environment'), facts.environment ? [facts.environment] : []],
    [t(locale, 'fact.startedAt'), facts.startedAt ? [facts.startedAt] : []],
    [
      t(locale, 'fact.results'),
      [
        t(locale, 'value.runResults', {
          total: n(facts.counts.total),
          passed: n(facts.counts.passed),
          failed: n(facts.counts.failed),
          flaky: n(facts.counts.flaky),
          skipped: n(facts.counts.skipped),
        }),
      ],
    ],
  ]);

  if (facts.tests.length) {
    b.heading(3, t(locale, 'section.tests', { count: facts.tests.length + facts.moreTests }));
    const withProject = facts.tests.some((test) => test.project);
    b.table(
      [
        t(locale, 'table.test'),
        t(locale, 'table.file'),
        ...(withProject ? [t(locale, 'table.project')] : []),
        t(locale, 'table.result'),
      ],
      facts.tests.map((test) => [
        test.title,
        location(test),
        ...(withProject ? [test.project ?? ''] : []),
        t(locale, `result.${test.result}` as MessageKey),
      ]),
    );
    if (facts.moreTests > 0) b.paragraph(t(locale, 'text.moreTests', { count: facts.moreTests }));
    const excerpt = facts.executionUrl ? facts.tests[0]?.errorExcerpt : null;
    if (excerpt) b.code(excerpt);
  }

  if (facts.clusters.length) {
    const moreClusters = facts.moreClusters ?? 0;
    b.heading(3, t(locale, 'section.failureClusters', { count: facts.clusters.length + moreClusters }));
    b.bullets(
      facts.clusters.map((cluster) => {
        const parts: Inline[] = [cluster.url ? { text: cluster.title, href: cluster.url } : cluster.title];
        if (cluster.issueKey) {
          parts.push(' — ', cluster.issueUrl ? { text: cluster.issueKey, href: cluster.issueUrl } : cluster.issueKey);
        }
        return parts;
      }),
    );
    if (moreClusters > 0) b.paragraph(t(locale, 'text.moreClusters', { count: moreClusters }));
  }

  const links: Inline[][] = [];
  if (facts.executionUrl) links.push([{ text: t(locale, 'link.thisExecution'), href: facts.executionUrl }]);
  if (facts.runUrl) links.push([{ text: t(locale, 'link.run'), href: facts.runUrl }]);
  if (links.length) {
    b.heading(2, t(locale, 'section.links'));
    b.bullets(links);
  }

  b.rule();
  b.paragraph(facts.filedBy ? t(locale, 'text.filedBy', { name: facts.filedBy }) : t(locale, 'text.filedFromPiwi'));
  b.paragraph(code(`Piwi-Run: ${facts.runId}`));
  return b.build();
}

/** The built issue of a run: its proposed title, body and labels. */
export function buildRunIssue(
  facts: RunIssueFacts,
  opts: { locale?: IssueLocale; comment?: IssueComment | null; title?: string } = {},
): BuiltIssue {
  const locale = opts.locale ?? DEFAULT_LOCALE;
  return {
    title: opts.title ?? runIssueTitle(locale, facts),
    document: buildRunIssueDocument(facts, opts),
    labels: runIssueLabels(facts.runId),
  };
}
