<script setup lang="ts">
/**
 * "Quarantine all affected" for a cluster — quarantines every affected test that
 * is not already quarantined, in one action. A confirmation step guards against
 * quarantining more than a few tests at once; a single test skips it. Where the
 * project records coverage, the confirmation says what the quarantine leaves to
 * no other trusted test once that is read. One toast summarizes how many were
 * quarantined and how many failed.
 */
interface QuarantinableCase {
  testCaseId: number;
  quarantined: boolean;
}

const props = defineProps<{
  projectId: string | number | null | undefined;
  cases: QuarantinableCase[];
  /** Reason stored on each quarantine entry. */
  reason: string;
  /** Render only the confirmation modal; the action is invoked via `trigger()`. */
  hideTrigger?: boolean;
}>();

const emit = defineEmits<{ changed: [] }>();

const CONFIRM_THRESHOLD = 3;

const toast = useToast();
const { quarantineMany } = useQuarantine(() => props.projectId ?? null);

const pending = computed(() => props.cases.filter((c) => !c.quarantined));
const confirmOpen = ref(false);
const busy = ref(false);

const coverageActive = useCoverageActive(props.projectId);
const { load: loadLoss, answerFor: lossFor } = useCoverageLoss(() => props.projectId, coverageActive);
const pendingIds = computed(() => pending.value.map((c) => c.testCaseId));
watch(confirmOpen, (open) => {
  if (open) void loadLoss(pendingIds.value);
});

async function run() {
  const ids = pending.value.map((c) => c.testCaseId);
  if (ids.length === 0) return;
  busy.value = true;
  try {
    const { succeeded, failed } = await quarantineMany(ids, () => props.reason);
    if (failed === 0) {
      toast.add({
        title: `Quarantined ${succeeded} test${succeeded === 1 ? '' : 's'}`,
        color: 'success',
      });
    } else {
      toast.add({
        title: `Quarantined ${succeeded} of ${ids.length}`,
        description: `${failed} could not be quarantined.`,
        color: succeeded > 0 ? 'warning' : 'error',
      });
    }
    if (succeeded > 0) emit('changed');
  } finally {
    busy.value = false;
    confirmOpen.value = false;
  }
}

function onClick() {
  if (pending.value.length === 0) return;
  if (pending.value.length > CONFIRM_THRESHOLD) confirmOpen.value = true;
  else run();
}

defineExpose({ trigger: onClick });
</script>

<template>
  <div v-if="pending.length > 0" class="inline-flex">
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
      Quarantine all affected{{ pending.length > 1 ? ` (${pending.length})` : '' }}
    </UButton>

    <UModal v-model:open="confirmOpen" title="Quarantine all affected tests">
      <template #body>
        <p class="text-sm text-muted">
          This quarantines {{ pending.length }} tests. Each keeps running and reporting but is excluded from the CI
          gate's verdict until released.
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
          <UButton color="warning" :loading="busy" @click="run">Quarantine {{ pending.length }}</UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
