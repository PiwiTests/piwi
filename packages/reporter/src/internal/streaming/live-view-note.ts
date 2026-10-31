/**
 * Why a CI run holds no live view key, as the reporter tells it as the run starts: its project's live view is off on
 * the instance, or the instance predates it (`off`); the reporter's global setup did not register the run
 * (`unregistered`: the reporter entry without `wrapConfig`, or an instance the setup could not reach); the run does
 * not stream its results (`streaming-off`).
 */
export type CiLiveViewMissing = 'off' | 'unregistered' | 'streaming-off';

/** The line a CI run without a live view key prints as it starts: why nobody can watch it, and what turns it on. */
export function ciLiveViewNote(why: CiLiveViewMissing): string {
  switch (why) {
    case 'off':
      return "Live view off: nobody can watch this run's tests on the dashboard while it runs. A Project admin turns it on in Project → Settings → Live view, for the runs that start after.";
    case 'unregistered':
      return "Live view unavailable: the reporter's global setup did not register this run as it started (wrapConfig adds it), so nobody can watch its tests on the dashboard while it runs.";
    case 'streaming-off':
      return 'Live view unavailable: this run does not stream its results (streaming: false), so nobody can watch its tests on the dashboard while it runs.';
  }
}
