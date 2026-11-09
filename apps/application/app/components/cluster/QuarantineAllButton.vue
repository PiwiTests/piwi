<script setup lang="ts">
/**
 * "Quarantine all affected" for a cluster — quarantines every test of the
 * cluster that is not already quarantined, the ones past the listed page
 * included, in one request to the cluster's quarantine route. A confirmation
 * step guards against quarantining more than a few tests at once; a single test
 * skips it. Where the project records coverage, the confirmation says what
 * quarantining the listed tests leaves to no other trusted test once that is
 * read. One toast says how many were quarantined.
 */
import type { ApiResponse } from '~~/types/api';

interface QuarantinableCase {
  testCaseId: number;
  quarantined: boolean;
}

const props = defineProps<{
  clusterId: number;
  projectId: string | number | null | undefined;
  /** The cluster's tests the page lists, whose coverage loss the confirmation previews. */
  cases: QuarantinableCase[];
  /** How many of the cluster's tests are not quarantined, the unlisted ones included. */
  pendingCount: number;
  /** Reason stored on each quarantine entry. */
  reason: string;
  /** Render only the confirmation modal; the action is invoked via `trigger()`. */
  hideTrigger?: boolean;
}>();

const emit = defineEmits<{ changed: [] }>();

const CONFIRM_THRESHOLD = 3;

const toast = useToast();

const confirmOpen = ref(false);
const busy = ref(false);

const coverageActive = useCoverageActive(props.projectId);
const { load: loadLoss, answerFor: lossFor } = useCoverageLoss(() => props.projectId, coverageActive);
const pendingIds = computed(() => props.cases.filter((c) => !c.quarantined).map((c) => c.testCaseId));
watch(confirmOpen, (open) => {
  if (open) void loadLoss(pendingIds.value);
});

async function run() {
  if (props.pendingCount === 0) return;
  busy.value = true;
  try {
    const { quarantined } = await $fetch<
      ApiResponse<typeof import('~~/server/api/failure-clusters/[id]/quarantine.post').default>
    >(`/api/failure-clusters/${props.clusterId}/quarantine`, { method: 'POST', body: { reason: props.reason } });
    toast.add({ title: `Quarantined ${quarantined} test${quarantined === 1 ? '' : 's'}`, color: 'success' });
    emit('changed');
  } catch {
    toast.add({ title: 'Could not quarantine the cluster’s tests', color: 'error' });
  } finally {
    busy.value = false;
    confirmOpen.value = false;
  }
}

function onClick() {
  if (props.pendingCount === 0) return;
  if (props.pendingCount > CONFIRM_THRESHOLD) confirmOpen.value = true;
  else run();
}

defineExpose({ trigger: onClick });
</script>

<template>
  <div v-if="pendingCount > 0" class="inline-flex">
    <UButton
      v-if="!hideTrigger"
      size="xs"
      variant="outline"
      color="warning"
      icon="i-lucide-shield-alert"
      :loading="busy"
      title="Quarantine every affected test that is not already quarantined"
      @click="onClick"
    >
      Quarantine all affected{{ pendingCount > 1 ? ` (${pendingCount})` : '' }}
    </UButton>

    <UModal v-model:open="confirmOpen" title="Quarantine all affected tests">
      <template #body>
        <p class="text-sm text-muted">
          This quarantines {{ pendingCount }} tests. Each keeps running and reporting but is excluded from the CI gate's
          verdict until released.
        </p>
        <CoverageLossPreview
          v-if="coverageActive && projectId != null"
          class="mt-3"
          :answer="lossFor(pendingIds)"
          :project-id="projectId"
        />
      </template>
      <template #footer>
        <div class="flex items-center gap-3 w-full justify-end">
          <UButton color="neutral" variant="ghost" :disabled="busy" @click="confirmOpen = false">Cancel</UButton>
          <UButton color="warning" :loading="busy" @click="run">Quarantine {{ pendingCount }}</UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
