<script setup lang="ts">
/**
 * Picks a credential saved under Settings → Credentials for a Jira or Zephyr
 * Scale connection, in place of a token typed in its form: those of the
 * provider, shared with all projects and sent under the connection's address,
 * besides the one it names already. Once one is picked, it says whose token
 * the connection signs in with, and the form hides its token fields.
 */
import { isUnderBaseUrl } from '#shared/ci-server';
import type { CredentialSummary } from '#shared/credentials';
import type { ApiResponse } from '~~/types/api';

const props = defineProps<{
  service: 'jira' | 'zephyr-scale';
  /** The address the connection's credential is sent under, as the form reads now; null before it has one. */
  endpoint: string | null;
  /** The credential the connection names already, which the list leaves out. */
  current?: number | null;
}>();
const model = defineModel<number | null>({ required: true });

type CredentialsAnswer = ApiResponse<typeof import('~~/server/api/credentials/index.get').default>;
const { data } = useFetch<CredentialsAnswer>('/api/credentials', {
  key: 'connection-credentials',
  server: false,
});
const saved = computed(() =>
  ((data.value?.credentials ?? []) as CredentialSummary[]).filter(
    (c) =>
      c.service === props.service &&
      c.managedBy === 'db' &&
      c.scope.allProjects &&
      c.id !== props.current &&
      props.endpoint !== null &&
      isUnderBaseUrl(c.destination, props.endpoint),
  ),
);
const items = computed(() =>
  saved.value.map((c) => ({
    label: c.disabled ? `${c.name} (disabled)` : c.name,
    value: c.id,
    description: c.user ?? c.destination,
  })),
);
const picked = computed(() => saved.value.find((c) => c.id === model.value) ?? null);
const value = computed({
  get: () => model.value ?? undefined,
  set: (id: number | undefined) => {
    model.value = id ?? null;
  },
});

// A move to another address drops a pick that is not sent there.
watch(
  () => props.endpoint,
  () => {
    if (model.value !== null && data.value && !picked.value) model.value = null;
  },
);
</script>

<template>
  <div v-if="model !== null || items.length > 0">
    <div
      v-if="model !== null"
      class="flex flex-wrap items-center gap-x-3 gap-y-1"
      data-testid="saved-credential-picked"
    >
      <p class="text-sm text-highlighted">
        Signs in with “{{ picked?.name ?? 'the credential picked' }}”<template v-if="picked?.user">
          as {{ picked.user }}</template
        >; each use is logged under Settings → Credentials.
      </p>
      <UButton color="neutral" variant="link" size="sm" class="px-0" @click="model = null">
        Type a token instead
      </UButton>
    </div>
    <UFormField
      v-else
      label="Saved credential"
      description="A token saved under Settings → Credentials and sent to this address, in place of one typed here."
    >
      <USelect
        v-model="value"
        :items="items"
        placeholder="Pick a saved credential"
        aria-label="Saved credential"
        class="w-full sm:max-w-sm"
        data-testid="saved-credential-select"
      />
    </UFormField>
  </div>
</template>
