<script setup lang="ts">
/**
 * The "Test source" evidence block. Baseline: the reporter-captured in-project
 * frames (TestSourceStack) or the legacy single snippet. When the execution
 * has a trace, it goes deeper — the complete call stack with real source is
 * loaded lazily from the trace and becomes the default view, with a toggle
 * back to the captured frames. Without a trace, a footer hint tells the user
 * what enabling tracing would add; the trace is never a requirement.
 */
import type { TestSourceFrame } from '~~/types/api';
import type { DebugInIdeTarget } from '~/composables/useOpenInIde';
import SectionCard from '../shared/SectionCard.vue';
import CollapsibleSectionCard from '../shared/CollapsibleSectionCard.vue';

const props = defineProps<{
  frames: TestSourceFrame[] | null;
  testSource: string | null;
  runId: number | null;
  testRunsCaseId: number;
  hasTrace: boolean;
  projectKey?: string | number | null;
  projectName?: string | null;
  /** When set, the card folds to a header with a peek (persisted per user); without one it is always open. */
  storageKey?: string;
  /** Whether the card starts folded on first visit (no stored cookie). */
  defaultFolded?: boolean;
  /** Drop the card frame and padding — render a plain heading row over the body. */
  embedded?: boolean;
  /** Debug in my editor's target, offered beside the failing line's frame in either view. */
  debugTarget?: DebugInIdeTarget | null;
}>();

const cardComponent = computed(() =>
  props.embedded ? SectionCard : props.storageKey ? CollapsibleSectionCard : SectionCard,
);
const cardBind = computed(() =>
  props.embedded
    ? { embedded: true }
    : props.storageKey
      ? { storageKey: props.storageKey, defaultFolded: props.defaultFolded }
      : {},
);

const { data: stack, pending: stackPending } = useTraceCallStack(
  () => props.runId,
  () => props.testRunsCaseId,
  () => props.hasTrace,
  { auto: true },
);

const traceFrames = computed(() => (stack.value?.status === 'ok' ? (stack.value.frames ?? []) : []));
const traceAvailable = computed(() => traceFrames.value.length > 0);
const capturedCount = computed(() => props.frames?.length ?? 0);
const capturedAvailable = computed(() => capturedCount.value > 0 || !!props.testSource);

/** User's explicit toggle choice; before any choice the trace view wins once loaded. */
const manualMode = ref<'trace' | 'captured' | null>(null);
const mode = computed<'trace' | 'captured'>({
  get: () => manualMode.value ?? (traceAvailable.value ? 'trace' : 'captured'),
  set: (value) => {
    manualMode.value = value;
  },
});

const modeItems = computed(() => [
  { label: `Full stack (${traceFrames.value.length})`, value: 'trace' as const },
  { label: `Captured (${capturedCount.value || 1})`, value: 'captured' as const },
]);

const count = computed(() =>
  mode.value === 'trace' && traceAvailable.value ? traceFrames.value.length : capturedCount.value || null,
);

const card = ref<{ reveal?: () => void; $el?: HTMLElement } | null>(null);
function reveal() {
  if (card.value?.reveal) card.value.reveal();
  else card.value?.$el?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
}
defineExpose({ reveal });
</script>

<template>
  <component
    :is="cardComponent"
    ref="card"
    v-bind="cardBind"
    icon="i-lucide-code"
    :count="count"
    title="Test source"
    help="case.test-source"
  >
    <template v-if="storageKey" #folded>
      <template v-if="mode === 'trace' && traceAvailable">
        Full call stack from the trace{{ stack?.hasSources === false ? ' (recorded without sources)' : '' }}
      </template>
      <template v-else-if="capturedCount > 1">
        The failing line and {{ capturedCount - 1 }} caller{{ capturedCount - 1 === 1 ? '' : 's' }}
      </template>
      <template v-else>Source around the failing assertion</template>
    </template>

    <template v-if="traceAvailable && capturedAvailable" #actions>
      <UTabs v-model="mode" :items="modeItems" size="xs" variant="link" :ui="{ list: 'gap-2', trigger: 'px-1.5' }" />
    </template>

    <div class="max-h-[32rem] overflow-y-auto">
      <template v-if="mode === 'trace' && traceAvailable">
        <p
          v-if="stack?.hasSources === false"
          class="mb-2 flex items-center gap-1.5 text-xs text-gray-400 dark:text-gray-500"
        >
          <UIcon name="i-lucide-info" class="size-3.5 shrink-0" />
          Trace recorded without sources — frame list only.
        </p>
        <TraceCallStack
          :frames="traceFrames"
          :project-key="projectKey"
          :project-name="projectName"
          :debug-target="debugTarget"
        />
      </template>
      <template v-else>
        <TestSourceStack
          v-if="frames?.length"
          :frames="frames"
          :project-key="projectKey"
          :project-name="projectName"
          :debug-target="debugTarget"
        />
        <MarkdownPreview v-else-if="testSource" :text="'```typescript\n' + testSource + '\n```'" />
        <LoadingState v-else-if="hasTrace && stackPending" text="Loading call stack from trace…" />
      </template>
    </div>

    <p v-if="!hasTrace" class="mt-3 flex items-center gap-1.5 text-xs text-gray-400 dark:text-gray-500">
      <UIcon name="i-lucide-info" class="size-3.5 shrink-0" />
      <span>
        Want to go deeper? Record traces (<code>trace: 'retain-on-failure'</code>) to see the full call stack with
        source here.
        <DocLink to="features/evidence#trace-powered-deep-views" no-icon class="underline">Learn more</DocLink>
      </span>
    </p>
  </component>
</template>
