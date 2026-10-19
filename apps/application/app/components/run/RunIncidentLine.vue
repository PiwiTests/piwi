<script setup lang="ts">
import type { IncidentReview, RunIncident } from '#shared/run-incident';

/**
 * The run header's environment-incident line: why the run is not counted and
 * which rule (or person) decided, with the action to clear the flag. On a run
 * that is not flagged it renders the action to mark it, for the Details
 * popover. The actions show only to a caller who submits or controls the
 * project's runs.
 */
const props = defineProps<{
  runId: number;
  projectId: number;
  incident: RunIncident | null;
  review: IncidentReview | null;
  /** `line` under the facts on a flagged run; `action` in the Details popover of one that is not. */
  variant: 'line' | 'action';
}>();

const emit = defineEmits<{ changed: [] }>();
const toast = useToast();
const { can } = useAuth();
const saving = ref(false);
const canDecide = computed(() => can('run:submit', props.projectId) || can('run:control', props.projectId));

const RULE_TEXT: Record<string, string> = {
  'host-unreachable': 'most tests failed navigating or connecting to the app’s host',
  'browser-crash': 'most tests failed because the browser crashed or closed',
  'cross-project': 'the same host or error failed in other projects at the same time',
};

const decidedBy = computed(() => {
  const i = props.incident;
  if (!i) return '';
  if (i.decidedBy === 'person') return i.by ? `Marked by ${i.by}` : 'Marked by hand';
  return `Flagged by the ${i.rule} rule: ${RULE_TEXT[i.rule] ?? 'the run failed for its environment'}`;
});

const clearedBy = computed(() =>
  props.review?.decision === 'cleared' ? `Cleared${props.review.by ? ` by ${props.review.by}` : ''}` : null,
);

async function setIncident(incident: boolean): Promise<void> {
  if (saving.value) return;
  saving.value = true;
  try {
    await $fetch(`/api/test-runs/${props.runId}/incident`, { method: 'POST', body: { incident } });
    toast.add({
      title: incident ? 'Marked as an environment incident' : 'Incident flag cleared',
      description: incident
        ? 'Left out of flaky scores, baselines, fix verification and the gate.'
        : 'The run counts again.',
      color: 'success',
    });
    emit('changed');
  } catch (e) {
    toast.add({ title: 'Could not update the run', description: errorMessage(e), color: 'error' });
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div
    v-if="variant === 'line' && incident"
    class="flex flex-col gap-1 sm:flex-row sm:items-start sm:gap-3"
    data-shot="run-incident"
    data-tour="run-incident"
  >
    <div class="min-w-0 flex-1 space-y-0.5">
      <p class="text-sm font-semibold text-highlighted">Environment incident · not counted</p>
      <p class="text-sm text-highlighted leading-relaxed">{{ incident.reason }}</p>
      <p class="text-xs text-muted">
        {{ decidedBy }}. Left out of flaky scores, baselines, fix verification and the gate (inconclusive).
        <DocLink to="features/environment-incidents" no-icon>How incidents are recognized</DocLink>
      </p>
    </div>
    <UButton
      v-if="canDecide"
      size="xs"
      color="neutral"
      variant="outline"
      class="shrink-0 self-start"
      :loading="saving"
      title="This run's failures are real: count it again"
      @click="setIncident(false)"
    >
      Clear the flag
    </UButton>
  </div>
  <div v-else-if="variant === 'action' && !incident && (canDecide || clearedBy)" class="flex items-start gap-1.5">
    <span class="text-muted shrink-0">Incident</span>
    <div class="space-y-1">
      <p v-if="clearedBy" class="text-xs text-muted">{{ clearedBy }}: the run counts.</p>
      <UButton
        v-if="canDecide"
        size="xs"
        color="neutral"
        variant="outline"
        :loading="saving"
        title="The environment under test was down: leave this run out of every verdict"
        @click="setIncident(true)"
      >
        Mark as an environment incident
      </UButton>
    </div>
  </div>
</template>
