/**
 * The pull request auto-heal opens — title and body, built purely so the server
 * and the tests produce the exact same text. The pieces that talk to the SCM
 * live in `server/utils/scm/`.
 */
import type { HealActionPayload, HealEditPayload } from '#shared/auto-heal';

/** Marks the PR auto-heal owns, so a later run can find and adopt it. */
export const HEAL_PR_MARKER = '<!-- piwi-dashboard:auto-heal -->';

/** How many edit rows the body lists before collapsing the rest into a count. */
const MAX_LISTED = 20;

/** Plain-words provenance for an edit's replacement. */
function sourceLabel(edit: HealEditPayload): string {
  if (edit.pickedByUser) return 'your confirmed pick';
  switch (edit.source) {
    case 'prior-run':
      return 'last passing run';
    case 'fingerprint':
      return 'prior run (line shifted)';
    case 'cross-test':
      return 'another test';
    case 'diff-rename':
      return 'rename in the change';
    default:
      return edit.source;
  }
}

/** Escape a cell value for a Markdown table (pipes and backticks). */
function cell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/`/g, '');
}

/**
 * The PR title — the configured commit message, which is a conventional-commit
 * subject so release-please and commitlint accept it. The provider adds any
 * `Draft:` prefix itself where the host needs one.
 */
export function buildHealPrTitle(payload: HealActionPayload): string {
  return payload.commitMessage;
}

export function buildHealPrBody(payload: HealActionPayload, siteUrl: string | null): string {
  const base = siteUrl ? siteUrl.replace(/\/$/, '') : null;
  const edits = payload.edits;
  const n = edits.length;
  const fileCount = new Set(edits.map((e) => e.filePath)).size;

  const lines: string[] = [];
  lines.push(HEAL_PR_MARKER);
  lines.push(
    `## 🩹 Piwi healed ${n} broken locator${n === 1 ? '' : 's'} in ${fileCount} file${fileCount === 1 ? '' : 's'}`,
  );
  lines.push('');
  lines.push(
    'A selector stopped matching its element. Piwi rewrote each failing line to a locator a passing run captured, or ' +
      'to the new string the change itself gave the element. These are deterministic one-line locator edits — no ' +
      'AI-generated changes.',
  );
  lines.push('');

  lines.push('| File | Line | Change | Score | From |');
  lines.push('|---|---|---|---|---|');
  for (const e of edits.slice(0, MAX_LISTED)) {
    const change = `${e.failingLocator ? cell(e.failingLocator) : '?'} → \`${cell(e.suggestedLocator)}\``;
    lines.push(`| \`${cell(e.filePath)}\` | ${e.line} | ${change} | ${e.score ?? '—'} | ${sourceLabel(e)} |`);
  }
  if (n > MAX_LISTED) lines.push(`| … | | …and ${n - MAX_LISTED} more | | |`);
  lines.push('');

  // Clusters this PR closes out, linked when a site URL is known.
  const clusterIds = [...new Set(edits.map((e) => e.clusterId).filter((id): id is number => id != null))];
  if (clusterIds.length) {
    const links = clusterIds.map((id) => (base ? `[#${id}](${base}/failure-clusters/${id})` : `#${id}`));
    lines.push(`**Failure clusters:** ${links.join(' · ')}`);
    lines.push('');
  }

  // Owners named on the affected tests (annotation → CODEOWNERS).
  const owners = [...new Set(edits.map((e) => e.owner).filter((o): o is string => !!o))];
  if (owners.length) {
    lines.push(`**Owners:** ${owners.join(' · ')}`);
    lines.push('');
  }

  lines.push('### Verify');
  lines.push('```bash');
  lines.push(payload.verifyCommand);
  lines.push('```');
  lines.push('');
  lines.push(
    '_Opened automatically by Piwi. Review the diff as you would any change — the evidence points at these ' +
      'locators, but only your suite proves the fix._',
  );

  return lines.join('\n');
}

/** Marks the comment auto-heal posts on its PR once a run on the heal branch passes. */
export const HEAL_BRANCH_VERIFIED_MARKER = '<!-- piwi-dashboard:auto-heal-branch-verified -->';

/**
 * The comment posted on an auto-heal PR the first time a run on its branch
 * passes every healed test. It leaves the PR as it is: marking a draft ready
 * for review stays a person's call.
 */
export function buildHealBranchVerifiedComment(input: {
  runId: number;
  commit: string | null;
  testCount: number;
  siteUrl: string | null;
  draft: boolean;
}): string {
  const base = input.siteUrl ? input.siteUrl.replace(/\/$/, '') : null;
  const run = base ? `[run #${input.runId}](${base}/test-runs/${input.runId})` : `run #${input.runId}`;
  const at = input.commit ? ` at \`${input.commit.slice(0, 7)}\`` : '';
  const tests = `${input.testCount} healed test${input.testCount === 1 ? '' : 's'}`;
  const next = input.draft
    ? 'Mark the pull request ready for review once you have checked the diff.'
    : 'Review the diff as you would any change.';
  return [
    HEAL_BRANCH_VERIFIED_MARKER,
    `✅ **Verified on this branch:** ${run} passed the ${tests}${at}.`,
    '',
    `_${next}_`,
  ].join('\n');
}
