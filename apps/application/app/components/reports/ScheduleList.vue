<script setup lang="ts">
/**
 * The report schedules on the Quality reports page: when each fires, whose it is, who
 * receives it through which channel, and its actions (run now, edit, mute,
 * pause, delete). A card list, so it reads the same at 375 px as on a wide screen.
 */
import { describeCadence } from '#shared/reports/schedule';
import type { ReportScheduleView } from '#shared/handlers/reports';

const props = defineProps<{ schedules: ReportScheduleView[] }>();
const emit = defineEmits<{ changed: []; edit: [schedule: ReportScheduleView] }>();

const toast = useToast();
const busy = ref<number | null>(null);
const config = useRuntimeConfig();
const demoMode = !!config.public.demoMode;
const authEnabled = !!config.public.authEnabled;

function isMuted(s: ReportScheduleView): boolean {
  return !!s.mutedUntil && new Date(s.mutedUntil).getTime() > Date.now();
}

/** Whose schedule it is, when not the reader's: global, or its owner's name. */
function ownerLabel(s: ReportScheduleView): string | null {
  if (s.global) return 'global';
  if (s.mine || !authEnabled) return null;
  return `by ${s.ownerName ?? 'another user'}`;
}

function stateLabel(s: ReportScheduleView): string | null {
  if (s.inactiveReason) return 'Inactive';
  if (!s.active) return 'Paused';
  if (isMuted(s)) return 'Muted';
  return null;
}

async function act(s: ReportScheduleView, fn: () => Promise<unknown>, done: string) {
  busy.value = s.id;
  try {
    await fn();
    toast.add({ title: done, color: 'success' });
    emit('changed');
  } catch (error) {
    toast.add({ title: 'The action failed', description: errorMessage(error), color: 'error' });
  } finally {
    busy.value = null;
  }
}

async function runNow(s: ReportScheduleView) {
  busy.value = s.id;
  try {
    const result = await $fetch<{ snapshotId: number; queued: number; muted: boolean }>(
      `/api/reports/schedules/${s.id}/run`,
      { method: 'POST' },
    );
    const sent = demoMode
      ? 'Kept as a snapshot; the demo sends nothing.'
      : result.muted
        ? 'Kept as a snapshot; the schedule is muted, so nothing was sent.'
        : `Queued for ${result.queued} ${result.queued === 1 ? 'channel' : 'channels'}.`;
    toast.add({ title: 'Quality report generated', description: sent, color: 'success' });
    emit('changed');
  } catch (error) {
    toast.add({ title: "Couldn't run the schedule", description: errorMessage(error), color: 'error' });
  } finally {
    busy.value = null;
  }
}

function patch(s: ReportScheduleView, body: Record<string, unknown>, done: string) {
  return act(s, () => $fetch(`/api/reports/schedules/${s.id}`, { method: 'PATCH', body }), done);
}

function remove(s: ReportScheduleView) {
  if (!window.confirm(`Delete the schedule “${s.name}”? Its snapshots stay on the Quality reports page.`)) return;
  return act(s, () => $fetch(`/api/reports/schedules/${s.id}`, { method: 'DELETE' }), 'Report schedule deleted');
}

function menu(s: ReportScheduleView) {
  const week = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
  return [
    [
      { label: 'Edit', icon: 'i-lucide-pencil', onSelect: () => emit('edit', s) },
      isMuted(s)
        ? { label: 'Unmute', icon: 'i-lucide-bell', onSelect: () => patch(s, { mutedUntil: null }, 'Unmuted') }
        : {
            label: 'Mute for a week',
            icon: 'i-lucide-bell-off',
            onSelect: () => patch(s, { mutedUntil: week }, 'Muted for a week'),
          },
      s.inactiveReason
        ? null
        : s.active
          ? { label: 'Pause', icon: 'i-lucide-pause', onSelect: () => patch(s, { active: false }, 'Paused') }
          : { label: 'Resume', icon: 'i-lucide-play', onSelect: () => patch(s, { active: true }, 'Resumed') },
    ].filter((item) => item !== null),
    [{ label: 'Delete', icon: 'i-lucide-trash-2', color: 'error' as const, onSelect: () => remove(s) }],
  ];
}

const sorted = computed(() => [...props.schedules].sort((a, b) => a.name.localeCompare(b.name)));
</script>

<template>
  <ul class="divide-y divide-default" data-testid="schedule-list">
    <li
      v-for="s in sorted"
      :key="s.id"
      class="py-3 flex flex-col gap-2 sm:flex-row sm:items-start"
      :data-testid="`schedule-${s.id}`"
    >
      <div class="min-w-0 flex-1 space-y-0.5">
        <p class="text-sm font-medium text-highlighted break-words">
          {{ s.name }}
          <span v-if="stateLabel(s)" class="text-xs font-normal text-muted"> · {{ stateLabel(s) }}</span>
        </p>
        <p class="text-xs text-muted">
          {{ s.dashboardName }} · {{ describeCadence(s)
          }}<template v-if="ownerLabel(s)"> · {{ ownerLabel(s) }}</template>
        </p>
        <p v-if="s.inactiveReason" class="text-xs text-muted" data-testid="schedule-inactive-reason">
          {{ s.inactiveReason }}
        </p>
        <ChannelRecipientList
          v-if="s.channels.length > 0"
          :channels="s.channels"
          :show-owner="authEnabled"
          :data-testid="`schedule-recipients-${s.id}`"
        />
        <p v-else class="text-xs text-muted">To no channel</p>
        <p v-if="s.active && s.nextRunAt" class="text-xs text-muted">
          Next: <ClientDate :date="s.nextRunAt" />
          <ClientOnly v-if="s.lastRunAt"> · last {{ formatRelativeTime(s.lastRunAt) }}</ClientOnly>
        </p>
      </div>
      <div v-if="s.canEdit" class="flex items-center gap-1 shrink-0">
        <UButton
          v-if="s.inactiveReason"
          size="sm"
          color="neutral"
          variant="outline"
          icon="i-lucide-layout-dashboard"
          :data-testid="`schedule-repoint-${s.id}`"
          @click="emit('edit', s)"
        >
          Pick a dashboard
        </UButton>
        <UButton
          v-else
          size="sm"
          color="neutral"
          variant="outline"
          icon="i-lucide-play"
          :loading="busy === s.id"
          :data-testid="`schedule-run-${s.id}`"
          title="Generate this quality report now, over the last complete period, and send it"
          @click="runNow(s)"
        >
          Run now
        </UButton>
        <UDropdownMenu :items="menu(s)" :content="{ align: 'end' }">
          <UButton size="sm" color="neutral" variant="ghost" icon="i-lucide-ellipsis" aria-label="Schedule actions" />
        </UDropdownMenu>
      </div>
    </li>
  </ul>
</template>
