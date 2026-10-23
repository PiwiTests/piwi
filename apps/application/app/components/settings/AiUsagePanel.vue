<script setup lang="ts">
import type { AiUsageModelRow, AiUsageSummary } from '~~/types/api';
import { diagnosisAuthorLabel, isAgentDiagnosis } from '#shared/agent-diagnosis';

const days = ref(30);

const periodOptions = [
  { label: 'Last 7 days', value: 7 },
  { label: 'Last 30 days', value: 30 },
  { label: 'Last 90 days', value: 90 },
];

const { data: usage, pending } = await useFetch<AiUsageSummary>('/api/settings/ai/usage', {
  query: { days },
});

// The exact counts on hover follow the browser's number format, which the
// server does not know, so they appear once the panel is mounted.
const mounted = ref(false);
onMounted(() => {
  mounted.value = true;
});
function exactCount(n: number): string | undefined {
  return mounted.value ? n.toLocaleString() : undefined;
}

function share(part: number, whole: number): string {
  return `${Math.round((part / whole) * 100)}%`;
}

/** `12 of 17 (71%)`; under the sample floor the share is left out and named too small. */
function helpfulText(row: AiUsageModelRow, minRatings: number): string {
  if (row.rated === 0) return '—';
  const counts = `${row.helpful} of ${row.rated}`;
  return row.rated < minRatings ? `${counts}, too few ratings` : `${counts} (${share(row.helpful, row.rated)})`;
}

function patchText(row: AiUsageModelRow): string {
  if (row.patchesChecked === 0) return '—';
  return `${row.patchesApplying} of ${row.patchesChecked} (${share(row.patchesApplying, row.patchesChecked)})`;
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
</script>

<template>
  <SectionCard icon="i-lucide-activity" title="AI usage" data-shot="ai-usage" data-tour="ai-usage">
    <template #actions>
      <USelect v-model="days" :items="periodOptions" size="sm" class="w-36" />
    </template>

    <div v-if="usage" class="space-y-3">
      <p class="text-sm text-gray-500">
        {{ formatCount(usage.totals.diagnoses) }} diagnoses · {{ formatCount(usage.totals.assistantTurns) }} assistant
        answers · {{ formatCount(usage.totals.inputTokens) }} input tokens ·
        {{ formatCount(usage.totals.outputTokens) }} output tokens
      </p>

      <p v-if="usage.byModel.length === 0" class="text-sm text-gray-500">No AI calls recorded in this period.</p>

      <div v-else class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="text-xs text-gray-500 uppercase tracking-wider border-b border-default">
              <th class="text-left px-2 py-2 font-medium">Model</th>
              <th class="text-right px-2 py-2 font-medium">Diagnoses</th>
              <th class="text-right px-2 py-2 font-medium">Failed</th>
              <th class="text-right px-2 py-2 font-medium" title="Questions the assistant answered">
                Assistant answers
              </th>
              <th class="text-right px-2 py-2 font-medium">Input tokens</th>
              <th class="text-right px-2 py-2 font-medium">Output tokens</th>
              <th class="text-right px-2 py-2 font-medium">Avg duration</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in usage.byModel"
              :key="`${row.provider ?? 'unknown'}/${row.model}`"
              class="border-b last:border-b-0 border-default"
            >
              <td class="px-2 py-2">
                <span class="font-mono text-xs">{{ row.model }}</span>
                <span class="text-xs text-gray-400">
                  · {{ isAgentDiagnosis(row.provider) ? 'written by an agent' : (row.provider ?? 'unknown') }}</span
                >
              </td>
              <td class="text-right px-2 py-2">{{ row.diagnoses }}</td>
              <td class="text-right px-2 py-2" :class="row.failed > 0 ? 'text-red-600 dark:text-red-400' : ''">
                {{ row.failed }}
              </td>
              <td class="text-right px-2 py-2">{{ row.assistantTurns }}</td>
              <td class="text-right px-2 py-2" :title="exactCount(row.inputTokens)">
                {{ formatCount(row.inputTokens) }}
              </td>
              <td class="text-right px-2 py-2" :title="exactCount(row.outputTokens)">
                {{ formatCount(row.outputTokens) }}
              </td>
              <td class="text-right px-2 py-2">
                <DurationValue :ms="row.avgDurationMs" />
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="usage.byModel.length > 0" class="overflow-x-auto" data-shot="ai-usage-quality">
        <table class="w-full text-sm">
          <thead>
            <tr class="text-xs text-gray-500 uppercase tracking-wider border-b border-default">
              <th class="text-left px-2 py-2 font-medium">Model</th>
              <th class="text-right px-2 py-2 font-medium" title="Diagnoses rated helpful, of those rated">
                Rated helpful
              </th>
              <th class="text-right px-2 py-2 font-medium" title="Suggested patches that apply to the source they name">
                Patches that apply
              </th>
              <th
                class="text-right px-2 py-2 font-medium"
                title="Diagnoses a fix confirmed by changing the diagnosed files"
              >
                Verified by the fix
              </th>
              <th class="text-right px-2 py-2 font-medium" title="Confirmed diagnoses whose failure came back">
                Regressed
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in usage.byModel"
              :key="`${row.provider ?? 'unknown'}/${row.model}`"
              class="border-b last:border-b-0 border-default"
            >
              <td class="px-2 py-2">
                <span class="font-mono text-xs" :title="diagnosisAuthorLabel(row.provider, row.model)">{{
                  row.model
                }}</span>
              </td>
              <td class="text-right px-2 py-2 whitespace-nowrap">{{ helpfulText(row, usage.minRatings) }}</td>
              <td class="text-right px-2 py-2 whitespace-nowrap">{{ patchText(row) }}</td>
              <td class="text-right px-2 py-2">{{ row.verified }}</td>
              <td class="text-right px-2 py-2">{{ row.regressed }}</td>
            </tr>
          </tbody>
        </table>
        <p class="px-2 pt-2 text-xs text-muted">
          A helpful share needs {{ usage.minRatings }} ratings. Models are never switched on these numbers.
        </p>
      </div>
    </div>

    <div v-else-if="pending" class="flex items-center gap-2 py-4 text-muted">
      <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin" />
      <span class="text-sm">Loading usage…</span>
    </div>
  </SectionCard>
</template>
