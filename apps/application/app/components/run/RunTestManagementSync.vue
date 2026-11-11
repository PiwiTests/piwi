<script setup lang="ts">
import type { RunSyncView } from '#shared/handlers/test-management-sync';
import { getProviderIcon } from '#shared/link-detect';
import { nextSyncRead, syncRetryPending } from '~/utils/run-sync-reads';

/**
 * How the run's results went to the test management tool: the test run made there, what was sent (or would be, in a dry
 * run), the keys left out, and an unknown outcome with the action to look again. Renders nothing for a run that has no
 * sync. Maintainers and above send a failed sync again.
 */
const props = defineProps<{
  runId: number;
  projectId: number;
  /** When the run ended, ISO 8601: a run that just ended is read again until its sync appears. */
  endedAt?: string | null;
}>();
const emit = defineEmits<{ changed: [] }>();

const toast = useToast();
const { can } = useAuth();
const sending = ref(false);
const canSendAgain = computed(() => can('run:control', props.projectId));

const { data, refresh } = useFetch<{ sync: RunSyncView | null }>(
  () => `/api/test-runs/${props.runId}/test-management-sync`,
  {
    server: false,
    lazy: true,
  },
);
const sync = computed(() => data.value?.sync ?? null);
const icon = getProviderIcon('zephyr-scale');

const inFlight = computed(() => sync.value?.status === 'pending' || sync.value?.status === 'processing');
const retryAt = computed(() => {
  const s = sync.value;
  if (!s || !syncRetryPending(s) || !s.scheduledFor) return null;
  return new Date(s.scheduledFor).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
});

let timer: ReturnType<typeof setTimeout> | null = null;
let emptyReads = 0;
function planRead(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!data.value) return;
  const wait = nextSyncRead(sync.value, {
    endedAt: props.endedAt ? Date.parse(props.endedAt) : null,
    emptyReads,
    now: Date.now(),
  });
  if (wait == null) return;
  timer = setTimeout(async () => {
    timer = null;
    if (!sync.value) emptyReads++;
    await refresh();
    planRead();
  }, wait);
}
watch(data, planRead, { immediate: true });
onBeforeUnmount(() => {
  if (timer) clearTimeout(timer);
});

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);

const countsText = computed(() => {
  const s = sync.value;
  if (!s) return '';
  const parts = [
    `${s.counts.passed} passed`,
    `${s.counts.failed} failed`,
    `${s.counts.flaky} flaky`,
    `${s.counts.notExecuted} not executed`,
  ];
  return parts.join(', ');
});

const hiddenUnknownKeys = computed(() => (sync.value ? sync.value.unknownKeyCount - sync.value.unknownKeys.length : 0));

async function sendAgain(): Promise<void> {
  if (sending.value) return;
  sending.value = true;
  try {
    const res = await $fetch<{ status: string; error?: string; retrying?: boolean }>(
      `/api/test-runs/${props.runId}/test-management-sync`,
      { method: 'POST' },
    );
    if (res.status === 'done') toast.add({ title: 'Results sent', color: 'success' });
    else if (res.status === 'skipped')
      toast.add({ title: 'Results not sent', description: res.error, color: 'neutral' });
    else
      toast.add({
        title: res.retrying ? 'Sending failed, trying again later' : 'Sending failed',
        description: res.error,
        color: 'error',
      });
    emit('changed');
  } catch (e) {
    toast.add({ title: 'Could not send the results', description: errorMessage(e), color: 'error' });
  } finally {
    sending.value = false;
    await refresh();
  }
}
</script>

<template>
  <div
    v-if="sync"
    class="rounded-md border border-default px-3 py-2 text-sm space-y-1"
    data-shot="run-test-management-sync"
    data-testid="run-test-management-sync"
    data-tour="run-test-management-sync"
  >
    <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
      <UIcon :name="icon" class="size-4 shrink-0 text-muted" />
      <span class="font-semibold text-highlighted">Zephyr Scale</span>

      <template v-if="sync.status === 'done' && !sync.dryRun">
        <span v-if="sync.runKey" class="font-mono text-primary" data-testid="sync-run-key">{{ sync.runKey }}</span>
        <span class="text-muted" data-testid="sync-sent">
          {{ sync.resultCount }} {{ plural(sync.resultCount, 'result', 'results') }} sent: {{ countsText }}
        </span>
      </template>
      <span v-else-if="sync.status === 'done'" class="text-muted" data-testid="sync-dry-run">
        Dry run, nothing was sent. A live sync would send {{ sync.resultCount }}
        {{ plural(sync.resultCount, 'result', 'results') }}: {{ countsText }}
      </span>
      <span v-else-if="retryAt" class="text-error" data-testid="sync-retrying">
        Sending failed, next attempt at {{ retryAt }}. {{ sync.error }}
      </span>
      <span v-else-if="inFlight" class="text-muted" data-testid="sync-pending">Sending results…</span>
      <span v-else-if="sync.status === 'skipped'" class="text-muted" data-testid="sync-skipped">
        Results not sent: {{ sync.error }}
      </span>
      <span v-else class="text-error" data-testid="sync-failed">
        {{ sync.error ?? 'Sending the results failed' }}
      </span>

      <UButton
        v-if="sync.status === 'failed' && canSendAgain"
        size="xs"
        variant="soft"
        color="neutral"
        icon="i-lucide-refresh-cw"
        label="Sync again"
        :loading="sending"
        data-testid="sync-again"
        @click="sendAgain"
      />
      <HelpHint topic="run.testManagementSync" />
    </div>

    <p v-if="sync.outcomeUnknown" class="text-xs text-muted" data-testid="sync-outcome-unknown">
      The upload may have reached the tool. Sync again looks there for the test run
      <template v-if="sync.runName">“{{ sync.runName }}”</template> first and links it when it exists.
    </p>

    <p v-if="sync.unknownKeyCount > 0" class="text-xs text-highlighted" data-testid="sync-unknown-keys">
      {{ sync.unknownKeyCount }} {{ plural(sync.unknownKeyCount, 'key', 'keys') }} not in the test case catalog
      {{ plural(sync.unknownKeyCount, 'was', 'were') }} left out:
      <code class="font-mono">{{ sync.unknownKeys.join(', ') }}</code
      ><template v-if="hiddenUnknownKeys > 0">, …</template>
    </p>
  </div>
</template>
