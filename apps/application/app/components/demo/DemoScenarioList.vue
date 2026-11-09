<script setup lang="ts">
import { DEMO_SCENARIO_GROUPS, type DemoScenario } from '~/demo/simulator';

/**
 * The run simulator's scenarios under the group each is listed in (`DEMO_SCENARIO_GROUPS`), as the demo banner's
 * popover and its bottom sheet on a phone show them. Picking one emits it.
 */
const props = defineProps<{
  scenarios: readonly DemoScenario[];
  /** Two columns per group from `sm` up, in the popover; one in the sheet. */
  columns?: boolean;
}>();
const emit = defineEmits<{ pick: [scenario: DemoScenario] }>();

const groups = computed(() =>
  DEMO_SCENARIO_GROUPS.map((group) => ({
    ...group,
    scenarios: props.scenarios.filter((s) => s.group === group.id),
  })).filter((group) => group.scenarios.length > 0),
);
</script>

<template>
  <div class="flex flex-col gap-3">
    <section v-for="group in groups" :key="group.id" :aria-labelledby="`demo-scenarios-${group.id}`">
      <h3 :id="`demo-scenarios-${group.id}`" class="px-2 pb-1 text-xs font-semibold text-highlighted">
        {{ group.label }}
      </h3>
      <ul class="grid gap-0.5" :class="columns ? 'sm:grid-cols-2' : ''">
        <li v-for="scenario in group.scenarios" :key="scenario.id">
          <button
            type="button"
            class="flex size-full items-start gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-elevated focus-visible:bg-elevated focus-visible:outline-2 focus-visible:outline-primary"
            :data-scenario="scenario.id"
            @click="emit('pick', scenario)"
          >
            <UIcon :name="scenario.icon" class="mt-0.5 size-4.5 shrink-0 text-muted" />
            <span class="flex min-w-0 flex-col">
              <span class="text-sm font-medium text-highlighted">{{ scenario.label }}</span>
              <span class="text-xs text-muted">{{ scenario.description }}</span>
            </span>
          </button>
        </li>
      </ul>
    </section>
  </div>
</template>
