<script setup lang="ts">
/**
 * Detail drawer for one trace network request: request line, timing phases,
 * masked request/response headers, post data, and a lazily fetched capped
 * body preview (JSON pretty-printed, images inline). Bodies come from the
 * trace-network-body endpoint, addressed by the trace's own content hash.
 */
import type { TraceBodyResponse, TraceNetworkEntry } from '~~/types/api';

const props = defineProps<{
  open: boolean;
  entry: TraceNetworkEntry | null;
  runId: number | null;
  testRunsCaseId: number;
}>();
const emit = defineEmits<{ 'update:open': [value: boolean] }>();

const PHASES = [
  { key: 'dns', label: 'DNS', color: 'bg-sky-400' },
  { key: 'connect', label: 'Connect', color: 'bg-violet-400' },
  { key: 'ssl', label: 'TLS', color: 'bg-rose-400' },
  { key: 'send', label: 'Send', color: 'bg-amber-400' },
  { key: 'wait', label: 'Wait', color: 'bg-blue-400' },
  { key: 'receive', label: 'Receive', color: 'bg-emerald-400' },
] as const;

/** Phases that were actually measured (-1 marks an absent phase in HAR timings). */
const phases = computed(() => {
  const timings = props.entry?.timings;
  if (!timings) return [];
  return PHASES.map((p) => ({ ...p, value: timings[p.key] ?? -1 })).filter(
    (p) => typeof p.value === 'number' && p.value >= 0,
  );
});
const phasesTotal = computed(() => phases.value.reduce((sum, p) => sum + p.value, 0));

const isJsonPostData = computed(() => {
  const text = props.entry?.requestPostData ?? '';
  return text.startsWith('{') || text.startsWith('[');
});

// ── Body preview (lazy, cached per content hash) ───────────────────────────
const body = ref<TraceBodyResponse | null>(null);
const bodyPending = ref(false);
const bodyCache = new Map<string, TraceBodyResponse>();

// A response that arrives after the drawer moved to another request (or closed)
// is cached but never shown: only the current request's body is.
watch(
  () => [props.open, props.entry?.bodySha1] as const,
  async ([open, sha1], _before, onCleanup) => {
    let stale = false;
    onCleanup(() => {
      stale = true;
    });
    body.value = null;
    bodyPending.value = false;
    if (!open || !sha1 || !props.runId) return;
    const cached = bodyCache.get(sha1);
    if (cached) {
      body.value = cached;
      return;
    }
    bodyPending.value = true;
    let result: TraceBodyResponse;
    try {
      result = await $fetch<TraceBodyResponse>(`/api/test-run-cases/${props.testRunsCaseId}/trace-network-body`, {
        query: { sha1 },
      });
      bodyCache.set(sha1, result);
    } catch {
      result = { status: 'not-found' };
    }
    if (stale || props.entry?.bodySha1 !== sha1) return;
    body.value = result;
    bodyPending.value = false;
  },
  { immediate: true },
);
</script>

<template>
  <USlideover
    :open="open"
    title="Request detail"
    :ui="{ content: 'max-w-xl' }"
    @update:open="emit('update:open', $event)"
  >
    <template #body>
      <div v-if="entry" class="space-y-4 text-sm">
        <!-- Request line -->
        <div class="space-y-1.5">
          <div class="flex items-center gap-2">
            <UBadge :color="httpMethodColor(entry.method)" variant="soft" size="sm" class="font-mono shrink-0">
              {{ entry.method }}
            </UBadge>
            <UBadge
              :color="httpStatusColor(entry.status)"
              variant="soft"
              size="sm"
              class="font-mono shrink-0 tabular-nums"
            >
              {{ entry.status > 0 ? entry.status : '—' }}
            </UBadge>
            <span v-if="entry.statusText" class="text-xs text-gray-500">{{ entry.statusText }}</span>
          </div>
          <code class="block text-xs break-all text-gray-700 dark:text-gray-300">{{ entry.url }}</code>
          <p v-if="entry.failureText" class="text-xs text-red-600 dark:text-red-400 font-mono">
            {{ entry.failureText }}
          </p>
          <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-400">
            <span v-if="entry.resourceType" class="font-mono">{{ entry.resourceType }}</span>
            <span v-if="entry.mimeType" class="font-mono">{{ entry.mimeType }}</span>
            <span v-if="entry.responseBodySize != null">{{ formatBytes(entry.responseBodySize) }}</span>
            <span v-if="entry.transferSize != null" :title="'Bytes on the wire'"
              >{{ formatBytes(entry.transferSize) }} transferred</span
            >
            <DurationValue :ms="entry.duration" />
            <UBadge v-if="entry.duringFailure" color="error" variant="subtle" size="xs">During failing action</UBadge>
          </div>
        </div>

        <!-- Timing phases -->
        <div v-if="phases.length > 0 && phasesTotal > 0">
          <p class="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1.5">Timing</p>
          <div class="flex h-2 rounded overflow-hidden bg-gray-100 dark:bg-gray-800">
            <div
              v-for="p in phases"
              :key="p.key"
              :class="p.color"
              :style="{ width: `${Math.max(0.5, (p.value / phasesTotal) * 100)}%` }"
              :title="`${p.label}: ${formatDuration(p.value)}`"
            />
          </div>
          <div class="flex flex-wrap gap-x-3 gap-y-1 mt-1.5 text-xs text-gray-500">
            <span v-for="p in phases" :key="p.key" class="inline-flex items-center gap-1">
              <span class="size-2 rounded-full" :class="p.color" />
              {{ p.label }} <DurationValue :ms="p.value" no-title />
            </span>
          </div>
        </div>

        <!-- Headers -->
        <div v-for="side in ['request', 'response'] as const" :key="side">
          <p class="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1.5 capitalize">{{ side }} headers</p>
          <div
            v-if="(side === 'request' ? entry.requestHeaders : entry.responseHeaders).length > 0"
            class="rounded border border-default divide-y divide-default max-h-48 overflow-y-auto"
          >
            <div
              v-for="header in side === 'request' ? entry.requestHeaders : entry.responseHeaders"
              :key="`${side}-${header.name}`"
              class="px-2 py-1 text-xs font-mono flex gap-2"
            >
              <span class="text-gray-500 dark:text-gray-400 shrink-0">{{ header.name }}:</span>
              <span class="break-all text-gray-700 dark:text-gray-300">{{ header.value }}</span>
            </div>
          </div>
          <p v-else class="text-xs text-gray-400">None recorded.</p>
        </div>

        <!-- Request body -->
        <div v-if="entry.requestPostData">
          <p class="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1.5">Request body</p>
          <CodeBlock :code="entry.requestPostData" :lang="isJsonPostData ? 'json' : 'text'" />
        </div>

        <!-- Response body preview -->
        <div>
          <p class="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1.5">Response body</p>
          <LoadingState v-if="bodyPending" text="Loading body…" :padded="false" />
          <template v-else-if="body">
            <div v-if="body.status === 'ok' && body.kind === 'image'" class="rounded border border-default p-2">
              <img :src="body.dataUri" :alt="entry.url" class="max-w-full max-h-96" />
            </div>
            <div v-else-if="body.status === 'ok'" class="max-h-96 overflow-y-auto">
              <CodeBlock :code="body.content ?? ''" :lang="body.kind === 'json' ? 'json' : 'text'" />
              <p v-if="body.truncated" class="mt-1 text-xs text-gray-400">Preview truncated.</p>
            </div>
            <p v-else class="text-xs text-gray-400">
              {{
                body.status === 'too-large'
                  ? `Body too large to preview (${formatBytes(body.size ?? 0)}) — open the trace viewer to inspect it.`
                  : body.status === 'unsupported'
                    ? `No preview for ${body.mimeType || 'this content type'} — open the trace viewer to inspect it.`
                    : 'Body not stored in the trace.'
              }}
            </p>
          </template>
          <p v-else-if="!entry.bodySha1" class="text-xs text-gray-400">No body captured for this request.</p>
        </div>
      </div>
    </template>
  </USlideover>
</template>
