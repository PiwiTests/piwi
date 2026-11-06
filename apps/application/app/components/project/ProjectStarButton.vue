<script setup lang="ts">
/** The star of one project: it leads the viewer's sidebar and Home while set. */
const props = defineProps<{
  projectId: number;
  name: string;
  starred: boolean;
  /** A change of this star is waiting for the server: a click then does nothing. */
  pending?: boolean;
}>();

const emit = defineEmits<{ toggle: [] }>();

// The name stays one; `aria-pressed` says whether it is starred, and the tooltip what a click does.
const title = computed(() => (props.starred ? `Unstar ${props.name}` : `Star ${props.name}`));
</script>

<template>
  <UButton
    color="neutral"
    variant="ghost"
    size="xs"
    square
    :aria-label="`Star ${name}`"
    :aria-pressed="starred"
    :aria-busy="pending || undefined"
    :title="title"
    :data-testid="`project-star-${projectId}`"
    :class="pending ? 'opacity-50' : undefined"
    @click="emit('toggle')"
  >
    <!-- Lucide's star, drawn inline: an icon font renders as a mask, which cannot be filled. -->
    <svg
      viewBox="0 0 24 24"
      class="size-4 shrink-0"
      :class="starred ? 'text-highlighted' : 'text-muted'"
      aria-hidden="true"
    >
      <path
        :fill="starred ? 'currentColor' : 'none'"
        stroke="currentColor"
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-width="2"
        d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.12 2.12 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.12 2.12 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.12 2.12 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.12 2.12 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.12 2.12 0 0 0 1.597-1.16z"
      />
    </svg>
  </UButton>
</template>
