/** How the panel names and colors what an answer shows: entity kinds, outcomes, routes. */
import type { AssistantEntityType } from '#shared/assistant';
import { statusPaletteKey, type StatusPaletteKey } from '~/utils/status-palette';

/** What a person calls each kind of entity. */
export const ASSISTANT_ENTITY_LABELS: Record<AssistantEntityType, string> = {
  project: 'Project',
  run: 'Test run',
  execution: 'Execution',
  cluster: 'Failure cluster',
  'test-case': 'Test',
};

/** The test and run outcomes, whose color is the Test outcome colors' (`STATUS_PALETTE`). */
const OUTCOMES: ReadonlySet<string> = new Set([
  'passed',
  'failed',
  'timedout',
  'timedOut',
  'interrupted',
  'flaky',
  'skipped',
  'fixme',
  'didnotrun',
  'running',
  'initializing',
  'finalizing',
]);

/** The outcome color of `status`, or null when it is not a test or run outcome (a cluster's state, say). */
export function assistantOutcome(status: string | null | undefined): StatusPaletteKey | null {
  return status && OUTCOMES.has(status) ? statusPaletteKey(status) : null;
}

/** Whether `route` is a path of this app (`/test-runs/12`), which a link may open in place. */
export function isAppRoute(route: string): boolean {
  return /^\/(?![/\\])/.test(route) && !/[\s\\]/.test(route);
}
