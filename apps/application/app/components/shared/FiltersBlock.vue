<script setup lang="ts">
/**
 * The block every page's filters sit in: a bordered block whose header row
 * carries the *Filters* heading, the block's help hint and *Reset*. Below `sm`
 * it starts folded to a one-line summary of the active filters; wider, it
 * starts open, and a click on the heading folds or opens it at any width.
 *
 * `inline` puts the controls on the heading's row from `sm` up, for a block
 * with one row of controls; without it they sit in a body under a divider.
 * Below `sm` the block is full-bleed like every card in the gutterless panel.
 * The `notes` slot is a line under the controls: what the filters hide, or
 * where the scope came from. It folds with the controls, so the summary
 * should mention what it says.
 */
import type { HelpTopicKey } from '~/utils/help-content';

const props = withDefaults(
  defineProps<{
    /** The one line the folded block reads: every active filter. */
    summary: string;
    /** Offers *Reset*: a filter differs from its default. */
    resettable?: boolean;
    /** The heading: *Default filters* while a dashboard is edited. */
    title?: string;
    inline?: boolean;
    help?: HelpTopicKey;
    /** The block's test id; its toggle and summary take `<testId>-toggle` and `<testId>-summary`. */
    testId?: string;
  }>(),
  { resettable: false, title: 'Filters', inline: false, help: undefined, testId: undefined },
);

const emit = defineEmits<{ reset: [] }>();

const bodyId = useId();

// Open or folded: null follows the viewport (folded below `sm`, open above) in
// CSS alone, so the server render already matches; a click fixes it either way.
const expanded = ref<boolean | null>(null);
const wide = ref(true);
onMounted(() => {
  wide.value = window.matchMedia('(min-width: 640px)').matches;
});
const isOpen = computed(() => expanded.value ?? wide.value);

function toggle() {
  wide.value = window.matchMedia('(min-width: 640px)').matches;
  expanded.value = !isOpen.value;
}

const bodyClass = computed(() => (expanded.value === null ? 'hidden sm:block' : expanded.value ? '' : 'hidden'));
const summaryClass = computed(() => (expanded.value === null ? 'sm:hidden' : expanded.value ? 'hidden' : ''));
const testIdOf = (part: string) => (props.testId ? `${props.testId}-${part}` : undefined);
</script>

<template>
  <section
    class="rounded-lg border border-default bg-default max-sm:rounded-none max-sm:border-x-0"
    :data-testid="testId"
  >
    <div class="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2 sm:px-4 min-h-11">
      <h2 class="shrink-0 text-sm font-semibold text-highlighted">
        <button
          type="button"
          class="flex items-center gap-1.5 rounded-sm outline-none focus-visible:outline-2 focus-visible:outline-primary"
          :aria-expanded="isOpen"
          :aria-controls="bodyId"
          :data-testid="testIdOf('toggle')"
          @click="toggle"
        >
          <UIcon
            :name="isOpen ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
            class="size-4 shrink-0 text-muted"
          />
          {{ title }}
        </button>
      </h2>
      <span
        class="min-w-0 flex-1 line-clamp-2 text-xs text-muted cursor-pointer"
        :class="summaryClass"
        :title="summary"
        :data-testid="testIdOf('summary')"
        @click="toggle"
      >
        {{ summary }}
      </span>
      <!-- Inline controls: their own full-width row below `sm`, the heading's row from `sm` up -->
      <div
        v-if="inline"
        :id="bodyId"
        class="order-last basis-full min-w-0 sm:order-none sm:basis-0 sm:flex-1"
        :class="bodyClass"
      >
        <slot />
      </div>
      <div v-if="resettable || help" class="ml-auto flex items-center gap-1 shrink-0">
        <UButton v-if="resettable" variant="ghost" size="sm" color="neutral" icon="i-lucide-x" @click="emit('reset')">
          Reset
        </UButton>
        <HelpHint v-if="help" :topic="help" />
      </div>
    </div>

    <div v-if="!inline" :id="bodyId" class="border-t border-default px-3 py-3 sm:px-4" :class="bodyClass">
      <slot />
    </div>

    <div v-if="$slots.notes" class="px-3 pb-2.5 sm:px-4 text-xs text-muted" :class="bodyClass">
      <slot name="notes" />
    </div>
  </section>
</template>
