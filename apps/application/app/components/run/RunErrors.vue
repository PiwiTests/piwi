<script setup lang="ts">
import type { WireRunError } from '#shared/types';

/**
 * The run header's errors outside any test, as Playwright reported them beside the tests: a global setup that threw,
 * a spec file that did not load (`No tests found` too), a web server that did not start, a worker fixture whose
 * teardown threw, the failure budget that stopped the run. Each shows its message and stack as Playwright printed
 * them, and the place it was thrown; past the first two, a button shows the rest.
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

function errorText(error: WireRunError): string {
  return error.stack ? `${error.message}\n${error.stack}` : error.message;
}
</script>

<template>
  <section class="space-y-2" data-shot="run-errors" data-tour="run-errors">
    <p class="text-sm font-semibold text-highlighted inline-flex items-center gap-1">
      {{ errors.length === 1 ? 'Error outside the tests' : `${errors.length} errors outside the tests` }}
      <HelpHint topic="run.errors" />
    </p>
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
  </section>
</template>
