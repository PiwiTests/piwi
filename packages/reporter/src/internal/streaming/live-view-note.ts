import type { LiveViewMissing } from '@piwitests/core/live-view';

/**
 * Why a CI run holds no live view key, as the reporter tells it as the run starts (`LiveViewMissing`): a reporter
 * with no instance says so in a line of its own, and a run reporting to the desktop app on this machine says nothing
 * of it.
 */
export type CiLiveViewMissing = Exclude<LiveViewMissing, 'no-instance' | 'local'>;

/**
 * The line a CI run without a live view key prints as it starts: why nobody can watch it, and what turns it on. With
 * `setup-failed`, `failure` is the global setup's error.
 */
export function ciLiveViewNote(why: CiLiveViewMissing, failure: string | null = null): string {
  switch (why) {
    case 'off':
      return "Live view off: nobody can watch this run's tests on the dashboard while it runs. A Project admin turns it on in Project → Settings → Live view, for the runs that start after.";
    case 'unregistered':
      return "Live view unavailable: the reporter's global setup did not register this run as it started (wrapConfig adds it, and it registers a run whose config lists Piwi's reporter), so nobody can watch its tests on the dashboard while it runs.";
    case 'setup-failed':
      return `Live view unavailable: the instance did not register this run as it started${failure ? ` (${failure})` : ''}, so nobody can watch its tests on the dashboard while it runs.`;
    case 'streaming-off':
      return 'Live view unavailable: this run does not stream its results (streaming: false), so nobody can watch its tests on the dashboard while it runs.';
  }
}
