<script setup lang="ts">
/**
 * **Your runs on my machine**: the person's own run requests, newest first, each with where it stands, the app that
 * holds it and the run it started, which only they see; **Stop** ends one still going on. Shown while **Run on my
 * machine** is on, or while the person has requests to show. Read again every 5 seconds while one goes on.
 */
import type { RunRequestView } from '#shared/handlers/run-requests';

const { isHidden } = await useInstanceCapabilities();
const toast = useToast();

const requests = ref<RunRequestView[]>([]);
const loaded = ref(false);
const stopping = ref<string | null>(null);
let timer: ReturnType<typeof setTimeout> | null = null;
let unmounted = false;

async function load() {
  if (timer) clearTimeout(timer);
  timer = null;
  let read: RunRequestView[] | null = null;
  let refused = false;
  try {
    read = (await $fetch<{ items: RunRequestView[] }>('/api/run-requests')).items;
  } catch (error) {
    read = null;
    const status = (error as { statusCode?: number } | null)?.statusCode ?? 0;
    refused = [401, 403, 404].includes(status);
  }
  if (unmounted) return;
  loaded.value = true;
  // A refused read (signed out, no access, the feature off) stops; another failed read keeps the list as it was and
  // tries again while one of them goes on.
  if (refused) return;
  if (read !== null) requests.value = read;
  if (requests.value.some((r) => !runRequestIsFinal(r))) timer = setTimeout(load, 5000);
}

onMounted(load);
onBeforeUnmount(() => {
  unmounted = true;
  if (timer) clearTimeout(timer);
});

async function stop(request: RunRequestView) {
  stopping.value = request.id;
  try {
    await $fetch(`/api/run-requests/${request.id}/stop`, { method: 'POST' });
    await load();
  } catch (error) {
    toast.add({ title: 'Could not stop the request', description: errorMessage(error), color: 'error' });
  } finally {
    stopping.value = null;
  }
}

const shown = computed(() => !isHidden('machine-runs') || requests.value.length > 0);

function what(request: RunRequestView): string {
  const first = request.tests[0];
  if (request.tests.length === 1 && first) return first.title;
  return `${request.tests.length} tests`;
}
</script>

<template>
  <SectionCard
    v-if="shown"
    icon="i-lucide-monitor-play"
    title="Your runs on my machine"
    data-shot="account-run-requests"
  >
    <p class="text-sm text-muted mb-4">
      The runs you asked your own apps for, from a run or a test page. Each one reports here, and only you see it.
    </p>

    <LoadingState v-if="!loaded" />
    <div v-else-if="requests.length" class="space-y-2" data-testid="run-requests-list">
      <div
        v-for="request in requests"
        :key="request.id"
        class="flex items-center justify-between gap-3 rounded-lg border border-default px-4 py-3"
      >
        <div class="flex-1 min-w-0">
          <div class="flex items-start gap-2">
            <span
              :class="['size-2.5 rounded-full mt-1.5 shrink-0', STATUS_PALETTE[runRequestStatusKey(request)].bg]"
              aria-hidden="true"
            />
            <span class="text-sm text-highlighted min-w-0 break-words">{{ runRequestSentence(request) }}</span>
          </div>
          <div class="text-xs text-muted mt-1 flex flex-wrap gap-x-4">
            <span class="min-w-0 break-words">{{ what(request) }}</span>
            <ClientOnly>
              <span :title="prettyDateFormat(request.createdAt)"
                >Asked {{ formatRelativeTime(request.createdAt) }}</span
              >
            </ClientOnly>
            <NuxtLink v-if="request.runId" :to="`/test-runs/${request.runId}`" :class="SENTENCE_LINK_CLASS"
              >Run #{{ request.runId }}</NuxtLink
            >
          </div>
        </div>
        <UButton
          v-if="runRequestCanStop(request)"
          color="neutral"
          variant="outline"
          size="sm"
          :loading="stopping === request.id"
          @click="stop(request)"
          >Stop</UButton
        >
      </div>
    </div>
    <p v-else class="text-center text-muted py-6 text-sm">
      None yet. Open a run or a test and click <strong>Run on my machine</strong>.
    </p>
  </SectionCard>
</template>
