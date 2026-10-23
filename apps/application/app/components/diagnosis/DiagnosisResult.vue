<script setup lang="ts">
import type { FailureDiagnosis } from '~~/server/database/schema';
import { formatRelativeTime } from '~/utils';
import { DIAGNOSIS_SECTION_SHORT, isKnownSectionId } from '#shared/diagnosis-sections';
import { escapeHtml } from '#shared/markdown-to-html';
import { storedPatchValidation, type PatchValidation } from '#shared/patch';
import { diagnosisAuthorLabel, isAgentDiagnosis } from '#shared/agent-diagnosis';

const props = defineProps<{
  diagnosis: FailureDiagnosis | null;
  /** The cluster's lastSeenRunId — for staleness detection */
  lastSeenRunId?: number;
  /**
   * Whether this diagnosis is still stale — computed by the parent (current
   * context hash differs from the stored one AND the cluster is still failing).
   */
  stale?: boolean;
  /** What changed to make it stale, for the banner wording. */
  staleReason?: 'occurrences' | 'evidence' | null;
  /**
   * Render a historical version: no feedback controls, no staleness banner. The
   * feedback endpoint keys on the live diagnosis id, not a version.
   */
  readOnly?: boolean;
}>();

const { copyRich, copied } = useCopyRich();
const sectionLocator = useClusterSectionLocator();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const details = computed(() => props.diagnosis?.details as any);

function formatTokens(i: number | null, o: number | null) {
  if (i == null && o == null) return '';
  return `${i ?? 0} in / ${o ?? 0} out tokens`;
}

function isRunningStale(d: FailureDiagnosis) {
  return d.status === 'running' && Date.now() - new Date(d.updatedAt).getTime() > 5 * 60 * 1000;
}

const feedbackSaving = ref(false);
const feedbackNoteSaving = ref(false);
const showNoteEditor = ref(false);
const localFeedback = ref<string | null>(null);
const localFeedbackNote = ref<string | undefined>(undefined);

const checkedSteps = reactive(new Set<number>());

watch(
  () => props.diagnosis?.id,
  () => checkedSteps.clear(),
);

watch(
  () => props.diagnosis?.feedback,
  (v) => {
    localFeedback.value = v ?? null;
  },
  { immediate: true },
);

watch(
  () => props.diagnosis?.feedbackNote,
  (v) => {
    localFeedbackNote.value = v ?? undefined;
  },
  { immediate: true },
);

async function setFeedback(value: 'up' | 'down') {
  if (!props.diagnosis) return;
  const newValue = localFeedback.value === value ? null : value;
  localFeedback.value = newValue;
  if (!newValue) showNoteEditor.value = false;
  feedbackSaving.value = true;
  try {
    await $fetch(`/api/failure-diagnoses/${props.diagnosis.id}/feedback`, {
      method: 'PATCH',
      body: { feedback: newValue, feedbackNote: localFeedbackNote.value || null },
    });
  } catch {
    localFeedback.value = props.diagnosis.feedback ?? null;
  } finally {
    feedbackSaving.value = false;
  }
}

async function saveFeedbackNote() {
  if (!props.diagnosis) return;
  feedbackNoteSaving.value = true;
  try {
    await $fetch(`/api/failure-diagnoses/${props.diagnosis.id}/feedback`, {
      method: 'PATCH',
      body: { feedback: localFeedback.value, feedbackNote: localFeedbackNote.value || null },
    });
    showNoteEditor.value = false;
  } catch {
    /* ignore */
  } finally {
    feedbackNoteSaving.value = false;
  }
}

const isStale = computed(() => {
  const d = props.diagnosis;
  if (props.readOnly || !d || d.status !== 'completed') return false;
  return props.stale === true;
});

/** Banner wording — says what changed when the parent could tell. */
const staleDescription = computed(() =>
  props.staleReason === 'occurrences'
    ? 'The cluster has failed again since this diagnosis. Re-run it to account for the new occurrences.'
    : props.staleReason === 'evidence'
      ? 'The evidence sent to the model has changed since this diagnosis. Re-run it to diagnose the current failure.'
      : 'The failure has changed since this diagnosis was made. Consider re-running it.',
);

function diagnosisMarkdown(): string {
  if (!props.diagnosis || props.diagnosis.status !== 'completed') return '';
  const d = props.diagnosis;
  const det = details.value;
  const lines: string[] = [];
  if (d.category) lines.push(`**Category:** ${d.category}`);
  if (d.confidence)
    lines.push(`**Confidence:** ${d.confidence}${det?.confidenceScore != null ? ` (${det.confidenceScore}/100)` : ''}`);
  if (det?.severity) lines.push(`**Severity:** ${det.severity}`);
  if (det?.affectedArea) lines.push(`**Affected area:** ${det.affectedArea}`);
  lines.push('');
  if (d.summary) lines.push(`${d.summary}\n`);
  if (d.rootCause) lines.push(`**Root cause:** ${d.rootCause}\n`);
  const evidence = (det?.evidence as string[]) ?? [];
  if (evidence.length) {
    lines.push('**Evidence:**');
    evidence.forEach((e) => lines.push(`- ${e}`));
    lines.push('');
  }
  const fix = det?.suggestedFix as Record<string, unknown> | undefined;
  if (fix) {
    lines.push('**Suggested fix:**');
    if (fix.description) lines.push(`${fix.description}`);
    if (fix.file) lines.push(`\`${fix.file}\``);
    if (fix.patch) lines.push(`\`\`\`diff\n${fix.patch}\n\`\`\``);
    else if (fix.code) lines.push(`\`\`\`\n${fix.code}\n\`\`\``);
    lines.push('');
  }
  const altHyps = (det?.hypotheses as Array<Record<string, unknown>> | undefined)?.slice(1) ?? [];
  if (altHyps.length) {
    lines.push('**Other hypotheses considered:**');
    altHyps.forEach((h) =>
      lines.push(`- (${h.category ?? 'unknown'}, ${h.likelihood ?? '?'}/100) ${h.rootCause ?? ''}`),
    );
    lines.push('');
  }
  const steps = (det?.investigationSteps as string[]) ?? [];
  if (steps.length) {
    lines.push('**To confirm this diagnosis:**');
    steps.forEach((s) => lines.push(`- ${s}`));
    lines.push('');
  }
  const tips = (det?.preventionTips as string[]) ?? [];
  if (tips.length) {
    lines.push('**Prevention tips:**');
    tips.forEach((t) => lines.push(`- ${t}`));
    lines.push('');
  }
  if (d.model || isAgentDiagnosis(d.provider)) lines.push(`_${diagnosisAuthorLabel(d.provider, d.model)}_`);
  return lines.join('\n');
}

function diagnosisHtml(): string {
  if (!props.diagnosis || props.diagnosis.status !== 'completed') return '';
  const d = props.diagnosis;
  const det = details.value;
  const parts: string[] = ['<dl>'];
  if (d.category) parts.push(`<dt>Category</dt><dd>${escapeHtml(d.category)}</dd>`);
  if (d.confidence)
    parts.push(
      `<dt>Confidence</dt><dd>${escapeHtml(d.confidence)}${det?.confidenceScore != null ? ` (${det.confidenceScore}/100)` : ''}</dd>`,
    );
  if (det?.severity) parts.push(`<dt>Severity</dt><dd>${escapeHtml(String(det.severity))}</dd>`);
  if (det?.affectedArea) parts.push(`<dt>Affected area</dt><dd>${escapeHtml(String(det.affectedArea))}</dd>`);
  parts.push('</dl>');
  if (d.summary) parts.push(`<p><strong>${escapeHtml(d.summary)}</strong></p>`);
  if (d.rootCause) parts.push(`<p><strong>Root cause:</strong> ${escapeHtml(d.rootCause)}</p>`);
  const evidence = (det?.evidence as string[]) ?? [];
  if (evidence.length) {
    parts.push('<p><strong>Evidence:</strong></p><ul>');
    evidence.forEach((e) => parts.push(`<li>${escapeHtml(e)}</li>`));
    parts.push('</ul>');
  }
  const fix = det?.suggestedFix as Record<string, unknown> | undefined;
  if (fix) {
    parts.push('<p><strong>Suggested fix:</strong></p>');
    if (fix.description) parts.push(`<p>${escapeHtml(String(fix.description))}</p>`);
    if (fix.file) parts.push(`<code>${escapeHtml(String(fix.file))}</code>`);
    if (fix.patch) parts.push(`<pre>${escapeHtml(String(fix.patch))}</pre>`);
    else if (fix.code) parts.push(`<pre>${escapeHtml(String(fix.code))}</pre>`);
  }
  const steps = (det?.investigationSteps as string[]) ?? [];
  if (steps.length) {
    parts.push('<p><strong>To confirm this diagnosis:</strong></p><ul>');
    steps.forEach((s) => parts.push(`<li>${escapeHtml(s)}</li>`));
    parts.push('</ul>');
  }
  const tips = (det?.preventionTips as string[]) ?? [];
  if (tips.length) {
    parts.push('<p><strong>Prevention tips:</strong></p><ul>');
    tips.forEach((t) => parts.push(`<li>${escapeHtml(t)}</li>`));
    parts.push('</ul>');
  }
  return parts.join('\n');
}

async function copyDiagnosis() {
  const md = diagnosisMarkdown();
  const html = diagnosisHtml();
  if (!md && !html) return;
  await copyRich(md, html, { toast: 'Diagnosis copied' });
}

const patchValidation = computed<PatchValidation | null>(() => storedPatchValidation(details.value));

const categoryColors: Record<string, 'error' | 'warning' | 'info' | 'secondary' | 'neutral'> = {
  'app-bug': 'error',
  'test-bug': 'warning',
  'flaky-test': 'warning',
  infrastructure: 'info',
  environment: 'secondary',
  unknown: 'neutral',
};

const confidenceColors: Record<string, 'success' | 'warning' | 'neutral'> = {
  high: 'success',
  medium: 'warning',
  low: 'neutral',
};

const severityColors: Record<string, 'error' | 'warning' | 'info' | 'neutral'> = {
  blocker: 'error',
  high: 'warning',
  medium: 'info',
  low: 'neutral',
};

const emit = defineEmits<{
  /** Request the parent to open the AI context modal focused on a section. */
  'view-section': [sectionId: string];
  /** Pre-fill the additional-context box (assisted iteration). */
  'prefill-context': [text: string];
}>();

/** Seed the additional-context box with the investigation checklist to refine. */
function prefillFromInvestigation() {
  const steps = (details.value?.investigationSteps as string[]) ?? [];
  if (!steps.length) return;
  const text = [
    'Investigation findings (fill in the results, then re-diagnose):',
    ...steps.map((s) => `- ${s}: `),
  ].join('\n');
  emit('prefill-context', text);
}

const confidenceScore = computed<number | null>(() => {
  const v = details.value?.confidenceScore;
  return typeof v === 'number' ? v : null;
});

/** A diagnosis we should visually flag as needing more evidence. */
const lowConfidence = computed(() => {
  const s = confidenceScore.value;
  if (s !== null) return s < 50;
  return props.diagnosis?.confidence === 'low' || props.diagnosis?.category === 'unknown';
});

/** Category icon for the header. */
const categoryIcons: Record<string, string> = {
  'app-bug': 'i-lucide-bug',
  'test-bug': 'i-lucide-flask-conical',
  'flaky-test': 'i-lucide-dice-5',
  infrastructure: 'i-lucide-server',
  environment: 'i-lucide-settings-2',
  unknown: 'i-lucide-circle-help',
};

/** Confidence gauge ring color (text color → stroke=currentColor). */
const gaugeColorClass = computed(() => {
  const c = props.diagnosis?.confidence;
  if (c === 'high') return 'text-emerald-500';
  if (c === 'medium') return 'text-amber-500';
  return 'text-rose-500';
});

function sectionLabel(id: string): string {
  return DIAGNOSIS_SECTION_SHORT[id] ?? id;
}

/** Split an evidence line into its prose and any `[sectionId]` citations. */
function parseEvidence(raw: string): { text: string; citations: string[] } {
  const citations: string[] = [];
  const text = raw
    .replace(/\[([a-zA-Z][a-zA-Z0-9]*)\]/g, (_m, id) => {
      if (isKnownSectionId(id)) {
        citations.push(id);
        return '';
      }
      return _m;
    })
    .replace(/\s{2,}/g, ' ')
    .trim();
  return { text, citations };
}

const evidenceParsed = computed(() => {
  const ev = details.value?.evidence as string[] | undefined;
  return Array.isArray(ev) ? ev.map(parseEvidence) : [];
});

/** Hypotheses beyond the primary one (index 0), shown as ranked alternatives. */
const alternateHypotheses = computed<Array<{ category?: string; rootCause?: string; likelihood?: number }>>(() => {
  const h = details.value?.hypotheses;
  return Array.isArray(h) ? h.slice(1) : [];
});

const showAlternates = ref(false);

/** Pipeline stages (two-stage research → diagnosis), when present. */
const pipeline = computed<
  Array<{ role: string; model: string; inputTokens?: number | null; cacheReadInputTokens?: number | null }>
>(() => {
  const p = details.value?.pipeline;
  return Array.isArray(p) ? p : [];
});

/** Tokens served from the provider prompt cache across stages (0 when unknown/none). */
const cachedTokens = computed<number>(() => pipeline.value.reduce((acc, s) => acc + (s.cacheReadInputTokens ?? 0), 0));
</script>

<template>
  <div class="space-y-3">
    <UAlert
      v-if="diagnosis && (diagnosis.status === 'failed' || isRunningStale(diagnosis))"
      color="error"
      title="Diagnosis failed"
      :description="diagnosis.error || 'Unknown error'"
    />

    <UAlert
      v-if="isStale"
      color="warning"
      icon="i-lucide-clock"
      title="Diagnosis may be stale"
      :description="staleDescription"
    />

    <div
      v-if="diagnosis && diagnosis.status === 'completed'"
      class="space-y-3 rounded-lg border border-default p-4 max-sm:p-2 bg-elevated/30"
      data-tour="diagnosis-result"
    >
      <!-- Header: confidence gauge + category/severity badges + summary -->
      <div class="flex items-start gap-3">
        <div v-if="confidenceScore !== null" class="shrink-0" :title="`Confidence ${confidenceScore}/100`">
          <div class="relative size-12">
            <svg viewBox="0 0 36 36" class="size-12 -rotate-90">
              <circle
                cx="18"
                cy="18"
                r="15.9155"
                fill="none"
                class="text-gray-200 dark:text-gray-700"
                stroke="currentColor"
                stroke-width="3"
              />
              <circle
                cx="18"
                cy="18"
                r="15.9155"
                fill="none"
                :class="gaugeColorClass"
                stroke="currentColor"
                stroke-width="3"
                stroke-linecap="round"
                :stroke-dasharray="`${confidenceScore} 100`"
              />
            </svg>
            <span class="absolute inset-0 flex items-center justify-center text-xs font-semibold">
              {{ confidenceScore }}
            </span>
          </div>
        </div>

        <div class="flex-1 min-w-0">
          <div class="flex items-start justify-between gap-2">
            <div class="flex flex-wrap items-center gap-1.5">
              <UBadge
                v-if="diagnosis.category"
                :color="categoryColors[diagnosis.category] || 'neutral'"
                variant="subtle"
                size="sm"
                :icon="categoryIcons[diagnosis.category]"
              >
                {{ diagnosis.category }}
              </UBadge>
              <UBadge
                v-if="diagnosis.confidence"
                :color="confidenceColors[diagnosis.confidence] || 'neutral'"
                variant="outline"
                size="sm"
              >
                {{ diagnosis.confidence }} confidence
              </UBadge>
              <UBadge
                v-if="details?.severity"
                :color="severityColors[details.severity] || 'neutral'"
                variant="soft"
                size="sm"
              >
                {{ details.severity }} severity
              </UBadge>
              <span v-if="details?.affectedArea" class="text-xs text-gray-500 inline-flex items-center gap-1">
                <UIcon name="i-lucide-crosshair" class="size-3 shrink-0" />
                {{ details.affectedArea }}
              </span>
            </div>
            <div class="flex items-center gap-1 shrink-0">
              <HelpHint topic="cluster.result" />
              <UButton
                :icon="copied ? 'i-lucide-check' : 'i-lucide-clipboard'"
                size="xs"
                color="neutral"
                variant="ghost"
                title="Copy full diagnosis (Markdown + HTML)"
                @click="copyDiagnosis"
              />
            </div>
          </div>
          <p v-if="diagnosis.summary" class="text-sm font-medium mt-1.5">{{ diagnosis.summary }}</p>
        </div>
      </div>

      <p v-if="diagnosis.rootCause" class="text-sm text-gray-600 dark:text-gray-400">{{ diagnosis.rootCause }}</p>

      <ul v-if="evidenceParsed.length" class="space-y-1">
        <li v-for="(e, i) in evidenceParsed" :key="i" class="text-sm text-gray-600 dark:text-gray-400 flex gap-1.5">
          <span class="text-gray-400 shrink-0 leading-5">&bull;</span>
          <span class="flex flex-wrap items-baseline gap-x-1.5 gap-y-1">
            <span>{{ e.text }}</span>
            <span v-for="c in e.citations" :key="c" class="inline-flex items-center">
              <button
                class="inline-flex items-center gap-0.5 border border-default px-1.5 text-xs text-gray-500 hover:text-primary hover:border-primary transition-colors"
                :class="sectionLocator.canLocate(c) ? 'rounded-l bg-elevated' : 'rounded bg-elevated'"
                :title="`View ${sectionLabel(c)} in the AI context`"
                @click="emit('view-section', c)"
              >
                <UIcon name="i-lucide-link" class="size-2.5" />
                {{ sectionLabel(c) }}
              </button>
              <button
                v-if="sectionLocator.canLocate(c)"
                class="inline-flex items-center rounded-r border border-l-0 border-default bg-elevated px-1 text-xs text-gray-500 hover:text-primary hover:border-primary transition-colors"
                :title="`Show ${sectionLabel(c)} on the page`"
                @click="sectionLocator.open(c)"
              >
                <UIcon name="i-lucide-map-pin" class="size-2.5" />
              </button>
            </span>
          </span>
        </li>
      </ul>

      <div v-if="details?.suggestedFix" data-tour="diagnosis-fix">
        <p class="text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Suggested fix</p>
        <p class="text-sm text-gray-600 dark:text-gray-400">{{ details.suggestedFix.description }}</p>
        <OpenInIdeLink
          v-if="details.suggestedFix.file && !details.suggestedFix.patch"
          :file-path="details.suggestedFix.file"
          class="text-xs mt-1"
        />

        <PatchBlock
          v-if="details.suggestedFix.patch"
          data-shot="diagnosis-patch"
          data-copies="copy-git-apply"
          class="mt-2 scroll-mt-4"
          :patch="details.suggestedFix.patch"
          :validation="patchValidation"
          :download-name="`piwi-diagnosis-${diagnosis?.id ?? 'fix'}`"
        />

        <div v-else-if="details.suggestedFix.code" class="mt-2">
          <CodeBlock :code="details.suggestedFix.code" />
        </div>
      </div>

      <div v-if="alternateHypotheses.length" class="space-y-1.5">
        <div class="flex items-center gap-1">
          <button
            class="flex items-center gap-1.5 text-xs font-medium text-gray-500 uppercase tracking-wide hover:text-gray-700 dark:hover:text-gray-300"
            @click="showAlternates = !showAlternates"
          >
            <UIcon :name="showAlternates ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'" class="size-3.5" />
            Other hypotheses considered ({{ alternateHypotheses.length }})
          </button>
        </div>
        <div v-if="showAlternates" class="space-y-1.5">
          <div
            v-for="(h, i) in alternateHypotheses"
            :key="i"
            class="rounded-md border border-default bg-elevated/40 px-2.5 py-1.5"
          >
            <div class="flex items-center gap-1.5">
              <UBadge v-if="h.category" :color="categoryColors[h.category] || 'neutral'" variant="subtle" size="sm">
                {{ h.category }}
              </UBadge>
              <div v-if="typeof h.likelihood === 'number'" class="flex items-center gap-1.5 flex-1 min-w-0">
                <div class="h-1.5 flex-1 max-w-24 rounded-full bg-gray-200 dark:bg-gray-700 overflow-hidden">
                  <div
                    class="h-full rounded-full bg-gray-400 dark:bg-gray-500"
                    :style="{ width: `${h.likelihood}%` }"
                  />
                </div>
                <span class="text-xs text-gray-400 shrink-0">{{ h.likelihood }}/100</span>
              </div>
            </div>
            <p v-if="h.rootCause" class="text-sm text-gray-600 dark:text-gray-400 mt-1">{{ h.rootCause }}</p>
          </div>
        </div>
      </div>

      <div
        v-if="details?.investigationSteps?.length"
        class="space-y-1.5"
        :class="
          lowConfidence
            ? 'rounded-lg border border-amber-300/60 dark:border-amber-500/30 bg-amber-50/60 dark:bg-amber-500/10 p-3'
            : ''
        "
      >
        <p
          class="text-xs font-medium uppercase tracking-wide flex items-center gap-1.5"
          :class="lowConfidence ? 'text-amber-700 dark:text-amber-400' : 'text-gray-500'"
        >
          <UIcon v-if="lowConfidence" name="i-lucide-flask-conical" class="size-3.5 shrink-0" />
          {{ lowConfidence ? 'Low confidence — gather more evidence' : 'To confirm this diagnosis' }}
        </p>
        <ul class="space-y-1">
          <li
            v-for="(s, i) in details.investigationSteps"
            :key="i"
            class="text-sm flex gap-2 items-start cursor-pointer select-none"
            :class="
              checkedSteps.has(Number(i))
                ? 'text-gray-400 dark:text-gray-500 line-through'
                : 'text-gray-600 dark:text-gray-400'
            "
            @click="checkedSteps.has(Number(i)) ? checkedSteps.delete(Number(i)) : checkedSteps.add(Number(i))"
          >
            <UIcon
              :name="checkedSteps.has(Number(i)) ? 'i-lucide-check-square' : 'i-lucide-square'"
              class="size-4 shrink-0 mt-0.5"
              :class="checkedSteps.has(Number(i)) ? 'text-primary' : 'text-gray-400'"
            />
            {{ s }}
          </li>
        </ul>
        <UButton
          v-if="lowConfidence"
          size="xs"
          color="warning"
          variant="soft"
          icon="i-lucide-clipboard-pen"
          class="mt-1"
          title="Pre-fill the additional-context box with these checks, then re-diagnose"
          @click="prefillFromInvestigation"
        >
          Add to context & refine
        </UButton>
      </div>

      <ul v-if="details?.preventionTips?.length" class="space-y-1">
        <li class="text-xs font-medium text-gray-500 uppercase tracking-wide">Prevention tips</li>
        <li
          v-for="(t, i) in details.preventionTips"
          :key="i"
          class="text-sm text-gray-600 dark:text-gray-400 flex gap-1.5"
        >
          <UIcon name="i-lucide-lightbulb" class="size-3.5 shrink-0 mt-0.5 text-yellow-500" />
          {{ t }}
        </li>
      </ul>

      <div class="flex items-start justify-between gap-3 pt-1 border-t border-default">
        <div v-if="!readOnly" class="flex items-start gap-2">
          <div class="flex items-center gap-1 shrink-0 pt-0.5">
            <UButton
              :icon="localFeedback === 'up' ? 'i-lucide-thumbs-up' : 'i-lucide-thumbs-up'"
              :color="localFeedback === 'up' ? 'success' : 'neutral'"
              variant="ghost"
              size="xs"
              :loading="feedbackSaving"
              @click="setFeedback('up')"
            />
            <UButton
              :icon="localFeedback === 'down' ? 'i-lucide-thumbs-down' : 'i-lucide-thumbs-down'"
              :color="localFeedback === 'down' ? 'error' : 'neutral'"
              variant="ghost"
              size="xs"
              :loading="feedbackSaving"
              @click="setFeedback('down')"
            />
            <button
              v-if="localFeedback"
              class="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 ml-1 transition-colors"
              @click="showNoteEditor = !showNoteEditor"
            >
              <UIcon :name="showNoteEditor ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" class="size-3" />
              {{ localFeedbackNote ? 'Edit note' : 'Note' }}
            </button>
          </div>
          <div v-if="showNoteEditor" class="flex items-start gap-1.5">
            <UTextarea
              v-model="localFeedbackNote"
              size="xs"
              placeholder="Add a note about this feedback…"
              class="max-w-64"
              :ui="{ base: 'text-xs' }"
              :rows="2"
            />
            <UButton size="xs" color="primary" variant="solid" :loading="feedbackNoteSaving" @click="saveFeedbackNote">
              Save
            </UButton>
          </div>
        </div>
        <div class="flex items-center gap-1.5 text-xs text-gray-400 shrink-0 pt-0.5">
          <UBadge
            v-if="pipeline.length > 1"
            color="neutral"
            variant="subtle"
            size="sm"
            icon="i-lucide-workflow"
            :title="pipeline.map((s) => `${s.role}: ${s.model}`).join('  →  ')"
          >
            2-stage
          </UBadge>
          <span v-if="isAgentDiagnosis(diagnosis.provider)" data-shot="diagnosis-agent-author">
            {{ diagnosisAuthorLabel(diagnosis.provider, diagnosis.model) }} ·
            {{ formatRelativeTime(diagnosis.updatedAt) }}
          </span>
          <span v-else>
            {{ diagnosis.model }} · {{ formatTokens(diagnosis.inputTokens, diagnosis.outputTokens)
            }}<template v-if="cachedTokens > 0"> ({{ cachedTokens }} cached)</template> ·
            {{ formatRelativeTime(diagnosis.updatedAt) }}
          </span>
        </div>
      </div>
    </div>

    <div
      v-if="!diagnosis"
      class="flex flex-col items-center justify-center p-8 text-center text-gray-400 border border-dashed border-default rounded-lg"
    >
      <UIcon name="i-lucide-sparkles" class="size-8 mb-2 opacity-30" />
      <p class="text-sm">Diagnosis will appear here</p>
    </div>
  </div>
</template>
