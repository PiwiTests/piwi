/**
 * Render a fix plan as Markdown — the whole plan an agent or a ticket can take
 * away as text. One renderer, used by the dashboard's "Copy as Markdown" button,
 * the `?format=markdown` export endpoint and its demo mirror, so the three can
 * never drift.
 *
 * Every section degrades independently, exactly like the plan itself: a cluster
 * with no diagnosis still renders its failing tests and verification command.
 */
import type { FixPlan } from '#shared/fix-plan.types';
import { reproScript } from '#shared/reproduce';
import { suspectLineMarkdown, suspectLinesLead } from '#shared/suspect-lines';

/** Fenced code block, guarding against a body that already ends in a newline. */
function fence(body: string, lang = ''): string {
  const trimmed = body.replace(/\n+$/, '');
  return `\`\`\`${lang}\n${trimmed}\n\`\`\``;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "12 Jul 2026" in UTC — deterministic, no locale/timezone drift. */
function fixedBeforeDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** "open 2 days" — a coarse duration for how long the earlier cluster stayed open. */
function openDuration(ms: number | null): string | null {
  if (ms == null) return null;
  const days = Math.round(ms / 86_400_000);
  if (days >= 2) return `open ${days} days`;
  const hours = Math.round(ms / 3_600_000);
  if (hours >= 1) return `open ${hours} hour${hours === 1 ? '' : 's'}`;
  const mins = Math.max(1, Math.round(ms / 60_000));
  return `open ${mins} min`;
}

function patchValidationLine(plan: NonNullable<FixPlan['diagnosis']>): string | null {
  const v = plan.patchValidation;
  if (!v) return null;
  const label: Record<string, string> = {
    applies: 'Applies cleanly — verified against the real file at the failing commit',
    'applies-with-offset': 'Applies with offset — context matched at a shifted line',
    'stale-file': 'Does not apply — the file changed since this patch was proposed',
    invalid: 'Invalid diff — could not be parsed as a unified diff',
    unchecked: 'Unverified — the source file was not in context',
  };
  return label[v.status] ?? v.status;
}

/**
 * Build the Markdown rendering of a fix plan. `url` is the cluster page link,
 * appended as a footer when supplied.
 */
export function fixPlanToMarkdown(plan: FixPlan, opts: { url?: string } = {}): string {
  const { cluster, diagnosis, edits, failingTests, ownership, verify, fixedBefore } = plan;
  const lines: string[] = [];

  const title = cluster.title || cluster.signature;
  lines.push(`# Fix plan — ${title}`, '');

  const meta = [
    cluster.errorType,
    `${cluster.occurrences} occurrence${cluster.occurrences === 1 ? '' : 's'}`,
    cluster.status !== 'open' ? `status: ${cluster.status}` : null,
    cluster.fixVerification ? `fix: ${cluster.fixVerification}` : null,
  ].filter(Boolean);
  if (meta.length) lines.push(meta.join(' · '), '');

  // Diagnosis
  if (diagnosis && (diagnosis.summary || diagnosis.rootCause || diagnosis.patch)) {
    lines.push('## Diagnosis', '');
    const badges = [
      diagnosis.category ? `**Category:** ${diagnosis.category}` : null,
      diagnosis.confidence ? `**Confidence:** ${diagnosis.confidence}` : null,
    ].filter(Boolean);
    if (badges.length) lines.push(badges.join(' · '), '');
    if (diagnosis.summary) lines.push(diagnosis.summary, '');
    if (diagnosis.rootCause) lines.push(`**Root cause:** ${diagnosis.rootCause}`, '');
    if (diagnosis.patch) {
      const validation = patchValidationLine(diagnosis);
      if (validation) lines.push(`**Patch validation:** ${validation}`, '');
      lines.push(fence(diagnosis.patch, 'diff'), '');
    }
  }

  // Suspect lines: the changed lines the failing tests executed, where to look first.
  if (plan.suspectLines?.available) {
    lines.push('## Suspect lines', '', suspectLinesLead(plan.suspectLines), '');
    const { suspects, summary } = plan.suspectLines;
    if (suspects.length) {
      const top = suspects.length < summary.executedHunks ? `, the top ${suspects.length}` : '';
      lines.push(`Most suspect first${top}:`, '');
      for (const suspect of suspects) lines.push(suspectLineMarkdown(suspect));
      lines.push('');
    }
  }

  // Fixed before — resolved clusters this one resembles, and how each was fixed.
  if (fixedBefore.length) {
    lines.push('## Fixed before', '');
    for (const m of fixedBefore) {
      const when = fixedBeforeDate(m.resolvedAt);
      const commit = m.fixCommit
        ? m.fixCommitUrl
          ? `[\`${m.fixCommitShort}\`](${m.fixCommitUrl})`
          : `\`${m.fixCommitShort}\``
        : null;
      const head = [
        `**#${m.clusterId} ${m.title}**`,
        when ? `resolved ${when}` : null,
        commit ? `in ${commit}` : null,
        openDuration(m.openMs),
      ]
        .filter(Boolean)
        .join(' · ');
      lines.push(`- ${head} — _${m.reason}_`);
      if (m.diagnosisTitle) lines.push(`  - Diagnosis: ${m.diagnosisTitle}`);
      if (m.triageNote) lines.push(`  - Triage note: ${m.triageNote.replace(/\s+/g, ' ').trim()}`);
      if (m.owner) lines.push(`  - Owner: ${m.owner}`);
    }
    lines.push('');
  }

  // Locator edits
  if (edits.length) {
    lines.push('## Suggested locator edits', '');
    for (const edit of edits) {
      const where = edit.line != null ? `${edit.filePath}:${edit.line}` : edit.filePath;
      lines.push(`### \`${where}\``, '');
      if (edit.failingLocator) lines.push(`- Failing: \`${edit.failingLocator}\``);
      if (edit.suggestedLocator) {
        const score = edit.score != null ? ` (score ${edit.score}/100)` : '';
        lines.push(`- Suggested: \`${edit.suggestedLocator}\`${score}`);
      }
      if (edit.currentLine) lines.push(`- Current line: \`${edit.currentLine.trim()}\``);
      lines.push('');
      if (edit.edit?.unifiedDiff) lines.push(fence(edit.edit.unifiedDiff, 'diff'), '');
    }
  }

  // Failing tests
  if (failingTests.length) {
    lines.push('## Failing tests', '');
    for (const test of failingTests) {
      lines.push(`- ${test.title} — \`${test.filePath}\` (execution #${test.executionId})`);
    }
    lines.push('');
  }

  // Owner
  if (ownership.owner) {
    const source = ownership.source ? ` (${ownership.source})` : '';
    lines.push('## Owner', '', `${ownership.owner}${source}`, '');
  }

  // Verify
  lines.push('## Verify', '', fence(verify.command), '', verify.expectation, '');
  if (verify.commitTrailer) lines.push('Commit trailer:', '', fence(verify.commitTrailer), '');

  // Reproduce locally — the commands are git/npm/npx, identical on every OS.
  if (plan.reproduce.steps.length) {
    lines.push('## Reproduce locally', '', fence(reproScript(plan.reproduce, 'bash'), 'bash'), '');
    for (const e of plan.reproduce.env) lines.push(`- ${e.label}: ${e.value}`);
    if (plan.reproduce.env.length) lines.push('');
    for (const note of plan.reproduce.notes) lines.push(`> ${note}`);
    if (plan.reproduce.notes.length) lines.push('');
  }

  // Bisect
  if (plan.bisect.available) {
    lines.push('## Bisect the regression', '', fence(plan.bisect.bash, 'bash'), '', plan.bisect.explanation, '');
  } else {
    lines.push('## Bisect the regression', '', plan.bisect.reason, '');
  }
  if (plan.bisectedCommit) {
    const c = plan.bisectedCommit;
    const who = [c.author, c.date].filter(Boolean).join(', ');
    const suffix = who ? ` (${who})` : '';
    const subject = c.subject ? ` — ${c.subject}` : '';
    lines.push(`Bisected to \`${c.sha.slice(0, 12)}\`${subject}${suffix}.`, '');
  }

  // Links — the tracker issue this cluster is known by, when one exists.
  if (plan.issue) {
    const status = plan.issue.status ? ` (${plan.issue.status})` : '';
    lines.push('## Links', '', `- Tracked in [${plan.issue.key}](${plan.issue.url})${status}`, '');
  }

  if (opts.url) lines.push('---', '', `[Open this cluster in Piwi](${opts.url})`, '');

  return (
    lines
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trimEnd() + '\n'
  );
}
