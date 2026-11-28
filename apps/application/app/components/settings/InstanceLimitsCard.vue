<script setup lang="ts">
/**
 * The limits the instance applies, on the Storage settings page: the storage quota, the largest upload and results
 * document, and the days of runs the nightly cleanup keeps, each with where it comes from. A value its variable sets
 * carries the environment's lock, one the operator set (`/api/operator/limits`) the operator's, and a default none. A
 * lowered retention waiting its 14 days is said under its row.
 */
import type { InstanceLimits, LimitSource } from '#shared/operator-limits';
import type { PiwiEnvVarName } from '#shared/piwi-env-vars';

const props = defineProps<{ limits: InstanceLimits }>();

/** How many days a retention keeps, in words. */
function keptRuns(days: number | null): string {
  if (!days) return 'Every run';
  return days === 1 ? '1 day' : `${days.toLocaleString()} days`;
}

const rows = computed(() => {
  const { storageQuotaBytes, importMaxBytes, submitMaxBytes, retentionDays } = props.limits;
  const row = (label: string, value: string, source: LimitSource, envVar: PiwiEnvVarName) => ({
    label,
    value,
    source,
    envVar,
  });
  return [
    row(
      'Storage quota',
      storageQuotaBytes.value === null ? 'None' : formatBytes(storageQuotaBytes.value),
      storageQuotaBytes.source,
      'PIWI_STORAGE_QUOTA_BYTES',
    ),
    row('Largest upload', formatBytes(importMaxBytes.value), importMaxBytes.source, 'PIWI_IMPORT_MAX_BYTES'),
    row('Largest results document', formatBytes(submitMaxBytes.value), submitMaxBytes.source, 'PIWI_SUBMIT_MAX_BYTES'),
    row('Runs kept', keptRuns(retentionDays.value), retentionDays.source, 'PIWI_RETENTION_DAYS'),
  ];
});

const pending = computed(() => props.limits.retentionDays.pending);
const operatorSet = computed(() => rows.value.some((row) => row.source === 'operator') || pending.value !== null);
</script>

<template>
  <SectionCard icon="i-lucide-gauge" title="Limits" help="settings.limits">
    <EnvManagedAlert v-if="operatorSet" set-by="operator" class="mb-3" />
    <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
      <template v-for="row in rows" :key="row.label">
        <dt class="text-muted">{{ row.label }}</dt>
        <dd class="flex items-center gap-2 text-highlighted min-w-0">
          <span>{{ row.value }}</span>
          <EnvManagedBadge v-if="row.source === 'environment'" :env-vars="[row.envVar]" />
          <EnvManagedBadge v-else-if="row.source === 'operator'" :env-vars="[row.envVar]" set-by="operator" />
        </dd>
      </template>
    </dl>
    <p v-if="pending" class="mt-3 text-xs text-muted" data-shot="retention-pending">
      The operator lowered the runs kept to {{ keptRuns(pending.value).toLowerCase() }}, which applies on
      <ClientDate :date="pending.appliesAt" date-only />: a lowered retention waits 14 days, so runs it would delete can
      still be kept or exported.
    </p>
  </SectionCard>
</template>
