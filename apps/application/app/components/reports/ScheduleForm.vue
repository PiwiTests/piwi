<script setup lang="ts">
/**
 * Create or edit a report schedule: which dashboard, when, compared with what,
 * to which channels. A new schedule takes its filters from the page it was
 * opened on (the analytics scope, or one project); the period comes from the
 * cadence. *Preview* shows the report as it would be sent now, before saving.
 * Opened from *Schedule…* on the analytics and project pages and from the
 * Reports page.
 */
import { offeredDashboards, type BuiltinDashboardKey } from '#shared/analytics/dashboards';
import { WEEKDAY_NAMES, type ReportCadence, type ScheduleComparison } from '#shared/reports/schedule';
import type { ReportScheduleView } from '#shared/handlers/reports';
import { REPORT_LANGUAGES, type ReportLanguage } from '#shared/reports/languages';
import { sentencesFor } from '#shared/reports/sentences';
import type { DashboardList } from '#shared/handlers/dashboards';
import { channelOwnerLabel, channelRecipient, type ChannelOwner } from '#shared/notifications/channel-recipients';
import type { ProjectMenuItem } from '~~/types/api';

const props = withDefaults(
  defineProps<{
    /** The scope query keys a new schedule starts from. */
    scope?: Record<string, string>;
    /** A built-in dashboard key or a saved dashboard's id. */
    dashboard?: BuiltinDashboardKey | string;
    /** The schedule being edited; a new one when absent. */
    schedule?: ReportScheduleView | null;
  }>(),
  { scope: () => ({}), dashboard: 'executive', schedule: null },
);

const emit = defineEmits<{ saved: [schedule: ReportScheduleView] }>();
const open = defineModel<boolean>('open', { default: false });

const config = useRuntimeConfig();
const demoMode = !!config.public.demoMode;
const isDesktop = useIsDesktop();
const { canSeeAdmin } = useAuth();
const authEnabled = !!config.public.authEnabled;
const { isHidden } = await useInstanceCapabilities();
const toast = useToast();

interface ChannelItem {
  id: number;
  name: string;
  type: string;
  userId: number | null;
  config?: Record<string, unknown>;
}

// Loaded when the form first opens: the pages render it closed for every reader.
const { data: channelData, execute: loadChannels } = useFetch<{ items: ChannelItem[] }>('/api/channels', {
  server: false,
  lazy: true,
  immediate: false,
  default: () => ({ items: [] }),
});
const { data: scheduleData, execute: loadScheduleOptions } = useFetch<{
  timeZone: string;
  owners: Array<{ owner: string; projectIds: number[] }>;
}>('/api/reports/schedules', {
  server: false,
  lazy: true,
  immediate: false,
  default: () => ({ timeZone: 'UTC', owners: [] }),
});
const { data: dashboardList, execute: loadDashboards } = useFetch<DashboardList>('/api/dashboards', {
  server: false,
  lazy: true,
  immediate: false,
});
const { data: projectMenu, execute: loadProjects } = useFetch('/api/projects/menu', {
  server: false,
  lazy: true,
  immediate: false,
  default: () => [] as ProjectMenuItem[],
  transform: (r: { items: ProjectMenuItem[] }) => r.items,
});
// Share links need the server; the demo has none, so the switch stays hidden there.
const { data: shareSettings, execute: loadShareSettings } = useFetch<{ enabled: boolean; maxTtlDays: number }>(
  '/api/share-links/settings',
  { server: false, lazy: true, immediate: false },
);
let loaded = false;

const name = ref('');
const dashboardKey = ref<string | undefined>('executive');
const cadence = ref<ReportCadence>('weekly');
const weekday = ref(1);
const dayOfMonth = ref(1);
const at = ref('08:00');
const comparison = ref<ScheduleComparison>('previous');
const language = ref<'auto' | ReportLanguage>('auto');
const channelIds = ref<number[]>([]);
const includeShareLink = ref(false);
const includeNarrative = ref(false);
const global = ref(false);
const owner = ref<string | undefined>(undefined);
const filters = ref<Record<string, string>>({});
const saving = ref(false);
const previewing = ref(false);

function reset() {
  const s = props.schedule;
  filters.value = { ...(s ? s.scope : props.scope) };
  delete filters.value.period;
  delete filters.value.tz;
  delete filters.value.locale;
  owner.value = filters.value.owner;
  dashboardKey.value = s
    ? (s.dashboard ?? undefined)
    : props.dashboard === 'team' && !owner.value
      ? 'engineering'
      : props.dashboard;
  name.value = s?.name ?? '';
  cadence.value = s?.cadence ?? 'weekly';
  weekday.value = s && s.cadence !== 'monthly' && s.anchor ? s.anchor : 1;
  dayOfMonth.value = s && s.cadence === 'monthly' && s.anchor ? s.anchor : 1;
  at.value = s?.at ?? '08:00';
  comparison.value = s?.comparison ?? 'previous';
  language.value = s?.language ?? 'auto';
  channelIds.value = s ? s.channels.map((c) => c.id) : [];
  includeShareLink.value = s?.includeShareLink ?? false;
  includeNarrative.value = s?.includeNarrative ?? false;
  global.value = s ? s.global : false;
  previewing.value = false;
}
watch(
  open,
  (isOpen) => {
    if (!isOpen) return;
    reset();
    if (!loaded) {
      loaded = true;
      void loadChannels();
      void loadScheduleOptions();
      void loadDashboards();
      if (!demoMode) void loadShareSettings();
      void loadProjects();
    }
  },
  { immediate: true },
);

const scopeProjects = computed(() =>
  (filters.value.projects ?? '')
    .split(',')
    .map(Number)
    .filter((id) => id > 0),
);

/** The owners of the tests in the schedule's projects, for the team dashboard. */
const owners = computed(() => {
  const all = scheduleData.value?.owners ?? [];
  const projects = scopeProjects.value;
  return all
    .filter((o) => projects.length === 0 || o.projectIds.some((id) => projects.includes(id)))
    .map((o) => o.owner);
});

/** The built-in report dashboards, then the saved dashboards the reader can open (a global schedule needs a shared one). */
const dashboardItems = computed(() => {
  const builtins = offeredDashboards({ hasOwner: owners.value.length > 0, testMapHidden: isHidden('test-map') }).map(
    (d) => ({ label: d.name, value: d.key as string, description: d.description }),
  );
  const saved = (dashboardList.value?.items ?? [])
    .filter((d) => d.kind === 'saved' && (!global.value || d.visibility === 'shared' || !authEnabled))
    .map((d) => ({ label: d.name, value: d.id, description: d.description ?? undefined }));
  return saved.length > 0
    ? [
        { type: 'label' as const, label: 'Built-in' },
        ...builtins,
        { type: 'label' as const, label: 'Saved dashboards' },
        ...saved,
      ]
    : builtins;
});

const cadenceItems = [
  { label: 'Daily', value: 'daily' },
  { label: 'Weekly', value: 'weekly' },
  { label: 'Every other week', value: 'biweekly' },
  { label: 'Monthly', value: 'monthly' },
];
const weekdayItems = WEEKDAY_NAMES.map((label, i) => ({ label, value: i + 1 }));
const dayItems = Array.from({ length: 28 }, (_, i) => ({ label: String(i + 1), value: i + 1 }));
const comparisonItems = [
  { label: 'The previous period', value: 'previous' },
  { label: 'The same period a year earlier', value: 'year-ago' },
  { label: 'No comparison', value: 'none' },
];
// Each report language under its own name.
const languageItems = [
  { label: 'Default language', value: 'auto' },
  ...REPORT_LANGUAGES.map((code) => ({ label: sentencesFor(code).name, value: code })),
];

/** A channel the schedule can send to, with who receives what it sends and whose it is. */
interface ChannelOption {
  id: number;
  name: string;
  type: string;
  owner: ChannelOwner;
  recipient: string;
}

/**
 * The reader's own channels and the global ones (what the channels list holds),
 * then any other channel the edited schedule already sends to: an administrator
 * editing someone's schedule sees that person's channels as the server names them.
 */
const channelOptions = computed<ChannelOption[]>(() => {
  const listed = (channelData.value?.items ?? []).map((c) => {
    const owner: ChannelOwner = c.userId === null ? { kind: 'global' } : { kind: 'viewer' };
    const text = (value: unknown) => (typeof value === 'string' ? value : null);
    const recipient = channelRecipient(
      { type: c.type, address: text(c.config?.address), url: text(c.config?.url) },
      owner,
    );
    return { id: c.id, name: c.name, type: c.type, owner, recipient };
  });
  const known = new Set(listed.map((c) => c.id));
  const others = (props.schedule?.channels ?? []).flatMap((c) =>
    !known.has(c.id) && c.owner ? [{ ...c, owner: c.owner }] : [],
  );
  return [...listed, ...others];
});

/** Global schedules send to global channels; a personal one to the author's own or a global channel. */
const allowedChannels = computed(() => channelOptions.value.filter((c) => !global.value || c.owner.kind === 'global'));

const OWNER_ORDER: ChannelOwner['kind'][] = ['viewer', 'global', 'user'];

/**
 * The picker's items, each described by who receives it and whose channel it
 * is, grouped by owner: the reader's own, the global ones, anyone else's. One
 * group with authentication off, where every channel is global.
 */
const channelItems = computed(() => {
  const toItem = (c: ChannelOption) => ({
    label: c.name,
    value: c.id,
    description: authEnabled ? `${c.recipient} · ${channelOwnerLabel(c.owner)}` : c.recipient,
  });
  return OWNER_ORDER.map((kind) => allowedChannels.value.filter((c) => c.owner.kind === kind).map(toItem)).filter(
    (group) => group.length > 0,
  );
});

watch(global, () => {
  const allowed = new Set(allowedChannels.value.map((c) => c.id));
  channelIds.value = channelIds.value.filter((id) => allowed.has(id));
});

/** The picked channels, in the order picked: who each one reaches. */
const pickedChannels = computed(() => {
  const byId = new Map(channelOptions.value.map((c) => [c.id, c]));
  return channelIds.value.flatMap((id) => {
    const c = byId.get(id);
    return c ? [c] : [];
  });
});

/** Whose schedule it is, when the reader edits someone else's. */
const ownerLine = computed(() => {
  const s = props.schedule;
  if (!s || s.global || s.mine || !authEnabled) return null;
  return `${s.ownerName ?? 'Another user'}'s schedule. It stays theirs when you save it.`;
});

const projectNames = computed(() => new Map((projectMenu.value ?? []).map((p) => [p.id, p.label || p.name])));

/** The schedule's filters in words: they come from the page it was opened on. */
const filterSummary = computed(() => {
  const f = filters.value;
  const parts: string[] = [];
  parts.push(
    scopeProjects.value.length === 0
      ? 'All projects you can open'
      : scopeProjects.value.map((id) => projectNames.value.get(id) ?? `#${id}`).join(', '),
  );
  if (f.environments) parts.push(`environments ${f.environments}`);
  if (f.branches) parts.push(`branches ${f.branches}`);
  else parts.push(f.allBranches === 'true' ? 'all branches' : 'default branches');
  if (f.sel) parts.push(`selection ${f.sel}`);
  if (f.tags) parts.push(`tags ${f.tags}`);
  if (f.browsers) parts.push(`browsers ${f.browsers}`);
  if (f.fullRunsOnly === 'false') parts.push('full and partial runs');
  return parts.join(' · ');
});

const timeZoneNote = computed(() => {
  const tz = scheduleData.value?.timeZone ?? 'UTC';
  return tz === 'UTC'
    ? 'Times are in UTC: the instance time zone is left to each browser, and a schedule has no browser.'
    : `Times are in the instance time zone, ${tz}.`;
});

const needsOwner = computed(() => dashboardKey.value === 'team');
/** A preview needs what the report needs: a dashboard, and the team dashboard its owner. */
const canPreview = computed(() => !!dashboardKey.value && (!needsOwner.value || !!owner.value));
const valid = computed(() => name.value.trim().length > 0 && canPreview.value && channelIds.value.length > 0);

/** The schedule as the form holds it, without its channels: the preview's request and the body saved. */
function scheduleValues() {
  const scope = { ...filters.value };
  if (needsOwner.value && owner.value) scope.owner = owner.value;
  else delete scope.owner;
  return {
    name: name.value.trim(),
    dashboard: dashboardKey.value,
    scope,
    cadence: cadence.value,
    anchor: cadence.value === 'daily' ? null : cadence.value === 'monthly' ? dayOfMonth.value : weekday.value,
    at: at.value,
    comparison: comparison.value,
    language: language.value === 'auto' ? null : language.value,
    ...(authEnabled && canSeeAdmin.value ? { global: global.value } : {}),
  };
}

// Taken when *Preview* is pressed: the form is hidden while it shows, so nothing changes under it.
const previewRequest = ref<Record<string, unknown>>({});
const selectedChannels = computed(() => pickedChannels.value.map((c) => ({ name: c.name, type: c.type })));
const comparisonText = computed(() => {
  if (comparison.value === 'none') return null;
  const label = comparisonItems.find((c) => c.value === comparison.value)?.label ?? '';
  return label.charAt(0).toLowerCase() + label.slice(1);
});

function openPreview() {
  if (!canPreview.value) return;
  previewRequest.value = { ...scheduleValues(), ...(props.schedule ? { createdAt: props.schedule.createdAt } : {}) };
  previewing.value = true;
}

async function save() {
  if (!valid.value) return;
  saving.value = true;
  const body = {
    ...scheduleValues(),
    channelIds: channelIds.value,
    includeShareLink: includeShareLink.value,
    includeNarrative: includeNarrative.value,
  };
  try {
    const saved = props.schedule
      ? await $fetch<ReportScheduleView>(`/api/reports/schedules/${props.schedule.id}`, { method: 'PATCH', body })
      : await $fetch<ReportScheduleView>('/api/reports/schedules', { method: 'POST', body });
    toast.add({ title: props.schedule ? 'Report schedule saved' : 'Report schedule created', color: 'success' });
    emit('saved', saved);
    open.value = false;
  } catch (error) {
    toast.add({ title: "Couldn't save the report schedule", description: errorMessage(error), color: 'error' });
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <ClientOnly>
    <UModal
      v-model:open="open"
      :title="schedule ? 'Edit report schedule' : 'Schedule a quality report'"
      :description="
        previewing
          ? 'What its recipients would get if it were sent now.'
          : 'A quality report delivered on a schedule, each one kept as a snapshot on the Reports page.'
      "
      :ui="{ content: previewing ? 'sm:max-w-4xl' : 'sm:max-w-xl' }"
    >
      <template #body>
        <SchedulePreview
          v-if="previewing"
          :request="previewRequest"
          :channels="selectedChannels"
          :comparison="comparisonText"
          :include-share-link="includeShareLink && !!shareSettings?.enabled"
          :include-narrative="includeNarrative"
        />
        <form v-else class="space-y-4" data-testid="schedule-form" data-tour="schedule-form" @submit.prevent="save">
          <UAlert
            v-if="demoMode"
            icon="i-lucide-info"
            color="neutral"
            variant="subtle"
            title="The demo has no scheduler"
            description="A schedule is stored in your browser but never fires by itself. Run now keeps a snapshot without sending it."
          />
          <UAlert
            v-else-if="isDesktop"
            icon="i-lucide-info"
            color="neutral"
            variant="subtle"
            description="A schedule fires while the desktop app is running."
          />

          <p v-if="ownerLine" class="text-xs text-muted" data-testid="schedule-owner-line">{{ ownerLine }}</p>

          <UFormField label="Name" required>
            <UInput v-model="name" class="w-full" placeholder="Weekly quality report" data-testid="schedule-name" />
          </UFormField>

          <UFormField label="Dashboard">
            <UAlert
              v-if="schedule?.inactiveReason"
              icon="i-lucide-info"
              color="neutral"
              variant="subtle"
              class="mb-2"
              :description="schedule.inactiveReason"
            />
            <div class="flex items-center gap-2">
              <USelect
                v-model="dashboardKey"
                :items="dashboardItems"
                class="w-full"
                placeholder="Pick a dashboard"
                aria-label="Report dashboard"
                data-testid="schedule-dashboard"
              />
              <HelpHint topic="reports.schedule" />
            </div>
            <p v-if="owners.length === 0" class="text-xs text-muted mt-1">
              The team dashboard needs tests with an owner (a <code class="font-mono">piwi:owner</code> annotation or
              CODEOWNERS); none of the tests in scope has one.
            </p>
          </UFormField>

          <UFormField v-if="needsOwner" label="Owner" required>
            <USelect
              v-model="owner"
              :items="owners"
              class="w-full"
              placeholder="Pick a team"
              aria-label="Owner"
              data-testid="schedule-owner"
            />
          </UFormField>

          <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <UFormField label="Cadence">
              <USelect v-model="cadence" :items="cadenceItems" class="w-full" data-testid="schedule-cadence" />
            </UFormField>
            <UFormField v-if="cadence === 'weekly' || cadence === 'biweekly'" label="On">
              <USelect v-model="weekday" :items="weekdayItems" class="w-full" aria-label="Weekday" />
            </UFormField>
            <UFormField v-else-if="cadence === 'monthly'" label="Day of month">
              <USelect v-model="dayOfMonth" :items="dayItems" class="w-full" aria-label="Day of month" />
            </UFormField>
            <UFormField label="At">
              <UInput v-model="at" type="time" class="w-full" data-testid="schedule-at" />
            </UFormField>
          </div>
          <p class="text-xs text-muted -mt-2">
            {{ timeZoneNote }} Each report covers the whole days since the previous one.
          </p>

          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <UFormField label="Compared with">
              <USelect v-model="comparison" :items="comparisonItems" class="w-full" />
            </UFormField>
            <UFormField label="Language">
              <USelect v-model="language" :items="languageItems" class="w-full" />
            </UFormField>
          </div>

          <UFormField v-if="authEnabled && canSeeAdmin" label="Global schedule">
            <div class="flex items-center gap-2">
              <USwitch v-model="global" />
              <span class="text-xs text-muted">Every project, sent to global channels only.</span>
            </div>
          </UFormField>

          <UFormField label="Send to" required>
            <USelectMenu
              v-model="channelIds"
              :items="channelItems"
              value-key="value"
              multiple
              class="w-full"
              placeholder="Pick channels"
              :ui="{ itemDescription: 'whitespace-normal' }"
              aria-label="Channels"
              data-testid="schedule-channels"
            />
            <ChannelRecipientList
              v-if="pickedChannels.length > 0"
              :channels="pickedChannels"
              :show-owner="authEnabled"
              class="mt-2"
              data-testid="schedule-recipients"
            />
            <p v-if="channelItems.length === 0" class="text-xs text-muted mt-1">
              No channel yet: add one under
              <NuxtLink
                to="/settings/notifications"
                class="underline decoration-dotted underline-offset-2 hover:decoration-solid"
              >
                Settings › Notifications</NuxtLink
              >.
            </p>
          </UFormField>

          <UFormField v-if="shareSettings?.enabled">
            <template #label>
              <span class="inline-flex items-center gap-1">Share link <HelpHint topic="reports.share-link" /></span>
            </template>
            <div class="flex items-center gap-2">
              <USwitch v-model="includeShareLink" data-testid="schedule-share-link" />
              <span class="text-xs text-muted">Each report carries a link that opens it without an account.</span>
            </div>
          </UFormField>

          <UFormField data-tour="schedule-narrative">
            <template #label>
              <span class="inline-flex items-center gap-1">AI narrative <HelpHint topic="reports.narrative" /></span>
            </template>
            <div class="flex items-center gap-2">
              <USwitch v-model="includeNarrative" data-testid="schedule-narrative" />
              <span class="text-xs text-muted">{{
                demoMode
                  ? 'The demo has no AI model, so its reports keep the rule-based verdict.'
                  : 'Three paragraphs by the configured AI model, labeled as generated.'
              }}</span>
            </div>
          </UFormField>

          <div>
            <p class="text-xs font-medium text-muted">Filters</p>
            <p class="text-sm text-highlighted leading-relaxed" data-testid="schedule-filters">{{ filterSummary }}</p>
          </div>
        </form>
      </template>

      <template #footer>
        <div class="flex w-full items-center justify-end gap-2">
          <UButton
            v-if="previewing"
            color="neutral"
            variant="outline"
            icon="i-lucide-arrow-left"
            label="Back"
            title="Back to the schedule's settings"
            class="mr-auto"
            data-testid="schedule-preview-back"
            @click="previewing = false"
          />
          <UButton
            v-else
            color="neutral"
            variant="outline"
            icon="i-lucide-eye"
            label="Preview"
            class="mr-auto"
            :disabled="!canPreview"
            title="The report as it would be sent now, before saving"
            data-testid="schedule-preview-open"
            @click="openPreview"
          />
          <UButton color="neutral" variant="ghost" label="Cancel" @click="open = false" />
          <UButton
            color="primary"
            :loading="saving"
            :disabled="!valid"
            data-testid="schedule-save"
            :label="schedule ? 'Save' : 'Create schedule'"
            @click="save"
          />
        </div>
      </template>
    </UModal>
  </ClientOnly>
</template>
