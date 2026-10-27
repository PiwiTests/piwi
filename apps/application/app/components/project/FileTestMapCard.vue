<script setup lang="ts">
/**
 * A file's place in the Test Map, on its coverage page: the nodes the file is
 * or serves (its route handler, the routes the handler serves, the page or
 * route its file name gives it, the file itself), each with the tests that
 * reach it, its feature and its open scenario gaps, and a link that opens the
 * Gaps tab's graph on it. Coverage says which lines ran; this says which user
 * paths reach the file and which tests are still to write. Renders nothing
 * where the project declined the Test Map, or the map holds nothing for the
 * file. Self-contained: it reads `GET /api/projects/:id/gaps/file` when the
 * file changes.
 */
import type { FileNodeVia, FileTestMap, FileTestMapNode } from '~~/server/utils/feature-graph';
import { SENTENCE_LINK_CLASS } from '~/utils';

const props = defineProps<{ projectId: number; path: string }>();

const { isHidden } = await useProjectCapabilities(props.projectId);

const map = ref<FileTestMap | null>(null);
let request = 0;
watch(
  () => [props.projectId, props.path, isHidden('test-map')] as const,
  async ([projectId, path, hidden]) => {
    const token = ++request;
    map.value = null;
    if (hidden || !path) return;
    const read = await $fetch<FileTestMap>(`/api/projects/${projectId}/gaps/file`, { query: { path } }).catch(
      () => null,
    );
    if (token === request) map.value = read;
  },
  { immediate: true },
);

const KIND_LABEL: Record<FileTestMapNode['kind'], string> = {
  page: 'Page',
  route: 'Route',
  handler: 'Handler',
  file: 'File',
};
const VIA_LABEL: Record<FileNodeVia, string> = {
  node: 'this file',
  'handled-by': 'served by this file',
  convention: 'by its file name',
};

/** The Gaps tab, its graph open on the node. */
function nodeLink(node: FileTestMapNode) {
  return { path: `/projects/${props.projectId}`, query: { tab: 'gaps', node: `${node.kind}:${node.key}` } };
}

function factsOf(node: FileTestMapNode): string {
  const facts = [
    VIA_LABEL[node.via],
    node.tests === 0 ? 'no test reaches it' : `reached by ${node.tests} test${node.tests === 1 ? '' : 's'}`,
  ];
  if (node.feature) facts.push(node.feature);
  return facts.join(' · ');
}

const openGaps = computed(() => map.value?.nodes.reduce((n, node) => n + node.openGaps, 0) ?? 0);
const subtitle = computed(() =>
  openGaps.value === 0
    ? 'The user paths that reach this file. No test is missing on them.'
    : `The user paths that reach this file, and ${openGaps.value} test${openGaps.value === 1 ? '' : 's'} still to write on them.`,
);
</script>

<template>
  <SectionCard
    v-if="map && map.nodes.length > 0"
    title="In the Test Map"
    icon="i-lucide-radar"
    help="coverage.test-map"
    data-tour="coverage-file-test-map"
    data-shot="coverage-file-test-map"
  >
    <template #subtitle>
      <span data-testid="coverage-file-test-map-summary">{{ subtitle }}</span>
    </template>
    <ul class="divide-y divide-default">
      <li
        v-for="node in map.nodes"
        :key="`${node.kind}:${node.key}`"
        class="py-2 space-y-1"
        :data-test-map-node="`${node.kind}:${node.key}`"
      >
        <p class="text-sm text-highlighted min-w-0 break-words">
          <span class="font-semibold">{{ KIND_LABEL[node.kind] }}</span>
          {{ ' ' }}
          <NuxtLink
            :to="nodeLink(node)"
            class="font-mono"
            :class="SENTENCE_LINK_CLASS"
            :title="`Open ${node.kind}:${node.key} in the Test Map's graph`"
            >{{ node.key }}</NuxtLink
          >
        </p>
        <p class="text-xs text-muted">{{ factsOf(node) }}</p>
        <ul v-if="node.gaps.length > 0" class="space-y-0.5" data-test-map-gaps>
          <li v-for="gap in node.gaps" :key="gap.id" class="text-xs text-muted">
            <span class="text-default">{{ gap.title }}</span> · {{ gap.class }}
          </li>
          <li v-if="node.openGaps > node.gaps.length" class="text-xs text-muted">
            and {{ node.openGaps - node.gaps.length }} more open
          </li>
        </ul>
      </li>
    </ul>
  </SectionCard>
</template>
