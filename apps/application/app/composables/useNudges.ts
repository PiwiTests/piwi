import type { AssistantNudgeDismissal, AssistantNudgeId } from '#shared/assistant-nudges';
import { NUDGE_SHOWS_KEY, parseNudgeShows, takeNudgeBudget } from '~/utils/nudges/budget';

/** The dismissals request in flight, shared by every caller. */
let dismissalsRequest: Promise<void> | null = null;

/**
 * The state nudges share across pages: the nudges the user dismissed, read
 * once from the server, where a dismissal is kept per user so it holds in
 * every browser, and this browser's weekly budget (`app/utils/nudges/budget.ts`).
 * Client-only: nothing here runs during the server render.
 */
export function useNudges() {
  const toast = useToast();
  /** The dismissed nudges, or null until they are read (or when they could not be). */
  const dismissed = useState<AssistantNudgeId[] | null>('assistant-nudge-dismissals', () => null);

  /** Reads the dismissed nudges once; a failure leaves them unread, so no nudge shows. */
  async function loadDismissals(): Promise<void> {
    if (import.meta.server || dismissed.value) return;
    dismissalsRequest ??= $fetch<{ items: AssistantNudgeDismissal[] }>('/api/assistant/nudge-dismissals')
      .then((result) => {
        dismissed.value = result.items.map((item) => item.nudgeId);
      })
      .catch(() => {})
      .finally(() => {
        dismissalsRequest = null;
      });
    await dismissalsRequest;
  }

  /** **Don't show again**: hides the nudge at once, then keeps the dismissal on the server. */
  async function dismiss(id: AssistantNudgeId): Promise<void> {
    dismissed.value = [...new Set([...(dismissed.value ?? []), id])];
    try {
      await $fetch(`/api/assistant/nudge-dismissals/${id}`, { method: 'PUT' });
    } catch (error) {
      toast.add({
        title: 'The dismissal was not saved',
        description: errorMessage(error, 'It is hidden until you reload the page.'),
        color: 'error',
      });
    }
  }

  /**
   * Asks this browser's weekly budget for one nudge, and counts it when there
   * is room. Without storage (a private window that refuses it) nothing is
   * counted, and the page view's one nudge still shows.
   */
  function takeBudget(now = Date.now()): boolean {
    try {
      const next = takeNudgeBudget(parseNudgeShows(localStorage.getItem(NUDGE_SHOWS_KEY)), now);
      if (!next) return false;
      localStorage.setItem(NUDGE_SHOWS_KEY, JSON.stringify({ shown: next }));
      return true;
    } catch {
      return true;
    }
  }

  return {
    dismissed: computed(() => (dismissed.value ? new Set<string>(dismissed.value) : null)),
    loadDismissals,
    dismiss,
    takeBudget,
  };
}
