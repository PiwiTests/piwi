import { ASSIGNEE_EMPTY_HINT, assigneeSearchHint } from '#shared/integrations/jira-setup';

/** What the person sees under a people picker when a search went wrong or found no one. */
export interface AssignableSearchProblem {
  state: 'error' | 'warning';
  text: string;
  hint: string | null;
}

const SEARCH_FAILED = 'Could not search the people Jira can assign';

/**
 * A failed search for assignable people as the picker shows it: the server's
 * message and, from the tracker status it carries in `data.providerStatus`, what
 * to grant or check. A failure that carries no message of the server's, such as
 * a request that never got an answer, reads as the search having failed.
 */
export function assignableSearchProblem(err: unknown): AssignableSearchProblem {
  const body = (err as { data?: { message?: unknown; data?: { providerStatus?: unknown } } } | null)?.data;
  const message = typeof body?.message === 'string' && body.message ? body.message : SEARCH_FAILED;
  const status = typeof body?.data?.providerStatus === 'number' ? body.data.providerStatus : null;
  return { state: 'error', text: message, hint: assigneeSearchHint(status) };
}

/** An empty list for no words at all: what Jira Cloud answers when the account may not browse users. */
export const NO_ONE_LISTED: AssignableSearchProblem = {
  state: 'warning',
  text: 'Jira listed no one for this project.',
  hint: ASSIGNEE_EMPTY_HINT,
};
