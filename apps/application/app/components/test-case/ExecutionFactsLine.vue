<script setup lang="ts">
/**
 * The facts line under an execution's situation block: the failing line's source
 * path (open in IDE) when it is not the test's own line, the run facts that
 * collapse to Details on mobile (browser, duration, attempts, branch, build,
 * age), the Details popover with everything else, and the shared "Raw error ▸"
 * disclosure with its Copy failure action. Its Links section lists the links
 * pinned to this execution, to its test and to its run, each group named by its
 * owner and editable by a viewer who may write links, then its cluster's links,
 * read-only, with a link that opens the cluster page's Details, where they are
 * edited. From `md` up the popover lays its groups out in two columns, the links
 * across both.
 *
 * The secondary facts render once and are hidden below `sm`; the Details popover
 * repeats the mobile-critical ones so the phone layout keeps them reachable.
 * `revealRawError()` opens the raw error from a citation elsewhere on the page.
 */
import { useResizeObserver } from '@vueuse/core';
import type { AttemptOutcome, EntityLinkInfo, TestCaseHistoryPoint } from '~~/types/api';
import type { LinkEntityType } from '#shared/handlers/links';
import { safeHttpUrl } from '#shared/utils/safe-url';

const props = defineProps<{
  /** The fetched execution — every fact reads off this object. */
  testCase: any;
  /** Prior executions of this test, for the duration-vs-average note. */
  history?: TestCaseHistoryPoint[];
}>();

const emit = defineEmits<{ copyFailure: []; linksChanged: [] }>();

// The links around this execution, by what they are pinned to: the execution,
// its test and its run, edited here, and its cluster's (its issue among them),
// read-only, since the cluster page edits them.
const { can } = useAuth();
const canWriteLinks = computed(() => can('link:write', props.testCase?.testRun?.project?.id ?? null));
const linkGroups = computed(() => {
  const tc = props.testCase;
  if (!tc) return [];
  const groups: {
    key: string;
    label: string;
    entityType: LinkEntityType;
    entityId: number;
    links: EntityLinkInfo[];
    /** The page that edits a read-only group's links. */
    editedOn?: string;
  }[] = [];
  if (tc.id)
    groups.push({
      key: 'execution',
      label: 'This execution',
      entityType: 'test_runs_case',
      entityId: tc.id,
      links: tc.links ?? [],
    });
  if (tc.testCaseId)
    groups.push({
      key: 'test',
      label: 'This test',
      entityType: 'test_case',
      entityId: tc.testCaseId,
      links: tc.stableLinks ?? [],
    });
  if (tc.testRun?.id)
    groups.push({
      key: 'run',
      label: `Run #${tc.testRun.id}`,
      entityType: 'test_run',
      entityId: tc.testRun.id,
      links: tc.testRun.links ?? [],
    });
  if (tc.failureCluster?.id)
    groups.push({
      key: 'cluster',
      label: `Cluster #${tc.failureCluster.id}`,
      entityType: 'failure_cluster',
      entityId: tc.failureCluster.id,
      links: tc.failureCluster.links ?? [],
      editedOn: `/failure-clusters/${tc.failureCluster.id}#links`,
    });
  // A group shows once it holds links; a writer also sees the groups edited here, to add one.
  return groups.filter((g) => g.links.length > 0 || (canWriteLinks.value && !g.editedOn));
});

// The popover opens below the button when its content fits there, or when there
// is at least as much room below as above; otherwise above. It never reaches over
// the page's navbar, wherever the navbar sits (the public demo's banner pushes it
// down), and scrolls inside when it is taller than the room it gets.
const GAP = 8;
const detailsButton = ref<{ $el?: Element } | null>(null);
const detailsTop = ref(64 + GAP);
/** The top of the panel body under the navbar, read when the popover opens. */
function contentTop(): number {
  const panel = detailsButton.value?.$el?.closest('[id^="dashboard-panel-"]');
  const body = panel?.querySelector(':scope > [data-slot="body"]');
  if (body) return body.getBoundingClientRect().top;
  const banner = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--demo-banner-height'));
  return 64 + (Number.isFinite(banner) ? banner : 0);
}
function onDetailsOpen(open: boolean) {
  if (open) detailsTop.value = contentTop() + GAP;
}
const detailsContent = computed(() => ({
  side: 'bottom' as const,
  collisionPadding: { top: detailsTop.value, right: GAP, bottom: GAP, left: GAP },
}));
// A fade with "More below" while the popover holds more than it shows.
const detailsScroller = ref<HTMLElement | null>(null);
const moreBelow = ref(false);
function updateMoreBelow() {
  const el = detailsScroller.value;
  moreBelow.value = !!el && el.scrollTop + el.clientHeight < el.scrollHeight - 4;
}
useResizeObserver(detailsScroller, updateMoreBelow);

const metadata = computed(() => props.testCase?.testRun?.metadata as Record<string, unknown> | null | undefined);
const scmInfo = computed(() => {
  const m = metadata.value;
  if (!m?.scm) return null;
  return m.scm as { commit?: string; branch?: string; author?: string; commitMessage?: string };
});
const ciInfo = computed(() => {
  const m = metadata.value;
  if (!m?.ci) return null;
  return m.ci as { provider?: string; buildNumber?: string; buildUrl?: string; workflow?: string; jobName?: string };
});
const environment = computed(() => props.testCase?.testRun?.environment);
const browser = computed(() => props.testCase?.browser ?? null);
const stepsCount = computed(() => (props.testCase?.steps as unknown[] | null)?.length ?? 0);

// The first captured source frame — the failing line — for the "open in IDE"
// link. The test's own file and line are on the identity line above, so a
// frame that points at them, or no frame, shows no link here.
const ideTarget = computed(() => {
  const tc = props.testCase as {
    filePath?: string | null;
    line?: number | null;
    testSourceFrames?: Array<{ filePath?: string; line?: number }> | null;
  } | null;
  const frame = tc?.testSourceFrames?.[0];
  if (!frame?.filePath) return null;
  if (frame.filePath === tc?.filePath && frame.line === tc?.line) return null;
  return { filePath: frame.filePath, line: frame.line };
});

const historicalTiming = computed(() => {
  const history = props.history;
  if (!history || history.length < 2 || !props.testCase?.duration) return null;
  const previous = history.filter((h) => h.duration !== null && h.id !== props.testCase?.id);
  if (previous.length === 0) return null;
  const avg = previous.reduce((sum, h) => sum + (h.duration || 0), 0) / previous.length;
  const current = props.testCase.duration;
  const diff = current - avg;
  const pct = avg > 0 ? Math.round((diff / avg) * 100) : 0;
  return { avg: Math.round(avg), current, diff: Math.round(diff), pct };
});

const attempts = computed(() => props.testCase?.attempts ?? null);
function attemptColor(status: string): 'success' | 'error' | 'neutral' {
  if (status === 'passed') return 'success';
  if (status === 'failed' || status === 'timedout' || status === 'timedOut') return 'error';
  return 'neutral';
}
// An attempt's start time is in the browser's time zone, which the server does
// not know, so the titles name it once the line is mounted.
const mounted = ref(false);
onMounted(() => {
  mounted.value = true;
});
function attemptTitle(a: AttemptOutcome): string {
  const when = a.startedAt && mounted.value ? ` at ${new Date(a.startedAt).toLocaleString()}` : '';
  return `Attempt ${a.retry + 1}: ${a.status} (${Math.round(a.duration)} ms)${when}`;
}
function isCurrentAttempt(a: AttemptOutcome): boolean {
  return a.retry === (props.testCase?.retries ?? 0);
}
function attemptLink(a: AttemptOutcome): string | null {
  return !isCurrentAttempt(a) && a.executionId ? `/test-run-cases/${a.executionId}` : null;
}

const disclosure = ref<{ reveal: () => void } | null>(null);
function revealRawError() {
  disclosure.value?.reveal();
}
defineExpose({ revealRawError });
</script>

<template>
  <div class="flex items-center gap-x-2 gap-y-1 flex-wrap text-xs text-muted">
    <OpenInIdeLink
      v-if="ideTarget"
      :file-path="ideTarget.filePath"
      :line="ideTarget.line"
      :project-key="testCase?.testRun?.project?.id"
      :project-name="testCase?.testRun?.project?.name"
    />
    <!-- Secondary facts collapse at 390px; they stay in Details below. -->
    <span class="max-sm:hidden inline-flex items-center gap-x-2 gap-y-1 flex-wrap">
      <span v-if="browser?.projectName" class="inline-flex items-center gap-1">
        <BrowserBadge :browser="{ ...browser, viewport: undefined }" size="sm" />
        <span v-if="browser.viewport" class="tabular-nums">
          {{ browser.viewport.width }}×{{ browser.viewport.height }}
        </span>
      </span>
      <span v-if="testCase?.status !== 'didnotrun'" class="inline-flex items-center gap-1 tabular-nums">
        <DurationValue :ms="testCase?.duration" />
        <span v-if="historicalTiming">
          (avg <DurationValue :ms="historicalTiming.avg" />, {{ historicalTiming.diff > 0 ? '+' : ''
          }}{{ historicalTiming.pct }}%)
        </span>
      </span>
      <span
        v-if="attempts && attempts.length > 1"
        class="inline-flex items-center gap-1"
        role="group"
        aria-label="Attempts of this test in this run"
      >
        <template v-for="a in attempts" :key="a.retry">
          <NuxtLink
            v-if="attemptLink(a)"
            :to="attemptLink(a)!"
            :title="`${attemptTitle(a)} — open this attempt`"
            class="inline-flex rounded-md outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary hover:opacity-80"
          >
            <UBadge :color="attemptColor(a.status)" variant="soft" size="sm" class="font-mono">
              {{ a.retry + 1 }}/{{ attempts.length }}
              <UIcon :name="a.status === 'passed' ? 'i-lucide-check' : 'i-lucide-x'" class="w-3 h-3" />
            </UBadge>
          </NuxtLink>
          <UBadge
            v-else
            :color="attemptColor(a.status)"
            variant="soft"
            size="sm"
            class="font-mono"
            :class="isCurrentAttempt(a) ? CURRENT_ITEM_RING_CLASS : ''"
            :title="isCurrentAttempt(a) ? `${attemptTitle(a)} — this execution` : attemptTitle(a)"
            :aria-current="isCurrentAttempt(a) ? 'true' : undefined"
          >
            {{ a.retry + 1 }}/{{ attempts.length }}
            <UIcon :name="a.status === 'passed' ? 'i-lucide-check' : 'i-lucide-x'" class="w-3 h-3" />
          </UBadge>
        </template>
      </span>
      <BranchLabel v-if="scmInfo?.branch" :name="scmInfo.branch" class="max-w-[12rem]" copyable />
      <a
        v-if="ciInfo?.buildUrl || ciInfo?.buildNumber"
        :href="safeHttpUrl(ciInfo?.buildUrl) ?? undefined"
        :target="safeHttpUrl(ciInfo?.buildUrl) ? '_blank' : undefined"
        :class="safeHttpUrl(ciInfo?.buildUrl) ? SENTENCE_LINK_CLASS : ''"
      >
        {{ ciInfo?.buildNumber ? `Build #${ciInfo.buildNumber}` : 'View build' }}
      </a>
      <ClientOnly>
        <span v-if="testCase?.startedAt" :title="new Date(testCase.startedAt).toLocaleString()">
          {{ formatRelativeTime(testCase.startedAt) }}
        </span>
      </ClientOnly>
    </span>

    <UPopover :content="detailsContent" @update:open="onDetailsOpen">
      <UButton
        ref="detailsButton"
        size="xs"
        variant="ghost"
        color="neutral"
        trailing-icon="i-lucide-chevron-down"
        label="Details"
        class="shrink-0"
      />
      <template #content>
        <div class="relative">
          <div
            ref="detailsScroller"
            class="overflow-y-auto max-h-(--reka-popover-content-available-height)"
            data-testid="execution-details"
            @scroll="updateMoreBelow"
          >
            <!-- One column on a phone, two from md up; a group never splits across them, and Links spans both. -->
            <div
              class="p-3 space-y-2 text-sm max-w-sm max-sm:max-w-[calc(100vw-1rem)] md:max-w-none md:w-[40rem] md:columns-2 md:gap-6 *:break-inside-avoid"
            >
              <!-- The facts that collapse on mobile, kept reachable here. -->
              <div class="space-y-1 sm:hidden">
                <p class="text-xs font-medium text-muted uppercase tracking-wide">Run</p>
                <p v-if="testCase?.status !== 'didnotrun'" class="tabular-nums">
                  Duration: <DurationValue :ms="testCase?.duration" />
                </p>
                <p v-if="scmInfo?.branch">
                  Branch: <BranchLabel :name="scmInfo.branch" class="text-highlighted" inherit copyable />
                </p>
                <p v-if="ciInfo?.buildNumber">Build #{{ ciInfo.buildNumber }}</p>
                <ClientOnly>
                  <p v-if="testCase?.startedAt">{{ formatRelativeTime(testCase.startedAt) }}</p>
                </ClientOnly>
              </div>
              <div v-if="environment || ciInfo" class="space-y-1">
                <p class="text-xs font-medium text-muted uppercase tracking-wide">CI &amp; environment</p>
                <p v-if="environment">
                  Environment: <span class="text-highlighted">{{ environment }}</span>
                </p>
                <p v-if="ciInfo?.provider">Provider: {{ ciInfo.provider }}</p>
                <p v-if="ciInfo?.workflow || ciInfo?.jobName">
                  <template v-if="ciInfo?.workflow">{{ ciInfo.workflow }}</template>
                  <template v-if="ciInfo?.workflow && ciInfo?.jobName"> · </template>
                  <template v-if="ciInfo?.jobName">{{ ciInfo.jobName }}</template>
                </p>
              </div>
              <div v-if="testCase?.testRun?.playwrightVersion || testCase?.testRun?.reporterVersion" class="space-y-1">
                <p class="text-xs font-medium text-muted uppercase tracking-wide">Tooling</p>
                <p>
                  <template v-if="testCase?.testRun?.playwrightVersion"
                    >Playwright v{{ testCase.testRun.playwrightVersion }}</template
                  >
                  <template v-if="testCase?.testRun?.playwrightVersion && testCase?.testRun?.reporterVersion">
                    ·
                  </template>
                  <template v-if="testCase?.testRun?.reporterVersion"
                    >Piwi v{{ testCase.testRun.reporterVersion }}</template
                  >
                </p>
              </div>
              <div class="space-y-1">
                <p class="text-xs font-medium text-muted uppercase tracking-wide">Execution</p>
                <p class="tabular-nums">
                  Worker {{ testCase?.workerIndex ?? '—'
                  }}<template v-if="testCase?.shardIndex != null"> · Shard {{ testCase.shardIndex }}</template> ·
                  {{ stepsCount }} steps
                </p>
                <p
                  v-if="testCase?.slowestStep && testCase?.status !== 'didnotrun'"
                  class="truncate"
                  :title="testCase.slowestStep"
                >
                  Slowest step: {{ testCase.slowestStep }}
                  <span v-if="testCase.slowestStepDuration"
                    >(<DurationValue :ms="testCase.slowestStepDuration" />)</span
                  >
                </p>
                <p v-if="(testCase?.wastedTimeMs ?? 0) > 0">
                  Wasted in fixed waits: <DurationValue :ms="testCase?.wastedTimeMs" />
                </p>
              </div>
              <div v-if="testCase?.locks?.length" class="space-y-1">
                <p class="text-xs font-medium text-muted uppercase tracking-wide">Locks</p>
                <p class="flex flex-wrap items-center gap-1.5">
                  <span
                    v-for="lock in testCase.locks"
                    :key="lock"
                    class="inline-flex items-center gap-1 text-highlighted"
                    title="Only one holder of this lock runs at a time"
                  >
                    <UIcon name="i-lucide-lock" class="size-3 text-warning" />{{ lock }}
                  </span>
                </p>
              </div>
              <div v-if="testCase?.tags?.length || testCase?.testMeta" class="space-y-1">
                <p class="text-xs font-medium text-muted uppercase tracking-wide">Tags</p>
                <TestMetaBadges :tags="testCase?.tags" :meta="testCase?.testMeta" />
              </div>
              <div v-if="linkGroups.length" class="space-y-1.5 md:[column-span:all]" data-shot="execution-links">
                <p class="text-xs font-medium text-muted uppercase tracking-wide">Links</p>
                <div
                  v-for="group in linkGroups"
                  :key="group.key"
                  class="space-y-0.5"
                  :data-testid="`links-${group.key}`"
                >
                  <p class="text-xs text-muted">
                    {{ group.label
                    }}<template v-if="group.editedOn">
                      ·
                      <NuxtLink :to="group.editedOn" :class="SENTENCE_LINK_CLASS">{{
                        canWriteLinks ? 'Edit on the cluster page' : 'Open the cluster'
                      }}</NuxtLink></template
                    >
                  </p>
                  <EntityLinks
                    :entity-type="group.entityType"
                    :entity-id="group.entityId"
                    :links="group.links"
                    :readonly="!canWriteLinks || !!group.editedOn"
                    @updated="emit('linksChanged')"
                  />
                </div>
              </div>
            </div>
          </div>
          <div
            v-if="moreBelow"
            aria-hidden="true"
            class="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center rounded-b-md bg-linear-to-t from-(--ui-bg) from-50% to-transparent pt-6 pb-1.5 text-xs text-muted"
            data-testid="execution-details-more"
          >
            <span class="inline-flex items-center gap-1">
              More below <UIcon name="i-lucide-chevron-down" class="size-3.5" />
            </span>
          </div>
        </div>
      </template>
    </UPopover>

    <!-- Raw error: the verbatim ANSI output, one click below the block. -->
    <RawErrorDisclosure ref="disclosure" :error="testCase?.error" condense>
      <template #actions>
        <UButton
          size="xs"
          variant="ghost"
          color="neutral"
          icon="i-lucide-clipboard"
          aria-label="Copy failure"
          title="Copy failure"
          @click="emit('copyFailure')"
        >
          Copy failure
        </UButton>
      </template>
    </RawErrorDisclosure>
  </div>
</template>
