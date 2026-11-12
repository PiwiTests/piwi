import type { H3Event } from 'h3';
import { SOLE_USER, type RunViewer } from '#shared/own-runs';
import { isAuthEnabled } from './auth';

/** Who reads a runs list: the authenticated `user`, or, with authentication off, the one person using the instance. */
export function runViewerOf(event: H3Event, user: { id: number }): RunViewer {
  return isAuthEnabled(event) ? { authEnabled: true, userId: user.id } : SOLE_USER;
}

/**
 * The reporter a new run stores (`test_runs.reporter_id`): the person whose credentials (an API key or a session)
 * started it. Null with authentication off, where the acting administrator is nobody, and for a run started by a
 * request token (`signedIn` null), whose requester names the person.
 */
export function runReporterId(event: H3Event, signedIn: { id: number } | null): number | null {
  return signedIn && isAuthEnabled(event) ? signedIn.id : null;
}
