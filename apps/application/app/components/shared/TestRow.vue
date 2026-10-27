<script setup lang="ts">
/**
 * One test in a list, read the same way everywhere: a status icon and the test
 * title on the first line with the exceptional badges and the right-side metrics
 * (duration, browser, retries, wasted time, cluster), the failure headline on
 * the second line, and the source path on the third. The whole row reflows to a
 * single column on a phone, so it reads as a card with no horizontal scroll.
 *
 * Built to be reused by the run's Tests tab, the cluster's affected-tests list,
 * the run's Changes tab, the project catalog, the flaky and quarantine lists and
 * the test history page. An execution is passed as `testCase`; a list whose rows
 * are not executions (the project catalog, a flaky or quarantined test, an entry
 * in a test's history) passes the identity and status directly and supplies its
 * own right-side facts through the `metrics` slot, an extra line through the
 * `subline` slot, and its own link through `href`.
 *
 * A searchable list passes `highlight` to mark what its search matched, and
 * `suitePath` to name the describe blocks before the title (`Checkout › pays
 * by card`, as Playwright's reporters print it) when its grouping does not
 * already show them.
 */
import type { TestCaseResult } from '~~/types/api';
import type { LiveStepInfo } from '~/utils/live-steps';
import { liveResourcesLabel, type LiveWorkerResources } from '~/utils/live-worker-resources';
import type { TestRowBadge } from '~/utils/test-row-badges';
import type { KnownIssueRef } from '#shared/handlers/known-issues';
import type { TestSearchHighlights } from '#shared/test-search';
import { badgesFromTestCase } from '~/utils/test-row-badges';
import { testLabel } from '#shared/utils/test-label';

const props = withDefaults(
  defineProps<{
    /** The execution this row shows. Omit for a test-level or history row. */
    testCase?: TestCaseResult | null;
    /** Link the row opens; defaults to the execution page for an execution. */
    href?: string | null;
    /** Title override, when the row is not built from an execution. Pass the test's whole title. */
    title?: string | null;
    /** The title without the external ID, when the row is not built from an execution. */
    displayTitle?: string | null;
    /** The test's external ID, shown before the title, when the row is not built from an execution. */
    externalId?: string | null;
    /** Status override that drives the left icon (defaults to the execution's). */
    status?: string | null;
    /** Left-icon override; defaults to the status glyph. */
    icon?: string | null;
    iconClass?: string | null;
    /** Source path (`file:line:col` or a bare path) for the third line. */
    location?: string | null;
    filePath?: string | null;
    /** Failure headline source, when the row is not built from an execution. */
    error?: string | null;
    steps?: TestCaseResult['steps'] | null;
    /** Badge list override; defaults to the execution's badges. */
    badges?: TestRowBadge[] | null;
    /** Resolved cluster display name; falls back to the id when absent. */
    clusterName?: string | null;
    /** Show the failing row's cluster chip on the right. */
    showCluster?: boolean;
    /** The tracker issue this execution's failure is tracked in, shown as a chip after the metrics. */
    issue?: KnownIssueRef | null;
    quarantined?: boolean;
    /** Render a selection checkbox on a failing row and reflect `selected`. */
    selectable?: boolean;
    selected?: boolean;
    /**
     * Make the whole row a selector: a click anywhere (and the title) emits
     * `select` instead of navigating, and `active` reflects the chosen row. Used
     * by the cluster page's affected-tests list to switch the evidence.
     */
    selectOnClick?: boolean;
    active?: boolean;
    /** The step this row's worker is on right now (live runs only). */
    liveStep?: LiveStepInfo | null;
    /** What this row's worker and its browsers use right now, as last measured (live runs only). */
    liveResources?: LiveWorkerResources | null;
    highlighted?: boolean;
    projectKey?: string | number | null;
    projectName?: string | null;
    /** How many badges to show before the rest fold into `+N`. */
    badgeMax?: number;
    /** Extra left padding in px, to indent a row under a nested group header. */
    indent?: number;
    /** The describe blocks, outermost first, named before the title. */
    suitePath?: readonly string[] | null;
    /** What the list's search matched, marked in the title, path, describe blocks and error. */
    highlight?: TestSearchHighlights | null;
  }>(),
  {
    testCase: null,
    href: null,
    title: null,
    displayTitle: null,
    externalId: null,
    status: null,
    icon: null,
    iconClass: null,
    location: null,
    filePath: null,
    error: null,
    steps: null,
    badges: null,
    clusterName: null,
    issue: null,
    showCluster: true,
    quarantined: false,
    selectable: false,
    selected: false,
    selectOnClick: false,
    active: false,
    liveStep: null,
    liveResources: null,
    highlighted: false,
    projectKey: null,
    projectName: null,
    badgeMax: 3,
    indent: 0,
    suitePath: null,
    highlight: null,
  },
);

const emit = defineEmits<{ toggle: []; select: [] }>();

const tc = computed(() => props.testCase);
const liveResourcesText = computed(() => (props.liveResources ? liveResourcesLabel(props.liveResources) : ''));
const liveResourcesTitle = computed(() => {
  const kind = props.liveResources?.memoryKind ? ` (memory as ${props.liveResources.memoryKind.toUpperCase()})` : '';
  return `What worker ${tc.value?.workerIndex ?? ''} and the browsers it started use right now, as last measured${kind}, and the pages open in it`;
});

const title = computed(() => props.title ?? tc.value?.title ?? '');
/** What the row shows: the title without its external ID when the reporter removed it; `title` stays the tooltip. */
const label = computed(() =>
  testLabel({ title: title.value, displayTitle: props.title != null ? props.displayTitle : tc.value?.displayTitle }),
);
const externalId = computed(() => (props.title != null ? props.externalId : tc.value?.externalId) ?? null);
const status = computed(() => props.status ?? tc.value?.status ?? 'unknown');
const failed = computed(() => isFailedStatus(status.value));
const href = computed(() => props.href ?? (tc.value ? `/test-run-cases/${tc.value.executionId}` : '#'));
/** The link's href, under the base path the app is served at (`/demo/` in the demo). */
const router = useRouter();
const linkHref = computed(() => (href.value === '#' ? '#' : router.resolve(href.value).href));

/** A plain click selects the row or routes in the app; a modified click opens the link as the browser does. */
function onTitleClick(event: MouseEvent) {
  if (isModifiedClick(event)) {
    event.stopPropagation();
    return;
  }
  event.preventDefault();
  if (props.selectOnClick) emit('select');
  else void navigateTo(href.value);
}
// A live-streamed row carries a negative placeholder executionId until its
// run-case row is persisted — render its title as plain text, not a link to
// some unrelated execution that happens to own the fabricated id.
const linkable = computed(() => (props.href != null ? true : tc.value ? tc.value.executionId > 0 : true));
const errorText = computed(() => props.error ?? tc.value?.error ?? null);
const stepsData = computed(() => props.steps ?? tc.value?.steps ?? null);
const locationPath = computed(() => props.location ?? tc.value?.location ?? null);

const badges = computed<TestRowBadge[]>(
  () => props.badges ?? (tc.value ? badgesFromTestCase(tc.value, { quarantined: props.quarantined }) : []),
);

const statusIcon = computed(() => props.icon ?? getStatusIcon(status.value));
const statusIconClass = computed(() => props.iconClass ?? getStatusTextClass(status.value));

const statusHint = computed(() =>
  tc.value && tc.value.status === 'didnotrun'
    ? formatDidNotRunReason(tc.value.didNotRunReason)
    : formatStatusLabel(status.value),
);

const suiteSegments = computed(() => props.suitePath ?? []);
/** What to mark in the title and the source path; empty when nothing was searched. */
const titleMarks = computed(() => props.highlight?.title ?? []);
const fileMarks = computed(() => props.highlight?.file ?? []);

const clusterLabel = computed(() =>
  tc.value?.failureClusterId != null ? (props.clusterName ?? `Cluster #${tc.value.failureClusterId}`) : '',
);
</script>

<template>
  <div
    class="border-b border-default px-3 py-2.5 text-sm transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-900/40"
    :class="[
      highlighted ? 'animate-pulse bg-yellow-100 dark:bg-yellow-900/30' : '',
      active ? SELECTED_ROW_CLASS : '',
      selectOnClick ? 'cursor-pointer' : '',
    ]"
    :style="indent ? { paddingLeft: `${12 + indent}px` } : undefined"
    :role="selectOnClick ? 'button' : undefined"
    :aria-pressed="selectOnClick ? (active ? 'true' : 'false') : undefined"
    :tabindex="selectOnClick ? 0 : undefined"
    @click="selectOnClick ? emit('select') : undefined"
    @keydown.enter.self="selectOnClick ? emit('select') : undefined"
    @keydown.space.self.prevent="selectOnClick ? emit('select') : undefined"
  >
    <div class="flex items-start gap-2 min-w-0">
      <input
        v-if="selectable"
        type="checkbox"
        class="size-4 shrink-0 mt-0.5 cursor-pointer accent-primary focus-visible:ring-2 focus-visible:ring-primary rounded"
        :checked="selected"
        :aria-label="`Select ${title}`"
        @click.stop
        @change="emit('toggle')"
      />
      <span class="size-4 shrink-0 mt-0.5" role="img" :aria-label="`Status: ${statusHint}`" :title="statusHint">
        <UIcon
          :name="statusIcon"
          class="size-4"
          :class="[statusIconClass, isStatusInFlight(status) ? 'animate-spin' : '']"
        />
      </span>

      <div class="flex-1 min-w-0 space-y-1">
        <!-- Line 1: title, badges, then the right-side metrics -->
        <div class="flex items-center gap-x-2 gap-y-1 flex-wrap min-w-0">
          <!-- The external ID leads the line, so IDs line up down the list. -->
          <TestIdChip v-if="externalId" :external-id="externalId" />
          <!-- The describe blocks and the title read as one line of text, wrapping together. -->
          <span class="min-w-0 break-words">
            <span v-if="suiteSegments.length" class="text-muted">
              <span class="sr-only">In </span>
              <template v-for="(segment, i) in suiteSegments" :key="i"
                ><SearchHighlight :text="segment" :patterns="highlight?.describe" /><span aria-hidden="true"> › </span
                ><span v-if="i < suiteSegments.length - 1" class="sr-only">, </span></template
              ><span class="sr-only">: </span>
            </span>
            <!-- Neutral title: a primary-colored link title would compete with the row's status. -->
            <a
              v-if="linkable"
              :href="linkHref"
              class="text-highlighted hover:text-primary hover:underline font-medium"
              :title="title"
              @click="onTitleClick"
              ><SearchHighlight v-if="titleMarks.length" :text="label" :patterns="titleMarks" /><template v-else>{{
                label
              }}</template></a
            >
            <span v-else class="text-highlighted font-medium" :title="title"
              ><SearchHighlight v-if="titleMarks.length" :text="label" :patterns="titleMarks" /><template v-else>{{
                label
              }}</template></span
            >
          </span>
          <BadgeGroup :badges="badges" :max="badgeMax" />

          <div class="flex flex-wrap items-center justify-end gap-x-2 gap-y-1 ml-auto min-w-0 text-xs text-muted">
            <slot name="metrics">
              <template v-if="tc">
                <template v-if="tc.status === 'running'">
                  <span v-if="!liveStep" class="text-info">In progress…</span>
                  <span
                    v-if="liveResourcesText"
                    class="inline-flex items-center gap-0.5 tabular-nums"
                    data-testid="live-worker-resources"
                    :title="liveResourcesTitle"
                  >
                    <UIcon name="i-lucide-cpu" class="size-3 shrink-0" />
                    {{ liveResourcesText }}
                  </span>
                </template>
                <DurationValue v-else-if="tc.duration" :ms="tc.duration" />
                <BrowserBadge :browser="tc.browser" size="sm" />
                <UBadge
                  v-if="(tc.retries ?? 0) > 0"
                  color="warning"
                  variant="soft"
                  size="xs"
                  :title="`${tc.retries} retries`"
                >
                  {{ tc.retries }}x
                </UBadge>
                <span
                  v-if="tc.wastedTimeMs"
                  class="inline-flex items-center gap-0.5 text-amber-600 dark:text-amber-400"
                  title="Wasted in fixed waits"
                >
                  <UIcon name="i-lucide-hourglass" class="size-3 shrink-0" />
                  <DurationValue :ms="tc.wastedTimeMs" unit-class="opacity-60" no-title />
                </span>
                <NuxtLink
                  v-if="showCluster && tc.failureClusterId"
                  :to="`/failure-clusters/${tc.failureClusterId}`"
                  class="inline-flex shrink-0"
                  @click.stop
                >
                  <UBadge color="info" variant="subtle" size="xs" class="max-w-44">
                    <span class="truncate">{{ clusterLabel }}</span>
                  </UBadge>
                </NuxtLink>
              </template>
            </slot>
            <IssueKeyChip v-if="issue" :issue="issue" />
          </div>
        </div>

        <FailureHeadline
          v-if="failed && errorText"
          :error="errorText"
          :steps="stepsData"
          :highlight="highlight?.error"
          truncate
          class="text-xs text-gray-600 dark:text-gray-400"
        />

        <OpenInIdeLink
          v-if="locationPath || filePath"
          :location="locationPath"
          :file-path="filePath ?? undefined"
          :project-key="projectKey"
          :project-name="projectName"
          class="block text-xs text-zinc-400 dark:text-zinc-500"
        >
          <template v-if="fileMarks.length" #default="{ label }"
            ><SearchHighlight :text="label" :patterns="fileMarks"
          /></template>
        </OpenInIdeLink>

        <slot name="subline" />

        <TestRowLiveStep v-if="liveStep" :step="liveStep" class="max-w-full" />
      </div>
    </div>
  </div>
</template>
