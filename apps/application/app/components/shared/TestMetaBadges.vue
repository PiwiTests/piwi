<script setup lang="ts">
/**
 * Tags and ownership metadata for one test, rendered as a badge row.
 *
 * Used wherever a test is listed (run test cases, the project catalog, the flaky
 * leaderboard) and on the test-case detail header, so a tag looks the same
 * everywhere. Renders nothing at all when a test declared none, which is the
 * common case — the row must not reserve space it isn't using.
 */
import { TEST_PRIORITIES, type TestMetadata } from '@piwitests/core/test-meta';

const props = withDefaults(
  defineProps<{
    tags?: string[] | null;
    /** Lock names this test held — a shared resource the runner serializes holders of. */
    locks?: string[] | null;
    meta?: TestMetadata | null;
    /** Cap the tags shown; the rest collapse into a `+N` badge. 0 = no cap. */
    maxTags?: number;
  }>(),
  { tags: null, locks: null, meta: null, maxTags: 0 },
);

type BadgeColor = 'error' | 'warning' | 'info' | 'neutral';

const PRIORITY_COLOR: Record<(typeof TEST_PRIORITIES)[number], BadgeColor> = {
  critical: 'error',
  high: 'warning',
  medium: 'info',
  low: 'neutral',
};

const shownTags = computed(() => {
  const all = props.tags ?? [];
  return props.maxTags > 0 ? all.slice(0, props.maxTags) : all;
});

const hiddenCount = computed(() => Math.max(0, (props.tags?.length ?? 0) - shownTags.value.length));
const hiddenTitle = computed(() => (props.tags ?? []).slice(shownTags.value.length).join(', '));

const priorityColor = computed<BadgeColor>(() =>
  props.meta?.priority ? (PRIORITY_COLOR[props.meta.priority] ?? 'neutral') : 'neutral',
);

const locks = computed(() => props.locks ?? []);

const hasAnything = computed(
  () =>
    shownTags.value.length > 0 ||
    locks.value.length > 0 ||
    Boolean(props.meta?.owner || props.meta?.priority || props.meta?.feature || props.meta?.link),
);
</script>

<template>
  <div v-if="hasAnything" class="inline-flex items-center gap-1 flex-wrap">
    <UBadge v-if="meta?.priority" :color="priorityColor" variant="soft" size="xs" class="shrink-0 capitalize">
      {{ meta.priority }}
    </UBadge>

    <TestCaseKeyHoverCard v-for="tag in shownTags" :key="tag" kind="tag" :value="tag">
      <UBadge color="primary" variant="soft" size="xs" class="shrink-0 font-mono">@{{ tag }}</UBadge>
    </TestCaseKeyHoverCard>

    <UBadge v-if="hiddenCount > 0" color="neutral" variant="soft" size="xs" class="shrink-0" :title="hiddenTitle">
      +{{ hiddenCount }}
    </UBadge>

    <UBadge
      v-for="lock in locks"
      :key="`lock:${lock}`"
      color="warning"
      variant="soft"
      size="xs"
      class="shrink-0 gap-1"
      :title="`Lock ${lock}: only one holder runs at a time`"
    >
      <UIcon name="i-lucide-lock" class="size-2.5 shrink-0" />
      {{ lock }}
    </UBadge>

    <UBadge v-if="meta?.owner" color="neutral" variant="soft" size="xs" class="shrink-0 gap-1">
      <UIcon name="i-lucide-user" class="size-2.5 shrink-0" />
      {{ meta.owner }}
    </UBadge>

    <UBadge v-if="meta?.feature" color="neutral" variant="outline" size="xs" class="shrink-0">
      {{ meta.feature }}
    </UBadge>

    <ULink
      v-if="meta?.link"
      :to="meta.link"
      target="_blank"
      rel="noopener noreferrer"
      class="text-gray-500 hover:text-primary shrink-0"
      :title="meta.link"
      @click.stop
    >
      <UIcon name="i-lucide-external-link" class="size-3" />
    </ULink>
  </div>
</template>
