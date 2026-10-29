/**
 * The email of each notification event, and the digest that batches several.
 * Pure: the caller passes the dashboard's address every link starts with.
 */
import { ENGLISH_FRAME, emailLayout, escapeHtml } from '#shared/email-layout';
import { durationApprox, durationShort } from '#shared/relative-time';
import {
  clusterOutcome,
  failureTargetPath,
  notificationTargetPath,
  renderEventSubject,
  type AutoHealPrOpenedPayload,
  type BugLooksFixedPayload,
  type ClusterFixedPayload,
  type ClusterNewPayload,
  type ClusterRegressedPayload,
  type DiagnosisCompletedPayload,
  type EnvironmentIncidentPayload,
  type NotificationEvent,
  type NotificationPayload,
  type RunFinishedPayload,
} from '#shared/notification-events';
import {
  NOTIFICATION_EMAIL_WIDTH,
  actions,
  badge,
  banner,
  bigNumber,
  errorBlock,
  factsTable,
  failureCard,
  failureText,
  historyStrip,
  historyText,
  mono,
  outcomeBar,
  outcomeText,
  paragraph,
  runSegments,
  sectionTitle,
  textLink,
  toneColor,
  type BannerOptions,
  type Tone,
} from './email-blocks';

export interface RenderedEmail {
  html: string;
  text: string;
}

/** Links into the dashboard, from its public address. */
class Links {
  constructor(readonly site: string) {}
  run = (runId: number) => `${this.site}/test-runs/${runId}`;
  cluster = (clusterId: number) => `${this.site}/failure-clusters/${clusterId}`;
  path = (path: string) => `${this.site}${path}`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The email document: the banner atop the wide card, the body under it. */
function frame(subject: string, bannerOptions: BannerOptions, body: string, site: string): string {
  return emailLayout(escapeHtml(subject), body, site, {
    ...ENGLISH_FRAME,
    width: NOTIFICATION_EMAIL_WIDTH,
    banner: banner(bannerOptions),
  });
}

/** Where a run comes from, in the banner: `Run #12 · main · staging · 8m 32s`. */
function runLine(p: { runId: number; branch?: string; environment?: string; durationMs?: number }): string {
  const parts = [`Run #${p.runId}`];
  if (p.branch) parts.push(p.branch);
  if (p.environment) parts.push(p.environment);
  if (p.durationMs) parts.push(durationShort(p.durationMs));
  return escapeHtml(parts.join(' · '));
}

/** The branch and environment a history covers, after its run count: ` on main in staging`. */
function scopeOf(p: { branch?: string; environment?: string }): string {
  return `${p.branch ? ` on ${p.branch}` : ''}${p.environment ? ` in ${p.environment}` : ''}`;
}

/** The commit row of a run's facts: the short sha, linked when the host is known, its subject and author. */
function commitFact(p: RunFinishedPayload): string | null {
  if (!p.commit) return null;
  const short = mono(p.commit.sha.slice(0, 7));
  const sha = p.commit.url ? `<a href="${escapeHtml(p.commit.url)}" style="text-decoration:none;">${short}</a>` : short;
  const message = p.commit.message ? ` ${escapeHtml(p.commit.message)}` : '';
  const author = p.commit.author ? ` <span style="color:#71717a;">by ${escapeHtml(p.commit.author)}</span>` : '';
  return `${sha}${message}${author}`;
}

function runFacts(p: RunFinishedPayload, withOwners: boolean): string {
  return factsTable([
    ['Commit', commitFact(p)],
    ['CI build', p.ciUrl ? textLink(p.ciUrl, 'Open the build') : null],
    ['Owners', withOwners && p.owners?.length ? escapeHtml(p.owners.join(', ')) : null],
  ]);
}

function runFactsText(p: RunFinishedPayload): string[] {
  const lines: string[] = [];
  if (p.commit) {
    lines.push(
      `Commit: ${p.commit.sha.slice(0, 7)}${p.commit.message ? ` ${p.commit.message}` : ''}${p.commit.author ? ` by ${p.commit.author}` : ''}`,
    );
  }
  if (p.ciUrl) lines.push(`CI build: ${p.ciUrl}`);
  return lines;
}

/** The run's outcome bar, then its history: what every run email opens its body with. */
function runOverview(p: RunFinishedPayload, links: Links): string {
  return outcomeBar(runSegments(p), p.totalTests) + (p.history ? historyStrip(p.history, links.run, scopeOf(p)) : '');
}

function runOverviewText(p: RunFinishedPayload): string[] {
  const lines = [outcomeText(runSegments(p), p.totalTests)];
  const history = p.history ? historyText(p.history) : '';
  if (history) lines.push(history);
  return lines;
}

/** The failing tests the payload names, each as a card, and how many more the run has. */
function failuresSection(p: RunFinishedPayload, links: Links): { html: string; text: string } {
  const failures = p.topFailures ?? [];
  if (failures.length === 0) return { html: '', text: '' };
  const runUrl = links.run(p.runId);
  const urlOf = (f: (typeof failures)[number]) => {
    const path = failureTargetPath(f);
    return path ? links.path(path) : runUrl;
  };
  const more = Math.max(0, p.failedTests - failures.length);
  const aside = p.failedTests > failures.length ? `${failures.length} of ${p.failedTests}` : undefined;
  const moreHtml =
    more > 0
      ? paragraph(`${textLink(runUrl, `${plural(more, 'more failing test')} in the run`)}`, 'margin:4px 0 22px;')
      : '';
  return {
    html:
      sectionTitle('What failed', aside) +
      failures.map((f) => failureCard(f, { url: urlOf(f), history: p.history, runUrl: links.run })).join('') +
      moreHtml,
    text: [
      `What failed${aside ? ` (${aside})` : ''}`,
      '',
      ...failures.map((f) => `${failureText(f, urlOf(f))}\n`),
      ...(more > 0 ? [`${plural(more, 'more failing test')}: ${runUrl}`] : []),
    ].join('\n'),
  };
}

function secondaryCi(p: RunFinishedPayload) {
  return p.ciUrl ? { url: p.ciUrl, label: 'Open the CI build' } : null;
}

// ── Run events ────────────────────────────────────────────────────────────────

/** `run.finished`, `run.failed`, `run.failed.default_branch` and `run.interrupted`. */
function runEmail(event: NotificationEvent, p: RunFinishedPayload, links: Links): RenderedEmail {
  const subject = renderEventSubject(event, p);
  const interrupted = event === 'run.interrupted' || p.status === 'interrupted';
  const failed = !interrupted && (p.failedTests > 0 || p.status === 'failed' || p.status === 'timedout');
  const tone: Tone = interrupted ? 'warning' : failed ? 'failed' : 'passed';
  const project = p.projectName;

  let label: string;
  let headline: string;
  let summary: string;
  if (interrupted) {
    label = `Run interrupted · ${project}`;
    const reported = p.totalTests - (p.didNotRunTests ?? 0);
    headline = 'The run stopped before the end';
    summary = `${reported} of ${plural(p.totalTests, 'test')} reported`;
  } else if (failed) {
    label = `${event === 'run.failed.default_branch' ? 'Default branch broken' : 'Run failed'} · ${project}`;
    headline =
      p.failedTests > 0
        ? `${bigNumber(p.failedTests)} ${p.failedTests === 1 ? 'test' : 'tests'} failed`
        : 'The run failed';
    summary = p.failedTests > 0 ? `out of ${p.totalTests}` : `${plural(p.totalTests, 'test')} reported`;
  } else {
    label = `Run passed · ${project}`;
    headline =
      p.flakyTests > 0
        ? `${bigNumber(p.passedTests)} tests passed`
        : `All ${bigNumber(p.totalTests)} ${p.totalTests === 1 ? 'test' : 'tests'} passed`;
    summary = p.flakyTests > 0 ? `${p.flakyTests} only on a retry` : '';
  }
  const subline = [escapeHtml(summary), runLine(p)].filter(Boolean).join(' &nbsp;·&nbsp; ');

  const failures = failuresSection(p, links);
  const runUrl = links.run(p.runId);
  const body =
    runOverview(p, links) +
    runFacts(p, failed) +
    failures.html +
    actions({ url: runUrl, label: 'Open the run' }, secondaryCi(p));
  const html = frame(subject, { tone, label, headline, subline }, body, links.site);
  const text = [
    subject,
    `${summary ? `${summary.charAt(0).toUpperCase()}${summary.slice(1)}. ` : ''}Run #${p.runId}${p.branch ? ` on ${p.branch}` : ''}`,
    '',
    ...runOverviewText(p),
    ...runFactsText(p),
    ...(failures.text ? ['', failures.text] : []),
    '',
    `View run: ${runUrl}`,
  ].join('\n');
  return { html, text };
}

function flakinessEmail(p: RunFinishedPayload, links: Links): RenderedEmail {
  const subject = renderEventSubject('flakiness.spike', p);
  const share = p.totalTests > 0 ? `${((p.flakyTests / p.totalTests) * 100).toFixed(1)}% of the run` : '';
  const runUrl = links.run(p.runId);
  const body =
    runOverview(p, links) +
    paragraph(
      `${plural(p.flakyTests, 'test')} failed at least once, then passed on a retry. A retry hides the failure from the run's verdict, not from the time it costs.`,
    ) +
    runFacts(p, false) +
    actions({ url: runUrl, label: 'Open the run' }, secondaryCi(p));
  const html = frame(
    subject,
    {
      tone: 'flaky',
      label: `Flakiness spike · ${p.projectName}`,
      headline: `${bigNumber(p.flakyTests)} flaky ${p.flakyTests === 1 ? 'test' : 'tests'}`,
      subline: [escapeHtml(share), runLine(p)].filter(Boolean).join(' &nbsp;·&nbsp; '),
    },
    body,
    links.site,
  );
  const text = [
    subject,
    `${plural(p.flakyTests, 'test')} passed only on a retry${share ? ` (${share})` : ''}.`,
    '',
    ...runOverviewText(p),
    ...runFactsText(p),
    '',
    `View run: ${runUrl}`,
  ].join('\n');
  return { html, text };
}

/** Two bars, the usual duration and this run's, each as long as its time. */
function durationBars(baselineMs: number, currentMs: number): string {
  const longest = Math.max(baselineMs, currentMs, 1);
  const row = (label: string, ms: number, color: string) => {
    const width = Math.max(2, Math.round((ms / longest) * 100));
    return `<tr><td width="96" style="width:96px;padding:4px 12px 4px 0;font-size:13px;color:#71717a;white-space:nowrap;">${escapeHtml(label)}</td><td style="padding:4px 0;"><table role="presentation" width="${width}%" cellpadding="0" cellspacing="0" border="0"><tr><td height="14" bgcolor="${color}" style="height:14px;line-height:14px;font-size:1px;background:${color};border-radius:4px;">&nbsp;</td></tr></table></td><td width="72" align="right" style="width:72px;padding:4px 0 4px 12px;font-size:13px;font-weight:700;color:#18181b;white-space:nowrap;">${escapeHtml(durationShort(ms))}</td></tr>`;
  };
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;">${row('Usual', baselineMs, '#d4d4d8')}${row('This run', currentMs, toneColor('warning'))}</table>`;
}

function perfEmail(p: RunFinishedPayload, links: Links): RenderedEmail {
  const subject = renderEventSubject('perf.regression', p);
  const pct = p.regressionPct != null ? Math.round(p.regressionPct) : null;
  const runUrl = links.run(p.runId);
  const comparison =
    p.durationMs != null && p.baselineDurationMs != null
      ? `${durationShort(p.durationMs)}, against a usual ${durationShort(p.baselineDurationMs)}`
      : '';
  const body =
    (p.durationMs != null && p.baselineDurationMs != null ? durationBars(p.baselineDurationMs, p.durationMs) : '') +
    paragraph(
      'The usual time is the median of the last runs on the same branch and environment.',
      'font-size:13px;color:#71717a;',
    ) +
    runOverview(p, links) +
    runFacts(p, false) +
    actions({ url: runUrl, label: 'Open the run' }, secondaryCi(p));
  const html = frame(
    subject,
    {
      tone: 'warning',
      label: `Performance regression · ${p.projectName}`,
      headline: pct != null ? `${bigNumber(`+${pct}%`)} slower` : 'Slower than usual',
      subline: [escapeHtml(comparison), runLine({ ...p, durationMs: undefined })]
        .filter(Boolean)
        .join(' &nbsp;·&nbsp; '),
    },
    body,
    links.site,
  );
  const text = [
    subject,
    ...(comparison ? [comparison] : []),
    '',
    ...runOverviewText(p),
    ...runFactsText(p),
    '',
    `View run: ${runUrl}`,
  ].join('\n');
  return { html, text };
}

// ── Failure clusters ──────────────────────────────────────────────────────────

/** A cluster's title when it adds something to its signature. */
function clusterTitle(p: { title?: string | null; signature: string }): string | null {
  return p.title && p.title !== p.signature ? p.title : null;
}

/** The cluster's signature, in a light code block. */
function signatureBlock(signature: string): string {
  return `<div style="margin:0 0 16px;padding:12px 14px;background:#f4f4f5;border-radius:6px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:19px;color:#18181b;white-space:pre-wrap;word-break:break-word;">${escapeHtml(signature)}</div>`;
}

function clusterIdentityText(p: { title?: string | null; signature: string }): string {
  const title = clusterTitle(p);
  return `${title ? `${title}\n` : ''}${p.signature}`;
}

function knownIssueFact(knownIssue?: { key: string; url: string }): string | null {
  return knownIssue ? `<strong>${textLink(knownIssue.url, escapeHtml(knownIssue.key))}</strong>` : null;
}

function trackedInText(knownIssue?: { key: string; url: string }): string {
  return knownIssue ? `\n\nTracked in ${knownIssue.key}: ${knownIssue.url}` : '';
}

function newClusterEmail(p: ClusterNewPayload, links: Links): RenderedEmail {
  const subject = renderEventSubject('cluster.new', p);
  const url = links.cluster(p.clusterId);
  const affected = p.affectedCases ?? 0;
  const title = clusterTitle(p);
  const body =
    paragraph(
      affected > 1
        ? `${affected} tests of run #${p.runId} failed with the same error, one no earlier run produced, so Piwi grouped them in one cluster.`
        : `A test of run #${p.runId} failed with an error no earlier run produced.`,
    ) +
    sectionTitle('The error they share') +
    signatureBlock(p.signature) +
    (p.sampleErrorExcerpt ? errorBlock(p.sampleErrorExcerpt) : '') +
    factsTable([
      ['Run', textLink(links.run(p.runId), escapeHtml(`#${p.runId}${p.branch ? ` on ${p.branch}` : ''}`))],
      ['Tracked in', knownIssueFact(p.knownIssue)],
      ['Owners', p.owners?.length ? escapeHtml(p.owners.join(', ')) : null],
    ]) +
    actions({ url, label: 'Open the cluster' }, { url: links.run(p.runId), label: 'Open the run' });
  const html = frame(
    subject,
    {
      tone: 'failed',
      label: `New failure cluster · ${p.projectName}`,
      headline:
        affected > 0
          ? `${bigNumber(affected)} ${affected === 1 ? 'test fails' : 'tests fail'} the same way`
          : 'A new way to fail',
      subline: title ? escapeHtml(title) : undefined,
    },
    body,
    links.site,
  );
  const text = `New failure cluster in ${p.projectName}${affected ? ` (${affected} affected)` : ''}\n\n${clusterIdentityText(p)}${p.sampleErrorExcerpt ? `\n\n${p.sampleErrorExcerpt}` : ''}${trackedInText(p.knownIssue)}\n\nView: ${url}`;
  return { html, text };
}

function clusterFixedEmail(p: ClusterFixedPayload, links: Links): RenderedEmail {
  const { headline, triageNote } = clusterOutcome('cluster.fixed', p);
  const subject = renderEventSubject('cluster.fixed', p);
  const url = links.cluster(p.clusterId);
  const title = clusterTitle(p);
  const fixedBy = [p.commit ? mono(p.commit.slice(0, 7)) : '', p.fixAuthor ? escapeHtml(`by ${p.fixAuthor.name}`) : '']
    .filter(Boolean)
    .join(' ');
  const sentence =
    p.verification === 'diagnosis-verified'
      ? 'The commits since the last failure changed a file the diagnosis named, and every affected test passes again.'
      : 'Every test that failed with this error passes again.';
  const body =
    paragraph(sentence) +
    signatureBlock(p.signature) +
    factsTable([
      ['Fixed by', fixedBy || null],
      ['Time to fix', p.timeToResolutionMs ? escapeHtml(durationApprox(p.timeToResolutionMs)) : null],
      ['Tests', p.testCount ? escapeHtml(plural(p.testCount, 'test')) : null],
      [
        'Pull request',
        p.healPr ? textLink(p.healPr.url, escapeHtml(`#${p.healPr.number}, opened by auto-heal`)) : null,
      ],
      ['Run', textLink(links.run(p.runId), escapeHtml(`#${p.runId}${p.branch ? ` on ${p.branch}` : ''}`))],
      ['Tracked in', knownIssueFact(p.knownIssue)],
      ['Triage', triageNote ? escapeHtml(triageNote) : null],
    ]) +
    actions({ url, label: 'Open the cluster' });
  const html = frame(
    subject,
    {
      tone: 'passed',
      label: `Fixed · ${p.projectName}`,
      headline: escapeHtml(headline),
      subline: title ? escapeHtml(title) : undefined,
    },
    body,
    links.site,
  );
  const text = `${headline} in ${p.projectName}\n\n${clusterIdentityText(p)}${triageNote ? `\n\n${triageNote}` : ''}${trackedInText(p.knownIssue)}\n\nView: ${url}`;
  return { html, text };
}

function clusterRegressedEmail(p: ClusterRegressedPayload, links: Links): RenderedEmail {
  const { headline, triageNote } = clusterOutcome('cluster.regressed', p);
  const subject = renderEventSubject('cluster.regressed', p);
  const url = links.cluster(p.clusterId);
  const title = clusterTitle(p);
  const sentence =
    p.fixLandedRunId != null
      ? `The fix landed in ${textLink(links.run(p.fixLandedRunId), `run #${p.fixLandedRunId}`)}, and the error is back in ${textLink(links.run(p.runId), `run #${p.runId}`)}.`
      : `The error is back in ${textLink(links.run(p.runId), `run #${p.runId}`)}.`;
  const body =
    paragraph(sentence) +
    signatureBlock(p.signature) +
    factsTable([
      ['Fix by', p.fixAuthor ? escapeHtml(p.fixAuthor.name) : null],
      ['Tracked in', knownIssueFact(p.knownIssue)],
      ['Triage', triageNote ? escapeHtml(triageNote) : null],
    ]) +
    actions({ url, label: 'Open the cluster' }, { url: links.run(p.runId), label: 'Open the run' });
  const html = frame(
    subject,
    {
      tone: 'failed',
      label: `Fix regressed · ${p.projectName}`,
      headline: 'The fix did not hold',
      subline: title ? escapeHtml(title) : undefined,
    },
    body,
    links.site,
  );
  const text = `${headline} in ${p.projectName}\n\n${clusterIdentityText(p)}${triageNote ? `\n\n${triageNote}` : ''}${trackedInText(p.knownIssue)}\n\nView: ${url}`;
  return { html, text };
}

// ── Other events ──────────────────────────────────────────────────────────────

const INCIDENT_RULES: Record<string, string> = {
  'host-unreachable': 'The application could not be reached',
  'browser-crash': 'The browser crashed',
  'cross-project': 'Several projects failed the same way',
};

function incidentEmail(p: EnvironmentIncidentPayload, links: Links): RenderedEmail {
  const subject = renderEventSubject('environment.incident', p);
  const url = links.run(p.runId);
  const note = 'Left out of flaky scores, baselines, fix verification and the gate (inconclusive).';
  const others =
    p.otherProjects > 0
      ? paragraph(`${plural(p.otherProjects, 'other project')} saw the same failure at the same time.`)
      : '';
  const body =
    paragraph(escapeHtml(p.reason), 'font-size:15px;color:#18181b;font-weight:600;') +
    others +
    paragraph(escapeHtml(note), 'font-size:13px;color:#71717a;') +
    factsTable([
      ['Run', textLink(url, escapeHtml(`#${p.runId}${p.branch ? ` on ${p.branch}` : ''}`))],
      ['Host', p.host ? mono(p.host) : null],
      ['Failed', escapeHtml(`${p.failedTests} of ${plural(p.totalTests, 'test')}`)],
    ]) +
    actions({ url, label: 'Open the run' });
  const html = frame(
    subject,
    {
      tone: 'warning',
      label: `Environment incident · ${p.projectName}`,
      headline: escapeHtml(INCIDENT_RULES[p.rule] ?? 'The environment failed'),
      subline: runLine(p),
    },
    body,
    links.site,
  );
  return { html, text: `${subject}\n\n${p.reason}\n${note}\n\nView: ${url}` };
}

function diagnosisEmail(p: DiagnosisCompletedPayload, links: Links): RenderedEmail {
  const subject = renderEventSubject('diagnosis.completed', p);
  const path = notificationTargetPath('diagnosis.completed', p);
  const url = path ? links.path(path) : links.cluster(p.clusterId);
  const facts = [p.category, p.confidence ? `${p.confidence} confidence` : null].filter(Boolean).join(' · ');
  const body =
    (p.summary ? paragraph(escapeHtml(p.summary), 'font-size:15px;color:#18181b;') : '') +
    (p.rootCause ? sectionTitle('Root cause') + paragraph(escapeHtml(p.rootCause)) : '') +
    actions({ url, label: 'Open the diagnosis' });
  const html = frame(
    subject,
    {
      tone: 'brand',
      label: 'AI diagnosis',
      headline: 'The diagnosis is ready',
      subline: facts ? escapeHtml(facts) : undefined,
    },
    body,
    links.site,
  );
  const text = [subject, p.summary, p.rootCause ? `Root cause: ${p.rootCause}` : null, facts || null, `View: ${url}`]
    .filter(Boolean)
    .join('\n\n');
  return { html, text };
}

function autoHealEmail(p: AutoHealPrOpenedPayload, links: Links): RenderedEmail {
  const subject = renderEventSubject('auto_heal.pr_opened', p);
  const runUrl = links.run(p.runId);
  const body =
    paragraph(
      `Auto-heal rewrote the broken locators of ${textLink(runUrl, `run #${p.runId}`)} in a pull request. Review it like any other change before merging it.`,
    ) +
    factsTable([
      ['Pull request', textLink(p.prUrl, escapeHtml(`#${p.prNumber}`))],
      ['Branch', mono(p.branch)],
      ['Edits', escapeHtml(plural(p.editCount, 'locator edit'))],
    ]) +
    actions({ url: p.prUrl, label: 'Review the pull request' }, { url: runUrl, label: 'Open the run' });
  const html = frame(
    subject,
    {
      tone: 'brand',
      label: `Auto-heal · ${p.projectName}`,
      headline: `Pull request ${bigNumber(`#${p.prNumber}`)} is open`,
      subline: escapeHtml(`${plural(p.editCount, 'locator edit')} on ${p.branch}`),
    },
    body,
    links.site,
  );
  return {
    html,
    text: `${subject}\n\n${plural(p.editCount, 'locator edit')} on ${p.branch}.\n\nReview: ${p.prUrl}\nRun: ${runUrl}`,
  };
}

function looksFixedEmail(p: BugLooksFixedPayload, links: Links): RenderedEmail {
  const subject = renderEventSubject('bug.looks_fixed', p);
  const runUrl = links.run(p.runId);
  const rows = p.tests
    .map((t) => {
      const bug = t.bugId ? textLink(links.path(`/bug-reports/${t.bugId}`), escapeHtml(`Bug #${t.bugId}`)) : '';
      const ticket = t.link ? textLink(t.link, 'ticket') : '';
      const refs = [bug, ticket].filter(Boolean).join(' · ');
      return `<tr><td style="padding:12px 14px;border:1px solid #e4e4e7;border-left:4px solid ${toneColor('passed')};border-radius:8px;">${refs ? `<div style="margin-bottom:4px;font-size:12px;color:#71717a;">${refs}</div>` : ''}<a href="${escapeHtml(links.path(`/test-run-cases/${t.executionId}`))}" style="font-size:15px;font-weight:700;color:#18181b;text-decoration:none;">${escapeHtml(t.title)}</a><div style="margin-top:2px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;color:#71717a;">${escapeHtml(t.filePath)}</div></td></tr><tr><td height="10" style="height:10px;font-size:1px;line-height:10px;">&nbsp;</td></tr>`;
    })
    .join('');
  const body =
    paragraph(
      `${p.tests.length === 1 ? 'A test marked' : 'Tests marked'} <code style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;">test.fail()</code> passed in ${textLink(runUrl, `run #${p.runId}`)}: the ${p.tests.length === 1 ? 'bug it reproduces' : 'bugs they reproduce'} no longer ${p.tests.length === 1 ? 'shows' : 'show'}. Confirm the fix, then remove <code style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;">test.fail()</code> so the test guards against a return.`,
    ) +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;margin:0 0 12px;">${rows}</table>` +
    actions({ url: runUrl, label: 'Open the run' });
  const html = frame(
    subject,
    {
      tone: 'passed',
      label: `Bug looks fixed · ${p.projectName}`,
      headline:
        p.tests.length === 1
          ? escapeHtml(p.tests[0]!.bugId ? `Bug #${p.tests[0]!.bugId} looks fixed` : 'A bug looks fixed')
          : `${bigNumber(p.tests.length)} bugs look fixed`,
      subline: runLine(p),
    },
    body,
    links.site,
  );
  const text = [
    subject,
    '',
    ...p.tests.map(
      (t) =>
        `- ${t.title} (${t.filePath})${t.bugId ? ` · Bug #${t.bugId}` : ''}${t.link ? ` · ${t.link}` : ''}\n  ${links.path(`/test-run-cases/${t.executionId}`)}`,
    ),
    '',
    `View run: ${runUrl}`,
  ].join('\n');
  return { html, text };
}

/** The email for one notification event. */
export function renderNotificationEmailAt(
  event: NotificationEvent,
  payload: NotificationPayload,
  site: string,
): RenderedEmail {
  const links = new Links(site);
  switch (event) {
    case 'run.finished':
    case 'run.failed':
    case 'run.failed.default_branch':
    case 'run.interrupted':
      return runEmail(event, payload as RunFinishedPayload, links);
    case 'flakiness.spike':
      return flakinessEmail(payload as RunFinishedPayload, links);
    case 'perf.regression':
      return perfEmail(payload as RunFinishedPayload, links);
    case 'cluster.new':
      return newClusterEmail(payload as ClusterNewPayload, links);
    case 'cluster.fixed':
      return clusterFixedEmail(payload as ClusterFixedPayload, links);
    case 'cluster.regressed':
      return clusterRegressedEmail(payload as ClusterRegressedPayload, links);
    case 'environment.incident':
      return incidentEmail(payload as EnvironmentIncidentPayload, links);
    case 'diagnosis.completed':
      return diagnosisEmail(payload as DiagnosisCompletedPayload, links);
    case 'auto_heal.pr_opened':
      return autoHealEmail(payload as AutoHealPrOpenedPayload, links);
    case 'bug.looks_fixed':
      return looksFixedEmail(payload as BugLooksFixedPayload, links);
  }
}

// ── Digest ────────────────────────────────────────────────────────────────────

/** One event queued for a digest send. */
export interface DigestItem {
  event: NotificationEvent;
  payload: NotificationPayload;
}

/** The tone an event is drawn in, in the digest. */
function eventTone(event: NotificationEvent, payload: NotificationPayload): Tone {
  switch (event) {
    case 'run.finished': {
      const p = payload as RunFinishedPayload;
      return p.failedTests > 0 || p.status === 'failed' ? 'failed' : 'passed';
    }
    case 'run.failed':
    case 'run.failed.default_branch':
    case 'cluster.new':
    case 'cluster.regressed':
      return 'failed';
    case 'cluster.fixed':
    case 'bug.looks_fixed':
      return 'passed';
    case 'flakiness.spike':
      return 'flaky';
    case 'run.interrupted':
    case 'perf.regression':
    case 'environment.incident':
      return 'warning';
    case 'diagnosis.completed':
    case 'auto_heal.pr_opened':
      return 'brand';
  }
}

/**
 * One email summarizing every notification a digest-mode subscription batched
 * since the previous send: a line and a link per item, with each run's outcome
 * bar where the payload carries its counts.
 */
export function renderDigestEmailAt(items: DigestItem[], site: string): RenderedEmail & { subject: string } {
  const links = new Links(site);
  const subject = `Piwi digest — ${plural(items.length, 'notification')}`;
  const bad = items.filter(({ event, payload }) => eventTone(event, payload) === 'failed').length;

  const rows = items
    .map(({ event, payload }) => {
      const line = renderEventSubject(event, payload);
      const path = notificationTargetPath(event, payload);
      const url = path ? links.path(path) : null;
      const tone = eventTone(event, payload);
      const run = payload as RunFinishedPayload;
      const bar =
        (event.startsWith('run.') || event === 'flakiness.spike') && run.totalTests > 0 && run.passedTests != null
          ? `<div style="margin-top:8px;">${outcomeBar(runSegments(run), run.totalTests)}</div>`
          : '';
      const title = url
        ? `<a href="${escapeHtml(url)}" style="color:#18181b;font-weight:700;font-size:14px;text-decoration:none;">${escapeHtml(line)}</a>`
        : `<span style="color:#18181b;font-weight:700;font-size:14px;">${escapeHtml(line)}</span>`;
      return `<tr><td style="padding:12px 14px 2px;border:1px solid #e4e4e7;border-left:4px solid ${toneColor(tone)};border-radius:8px;">${title}${bar || '<div style="height:10px;line-height:10px;font-size:1px;">&nbsp;</div>'}</td></tr><tr><td height="10" style="height:10px;font-size:1px;line-height:10px;">&nbsp;</td></tr>`;
    })
    .join('');

  const body =
    (bad > 0
      ? `<p style="margin:0 0 16px;">${badge(`${bad} need${bad === 1 ? 's' : ''} attention`, 'failed')}</p>`
      : '') +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;">${rows}</table>`;
  const html = frame(
    subject,
    {
      tone: bad > 0 ? 'failed' : 'brand',
      label: 'Notification digest',
      headline: `${bigNumber(items.length)} ${items.length === 1 ? 'notification' : 'notifications'}`,
      subline: 'Everything your digest subscriptions collected since the last one',
    },
    body,
    site,
  );

  const text = items
    .map(({ event, payload }) => {
      const path = notificationTargetPath(event, payload);
      return `- ${renderEventSubject(event, payload)}${path ? `\n  ${links.path(path)}` : ''}`;
    })
    .join('\n');
  return { subject, html, text: `${subject}\n\n${text}` };
}
