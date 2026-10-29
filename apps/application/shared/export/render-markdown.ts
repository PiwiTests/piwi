/**
 * Renders an `ExportBundle` as Markdown — for pasting into an issue tracker or
 * handing to an AI agent.
 *
 * It states the same facts as the HTML report (both read `./fields`); only the
 * evidence differs, since images and video cannot travel in Markdown and are
 * listed by name instead.
 */
import { stripAnsi } from '#shared/error-fingerprint';
import { stepLabel } from '@piwitests/core/step-analysis';
import {
  caseFacts,
  caseHeadline,
  caseLabels,
  casePath,
  clusterFacts,
  clusterHeadline,
  clusterOccurrences,
  clusterOccurrencesText,
  clusterOwner,
  clusterState,
  consoleLine,
  diagnosisFacts,
  fmtBytes,
  fmtDate,
  fmtDuration,
  fmtStepDuration,
  hasDiagnosis,
  OMISSION_REASONS,
  projectLabel,
  runFacts,
  runFailureGroups,
  runHeadline,
  runSummaryFacts,
  runTestsByOutcome,
  runTestDuration,
  runTestStatus,
  slowestTests,
  statusLabel,
  type Fact,
} from './fields';
import { outcomeText } from '#shared/notifications/message-parts';
import { piwiCreditMarkdown } from '#shared/brand';
import type { ExportBundle, ExportCase, ExportRun } from './types';

function fence(text: string, lang = ''): string {
  return `\`\`\`${lang}\n${stripAnsi(text).replace(/```/g, '\\`\\`\\`')}\n\`\`\``;
}

function factList(facts: Fact[]): string[] {
  const present = facts.filter(([, v]) => v != null && v !== '');
  return present.length ? [...present.map(([k, v]) => `- **${k}:** ${v}`), ''] : [];
}

function table(headers: string[], rows: string[][]): string[] {
  if (!rows.length) return [];
  const esc = (c: string) => c.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.map(esc).join(' | ')} |`),
    '',
  ];
}

function diagnosisMarkdown(diagnosis: Record<string, any> | null, heading: string): string[] {
  if (!hasDiagnosis(diagnosis)) return [];
  const d = diagnosis as Record<string, any>;
  const det = (d.details ?? {}) as Record<string, any>;

  const out: string[] = [heading, '', ...factList(diagnosisFacts(d))];
  if (d.summary) out.push(String(d.summary), '');
  if (d.rootCause) out.push(`**Root cause:** ${d.rootCause}`, '');

  const evidence = (det.evidence ?? []) as unknown[];
  if (evidence.length) out.push('**Evidence:**', ...evidence.map((e) => `- ${String(e)}`), '');

  const fix = (det.suggestedFix ?? null) as Record<string, any> | null;
  if (fix) {
    out.push('**Suggested fix:**', '');
    if (fix.description) out.push(String(fix.description), '');
    if (fix.patch) out.push(fence(String(fix.patch), 'diff'), '');
    else if (fix.code) out.push(fence(String(fix.code)), '');
  }
  return out;
}

/** A run's context and its tests by outcome, under `heading`. */
function runMarkdown(run: Record<string, any> | null | undefined, heading: string): string[] {
  const facts = factList(runFacts(run ?? {}));
  const outcome = runTestsByOutcome(run);
  if (!facts.length && !outcome) return [];
  return [heading, '', ...facts, ...(outcome ? [outcomeText(outcome.segments, outcome.total), ''] : [])];
}

function caseMarkdown(exportCase: ExportCase, headingLevel: '##' | '###', withRun = true): string[] {
  const d = exportCase.detail as Record<string, any>;
  const sub = headingLevel === '##' ? '###' : '####';
  const path = casePath(exportCase);
  const headline = caseHeadline(exportCase);
  const labels = caseLabels(exportCase);

  const out: string[] = [
    `${headingLevel} ${exportCase.title}`,
    '',
    `\`${exportCase.location ?? exportCase.filePath ?? ''}\` — **${exportCase.status}**`,
    '',
  ];
  if (path) out.push(path, '');
  if (labels.length) out.push(labels.map((l) => l.text).join(' · '), '');
  if (headline) out.push(`**${headline.headline}**${headline.detail ? `  \n${headline.detail}` : ''}`, '');
  out.push(...factList(caseFacts(exportCase)));
  if (withRun) out.push(...runMarkdown(d.testRun, `${sub} The run`));

  if (d.error) out.push(`${sub} Error`, '', fence(String(d.error)), '');
  out.push(...diagnosisMarkdown(exportCase.diagnosis, `${sub} AI diagnosis`));

  if (Array.isArray(d.steps) && d.steps.length) {
    out.push(
      `${sub} Steps`,
      '',
      ...table(
        ['Step', 'Category', 'Duration'],
        (d.steps as Record<string, any>[]).map((s) => [
          stepLabel(s),
          [String(s.category ?? ''), s.failed ? 'failed' : s.recovered ? 'recovered' : ''].filter(Boolean).join(' · '),
          fmtStepDuration(s, d.pauses),
        ]),
      ),
    );
  }

  if (Array.isArray(d.consoleLogs) && d.consoleLogs.length) {
    out.push(`${sub} Console`, '', fence((d.consoleLogs as Record<string, any>[]).map(consoleLine).join('\n')), '');
  }

  if (Array.isArray(d.networkRequests) && d.networkRequests.length) {
    out.push(
      `${sub} Network`,
      '',
      ...table(
        ['Method', 'Status', 'Time', 'URL'],
        (d.networkRequests as Record<string, any>[]).map((r) => [
          String(r.method ?? ''),
          String(r.status ?? ''),
          fmtDuration(r.duration),
          String(r.url ?? ''),
        ]),
      ),
    );
  }

  if (d.testSource) out.push(`${sub} Test source`, '', fence(String(d.testSource), 'ts'), '');

  if (Array.isArray(d.testSourceFrames) && d.testSourceFrames.length) {
    out.push(`${sub} Call stack`, '');
    for (const f of d.testSourceFrames as Record<string, any>[]) {
      out.push(`\`${f.file ?? ''}:${f.line ?? ''}\``, '', fence(String(f.snippet ?? ''), 'ts'), '');
    }
  }

  if (d.ariaSnapshot) out.push(`${sub} ARIA snapshot`, '', fence(String(d.ariaSnapshot), 'yaml'), '');
  if (d.pageState) out.push(`${sub} Page state`, '', fence(JSON.stringify(d.pageState, null, 2), 'json'), '');
  if (d.webVitals) out.push(`${sub} Web vitals`, '', fence(JSON.stringify(d.webVitals, null, 2), 'json'), '');

  if (exportCase.assets.length) {
    out.push(
      `${sub} Evidence files`,
      '',
      ...table(
        ['File', 'Kind', 'Size'],
        exportCase.assets.map((a) => [a.name, a.kind, fmtBytes(a.size)]),
      ),
    );
  }
  return out;
}

/** The top of a run export: the run, its failures by root cause, its flaky and slowest tests, and every test. */
function runSummaryMarkdown(run: ExportRun): string[] {
  const d = run.detail as Record<string, any>;
  const out: string[] = [];
  const where = [d.branch, d.environment].filter(Boolean).join(' · ');
  const headline = runHeadline(d);
  out.push(`**${String(d.status ?? 'unknown')}**${where ? ` · ${where}` : ''}${headline ? ` · ${headline}` : ''}`, '');
  out.push(...factList(runSummaryFacts(run)));
  out.push(...runMarkdown(d, '## The run'));

  const groups = runFailureGroups(run);
  if (groups.length) {
    out.push('## Failures by root cause', '');
    for (const g of groups) {
      const meta = [g.isNew ? 'new' : null, g.status, `${g.tests.length} ${g.tests.length === 1 ? 'test' : 'tests'}`];
      out.push(`### ${g.title}`, '', `_${meta.filter(Boolean).join(' · ')}_`, '');
      if (g.diagnosis) out.push(g.diagnosis, '');
      for (const t of g.tests) {
        out.push(
          `- **${statusLabel(runTestStatus(t))}** ${t.title} — \`${t.location ?? ''}\`${t.browser ? ` (${t.browser})` : ''}`,
          ...(t.error && !t.flaky ? [`  \`${t.error.replace(/`/g, "'")}\``] : []),
        );
      }
      out.push('');
    }
  }

  const flaky = run.tests.filter((t) => t.flaky);
  if (flaky.length) {
    out.push(
      '## Flaky tests',
      '',
      ...table(
        ['Test', 'Location', 'Browser', 'Retries', 'Duration'],
        flaky.map((t) => [t.title, t.location ?? '', t.browser ?? '', String(t.retries), runTestDuration(t)]),
      ),
    );
  }

  const slowest = slowestTests(run.tests);
  if (slowest.length) {
    out.push(
      '## Slowest tests',
      '',
      ...table(
        ['Test', 'Browser', 'Duration'],
        slowest.map((t) => [t.title, t.browser ?? '', runTestDuration(t)]),
      ),
    );
  }

  if (run.tests.length) {
    out.push(
      `## All tests (${run.tests.length})`,
      '',
      ...table(
        ['Status', 'Test', 'Location', 'Browser', 'Duration', 'Retries'],
        run.tests.map((t) => [
          statusLabel(runTestStatus(t)),
          [...t.suitePath, t.title].join(' › '),
          t.location ?? '',
          t.browser ?? '',
          runTestDuration(t),
          String(t.retries),
        ]),
      ),
    );
  }
  return out;
}

const KIND_LABELS: Record<ExportBundle['kind'], string> = {
  execution: 'Test execution',
  cluster: 'Failure cluster',
  run: 'Test run',
};

export function renderExportMarkdown(bundle: ExportBundle): string {
  const isRun = bundle.kind === 'run';
  const label = projectLabel(bundle);

  const out: string[] = [
    `# ${bundle.title}`,
    '',
    `_${KIND_LABELS[bundle.kind]} exported ${fmtDate(bundle.generatedAt) ?? bundle.generatedAt}${
      bundle.piwiVersion ? ` · Piwi ${bundle.piwiVersion}` : ''
    }_`,
    '',
  ];
  if (label) out.push(`**Project:** ${label}`, '');
  if (bundle.sourceUrl) out.push(`**Source:** ${bundle.sourceUrl}`, '');

  const c = bundle.cluster as Record<string, any> | null;
  if (c) {
    out.push('## Cluster', '');
    const headline = clusterHeadline(c);
    const state = clusterState(c);
    const owner = clusterOwner(c);
    const occurrences = clusterOccurrencesText(clusterOccurrences(c));
    if (headline) out.push(`**${headline.headline}**${headline.detail ? `  \n${headline.detail}` : ''}`, '');
    if (state) out.push(state, '');
    if (owner) out.push(`Owner ${owner}`, '');
    if (occurrences) out.push(`${occurrences}.`, '');
    out.push(...factList(clusterFacts(c)));
    if (c.sampleError) out.push('### Representative error', '', fence(String(c.sampleError)), '');
    out.push(...diagnosisMarkdown((c.diagnosis ?? null) as Record<string, any> | null, '### AI diagnosis'));
  }

  if (isRun && bundle.run) out.push(...runSummaryMarkdown(bundle.run));
  if (isRun && bundle.cases.length) out.push('## Failures in detail', '');
  for (const exportCase of bundle.cases) out.push(...caseMarkdown(exportCase, isRun ? '###' : '##', !isRun));

  if (bundle.truncatedCases.length) {
    const others = isRun ? 'Other failing tests' : 'Other affected tests';
    out.push(
      `## ${others} (${bundle.truncatedCases.length}, evidence not included)`,
      '',
      ...bundle.truncatedCases.map((t) => `- ${t.title} — \`${t.filePath ?? ''}\``),
      '',
    );
  }

  if (bundle.omitted.length) {
    out.push(
      '## Omitted from this export',
      '',
      ...table(
        ['File', 'Kind', 'Size', 'Reason'],
        bundle.omitted.map((o) => [o.name, o.kind, fmtBytes(o.bytes), OMISSION_REASONS[o.reason] ?? o.reason]),
      ),
    );
  }

  out.push('', '---', '', `_${piwiCreditMarkdown('Generated by Piwi')}_`, '');
  return out.join('\n');
}
