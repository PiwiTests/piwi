/**
 * The diagnosis context limits of Settings → AI, grouped by the evidence they
 * bound. Every field of `CONTEXT_LIMIT_FIELDS` is in exactly one group
 * (`tests/unit/ai-provider-catalog.test.ts`).
 */
import type { ContextLimits } from '#shared/ai-context-limits';

export interface ContextLimitGroup {
  id: string;
  title: string;
  /** What this evidence is, as sent to the model. */
  sends: string;
  fields: (keyof ContextLimits)[];
}

export const CONTEXT_LIMIT_GROUPS: ContextLimitGroup[] = [
  {
    id: 'error',
    title: 'Error and test',
    sends: 'Error text, test titles and file paths, the test source, recent steps and the affected tests',
    fields: ['sampleErrorChars', 'testSourceChars', 'steps', 'affectedTests', 'maxPassedPeers', 'aiStepIntents'],
  },
  {
    id: 'console',
    title: 'Browser console',
    sends: 'Errors and warnings logged before the failure',
    fields: ['consoleEntries', 'consoleEntryChars', 'maxConsoleWindow'],
  },
  {
    id: 'network',
    title: 'Network',
    sends: 'URLs and status codes of failed and slow requests',
    fields: ['networkRequests', 'slowRequestMs'],
  },
  {
    id: 'page',
    title: 'Page and screenshots',
    sends: 'The ARIA snapshot, the DOM at the failure, and screenshots',
    fields: ['ariaSnapshotChars', 'domSnapshotChars', 'maxImages', 'imageMaxEdge'],
  },
  {
    id: 'trace',
    title: 'Playwright trace',
    sends: 'Actions, call stack, DOM and requests around the failing step',
    fields: ['maxTraceActions', 'traceStackFrames', 'traceDomChars', 'traceNetworkRequests'],
  },
  {
    id: 'source',
    title: 'Source code and commits',
    sends: 'Commits since the last passing run, changed files and their diffs, read with the repository token',
    fields: ['scmPatchBudget', 'maxSourceFiles', 'sourceFileChars'],
  },
  {
    id: 'server',
    title: 'Server logs and traces',
    sends: 'Backend logs and spans your app returns in the X-Piwi-Logs and X-Piwi-Trace headers',
    fields: ['serverLogEntries', 'serverLogEntryChars', 'serverTraceSpans'],
  },
];

/** The limits a provider that reads text only never uses. */
export const IMAGE_LIMIT_FIELDS: (keyof ContextLimits)[] = ['maxImages', 'imageMaxEdge'];
