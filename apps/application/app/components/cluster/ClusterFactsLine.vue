<script setup lang="ts">
/**
 * The facts line under the cluster's situation block: a Details popover (owner
 * and the links pinned to the cluster, its known issue among them) and the
 * shared "Raw error ▸" disclosure (the sample error and its fingerprint
 * signature). `revealRawError()` lets a citation open
 * the raw error from elsewhere on the page. At `#links`, where an execution's
 * Details send a viewer to edit the cluster's links, the Details open on load.
 */
import type { FailureClusterDetail } from '~~/types/api';

const props = defineProps<{
  cluster: FailureClusterDetail;
  signatureLine: string | null;
}>();

const emit = defineEmits<{ refresh: [] }>();

// Pinning and editing the known issue needs `link:write` on the cluster's project.
const { can } = useAuth();
const canEditLinks = computed(() => can('link:write', props.cluster.project?.id ?? null));

const route = useRoute();
const detailsOpen = ref(false);
const detailsButton = ref<{ $el?: Element } | null>(null);
onMounted(() => {
  if (route.hash !== '#links') return;
  detailsButton.value?.$el?.scrollIntoView({ block: 'nearest' });
  detailsOpen.value = true;
});

const disclosure = ref<{ reveal: () => void } | null>(null);
function revealRawError() {
  disclosure.value?.reveal();
}
defineExpose({ revealRawError });
</script>

<template>
  <div class="flex items-center gap-x-3 gap-y-1 flex-wrap text-xs text-muted">
    <UPopover v-model:open="detailsOpen" :content="{ align: 'start' }">
      <UButton
        id="links"
        ref="detailsButton"
        size="xs"
        variant="ghost"
        color="neutral"
        trailing-icon="i-lucide-chevron-down"
        label="Details"
        class="shrink-0"
        data-tour="cluster-details"
      />
      <template #content>
        <div class="p-3 space-y-3 text-sm w-72">
          <div class="space-y-1">
            <p class="text-xs font-medium text-muted uppercase tracking-wide">Owner</p>
            <ClusterOwnerLine :owner="cluster.owner" :project-id="cluster.project?.id ?? null" />
          </div>
          <div class="space-y-1" data-tour="cluster-links">
            <div class="flex items-center gap-1.5 text-xs">
              <span class="text-muted uppercase tracking-wide font-medium">Links</span>
              <HelpHint topic="cluster.known-issue" />
            </div>
            <EntityLinks
              entity-type="failure_cluster"
              :entity-id="cluster.id"
              :links="cluster.links"
              :readonly="!canEditLinks"
              @updated="emit('refresh')"
            />
          </div>
        </div>
      </template>
    </UPopover>

    <RawErrorDisclosure ref="disclosure" :error="cluster.sampleError" :signature="signatureLine" />
  </div>
</template>
