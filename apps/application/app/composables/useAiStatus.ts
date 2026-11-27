import type { AiStatus } from '~~/types/api';

let fetchPromise: Promise<AiStatus | null> | null = null;

export function useAiStatus() {
  const status = useState<AiStatus | null>('ai-status', () => null);

  async function load() {
    if (status.value !== null) return;
    // A failed answer (a session that ended) is not kept: the next caller asks again.
    fetchPromise ??= $fetch<AiStatus>('/api/ai/status').catch(() => {
      fetchPromise = null;
      return null;
    });
    status.value = await fetchPromise;
  }

  if (import.meta.client) {
    load();
  }

  return { aiStatus: status };
}
