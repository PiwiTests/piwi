/**
 * Microsoft Teams messages: an Adaptive Card posted to an incoming webhook
 * (a Teams channel's Workflows "Post to a channel when a webhook request is
 * received", or a legacy connector URL, which take the same body). One card
 * per notification event, one per digest and one per quality report. Every
 * run-derived string is markdown-escaped, since card text renders markdown.
 */
import {
  notificationTargetPath,
  renderEventSubject,
  type BugLooksFixedPayload,
  type ClusterFixedPayload,
  type ClusterNewPayload,
  type ClusterRegressedPayload,
  type DiagnosisCompletedPayload,
  type FailureSource,
  type NotificationEvent,
  type NotificationPayload,
  type RunFinishedPayload,
  type TopFailure,
} from '#shared/notification-events';
import {
  DIGEST_ITEMS_LIMIT,
  DashboardLinks,
  INCIDENT_NOTE,
  codeRows,
  codeRowsText,
  errorLines,
  eventActions,
  eventFacts,
  eventHeadline,
  eventSentences,
  digestRun,
  eventTone,
  failingTests,
  failureHeadline,
  failureMeta,
  historyLabel,
  historySentence,
  historySquares,
  moreFailures,
  outcomeSquares,
  percent,
  plural,
  runSegments,
  sourceIsTestFile,
  testHistorySquares,
  testLocation,
  type ErrorLineKind,
  type EventHeadline,
  type Fact,
  type Tone,
} from '#shared/notifications/message-parts';
import type { StatusColorKey } from '#shared/status-colors';
import { languageForPath } from '#shared/highlight';
import { durationShort } from '#shared/relative-time';
import { safeHttpUrl } from '#shared/utils/safe-url';
import { sparkline } from '#shared/reports/chart';
import { sentencesFor } from '#shared/reports/sentences';
import { reportWidgets, type ReportBundle } from '#shared/reports/types';
import type { DigestItem } from '../email';
import { emailTrendBlock } from '#shared/reports/render-email';

const TEXT_MAX = 600;

type Element = Record<string, unknown>;

/** Markdown-escape run-derived text, so a test title cannot turn into a link or a heading. */
export function teamsEscape(text: string): string {
  return text
    .replace(/[\\`*_[\]()#<>~|]/g, (ch) => `\\${ch}`)
    .replace(/^(\s*)([-+])(?=\s|$)/gm, '$1\\$2')
    .replace(/^(\s*\d+)\.(?=\s|$)/gm, '$1\\.');
}

const clip = (text: string, max = TEXT_MAX) => (text.length > max ? `${text.slice(0, max)}…` : text);

/**
 * A markdown link, its label escaped and the characters that would end its
 * address encoded; the label alone for an address that is not http(s).
 */
export function teamsLink(label: string, url: string): string {
  if (!safeHttpUrl(url)) return teamsEscape(label);
  const href = new URL(url).href.replace(/[()\\]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  return `[${teamsEscape(label)}](${href})`;
}

function textBlock(text: string, extra: Element = {}): Element {
  return { type: 'TextBlock', text, wrap: true, ...extra };
}

/** The webhook body: one Adaptive Card as a message attachment. */
export function teamsMessage(body: Element[], actions: Array<{ title: string; url: string }> = []): Element {
  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: null,
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          msteams: { width: 'Full' },
          body,
          ...(actions.length > 0
            ? { actions: actions.map((a) => ({ type: 'Action.OpenUrl', title: a.title, url: a.url })) }
            : {}),
        },
      },
    ],
  };
}

/** The container style and the text color of each tone. */
const TONE_STYLES: Record<Tone, { style: string; color: string }> = {
  failed: { style: 'attention', color: 'Attention' },
  passed: { style: 'good', color: 'Good' },
  warning: { style: 'warning', color: 'Warning' },
  flaky: { style: 'accent', color: 'Accent' },
  brand: { style: 'accent', color: 'Accent' },
};

/** The color of each outcome in a Teams chart. */
const CHART_COLORS: Record<StatusColorKey, string> = {
  passed: 'good',
  failed: 'attention',
  flaky: 'categoricalPurple',
  skipped: 'neutral',
  fixme: 'neutral',
  didnotrun: 'warning',
  running: 'categoricalBlue',
};

/** The code languages a Teams `CodeBlock` colors, by the name `languageForPath` gives. */
const CODE_LANGUAGES: Record<string, string> = {
  typescript: 'TypeScript',
  javascript: 'JavaScript',
  python: 'Python',
  csharp: 'C#',
  css: 'CSS',
  json: 'JSON',
  xml: 'XML',
  bash: 'Bash',
  powershell: 'PowerShell',
};

/** The headline, its figure set large in the tone's color, on a band of that tone. */
function bannerContainer(h: EventHeadline): Element {
  const tone = TONE_STYLES[h.tone];
  const inlines: Element[] = [];
  if (h.lead) inlines.push({ type: 'TextRun', text: h.lead, size: 'Large', weight: 'Bolder' });
  if (h.figure)
    inlines.push({ type: 'TextRun', text: h.figure, size: 'ExtraLarge', weight: 'Bolder', color: tone.color });
  if (h.rest) inlines.push({ type: 'TextRun', text: h.rest, size: 'Large', weight: 'Bolder' });
  return {
    type: 'Container',
    style: tone.style,
    bleed: true,
    items: [
      textBlock(teamsEscape(h.label), { size: 'Small', weight: 'Bolder', isSubtle: true }),
      { type: 'RichTextBlock', inlines, spacing: 'Small' },
      ...(h.details.length
        ? [textBlock(teamsEscape(h.details.join(' · ')), { isSubtle: true, spacing: 'Small' })]
        : []),
    ],
  };
}

/** A run's tests by outcome as a stacked bar chart, squares and counts where the client draws no chart. */
function outcomeElements(p: RunFinishedPayload): Element[] {
  const segments = runSegments(p);
  if (p.totalTests <= 0 || segments.length === 0) return [];
  const legend = segments
    .map((s) => `**${s.count}** ${teamsEscape(s.label)} ${percent(s.count, p.totalTests)}`)
    .join('   ');
  return [
    {
      type: 'Chart.HorizontalBar.Stacked',
      data: [
        {
          title: 'Tests',
          data: segments.map((s) => ({ legend: s.label, value: s.count, color: CHART_COLORS[s.key] })),
        },
      ],
      fallback: textBlock(`${outcomeSquares(segments, p.totalTests)}\n\n${legend}`),
    },
  ];
}

function historyElements(p: RunFinishedPayload): Element[] {
  if (!p.history || p.history.length < 2) return [];
  const sentence = historySentence(p.history);
  return [
    textBlock(teamsEscape(`${historyLabel(p.history, p)}, oldest first`), { isSubtle: true, size: 'Small' }),
    textBlock(`${historySquares(p.history)}${sentence ? `   **${teamsEscape(sentence)}**` : ''}`, { spacing: 'Small' }),
  ];
}

const ERROR_COLORS: Record<ErrorLineKind, Element> = {
  head: { weight: 'Bolder' },
  expected: { color: 'Good' },
  received: { color: 'Attention' },
  body: {},
};

/** A Playwright error, one line per block, the expected value green and the received one red. */
function errorElements(excerpt: string): Element[] {
  return errorLines(excerpt)
    .filter((line) => line.text.trim())
    .map((line, i) =>
      textBlock(teamsEscape(clip(line.text)), {
        fontType: 'Monospace',
        size: 'Small',
        spacing: i === 0 ? 'Small' : 'None',
        ...ERROR_COLORS[line.kind],
      }),
    );
}

/**
 * Lines of code as monospace blocks, one per line. Markdown folds runs of
 * spaces, so a leading space and every run of two or more are no-break spaces:
 * the indentation stays, and a long line still wraps between words.
 */
function codeLinesContainer(text: string): Element {
  return {
    type: 'Container',
    spacing: 'Small',
    items: text.split('\n').map((line) =>
      textBlock(teamsEscape(line).replace(/^ +| {2,}/g, (run) => '\u00a0'.repeat(run.length)) || '\u00a0', {
        fontType: 'Monospace',
        size: 'Small',
        spacing: 'None',
      }),
    ),
  };
}

/**
 * The code a failure threw at: a `CodeBlock` Teams colors, numbered lines
 * where the client has none. The file is named when it is not the test's own.
 */
function codeElements(source: FailureSource, testFile: string | undefined): Element[] {
  const rows = codeRows(source);
  if (rows.length === 0) return [];
  const language = CODE_LANGUAGES[languageForPath(source.file) ?? ''] ?? 'PlainText';
  const where = sourceIsTestFile({ source, filePath: testFile })
    ? `Failed at line ${source.line}`
    : `${source.file}:${source.line}`;
  return [
    textBlock(teamsEscape(where), { fontType: 'Monospace', size: 'Small', isSubtle: true }),
    {
      type: 'CodeBlock',
      codeSnippet: rows.map((row) => row.code).join('\n'),
      language,
      startLineNumber: rows[0]!.line,
      spacing: 'Small',
      fallback: codeLinesContainer(codeRowsText(rows)),
    },
  ];
}

/** One failing test: who and where, what it says, the code it threw at, the error, its own history. */
function failureContainer(f: TopFailure, url: string): Element {
  const { isNew, story, labels } = failureMeta(f);
  const meta = [...(isNew ? ['🆕 **New failure**'] : []), ...labels.map(teamsEscape)].join(' · ');
  const location = testLocation(f);
  const headline = failureHeadline(f);
  return {
    type: 'Container',
    separator: true,
    spacing: 'Medium',
    selectAction: { type: 'Action.OpenUrl', url },
    items: [
      ...(meta ? [textBlock(meta, { size: 'Small', isSubtle: true })] : []),
      ...(f.suitePath?.length
        ? [textBlock(`${teamsEscape(f.suitePath.join(' › '))} ›`, { size: 'Small', isSubtle: true, spacing: 'Small' })]
        : []),
      textBlock(`**${teamsLink(f.title, url)}**`, { spacing: 'None' }),
      ...(location
        ? [textBlock(teamsEscape(location), { fontType: 'Monospace', size: 'Small', isSubtle: true, spacing: 'None' })]
        : []),
      ...(headline ? [textBlock(teamsEscape(clip(headline)))] : []),
      ...(f.source ? codeElements(f.source, f.filePath) : []),
      ...(f.errorExcerpt ? errorElements(f.errorExcerpt) : []),
      ...(f.history && f.history.length > 1
        ? [textBlock(`${testHistorySquares(f.history)}   ${story ? teamsEscape(story) : ''}`, { size: 'Small' })]
        : []),
    ],
  };
}

function failureElements(p: RunFinishedPayload, links: DashboardLinks): Element[] {
  const failures = p.topFailures ?? [];
  if (failures.length === 0) return [];
  const more = moreFailures(p);
  return [
    textBlock(`**What failed**${more > 0 ? ` ${failures.length} of ${failingTests(p)}` : ''}`, {
      size: 'Medium',
      spacing: 'Large',
    }),
    ...failures.map((f) => failureContainer(f, links.failure(f, p.runId))),
    ...(more > 0
      ? [
          textBlock(teamsLink(`${plural(more, 'more failing test')} in the run`, links.run(p.runId)), {
            separator: true,
          }),
        ]
      : []),
  ];
}

function factSet(facts: Fact[]): Element[] {
  if (facts.length === 0) return [];
  return [
    {
      type: 'FactSet',
      spacing: 'Medium',
      facts: facts.map((f) => {
        const value = f.url ? teamsLink(f.value, f.url) : teamsEscape(f.value);
        return { title: teamsEscape(f.label), value: `${value}${f.note ? ` ${teamsEscape(f.note)}` : ''}` };
      }),
    },
  ];
}

/** What only this kind of event shows, between its sentences and its facts. */
function detailElements(event: NotificationEvent, payload: NotificationPayload, links: DashboardLinks): Element[] {
  switch (event) {
    case 'run.finished':
    case 'run.failed':
    case 'run.failed.default_branch':
    case 'run.interrupted':
    case 'flakiness.spike': {
      const p = payload as RunFinishedPayload;
      return [...outcomeElements(p), ...historyElements(p)];
    }
    case 'perf.regression': {
      const p = payload as RunFinishedPayload;
      const durations =
        p.durationMs != null && p.baselineDurationMs != null
          ? [
              {
                type: 'FactSet',
                facts: [
                  { title: 'Usual', value: durationShort(p.baselineDurationMs) },
                  { title: 'This run', value: durationShort(p.durationMs) },
                ],
              },
            ]
          : [];
      return [...durations, ...outcomeElements(p), ...historyElements(p)];
    }
    case 'cluster.new':
    case 'cluster.fixed':
    case 'cluster.regressed': {
      const p = payload as ClusterNewPayload | ClusterFixedPayload | ClusterRegressedPayload;
      const sample = (p as ClusterNewPayload).sampleErrorExcerpt;
      return [
        textBlock(teamsEscape(clip(p.signature)), { fontType: 'Monospace', size: 'Small' }),
        ...(sample ? errorElements(sample) : []),
      ];
    }
    case 'diagnosis.completed': {
      const p = payload as DiagnosisCompletedPayload;
      return [
        ...(p.summary ? [textBlock(teamsEscape(clip(p.summary)))] : []),
        ...(p.rootCause ? [textBlock(`**Root cause**\n\n${teamsEscape(clip(p.rootCause))}`)] : []),
      ];
    }
    case 'bug.looks_fixed': {
      const p = payload as BugLooksFixedPayload;
      const more = p.tests.length - DIGEST_ITEMS_LIMIT;
      const tests = p.tests.slice(0, DIGEST_ITEMS_LIMIT).map((t) => {
        const refs = [
          t.bugId ? teamsLink(`Bug #${t.bugId}`, links.bugReport(t.bugId)) : '',
          t.link ? teamsLink('ticket', t.link) : '',
        ].filter(Boolean);
        return textBlock(
          `✅ **${teamsLink(t.title, links.execution(t.executionId))}**\n\n${teamsEscape(t.filePath)}${refs.length ? ` · ${refs.join(' · ')}` : ''}`,
          { separator: true },
        );
      });
      return more > 0 ? [...tests, textBlock(`…and ${more} more`, { isSubtle: true })] : tests;
    }
    case 'environment.incident':
    case 'auto_heal.pr_opened':
    case 'test.stuck':
      return [];
  }
}

/** One notification event as a card: its headline on a band of its tone, what it shows, its facts, its buttons. */
export function teamsEventMessage(event: NotificationEvent, payload: NotificationPayload, base: string): Element {
  const links = new DashboardLinks(base);
  const sentences = eventSentences(event, payload).map((s) =>
    textBlock(teamsEscape(s), s === INCIDENT_NOTE ? { isSubtle: true, size: 'Small' } : {}),
  );
  const body: Element[] = [
    bannerContainer(eventHeadline(event, payload)),
    ...sentences,
    ...detailElements(event, payload, links),
    ...factSet(eventFacts(event, payload, links)),
    ...(event.startsWith('run.') ? failureElements(payload as RunFinishedPayload, links) : []),
  ];
  return teamsMessage(
    body,
    eventActions(event, payload, links).map((a) => ({ title: a.label, url: a.url })),
  );
}

const TONE_DOTS: Record<Tone, string> = {
  failed: '🔴',
  passed: '🟢',
  warning: '🟠',
  flaky: '🟣',
  brand: '🔷',
};

/** A digest as one card: a line per notification, linked where it has a page, with each run's bar of squares. */
export function teamsDigestMessage(items: DigestItem[], base: string): Element {
  const links = new DashboardLinks(base);
  const failing = items.filter(({ event, payload }) => eventTone(event, payload) === 'failed').length;
  const header = `Piwi digest: ${plural(items.length, 'notification')}`;
  const rows = items.slice(0, DIGEST_ITEMS_LIMIT).map(({ event, payload }, i) => {
    const subject = renderEventSubject(event, payload);
    const path = notificationTargetPath(event, payload);
    const run = digestRun(event, payload);
    const squares = run ? `\n\n${outcomeSquares(runSegments(run), run.totalTests)}` : '';
    return textBlock(
      `${TONE_DOTS[eventTone(event, payload)]} ${path ? teamsLink(subject, links.path(path)) : teamsEscape(subject)}${squares}`,
      { separator: i > 0 },
    );
  });
  if (items.length > DIGEST_ITEMS_LIMIT) {
    rows.push(textBlock(`…and ${items.length - DIGEST_ITEMS_LIMIT} more`, { isSubtle: true }));
  }
  return teamsMessage([
    {
      type: 'Container',
      style: failing > 0 ? 'attention' : 'accent',
      bleed: true,
      items: [
        textBlock(header, { weight: 'Bolder', size: 'Large' }),
        textBlock(
          `Everything your digest subscriptions collected since the last one${failing > 0 ? ` · **${failing} need${failing === 1 ? 's' : ''} attention**` : ''}`,
          { isSubtle: true, spacing: 'Small' },
        ),
      ],
    },
    ...rows,
  ]);
}

/**
 * A quality report as a card: the verdict, the tiles as facts, the trend
 * (an image through the share link when there is one, else a text
 * sparkline), what changed, and buttons to the snapshot and the share link.
 */
export function teamsReportMessage(bundle: ReportBundle, url: string, shareUrl: string | null = null): Element {
  const s = sentencesFor(bundle.language);
  const widgets = reportWidgets(bundle);
  const body: Element[] = [
    textBlock(teamsEscape(bundle.title), { weight: 'Bolder', size: 'Large' }),
    textBlock(teamsEscape(bundle.period.label), { isSubtle: true, spacing: 'None' }),
    textBlock(teamsEscape(bundle.verdict.sentence)),
  ];
  const tiles = widgets.flatMap((w) => w.blocks).find((b) => b.kind === 'stats');
  if (tiles && tiles.kind === 'stats' && tiles.tiles.length > 0) {
    body.push({
      type: 'FactSet',
      facts: tiles.tiles.slice(0, 10).map((t) => ({
        title: teamsEscape(t.label),
        value: teamsEscape(`${t.value}${t.change ? ` (${t.change})` : ''}`),
      })),
    });
  }
  const trend = emailTrendBlock(bundle);
  const line = trend?.series[0];
  if (trend && line) {
    body.push(textBlock(teamsEscape(trend.summary ?? line.label), { isSubtle: true }));
    if (shareUrl)
      body.push({ type: 'Image', url: `${shareUrl}/chart.png`, altText: clip(trend.summary ?? line.label) });
    else {
      const spark = sparkline(line.points);
      if (spark) body.push(textBlock(spark, { fontType: 'Monospace', spacing: 'None' }));
    }
  }
  const changes = widgets.find((w) => w.type === 'insights')?.blocks.find((b) => b.kind === 'list');
  if (changes && changes.kind === 'list' && changes.items.length > 0) {
    body.push(
      textBlock(
        changes.items
          .slice(0, 6)
          .map((i) => `- ${teamsEscape(i.text)}`)
          .join('\n'),
      ),
    );
  }
  const actions = [{ title: s.labels.openInPiwi, url }];
  if (shareUrl) actions.push({ title: s.labels.readWithoutAccount, url: shareUrl });
  return teamsMessage(body, actions);
}
