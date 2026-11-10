<script setup lang="ts">
/**
 * Below the test management binding form: how the last complete run's tests map onto the catalog of test cases the
 * project is bound to (tests with a key, tests with none, keys the catalog does not hold), and the catalog itself with
 * its *Refresh catalog* button. Reads `GET /api/projects/:id/test-management/summary`, which never calls the tool;
 * only *Refresh catalog* does, through `POST .../catalog/refresh`.
 */
import { formatTagsTruncatedTests, tagsTruncatedCount } from '@piwitests/core/test-meta';
import { MAX_UNKNOWN_KEY_EXAMPLES } from '#shared/integrations/test-management-mapping';
import type { TestManagementSummaryReport } from '#shared/handlers/test-management-summary';

const props = defineProps<{ projectId: number }>();
const toast = useToast();

const report = ref<TestManagementSummaryReport | null>(null);
const loading = ref(true);
const failure = ref<string | null>(null);
const refreshing = ref(false);

async function load() {
  failure.value = null;
  try {
    report.value = await $fetch<TestManagementSummaryReport>(
      `/api/projects/${props.projectId}/test-management/summary`,
    );
  } catch (err) {
    failure.value = errorMessage(err, 'The mapping summary could not be read.');
  } finally {
    loading.value = false;
  }
}

async function refresh() {
  refreshing.value = true;
  try {
    const { size } = await $fetch<{ size: number; fetchedAt: string }>(
      `/api/projects/${props.projectId}/test-management/catalog/refresh`,
      { method: 'POST' },
    );
    toast.add({ title: 'Catalog refreshed', description: `${size} test cases read.`, color: 'success' });
    await load();
  } catch (err) {
    toast.add({ title: 'Could not read the catalog', description: errorMessage(err), color: 'error' });
  } finally {
    refreshing.value = false;
  }
}

onMounted(load);
defineExpose({ reload: load });

const bound = computed(() => (report.value?.bound ? report.value : null));
const summary = computed(() => bound.value?.summary ?? null);
const hiddenUnknownKeys = computed(() =>
  summary.value ? summary.value.unknownKeyCount - summary.value.unknownKeys.length : 0,
);
const tagsCut = computed(() => {
  const cut = bound.value?.tagsTruncated;
  if (!cut) return null;
  return { text: formatTagsTruncatedTests(cut), atLeast: tagsTruncatedCount(cut).atLeast };
});
const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);
</script>

<template>
  <div class="space-y-4" data-testid="test-management-summary" data-shot="test-management-summary">
    <LoadingState v-if="loading" />
    <UAlert
      v-else-if="failure"
      color="error"
      variant="subtle"
      icon="i-lucide-circle-alert"
      title="Couldn’t read the mapping summary"
      :description="failure"
    />
    <p v-else-if="!bound || !summary" class="text-sm text-muted">Save a binding to see how your tests map onto it.</p>
    <template v-else>
      <div>
        <p class="text-xs font-medium text-muted mb-2 flex items-center gap-1">How the last complete run maps</p>
        <p v-if="bound.runId === null" class="text-sm text-muted" data-testid="test-management-no-run">
          No complete run yet, so there are no tests to map.
        </p>
        <template v-else>
          <p class="text-sm text-highlighted" data-testid="test-management-mapped">
            <strong>{{ summary.mappedTests }}</strong>
            {{ plural(summary.mappedTests, 'test carries', 'tests carry') }} a test case key,
            <strong>{{ summary.testsWithoutKey }}</strong>
            {{ plural(summary.testsWithoutKey, 'has', 'have') }} none. Keys are read with
            <code class="font-mono text-xs">{{ bound.pattern }}</code>
            <span v-if="bound.patternIsDefault" class="text-muted">(the default for this project)</span>.
          </p>
          <p v-if="tagsCut" class="mt-1 text-sm text-warning" data-testid="test-management-tags-cut">
            Tags were cut on {{ tagsCut.text }} in this run, so {{ tagsCut.atLeast ? 'some' : 'those' }} tests may be
            missing a key.
          </p>
        </template>
      </div>

      <div data-testid="test-management-unknown">
        <p class="text-xs font-medium text-muted mb-2">Keys the catalog does not hold</p>
        <p v-if="!summary.catalogRead" class="text-sm text-muted">
          Catalog not read yet, so no key can be checked. Refresh the catalog below.
        </p>
        <p v-else-if="summary.unknownKeyCount === 0" class="text-sm text-muted">
          Every key of the run is a test case in the catalog.
        </p>
        <template v-else>
          <ul class="space-y-1.5">
            <li v-for="entry in summary.unknownKeys" :key="entry.key" class="text-sm">
              <code class="font-mono">{{ entry.key }}</code>
              <span class="text-muted">
                on {{ entry.tests }} {{ plural(entry.tests, 'test', 'tests') }}: {{ entry.examples.join(', ')
                }}<template v-if="entry.tests > MAX_UNKNOWN_KEY_EXAMPLES">, …</template>
              </span>
            </li>
          </ul>
          <p v-if="hiddenUnknownKeys > 0" class="mt-1 text-xs text-muted">
            and {{ hiddenUnknownKeys }} more {{ plural(hiddenUnknownKeys, 'key', 'keys') }}.
          </p>
        </template>
      </div>

      <div class="flex flex-wrap items-center justify-between gap-2" data-testid="test-management-catalog">
        <p class="text-sm text-muted">
          <template v-if="summary.catalogRead">
            Catalog: {{ summary.catalogSize }} {{ plural(summary.catalogSize, 'test case', 'test cases') }}, read
            <ClientDate :date="summary.catalogFetchedAt" />.
          </template>
          <template v-else>Catalog: not read yet.</template>
        </p>
        <UButton
          label="Refresh catalog"
          icon="i-lucide-refresh-cw"
          size="xs"
          color="neutral"
          variant="outline"
          :loading="refreshing"
          data-testid="test-management-refresh"
          @click="refresh"
        />
      </div>
    </template>
  </div>
</template>
