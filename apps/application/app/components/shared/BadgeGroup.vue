<script setup lang="ts">
/**
 * A capped row of badges: the first `max` are shown inline, the rest fold into
 * a `+N` badge whose popover lists them all. The caller orders the list so the
 * badges that matter most (a test row's exceptional signals) survive the cap;
 * `BadgeGroup` only decides how many are visible.
 *
 * Shared by every `TestRow` so a badge looks the same wherever a test is listed.
 * Renders nothing when the list is empty — the row never reserves unused space.
 */
import type { TestRowBadge } from '~/utils/test-row-badges';

const props = withDefaults(
  defineProps<{
    badges: TestRowBadge[];
    /** How many badges to show before the rest collapse into `+N`. */
    max?: number;
  }>(),
  { max: 3 },
);

const visible = computed(() => (props.max > 0 ? props.badges.slice(0, props.max) : props.badges));
const hidden = computed(() => (props.max > 0 ? props.badges.slice(props.max) : []));

function badgeClass(badge: TestRowBadge): string {
  return ['shrink-0 items-center gap-1', badge.mono ? 'font-mono' : ''].join(' ');
}
</script>

<template>
  <div v-if="badges.length" class="inline-flex items-center gap-1 flex-wrap min-w-0">
    <TestCaseKeyHoverCard v-for="badge in visible" :key="badge.key" kind="tag" :value="badge.tag">
      <UBadge :color="badge.color" :variant="badge.variant" size="xs" :title="badge.title" :class="badgeClass(badge)">
        <UIcon v-if="badge.icon" :name="badge.icon" class="size-2.5 shrink-0" />
        {{ badge.label }}
      </UBadge>
    </TestCaseKeyHoverCard>

    <UPopover v-if="hidden.length" mode="hover" :content="{ side: 'top' }">
      <UBadge
        color="neutral"
        variant="soft"
        size="xs"
        class="shrink-0 cursor-default"
        :aria-label="`${hidden.length} more badges`"
      >
        +{{ hidden.length }}
      </UBadge>
      <template #content>
        <div class="p-2 flex flex-wrap gap-1 max-w-64">
          <UBadge
            v-for="badge in hidden"
            :key="badge.key"
            :color="badge.color"
            :variant="badge.variant"
            size="xs"
            :title="badge.title"
            :class="badgeClass(badge)"
          >
            <UIcon v-if="badge.icon" :name="badge.icon" class="size-2.5 shrink-0" />
            {{ badge.label }}
          </UBadge>
        </div>
      </template>
    </UPopover>
  </div>
</template>
