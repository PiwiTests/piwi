<script setup lang="ts">
/**
 * One scenario gap with its verbs: accept (copies the draft test), snooze,
 * covered-by, dismiss with a reason, and the button that opens its subject in
 * the Map view's graph. Under its evidence, the files behind it with the share
 * of their lines the suites ran, each opening its coverage page on the lines
 * not run. A compact row (a file's coverage page) shows the class and the title
 * only. Emits `changed` after a verdict, so the list it sits in reads again.
 */
import { GAP_CLOSE_REASON_LABELS } from '#shared/gap-classes';
import type { GapCodeFile } from '~~/server/utils/coverage-summary';
import { coverageFileLink, formatCount, formatPercent } from '~/utils/combined-coverage';
import { coveragePercent } from '#shared/coverage-combine';
import { GAP_CLASS_COLOR, gapFactorLine, type GapRowItem } from '~/utils/gap-row';
import { SENTENCE_LINK_CLASS } from '~/utils';

const props = withDefaults(
  defineProps<{
    projectId: number;
    gap: GapRowItem;
    /** Show the gap's status after its class. */
    showStatus?: boolean;
    /** The files behind the gap, with their coverage. */
    code?: GapCodeFile[];
    compact?: boolean;
  }>(),
  { showStatus: false, code: () => [], compact: false },
);
const emit = defineEmits<{ changed: []; graph: [subject: { kind: string; key: string }] }>();
const toast = useToast();

/** Run a triage verb; returns whether it succeeded so callers show one outcome. */
async function triage(body: Record<string, unknown>): Promise<boolean> {
  try {
    await $fetch(
      `/api/projects/${props.projectId}/gaps/${props.gap.id}/triage` as `/api/projects/:id/gaps/:gapId/triage`,
      { method: 'POST', body },
    );
    emit('changed');
    return true;
  } catch {
    toast.add({ title: 'Triage failed', color: 'error' });
    return false;
  }
}

async function accept() {
  // One outcome, one toast: a failed triage stops here with its own error toast,
  // so accept never reports both "Triage failed" and "draft copied".
  if (!(await triage({ verb: 'accept' }))) return;
  try {
    const draft = await $fetch<{ text: string }>(
      `/api/projects/${props.projectId}/gaps/${props.gap.id}/draft` as `/api/projects/:id/gaps/:gapId/draft`,
      { method: 'POST' },
    );
    if (draft?.text && typeof navigator !== 'undefined' && navigator.clipboard) {
      await navigator.clipboard.writeText(draft.text).catch(() => {});
      toast.add({ title: 'Accepted — draft copied to clipboard', color: 'success' });
      return;
    }
  } catch {
    // The draft is best-effort; acceptance already succeeded.
  }
  toast.add({ title: 'Gap accepted', color: 'success' });
}

// Covered-by modal state.
const coveredOpen = ref(false);
const coveredTestId = ref<string>('');
const coveredDismiss = ref(false);
const coveredError = ref<string | null>(null);

function openCovered(alsoDismiss: boolean) {
  coveredTestId.value = '';
  coveredDismiss.value = alsoDismiss;
  coveredError.value = null;
  coveredOpen.value = true;
}

async function submitCovered() {
  const raw = coveredTestId.value.trim();
  const id = Number(raw);
  // Validate before sending: an empty box is `Number('') === 0`, which would
  // otherwise submit test case id 0.
  if (raw === '' || !Number.isInteger(id) || id <= 0) {
    coveredError.value = 'Enter a positive test case id.';
    return;
  }
  const ok = await triage(
    coveredDismiss.value
      ? { verb: 'dismiss', reason: 'covered-elsewhere', coveringTestCaseId: id }
      : { verb: 'covered-by', coveringTestCaseId: id },
  );
  if (ok) coveredOpen.value = false;
}

const snoozeItems = [
  [
    { label: 'For 1 day', onSelect: () => triage({ verb: 'snooze', snooze: '1-day' }) },
    { label: 'For 1 week', onSelect: () => triage({ verb: 'snooze', snooze: '1-week' }) },
    { label: 'Until the node changes', onSelect: () => triage({ verb: 'snooze', snooze: 'until-node-changes' }) },
  ],
];

const dismissItems = [
  [
    { label: 'Not worth testing', onSelect: () => triage({ verb: 'dismiss', reason: 'not-worth-testing' }) },
    { label: 'Covered elsewhere…', onSelect: () => openCovered(true) },
    { label: 'Wrong', onSelect: () => triage({ verb: 'dismiss', reason: 'wrong' }) },
  ],
];

/** One file behind the gap: the share of its lines the suites ran, and how many they did not. */
function codeLine(file: GapCodeFile): string {
  const ran = formatPercent(coveragePercent(file.executedLines, file.executableLines));
  const unrun = file.unrunLines > 0 ? ` · ${formatCount(file.unrunLines)} not run` : '';
  return `${ran} of ${formatCount(file.executableLines)} lines ran${unrun}`;
}
</script>

<template>
  <div
    class="flex flex-col gap-2"
    :class="compact ? undefined : 'sm:flex-row sm:items-start sm:justify-between sm:gap-3'"
  >
    <div class="min-w-0">
      <div class="flex flex-wrap items-center gap-2">
        <UBadge :color="(GAP_CLASS_COLOR[gap.class] as any) ?? 'neutral'" variant="subtle" size="sm">{{
          gap.class
        }}</UBadge>
        <span v-if="gap.kind === 'finding'" class="text-xs text-muted">finding</span>
        <span v-if="showStatus && gap.status" class="text-xs text-muted"
          >{{ gap.status
          }}<template v-if="gap.closeReason">: {{ GAP_CLOSE_REASON_LABELS[gap.closeReason] }}</template></span
        >
        <span class="text-xs text-muted font-mono">{{ gap.detector }}</span>
      </div>
      <p class="mt-1 text-sm text-highlighted leading-relaxed break-words">{{ gap.title }}</p>
      <template v-if="!compact">
        <ul class="mt-1 space-y-0.5">
          <li v-for="(line, i) in gap.evidence ?? []" :key="i" class="text-xs text-muted">{{ line }}</li>
        </ul>
        <ul v-if="code.length > 0" class="mt-1 space-y-0.5" data-gap-code>
          <li v-for="file in code" :key="file.path" class="text-xs text-muted break-words" :data-gap-file="file.path">
            <NuxtLink
              :to="coverageFileLink(projectId, {}, file.path)"
              class="font-mono"
              :class="SENTENCE_LINK_CLASS"
              :title="`Open the coverage of ${file.path}`"
              >{{ file.path }}</NuxtLink
            >: {{ codeLine(file) }}
          </li>
        </ul>
        <p class="mt-1 text-xs text-muted">
          Score {{ (gap.score ?? 0).toFixed(3) }}<span v-if="gap.factors"> · {{ gapFactorLine(gap) }}</span>
        </p>
      </template>
    </div>
    <div class="flex flex-wrap items-center gap-1" :class="compact ? undefined : 'sm:shrink-0'">
      <UButton size="xs" color="primary" label="Accept" @click="accept" />
      <UDropdownMenu :items="snoozeItems">
        <UButton size="xs" color="neutral" variant="ghost" label="Snooze" trailing-icon="i-lucide-chevron-down" />
      </UDropdownMenu>
      <UButton size="xs" color="neutral" variant="ghost" label="Covered by" @click="openCovered(false)" />
      <UDropdownMenu :items="dismissItems">
        <UButton size="xs" color="neutral" variant="ghost" label="Dismiss" trailing-icon="i-lucide-chevron-down" />
      </UDropdownMenu>
      <UButton
        v-if="gap.subject"
        size="xs"
        color="neutral"
        variant="ghost"
        icon="i-lucide-radar"
        :title="`View ${gap.subject.kind}:${gap.subject.key} in the graph`"
        @click="emit('graph', gap.subject)"
      />
    </div>

    <UModal v-model:open="coveredOpen" :title="coveredDismiss ? 'Covered elsewhere' : 'Covered by a test'">
      <template #body>
        <div class="space-y-3">
          <p class="text-sm text-highlighted">
            <template v-if="coveredDismiss">
              Enter the test case id of the test that already covered this: no test was missing.
            </template>
            <template v-else>Enter the test case id of the test written for this gap.</template>
            A manual reaches edge is written so the gap closes on the next recompute<span v-if="coveredDismiss">
              and the gap is dismissed</span
            >.
          </p>
          <UFormField label="Covering test case id" :error="coveredError ?? undefined">
            <UInput v-model="coveredTestId" type="number" placeholder="test case id" class="w-full" />
          </UFormField>
          <div class="flex justify-end gap-2">
            <UButton color="neutral" variant="ghost" label="Cancel" @click="coveredOpen = false" />
            <UButton color="primary" label="Save" @click="submitCovered" />
          </div>
        </div>
      </template>
    </UModal>
  </div>
</template>
