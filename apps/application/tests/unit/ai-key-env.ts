import { vi } from 'vitest';

/** The variable each AI key of `useRuntimeConfig().ai` is read from, by its field there. */
const AI_KEY_VARS = [
  ['apiKey', 'PIWI_AI_API_KEY'],
  ['researchApiKey', 'PIWI_AI_RESEARCH_API_KEY'],
  ['embeddingApiKey', 'PIWI_AI_EMBEDDING_API_KEY'],
  ['assistantApiKey', 'PIWI_AI_ASSISTANT_API_KEY'],
] as const;

/**
 * Set the AI key variables a test's runtime config names, as the server reads
 * them, so the read-only credentials of the environment open them; a key it
 * leaves out is unset. `vi.unstubAllEnvs()` restores them.
 */
export function stubAiKeyEnv(envAi: Record<string, string | undefined> | undefined): void {
  for (const [field, name] of AI_KEY_VARS) vi.stubEnv(name, envAi?.[field] || undefined);
}
