<script setup lang="ts">
import { describeCluster } from '#shared/describe-cluster';
import {
  INBOX_QUEUES,
  clusterInQueue,
  countQueues,
  isSnoozedBack,
  effectiveAssignee,
  groupIncidentClusters,
  type InboxQueue,
  type SnoozeOption,
  type UserIdentity,
} from '#shared/inbox-queues';
import type { OpenFailureCluster } from '~~/types/api';

const props = defineProps<{
  clusters: OpenFailureCluster[];
}>();

const emit = defineEmits<{ changed: [] }>();

const toast = useToast();
const route = useRoute();
const router = useRouter();
const { authState, can } = useAuth();
const { hasTracker } = useTrackerStatus();

// ── What the viewer may do on each cluster's project ─────────────────────────
// Each action shows to the holders of the permission its route declares there.
const canTriage = (c: OpenFailureCluster) => can('triage:write', c.projectId);
const canQuarantine = (c: OpenFailureCluster) => can('quarantine:write', c.projectId);
const canLink = (c: OpenFailureCluster) => can('link:write', c.projectId);
const canFileIssue = (c: OpenFailureCluster) => can('issue:create', c.projectId);
/** A row is selectable when some bulk action applies to it. */
const canSelect = (c: OpenFailureCluster) => canTriage(c) || canQuarantine(c) || canFileIssue(c);
const canActOn = (c: OpenFailureCluster) => canSelect(c) || canLink(c);

const PREVIEW_LIMIT = 10;

// ── Queue selection (deep-linkable via ?queue=) ──────────────────────────────

const queue = computed<InboxQueue>({
  get() {
    const q = route.query.queue;
    const value = Array.isArray(q) ? q[0] : q;
    return (INBOX_QUEUES as readonly string[]).includes(value ?? '') ? (value as InboxQueue) : 'all';
  },
  set(value) {
    const query = { ...route.query };
    if (value === 'all') delete query.queue;
    else query.queue = value;
    router.replace({ query });
    selectedIndex.value = -1;
  },
});

const QUEUE_META: Record<InboxQueue, { label: string; icon: string }> = {
  all: { label: 'All open', icon: 'i-lucide-inbox' },
  new: { label: 'New', icon: 'i-lucide-sparkles' },
  mine: { label: 'Mine', icon: 'i-lucide-user' },
  'needs-ticket': { label: 'Needs ticket', icon: 'i-lucide-ticket' },
  regressions: { label: 'Regressions', icon: 'i-lucide-trending-down' },
  'fix-didnt-hold': { label: "Fix didn't hold", icon: 'i-lucide-rotate-ccw' },
  'quarantine-ready': { label: 'Quarantine ready', icon: 'i-lucide-shield-check' },
  'merge-suggestions': { label: 'Merge suggestions', icon: 'i-lucide-git-merge' },
};

// ── Per-viewer "new since you last looked" cut (localStorage, no schema) ──────
// The first Home visit of a browser session reads the previous session's visit
// as the cut and stamps now; every later visit in the session keeps that cut
// (sessionStorage), so going back to Home does not empty the New queue.
const LAST_VISIT_KEY = 'piwi-inbox-last-visit';
const SESSION_CUT_KEY = 'piwi-inbox-session-cut';
const lastVisitMs = ref<number | null>(null);
onMounted(() => {
  try {
    const sessionCut = sessionStorage.getItem(SESSION_CUT_KEY);
    if (sessionCut !== null) {
      lastVisitMs.value = Number(sessionCut) || null;
      return;
    }
    const stored = localStorage.getItem(LAST_VISIT_KEY);
    lastVisitMs.value = stored ? Number(stored) || null : null;
    sessionStorage.setItem(SESSION_CUT_KEY, stored ?? '');
    localStorage.setItem(LAST_VISIT_KEY, String(Date.now()));
  } catch {
    lastVisitMs.value = null;
  }
});

const user = computed<UserIdentity | null>(() => {
  const u = authState.value.user;
  return u ? { name: u.name ?? null, username: u.username ?? null } : null;
});

const queueCtx = computed(() => ({ user: user.value, lastVisitMs: lastVisitMs.value }));

// ── Optimistic state ─────────────────────────────────────────────────────────
// Rows removed by a triage action (resolve / ignore / snooze) drop out at once;
// assignee edits show through a local override until the parent refetch lands.
const removedIds = ref(new Set<number>());
const assigneeOverride = ref(new Map<number, string | null>());

watch(
  () => props.clusters.map((c) => c.id).join(','),
  () => {
    const present = new Set(props.clusters.map((c) => c.id));
    for (const id of removedIds.value) if (!present.has(id)) removedIds.value.delete(id);
    for (const id of assigneeOverride.value.keys()) if (!present.has(id)) assigneeOverride.value.delete(id);
  },
);

function withOverrides(cluster: OpenFailureCluster): OpenFailureCluster {
  if (!assigneeOverride.value.has(cluster.id)) return cluster;
  return { ...cluster, assignee: assigneeOverride.value.get(cluster.id) ?? null };
}

// Clusters an environment-incident run opened collapse into one row per run,
// listed above the clusters on the All open queue.
const grouped = computed(() =>
  groupIncidentClusters(props.clusters.filter((c) => !removedIds.value.has(c.id)).map(withOverrides)),
);
const liveClusters = computed(() => grouped.value.clusters);
const incidentRows = computed(() => (queue.value === 'all' ? grouped.value.incidents : []));

const counts = computed(() => countQueues(liveClusters.value, queueCtx.value));

const rows = computed(() => liveClusters.value.filter((c) => clusterInQueue(c, queue.value, queueCtx.value)));

const expanded = useViewState('open-failures-expanded', () => false);
const visibleRows = computed(() => (expanded.value ? rows.value : rows.value.slice(0, PREVIEW_LIMIT)));
const hasMore = computed(() => rows.value.length > PREVIEW_LIMIT);

// The keyboard hints name only the shortcuts the viewer can use on some row.
const hints = computed(() => {
  const list = rows.value;
  return {
    any: list.some(canActOn),
    select: list.some(canSelect),
    triage: list.some(canTriage),
    quarantine: list.some(canQuarantine),
    link: list.some(canLink),
    issue: hasTracker.value && list.some(canFileIssue),
  };
});

watch([visibleRows, queue], () => {
  if (selectedIndex.value >= visibleRows.value.length) selectedIndex.value = visibleRows.value.length - 1;
});

// ── Row helpers ──────────────────────────────────────────────────────────────

function clusterHref(cluster: OpenFailureCluster): string {
  return `/failure-clusters/${cluster.id}`;
}
function open(cluster: OpenFailureCluster): void {
  navigateTo(clusterHref(cluster));
}
function ageTitle(cluster: OpenFailureCluster): string {
  return cluster.lastSeenAt ? prettyDateFormat(cluster.lastSeenAt) : '';
}
function ownerName(cluster: OpenFailureCluster): string | null {
  return effectiveAssignee(cluster);
}
function initials(name: string): string {
  const parts = name
    .replace(/@.*$/, '')
    .split(/[\s._-]+/)
    .filter(Boolean);
  return (parts[0]?.[0] ?? name[0] ?? '?').concat(parts[1]?.[0] ?? '').toUpperCase();
}

// People to offer in the assignee picker: everyone already named on a visible
// cluster, plus the signed-in user — best effort, no extra request.
const knownPeople = computed(() => {
  const set = new Set<string>();
  for (const c of props.clusters) {
    if (c.assignee) set.add(c.assignee);
    if (c.owner?.name) set.add(c.owner.name);
  }
  if (user.value?.name) set.add(user.value.name);
  return [...set].sort((a, b) => a.localeCompare(b));
});

// ── Selection ────────────────────────────────────────────────────────────────

const selectedIndex = ref(-1);
const selectedIds = ref(new Set<number>());

const selectedClusters = computed(() => rows.value.filter((c) => selectedIds.value.has(c.id)));
const bulkCanTriage = computed(() => selectedClusters.value.every(canTriage));
const bulkCanQuarantine = computed(() => selectedClusters.value.every(canQuarantine));
const bulkCanFileIssues = computed(() => selectedClusters.value.every(canFileIssue));

function toggleSelect(cluster: OpenFailureCluster): void {
  const next = new Set(selectedIds.value);
  if (next.has(cluster.id)) next.delete(cluster.id);
  else next.add(cluster.id);
  selectedIds.value = next;
}

function extendSelection(dir: 1 | -1): void {
  const list = visibleRows.value;
  if (list.length === 0) return;
  if (selectedIndex.value < 0) selectedIndex.value = 0;
  const next = Math.min(list.length - 1, Math.max(0, selectedIndex.value + dir));
  selectedIndex.value = next;
  const target = list[next];
  if (target && canSelect(target)) {
    const set = new Set(selectedIds.value);
    set.add(target.id);
    selectedIds.value = set;
  }
}

function clearSelection(): void {
  selectedIds.value = new Set();
}

// ── Actions (optimistic + undo) ──────────────────────────────────────────────

async function callPatch(path: string, body: Record<string, unknown>): Promise<void> {
  await $fetch(path, { method: 'PATCH', body });
}

function undoToast(title: string, undo: () => Promise<void>): void {
  toast.add({
    title,
    color: 'success',
    duration: 6000,
    actions: [
      {
        label: 'Undo',
        color: 'neutral',
        variant: 'outline',
        onClick: () => {
          void undo();
        },
      },
    ],
  });
}

async function setStatus(cluster: OpenFailureCluster, status: 'resolved' | 'ignored'): Promise<void> {
  if (!canTriage(cluster)) return;
  try {
    await callPatch(`/api/failure-clusters/${cluster.id}/status`, { status });
    removedIds.value = new Set([...removedIds.value, cluster.id]);
    emit('changed');
    undoToast(`${describeCluster(cluster)} set to ${formatTriageStatus(status)}`, async () => {
      await callPatch(`/api/failure-clusters/${cluster.id}/status`, { status: 'open' });
      const next = new Set(removedIds.value);
      next.delete(cluster.id);
      removedIds.value = next;
      emit('changed');
    });
  } catch (e) {
    toast.add({ title: 'Could not update the cluster', description: errorMessage(e), color: 'error' });
  }
}

async function snooze(cluster: OpenFailureCluster, option: SnoozeOption): Promise<void> {
  if (!canTriage(cluster)) return;
  try {
    await callPatch(`/api/failure-clusters/${cluster.id}/snooze`, { snooze: option });
    removedIds.value = new Set([...removedIds.value, cluster.id]);
    emit('changed');
    undoToast(`${describeCluster(cluster)} snoozed`, async () => {
      await callPatch(`/api/failure-clusters/${cluster.id}/snooze`, { snooze: null });
      const next = new Set(removedIds.value);
      next.delete(cluster.id);
      removedIds.value = next;
      emit('changed');
    });
  } catch (e) {
    toast.add({ title: 'Could not snooze the cluster', description: errorMessage(e), color: 'error' });
  }
}

async function assign(cluster: OpenFailureCluster, assignee: string | null): Promise<void> {
  if (!canTriage(cluster)) return;
  const previous = cluster.assignee ?? null;
  try {
    assigneeOverride.value = new Map(assigneeOverride.value).set(cluster.id, assignee);
    await callPatch(`/api/failure-clusters/${cluster.id}/assignee`, { assignee });
    emit('changed');
    assignOpenId.value = null;
    undoToast(assignee ? `Assigned to ${assignee}` : 'Unassigned', async () => {
      assigneeOverride.value = new Map(assigneeOverride.value).set(cluster.id, previous);
      await callPatch(`/api/failure-clusters/${cluster.id}/assignee`, { assignee: previous });
      emit('changed');
    });
  } catch (e) {
    assigneeOverride.value = new Map(assigneeOverride.value).set(cluster.id, previous);
    toast.add({ title: 'Could not assign the cluster', description: errorMessage(e), color: 'error' });
  }
}

async function quarantine(cluster: OpenFailureCluster): Promise<void> {
  if (!canQuarantine(cluster)) return;
  try {
    const res = await $fetch<{ tests: number }>(`/api/failure-clusters/${cluster.id}/quarantine`, { method: 'POST' });
    toast.add({
      title: `Quarantined ${res.tests} ${res.tests === 1 ? 'test' : 'tests'}`,
      description: describeCluster(cluster),
      color: 'success',
    });
    emit('changed');
  } catch (e) {
    toast.add({ title: 'Could not quarantine the tests', description: errorMessage(e), color: 'error' });
  }
}

async function linkIssue(cluster: OpenFailureCluster): Promise<void> {
  if (!canLink(cluster) || !linkUrl.value.trim()) return;
  try {
    await $fetch('/api/links', {
      method: 'POST',
      body: { entityType: 'failure_cluster', entityId: cluster.id, url: linkUrl.value.trim() },
    });
    toast.add({ title: 'Issue linked', description: describeCluster(cluster), color: 'success' });
    linkUrl.value = '';
    linkOpenId.value = null;
    emit('changed');
  } catch (e) {
    toast.add({ title: 'Could not link the issue', description: errorMessage(e), color: 'error' });
  }
}

// ── Bulk actions ─────────────────────────────────────────────────────────────

async function bulk(action: 'status' | 'assign' | 'snooze', extra: Record<string, unknown>): Promise<void> {
  if (!bulkCanTriage.value) return;
  const ids = selectedClusters.value.map((c) => c.id);
  if (ids.length === 0) return;
  try {
    await $fetch('/api/failure-clusters/bulk', { method: 'POST', body: { ids, action, ...extra } });
    if (action !== 'assign') removedIds.value = new Set([...removedIds.value, ...ids]);
    clearSelection();
    emit('changed');
    toast.add({ title: `Applied to ${ids.length} ${ids.length === 1 ? 'cluster' : 'clusters'}`, color: 'success' });
  } catch (e) {
    toast.add({ title: 'Bulk action failed', description: errorMessage(e), color: 'error' });
  }
}

async function bulkQuarantine(): Promise<void> {
  if (!bulkCanQuarantine.value) return;
  const targets = [...selectedClusters.value];
  if (targets.length === 0) return;
  try {
    await Promise.all(targets.map((c) => $fetch(`/api/failure-clusters/${c.id}/quarantine`, { method: 'POST' })));
    clearSelection();
    emit('changed');
    toast.add({ title: `Quarantined tests in ${targets.length} clusters`, color: 'success' });
  } catch (e) {
    toast.add({ title: 'Bulk quarantine failed', description: errorMessage(e), color: 'error' });
  }
}

// ── Popover open-state (assign / link, keyed by cluster id) ──────────────────

const assignOpenId = ref<number | null>(null);
const assignInput = ref('');
const linkOpenId = ref<number | null>(null);
const linkUrl = ref('');

function openAssign(cluster: OpenFailureCluster): void {
  assignInput.value = cluster.assignee ?? '';
  assignOpenId.value = cluster.id;
}
function openLink(cluster: OpenFailureCluster): void {
  linkUrl.value = '';
  linkOpenId.value = cluster.id;
}

// ── Create issue (modal on a row; bulk on the selection) ─────────────────────

const issueModalOpen = ref(false);
const issueModalClusterId = ref<number | null>(null);

function createIssue(cluster: OpenFailureCluster): void {
  if (!canFileIssue(cluster) || !hasTracker.value) return;
  issueModalClusterId.value = cluster.id;
  issueModalOpen.value = true;
}

const bulkCreating = ref(false);
async function bulkCreateIssues(): Promise<void> {
  if (!bulkCanFileIssues.value || bulkCreating.value) return;
  const targets = selectedClusters.value.filter((c) => !c.issueLink);
  if (targets.length === 0) return;
  bulkCreating.value = true;
  let created = 0;
  try {
    for (const cluster of targets) {
      try {
        const draft = await $fetch<{
          connectionId: number | null;
          projectKey: string | null;
          issueType: string | null;
          title: string;
          labels: string[];
          assignee: string | null;
        }>(`/api/integrations/issue-draft?entityType=failure_cluster&entityId=${cluster.id}`);
        if (!draft.connectionId || !draft.projectKey || !draft.issueType) continue;
        await $fetch('/api/integrations/issues', {
          method: 'POST',
          body: {
            entityType: 'failure_cluster',
            entityId: cluster.id,
            connectionId: draft.connectionId,
            title: draft.title,
            projectKey: draft.projectKey,
            issueType: draft.issueType,
            labels: draft.labels,
            assignee: draft.assignee,
          },
        });
        created++;
      } catch {
        /* one cluster failing never blocks the rest */
      }
    }
    clearSelection();
    emit('changed');
    toast.add({
      title: created > 0 ? `Filed ${created} ${created === 1 ? 'issue' : 'issues'}` : 'No issues filed',
      description: created < targets.length ? 'Some clusters need a Jira project binding first.' : undefined,
      color: created > 0 ? 'success' : 'warning',
    });
  } finally {
    bulkCreating.value = false;
  }
}

function onIssueCreated(): void {
  issueModalOpen.value = false;
  emit('changed');
}

function snoozeItems(cluster: OpenFailureCluster) {
  return [
    [
      { label: '1 day', onSelect: () => void snooze(cluster, '1-day') },
      { label: '1 week', onSelect: () => void snooze(cluster, '1-week') },
      { label: 'Until it recurs', onSelect: () => void snooze(cluster, 'until-recurs') },
    ],
  ];
}

// ── Keyboard ─────────────────────────────────────────────────────────────────

function onKeydown(e: KeyboardEvent): void {
  const target = e.target as HTMLElement | null;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
  const list = visibleRows.value;

  if (e.key === 'Escape') {
    if (selectedIds.value.size > 0) {
      e.preventDefault();
      clearSelection();
    }
    return;
  }
  if (list.length === 0) return;

  const sel = () => list[selectedIndex.value];

  switch (e.key) {
    case 'j':
      e.preventDefault();
      if (e.shiftKey) extendSelection(1);
      else selectedIndex.value = Math.min(list.length - 1, Math.max(0, selectedIndex.value + 1));
      break;
    case 'k':
      e.preventDefault();
      if (e.shiftKey) extendSelection(-1);
      else selectedIndex.value = Math.max(0, (selectedIndex.value < 0 ? 0 : selectedIndex.value) - 1);
      break;
    case 'x': {
      const c = sel();
      if (c && canSelect(c)) {
        e.preventDefault();
        toggleSelect(c);
      }
      break;
    }
    case 'o': {
      const c = sel();
      if (c) {
        e.preventDefault();
        open(c);
      }
      break;
    }
    case 'r': {
      const c = sel();
      if (c && canTriage(c)) {
        e.preventDefault();
        void setStatus(c, 'resolved');
      }
      break;
    }
    case 'i': {
      const c = sel();
      if (c && canTriage(c)) {
        e.preventDefault();
        void setStatus(c, 'ignored');
      }
      break;
    }
    case 'q': {
      const c = sel();
      if (c && canQuarantine(c)) {
        e.preventDefault();
        void quarantine(c);
      }
      break;
    }
    case 'a': {
      const c = sel();
      if (c && canTriage(c)) {
        e.preventDefault();
        openAssign(c);
      }
      break;
    }
    case 's': {
      const c = sel();
      if (c && canTriage(c)) {
        e.preventDefault();
        snoozeMenuId.value = c.id;
      }
      break;
    }
    case 'l': {
      const c = sel();
      if (c && canLink(c)) {
        e.preventDefault();
        openLink(c);
      }
      break;
    }
    case 'c': {
      const c = sel();
      if (c && canFileIssue(c) && hasTracker.value && !c.issueLink) {
        e.preventDefault();
        createIssue(c);
      }
      break;
    }
  }
}

// The `s` key opens the snooze dropdown for the selected row.
const snoozeMenuId = ref<number | null>(null);

onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));
</script>

<template>
  <SectionCard icon="i-lucide-inbox" title="Failure inbox" help="home.failure-inbox" data-tour="failure-inbox">
    <template #actions>
      <UButton
        v-if="hasMore && !expanded"
        variant="ghost"
        size="sm"
        trailing-icon="i-lucide-chevron-down"
        @click="expanded = true"
      >
        Show all {{ rows.length }}
      </UButton>
      <UButton
        v-else-if="expanded"
        variant="ghost"
        size="sm"
        trailing-icon="i-lucide-chevron-up"
        @click="expanded = false"
      >
        Show less
      </UButton>
    </template>

    <!-- Queue tabs — horizontally scrollable on phones -->
    <div class="-mx-2 mb-2 overflow-x-auto">
      <div class="flex items-center gap-1 px-2 min-w-max" role="tablist" aria-label="Inbox queues">
        <button
          v-for="q in INBOX_QUEUES"
          :key="q"
          type="button"
          role="tab"
          :aria-selected="queue === q"
          :data-queue="q"
          class="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium whitespace-nowrap transition-colors"
          :class="
            queue === q
              ? 'bg-primary/10 text-primary'
              : 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'
          "
          @click="queue = q"
        >
          <UIcon :name="QUEUE_META[q].icon" class="size-3.5 shrink-0" />
          <span>{{ QUEUE_META[q].label }}</span>
          <span v-if="counts[q] > 0" class="tabular-nums opacity-70">{{ counts[q] }}</span>
        </button>
      </div>
    </div>

    <!-- Bulk bar -->
    <div
      v-if="selectedIds.size > 0"
      class="mb-2 flex flex-wrap items-center gap-1.5 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-sm"
    >
      <span class="font-medium tabular-nums">{{ selectedIds.size }} selected</span>
      <div class="ml-auto flex flex-wrap items-center gap-1">
        <template v-if="bulkCanTriage">
          <UButton
            size="xs"
            color="success"
            variant="soft"
            icon="i-lucide-check"
            @click="bulk('status', { status: 'resolved' })"
          >
            Resolve
          </UButton>
          <UButton
            size="xs"
            color="neutral"
            variant="soft"
            icon="i-lucide-bell-off"
            @click="bulk('status', { status: 'ignored' })"
          >
            Ignore
          </UButton>
        </template>
        <UDropdownMenu
          v-if="bulkCanTriage"
          :items="[
            [
              {
                label: 'Assign to me',
                onSelect: () => bulk('assign', { assignee: user?.name ?? user?.username ?? null }),
              },
              { label: 'Unassign', onSelect: () => bulk('assign', { assignee: null }) },
            ],
          ]"
        >
          <UButton
            size="xs"
            color="neutral"
            variant="soft"
            icon="i-lucide-user-plus"
            trailing-icon="i-lucide-chevron-down"
          >
            Assign
          </UButton>
        </UDropdownMenu>
        <UDropdownMenu
          v-if="bulkCanTriage"
          :items="[
            [
              { label: '1 day', onSelect: () => bulk('snooze', { snooze: '1-day' }) },
              { label: '1 week', onSelect: () => bulk('snooze', { snooze: '1-week' }) },
              { label: 'Until it recurs', onSelect: () => bulk('snooze', { snooze: 'until-recurs' }) },
            ],
          ]"
        >
          <UButton size="xs" color="neutral" variant="soft" icon="i-lucide-clock" trailing-icon="i-lucide-chevron-down">
            Snooze
          </UButton>
        </UDropdownMenu>
        <UButton
          v-if="bulkCanQuarantine"
          size="xs"
          color="warning"
          variant="soft"
          icon="i-lucide-shield"
          @click="bulkQuarantine"
        >
          Quarantine
        </UButton>
        <UButton
          v-if="hasTracker && bulkCanFileIssues"
          size="xs"
          color="neutral"
          variant="soft"
          icon="i-simple-icons-jira"
          :loading="bulkCreating"
          @click="bulkCreateIssues"
        >
          Create issues
        </UButton>
        <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-x" @click="clearSelection">Clear</UButton>
      </div>
    </div>

    <div
      v-if="incidentRows.length > 0"
      class="divide-y divide-gray-100 dark:divide-gray-800"
      data-shot="inbox-incident"
    >
      <NuxtLink
        v-for="incident in incidentRows"
        :key="`incident-${incident.runId}`"
        :to="`/test-runs/${incident.runId}`"
        :data-incident-row="incident.runId"
        class="flex flex-col gap-0.5 py-3 px-2 -mx-2 rounded-md hover:bg-gray-50 dark:hover:bg-gray-800/60"
      >
        <span class="text-sm font-medium text-primary">
          Environment incident · run #{{ incident.runId }}{{ incident.host ? ` · ${incident.host}` : '' }}
        </span>
        <span class="text-xs text-muted">{{ incident.reason }}</span>
        <span class="text-xs text-muted">
          {{ incident.clusters[0]?.projectLabel || incident.clusters[0]?.projectName }} ·
          {{ incident.clusters.length }} new {{ incident.clusters.length === 1 ? 'cluster' : 'clusters' }}, not counted
        </span>
      </NuxtLink>
    </div>

    <p v-if="rows.length === 0 && incidentRows.length === 0" class="py-3 text-sm text-gray-500 dark:text-gray-400">
      {{
        queue === 'all'
          ? 'No open failure clusters — nothing needs triage right now.'
          : 'Nothing in this queue right now.'
      }}
    </p>

    <div v-if="rows.length > 0" class="divide-y divide-gray-100 dark:divide-gray-800">
      <div
        v-for="(cluster, index) in visibleRows"
        :key="cluster.id"
        role="button"
        tabindex="0"
        :data-cluster-row="cluster.id"
        data-tour="failure-inbox-row"
        :aria-current="index === selectedIndex ? 'true' : undefined"
        class="group flex flex-col gap-2 py-3 px-2 -mx-2 rounded-md cursor-pointer sm:flex-row sm:items-center sm:gap-3 hover:bg-gray-50 dark:hover:bg-gray-800/60"
        :class="[
          index === selectedIndex ? 'bg-primary/5 ring-1 ring-primary/30' : '',
          selectedIds.has(cluster.id) ? 'bg-primary/5' : '',
        ]"
        @click="open(cluster)"
        @mouseenter="selectedIndex = index"
        @keydown.enter="open(cluster)"
      >
        <!-- Select checkbox -->
        <UCheckbox
          v-if="canSelect(cluster)"
          :model-value="selectedIds.has(cluster.id)"
          class="shrink-0"
          :aria-label="`Select ${describeCluster(cluster)}`"
          @update:model-value="toggleSelect(cluster)"
          @click.stop
        />

        <!-- Headline + clue + meta -->
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-1.5 min-w-0 flex-wrap">
            <NuxtLink
              :to="clusterHref(cluster)"
              class="text-sm font-medium text-primary hover:underline truncate"
              :title="cluster.signature"
              @click.stop
            >
              {{ describeCluster(cluster) }}
            </NuxtLink>

            <!-- Exceptional badges only -->
            <UBadge v-if="cluster.regressionOnDefault" color="error" variant="subtle" size="xs" class="gap-1">
              <UIcon name="i-lucide-trending-down" class="size-3" />Regression
            </UBadge>
            <UBadge
              v-if="cluster.fixVerification === 'regressed'"
              color="error"
              variant="subtle"
              size="xs"
              class="gap-1"
            >
              <UIcon name="i-lucide-rotate-ccw" class="size-3" />Fix didn't hold
            </UBadge>
            <UBadge v-if="cluster.quarantinedCount > 0" color="warning" variant="subtle" size="xs" class="gap-1">
              <UIcon name="i-lucide-shield" class="size-3" />Quarantined
            </UBadge>
            <UBadge v-if="isSnoozedBack(cluster)" color="info" variant="subtle" size="xs" class="gap-1">
              <UIcon name="i-lucide-alarm-clock" class="size-3" />Snoozed, back
            </UBadge>
            <UBadge v-if="cluster.mergeSuggestionPending" color="neutral" variant="subtle" size="xs" class="gap-1">
              <UIcon name="i-lucide-git-merge" class="size-3" />Merge suggested
            </UBadge>

            <IssueKeyChip v-if="cluster.issueLink" :issue="cluster.issueLink" />
          </div>

          <!-- Top clue (muted) -->
          <p v-if="cluster.topClue" class="mt-0.5 text-xs text-gray-500 dark:text-gray-400 truncate">
            {{ cluster.topClue.text }}
          </p>

          <!-- Project · owner/assignee · age · tests -->
          <div class="mt-0.5 flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400 flex-wrap">
            <span class="truncate">{{ cluster.projectLabel || cluster.projectName }}</span>
            <span v-if="ownerName(cluster)" class="flex items-center gap-1 shrink-0">
              <span>·</span>
              <UAvatar :alt="ownerName(cluster)!" :text="initials(ownerName(cluster)!)" size="3xs" />
              <span class="truncate max-w-[8rem]">{{ ownerName(cluster) }}</span>
            </span>
            <span class="shrink-0">·</span>
            <span class="tabular-nums whitespace-nowrap">
              {{ cluster.affectedTests }} {{ cluster.affectedTests === 1 ? 'test' : 'tests' }}
            </span>
            <ClientOnly>
              <template v-if="cluster.lastSeenAt">
                <span class="shrink-0">·</span>
                <span :title="ageTitle(cluster)" class="whitespace-nowrap">{{
                  formatRelativeTime(cluster.lastSeenAt)
                }}</span>
              </template>
            </ClientOnly>
          </div>
        </div>

        <!-- Row actions, each for the holders of its permission on the cluster's project -->
        <div
          v-if="canActOn(cluster)"
          class="flex items-center gap-0.5 shrink-0 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100"
          @click.stop
        >
          <template v-if="canTriage(cluster)">
            <UButton
              size="xs"
              color="success"
              variant="ghost"
              icon="i-lucide-check"
              :title="`Resolve (r)`"
              @click="setStatus(cluster, 'resolved')"
            />
            <UButton
              size="xs"
              color="neutral"
              variant="ghost"
              icon="i-lucide-bell-off"
              :title="`Ignore (i)`"
              @click="setStatus(cluster, 'ignored')"
            />
          </template>
          <UButton
            v-if="canQuarantine(cluster)"
            size="xs"
            color="warning"
            variant="ghost"
            icon="i-lucide-shield"
            :title="`Quarantine the cluster's tests (q)`"
            @click="quarantine(cluster)"
          />

          <!-- Assign -->
          <UPopover
            v-if="canTriage(cluster)"
            :open="assignOpenId === cluster.id"
            @update:open="(v) => (assignOpenId = v ? cluster.id : null)"
          >
            <UButton
              size="xs"
              color="neutral"
              variant="ghost"
              icon="i-lucide-user-plus"
              :title="`Assign (a)`"
              @click="openAssign(cluster)"
            />
            <template #content>
              <div class="p-3 w-64 space-y-2">
                <p class="text-xs font-medium text-gray-500">Assign this cluster</p>
                <UInput
                  v-model="assignInput"
                  placeholder="Name or email"
                  size="sm"
                  autofocus
                  :list="`assignee-people-${cluster.id}`"
                  @keydown.enter="assign(cluster, assignInput.trim() || null)"
                />
                <datalist :id="`assignee-people-${cluster.id}`">
                  <option v-for="p in knownPeople" :key="p" :value="p" />
                </datalist>
                <div class="flex items-center justify-between gap-1">
                  <UButton size="xs" variant="soft" @click="assign(cluster, user?.name ?? user?.username ?? null)">
                    Assign to me
                  </UButton>
                  <div class="flex gap-1">
                    <UButton
                      v-if="cluster.assignee"
                      size="xs"
                      color="neutral"
                      variant="ghost"
                      @click="assign(cluster, null)"
                    >
                      Clear
                    </UButton>
                    <UButton size="xs" color="primary" @click="assign(cluster, assignInput.trim() || null)"
                      >Save</UButton
                    >
                  </div>
                </div>
              </div>
            </template>
          </UPopover>

          <!-- Snooze -->
          <UDropdownMenu
            v-if="canTriage(cluster)"
            :items="snoozeItems(cluster)"
            :open="snoozeMenuId === cluster.id"
            @update:open="(v: boolean) => (snoozeMenuId = v ? cluster.id : null)"
          >
            <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-clock" :title="`Snooze (s)`" />
          </UDropdownMenu>

          <!-- Create issue (only while the cluster has no known issue) -->
          <UButton
            v-if="canFileIssue(cluster) && hasTracker && !cluster.issueLink"
            size="xs"
            color="neutral"
            variant="ghost"
            icon="i-simple-icons-jira"
            :title="`Create issue (c)`"
            @click="createIssue(cluster)"
          />

          <!-- Link to issue -->
          <UPopover
            v-if="canLink(cluster)"
            :open="linkOpenId === cluster.id"
            @update:open="(v) => (linkOpenId = v ? cluster.id : null)"
          >
            <UButton
              size="xs"
              color="neutral"
              variant="ghost"
              icon="i-lucide-link"
              :title="`Link to issue (l)`"
              @click="openLink(cluster)"
            />
            <template #content>
              <div class="p-3 w-72 space-y-2">
                <p class="text-xs font-medium text-gray-500">Link a known issue</p>
                <UInput
                  v-model="linkUrl"
                  placeholder="https://github.com/org/repo/issues/1"
                  size="sm"
                  autofocus
                  @keydown.enter="linkIssue(cluster)"
                />
                <div class="flex justify-end">
                  <UButton size="xs" color="primary" :disabled="!linkUrl.trim()" @click="linkIssue(cluster)"
                    >Link</UButton
                  >
                </div>
              </div>
            </template>
          </UPopover>
        </div>
      </div>
    </div>

    <!-- Keyboard hints (hidden on touch) -->
    <p
      v-if="hints.any"
      class="mt-3 text-[11px] text-gray-400 [@media(hover:none)]:hidden"
      data-tour="failure-inbox-triage"
    >
      <span class="font-mono">j/k</span> move ·
      <span v-if="hints.select"><span class="font-mono">x</span> select · </span>
      <template v-if="hints.triage">
        <span class="font-mono">r</span> resolve · <span class="font-mono">i</span> ignore ·
      </template>
      <span v-if="hints.quarantine"><span class="font-mono">q</span> quarantine · </span>
      <template v-if="hints.triage">
        <span class="font-mono">a</span> assign · <span class="font-mono">s</span> snooze ·
      </template>
      <span v-if="hints.link"><span class="font-mono">l</span> link · </span>
      <span v-if="hints.issue"><span class="font-mono">c</span> create issue · </span>
      <span class="font-mono">o</span> open
    </p>

    <CreateIssueModal
      v-if="issueModalClusterId != null"
      v-model:open="issueModalOpen"
      entity-type="failure_cluster"
      :entity-id="issueModalClusterId"
      @created="onIssueCreated"
      @linked="onIssueCreated"
      @queued="onIssueCreated"
    />
  </SectionCard>
</template>
