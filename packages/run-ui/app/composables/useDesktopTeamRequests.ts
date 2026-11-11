/**
 * Desktop shell: **Run on my machine**, the app taking run requests from one team instance. The desktop event stream
 * gives the connection (`run-target`) and each request the window asks the person about (`run-request`, the ones
 * still asked about again on every connection); the confirmation shows the first, oldest first.
 */
import type { RunRequestPromptView, RunTargetConnectionView } from '@piwitests/editor/run-target-view';

const NO_CONNECTION: RunTargetConnectionView = {
  state: 'none',
  instance: null,
  userCode: null,
  verificationUrl: null,
  error: null,
  keyToKeep: false,
  linkedProjectIds: [],
  projectNames: {},
};

export function useDesktopTeamRequests() {
  const connection = useState<RunTargetConnectionView>('desktop-team-connection', () => NO_CONNECTION);
  const queue = useState<RunRequestPromptView[]>('desktop-team-requests', () => []);

  function add(request: RunRequestPromptView) {
    const others = queue.value.filter((r) => r.id !== request.id);
    const at = queue.value.findIndex((r) => r.id === request.id);
    queue.value = at < 0 ? [...queue.value, request] : [...others.slice(0, at), request, ...others.slice(at)];
  }

  function remove(id: string) {
    queue.value = queue.value.filter((r) => r.id !== id);
  }

  const current = computed(() => queue.value[0] ?? null);

  return { connection, queue, current, add, remove };
}
