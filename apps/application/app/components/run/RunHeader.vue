<script setup lang="ts">
import type { TestRunDetails, ReportInfo } from '~~/types/api';
import type { RetryMode } from '~/utils/retry-command';
import { highlightCode } from '#shared/highlight';
import { safeHttpUrl } from '#shared/utils/safe-url';
import { readIncidentReview, readRunIncident } from '#shared/run-incident';
import { describeIngestHealth, readIngestHealth } from '#shared/ingest-health';
import { readShuffleSeed } from '#shared/utils/run-metadata';
import { readRunCoverageGaps } from '#shared/run-coverage-gaps';
import { coverageGapDetail } from '~/utils/combined-coverage';

/**
 * The run page's detail header (the run variant of `DetailHeader`): status,
 * Run #N, the label editor, the kept mark and the marker chip on the first line with the
 * primary action, one facts line with a Details popover for the rest, and one
 * count bar whose segments filter the Tests tab.
 */
const props = defineProps<{
  testRun: TestRunDetails;
  displayProgress: {
    totalTests: number;
    passedTests: number;
    failedTests: number;
    skippedTests: number;
    /** `test.fixme()` skips — a subset of `skippedTests`. */
    fixmeTests?: number;
    didNotRunTests?: number;
    flakyTests?: number;
  } | null;
  allReports: ReportInfo[];
  totalWastedTime?: number;
  /** The active status filters, shared with the Tests tab chips and the count bar. */
  activeStatuses: string[];
  finalizing?: boolean;
}>();

const emit = defineEmits<{
  'toggle-status': [status: string];
  'label-updated': [];
}>();

const toast = useToast();
const config = useRuntimeConfig();
const { onOpenReport } = useDesktopReportLink();

const storageStats = computed(() => props.testRun?.storageStats);
const ci = computed(() => props.testRun?.metadata?.ci);
const scm = computed(() => props.testRun?.metadata?.scm);
const tags = computed(() => props.testRun?.metadata?.tags as string[] | undefined);
const customData = computed(() => props.testRun?.metadata?.customData);
const incident = computed(() => readRunIncident(props.testRun?.metadata));
// The seed of a run Playwright scheduled in random order (`--shuffle`).
const shuffleSeed = computed(() => readShuffleSeed(props.testRun?.metadata));
const { copy } = useCopy();
const incidentReview = computed(() => readIncidentReview(props.testRun?.metadata));
const incidentBadges = computed(() =>
  incident.value
    ? [{ label: 'Incident', color: 'warning' as const, title: 'An environment incident: this run is not counted' }]
    : [],
);
const customDataHtml = computed(() =>
  customData.value ? highlightCode(JSON.stringify(customData.value, null, 2), 'json').html : '',
);

// The run's commit, when it names one coverage can be read at.
const coverageCommit = computed(() => {
  const commit = scm.value?.commit;
  return typeof commit === 'string' && /^[0-9a-f]{7,64}$/i.test(commit) ? commit.toLowerCase() : null;
});
// The backends whose part of the run's server coverage is missing; empty for a run whose coverage is whole.
const coverageGaps = computed(() => readRunCoverageGaps(props.testRun?.serverCoverageGaps));

// What ingest left out or rebuilt, one sentence each; empty for a run stored whole.
const ingestNotes = computed(() => describeIngestHealth(readIngestHealth(props.testRun?.metadata)));

const showStorage = computed(() => !!(storageStats.value?.totalFiles || props.finalizing));

const passed = computed(() => props.displayProgress?.passedTests ?? props.testRun?.passedTests ?? 0);
const failed = computed(() => props.displayProgress?.failedTests ?? props.testRun?.failedTests ?? 0);
const skipped = computed(() => props.displayProgress?.skippedTests ?? props.testRun?.skippedTests ?? 0);
const fixme = computed(() => props.displayProgress?.fixmeTests ?? 0);
const total = computed(() => props.displayProgress?.totalTests ?? props.testRun?.totalTests ?? 0);
// Flaky and didn't-run track the live progress too (both are 0 on the persisted
// row until the run finishes), so the bar shows passed-on-retry and didn't-run
// segments while the run is still going instead of only at the end.
const flaky = computed(() => props.displayProgress?.flakyTests ?? props.testRun?.flakyTests ?? 0);
const didNotRun = computed(() => props.displayProgress?.didNotRunTests ?? props.testRun?.didNotRunTests ?? 0);

// The first uploaded report is the run's headline artifact.
const primaryReport = computed(() => props.allReports[0] ?? null);

const {
  mode: retryMode,
  failedCases,
  copyCommand: copyRetryCommand,
  copied: retryCopied,
  title: retryTitle,
} = useRunRetryCommand(() => props.testRun?.testCases);

// A red run leads with Copy retry command; a green run leads with its report.
const retryIsPrimary = computed(() => failedCases.value.length > 0);

const desktopBridge = ref(false);
onMounted(() => {
  desktopBridge.value = !!tauriCore();
});

// ── Label editor ──────────────────────────────────────────────────────────
const labelInput = ref('');
const editingLabel = ref(false);
const savingLabel = ref(false);
let labelCancelled = false;
const labelInputRef = ref<HTMLInputElement | null>(null);

function startEditLabel() {
  labelCancelled = false;
  labelInput.value = props.testRun?.label ?? '';
  editingLabel.value = true;
  nextTick(() => labelInputRef.value?.focus());
}

async function saveLabel() {
  if (savingLabel.value) return;
  if (labelCancelled) {
    labelCancelled = false;
    return;
  }
  const run = props.testRun;
  if (!run) return;
  savingLabel.value = true;
  try {
    await $fetch(`/api/test-runs/${run.id}`, { method: 'PATCH', body: { label: labelInput.value || null } });
    editingLabel.value = false;
    emit('label-updated');
  } catch (error: unknown) {
    const msg =
      error && typeof error === 'object' && 'data' in error
        ? (error.data as { message?: string })?.message
        : 'Failed to save label';
    toast.add({ title: 'Error', description: msg || 'Failed to save label', color: 'error' });
  } finally {
    savingLabel.value = false;
  }
}

function cancelEditLabel() {
  labelCancelled = true;
  editingLabel.value = false;
}

function onLabelKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') saveLabel();
  else if (e.key === 'Escape') cancelEditLabel();
}
</script>

<template>
  <DetailHeader
    :status="testRun?.status ?? ''"
    :title="`Run #${testRun?.id}`"
    :badges="incidentBadges"
    data-shot="run-header"
  >
    <template #badges-extra>
      <!-- The label editor sits right after the title. -->
      <template v-if="editingLabel">
        <input
          ref="labelInputRef"
          v-model="labelInput"
          type="text"
          placeholder="Add a label..."
          class="inline-block w-44 text-sm font-normal border-b border-dashed border-zinc-400 bg-transparent outline-none focus:border-primary px-0.5 py-0"
          @keydown="onLabelKeydown"
          @blur="saveLabel"
        />
        <UIcon v-if="savingLabel" name="i-lucide-loader-circle" class="size-3.5 text-zinc-400 animate-spin shrink-0" />
      </template>
      <template v-else>
        <span
          v-if="testRun?.label"
          role="button"
          tabindex="0"
          class="text-sm font-normal text-muted cursor-pointer hover:text-default border-b border-dashed border-transparent hover:border-zinc-400"
          @click="startEditLabel"
          @keydown.enter="startEditLabel"
          >{{ testRun.label }}</span
        >
        <button
          v-else
          class="text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 border-b border-dashed border-transparent hover:border-zinc-400"
          title="Add a label"
          @click="startEditLabel"
        >
          + label
        </button>
      </template>

      <UTooltip v-if="testRun?.keptAt" :text="describeKeep(testRun)">
        <span class="shrink-0 inline-flex items-center gap-1 text-xs text-muted" data-shot="run-kept">
          <UIcon name="i-lucide-lock" class="size-3.5" />
          Kept
        </span>
      </UTooltip>

      <UTooltip v-if="testRun?.precedingMarker" :text="`This run started after: ${testRun.precedingMarker.label}`">
        <NuxtLink :to="`/projects/${testRun.projectId}?tab=timeline`" class="shrink-0 inline-flex items-center gap-1">
          <span class="text-xs text-muted">After</span>
          <MarkerBadge :marker="testRun.precedingMarker" size="xs" />
        </NuxtLink>
      </UTooltip>
    </template>

    <template #primary>
      <!-- Copy retry command (with a mode picker) leads on a red run; the report
           leads on a green one. The other is a secondary button when present. -->
      <UPopover v-if="retryIsPrimary && !desktopBridge">
        <UButton
          size="xs"
          color="primary"
          variant="solid"
          :icon="retryCopied ? 'i-lucide-check' : 'i-lucide-clipboard'"
          :title="retryTitle"
          aria-label="Copy retry command"
          @click="copyRetryCommand()"
        >
          <span class="hidden sm:inline">Copy retry command</span>
        </UButton>
        <template #content>
          <div class="p-2 space-y-1 min-w-32">
            <p class="text-xs font-medium text-zinc-500 px-2 py-1">Mode</p>
            <button
              v-for="m in ['file-line', 'grep', 'file'] as RetryMode[]"
              :key="m"
              class="w-full text-left px-2 py-1 text-sm rounded hover:bg-zinc-100 dark:hover:bg-zinc-800"
              :class="retryMode === m ? 'bg-primary/10 text-primary' : ''"
              @click="retryMode = m"
            >
              {{ m === 'file-line' ? 'File:line' : m === 'grep' ? 'Title (grep)' : 'File only' }}
            </button>
          </div>
        </template>
      </UPopover>

      <DesktopRunLocallyButton
        v-if="retryIsPrimary"
        :project-id="testRun?.project?.id"
        :project-label="testRun?.project?.label ?? testRun?.project?.name"
        :cases="failedCases"
      />

      <UButton
        v-if="primaryReport"
        :href="fileApiUrl(primaryReport.path, null, config.app?.baseURL)"
        :icon="reportIcon(primaryReport.type)"
        target="_blank"
        size="xs"
        :color="retryIsPrimary ? 'neutral' : 'primary'"
        :variant="retryIsPrimary ? 'outline' : 'solid'"
        :aria-label="primaryReport.label"
        :title="
          primaryReport.size ? `${primaryReport.label} · ${formatBytes(primaryReport.size)}` : primaryReport.label
        "
        @click="onOpenReport($event, primaryReport)"
      >
        <span class="hidden sm:inline">{{ primaryReport.label }}</span>
      </UButton>
    </template>

    <template #facts>
      <ClientOnly>
        <span :title="prettyDateFormat(testRun?.startTime)">Started {{ formatRelativeTime(testRun?.startTime) }}</span>
      </ClientOnly>
      <template v-if="testRun?.duration">
        <span class="text-dimmed">·</span>
        <DurationValue :ms="testRun.duration" />
      </template>
      <template v-if="scm?.branch || scm?.commit || scm?.author">
        <span class="text-dimmed">·</span>
        <BranchLabel v-if="scm?.branch" :name="scm.branch" inherit copyable />
        <code
          v-if="scm?.commit"
          class="font-mono bg-zinc-100 dark:bg-zinc-800 px-1 py-0.5 rounded"
          :title="scm.commit"
          >{{ scm.commit.length >= 8 ? scm.commit.substring(0, 8) : scm.commit }}</code
        >
        <span v-if="scm?.author">{{ scm.author }}</span>
      </template>
      <ClientOnly>
        <RunCoverageFact
          v-if="testRun?.projectId && (coverageCommit || coverageGaps.length)"
          :project-id="testRun.projectId"
          :commit="coverageCommit"
          :gaps="coverageGaps"
        />
      </ClientOnly>
      <template v-if="testRun?.environment">
        <span class="text-dimmed">·</span>
        <EnvironmentBadge :name="testRun.environment" />
      </template>
      <template v-if="ingestNotes.length">
        <span class="text-dimmed">·</span>
        <span :title="ingestNotes.join('\n')" data-shot="run-ingest-fact">{{
          ingestNotes.length === 1 ? '1 ingest note' : `${ingestNotes.length} ingest notes`
        }}</span>
      </template>
      <template v-if="ci?.buildNumber || ci?.buildUrl">
        <span class="text-dimmed">·</span>
        <a
          v-if="safeHttpUrl(ci?.buildUrl)"
          :href="safeHttpUrl(ci?.buildUrl) ?? undefined"
          target="_blank"
          class="text-primary hover:underline"
          >{{ ci?.buildNumber ? `Build #${ci.buildNumber}` : 'View build' }}</a
        >
        <span v-else>Build #{{ ci.buildNumber }}</span>
      </template>
    </template>

    <template #details>
      <div v-if="testRun?.shardTotal && testRun.shardTotal > 1" class="flex items-center gap-1.5">
        <span class="text-muted">Shards</span>
        <span class="font-medium">{{ testRun.shardsFinished ?? 0 }}/{{ testRun.shardTotal }}</span>
        <HelpHint topic="run.partial" />
      </div>
      <div v-if="testRun?.playwrightVersion || testRun?.reporterVersion" class="flex items-center gap-1.5">
        <span class="text-muted">Versions</span>
        <span class="font-medium">
          <template v-if="testRun?.playwrightVersion">Playwright v{{ testRun.playwrightVersion }}</template>
          <template v-if="testRun?.playwrightVersion && testRun?.reporterVersion"> · </template>
          <template v-if="testRun?.reporterVersion">Piwi v{{ testRun.reporterVersion }}</template>
        </span>
      </div>
      <div v-if="shuffleSeed" class="flex items-center gap-1.5">
        <span class="text-muted inline-flex items-center gap-1">Order <HelpHint topic="run.shuffle" /></span>
        <span>Shuffled, seed</span>
        <button
          type="button"
          class="font-mono hover:underline decoration-dotted underline-offset-2 cursor-pointer"
          :title="`Copy --shuffle ${shuffleSeed}`"
          @click="copy(`--shuffle ${shuffleSeed}`, { toast: `Copied --shuffle ${shuffleSeed}` })"
        >
          {{ shuffleSeed }}
        </button>
      </div>
      <div class="flex items-center gap-x-3 gap-y-1 flex-wrap">
        <span v-if="testRun?.avgTestDuration" class="inline-flex items-center gap-1">
          <span class="text-muted">Avg</span><DurationValue :ms="testRun.avgTestDuration" class="font-medium" />
        </span>
        <span v-if="testRun?.p90TestDuration" class="inline-flex items-center gap-1">
          <span class="text-muted">P90</span><DurationValue :ms="testRun.p90TestDuration" class="font-medium" />
        </span>
        <span v-if="totalWastedTime && totalWastedTime > 0" class="inline-flex items-center gap-1">
          <span class="text-muted">Wasted</span>
          <DurationValue :ms="totalWastedTime" class="font-medium text-amber-600 dark:text-amber-400" />
        </span>
      </div>
      <div class="flex items-start gap-1.5">
        <span class="text-muted shrink-0 inline-flex items-center gap-1">Retention <HelpHint topic="run.keep" /></span>
        <span v-if="testRun?.keptAt">
          {{ describeKeep(testRun) }}
          <ClientOnly>
            <span class="text-muted" :title="prettyDateFormat(testRun.keptAt)">
              · {{ formatRelativeTime(testRun.keptAt) }}</span
            >
          </ClientOnly>
        </span>
        <span v-else>Not kept — retention deletes it once it is old enough</span>
      </div>
      <div v-if="ingestNotes.length" class="flex items-start gap-1.5" data-shot="run-ingest-health">
        <span class="text-muted shrink-0 inline-flex items-center gap-1"
          >Ingest <HelpHint topic="run.ingestHealth"
        /></span>
        <ul class="space-y-1">
          <li v-for="note in ingestNotes" :key="note">{{ note }}</li>
        </ul>
      </div>
      <div v-if="coverageGaps.length" class="flex items-start gap-1.5" data-shot="run-coverage-gaps">
        <span class="text-muted shrink-0 inline-flex items-center gap-1"
          >Coverage <HelpHint topic="run.coverageIncomplete"
        /></span>
        <ClientOnly>
          <ul class="space-y-1">
            <li v-for="gap in coverageGaps" :key="`${gap.origin}-${gap.reason}`">
              {{ coverageGapDetail(gap, prettyDateFormat) }}
            </li>
          </ul>
        </ClientOnly>
      </div>
      <div v-if="showStorage" class="flex items-center gap-1.5">
        <span class="text-muted">Storage</span>
        <RunStorageChip :storage-stats="storageStats" :reports="allReports" :finalizing="finalizing" />
      </div>
      <div v-if="tags?.length" class="flex items-start gap-1.5">
        <span class="text-muted mt-0.5">Tags</span>
        <div class="flex flex-wrap gap-1">
          <UBadge v-for="tag in tags" :key="tag" color="neutral" variant="soft" size="xs">{{ tag }}</UBadge>
        </div>
      </div>
      <div class="flex items-start gap-1.5">
        <span class="text-muted mt-0.5 inline-flex items-center gap-1">Links <HelpHint topic="run.metadata" /></span>
        <EntityLinks
          entity-type="test_run"
          :entity-id="testRun.id"
          :links="testRun.links ?? null"
          @updated="emit('label-updated')"
        />
      </div>
      <RunIncidentLine
        v-if="testRun?.id && !incident"
        variant="action"
        :run-id="testRun.id"
        :incident="null"
        :review="incidentReview"
        @changed="emit('label-updated')"
      />
      <div v-if="customData">
        <span class="text-muted">Custom data</span>
        <pre
          class="mt-1 bg-zinc-50 dark:bg-zinc-900 p-2 rounded text-xs font-mono overflow-x-auto max-h-48 overflow-y-auto"
        ><code v-html="customDataHtml" /></pre>
      </div>
    </template>

    <template v-if="incident" #below>
      <RunIncidentLine
        variant="line"
        :run-id="testRun.id"
        :incident="incident"
        :review="incidentReview"
        @changed="emit('label-updated')"
      />
    </template>

    <template #count-bar>
      <RunCountBar
        :passed="passed"
        :failed="failed"
        :flaky="flaky"
        :skipped="skipped"
        :fixme="fixme"
        :did-not-run="didNotRun"
        :total="total"
        :active-statuses="activeStatuses"
        @toggle-status="emit('toggle-status', $event)"
      />
    </template>
  </DetailHeader>
</template>
