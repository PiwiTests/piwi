<script setup lang="ts">
/**
 * Home's Flake Lab queue: flaky tests whose fix waits for a verify, then flaky
 * tests whose top suspect the lab has not tested, across the visible projects.
 * Each row opens the test's Flakiness tab and copies the command it needs.
 */
import type { FlakeLabInboxItem } from '#shared/handlers/flake-lab';

defineProps<{ items: FlakeLabInboxItem[] }>();

const { copy } = useCopy();

function stepLine(item: FlakeLabInboxItem): string {
  if (item.step === 'verify') return item.detail ? `Verify the fix under ${item.detail}` : 'Verify the fix';
  const more = item.untestedSuspects > 1 ? ` (+${item.untestedSuspects - 1} untested)` : '';
  return `Reproduce under ${item.detail ?? 'its top suspect'}${more}`;
}

function rate(item: FlakeLabInboxItem): string | null {
  return item.flakeRate == null ? null : `flaky ${Math.max(1, Math.round(item.flakeRate * 100))}%`;
}
</script>

<template>
  <SectionCard
    icon="i-lucide-flask-conical"
    title="Flaky tests waiting in the Flake Lab"
    help="home.flake-lab"
    data-tour="flake-lab-inbox"
  >
    <ul class="divide-y divide-default text-sm" data-testid="flake-lab-inbox">
      <li
        v-for="item in items"
        :key="item.testCaseId"
        class="flex flex-col gap-1 py-3 sm:flex-row sm:items-center sm:gap-3"
        data-testid="flake-lab-inbox-item"
      >
        <NuxtLink
          :to="{ path: `/test-cases/${item.testCaseId}`, query: { tab: 'flakiness' } }"
          class="min-w-0 flex-1 hover:underline"
        >
          <span class="block break-words text-highlighted sm:truncate">{{ item.title }}</span>
          <span class="block break-words text-xs text-muted sm:truncate">
            {{ stepLine(item) }} · {{ item.projectName }}<template v-if="rate(item)"> · {{ rate(item) }}</template>
          </span>
        </NuxtLink>
        <UButton
          size="xs"
          color="neutral"
          variant="outline"
          icon="i-lucide-clipboard"
          class="self-start sm:self-auto shrink-0"
          :title="item.command"
          data-tour="flake-lab-inbox-command"
          @click="copy(item.command, { toast: 'Lab command copied' })"
        >
          Copy command
        </UButton>
      </li>
    </ul>
  </SectionCard>
</template>
