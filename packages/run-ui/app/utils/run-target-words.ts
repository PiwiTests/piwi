import type { RunRequestPromptView, RunTargetConnectionView } from '@piwitests/editor/run-target-view';

/** What the connection card says of each state of the connection to a team instance. */
export const CONNECTION_WORDS: Record<RunTargetConnectionView['state'], string> = {
  none: 'Not connected',
  'signing-in': 'Waiting for you to allow this app on the instance',
  connecting: 'Connecting',
  online: 'Connected: requests from your pages come here',
  offline: 'Connected, the instance does not answer: trying again',
  revoked: 'Disconnected by the instance',
};

/** The icon and the text color of each level of a request's checks. */
export const CHECK_ICONS = {
  ok: 'i-lucide-circle-check',
  warn: 'i-lucide-triangle-alert',
  fail: 'i-lucide-circle-x',
} as const;
export const CHECK_COLORS = { ok: 'text-success', warn: 'text-warning', fail: 'text-error' } as const;

/** The host of a team instance's address, the address itself when it is not a URL, and a name for none. */
export function teamInstanceHost(instance: string | null | undefined): string {
  if (!instance) return 'your team instance';
  try {
    return new URL(instance).host;
  } catch {
    return instance;
  }
}

/** The number of tests a request asks for: `a test` or `3 tests`. */
export function testCountWords(count: number): string {
  return count === 1 ? 'a test' : `${count} tests`;
}

/** The options of a request as short phrases. */
export function optionWords(options: RunRequestPromptView['options'] | null | undefined): string[] {
  if (!options) return [];
  return [
    options.headed ? 'headed' : 'headless',
    options.trace ? `trace ${options.trace}` : null,
    options.repeatEach && options.repeatEach > 1 ? `repeat ${options.repeatEach}×` : null,
    options.workers ? `${options.workers} workers` : null,
    options.project ? `project ${options.project}` : null,
  ].filter((word): word is string => !!word);
}

/** What a card for the connection says it is for. */
export const CONNECTION_INTRO =
  'Take run requests from your team instance: a test you open there runs here, in a browser on your screen.';
