/**
 * The email of each notification event, and the digest that batches several.
 * Pure: the caller passes the dashboard's address every link starts with.
 */
import { ENGLISH_FRAME, emailLayout, escapeHtml } from '#shared/email-layout';
import { durationShort } from '#shared/relative-time';
import { safeHttpUrl } from '#shared/utils/safe-url';
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
} from '#shared/notification-events';
import {
  DIGEST_ITEMS_LIMIT,
  DashboardLinks,
  INCIDENT_NOTE,
  digestRun,
  eventActions,
  eventFacts,
  eventHeadline,
  eventSentences,
  eventTone,
  failingTests,
  headlineText,
  historyText,
  moreFailures,
  outcomeText,
  plural,
  runSegments,
  type Fact,
} from './message-parts';
import {
  EMAIL_COLORS,
  MONO,
  NOTIFICATION_EMAIL_WIDTH,
  actions,
  badge,
  banner,
  cardRow,
  cards,
  errorBlock,
  factsTable,
  failureCard,
  failureText,
  historyStrip,
  mono,
  outcomeBar,
  paragraph,
  sectionTitle,
  textLink,
  toneFill,
} from './email-blocks';

export interface RenderedEmail {
  html: string;
  text: string;
}

/** A part of an email's body, and the same part in its plain-text alternative. */
interface Section {
  html: string;
  text: string[];
}

const NO_SECTION: Section = { html: '', text: [] };

/** A sentence of `eventSentences`, escaped, its code between backticks set in a monospace font. */
function sentenceHtml(sentence: string): string {
  return escapeHtml(sentence).replace(/`([^`]+)`/g, `<code style="font-family:${MONO};">$1</code>`);
}

function factsHtml(facts: Fact[]): string {
  return factsTable(
    facts.map((f) => {
      const value = f.code ? mono(f.value) : escapeHtml(f.value);
      const linked = f.url ? (f.code ? textLink(f.url, value) : `<strong>${textLink(f.url, value)}</strong>`) : value;
      const note = f.note ? ` ${escapeHtml(f.note)}` : '';
      return [f.label, `${linked}${note}`];
    }),
  );
}

function factsText(facts: Fact[]): string[] {
  return facts.map((f) => {
    const url = f.url ? safeHttpUrl(f.url) : null;
    return `${f.label}: ${f.value}${f.note ? ` ${f.note}` : ''}${url ? ` (${url})` : ''}`;
  });
}

/**
 * The email of an event: the banner with its headline, its sentences, `detail`
 * (what the event alone shows), its facts, `tail` (what the facts frame: a
 * run's failing tests) and its buttons.
 */
function eventEmail(
  event: NotificationEvent,
  payload: NotificationPayload,
  links: DashboardLinks,
  detail: Section = NO_SECTION,
  tail: Section = NO_SECTION,
): RenderedEmail {
  const subject = renderEventSubject(event, payload);
  const headline = eventHeadline(event, payload);
  const sentences = eventSentences(event, payload);
  const facts = eventFacts(event, payload, links);
  const [primary, secondary] = eventActions(event, payload, links);
  const body =
    sentences
      .map((s) =>
        s === INCIDENT_NOTE
          ? paragraph(sentenceHtml(s), `font-size:13px;color:${EMAIL_COLORS.muted};`)
          : paragraph(sentenceHtml(s)),
      )
      .join('') +
    detail.html +
    factsHtml(facts) +
    tail.html +
    (primary ? actions(primary, secondary) : '');
  const html = emailLayout(escapeHtml(subject), body, links.site, {
    ...ENGLISH_FRAME,
    width: NOTIFICATION_EMAIL_WIDTH,
    banner: banner(headline),
  });
  const text = [
    subject,
    '',
    headlineText(headline),
    headline.details.join(' · '),
    '',
    ...sentences,
    ...detail.text,
    ...factsText(facts),
    ...tail.text,
    '',
    ...(primary ? [`${primary.label}: ${primary.url}`] : []),
  ].join('\n');
  return { html, text };
}

// ── Run events ────────────────────────────────────────────────────────────────

/** The run's outcome bar, then its history: what every run email opens its body with. */
function runOverview(p: RunFinishedPayload, links: DashboardLinks): Section {
  const history = p.history ? historyText(p.history) : '';
  return {
    html: outcomeBar(runSegments(p), p.totalTests) + (p.history ? historyStrip(p.history, links.run, p) : ''),
    text: [outcomeText(runSegments(p), p.totalTests), ...(history ? [history] : [])],
  };
}

/** The failing tests the payload names, each as a card, and how many more the run has. */
function failuresSection(p: RunFinishedPayload, links: DashboardLinks): Section {
  const failures = p.topFailures ?? [];
  if (failures.length === 0) return { html: '', text: [] };
  const runUrl = links.run(p.runId);
  const more = moreFailures(p);
  const aside = more > 0 ? `${failures.length} of ${failingTests(p)}` : undefined;
  return {
    html:
      sectionTitle('What failed', aside) +
      failures
        .map((f) => failureCard(f, { url: links.failure(f, p.runId), history: p.history, runUrl: links.run }))
        .join('') +
      (more > 0
        ? paragraph(textLink(runUrl, `${plural(more, 'more failing test')} in the run`), 'margin:4px 0 22px;')
        : ''),
    text: [
      '',
      `What failed${aside ? ` (${aside})` : ''}`,
      '',
      ...failures.map((f) => `${failureText(f, links.failure(f, p.runId))}\n`),
      ...(more > 0 ? [`${plural(more, 'more failing test')}: ${runUrl}`] : []),
    ],
  };
}

/** Two bars, the usual duration and this run's, each as long as its time. */
function durationBars(baselineMs: number, currentMs: number): string {
  const longest = Math.max(baselineMs, currentMs, 1);
  const row = (label: string, ms: number, color: string) => {
    const width = Math.max(2, Math.round((ms / longest) * 100));
    return `<tr><td width="96" style="width:96px;padding:4px 12px 4px 0;font-size:13px;color:${EMAIL_COLORS.muted};white-space:nowrap;">${escapeHtml(label)}</td><td style="padding:4px 0;"><table role="presentation" width="${width}%" cellpadding="0" cellspacing="0" border="0"><tr><td height="14" bgcolor="${color}" style="height:14px;line-height:14px;font-size:1px;background:${color};border-radius:4px;">&nbsp;</td></tr></table></td><td width="72" align="right" style="width:72px;padding:4px 0 4px 12px;font-size:13px;font-weight:700;color:${EMAIL_COLORS.ink};white-space:nowrap;">${escapeHtml(durationShort(ms))}</td></tr>`;
  };
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;">${row('Usual', baselineMs, '#d4d4d8')}${row('This run', currentMs, toneFill('warning'))}</table>`;
}

// ── Failure clusters ──────────────────────────────────────────────────────────

/** The cluster's signature, in a light code block. */
function signatureBlock(signature: string): string {
  return `<div style="margin:0 0 16px;padding:12px 14px;background:${EMAIL_COLORS.sunken};border-radius:6px;font-family:${MONO};font-size:12px;line-height:19px;color:${EMAIL_COLORS.ink};white-space:pre-wrap;word-break:break-word;">${escapeHtml(signature)}</div>`;
}

/** A cluster's signature and sample error; its title is in the headline. */
function clusterDetail(p: { signature: string; sampleErrorExcerpt?: string }): Section {
  return {
    html:
      (p.sampleErrorExcerpt ? sectionTitle('The error they share') : '') +
      signatureBlock(p.signature) +
      (p.sampleErrorExcerpt ? errorBlock(p.sampleErrorExcerpt) : ''),
    text: ['', p.signature, ...(p.sampleErrorExcerpt ? ['', p.sampleErrorExcerpt] : []), ''],
  };
}

// ── Other events ──────────────────────────────────────────────────────────────

function diagnosisDetail(p: DiagnosisCompletedPayload): Section {
  return {
    html:
      (p.summary ? paragraph(escapeHtml(p.summary), `font-size:15px;color:${EMAIL_COLORS.ink};`) : '') +
      (p.rootCause ? sectionTitle('Root cause') + paragraph(escapeHtml(p.rootCause)) : ''),
    text: [...(p.summary ? [p.summary] : []), ...(p.rootCause ? [`Root cause: ${p.rootCause}`] : [])],
  };
}

function looksFixedDetail(p: BugLooksFixedPayload, links: DashboardLinks): Section {
  const rows = p.tests
    .map((t) => {
      const bug = t.bugId ? textLink(links.bugReport(t.bugId), escapeHtml(`Bug #${t.bugId}`)) : '';
      const ticket = t.link ? textLink(t.link, 'ticket') : '';
      const refs = [bug, ticket].filter(Boolean).join(' · ');
      return cardRow(
        `${refs ? `<div style="margin-bottom:4px;font-size:12px;color:${EMAIL_COLORS.muted};">${refs}</div>` : ''}<a href="${escapeHtml(links.execution(t.executionId))}" style="font-size:15px;font-weight:700;color:${EMAIL_COLORS.ink};text-decoration:none;">${escapeHtml(t.title)}</a><div style="margin-top:2px;font-family:${MONO};font-size:12px;color:${EMAIL_COLORS.muted};">${escapeHtml(t.filePath)}</div>`,
        'passed',
      );
    })
    .join('');
  return {
    html: cards(rows),
    text: [
      '',
      ...p.tests.map(
        (t) =>
          `- ${t.title} (${t.filePath})${t.bugId ? ` · Bug #${t.bugId}` : ''}${t.link && safeHttpUrl(t.link) ? ` · ${t.link}` : ''}\n  ${links.execution(t.executionId)}`,
      ),
      '',
    ],
  };
}

/** The email for one notification event. */
export function renderNotificationEmailAt(
  event: NotificationEvent,
  payload: NotificationPayload,
  site: string,
): RenderedEmail {
  const links = new DashboardLinks(site);
  switch (event) {
    case 'run.finished':
    case 'run.failed':
    case 'run.failed.default_branch':
    case 'run.interrupted':
    case 'flakiness.spike':
    case 'perf.regression': {
      const p = payload as RunFinishedPayload;
      const overview = runOverview(p, links);
      if (event === 'flakiness.spike') return eventEmail(event, p, links, overview);
      if (event === 'perf.regression') {
        const bars =
          p.durationMs != null && p.baselineDurationMs != null ? durationBars(p.baselineDurationMs, p.durationMs) : '';
        return eventEmail(event, p, links, { html: bars + overview.html, text: overview.text });
      }
      return eventEmail(event, p, links, overview, failuresSection(p, links));
    }
    case 'cluster.new':
      return eventEmail(event, payload, links, clusterDetail(payload as ClusterNewPayload));
    case 'cluster.fixed':
    case 'cluster.regressed':
      return eventEmail(event, payload, links, clusterDetail(payload as ClusterFixedPayload | ClusterRegressedPayload));
    case 'diagnosis.completed':
      return eventEmail(event, payload, links, diagnosisDetail(payload as DiagnosisCompletedPayload));
    case 'bug.looks_fixed':
      return eventEmail(event, payload, links, looksFixedDetail(payload as BugLooksFixedPayload, links));
    case 'environment.incident':
    case 'auto_heal.pr_opened':
    case 'test.stuck':
      return eventEmail(event, payload, links);
  }
}

// ── Digest ────────────────────────────────────────────────────────────────────

/** One event queued for a digest send. */
export interface DigestItem {
  event: NotificationEvent;
  payload: NotificationPayload;
}

/**
 * One email summarizing every notification a digest-mode subscription batched
 * since the previous send: a line and a link per item, with each run's outcome
 * bar where the payload carries its counts. The HTML lists the first
 * {@link DIGEST_ITEMS_LIMIT} and counts the rest; the plain text lists them all.
 */
export function renderDigestEmailAt(items: DigestItem[], site: string): RenderedEmail & { subject: string } {
  const links = new DashboardLinks(site);
  const subject = `Piwi digest — ${plural(items.length, 'notification')}`;
  const bad = items.filter(({ event, payload }) => eventTone(event, payload) === 'failed').length;

  const rows = items
    .slice(0, DIGEST_ITEMS_LIMIT)
    .map(({ event, payload }) => {
      const line = renderEventSubject(event, payload);
      const path = notificationTargetPath(event, payload);
      const url = path ? links.path(path) : null;
      const run = digestRun(event, payload);
      const bar = run ? `<div style="margin-top:8px;">${outcomeBar(runSegments(run), run.totalTests)}</div>` : '';
      const style = `color:${EMAIL_COLORS.ink};font-weight:700;font-size:14px;text-decoration:none;`;
      const title = url
        ? `<a href="${escapeHtml(url)}" style="${style}">${escapeHtml(line)}</a>`
        : `<span style="${style}">${escapeHtml(line)}</span>`;
      return cardRow(
        `${title}${bar || '<div style="height:10px;line-height:10px;font-size:1px;">&nbsp;</div>'}`,
        eventTone(event, payload),
        '12px 14px 2px',
      );
    })
    .join('');
  const more = items.length - DIGEST_ITEMS_LIMIT;

  const body =
    (bad > 0
      ? `<p style="margin:0 0 16px;">${badge(`${bad} need${bad === 1 ? 's' : ''} attention`, 'failed')}</p>`
      : '') +
    cards(rows) +
    (more > 0 ? paragraph(escapeHtml(`…and ${plural(more, 'more notification')}`)) : '');
  const html = emailLayout(escapeHtml(subject), body, site, {
    ...ENGLISH_FRAME,
    width: NOTIFICATION_EMAIL_WIDTH,
    banner: banner({
      tone: bad > 0 ? 'failed' : 'brand',
      label: 'Notification digest',
      lead: '',
      figure: String(items.length),
      rest: items.length === 1 ? ' notification' : ' notifications',
      details: ['Everything your digest subscriptions collected since the last one'],
    }),
  });

  const text = items
    .map(({ event, payload }) => {
      const path = notificationTargetPath(event, payload);
      return `- ${renderEventSubject(event, payload)}${path ? `\n  ${links.path(path)}` : ''}`;
    })
    .join('\n');
  return { subject, html, text: `${subject}\n\n${text}` };
}
