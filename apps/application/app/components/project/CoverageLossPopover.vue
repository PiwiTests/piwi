<script setup lang="ts">
/**
 * A quarantine or release button with what it does to the code no other
 * trusted test runs, shown beside it on hover or focus (`CoverageLossPreview`).
 * The read starts when the pointer or the focus reaches the button and the
 * preview opens once it arrived with something to say; the button itself acts
 * at once, whatever the read. Without `active` (the project's coverage
 * capability is not active), the button renders alone.
 */
import { coverageLossPreview } from '~/utils/coverage-insights';

const props = defineProps<{
  projectId: string | number;
  projectName?: string | null;
  testCaseIds: number[];
  action?: 'quarantine' | 'release';
  /** Whether the project's coverage capability is active. */
  active: boolean;
}>();

const { load, answerFor } = useCoverageLoss(
  () => props.projectId,
  () => props.active,
);

const wanted = ref(false);
const answer = computed(() => answerFor(props.testCaseIds));
const hasPreview = computed(() => coverageLossPreview(answer.value, props.action ?? 'quarantine') !== null);

function onOpen(open: boolean) {
  wanted.value = open;
  if (open) void load(props.testCaseIds);
}
</script>

<template>
  <UPopover
    v-if="active"
    mode="hover"
    :open="wanted && hasPreview"
    :open-delay="200"
    :close-delay="150"
    :content="{ side: 'top', align: 'end' }"
    @update:open="onOpen"
  >
    <slot />
    <template #content>
      <div class="w-80 max-w-[calc(100vw-2rem)] p-3">
        <CoverageLossPreview :answer="answer" :action="action" :project-id="projectId" :project-name="projectName" />
      </div>
    </template>
  </UPopover>
  <slot v-else />
</template>
