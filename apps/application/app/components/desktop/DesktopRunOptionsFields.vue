<script setup lang="ts">
/**
 * Desktop shell only: the fields of a local run's options (how tests are
 * selected, the browser mode, repeat each and whether a repeat ends at its
 * first failure, a forced trace, Hold failures), on one options object. The run dialog edits one run's options with it, and a project's
 * Local folder section the project's defaults.
 */
import type { SavedLocalRunOptions } from '~/composables/useDesktopLocalRuns';

const options = defineModel<SavedLocalRunOptions>({ required: true });

function field<K extends keyof SavedLocalRunOptions>(key: K) {
  return computed({
    get: () => options.value[key],
    set: (value: SavedLocalRunOptions[K]) => (options.value = { ...options.value, [key]: value }),
  });
}

const mode = field('mode');
const runMode = field('runMode');
const trace = field('trace');
const repeatEach = field('repeatEach');
const stopAtFirstFailure = field('stopAtFirstFailure');
const holdFailures = field('holdFailures');

const repeats = computed(() => Math.floor(repeatEach.value ?? 1) > 1);
/** Why Hold failures does nothing with these options: a run nobody attends goes on past each failure. */
const holdRefused = computed(() =>
  runMode.value === 'ui'
    ? 'UI mode goes on past each failure.'
    : repeats.value && !stopAtFirstFailure.value
      ? 'A repeated run goes on past each failure, unless it stops at the first one.'
      : null,
);
</script>

<template>
  <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
    <UFormField label="Select tests by" name="mode">
      <USelect v-model="mode" :items="RETRY_MODE_ITEMS" class="w-full" />
    </UFormField>
    <UFormField label="Browser" name="runMode">
      <USelect v-model="runMode" :items="LOCAL_RUN_MODE_ITEMS" class="w-full" />
    </UFormField>
    <UFormField label="Repeat each" name="repeatEach" description="Run every test N times — flake reproduction.">
      <UInput v-model.number="repeatEach" type="number" min="1" max="1000" class="w-full" />
    </UFormField>
    <UFormField
      label="Stop at the first failing repetition"
      name="stopAtFirstFailure"
      description="End a repeated run at its first failure (--max-failures=1), so you can look at it."
    >
      <USwitch v-model="stopAtFirstFailure" :disabled="!repeats" />
    </UFormField>
    <UFormField label="Trace" name="trace" description="Force trace recording (--trace=on).">
      <USwitch v-model="trace" />
    </UFormField>
    <UFormField
      label="Hold failures"
      name="holdFailures"
      :description="holdRefused ?? 'Hold each failing test at its line from the run\'s start, until you answer it.'"
    >
      <USwitch v-model="holdFailures" :disabled="!!holdRefused" />
    </UFormField>
  </div>
</template>
