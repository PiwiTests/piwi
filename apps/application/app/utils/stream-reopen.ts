import { isFinalRefetch, type RefetchResult } from '~/utils/refetch-keeping';

/** The first wait before a page opens its stream again after an error answer closed it; each try doubles it. */
export const STREAM_REOPEN_MIN_MS = 2_000;
/** The longest wait between two tries. */
export const STREAM_REOPEN_MAX_MS = 30_000;

/**
 * Opens a page's stream again after an error answer closed it for good (a proxy's 502 while the instance restarts, an
 * expired session), waiting longer each time. A try reads the page's data again (`reload`, which resolves to how the
 * read ended) and then calls `open`. A try whose read failed waits longer and tries again, unless the failure is final
 * (`isFinalRefetch`: the data is gone, or the viewer cannot read it): then it stops, and the page says why. `schedule`
 * starts a try unless one is waiting or reading; `reset` drops that try and starts the next wait from the shortest, as
 * when the stream opened or the page stopped following it.
 */
export function streamReopener(reload: () => Promise<RefetchResult>, open: () => void) {
  let delay = STREAM_REOPEN_MIN_MS;
  let pending: ReturnType<typeof setTimeout> | null = null;

  function schedule(): void {
    if (pending) return;
    const timer = setTimeout(async () => {
      const result = await reload();
      // A reset while the data was read dropped this try.
      if (pending !== timer) return;
      pending = null;
      if (result === 'answered') open();
      else if (!isFinalRefetch(result)) schedule();
    }, delay);
    pending = timer;
    delay = Math.min(delay * 2, STREAM_REOPEN_MAX_MS);
  }

  function reset(): void {
    if (pending) clearTimeout(pending);
    pending = null;
    delay = STREAM_REOPEN_MIN_MS;
  }

  return { schedule, reset };
}
