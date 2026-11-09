/**
 * Auto-heal — settings and the durable shapes shared by the server, the demo
 * and the tests.
 *
 * When a locator breaks on the default branch and healing has high-confidence
 * evidence, Piwi opens the fix pull request itself. Writing to a user's
 * repository is the strongest thing the dashboard does, so the posture is
 * deliberately conservative: off by default, an explicit per-project allowlist
 * even once on, draft PRs, one-line locator edits only, and never any model
 * output in the write path.
 *
 * Pure + dependency-free (mirrors `shared/pr-feedback.ts`): the pieces that talk
 * to GitHub / GitLab / Bitbucket live in `server/utils/scm/`, and the
 * orchestration in `server/utils/heal/`.
 */

import { fnv1a32 } from '@piwitests/core/hash';
import type { ScmProviderName } from '#shared/scm-urls';

/** `app_settings` key holding the resolved {@link AutoHealSettings}. */
export const AUTO_HEAL_KEY = 'auto_heal';

export interface AutoHealSettings {
  /** Master switch. Off by default — opening a PR needs an explicit opt-in. */
  enabled: boolean;
  /** Project IDs auto-heal may act on. Empty = no project (allowlist, not denylist). */
  projects: number[];
  /** Minimum recommendation score (0-100) an edit needs to qualify. */
  minScore: number;
  /** Open the PR as a draft (ignored on Bitbucket, which has no draft PRs). */
  draft: boolean;
  /** Cap on auto-heal PRs still open on the SCM per project; merged and closed PRs stop counting. */
  maxOpenPrs: number;
  /** Prefix for the branch auto-heal pushes to. Always ends with `/`. */
  branchPrefix: string;
  /** First line of the commit message. */
  commitMessage: string;
}

export const DEFAULT_AUTO_HEAL: AutoHealSettings = {
  enabled: false,
  projects: [],
  minScore: 80,
  draft: true,
  maxOpenPrs: 3,
  branchPrefix: 'piwi/heal/',
  commitMessage: 'test: heal broken locators',
};

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** Normalize a branch prefix to safe characters, no leading slash, one trailing slash. */
export function normalizeBranchPrefix(input: string): string {
  const cleaned = input
    .trim()
    .replace(/[^A-Za-z0-9._/-]/g, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
  return cleaned ? `${cleaned}/` : DEFAULT_AUTO_HEAL.branchPrefix;
}

/** Merge a partial (possibly untrusted) payload onto the defaults. */
export function resolveAutoHealSettings(input?: Partial<AutoHealSettings> | null): AutoHealSettings {
  const projects = Array.isArray(input?.projects)
    ? [...new Set(input!.projects.filter((n): n is number => Number.isInteger(n) && n > 0))]
    : [];
  const branchPrefix =
    typeof input?.branchPrefix === 'string' && input.branchPrefix.trim()
      ? normalizeBranchPrefix(input.branchPrefix)
      : DEFAULT_AUTO_HEAL.branchPrefix;
  const commitMessage =
    typeof input?.commitMessage === 'string' && input.commitMessage.trim()
      ? input.commitMessage.trim().slice(0, 100)
      : DEFAULT_AUTO_HEAL.commitMessage;
  return {
    enabled: input?.enabled === true,
    projects,
    minScore: clampInt(input?.minScore, 0, 100, DEFAULT_AUTO_HEAL.minScore),
    draft: input?.draft !== false,
    maxOpenPrs: clampInt(input?.maxOpenPrs, 0, 50, DEFAULT_AUTO_HEAL.maxOpenPrs),
    branchPrefix,
    commitMessage,
  };
}

// ── Durable action shapes ────────────────────────────────────────────────────

/** One locator rewrite snapshotted into a heal action at enqueue time. */
export interface HealEditPayload {
  /** Repo-relative file to edit. */
  filePath: string;
  /** 1-based line the rewrite applies to. */
  line: number;
  /** The failing source line (the `-` side), matched before writing. */
  oldLine: string;
  /** The rewritten source line (the `+` side). */
  newLine: string;
  /** The broken locator expression, for the PR body. */
  failingLocator: string | null;
  /** The replacement locator expression. */
  suggestedLocator: string;
  /** Stability score of the replacement, 0-100. */
  score: number | null;
  /** Which healing rung produced it (`prior-run` / `fingerprint` / `cross-test`). */
  source: string;
  /** True when the replacement is a user's confirmed pick. */
  pickedByUser: boolean;
  /** When a person confirmed the pick in the dashboard's snapshot picker, ISO 8601. */
  pickedAt?: string | null;
  /** The failure cluster this edit belongs to, for the PR body links. */
  clusterId: number | null;
  /** The execution the edit was derived from. */
  executionId: number;
  /** The test's title, for the PR body. */
  testTitle: string;
  /** The owning team/person (annotation or CODEOWNERS), for the PR body. */
  owner: string | null;
}

/** Everything needed to open one heal PR, snapshotted so a retry is deterministic. */
export interface HealActionPayload {
  repositoryUrl: string;
  provider: ScmProviderName;
  baseBranch: string;
  /** The commit the failing run was on, used as the branch start point when set. */
  baseSha: string | null;
  branch: string;
  commitMessage: string;
  title: string;
  draft: boolean;
  /** Command that runs exactly the affected tests, shown in the PR body. */
  verifyCommand: string;
  edits: HealEditPayload[];
}

/** What a successful heal action recorded. */
export interface HealActionResult {
  prNumber: number;
  prUrl: string;
  commitSha: string;
  branch: string;
  /** Edits dropped at dispatch time because the head had drifted. */
  droppedEdits?: number;
  /** The latest eligible run on the heal branch. */
  branchRun?: HealBranchRun;
  /** The first run on the heal branch in which every healed test passed. */
  verifiedOnBranch?: HealBranchRun;
}

/** A run on a heal branch, as its action records it. */
export interface HealBranchRun {
  runId: number;
  commit: string | null;
  /** Every healed test ran in it and passed. */
  passed: boolean;
  /** ISO 8601. */
  at: string;
}

/**
 * `processing` is an action a sweep is opening right now; `opened` is a PR still
 * open on the SCM; `merged` and `closed` are the states the PR-state refresh
 * records once the SCM reports it settled.
 */
export type HealActionStatus = 'pending' | 'processing' | 'opened' | 'merged' | 'closed' | 'failed' | 'skipped';

// ── Deterministic identity (dedupe key + branch name) ────────────────────────

/** A stable fingerprint of an edit set — order-independent (call site → target locator). */
export function healSignature(edits: Array<{ filePath: string; line: number; suggestedLocator: string }>): string {
  const parts = edits.map((e) => `${e.filePath}:${e.line}=>${e.suggestedLocator}`).sort();
  return fnv1a32(parts.join('|'));
}

/** The dedupe key — one open-PR action per (project, edit set). Enforced by a unique index. */
export function healDedupeKey(projectId: number, signature: string): string {
  return `heal:v1:${projectId}:${signature}`;
}

/** The branch name auto-heal pushes to: `<prefix><runId>-<sig>`. */
export function healBranchName(branchPrefix: string, runId: number, signature: string): string {
  return `${branchPrefix}${runId}-${signature}`;
}

/**
 * The run id and edit-set signature a heal branch name carries, or null for a
 * branch auto-heal did not name (`healBranchName` is the inverse).
 */
export function parseHealBranch(
  branch: string | null | undefined,
  branchPrefix: string,
): { runId: number; signature: string } | null {
  if (!branch || !branch.startsWith(branchPrefix)) return null;
  const match = /^(\d+)-([0-9a-f]{8})$/.exec(branch.slice(branchPrefix.length));
  if (!match) return null;
  return { runId: Number(match[1]), signature: match[2]! };
}

/**
 * The identity of one edit, across edit sets: the file, the failing locator and
 * the replacement. A PR closed without merging blocks its edits by this key.
 */
export function healEditKey(edit: Pick<HealEditPayload, 'filePath' | 'failingLocator' | 'suggestedLocator'>): string {
  return fnv1a32([edit.filePath, edit.failingLocator ?? '', edit.suggestedLocator].join('\u0000'));
}

/** True when a branch name was produced by auto-heal — used to break the feedback loop. */
export function isHealBranch(branch: string | null | undefined, branchPrefix: string): boolean {
  if (!branch) return false;
  return branch.startsWith(branchPrefix);
}
