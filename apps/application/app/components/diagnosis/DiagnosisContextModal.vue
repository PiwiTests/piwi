<script setup lang="ts">
import { DIAGNOSIS_SECTIONS } from '#shared/diagnosis-sections';
import type { ContextSection } from '~~/types/api';

const props = defineProps<{
  open: boolean;
  sections: ContextSection[];
  tokenEstimate: number;
  /** Portion of the estimate attributable to attached images (vision tokens). */
  imageTokenEstimate?: number;
  loading: boolean;
  /** Section id to scroll to and briefly highlight when the modal opens. */
  focusSection?: string | null;
  /** Section ids the diagnosis cited — marked in the coverage map. */
  citedSections?: string[];
  /** Sections where data is not applicable (with reason), keyed by section id. */
  notApplicableSections?: Record<string, string>;
}>();

type CoverageState = 'present' | 'truncated' | 'absent' | 'notApplicable';

const presentById = computed(() => {
  const m = new Map<string, ContextSection>();
  for (const s of props.sections) if (!m.has(s.id)) m.set(s.id, s);
  return m;
});

const notApplicableSet = computed(() => new Set(Object.keys(props.notApplicableSections ?? {})));

const citedSet = computed(() => new Set(props.citedSections ?? []));

/** Present/truncated/absent/notApplicable (+cited) state for every known section. */
const coverage = computed(() =>
  DIAGNOSIS_SECTIONS.map((meta) => {
    if (notApplicableSet.value.has(meta.id)) {
      return {
        id: meta.id,
        short: meta.short,
        label: meta.label,
        state: 'notApplicable' as CoverageState,
        cited: citedSet.value.has(meta.id),
      };
    }
    const s = presentById.value.get(meta.id);
    const state: CoverageState = !s ? 'absent' : s.truncated ? 'truncated' : 'present';
    return { id: meta.id, short: meta.short, label: meta.label, state, cited: citedSet.value.has(meta.id) };
  }),
);

const coverageCounts = computed(() => {
  const c = { present: 0, truncated: 0, absent: 0, notApplicable: 0 };
  for (const s of coverage.value) c[s.state]++;
  return c;
});

const dotClass: Record<CoverageState, string> = {
  present: 'bg-emerald-500',
  truncated: 'bg-amber-500',
  absent: 'bg-gray-300 dark:bg-gray-600',
  notApplicable: 'bg-purple-400',
};

function coverageTitle(c: { id: string; label: string; state: CoverageState; cited: boolean }): string {
  if (c.state === 'notApplicable') {
    const reason = props.notApplicableSections?.[c.id];
    return `${c.label}: not applicable${reason ? ` — ${reason}` : ''}`;
  }
  return `${c.label}: ${c.state}${c.cited ? ' · cited by the diagnosis' : ''}`;
}

const emit = defineEmits<{
  'update:open': [value: boolean];
  refresh: [];
}>();

const { copy, copied } = useCopy();

const sectionsByCategory = computed(() => {
  const categories: { label: string; items: ContextSection[] }[] = [];
  const primary = ['clusterSummary', 'sampleError', 'representativeExecution', 'executionError', 'runContext'];
  const evidence = [
    'testAnnotations',
    'testSource',
    'steps',
    'failingSteps',
    'console',
    'networkRequests',
    'serverLogs',
    'serverTraces',
    'webVitals',
    'ariaSnapshot',
  ];
  const analysis = [
    'recurrenceFlakiness',
    'baselineComparison',
    'retryProgression',
    'passedPeers',
    'browserDistribution',
    'affectedTests',
  ];
  const scm = ['suspectLines', 'scmInvestigation', 'topSuspectedCommit', 'selectedCommits'];
  const grouped = new Set([...primary, ...evidence, ...analysis, ...scm]);

  const categorize = (label: string, keep: (id: string) => boolean) => {
    const items = props.sections.filter((s) => keep(s.id));
    if (items.length > 0) categories.push({ label, items });
  };

  categorize('Primary', (id) => primary.includes(id));
  categorize('Test Evidence', (id) => evidence.includes(id));
  categorize('Analysis', (id) => analysis.includes(id));
  categorize('SCM', (id) => scm.includes(id));
  // Every other section, so the preview shows all the context holds.
  categorize('Other', (id) => !grouped.has(id));
  return categories;
});

// Scroll to and briefly highlight a section when opened via an evidence citation.
const highlightedId = ref<string | null>(null);
watch(
  () => [props.open, props.focusSection] as const,
  async ([open, focus]) => {
    if (!open || !focus) return;
    await nextTick();
    const el = document.querySelector(`[data-section-id="${focus}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    highlightedId.value = focus;
    setTimeout(() => {
      if (highlightedId.value === focus) highlightedId.value = null;
    }, 2500);
  },
);

function sectionHeading(s: ContextSection): string {
  let h = `## ${s.title}`;
  const meta: string[] = [];
  meta.push(`${s.chars} chars`);
  if (s.truncated) meta.push('truncated');
  if (s.items != null) meta.push(`${s.items} items`);
  if (meta.length) h += ` — ${meta.join(', ')}`;
  return h;
}
</script>

<template>
  <UModal
    :open="open"
    title="Context sent to AI"
    :ui="{ content: 'max-w-5xl' }"
    @update:open="(v) => emit('update:open', v)"
  >
    <template #header>
      <div class="flex items-center justify-between w-full" data-tour="diagnosis-context">
        <div class="flex items-center gap-2">
          <span class="font-semibold inline-flex items-center gap-1">
            Context sent to AI <HelpHint topic="cluster.context-preview" />
          </span>
          <span class="text-xs text-gray-400">
            ~{{ tokenEstimate }} tokens<template v-if="imageTokenEstimate">
              ({{ tokenEstimate - imageTokenEstimate }} text + {{ imageTokenEstimate }} image)</template
            >
          </span>
        </div>
        <div class="flex items-center gap-1">
          <UButton
            icon="i-lucide-refresh-cw"
            size="xs"
            color="neutral"
            variant="ghost"
            :loading="loading"
            @click="emit('refresh')"
          />
          <UButton icon="i-lucide-x" size="xs" color="neutral" variant="ghost" @click="emit('update:open', false)" />
        </div>
      </div>
    </template>

    <template #body>
      <p class="text-xs text-gray-500 dark:text-gray-400 mb-3">Copy individual sections or the full context below.</p>

      <!-- Data coverage map -->
      <div class="rounded-lg border border-default bg-elevated/30 p-3 mb-4">
        <div class="flex items-center justify-between gap-2 mb-2">
          <p class="text-xs font-medium text-gray-500 uppercase tracking-wide inline-flex items-center gap-1">
            Data coverage <HelpHint topic="cluster.coverage" />
          </p>
          <p class="text-xs text-gray-400">
            {{ coverageCounts.present }} present · {{ coverageCounts.truncated }} truncated ·
            {{ coverageCounts.absent }} absent{{
              coverageCounts.notApplicable ? ` · ${coverageCounts.notApplicable} n/a` : ''
            }}
          </p>
        </div>
        <div class="flex flex-wrap gap-1.5">
          <span
            v-for="c in coverage"
            :key="c.id"
            class="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs"
            :class="[
              c.cited ? 'border-primary text-primary' : 'border-default',
              c.state === 'absent' ? 'text-gray-400 opacity-70' : '',
              c.state === 'notApplicable' ? 'text-purple-500 border-purple-300 dark:border-purple-700' : '',
            ]"
            :title="coverageTitle(c)"
          >
            <span class="size-1.5 rounded-full shrink-0" :class="dotClass[c.state]" />
            {{ c.short }}
            <UIcon v-if="c.cited" name="i-lucide-quote" class="size-2.5 shrink-0" />
          </span>
        </div>
        <p class="text-xs text-gray-400 mt-2">
          Absent or truncated evidence lowers the diagnosis confidence.
          <UIcon name="i-lucide-quote" class="size-2.5 inline" /> marks sections the diagnosis cited.
        </p>
      </div>

      <div class="space-y-4">
        <div v-for="cat in sectionsByCategory" :key="cat.label">
          <p class="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">{{ cat.label }}</p>
          <div class="space-y-2">
            <div
              v-for="s in cat.items"
              :key="s.id"
              :data-section-id="s.id"
              class="relative rounded-lg transition-shadow"
              :class="
                highlightedId === s.id ? 'ring-2 ring-primary' : citedSet.has(s.id) ? 'ring-1 ring-primary/40' : ''
              "
            >
              <MarkdownPreview :text="sectionHeading(s) + '\n\n' + s.markdown" />
              <UButton
                :icon="copied ? 'i-lucide-check' : 'i-lucide-clipboard'"
                size="xs"
                color="neutral"
                variant="ghost"
                class="absolute top-1 right-1"
                @click="copy(s.markdown)"
              />
            </div>
          </div>
        </div>

        <div v-if="sections.length === 0 && !loading" class="text-center text-gray-400 py-8 text-sm">
          No context sections available.
        </div>
      </div>
    </template>
  </UModal>
</template>
