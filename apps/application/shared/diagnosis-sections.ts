/**
 * Canonical list of evidence sections that can feed an AI diagnosis. Single
 * source of truth shared by:
 *  - the server "Data Coverage" block (server/utils/ai-context.ts)
 *  - the result's evidence citation chips (DiagnosisResult.vue)
 *  - the context modal's coverage panel (DiagnosisContextModal.vue)
 *
 * `label` is the long human name; `short` is used on compact citation chips.
 */
export interface DiagnosisSectionMeta {
  id: string;
  label: string;
  short: string;
}

export const DIAGNOSIS_SECTIONS: DiagnosisSectionMeta[] = [
  { id: 'clusterSummary', label: 'Failure cluster summary', short: 'Cluster' },
  { id: 'sampleError', label: 'Raw error message', short: 'Error' },
  { id: 'representativeExecution', label: 'Representative execution overview', short: 'Execution' },
  { id: 'executionError', label: 'Representative execution error', short: 'Error' },
  { id: 'clues', label: 'Deterministic clues (rule-based correlations)', short: 'Clues' },
  { id: 'runContext', label: 'Run context (partial run, parallelism, flaky class)', short: 'Run context' },
  { id: 'testAnnotations', label: 'Test annotations (@fixme/@flaky …)', short: 'Annotations' },
  { id: 'affectedTests', label: 'Affected tests', short: 'Tests' },
  { id: 'testSource', label: 'Test source code', short: 'Source' },
  { id: 'sourceFiles', label: 'Full source files (suspect + imports)', short: 'Files' },
  { id: 'steps', label: 'Test steps', short: 'Steps' },
  { id: 'failingSteps', label: 'Failing steps', short: 'Steps' },
  { id: 'aiSteps', label: 'AI-step prompts (natural-language intents)', short: 'AI steps' },
  { id: 'console', label: 'Browser console logs', short: 'Console' },
  { id: 'dialogs', label: 'Browser dialogs', short: 'Dialogs' },
  { id: 'networkRequests', label: 'Network requests', short: 'Network' },
  { id: 'serverLogs', label: 'Backend server logs', short: 'Server logs' },
  { id: 'serverTraces', label: 'Server traces (spans)', short: 'Traces' },
  { id: 'webVitals', label: 'Web vitals', short: 'Web vitals' },
  { id: 'appState', label: 'App state at test end (URL/storage/cookies)', short: 'App state' },
  { id: 'ariaSnapshot', label: 'ARIA snapshot', short: 'ARIA' },
  { id: 'domSnapshot', label: 'DOM snapshot from trace (failure time)', short: 'DOM' },
  { id: 'screenshots', label: 'Screenshots (attached as images)', short: 'Screenshots' },
  { id: 'visualDiff', label: 'Visual diff vs last passing screenshot', short: 'Visual diff' },
  { id: 'pageDiff', label: 'Page structure diff vs last green sample', short: 'Page diff' },
  { id: 'browserDistribution', label: 'Browser distribution', short: 'Browsers' },
  { id: 'recurrenceFlakiness', label: 'Recurrence & flakiness', short: 'Flakiness' },
  { id: 'baselineComparison', label: 'Compared to last pass (duration/vitals/steps)', short: 'Baseline' },
  { id: 'environmentDiff', label: 'Environment diff vs last pass', short: 'Env diff' },
  { id: 'coverageDivergence', label: 'Code paths vs last pass (coverage)', short: 'Code paths' },
  { id: 'retryProgression', label: 'Retry progression (per-attempt errors)', short: 'Retries' },
  { id: 'passedPeers', label: 'Passing peers in same file', short: 'Peers' },
  { id: 'scmInvestigation', label: 'SCM diff since last green', short: 'SCM diff' },
  { id: 'suspectLines', label: 'Changed lines the failing tests executed (suspect lines)', short: 'Suspect lines' },
  { id: 'selectedCommits', label: 'Manually selected commits', short: 'Commits' },
  { id: 'priorDiagnosis', label: 'Prior diagnosis & triage', short: 'Prior' },
  { id: 'previouslyFixed', label: 'Previously fixed similar failure', short: 'Fixed before' },
  { id: 'tracePointers', label: 'Trace files', short: 'Traces' },
  { id: 'artifacts', label: 'Attachments & artifacts (video, HAR)', short: 'Artifacts' },
  { id: 'nearestAriaNames', label: 'Nearest matching ARIA names from snapshot', short: 'Nearest ARIA' },
  { id: 'alreadyGreen', label: 'Baseline freshness / already-green check', short: 'Already green' },
  { id: 'topSuspectedCommit', label: 'Top suspected commit', short: 'Top commit' },
  { id: 'failingAction', label: 'Failing action from trace parsing', short: 'Trace' },
  { id: 'traceCallStack', label: 'Full call stack with source (from trace)', short: 'Call stack' },
  { id: 'traceNetwork', label: 'Network activity from trace (all requests)', short: 'Trace net' },
  { id: 'locatorHealing', label: 'Alternative locators from prior success', short: 'Alt locators' },
];

const SECTION_IDS = new Set(DIAGNOSIS_SECTIONS.map((s) => s.id));

/** Short label for a section id (falls back to the id itself). */
export const DIAGNOSIS_SECTION_SHORT: Record<string, string> = Object.fromEntries(
  DIAGNOSIS_SECTIONS.map((s) => [s.id, s.short]),
);

export function isKnownSectionId(id: string): boolean {
  return SECTION_IDS.has(id);
}

/**
 * Extract the `[sectionId]` citations the model embedded in evidence strings.
 * Returns the unique, known section ids in first-seen order.
 */
export function extractCitedSectionIds(texts: Array<string | null | undefined>): string[] {
  const found = new Set<string>();
  for (const t of texts) {
    if (!t) continue;
    for (const m of String(t).matchAll(/\[([a-zA-Z][a-zA-Z0-9]*)]/g)) {
      if (SECTION_IDS.has(m[1]!)) found.add(m[1]!);
    }
  }
  return [...found];
}
