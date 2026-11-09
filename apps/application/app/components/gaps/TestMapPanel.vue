<script setup lang="ts">
/**
 * The Coverage tab's Map view: the project graph folded per feature, the graph
 * of one node, and map health, which says what inputs the map has and which it
 * lacks. The node the graph is open on is the address's `?node=kind:key`, so a
 * link from another page (a file's coverage, a gap of the Gaps view) opens the
 * view on that node.
 */

const props = defineProps<{ projectId: number }>();
const route = useRoute();
const router = useRouter();

const graphSeed = ref<string | null>(
  typeof route.query.node === 'string' && route.query.node ? route.query.node : null,
);
const graphCard = ref<HTMLElement | null>(null);
// The graph's node is the address's `?node=`: an open graph can be shared, and a link can open one,
// also while the view is open.
watch(graphSeed, (node) => {
  if ((route.query.node ?? null) === node) return;
  router.replace({ query: { ...route.query, node: node ?? undefined } });
});
watch(
  () => route.query.node,
  (node) => {
    const seed = typeof node === 'string' && node ? node : null;
    if (seed !== graphSeed.value) graphSeed.value = seed;
  },
);
onMounted(() => {
  if (graphSeed.value) nextTick(() => graphCard.value?.scrollIntoView?.({ block: 'start' }));
});

/** Open a node in the graph view and bring the view into sight. */
function openInGraph(node: { kind: string; key: string }) {
  graphSeed.value = `${node.kind}:${node.key}`;
  nextTick(() => graphCard.value?.scrollIntoView?.({ behavior: 'smooth', block: 'start' }));
}
</script>

<template>
  <div class="space-y-4" data-shot="test-map-panel">
    <SectionCard
      title="Feature map"
      subtitle="The project graph folded per feature — click one to open it in the graph"
    >
      <FeatureMapView :project-id="props.projectId" :selected="graphSeed" @select="openInGraph" />
    </SectionCard>

    <div v-if="graphSeed" ref="graphCard" class="scroll-mt-4">
      <SectionCard title="Feature graph">
        <template #actions>
          <UButton
            size="xs"
            color="neutral"
            variant="ghost"
            icon="i-lucide-x"
            aria-label="Close feature graph"
            @click="graphSeed = null"
          />
        </template>
        <FeatureGraphView :project-id="props.projectId" :seed-node="graphSeed" @select="openInGraph" />
      </SectionCard>
    </div>

    <SectionCard
      data-shot="map-health-card"
      title="Map health"
      subtitle="What the map can see: an input it lacks keeps the detectors that read it silent"
    >
      <MapHealthView :project-id="props.projectId" />
    </SectionCard>
  </div>
</template>
