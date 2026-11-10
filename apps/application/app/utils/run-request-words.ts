import { FINAL_RUN_REQUEST_STATES, type RunRequestState } from '@piwitests/core/run-request';
import type { RunRequestView } from '#shared/handlers/run-requests';
import type { StatusPaletteKey } from '~/utils/status-palette';

/** Whether a request moves no more: the page stops reading it. */
export function runRequestIsFinal(request: Pick<RunRequestView, 'state'>): boolean {
  return FINAL_RUN_REQUEST_STATES.has(request.state);
}

/** Whether the requester can still stop it: it waits, its app shows it, or its run goes on. */
export function runRequestCanStop(request: Pick<RunRequestView, 'state'>): boolean {
  return (['waiting', 'claimed', 'starting', 'running', 'stopping'] as RunRequestState[]).includes(request.state);
}

/** The app that holds a request, as its sentence names it. */
function appName(request: Pick<RunRequestView, 'target'>): string {
  return request.target?.deviceName ?? 'your app';
}

/** One sentence for where a request stands, the same on the page's progress and in the requester's list. */
export function runRequestSentence(request: Pick<RunRequestView, 'state' | 'outcome' | 'detail' | 'target'>): string {
  switch (request.state) {
    case 'waiting':
      return 'Waiting for one of your apps to pick it up';
    case 'claimed':
      return `${appName(request)} shows it: click Run there`;
    case 'declined':
      return 'You answered Not now in the app';
    case 'expired':
      return 'None of your apps picked it up within 2 minutes: is the desktop app open and connected?';
    case 'refused':
      return request.detail ? `The app could not run it: ${request.detail}` : 'The app could not run it';
    case 'starting':
      return `Starting in ${appName(request)}`;
    case 'running':
      return `Running in ${appName(request)}`;
    case 'stopping':
      return `Stopping in ${appName(request)}`;
    case 'ended':
      switch (request.outcome) {
        case 'passed':
          return 'Ended: every test passed';
        case 'failed':
          return 'Ended: some tests failed';
        case 'stopped':
          return 'Stopped';
        default:
          return request.detail ? `Ended with an error: ${request.detail}` : 'Ended with an error';
      }
  }
}

/** The palette entry of a request's dot: its outcome once it ended, running while it runs, else none. */
export function runRequestStatusKey(request: Pick<RunRequestView, 'state' | 'outcome'>): StatusPaletteKey {
  if (request.state === 'ended') {
    if (request.outcome === 'passed') return 'passed';
    if (request.outcome === 'failed' || request.outcome === 'error') return 'failed';
    return 'skipped';
  }
  if (['starting', 'running', 'stopping'].includes(request.state)) return 'running';
  if (runRequestIsFinal(request)) return 'skipped';
  return 'interrupted';
}
