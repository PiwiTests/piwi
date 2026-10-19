import type { AiAttachedImage } from './ai-provider';
import type { DiagnosisContextCoverage } from '~~/types/api';
import type { ScmChanges } from './scm/ScmProvider';

export type DiagnosisScope =
  | { kind: 'cluster'; clusterId: number }
  | { kind: 'execution'; executionId: number; clusterId?: number };

export interface BuildContextOptions {
  baseCommit?: string;
  selectedCommitShas?: string[];
  /** When true, resolve screenshot data URLs into `images`. Default true. */
  includeImages?: boolean;
  /**
   * Build for a provider that reads text only (the local Claude CLI): no
   * screenshot or visual-diff overlay is attached, and the prompt `text` names
   * none. `sections` are the same as without it.
   */
  textOnly?: boolean;
  /**
   * Skip the SCM investigation network fetch (diff since last green + selected
   * commit diffs). Used by the two-stage pipeline to keep the research pass
   * cheap and to only pay for the SCM fetch when it's actually needed.
   */
  skipScm?: boolean;
}

export type SectionId =
  | 'clusterSummary'
  | 'sampleError'
  | 'affectedTests'
  | 'browserDistribution'
  | 'representativeExecution'
  | 'executionError'
  | 'clues'
  | 'runContext'
  | 'testAnnotations'
  | 'testSource'
  | 'sourceFiles'
  | 'steps'
  | 'failingSteps'
  | 'aiSteps'
  | 'console'
  | 'networkRequests'
  | 'serverLogs'
  | 'serverTraces'
  | 'webVitals'
  | 'ariaSnapshot'
  | 'screenshots'
  | 'recurrenceFlakiness'
  | 'baselineComparison'
  | 'retryProgression'
  | 'scmInvestigation'
  | 'suspectLines'
  | 'selectedCommits'
  | 'priorDiagnosis'
  | 'previouslyFixed'
  | 'passedPeers'
  | 'tracePointers'
  | 'artifacts'
  | 'nearestAriaNames'
  | 'alreadyGreen'
  | 'topSuspectedCommit'
  | 'failingAction'
  | 'traceCallStack'
  | 'traceNetwork'
  | 'locatorHealing'
  | 'environmentDiff'
  | 'coverageDivergence'
  | 'visualDiff'
  | 'domSnapshot'
  | 'appState';

export interface ContextSection {
  id: SectionId;
  title: string;
  chars: number;
  truncated: boolean;
  markdown: string;
  items?: number;
}

export interface BuiltDiagnosisContext {
  scope: DiagnosisScope;
  text: string;
  sections: ContextSection[];
  coverage: DiagnosisContextCoverage;
  scmChanges: ScmChanges | null;
  images?: AiAttachedImage[];
  /**
   * Full content of the source files fetched into the `sourceFiles` section,
   * keyed by repo-relative path. Used to validate a suggested patch against the
   * exact bytes the model was shown (see `validatePatch`).
   */
  sourceFiles?: Array<{ path: string; content: string }>;
  /** Total estimated input tokens (text + images). */
  tokenEstimate: number;
  /** Estimated tokens from the text context alone (≈ chars / 4). */
  textTokenEstimate: number;
  /** Estimated tokens from attached images (fixed per-image vision cost). */
  imageTokenEstimate: number;
  cluster?: {
    id: number;
    signature: string;
    occurrences: number;
    pattern: 'intermittent' | 'persistent' | 'unknown';
  };
}
