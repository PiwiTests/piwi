<script setup lang="ts">
/**
 * The tests a cluster affects — the evidence selector, shown when the cluster
 * has several. Rows sort by their latest failure; clicking a row selects it
 * (`selectedCaseId`, v-model), which switches the page's evidence and story to
 * that test's latest execution; the Evidence card names it. The checkboxes stay
 * for the bulk bar: *Move to a new cluster* (the extract endpoint) and
 * *Quarantine*.
 */
import type { TestCaseResult } from '~~/types/api';
import { errorMessage } from '~/utils';

interface AffectedCase {
  testCaseId: number;
  title: string;
  filePath: string;
  runCount: number;
  recentTestRunsCaseId: number;
  quarantined?: boolean;
}

const props = defineProps<{
  clusterId: number;
  cases: AffectedCase[];
  /** The selected test whose evidence is shown (v-model). */
  selectedCaseId?: number;
  projectId?: string | number | null;
  projectKey?: string | number | null;
  projectName?: string | null;
}>();

const emit = defineEmits<{ changed: []; 'update:selectedCaseId': [id: number] }>();

// Rows sort by their latest failure — the most recent execution first, so the
// default selection (the cluster's latest occurrence) leads the list.
const sortedCases = computed(() => [...props.cases].sort((a, b) => b.recentTestRunsCaseId - a.recentTestRunsCaseId));

const toast = useToast();

// The bulk bar's actions: moving tests out of the cluster is triage, the other
// one quarantine; each shows to the holders of its permission on the project.
const { can } = useAuth();
const canMove = computed(() => can('triage:write', props.projectId));
const canQuarantine = computed(() => can('quarantine:write', props.projectId));
const canSelect = computed(() => canMove.value || canQuarantine.value);
// What quarantining the selection leaves uncovered, beside its button, where the project records coverage.
const coverageActive = useCoverageActive(props.projectId);

// A cluster is a set of same-way failures, so each affected test reads as a
// failing row linking to its latest execution.
function toRow(c: AffectedCase): TestCaseResult {
  return {
    executionId: c.recentTestRunsCaseId,
    title: c.title,
    status: 'failed',
    location: c.filePath,
    failureClusterId: null,
  } as unknown as TestCaseResult;
}

// ── Selection ────────────────────────────────────────────────────────────────
const selected = ref<Set<number>>(new Set());
function toggle(id: number) {
  const next = new Set(selected.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selected.value = next;
}
function clearSelection() {
  selected.value = new Set();
}
const selectedCount = computed(() => selected.value.size);

// ── Move to a new cluster (the extract endpoint) ─────────────────────────────
const moveOpen = ref(false);
const moveNote = ref('');
const moving = ref(false);
function openMove() {
  moveNote.value = '';
  moveOpen.value = true;
}
async function confirmMove() {
  if (!selectedCount.value) return;
  moving.value = true;
  try {
    const result = await $fetch<{ clusterId: number | null }>(
      `/api/failure-clusters/${props.clusterId}/extract-cases`,
      {
        method: 'POST',
        body: { testCaseIds: [...selected.value], triageNote: moveNote.value.trim() || undefined },
      },
    );
    toast.add({
      title: result.clusterId
        ? `Moved ${selectedCount.value} test${selectedCount.value === 1 ? '' : 's'} to cluster #${result.clusterId}`
        : 'None of these tests failed in this cluster',
      color: result.clusterId ? 'success' : 'warning',
      actions: result.clusterId
        ? [{ label: 'Open', to: `/failure-clusters/${result.clusterId}`, color: 'neutral', variant: 'outline' }]
        : undefined,
    });
    moveOpen.value = false;
    clearSelection();
    emit('changed');
  } catch (err: unknown) {
    toast.add({ title: 'Could not move the tests', description: errorMessage(err), color: 'error' });
  } finally {
    moving.value = false;
  }
}

// ── Quarantine the selected tests ────────────────────────────────────────────
const { quarantineMany } = useQuarantine(() => props.projectId ?? null);
const quarantining = ref(false);
async function quarantineSelected() {
  if (!selectedCount.value) return;
  quarantining.value = true;
  try {
    const { succeeded, failed } = await quarantineMany(
      [...selected.value],
      () => `Quarantined from cluster #${props.clusterId}`,
    );
    if (succeeded) toast.add({ title: `Quarantined ${succeeded} test${succeeded === 1 ? '' : 's'}`, color: 'success' });
    if (failed) toast.add({ title: `${failed} could not be quarantined`, color: 'error' });
    clearSelection();
    emit('changed');
  } finally {
    quarantining.value = false;
  }
}
</script>

<template>
  <SectionCard
    icon="i-lucide-list-checks"
    :title="`Affected tests (${cases.length})`"
    subtitle="The evidence below shows the selected test."
    data-shot="cluster-affected-tests"
  >
    <div class="rounded-lg border border-default overflow-hidden">
      <TestRow
        v-for="c in sortedCases"
        :key="c.testCaseId"
        :test-case="toRow(c)"
        :show-cluster="false"
        :quarantined="c.quarantined"
        :selectable="canSelect"
        :selected="selected.has(c.testCaseId)"
        select-on-click
        :active="c.testCaseId === selectedCaseId"
        :project-key="projectKey"
        :project-name="projectName"
        @toggle="toggle(c.testCaseId)"
        @select="emit('update:selectedCaseId', c.testCaseId)"
      />
    </div>

    <!-- Bulk bar -->
    <div
      v-if="canSelect && selectedCount"
      class="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-default bg-elevated p-2.5"
    >
      <span class="text-sm font-medium">{{ selectedCount }} selected</span>
      <span class="flex-1" />
      <UButton
        v-if="canMove"
        size="xs"
        color="neutral"
        variant="outline"
        icon="i-lucide-arrow-up-from-line"
        :loading="moving"
        @click="openMove"
      >
        Move to a new cluster
      </UButton>
      <CoverageLossPopover
        v-if="canQuarantine"
        :project-id="projectId ?? 0"
        :project-name="projectName"
        :test-case-ids="[...selected]"
        :active="coverageActive"
      >
        <UButton
          size="xs"
          color="neutral"
          variant="outline"
          icon="i-lucide-shield-alert"
          :loading="quarantining"
          @click="quarantineSelected"
        >
          Quarantine
        </UButton>
      </CoverageLossPopover>
      <UButton size="xs" color="neutral" variant="ghost" @click="clearSelection">Clear</UButton>
    </div>
  </SectionCard>

  <UModal v-model:open="moveOpen" title="Move to a new cluster">
    <template #body>
      <div class="space-y-3">
        <p class="text-sm text-muted">
          {{ selectedCount }} test{{ selectedCount === 1 ? '' : 's' }} and {{ selectedCount === 1 ? 'its' : 'their' }}
          failures move to a new cluster. Later failures of
          {{ selectedCount === 1 ? 'this test' : 'these tests' }} with the same error join the new cluster, and the two
          clusters are never merged automatically.
        </p>
        <UFormField label="Triage note for the new cluster (optional)">
          <UTextarea v-model="moveNote" placeholder="Why are these being moved out?" :rows="2" class="w-full" />
        </UFormField>
      </div>
    </template>
    <template #footer>
      <div class="flex items-center gap-2 justify-end w-full">
        <UButton color="neutral" variant="ghost" @click="moveOpen = false">Cancel</UButton>
        <UButton color="primary" :loading="moving" @click="confirmMove">
          Move {{ selectedCount }} test{{ selectedCount === 1 ? '' : 's' }}
        </UButton>
      </div>
    </template>
  </UModal>
</template>
