<script setup lang="ts">
import type { BadgeProps } from '@nuxt/ui';
import type { ProjectWithStats } from '~~/types/api';

/**
 * The status badge of a project in the sidebar. With a latest run it opens that run
 * instead of the project, and its tooltip summarizes the run and names the
 * project's status filter when it has one.
 *
 * It renders inside the project's link, so it is a span with a link role rather than
 * a nested <a>, and it stops the click before the project link sees it.
 */
const props = defineProps<{
  run: ProjectWithStats['latestRun'];
  /** The project's status filter in words; unset when every run sets the status. */
  statusFilter?: string;
  badge: BadgeProps;
  size?: BadgeProps['size'];
  badgeClass?: string;
}>();

const emit = defineEmits<{ navigate: [] }>();

// How long ago the run started moves between the server render and hydration,
// so the tooltip names it once the badge is mounted.
const mounted = ref(false);
onMounted(() => {
  mounted.value = true;
});

const title = computed(() => {
  const run = props.run;
  if (!run) return props.statusFilter ? `No run on ${props.statusFilter}` : undefined;
  const ago = mounted.value ? `, ${formatRelativeTime(run.startTime)}` : '';
  const lines = [`Open latest run #${run.id}: ${run.status}${ago}`];
  const counts = [`${run.passedTests} passed`];
  if (run.failedTests) counts.push(`${run.failedTests} failed`);
  if (run.flakyTests) counts.push(`${run.flakyTests} flaky`);
  if (run.skippedTests) counts.push(`${run.skippedTests} skipped`);
  if (run.didNotRunTests) counts.push(`${run.didNotRunTests} did not run`);
  lines.push(`${run.totalTests} tests: ${counts.join(', ')}`);
  if (run.duration != null) lines.push(`Duration: ${formatLongDuration(run.duration)}`);
  const scm = run.metadata?.scm;
  const revision = [scm?.branch, scm?.commit?.substring(0, 7)].filter(Boolean).join(' @ ');
  if (revision) lines.push(revision);
  if (props.statusFilter) lines.push(`Status filter: ${props.statusFilter}`);
  return lines.join('\n');
});

function openRun() {
  if (!props.run) return;
  emit('navigate');
  navigateTo(`/test-runs/${props.run.id}`);
}
</script>

<template>
  <span
    v-if="run"
    role="link"
    tabindex="0"
    data-shot="sidebar-latest-run"
    class="inline-flex rounded-md hover:ring-1 hover:ring-accented focus-visible:outline-2 focus-visible:outline-primary"
    :title="title"
    :aria-label="statusFilter ? `Open latest run #${run.id} on ${statusFilter}` : `Open latest run #${run.id}`"
    @click.prevent.stop="openRun"
    @keydown.enter.prevent.stop="openRun"
  >
    <UBadge color="neutral" variant="outline" :size="size" v-bind="badge" :class="badgeClass" />
  </span>
  <UBadge v-else color="neutral" variant="outline" :size="size" v-bind="badge" :class="badgeClass" :title="title" />
</template>
