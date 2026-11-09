import { onUnmounted } from 'vue';

const POLLS = 5;
const STEP_MS = 1_500;

/**
 * Read a finished run again a few times, for the reports and traces the
 * reporter uploads after the run finishes. The uploads land in several
 * batches (the report directory, then each test's traces and attachments), so
 * it reads five times, 1.5 s, 3 s, 4.5 s… apart, whatever already arrived.
 * Starting again restarts the reads; they stop when the page leaves.
 */
export function useReportsPoll(refresh: () => Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let left = false;

  function poll(attempt: number) {
    if (left || attempt >= POLLS) return;
    timer = setTimeout(
      async () => {
        timer = null;
        await refresh();
        poll(attempt + 1);
      },
      STEP_MS * (attempt + 1),
    );
  }

  onUnmounted(() => {
    left = true;
    if (timer) clearTimeout(timer);
    timer = null;
  });

  return {
    start() {
      if (timer) clearTimeout(timer);
      poll(0);
    },
  };
}
