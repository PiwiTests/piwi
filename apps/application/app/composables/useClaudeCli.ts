import type { ClaudeCliStatus } from '~~/types/api';

/**
 * Client state for the local Claude CLI provider: health and sign-in status.
 * Shared across components via useState so the settings card and any status
 * badge agree. Signing in happens in Claude Code itself, never through Piwi.
 */
export function useClaudeCli() {
  const status = useState<ClaudeCliStatus | null>('claude-cli-status', () => null);
  const loading = useState<boolean>('claude-cli-loading', () => false);

  async function refresh(force = false): Promise<void> {
    loading.value = true;
    try {
      status.value = await $fetch<ClaudeCliStatus>('/api/ai/claude-cli/status', {
        query: force ? { refresh: 'true' } : undefined,
      });
    } catch {
      // Keep the previous snapshot on a transient failure.
    } finally {
      loading.value = false;
    }
  }

  return { status, loading, refresh };
}
