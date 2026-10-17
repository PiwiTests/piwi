/**
 * Pull-request feedback — settings, and the pure builders that turn a finished
 * run into the comment body and commit-status text posted back to the SCM.
 *
 * Everything here is dependency-free and side-effect-free so both the server
 * and the unit tests can build the exact bytes that get posted. The pieces that
 * talk to GitHub / GitLab live in `server/utils/scm/`.
 */

import type { WireResourceFinding } from '#shared/types';
import { findingView } from '#shared/resource-copy';
import type { PatchCoverage } from '#shared/patch-coverage';
import { coveragePercent } from '#shared/coverage-combine';

/** `app_settings` key holding the resolved `PrFeedbackSettings`. */
export const PR_FEEDBACK_KEY = 'pr_feedback';

/**
 * Marks the comment Piwi owns on a pull request. Kept in an HTML comment so it
 * renders as nothing, and matched on edit so a run updates its previous comment
 * instead of appending a new one to every push.
 */
export const PR_COMMENT_MARKER = '<!-- piwi-dashboard:run-summary -->';

export interface PrFeedbackSettings {
  /** Master switch. Off by default — posting to a PR needs an explicit opt-in. */
  enabled: boolean;
  /** Post (and update) a summary comment on the pull request. */
  comment: boolean;
  /** Post a commit status against the run's commit. */
  status: boolean;
  /**
   * Only post when the run failed. Keeps green runs from adding noise while
   * still flipping the commit status (a status is a state, not a message).
   */
  onlyOnFailure: boolean;
  /** Context label for the commit status, as shown in the PR checks list. */
  statusContext: string;
}

export const DEFAULT_PR_FEEDBACK: PrFeedbackSettings = {
  enabled: false,
  comment: true,
  status: true,
  onlyOnFailure: false,
  statusContext: 'piwi/tests',
};

/** Merge a partial (possibly untrusted) payload onto the defaults. */
export function resolvePrFeedbackSettings(input?: Partial<PrFeedbackSettings> | null): PrFeedbackSettings {
  const context = typeof input?.statusContext === 'string' ? input.statusContext.trim().slice(0, 80) : '';
  return {
    enabled: input?.enabled === true,
    comment: input?.comment !== false,
    status: input?.status !== false,
    onlyOnFailure: input?.onlyOnFailure === true,
    statusContext: context || DEFAULT_PR_FEEDBACK.statusContext,
  };
}

// ── Summary input ────────────────────────────────────────────────────────────

/** One failing test named in the comment. */
export interface PrFailureEntry {
  title: string;
  filePath: string;
  /** The one-line failure headline, plain text; leads the entry when set. */
  headline?: string | null;
  /** The error's message head, already trimmed for display. */
  errorExcerpt: string | null;
  executionId: number;
  /** Set when the failure joined a cluster, so the comment can link the cause. */
  clusterId?: number | null;
  clusterSignature?: string | null;
  /** The tracker issue the failure's cluster is known by, when one exists. */
  issue?: { key: string; url: string } | null;
  /** Ranked replacement suggested for the locator that broke, when there is one. */
  suggestedLocator?: string | null;
  /** An auto-heal PR already open for this locator, so the reader isn't sent to fix it twice. */
  healPrNumber?: number | null;
  healPrUrl?: string | null;
  /** Tags declared on the test, for routing the reader to an owning team. */
  tags?: string[] | null;
  owner?: string | null;
  /**
   * Set when this test is also flaky on the default branch, so the comment can
   * exonerate a failure the change probably did not cause. `flakinessRate` is
   * the test's flaky rate over recent default-branch runs (0–1).
   */
  flakyOnDefaultBranch?: { branch: string; flakinessRate: number } | null;
}

export interface PrSummaryInput {
  runId: number;
  runUrl: string;
  projectName: string;
  status: string;
  totalTests: number;
  passedTests: number;
  failedTests: number;
  flakyTests: number;
  durationMs: number | null;
  /** Failures that did not fail in the baseline — the ones this change caused. */
  newRegressions: PrFailureEntry[];
  /** Failures that were already failing before this change. */
  preExisting: PrFailureEntry[];
  /** Tests that passed only after a retry in this run. */
  flaky: PrFailureEntry[];
  /** `test.fail()` tests that passed: the bug each reproduces looks fixed. */
  looksFixed?: Array<{
    title: string;
    filePath: string;
    executionId: number;
    bugId?: number | null;
    /** The bug id names a report of this project, so the line links it. */
    bugReportExists?: boolean;
  }>;
  /** Failure clusters first seen in this run. */
  newClusters: Array<{ id: number; signature: string; caseCount: number }>;
  /** Clusters this run stopped failing — the answer to "did my fix work?". */
  fixedClusters?: Array<{
    id: number;
    label: string;
    testCount: number;
    /** `diagnosis-verified` means the change touched the file the diagnosis named. */
    verification: 'stopped-failing' | 'diagnosis-verified';
    timeToResolutionMs: number | null;
    /** The auto-heal pull request whose commit landed the fix. */
    healPr?: { number: number; url: string };
  }>;
  /** CI minutes this run spent on waits and failed attempts, when known. */
  wastedMinutes: number | null;
  /** The named selection this run resolved from, when it came from `piwi run`. */
  selection?: { key: string; testCount: number } | null;
  /** Locks held on two shards at once in this run — the guarantee sharding is meant to keep. */
  splitLocks?: string[] | null;
  /** True when no previous green run existed to compare against. */
  hasBaseline: boolean;
  /** Failures of tests that are currently quarantined, counted in `failedTests`. */
  quarantinedFailures?: number;
  /** The project's setting: a quarantined failure still turns the commit status red. */
  quarantineFailsStatus?: boolean;
  /** Uncovered-changes section, when the run was pull-request-stamped with a diff. */
  changeCoverage?: PrChangeCoverage | null;
  /** Locators the diff breaks whose tests this run did not exercise. */
  locatorBreaks?: PrLocatorBreaks | null;
  /** Browsers, contexts and pages this run left open that the base branch never showed. */
  newLeaks?: PrNewLeaks | null;
}

// ── New leaks ────────────────────────────────────────────────────────────────

/** The leaks a run introduces against its base branch. */
export interface PrNewLeaks {
  baseBranch: string;
  leaks: WireResourceFinding[];
}

/** Max new leaks listed in the pull-request comment. */
const MAX_LEAKS_LISTED = 10;

/**
 * Render the new-leaks section: one line per leak the base branch never
 * showed, with the line or fixture that opened it. Null when there is none.
 */
export function renderNewLeaks(nl: PrNewLeaks): string | null {
  if (nl.leaks.length === 0) return null;
  const n = nl.leaks.length;
  const lines = nl.leaks.slice(0, MAX_LEAKS_LISTED).map((finding) => {
    const view = findingView(finding);
    const facts = view.facts.slice(0, 3).join(' · ');
    return `- **${view.label}** · ${codeSpan(view.where ?? '')}${facts ? ` · ${escapeInline(facts)}` : ''}`;
  });
  const blocks = [
    `#### 🟠 Left open by this change (${n})`,
    `Never seen on ${codeSpan(nl.baseBranch)}. Close each before its test ends, or set \`leakCheck: 'fail'\` to catch the next one locally.`,
    lines.join('\n'),
  ];
  if (n > MAX_LEAKS_LISTED) blocks.push(`…and ${n - MAX_LEAKS_LISTED} more`);
  return blocks.join('\n\n');
}

// ── Change coverage ──────────────────────────────────────────────────────────

/** One changed file in the uncovered-changes section. */
export interface PrChangeCoverageFile {
  filePath: string;
  additions: number;
  deletions: number;
  reachedInRun: boolean;
  reachedCountHistory: number;
  /** The suites of the head commit's coverage that ran one of its changed lines. */
  suites?: string[];
  /** A one-line suggestion for the scenario to write, when there is one. */
  draftTitle?: string | null;
}

export interface PrChangeCoverageTicket {
  ticket: string | null;
  files: PrChangeCoverageFile[];
}

/** The pre-shaped uncovered-changes data the comment renders. */
export interface PrChangeCoverage {
  totalFiles: number;
  uncoveredFiles: number;
  reachedFiles: number;
  ticketCount: number;
  windowRuns: number;
  baseBranch: string | null;
  tickets: PrChangeCoverageTicket[];
  /** True when the diff had more changed files than the provider cap returned. */
  filesTruncated?: boolean;
  /** The changed lines the head commit's combined coverage counts. */
  patchCoverage?: PatchCoverage | null;
}

/**
 * The patch coverage line: "Patch coverage 82.9%: 34 of the 41 changed lines
 * ran (unit 28, end to end 19)."
 */
export function renderPatchCoverage(pc: PatchCoverage): string {
  const percent = coveragePercent(pc.executedLines, pc.changedLines);
  const kinds = new Set(pc.suites.map((s) => s.kind));
  const parts = [
    ...(kinds.has('unit') ? [`unit ${pc.unitLines}`] : []),
    ...(kinds.has('e2e') ? [`end to end ${pc.e2eLines}`] : []),
  ];
  const lines = pc.changedLines === 1 ? 'changed line' : 'changed lines';
  let text = `**Patch coverage ${percent}%**: ${pc.executedLines} of the ${pc.changedLines} ${lines} ran`;
  if (parts.length > 0) text += ` (${parts.join(', ')})`;
  text += `, at ${codeSpan(pc.commit.slice(0, 7))}.`;
  if (pc.undeterminedLines > 0) {
    text += ` ${pc.undeterminedLines} more ${pc.undeterminedLines === 1 ? 'is' : 'are'} undetermined: in functions the browser ran.`;
  }
  return text;
}

/** Max uncovered files listed in the pull-request comment. */
const MAX_UNCOVERED_LISTED = 10;

/**
 * Render the uncovered-changes section: the files this change touched that no
 * test reaches, grouped by ticket, each with a draft suggestion. Returns null
 * when there is nothing worth a section (no diff, or every file is reached).
 */
export function renderChangeCoverage(cc: PrChangeCoverage): string | null {
  if (cc.totalFiles === 0) return null;
  const base = cc.baseBranch ? codeSpan(cc.baseBranch) : 'the default branch';
  const bySuites = cc.patchCoverage != null || cc.tickets.some((g) => g.files.some((f) => f.suites?.length));
  const preface = bySuites
    ? `Observed reach, and the lines the head commit's coverage suites ran. Numbers from this run and the last ${cc.windowRuns} on ${base}.`
    : `Observed reach, not instrumented coverage. Numbers from this run and the last ${cc.windowRuns} on ${base}.`;
  const patch = cc.patchCoverage ? renderPatchCoverage(cc.patchCoverage) : null;

  if (cc.uncoveredFiles === 0) {
    const one = cc.totalFiles === 1;
    const reached = bySuites
      ? `All ${cc.totalFiles} changed ${one ? 'file is' : 'files are'} reached.`
      : `All ${cc.totalFiles} changed ${one ? 'file has' : 'files have'} observed reach.`;
    return [`#### 🟣 Uncovered changes · 0 of ${cc.totalFiles} files\n${preface}`, patch, reached]
      .filter(Boolean)
      .join('\n\n');
  }

  const header = `#### 🟣 Uncovered changes · ${cc.uncoveredFiles} of ${cc.totalFiles} files · ${cc.ticketCount} ${cc.ticketCount === 1 ? 'ticket' : 'tickets'}`;
  const blocks: string[] = [header, preface];
  if (patch) blocks.push(patch);

  // One definition of "uncovered" everywhere: no reach in this run and none in
  // the recent window. A file reached only in history is a separate, lower line.
  let listed = 0;
  let historyOnly = 0;
  for (const group of cc.tickets) {
    const lines: string[] = [];
    for (const file of group.files) {
      if (file.reachedInRun || file.suites?.length) continue;
      if (file.reachedCountHistory > 0) {
        historyOnly++;
        continue;
      }
      if (listed >= MAX_UNCOVERED_LISTED) continue;
      listed++;
      let line = `- ${codeSpan(file.filePath)} · changed (+${file.additions} −${file.deletions}) · 0 tests in ${cc.windowRuns} runs`;
      if (file.draftTitle) line += `\n  → *${escapeInline(file.draftTitle)}* · draft`;
      lines.push(line);
    }
    if (lines.length === 0) continue;
    const label = group.ticket ? `**${escapeCell(group.ticket)}**` : '**No ticket**';
    blocks.push([label, ...lines].join('\n'));
  }

  const hidden = cc.uncoveredFiles - listed;
  if (hidden > 0) blocks.push(`…and ${hidden} more`);
  if (cc.filesTruncated) {
    blocks.push('The diff was capped, so more files changed than are counted here.');
  }
  if (historyOnly > 0) {
    blocks.push(
      `${historyOnly} ${historyOnly === 1 ? 'file' : 'files'} reached only in the last ${cc.windowRuns} runs, not this run.`,
    );
  }
  if (cc.reachedFiles > 0) {
    blocks.push(
      `${cc.reachedFiles} ${cc.reachedFiles === 1 ? 'file' : 'files'} reached. Gate \`maxUncoveredChanges\`: warn.`,
    );
  } else {
    blocks.push('Gate `maxUncoveredChanges`: warn.');
  }
  return blocks.join('\n\n');
}

// ── Locator breaks ───────────────────────────────────────────────────────────

/** One locator the diff breaks, as the comment lists it. */
export interface PrLocatorBreak {
  locator: string;
  /** The same chain with the new string; null for a removal or a regex. */
  rewrite: string | null;
  /** The changed application file and its line in the new file. */
  file: string;
  line: number;
  before: string;
  after: string | null;
  /** The translation key, when the string was a translation value. */
  key: string | null;
  testCount: number;
  /** Call sites (`file:line:col`), the most used first. */
  callSites: string[];
}

/** The locators a diff breaks that the run did not exercise. */
export interface PrLocatorBreaks {
  /** Likely breaks whose tests did not run here. */
  breaks: PrLocatorBreak[];
  /** Possible breaks (a bare string matched) left out of the list. */
  possible: number;
  /** The branch whose locator index the diff was matched against. */
  baseBranch: string | null;
}

/** Max locator breaks listed in the pull-request comment. */
const MAX_BREAKS_LISTED = 10;

/**
 * Render the locator-breaks section: the locators whose strings the diff
 * removes or renames and whose tests this run did not exercise (outside the
 * selection, on another shard set, or only in a nightly suite). Null when
 * there is none.
 */
export function renderLocatorBreaks(lb: PrLocatorBreaks): string | null {
  if (lb.breaks.length === 0) return null;
  const n = lb.breaks.length;
  const base = lb.baseBranch ? ` on ${codeSpan(lb.baseBranch)}` : '';
  const blocks = [
    `#### 🟠 Locators this change breaks · ${n} not run here`,
    `The diff removes or renames strings these locators find their element by${base}, and none of their tests ran in this run.`,
  ];
  const lines = lb.breaks.slice(0, MAX_BREAKS_LISTED).map((b) => {
    const change = b.after != null ? `${codeSpan(b.before)} → ${codeSpan(b.after)}` : `${codeSpan(b.before)} removed`;
    const key = b.key ? ` (key ${codeSpan(b.key)})` : '';
    const tests = `${b.testCount} ${b.testCount === 1 ? 'test' : 'tests'}`;
    const site = b.callSites[0] ? ` · ${codeSpan(b.callSites[0].replace(/:\d+$/, ''))}` : '';
    const fix = b.rewrite ? `\n  → ${codeSpan(b.rewrite)}` : '';
    return `- ${codeSpan(`${b.file}:${b.line}`)} ${change}${key}\n  ${codeSpan(b.locator)} · ${tests}${site}${fix}`;
  });
  blocks.push(lines.join('\n'));
  if (n > MAX_BREAKS_LISTED) blocks.push(`…and ${n - MAX_BREAKS_LISTED} more`);
  if (lb.possible > 0) {
    blocks.push(
      `${lb.possible} more ${lb.possible === 1 ? 'locator matches' : 'locators match'} a bare string the diff changes. \`npx @piwitests/reporter preflight\` lists every one.`,
    );
  }
  return blocks.join('\n\n');
}

// ── Rendering ────────────────────────────────────────────────────────────────

const MAX_LISTED = 5;
/** Max characters of an error excerpt quoted in the pull-request comment. */
export const PR_EXCERPT_MAX = 200;

/** Escape the characters that would break out of a markdown table cell. */
function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

/**
 * Wrap arbitrary text as an inline code span that no backtick run can break out
 * of. A backtick inside the text (a file path or branch name may carry one) would
 * otherwise close the span and inject markdown into the comment; the CommonMark
 * rule is a fence one backtick longer than the longest run inside, padded with a
 * space so a leading/trailing backtick is not eaten.
 */
function codeSpan(text: string): string {
  const clean = escapeCell(text);
  const longest = Math.max(0, ...(clean.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  const pad = longest > 0 ? ' ' : '';
  return `${fence}${pad}${clean}${pad}${fence}`;
}

/** Escape inline markdown so a headline's locator quotes and underscores render literally. */
function escapeInline(text: string): string {
  return escapeCell(text).replace(/([\\`*_[\]<>])/g, '\\$1');
}

function formatDuration(ms: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}

/** Coarse age for a cluster's lifetime — days, hours, or minutes. */
function formatAge(ms: number): string {
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function statusEmoji(status: string, failedTests: number): string {
  if (failedTests > 0 || status === 'failed' || status === 'timedout') return '❌';
  if (status === 'interrupted' || status === 'cancelled') return '⚠️';
  return '✅';
}

function renderFailureList(entries: PrFailureEntry[], runUrl: string): string {
  const origin = originOf(runUrl);
  const lines = entries.slice(0, MAX_LISTED).map((entry) => {
    const link = origin
      ? `[${escapeCell(entry.title)}](${origin}/test-run-cases/${entry.executionId})`
      : escapeCell(entry.title);
    const parts = [`- ${link} — ${codeSpan(entry.filePath)}`];
    if (entry.owner) parts.push(`_owner: ${escapeCell(entry.owner)}_`);
    if (entry.tags?.length) parts.push(entry.tags.map((tag) => codeSpan(`@${tag}`)).join(' '));
    let line = parts.join(' · ');
    if (entry.headline) line += `\n  **${escapeInline(entry.headline)}**`;
    if (entry.errorExcerpt) line += `\n  \`\`\`\n  ${escapeCell(entry.errorExcerpt)}\n  \`\`\``;
    if (entry.healPrNumber) {
      const pr = entry.healPrUrl ? `[#${entry.healPrNumber}](${entry.healPrUrl})` : `#${entry.healPrNumber}`;
      line += `\n  🩹 Piwi opened ${pr} to heal this locator.`;
    } else if (entry.suggestedLocator) {
      line += `\n  💡 Try ${codeSpan(entry.suggestedLocator)} instead.`;
    }
    if (entry.flakyOnDefaultBranch) {
      const pct = Math.round(entry.flakyOnDefaultBranch.flakinessRate * 100);
      line += `\n  🎲 Also flaky on ${codeSpan(entry.flakyOnDefaultBranch.branch)} (~${pct}% of recent runs) — likely not yours.`;
    }
    if (entry.issue) {
      line += `\n  🎫 Tracked in [${escapeCell(entry.issue.key)}](${entry.issue.url}).`;
    }
    return line;
  });

  const hidden = entries.length - Math.min(entries.length, MAX_LISTED);
  if (hidden > 0) lines.push(`- …and ${hidden} more`);
  return lines.join('\n');
}

/** The dashboard origin, derived from the run URL so links stay self-hosted. */
function originOf(runUrl: string): string | null {
  try {
    return new URL(runUrl).origin;
  } catch {
    return null;
  }
}

/**
 * Build the markdown comment posted on the pull request.
 *
 * The ordering is deliberate: what this change broke comes first, what was
 * already broken second, and everything else after — a reviewer should be able
 * to stop reading after the first section.
 */
export function buildPrComment(input: PrSummaryInput): string {
  const emoji = statusEmoji(input.status, input.failedTests);
  const sections: string[] = [PR_COMMENT_MARKER];

  sections.push(`### ${emoji} Piwi — ${input.projectName}`);

  const counters = [
    `**${input.passedTests}** passed`,
    `**${input.failedTests}** failed`,
    input.flakyTests > 0 ? `**${input.flakyTests}** flaky` : null,
    `${formatDuration(input.durationMs)}`,
  ].filter(Boolean);
  sections.push(`${counters.join(' · ')} — [full run](${input.runUrl})`);

  if (input.selection) {
    const n = input.selection.testCount;
    sections.push(`🎯 Selection **\`${input.selection.key}\`** — ${n} ${n === 1 ? 'test' : 'tests'}`);
  }

  if (input.splitLocks && input.splitLocks.length > 0) {
    const names = input.splitLocks.map((lock) => codeSpan(lock)).join(', ');
    const plural = input.splitLocks.length === 1 ? 'Lock' : 'Locks';
    sections.push(
      `🔓 ${plural} ${names} held on two shards at once — locks serialize only within one \`playwright test\` process, so sharded runs don't coordinate. Shard with \`piwi run --shard\` (lock-aware) to keep each lock in one shard.`,
    );
  }

  if (input.newRegressions.length > 0) {
    sections.push(
      `#### 🔴 New failures (${input.newRegressions.length})\nNot failing in the last green run.\n\n${renderFailureList(input.newRegressions, input.runUrl)}`,
    );
  }

  if (input.preExisting.length > 0) {
    sections.push(
      `#### 🟠 Pre-existing failures (${input.preExisting.length})\nAlready failing before this change.\n\n${renderFailureList(input.preExisting, input.runUrl)}`,
    );
  }

  if (input.flaky.length > 0) {
    sections.push(
      `#### 🟡 Flaky (${input.flaky.length})\nPassed only after a retry.\n\n${renderFailureList(input.flaky, input.runUrl)}`,
    );
  }

  const looksFixed = input.looksFixed ?? [];
  if (looksFixed.length > 0) {
    const origin = originOf(input.runUrl);
    const list = looksFixed
      .slice(0, MAX_LISTED)
      .map((entry) => {
        const spec = origin ? `[the spec](${origin}/test-run-cases/${entry.executionId})` : 'the spec';
        const bug =
          entry.bugId && entry.bugReportExists && origin
            ? `[bug #${entry.bugId}](${origin}/bug-reports/${entry.bugId})`
            : `bug #${entry.bugId}`;
        const subject = entry.bugId ? `${spec} of ${bug}` : `${spec} ${codeSpan(entry.title)}`;
        return `- ${subject} now passes: remove \`test.fail()\` in ${codeSpan(entry.filePath)}`;
      })
      .join('\n');
    sections.push(
      `#### 🐞 Looks fixed (${looksFixed.length})\nMarked \`test.fail()\` and passed: the bug they reproduce no longer shows.\n\n${list}`,
    );
  }

  if (input.newClusters.length > 0) {
    const origin = originOf(input.runUrl);
    const list = input.newClusters
      .slice(0, MAX_LISTED)
      .map((cluster) => {
        const label = escapeCell(cluster.signature);
        const link = origin ? `[${label}](${origin}/failure-clusters/${cluster.id})` : label;
        return `- ${link} — ${cluster.caseCount} ${cluster.caseCount === 1 ? 'test' : 'tests'}`;
      })
      .join('\n');
    sections.push(`#### 🧩 New failure clusters (${input.newClusters.length})\n${list}`);
  }

  const fixedClusters = input.fixedClusters ?? [];
  if (fixedClusters.length > 0) {
    const origin = originOf(input.runUrl);
    const list = fixedClusters
      .slice(0, MAX_LISTED)
      .map((cluster) => {
        const label = escapeCell(cluster.label);
        const link = origin ? `[${label}](${origin}/failure-clusters/${cluster.id})` : label;
        const tests = `${cluster.testCount} ${cluster.testCount === 1 ? 'test' : 'tests'}`;
        const age = cluster.timeToResolutionMs != null ? `, open ${formatAge(cluster.timeToResolutionMs)}` : '';
        const verified = cluster.verification === 'diagnosis-verified' ? ' — matches the diagnosed change' : '';
        const healed = cluster.healPr
          ? ` — landed by auto-heal [#${cluster.healPr.number}](${cluster.healPr.url})`
          : '';
        return `- ${link} — ${tests}${age}${verified}${healed}`;
      })
      .join('\n');
    sections.push(`#### 🟢 Fixed by this change (${fixedClusters.length})\n${list}`);
  }

  if (input.newLeaks) {
    const section = renderNewLeaks(input.newLeaks);
    if (section) sections.push(section);
  }

  if (input.changeCoverage) {
    const section = renderChangeCoverage(input.changeCoverage);
    if (section) sections.push(section);
  }

  if (input.locatorBreaks) {
    const section = renderLocatorBreaks(input.locatorBreaks);
    if (section) sections.push(section);
  }

  if (!input.hasBaseline && input.failedTests > 0) {
    sections.push(
      '> No previous green run for this project, so failures could not be split into new and pre-existing.',
    );
  }

  if (input.wastedMinutes != null && input.wastedMinutes >= 1) {
    sections.push(`🕒 ${input.wastedMinutes.toFixed(1)} CI minutes went to waits and failed attempts in this run.`);
  }

  if (input.failedTests === 0 && input.flakyTests === 0) {
    sections.push('No failures. 🎉');
  }

  return sections.join('\n\n');
}

/** State vocabulary shared by GitHub commit statuses and GitLab commit statuses. */
export type CommitStatusState = 'success' | 'failure' | 'error' | 'pending';

export interface CommitStatusInput {
  state: CommitStatusState;
  description: string;
  targetUrl: string;
  context: string;
}

type FailureCounts = Pick<PrSummaryInput, 'failedTests' | 'quarantinedFailures' | 'quarantineFailsStatus'>;

/** The run's failures of quarantined tests, at most its failures. */
function quarantinedFailureCount(input: FailureCounts): number {
  return Math.min(input.failedTests, Math.max(0, input.quarantinedFailures ?? 0));
}

/**
 * The failures that count against a run: every failure when the project's
 * `quarantineFailsStatus` is on, else the failures of tests not quarantined.
 */
export function countedFailures(input: FailureCounts): number {
  return input.failedTests - (input.quarantineFailsStatus ? 0 : quarantinedFailureCount(input));
}

/**
 * True when `onlyOnFailure` keeps the comment off a run: no failure counts
 * against it (`countedFailures`), it fixed no cluster and it opened no new leak.
 */
export function isQuietRun(settings: Pick<PrFeedbackSettings, 'onlyOnFailure'>, summary: PrSummaryInput): boolean {
  return (
    settings.onlyOnFailure &&
    countedFailures(summary) === 0 &&
    (summary.fixedClusters?.length ?? 0) === 0 &&
    (summary.newLeaks?.leaks.length ?? 0) === 0
  );
}

/**
 * Build the commit status for a finished run. Failures of quarantined tests
 * leave it green unless the project's `quarantineFailsStatus` says otherwise;
 * the description counts them either way. Descriptions are capped at the 140
 * characters GitHub accepts.
 */
export function buildCommitStatus(input: PrSummaryInput, context: string): CommitStatusInput {
  const quarantined = quarantinedFailureCount(input);
  const failing = countedFailures(input) > 0;
  const parts = [`${input.passedTests}/${input.totalTests} passed`];
  if (input.newRegressions.length > 0) parts.push(`${input.newRegressions.length} new`);
  if (input.flakyTests > 0) parts.push(`${input.flakyTests} flaky`);
  if (quarantined > 0) parts.push(`${quarantined} quarantined`);

  return {
    state: failing ? 'failure' : 'success',
    description: parts.join(', ').slice(0, 140),
    targetUrl: input.runUrl,
    context,
  };
}

/**
 * Build the informational commit status for change coverage. Warn-only in this
 * release, so the state is always `success` — it reports, it never blocks.
 */
export function buildChangeCoverageStatus(cc: PrChangeCoverage, targetUrl: string, context: string): CommitStatusInput {
  const reach =
    cc.uncoveredFiles > 0
      ? `${cc.uncoveredFiles} of ${cc.totalFiles} changed files have no observed reach`
      : `all ${cc.totalFiles} changed files have observed reach`;
  const patch = cc.patchCoverage
    ? `, patch coverage ${coveragePercent(cc.patchCoverage.executedLines, cc.patchCoverage.changedLines)}%`
    : '';
  const description = reach + patch;
  return {
    state: 'success',
    description: description.slice(0, 140),
    targetUrl,
    context,
  };
}

/** The gate verdict and violations `buildGateStatus` reads. */
export interface GateStatusInput {
  verdict: 'passed' | 'failed';
  violations: Array<{ message: string }>;
}

/**
 * Build the `<statusContext>/gate` commit status for a gate evaluation: green
 * when the policy passed, red with the first violation when it failed.
 */
export function buildGateStatus(input: GateStatusInput, targetUrl: string, context: string): CommitStatusInput {
  if (input.verdict === 'passed') {
    return { state: 'success', description: 'Gate policy satisfied', targetUrl, context };
  }
  const count = input.violations.length;
  const first = input.violations[0]?.message ?? 'policy violated';
  const description = count > 1 ? `${count} violations: ${first}` : first;
  return { state: 'failure', description: description.slice(0, 140), targetUrl, context };
}
