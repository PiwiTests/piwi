<script setup lang="ts">
import type { WireRunError } from '#shared/types';
import { RUN_ERRORS_COLLAPSED_KEY, runErrorHeadline } from '~/utils/run-errors';

/**
 * The run header's errors outside any test, as Playwright reported them beside the tests: a global setup that threw,
 * a spec file that did not load (`No tests found` too), a web server that did not start, a worker fixture whose
 * teardown threw, the failure budget that stopped the run. Each shows its message and stack as Playwright printed
 * them, and the place it was thrown; past the first two, a button shows the rest.
 *
 * The block can be folded to one line, the title and the first error's first line, so a long stack does not take the
 * height the tab below needs (the Video tab fits its video to what is left). The fold is kept per browser and starts
 * unfolded, so an error is never hidden from someone who has not chosen to hide it.
 */
const props = defineProps<{
  errors: WireRunError[];
  /** The project's id and name, for the place an error was thrown to open in the editor. */
  projectKey?: number | null;
  projectName?: string | null;
}>();

/** How many errors show before the rest are asked for. */
const SHOWN = 2;
const showAll = ref(false);
const shown = computed(() => (showAll.value ? props.errors : props.errors.slice(0, SHOWN)));

const collapsed = useLocalStorage(RUN_ERRORS_COLLAPSED_KEY, false, { initOnMounted: true });
const headline = computed(() => runErrorHeadline(props.errors));
const listId = useId();
const title = computed(() =>
  props.errors.length === 1 ? 'Error outside the tests' : `${props.errors.length} errors outside the tests`,
);

function errorText(error: WireRunError): string {
  return error.stack ? `${error.message}\n${error.stack}` : error.message;
}
</script>

<template>
  <section class="space-y-2" data-shot="run-errors" data-tour="run-errors">
    <div class="flex min-w-0 items-center gap-2">
      <p class="min-w-0 flex-1 text-sm inline-flex items-center gap-1">
        <span class="shrink-0 font-semibold text-highlighted"
          >{{ title }}<template v-if="collapsed && headline">:</template></span
        >
        <span
          v-if="collapsed && headline"
          class="min-w-0 truncate text-error"
          :title="headline"
          data-testid="run-errors-headline"
          >{{ headline }}</span
        >
        <HelpHint topic="run.errors" class="shrink-0" />
      </p>
      <UButton
        size="xs"
        color="neutral"
        variant="ghost"
        class="shrink-0"
        :trailing-icon="collapsed ? 'i-lucide-chevron-down' : 'i-lucide-chevron-up'"
        :label="collapsed ? 'Expand' : 'Collapse'"
        :aria-expanded="collapsed ? 'false' : 'true'"
        :aria-controls="listId"
        @click="collapsed = !collapsed"
      />
    </div>
    <div v-show="!collapsed" :id="listId" class="space-y-2">
      <ul class="space-y-2">
        <li v-for="(error, index) in shown" :key="index" class="space-y-1 min-w-0">
          <div class="max-h-48 overflow-y-auto rounded-md border border-default px-2.5 py-2">
            <ErrorText :text="errorText(error)" mode="block" />
          </div>
          <OpenInIdeLink
            v-if="error.location"
            :file-path="error.location.file"
            :line="error.location.line"
            :column="error.location.column"
            :project-key="projectKey"
            :project-name="projectName"
            class="text-xs"
          />
        </li>
      </ul>
      <UButton
        v-if="errors.length > SHOWN"
        size="xs"
        color="neutral"
        variant="ghost"
        :trailing-icon="showAll ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
        :label="showAll ? 'Show fewer' : `Show ${errors.length - SHOWN} more`"
        @click="showAll = !showAll"
      />
    </div>
  </section>
</template>
