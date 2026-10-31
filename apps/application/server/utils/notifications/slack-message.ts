/**
 * Slack messages for notification events and digests, in Block Kit: the
 * headline as the message's own blocks, the rest in an attachment whose side
 * stripe carries the event's tone. Every interpolated value goes through
 * `slackEscape` or `slackLink`, so a test title cannot mention a channel or
 * hide a link.
 */
import { STATUS_COLORS } from '#shared/status-colors';
import { BRAND_VIOLET } from '#shared/brand';
import { durationShort } from '#shared/relative-time';
import {
  notificationTargetPath,
  renderEventSubject,
  type BugLooksFixedPayload,
  type ClusterFixedPayload,
  type ClusterNewPayload,
  type ClusterRegressedPayload,
  type DiagnosisCompletedPayload,
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
  eventActions,
  eventFacts,
  eventHeadline,
  eventSentences,
  digestRun,
  eventTone,
  failingTests,
  failureHeadline,
  failureMeta,
  headlineText,
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
  type Fact,
  type Tone,
} from '#shared/notifications/message-parts';
import type { DigestItem } from '#shared/notifications/render-email';
import { slackEscape, slackLink } from './slack';

type Block = Record<string, unknown>;

/** Slack's limits: characters in a section's text, in a header, and fields in a section. */
const SECTION_MAX = 2900;
const HEADER_MAX = 150;
const FIELDS_MAX = 10;
/** The longest raw text a code block or a paragraph quotes, leaving room for its escaping and fences. */
const QUOTE_MAX = 2000;

/** The side stripe of each tone. */
const TONE_COLORS: Record<Tone, string> = {
  failed: STATUS_COLORS.failed.fill,
  passed: STATUS_COLORS.passed.fill,
  warning: STATUS_COLORS.didnotrun.fill,
  flaky: STATUS_COLORS.flaky.fill,
  brand: BRAND_VIOLET,
};

/** The emoji before an event's headline. */
function eventEmoji(event: NotificationEvent, tone: Tone): string {
  switch (event) {
    case 'cluster.new':
      return ':bug:';
    case 'cluster.regressed':
      return ':rotating_light:';
    case 'flakiness.spike':
      return ':game_die:';
    case 'perf.regression':
      return ':snail:';
    case 'environment.incident':
      return ':construction:';
    case 'test.stuck':
      return ':hourglass_flowing_sand:';
    case 'diagnosis.completed':
      return ':mag:';
    case 'auto_heal.pr_opened':
      return ':adhesive_bandage:';
    default:
      return tone === 'failed' ? ':x:' : tone === 'passed' ? ':white_check_mark:' : ':warning:';
  }
}

/** At most `max` characters, the last an ellipsis when cut, never splitting a character in two. */
function clip(text: string, max = SECTION_MAX): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text;
}

/**
 * mrkdwn with Slack's automatic parsing off: a plain `@channel` or a bare
 * address in a test title stays text, and only the message's own `<…>` links
 * and formatting apply.
 */
function mrkdwn(text: string): Block {
  return { type: 'mrkdwn', text, verbatim: true };
}

function section(text: string): Block {
  return { type: 'section', text: mrkdwn(clip(text)) };
}

function context(text: string): Block {
  return { type: 'context', elements: [mrkdwn(clip(text))] };
}

/** Text in a code block, cut before it is escaped, every run of backticks broken so none can end the block. */
function codeBlock(text: string): string {
  const safe = slackEscape(clip(text, QUOTE_MAX)).replace(/`{3,}/g, (run) => run.split('').join('\u200b'));
  return `\`\`\`${safe}\`\`\``;
}

function factField(f: Fact): Block {
  const value = f.url ? slackLink(f.url, f.value) : f.code ? `\`${slackEscape(f.value)}\`` : slackEscape(f.value);
  return mrkdwn(clip(`*${slackEscape(f.label)}*\n${value}${f.note ? ` ${slackEscape(f.note)}` : ''}`, 1900));
}

function factsBlocks(facts: Fact[]): Block[] {
  return facts.length ? [{ type: 'section', fields: facts.slice(0, FIELDS_MAX).map(factField) }] : [];
}

/** A run's tests as a bar of squares, then each outcome's count and share. */
function outcomeBlocks(p: RunFinishedPayload): Block[] {
  const segments = runSegments(p);
  if (p.totalTests <= 0 || segments.length === 0) return [];
  const legend = segments.map((s) => `*${s.count}* ${s.label} ${percent(s.count, p.totalTests)}`).join('   ');
  return [section(`${outcomeSquares(segments, p.totalTests)}\n${slackEscape(legend)}`)];
}

function historyBlocks(p: RunFinishedPayload): Block[] {
  if (!p.history || p.history.length < 2) return [];
  const sentence = historySentence(p.history);
  return [
    section(
      `${slackEscape(historyLabel(p.history, p))}, oldest first\n${historySquares(p.history)}${sentence ? `   *${slackEscape(sentence)}*` : ''}`,
    ),
  ];
}

/** One failing test: who and where, what it says, the code it threw at, the error, its own history. */
function failureBlocks(f: TopFailure, url: string): Block[] {
  const { isNew, story, labels } = failureMeta(f);
  const meta = [...(isNew ? [':new: *New failure*'] : []), ...labels.map(slackEscape)].join('  ·  ');
  const suites = f.suitePath?.length ? `${slackEscape(f.suitePath.join(' › '))} › ` : '';
  const location = testLocation(f);
  const headline = failureHeadline(f);
  const lines = [
    ...(meta ? [meta] : []),
    `${suites}*${slackLink(url, f.title)}*`,
    ...(location ? [`\`${slackEscape(location)}\``] : []),
    ...(headline ? [slackEscape(headline)] : []),
  ];
  const blocks: Block[] = [{ type: 'divider' }, section(lines.join('\n'))];
  const code = f.source ? codeRows(f.source) : [];
  if (f.source && code.length) {
    // The failing line is marked in the code; a helper's file is named above it.
    const where = sourceIsTestFile(f) ? '' : `${slackEscape(`${f.source.file}:${f.source.line}`)}\n`;
    blocks.push(section(`${where}${codeBlock(codeRowsText(code))}`));
  }
  if (f.errorExcerpt) blocks.push(section(codeBlock(f.errorExcerpt)));
  if (f.history && f.history.length > 1) {
    blocks.push(context(`${testHistorySquares(f.history)}   ${story ? slackEscape(story) : ''}`));
  }
  return blocks;
}

function failuresBlocks(p: RunFinishedPayload, links: DashboardLinks): Block[] {
  const failures = p.topFailures ?? [];
  if (failures.length === 0) return [];
  const more = moreFailures(p);
  return [
    section(`*What failed*${more > 0 ? `  ${failures.length} of ${failingTests(p)}` : ''}`),
    ...failures.flatMap((f) => failureBlocks(f, links.failure(f, p.runId))),
    ...(more > 0
      ? [{ type: 'divider' }, context(slackLink(links.run(p.runId), `${plural(more, 'more failing test')} in the run`))]
      : []),
  ];
}

/** The usual duration and this run's, as two bars of squares. */
function durationBlocks(p: RunFinishedPayload): Block[] {
  if (p.durationMs == null || p.baselineDurationMs == null) return [];
  const longest = Math.max(p.durationMs, p.baselineDurationMs, 1);
  const bar = (ms: number, square: string) => square.repeat(Math.max(1, Math.round((ms / longest) * 16)));
  return [
    section(
      `Usual      ${bar(p.baselineDurationMs, '⬜')}  *${durationShort(p.baselineDurationMs)}*\nThis run  ${bar(p.durationMs, '🟧')}  *${durationShort(p.durationMs)}*`,
    ),
  ];
}

/** What only this kind of event shows, between its sentences and its facts. */
function detailBlocks(event: NotificationEvent, payload: NotificationPayload, links: DashboardLinks): Block[] {
  switch (event) {
    case 'run.finished':
    case 'run.failed':
    case 'run.failed.default_branch':
    case 'run.interrupted':
    case 'flakiness.spike': {
      const p = payload as RunFinishedPayload;
      return [...outcomeBlocks(p), ...historyBlocks(p)];
    }
    case 'perf.regression': {
      const p = payload as RunFinishedPayload;
      return [...durationBlocks(p), ...outcomeBlocks(p), ...historyBlocks(p)];
    }
    case 'cluster.new':
    case 'cluster.fixed':
    case 'cluster.regressed': {
      const p = payload as ClusterNewPayload | ClusterFixedPayload | ClusterRegressedPayload;
      const sample = (p as ClusterNewPayload).sampleErrorExcerpt;
      return [section(codeBlock(p.signature)), ...(sample ? [section(codeBlock(sample))] : [])];
    }
    case 'diagnosis.completed': {
      const p = payload as DiagnosisCompletedPayload;
      return [
        ...(p.summary ? [section(slackEscape(clip(p.summary, QUOTE_MAX)))] : []),
        ...(p.rootCause ? [section(`*Root cause*\n${slackEscape(clip(p.rootCause, QUOTE_MAX))}`)] : []),
      ];
    }
    case 'bug.looks_fixed': {
      const p = payload as BugLooksFixedPayload;
      const more = p.tests.length - DIGEST_ITEMS_LIMIT;
      const tests = p.tests.slice(0, DIGEST_ITEMS_LIMIT).map((t) => {
        const refs = [
          t.bugId ? slackLink(links.bugReport(t.bugId), `Bug #${t.bugId}`) : '',
          t.link ? slackLink(t.link, 'ticket') : '',
        ].filter(Boolean);
        return section(
          `:white_check_mark: *${slackLink(links.execution(t.executionId), t.title)}*\n\`${slackEscape(t.filePath)}\`${refs.length ? `  ·  ${refs.join('  ·  ')}` : ''}`,
        );
      });
      return more > 0 ? [...tests, context(`…and ${more} more`)] : tests;
    }
    case 'environment.incident':
    case 'auto_heal.pr_opened':
    case 'test.stuck':
      return [];
  }
}

function actionsBlock(event: NotificationEvent, payload: NotificationPayload, links: DashboardLinks): Block[] {
  const actions = eventActions(event, payload, links);
  if (actions.length === 0) return [];
  return [
    {
      type: 'actions',
      elements: actions.map((a) => ({
        type: 'button',
        text: { type: 'plain_text', text: a.label, emoji: false },
        url: a.url,
      })),
    },
  ];
}

/** The Slack message of one notification event. */
export function slackEventMessage(
  event: NotificationEvent,
  payload: NotificationPayload,
  base: string,
): Record<string, unknown> {
  const links = new DashboardLinks(base);
  const headline = eventHeadline(event, payload);
  const emoji = eventEmoji(event, headline.tone);
  const title = clip(`${emoji} ${headlineText(headline)}`, HEADER_MAX);
  const sentences = eventSentences(event, payload).map((s) =>
    s === INCIDENT_NOTE ? context(slackEscape(s)) : section(slackEscape(s)),
  );
  const body: Block[] = [
    ...sentences,
    ...detailBlocks(event, payload, links),
    ...factsBlocks(eventFacts(event, payload, links)),
    ...(event.startsWith('run.') ? failuresBlocks(payload as RunFinishedPayload, links) : []),
    ...actionsBlock(event, payload, links),
  ];
  return {
    text: `${emoji} *${slackEscape(renderEventSubject(event, payload))}*`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: title, emoji: true } },
      context([`*${slackEscape(headline.label)}*`, ...headline.details.map(slackEscape)].join('  ·  ')),
    ],
    attachments: [{ color: TONE_COLORS[headline.tone], blocks: body }],
  };
}

/** A digest as one Slack message: a line per notification, linked, with each run's bar of squares. */
export function slackDigestMessage(items: DigestItem[], base: string): Record<string, unknown> {
  const links = new DashboardLinks(base);
  const failing = items.filter(({ event, payload }) => eventTone(event, payload) === 'failed').length;
  const title = `:bell: ${plural(items.length, 'notification')}`;
  const blocks: Block[] = items.slice(0, DIGEST_ITEMS_LIMIT).map(({ event, payload }) => {
    const tone = eventTone(event, payload);
    const subject = renderEventSubject(event, payload);
    const path = notificationTargetPath(event, payload);
    const line = path ? slackLink(links.path(path), subject) : slackEscape(subject);
    const run = digestRun(event, payload);
    const squares = run ? `\n${outcomeSquares(runSegments(run), run.totalTests)}` : '';
    return section(`${eventEmoji(event, tone)} *${line}*${squares}`);
  });
  if (items.length > DIGEST_ITEMS_LIMIT) blocks.push(context(`…and ${items.length - DIGEST_ITEMS_LIMIT} more`));
  return {
    text: `${title}: Piwi digest`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: title, emoji: true } },
      context(
        `*Piwi digest*  ·  everything your digest subscriptions collected since the last one${failing > 0 ? `  ·  *${failing} need${failing === 1 ? 's' : ''} attention*` : ''}`,
      ),
    ],
    attachments: [{ color: TONE_COLORS[failing > 0 ? 'failed' : 'brand'], blocks }],
  };
}
