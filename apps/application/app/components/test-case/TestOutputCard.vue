<script setup lang="ts">
/**
 * What the test wrote to stdout and stderr while it ran, as the reporter kept it: each stream as Playwright gave it,
 * its colors rendered, and past the reporter's budget its first and last lines, with the line between them saying
 * how much was cut. Each stream can be copied as plain text.
 */
import { stripAnsi } from '~/utils/text-format';

const props = defineProps<{
  stdout?: string | null;
  stderr?: string | null;
}>();

const streams = computed(() =>
  [
    { name: 'stdout', text: props.stdout ?? null },
    { name: 'stderr', text: props.stderr ?? null },
  ].filter((stream): stream is { name: string; text: string } => !!stream.text),
);

const { copy } = useCopy();
</script>

<template>
  <div class="space-y-4" data-shot="evidence-output">
    <SectionCard
      v-for="(stream, index) in streams"
      :key="stream.name"
      embedded
      :title="stream.name"
      :help="index === 0 ? 'case.output' : undefined"
    >
      <template #actions>
        <UButton
          size="xs"
          color="neutral"
          variant="ghost"
          icon="i-lucide-copy"
          :label="`Copy ${stream.name}`"
          @click="copy(stripAnsi(stream.text), { toast: `${stream.name} copied` })"
        />
      </template>
      <div class="max-h-96 overflow-y-auto rounded-md border border-default px-3 py-2">
        <ErrorText :text="stream.text" mode="block" />
      </div>
    </SectionCard>
  </div>
</template>
