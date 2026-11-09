import type { FinalRefetchFailure } from '~/utils/refetch-keeping';

/** What the run page says once it can no longer read its run, and the one action it offers. */
export interface RunReadEndedNotice {
  title: string;
  description: string;
  /** `sign-in` opens Piwi's sign-in page, `reload` loads the page again; null offers nothing. */
  action: 'sign-in' | 'reload' | null;
}

/**
 * The run page's notice after a final failure to read its run (`isFinalRefetch`), for a run still running or one that
 * ended alike. Signing in again is offered only where Piwi's own authentication is on (`authEnabled`); elsewhere the
 * page offers to load itself again.
 */
export function runReadEndedNotice(failure: FinalRefetchFailure, authEnabled: boolean): RunReadEndedNotice {
  const shown = 'The page shows the run as it last read it';
  switch (failure) {
    case 'gone':
      return {
        title: 'This run no longer exists',
        description: `It was deleted while this page was open. ${shown}.`,
        action: null,
      };
    case 'signed-out':
      return authEnabled
        ? {
            title: 'Your session has ended',
            description: `${shown}. Sign in again to read it afresh.`,
            action: 'sign-in',
          }
        : {
            title: 'The instance refused to read this run',
            description: `${shown}. Load the page again to read it afresh.`,
            action: 'reload',
          };
    case 'forbidden':
      return authEnabled
        ? {
            title: 'Your access to this run was removed',
            description: `${shown}. Sign in with an account that holds a role on its project, or ask a Project admin for one.`,
            action: 'sign-in',
          }
        : {
            title: 'The instance refused to read this run',
            description: `${shown}. Load the page again to read it afresh.`,
            action: 'reload',
          };
  }
}
