/**
 * Turn the facts Piwi already holds about a failure into a provider-neutral
 * `IssueDocument`, in the cluster page's reading order: what happened, the most
 * likely cause, the evidence, what to do, the links. Every section degrades
 * independently — a cluster with no diagnosis still yields evidence and a verify
 * command.
 *
 * This half is pure: the server gathers the facts (`server/utils/integrations/
 * documents.ts`) and the demo mirror seeds them, and both render the same body
 * through here, so the two can never drift.
 */
import { doc, type DocNode, type Inline, type IssueDocument } from './document';
import { DEFAULT_LOCALE, formatDate, formatNumber, t, type IssueLocale, type MessageKey } from './messages';
import { en } from './messages/en';
import type { AutomaticFiling } from './automation';
import { filedByLine, openingCommentNodes, type IssueFilingOpts } from './run-issue';
import { prefixedTitle } from './title-prefix';
import {
  describeExpectation,
  describeStepInWords,
  type BugContext,
  type BugEvidence,
} from '@piwitests/core/bug-report';
import { bugPhrases } from '@piwitests/core/bug-phrases';
import type { PiwiSteps } from '@piwitests/core/steps';

/** The include toggles the modal and the per-project policy set. */
export interface IssueBuildOpts extends IssueFilingOpts {
  includeDiagnosis?: boolean;
  includePatch?: boolean;
  includeScreenshot?: boolean;
  includeShareLink?: boolean;
  siteUrl?: string | null;
}

export const DEFAULT_ISSUE_OPTS: Required<
  Pick<IssueBuildOpts, 'includeDiagnosis' | 'includePatch' | 'includeScreenshot' | 'includeShareLink'>
> = {
  includeDiagnosis: true,
  includePatch: true,
  includeScreenshot: false,
  includeShareLink: false,
};

/** One affected test row, as the "What happened" table lists it. */
export interface AffectedTestFact {
  title: string;
  filePath: string | null;
  owner: string | null;
  /** How many times the test failed into the cluster, when known. */
  failures?: number | null;
}

/** One suggested locator replacement, from the fix plan. */
export interface LocatorEditFact {
  filePath: string;
  line: number | null;
  failingLocator: string | null;
  suggestedLocator: string | null;
}

/** An issue that tracked the same kind of failure before. */
export interface RelatedIssueFact {
  key: string;
  url: string;
  title: string | null;
  status: string | null;
}

/** Everything the builder reads; assembled from the DB (or seeded in the demo). */
export interface IssueFacts {
  clusterId: number;
  fingerprint: string;
  /** The ticket title — the AI title, else the deterministic cluster name. */
  title: string;
  /** The latest occurrence's one-line headline, when it adds to the title. */
  headline: string | null;
  errorType: string | null;
  firstSeen: string | null;
  lastSeen: string | null;
  occurrences: number;
  /** Distinct runs it failed in, when known. */
  runs?: number | null;
  affectedTests: AffectedTestFact[];
  /** Affected tests beyond those listed. */
  moreAffectedTests?: number;
  /** The latest occurrence's branch and environment, the fallback when the lists below are empty. */
  branch: string | null;
  environment: string | null;
  /** Distinct branches and environments it failed on, newest first. */
  branches?: string[];
  environments?: string[];
  commit: string | null;

  diagnosisSummary: string | null;
  rootCause: string | null;
  /** The diagnosis category (`app-bug`, `test-bug` …) and confidence, when diagnosed. */
  diagnosisCategory?: string | null;
  diagnosisConfidence?: string | null;
  /** The top clue, shown when there is no diagnosis. */
  clue: string | null;

  errorExcerpt: string | null;
  failingLocator: string | null;

  /** Unified-diff patch from the fix plan. */
  patch: string | null;
  locatorEdits: LocatorEditFact[];
  verifyCommand: string | null;
  reproduceScript: string | null;

  /** Issues that tracked the same kind of failure before. */
  relatedIssues?: RelatedIssueFact[];
  /** Set when a rule filed the issue: what it counted, and where. */
  automatic?: AutomaticFiling | null;

  clusterUrl: string | null;
  executionUrl: string | null;
  runUrl: string | null;
  shareUrl: string | null;
}

/** The finished issue: title, body, and the labels every Piwi issue carries. */
export interface BuiltIssue {
  title: string;
  document: IssueDocument;
  labels: string[];
}

/** `piwi`, `piwi-cluster-<id>`, `piwi-fp-<first 8 hex>` — how dedupe finds it later. */
export function issueLabels(clusterId: number, fingerprint: string): string[] {
  const fp = fingerprint.slice(0, 8);
  return ['piwi', `piwi-cluster-${clusterId}`, `piwi-fp-${fp}`];
}

function code(text: string): Inline {
  return { text, code: true };
}

/** A bold label, the colon inside, the space after it outside: `**Root cause:** …`. */
export function label(text: string): Inline[] {
  return [{ text: `${text}:`, strong: true }, ' '];
}

/** Code spans separated by commas. */
function codeList(values: string[]): Inline[] {
  return values.flatMap((value, i) => (i === 0 ? [code(value)] : [', ', code(value)]));
}

/** Branches and environments as one phrase: `main, release/2.0 (staging)`. */
export function wherePhrase(branches: string[], environments: string[]): string {
  const envs = environments.length ? ` (${environments.join(', ')})` : '';
  return `${branches.join(', ')}${envs}`;
}

/** The sentences opening an issue a rule filed: what it counted, since when, and where. */
export function automaticFilingInlines(locale: IssueLocale, filing: AutomaticFiling): Inline[] {
  const occurrences = t(locale, 'count.occurrences', { count: filing.occurrences });
  const runs = t(locale, 'count.runs', { count: filing.runs });
  const since = filing.firstFailureAt != null ? formatDate(locale, new Date(filing.firstFailureAt)) : null;
  const parts: Inline[] = [
    since
      ? t(locale, 'auto.filed', { occurrences, runs, since })
      : t(locale, 'auto.filed.noDate', { occurrences, runs }),
  ];
  const branches = filing.branches.slice(0, 3);
  const environments = filing.environments.slice(0, 3);
  if (branches.length) parts.push(' ', t(locale, 'auto.countedOn', { where: wherePhrase(branches, environments) }));
  else if (environments.length)
    parts.push(' ', t(locale, 'auto.countedIn', { where: environments.join(', '), count: environments.length }));
  return parts;
}

/** The diagnosis category and confidence in the ticket's language, or null when unknown. */
export function diagnosisCategoryText(
  locale: IssueLocale,
  category: string | null | undefined,
  confidence: string | null | undefined,
): string | null {
  const categoryKey = `category.${category ?? ''}`;
  if (!category || !(categoryKey in en)) return null;
  const name = t(locale, categoryKey as MessageKey);
  const confidenceKey = `confidence.${confidence ?? ''}`;
  return confidence && confidenceKey in en ? `${name} (${t(locale, confidenceKey as MessageKey)})` : name;
}

/** Assemble the document from gathered facts and the include toggles. */
export function buildIssueDocument(facts: IssueFacts, opts: IssueBuildOpts = {}): IssueDocument {
  const o = { ...DEFAULT_ISSUE_OPTS, ...opts };
  const locale = opts.locale ?? DEFAULT_LOCALE;
  const b = doc();

  for (const node of openingCommentNodes(locale, opts.comment)) b.push(node);

  // An issue no person filed says so first, with what made it qualify.
  if (facts.automatic) b.paragraph(...automaticFilingInlines(locale, facts.automatic));

  // What happened. The headline is a deterministic English sentence quoting
  // locators and Playwright terms — data, reproduced verbatim.
  b.heading(2, t(locale, 'section.whatHappened'));
  if (facts.headline) b.paragraph(facts.headline);
  const branches = facts.branches?.length ? facts.branches.slice(0, 5) : facts.branch ? [facts.branch] : [];
  const environments = facts.environments?.length
    ? facts.environments.slice(0, 5)
    : facts.environment
      ? [facts.environment]
      : [];
  const occurrences = formatNumber(locale, facts.occurrences);
  const factRows: [string, Inline[]][] = [
    [t(locale, 'fact.errorType'), facts.errorType ? [facts.errorType] : []],
    [t(locale, 'fact.firstSeen'), facts.firstSeen ? [facts.firstSeen] : []],
    [t(locale, 'fact.lastSeen'), facts.lastSeen ? [facts.lastSeen] : []],
    [
      t(locale, 'fact.occurrences'),
      [facts.runs ? t(locale, 'value.inRuns', { occurrences, count: facts.runs }) : occurrences],
    ],
    [t(locale, 'fact.branches', { count: branches.length }), codeList(branches)],
    [
      t(locale, 'fact.environments', { count: environments.length }),
      environments.length ? [environments.join(', ')] : [],
    ],
    [t(locale, 'fact.commit'), facts.commit ? [code(facts.commit)] : []],
  ];
  b.facts(factRows);
  if (facts.affectedTests.length) {
    const more = facts.moreAffectedTests ?? 0;
    b.heading(3, t(locale, 'section.affectedTests', { count: facts.affectedTests.length + more }));
    // The owner and failure columns appear only when some row has a value.
    const withOwner = facts.affectedTests.some((test) => test.owner);
    const withFailures = facts.affectedTests.some((test) => test.failures != null);
    b.table(
      [
        t(locale, 'table.test'),
        t(locale, 'table.file'),
        ...(withOwner ? [t(locale, 'table.owner')] : []),
        ...(withFailures ? [t(locale, 'table.failures')] : []),
      ],
      facts.affectedTests.map((test) => [
        test.title,
        test.filePath ?? '',
        ...(withOwner ? [test.owner ?? ''] : []),
        ...(withFailures ? [test.failures != null ? formatNumber(locale, test.failures) : ''] : []),
      ]),
    );
    if (more > 0) b.paragraph(t(locale, 'text.moreTests', { count: more }));
  }

  // Most likely. The diagnosis/root cause are model prose used as stored (their
  // language is the AI response-language setting); the clue is deterministic.
  const mostLikely: DocNode[] = [];
  if (o.includeDiagnosis && (facts.diagnosisSummary || facts.rootCause)) {
    if (facts.diagnosisSummary) mostLikely.push({ type: 'paragraph', inlines: [facts.diagnosisSummary] });
    if (facts.rootCause)
      mostLikely.push({ type: 'paragraph', inlines: [...label(t(locale, 'label.rootCause')), facts.rootCause] });
    const category = diagnosisCategoryText(locale, facts.diagnosisCategory, facts.diagnosisConfidence);
    if (category) mostLikely.push({ type: 'paragraph', inlines: [...label(t(locale, 'label.category')), category] });
  } else if (facts.clue) {
    mostLikely.push({ type: 'paragraph', inlines: [facts.clue] });
  }
  if (mostLikely.length) {
    b.heading(2, t(locale, 'section.mostLikely'));
    for (const n of mostLikely) b.push(n);
  }

  // Evidence — the error excerpt and the failing locator, quoted verbatim.
  const hasEvidence = facts.errorExcerpt || facts.failingLocator;
  if (hasEvidence) {
    b.heading(2, t(locale, 'section.evidence'));
    if (facts.errorExcerpt) b.code(facts.errorExcerpt);
    if (facts.failingLocator) b.paragraph(...label(t(locale, 'label.failingLocator')), code(facts.failingLocator));
  }

  // What to do — the patch, locator edit, verify command and reproduce recipe
  // are the team's own code and commands, quoted verbatim.
  const whatToDo: DocNode[] = [];
  if (o.includePatch && facts.patch) whatToDo.push({ type: 'code', language: 'diff', text: facts.patch });
  const locatorItems: Inline[][] = facts.locatorEdits
    .filter((e) => e.suggestedLocator)
    .map((e) => {
      const where = e.line != null ? `${e.filePath}:${e.line}` : e.filePath;
      const parts: Inline[] = [code(where), ' — '];
      if (e.failingLocator) parts.push(code(e.failingLocator), ' → ');
      parts.push(code(e.suggestedLocator ?? ''));
      return parts;
    });
  if (locatorItems.length) whatToDo.push({ type: 'bullets', items: locatorItems });
  if (facts.verifyCommand)
    whatToDo.push(
      { type: 'paragraph', inlines: [{ text: `${t(locale, 'label.verify')}:`, strong: true }] },
      { type: 'code', text: facts.verifyCommand },
    );
  if (facts.reproduceScript)
    whatToDo.push(
      { type: 'paragraph', inlines: [{ text: `${t(locale, 'label.reproduce')}:`, strong: true }] },
      { type: 'code', language: 'bash', text: facts.reproduceScript },
    );
  if (whatToDo.length) {
    b.heading(2, t(locale, 'section.whatToDo'));
    for (const n of whatToDo) b.push(n);
  }

  // Related issues — tickets of the same kind of failure, fixed before.
  if (facts.relatedIssues?.length) {
    b.heading(2, t(locale, 'section.related'));
    b.bullets(
      facts.relatedIssues.map((issue) => {
        const parts: Inline[] = [{ text: issue.key, href: issue.url }];
        if (issue.title) parts.push(` ${issue.title}`);
        if (issue.status) parts.push(` (${issue.status})`);
        parts.push(` — ${t(locale, 'related.fixedBefore')}`);
        return parts;
      }),
    );
  }

  // Links
  const linkItems: Inline[][] = [];
  if (facts.clusterUrl) linkItems.push([{ text: t(locale, 'link.cluster'), href: facts.clusterUrl }]);
  if (facts.executionUrl) linkItems.push([{ text: t(locale, 'link.execution'), href: facts.executionUrl }]);
  if (facts.runUrl) linkItems.push([{ text: t(locale, 'link.run'), href: facts.runUrl }]);
  if (o.includeShareLink && facts.shareUrl) linkItems.push([{ text: t(locale, 'link.share'), href: facts.shareUrl }]);
  if (linkItems.length) {
    b.heading(2, t(locale, 'section.links'));
    b.bullets(linkItems);
  }

  // Trailer — a JQL filter or a human can find every Piwi-filed issue by it.
  b.rule();
  if (!facts.automatic) b.paragraph(filedByLine(locale, opts.filedBy));
  b.paragraph(code(`Piwi-Cluster: ${facts.clusterId}`));

  return b.build();
}

/** The full built issue: title, document, and the standard labels. */
export function buildIssue(facts: IssueFacts, opts: IssueBuildOpts = {}): BuiltIssue {
  return {
    title: prefixedTitle(opts.titlePrefix, facts.title),
    document: buildIssueDocument(facts, opts),
    labels: issueLabels(facts.clusterId, facts.fingerprint),
  };
}

// ---------------------------------------------------------------------------
// Bug reports

/** What the builder reads about a bug report sent from Piwi Picker. */
export interface BugIssueFacts {
  id: number;
  title: string;
  steps: PiwiSteps;
  evidence: BugEvidence;
  context: BugContext;
  /** The language the report was written in (`de`, `pt-BR`), when known. */
  reportLanguage: string | null;
  reportedBy: string | null;
  reportedAt: string | null;
  /** The spec to commit, as the report's page renders it. */
  spec: { path: string; code: string } | null;
  reproductions: Array<{ verdict: string; divergedAt: number | null; origin: string | null; source: string }>;
  /** Why the suite missed it, one line, and the tests that visit the page. */
  missedBy?: { summary: string; tests: Array<{ title: string; filePath: string }> } | null;
  reportUrl: string | null;
}

/** `piwi`, `piwi-bug-<id>` — how a filed report is found again. */
export function bugIssueLabels(id: number): string[] {
  return ['piwi', `piwi-bug-${id}`];
}

/** A phrasebook sentence as inlines: its Markdown code spans become code. */
function phraseInlines(text: string): Inline[] {
  return text
    .split(/(`[^`]*`)/)
    .filter(Boolean)
    .map((part) => (part.length > 1 && part.startsWith('`') && part.endsWith('`') ? code(part.slice(1, -1)) : part));
}

/** A language code by its name in the ticket's language, or the code when the platform has no name for it. */
function languageName(locale: IssueLocale, codeOrTag: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: 'language' }).of(codeOrTag.replace('_', '-')) ?? codeOrTag;
  } catch {
    return codeOrTag;
  }
}

/**
 * The ticket for a bug report, in the ticket's language: the steps and the
 * expectations written again from the steps document with core's phrasebook
 * for that language, Piwi's own parts from the message catalog, and the
 * reporter's own words (the title, the note, the values typed) as they are.
 */
export function buildBugIssueDocument(facts: BugIssueFacts, opts: IssueFilingOpts = {}): IssueDocument {
  const locale = opts.locale ?? DEFAULT_LOCALE;
  const phrases = bugPhrases(locale);
  const b = doc();
  for (const node of openingCommentNodes(locale, opts.comment)) b.push(node);

  b.heading(2, t(locale, 'section.whatHappened'));
  const page =
    facts.context.origin && facts.context.path ? `${facts.context.origin}${facts.context.path}` : facts.context.path;
  b.facts([
    [t(locale, 'fact.page'), page ? [code(page)] : []],
    [t(locale, 'fact.browser'), facts.context.browser ? [facts.context.browser] : []],
    [t(locale, 'fact.reportedBy'), facts.reportedBy ? [facts.reportedBy] : []],
    [t(locale, 'fact.reportedOn'), facts.reportedAt ? [facts.reportedAt] : []],
  ]);
  if (facts.reportLanguage && facts.reportLanguage.split(/[-_]/)[0] !== locale) {
    b.paragraph(t(locale, 'text.reportLanguage', { language: languageName(locale, facts.reportLanguage) }));
  }

  b.heading(2, t(locale, 'section.stepsToReproduce'));
  b.bullets(
    facts.steps.steps.map((step, i) => [
      `${i + 1}. `,
      ...phraseInlines(
        step.action === 'assert' ? describeExpectation(step, phrases) : describeStepInWords(step, phrases),
      ),
    ]),
  );

  const expected = facts.steps.steps.flatMap((step, index) =>
    step.action === 'assert' && step.assertion ? [{ index, step, a: step.assertion }] : [],
  );
  if (expected.length) {
    b.heading(2, t(locale, 'section.expectedActual'));
    for (const { step, a } of expected) {
      b.paragraph(...label(t(locale, 'label.expected')), ...phraseInlines(describeExpectation(step, phrases)));
      if (a.actual != null) b.paragraph(...label(t(locale, 'label.actual')), code(a.actual));
      if (a.note) b.paragraph(...label(t(locale, 'label.note')), a.note);
    }
  }

  const ev = facts.evidence;
  const evidenceItems: Inline[][] = [];
  if (ev.screenshots.length) evidenceItems.push([t(locale, 'evidence.screenshots', { count: ev.screenshots.length })]);
  if (ev.console.length)
    evidenceItems.push([t(locale, 'evidence.console', { count: ev.console.length + ev.consoleDropped })]);
  if (ev.requests.length) {
    evidenceItems.push([t(locale, 'evidence.requests', { count: ev.requests.length + ev.requestsDropped })]);
    for (const r of ev.requests.slice(0, 5)) evidenceItems.push([code(`${r.method} ${r.url} → ${r.status || '—'}`)]);
  }
  if (evidenceItems.length || ev.console.length) {
    b.heading(2, t(locale, 'section.evidence'));
    if (evidenceItems.length) b.bullets(evidenceItems);
    const messages = ev.console.slice(0, 5).map((c) => c.message);
    if (messages.length) b.code(messages.join('\n'));
  }

  if (facts.spec) {
    b.heading(2, t(locale, 'section.failingTest'));
    b.paragraph(t(locale, 'text.failingTest', { path: facts.spec.path }));
    b.code(facts.spec.code, 'typescript');
  }

  if (facts.reproductions.length) {
    b.heading(2, t(locale, 'section.reproductions'));
    b.bullets(
      facts.reproductions.map((r) => {
        const verdict =
          r.verdict === 'reproduced'
            ? t(locale, 'verdict.reproduced')
            : r.verdict === 'not-reproduced'
              ? t(locale, 'verdict.notReproduced')
              : t(locale, 'verdict.diverged', { step: (r.divergedAt ?? 0) + 1 });
        const how = t(locale, r.source === 'desktop' ? 'reproduction.desktop' : 'reproduction.replay');
        return [`${verdict}${r.origin ? ` — ${r.origin}` : ''} (${how})`];
      }),
    );
  }

  if (facts.missedBy) {
    b.heading(2, t(locale, 'section.missedBy'));
    b.paragraph(facts.missedBy.summary);
    if (facts.missedBy.tests.length)
      b.table(
        [t(locale, 'table.test'), t(locale, 'table.file')],
        facts.missedBy.tests.slice(0, 10).map((test) => [test.title, test.filePath]),
      );
  }

  if (facts.reportUrl) {
    b.heading(2, t(locale, 'section.links'));
    b.bullets([[{ text: t(locale, 'link.bugReport'), href: facts.reportUrl }]]);
  }

  b.rule();
  b.paragraph(filedByLine(locale, opts.filedBy));
  b.paragraph(code(`Piwi-Bug: ${facts.id}`));
  return b.build();
}

export function buildBugIssue(facts: BugIssueFacts, opts: IssueFilingOpts = {}): BuiltIssue {
  return {
    title: prefixedTitle(opts.titlePrefix, facts.title),
    document: buildBugIssueDocument(facts, opts),
    labels: bugIssueLabels(facts.id),
  };
}
