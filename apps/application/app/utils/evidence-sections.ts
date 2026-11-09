/**
 * Which evidence tab holds each diagnosis/clue section, shared by `EvidenceTabs`
 * (to switch tabs on a citation) and the execution page (to answer, at render
 * time, whether a citation is locatable). Kept out of the component so the
 * page's section locator gives the same answer during SSR and on the client.
 */
export type EvidenceTabValue =
  | 'timeline'
  | 'attempts'
  | 'screen'
  | 'source'
  | 'network'
  | 'console'
  | 'output'
  | 'state'
  | 'performance'
  | 'locators';

export const EVIDENCE_SECTION_TAB: Record<string, EvidenceTabValue> = {
  steps: 'timeline',
  failingSteps: 'timeline',
  testSource: 'source',
  sourceFiles: 'source',
  traceCallStack: 'source',
  networkRequests: 'network',
  serverTraces: 'network',
  serverLogs: 'network',
  backendLogs: 'network',
  traceNetwork: 'network',
  console: 'console',
  appState: 'state',
  environmentDiff: 'state',
  visualDiff: 'screen',
  pageDiff: 'screen',
  domSnapshot: 'screen',
  ariaSnapshot: 'screen',
  screenshots: 'screen',
  tracePointers: 'screen',
  artifacts: 'screen',
  webVitals: 'performance',
};
