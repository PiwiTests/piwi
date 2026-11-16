<script setup lang="ts">
/**
 * A credential's log: every use, newest first, with who started it, for which
 * project, where it went and how it ended, filtered by result, a page at a
 * time.
 */
import {
  CREDENTIAL_FEATURE_LABELS,
  CREDENTIAL_USE_RESULTS,
  type CredentialUseEntry,
  type CredentialUseResult,
} from '#shared/credentials';
import type { ApiResponse } from '~~/types/api';

const props = defineProps<{ credentialId: number }>();

type UsesAnswer = ApiResponse<typeof import('~~/server/api/credentials/[id]/uses.get').default>;

const result = ref<CredentialUseResult | 'all'>('all');
const items = ref<CredentialUseEntry[]>([]);
const nextCursor = ref<number | null>(null);
const loading = ref(false);
const failed = ref<string | null>(null);

const RESULT_LABELS: Record<CredentialUseResult, string> = {
  sent: 'Sent',
  ok: 'Ok',
  failed: 'Failed',
  refused: 'Refused',
};
const resultItems = [
  { label: 'Every result', value: 'all' },
  ...CREDENTIAL_USE_RESULTS.map((value) => ({ label: RESULT_LABELS[value], value })),
];
const RESULT_CLASS: Record<CredentialUseResult, string> = {
  sent: 'text-muted',
  ok: 'text-highlighted',
  failed: 'text-error',
  refused: 'text-error',
};

async function load(more = false) {
  loading.value = true;
  failed.value = null;
  try {
    const answer = await $fetch<UsesAnswer>(`/api/credentials/${props.credentialId}/uses`, {
      query: {
        ...(result.value === 'all' ? {} : { result: result.value }),
        ...(more && nextCursor.value ? { before: nextCursor.value } : {}),
      },
    });
    items.value = more ? [...items.value, ...answer.items] : answer.items;
    nextCursor.value = answer.nextCursor;
  } catch (e) {
    failed.value = errorMessage(e, 'The log could not be read.');
  } finally {
    loading.value = false;
  }
}

watch([() => props.credentialId, result], () => load(), { immediate: true });
</script>

<template>
  <div class="space-y-3" data-testid="credential-activity">
    <div class="flex items-center justify-between gap-2">
      <p class="text-sm font-semibold text-highlighted">Activity <HelpHint topic="settings.credentials.log" /></p>
      <USelect v-model="result" :items="resultItems" size="sm" aria-label="Filter the log by result" class="w-40" />
    </div>
    <ErrorText v-if="failed" :text="failed" />
    <LoadingState v-else-if="loading && items.length === 0" />
    <EmptyState v-else-if="items.length === 0" text="No use recorded yet." icon="i-lucide-scroll-text" />
    <ul v-else class="divide-y divide-default">
      <li v-for="use in items" :key="use.id" class="py-2 space-y-0.5" data-testid="credential-use">
        <div class="flex flex-wrap items-baseline justify-between gap-x-3">
          <span class="text-sm text-highlighted">
            {{ CREDENTIAL_FEATURE_LABELS[use.feature] }}
            <template v-if="use.projectName"> · {{ use.projectName }}</template>
            <template v-if="use.count > 1"> · {{ use.count }} reads</template>
          </span>
          <span class="text-xs" :class="RESULT_CLASS[use.result]">{{ RESULT_LABELS[use.result] }}</span>
        </div>
        <p class="text-xs text-muted">
          <ClientDate :date="use.lastAt" />
          · {{ use.actor ?? 'the instance' }}<template v-if="use.apiKey"> (API key “{{ use.apiKey }}”)</template>
          <template v-if="use.subjectId"> · action {{ use.subjectId }}</template>
        </p>
        <p v-if="use.destination" class="text-xs text-muted font-mono break-all">{{ use.destination }}</p>
        <p v-if="use.reason" class="text-xs text-muted">{{ use.reason }}</p>
      </li>
    </ul>
    <UButton
      v-if="nextCursor"
      color="neutral"
      variant="outline"
      size="sm"
      :loading="loading"
      label="Show older uses"
      @click="load(true)"
    />
  </div>
</template>
