<script setup lang="ts">
/**
 * A bug report's step, or what it expects, in words, its parts set apart as
 * core writes them (`describeStepInParts`) so a reader finds them at a glance:
 * a name of the page or a value in its quotation marks in the strongest text
 * color, a key as a key cap, and the code (an address, a test id, a locator,
 * highlighted) in a chip.
 */
import type { StepPart } from '@piwitests/core/bug-report';

defineProps<{ parts: StepPart[] }>();
</script>

<template>
  <span
    ><template v-for="(part, i) in parts" :key="i"
      ><LocatorCode v-if="part.kind === 'locator'" :locator="part.text" chip /><code
        v-else-if="part.kind === 'url' || part.kind === 'code'"
        class="text-[0.92em] break-words"
        :class="CODE_CHIP_CLASS"
        >{{ part.text }}</code
      ><UKbd v-else-if="part.kind === 'key'" :value="part.text" size="sm" /><span
        v-else-if="part.kind === 'name' || part.kind === 'value'"
        class="font-semibold text-highlighted"
        >{{ part.text }}</span
      ><span v-else-if="part.kind === 'words'" class="italic">{{ part.text }}</span
      ><template v-else>{{ part.text }}</template></template
    ></span
  >
</template>
