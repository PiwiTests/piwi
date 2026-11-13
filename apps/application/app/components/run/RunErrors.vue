<script setup lang="ts">
import type { WireRunError } from '#shared/types';

/**
 * The run header's errors outside any test, as Playwright reported them beside the tests: a global setup that threw,
 * a spec file that did not load (`No tests found` too), a web server that did not start, a worker fixture whose
 * teardown threw, the failure budget that stopped the run. Each shows its message and stack as Playwright printed
 * them, and the place it was thrown; past the first two, a button shows the rest. Collapsed, the block is one line,
 * the first error's message cut to fit with its whole text on hover, and Expand brings the rest back; this browser
 * keeps the choice for every run.
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

/** Whether the block is folded to one line, kept per browser (`useLocalStorage` reads and writes it safely). */
const collapsed = useLocalStorage('piwi-run-errors-collapsed', false, { initOnMounted: true });
const listId = useId();

function errorText(error: WireRunError): string {
  return error.stack ? `${error.message}\n${error.stack}` : error.message;
}
</script>

<template>
  <section class="space-y-2" data-shot="run-errors" data-tour="run-errors">
    <div class="flex min-w-0 items-center gap-2">
      <p class="inline-flex shrink-0 items-center gap-1 text-sm font-semibold text-highlighted">
        {{ errors.length === 1 ? 'Error outside the tests' : `${errors.length} errors outside the tests` }}
        <HelpHint topic="run.errors" />
      </p>
      <ErrorText v-if="collapsed && errors[0]" :text="errors[0].message" class="flex-1" data-run-errors-line />
      <UButton
        size="xs"
        color="neutral"
        variant="ghost"
        class="ml-auto shrink-0"
        :trailing-icon="collapsed ? 'i-lucide-chevron-down' : 'i-lucide-chevron-up'"
        :label="collapsed ? 'Expand' : 'Collapse'"
        :aria-expanded="!collapsed"
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
