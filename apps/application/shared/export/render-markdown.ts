/**
 * Renders an `ExportBundle` as Markdown — for pasting into an issue tracker or
 * handing to an AI agent.
 *
 * It states the same facts as the HTML report (both read `./fields`); only the
 * evidence differs, since images and video cannot travel in Markdown and are
 * listed by name instead.
 */
import { stripAnsi } from '#shared/error-fingerprint';
import {
  caseFacts,
  clusterFacts,
  consoleLine,
  diagnosisFacts,
  fmtBytes,
  fmtDuration,
  fmtStepDuration,
  hasDiagnosis,
  OMISSION_REASONS,
  projectLabel,
  type Fact,
} from './fields';
import { piwiCreditMarkdown } from '#shared/brand';
import type { ExportBundle, ExportCase } from './types';

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

function caseMarkdown(exportCase: ExportCase, headingLevel: '##' | '###'): string[] {
  const d = exportCase.detail as Record<string, any>;
  const sub = headingLevel === '##' ? '###' : '####';

  const out: string[] = [
    `${headingLevel} ${exportCase.title}`,
    '',
    `\`${exportCase.location ?? exportCase.filePath ?? ''}\` — **${exportCase.status}**`,
    '',
    ...factList(caseFacts(exportCase)),
  ];

  if (d.error) out.push(`${sub} Error`, '', fence(String(d.error)), '');
  out.push(...diagnosisMarkdown(exportCase.diagnosis, `${sub} AI diagnosis`));

  if (Array.isArray(d.steps) && d.steps.length) {
    out.push(
      `${sub} Steps`,
      '',
      ...table(
        ['Step', 'Category', 'Duration'],
        (d.steps as Record<string, any>[]).map((s) => [
          String(s.title ?? ''),
          String(s.category ?? ''),
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

export function renderExportMarkdown(bundle: ExportBundle): string {
  const isCluster = bundle.kind === 'cluster';
  const label = projectLabel(bundle);

  const out: string[] = [
    `# ${bundle.title}`,
    '',
    `_${isCluster ? 'Failure cluster' : 'Test execution'} exported ${bundle.generatedAt}${
      bundle.piwiVersion ? ` · Piwi ${bundle.piwiVersion}` : ''
    }_`,
    '',
  ];
  if (label) out.push(`**Project:** ${label}`, '');
  if (bundle.sourceUrl) out.push(`**Source:** ${bundle.sourceUrl}`, '');

  const c = bundle.cluster as Record<string, any> | null;
  if (c) {
    out.push('## Cluster', '', ...factList(clusterFacts(c)));
    if (c.sampleError) out.push('### Representative error', '', fence(String(c.sampleError)), '');
    out.push(...diagnosisMarkdown((c.diagnosis ?? null) as Record<string, any> | null, '### AI diagnosis'));
  }

  for (const exportCase of bundle.cases) out.push(...caseMarkdown(exportCase, isCluster ? '##' : '##'));

  if (bundle.truncatedCases.length) {
    out.push(
      `## Other affected tests (${bundle.truncatedCases.length}, evidence not included)`,
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
