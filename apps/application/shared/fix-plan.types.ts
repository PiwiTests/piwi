/**
 * The fix plan shape — everything needed to repair one failure cluster in a
 * single answer. Lives in `shared/` so the server (which builds it), the demo
 * mirror, the Markdown renderer and the dashboard page all speak the same type.
 *
 * The builder is `server/utils/fix-plan.ts#buildFixPlan`; the Markdown rendering
 * is `#shared/fix-plan-markdown`.
 */
import type { PatchValidation } from '#shared/patch';
import type { LocatorEdit } from '#shared/locator-healing.types';
import type { ReproRecipe, BisectResult, BisectedCommit, ReproduceDesktopContext } from '#shared/reproduce';
import type { ClusterSuspectLinesAnswer } from '#shared/suspect-lines';

export interface FixPlanEdit {
  filePath: string;
  /** 1-based line the failing locator sits on, when the trace identified it. */
  line: number | null;
  /** The line as captured, so an agent can match before rewriting. */
  currentLine: string | null;
  /** The locator that broke. */
  failingLocator: string | null;
  /** The ranked replacement to use instead. */
  suggestedLocator: string | null;
  /** Stability score of the suggestion, 0-100. */
  score: number | null;
  /**
   * The ranked replacement as a ready-to-apply edit: the failing line rewritten,
   * plus a git-applyable unified diff. Null when there is no captured source line
   * to rewrite. Deterministic locator-line rewrite only — never model output.
   */
  edit: LocatorEdit | null;
  executionId: number;
}

/**
 * One resolved cluster the open one resembles, with how it was fixed. Surfaced
 * as the "Fixed before" section so the same triage can be reused.
 */
export interface FixedBeforeMatch {
  clusterId: number;
  /** The earlier cluster's title, falling back to its signature. */
  title: string;
  /** Its triage status (a resolved-like one — 'resolved', or a verified fix). */
  status: string;
  /** When the fix landed (fix verification), ISO — null when never recorded. */
  resolvedAt: string | null;
  /** How long it stayed open before the fix, ms — null when unknown. */
  openMs: number | null;
  /** The commit that turned it green, when fix verification recorded one. */
  fixCommit: string | null;
  fixCommitShort: string | null;
  /** Provider commit URL for `fixCommit`, when the repository host is known. */
  fixCommitUrl: string | null;
  /** The earlier cluster's triage note (what a human wrote about the fix). */
  triageNote: string | null;
  /** Effective owner of the earlier cluster's tests (`piwi:owner` annotation). */
  owner: string | null;
  /** One-line summary of the earlier cluster's diagnosis, when it had one not rated unhelpful. */
  diagnosisTitle: string | null;
  /** Whether that diagnosis was marked helpful/unhelpful. */
  diagnosisFeedback: 'up' | 'down' | null;
  /** Why it matched, in one short phrase ("same error and locator"). */
  reason: string;
  /** Match score, 0–1. */
  score: number;
}

export interface FixPlan {
  cluster: {
    id: number;
    title: string | null;
    signature: string;
    errorType: string | null;
    status: string;
    occurrences: number;
    /** Set when a previous fix landed and later broke again. */
    fixVerification: string | null;
  };
  diagnosis: {
    /** The diagnosis row, to name in a fix attempt. */
    id: number;
    /** `agent` when an agent wrote it; otherwise the AI provider. */
    provider: string | null;
    model: string | null;
    category: string | null;
    confidence: string | null;
    rootCause: string | null;
    summary: string | null;
    /** Unified diff proposed by the model. */
    patch: string | null;
    /** Whether that patch still applies to the current source. */
    patchValidation: PatchValidation | null;
  } | null;
  /** Concrete locator rewrites, one per failing call site. */
  edits: FixPlanEdit[];
  failingTests: Array<{ testCaseId: number; title: string; filePath: string; executionId: number }>;
  ownership: { owner: string | null; source: string | null };
  verify: {
    /** Playwright invocation that runs exactly the affected tests. */
    command: string;
    /** What happens on the dashboard when it passes. */
    expectation: string;
    /** The trailer to put in the fix's commit message, so the fix is tied to this cluster. */
    commitTrailer: string;
  };
  /** Copy-paste steps to reproduce the failure locally (checkout, install, run). */
  reproduce: ReproRecipe;
  /** A generated `git bisect` between the last green and the failing commit, or why it is unavailable. */
  bisect: BisectResult;
  /** The first bad commit a desktop bisect found and recorded on this cluster, when one exists. */
  bisectedCommit: BisectedCommit | null;
  /** Everything the desktop shell needs to reproduce and bisect this locally (desktop UI only). */
  reproduceDesktop: ReproduceDesktopContext;
  /**
   * The changed lines the cluster's failing tests executed, most suspect first
   * (at most five): where to look first. Null when they were not computed.
   */
  suspectLines: ClusterSuspectLinesAnswer | null;
  /** Resolved clusters this one resembles, and how each was fixed. Empty when none match. */
  fixedBefore: FixedBeforeMatch[];
  /** The tracker issue this cluster is known by, when one exists. */
  issue: { key: string; url: string; status: string | null } | null;
}
