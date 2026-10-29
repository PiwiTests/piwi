<script setup lang="ts">
/**
 * Desktop shell only: the fields of a local run's options (how tests are
 * selected, the browser mode, repeat each, a forced trace), on one options
 * object. The run dialog edits one run's options with it, and a project's
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
    <UFormField label="Trace" name="trace" description="Force trace recording (--trace=on).">
      <USwitch v-model="trace" />
    </UFormField>
  </div>
</template>
