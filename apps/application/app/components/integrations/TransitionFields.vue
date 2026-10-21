<script setup lang="ts">
/**
 * A sync policy's transition, checked against the project's workflow: the
 * transitions one sample issue offers (an open issue for the fix transition, a
 * done one for the reopen transition), whether the policy's setting matches one
 * of them — with the others offered as suggestions when it does not — and the
 * values for the fields the matched transition's screen asks for, such as a
 * resolution. The values are sent with every move the policy makes.
 */
import {
  joinFieldNames,
  requiredFieldsToAsk,
  settableFields,
  TRANSITION_SKIPPED_FIELDS,
  type FieldValues,
} from '#shared/integrations/fields';
import {
  matchTransition,
  transitionSettingValue,
  type TrackerTransitionOption,
  type TransitionSample,
} from '#shared/integrations/transitions';

const props = defineProps<{
  connectionId: number | null;
  projectKey: string | null;
  issueType: string | null;
  /** The state an issue is in before the move: open for the fix transition, done for the reopen one. */
  from: 'open' | 'done';
  /** The policy's setting: a transition id or a status name. */
  transition: string;
}>();

const emit = defineEmits<{ pick: [value: string] }>();

const values = defineModel<FieldValues>({ required: true });

const sample = ref<TransitionSample | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
/** Increments per request, so an older answer never overwrites a newer one. */
let generation = 0;

async function load() {
  const current = ++generation;
  if (!props.connectionId || !props.projectKey) {
    sample.value = null;
    error.value = null;
    loading.value = false;
    return;
  }
  loading.value = true;
  error.value = null;
  try {
    const params = new URLSearchParams({ from: props.from });
    if (props.issueType) params.set('issueType', props.issueType);
    const res = await $fetch<TransitionSample>(
      `/api/integrations/connections/${props.connectionId}/projects/${encodeURIComponent(props.projectKey)}/transitions?${params.toString()}`,
    );
    if (current === generation) sample.value = res;
  } catch (err) {
    if (current === generation) {
      sample.value = null;
      error.value = errorMessage(err, 'Could not read the transitions from Jira');
    }
  } finally {
    if (current === generation) loading.value = false;
  }
}

watch(
  () => [props.connectionId, props.projectKey, props.issueType, props.from],
  () => void load(),
  { immediate: true },
);

const matched = computed(() => (sample.value ? matchTransition(sample.value.transitions, props.transition) : null));
const required = computed(() =>
  matched.value ? requiredFieldsToAsk(matched.value.fields, TRANSITION_SKIPPED_FIELDS) : [],
);
/** The fields of the matched transition's screen a value can be set for. */
const settable = computed(() => (matched.value ? settableFields(matched.value.fields, TRANSITION_SKIPPED_FIELDS) : []));
/** Values kept from another transition, when this one's screen takes none: listed so they can be removed. */
const leftover = computed(() => Object.entries(values.value).map(([id, v]) => `${id} = ${v.label}`));
/** The sample issue as a reader names it: "PROJ-12 (To Do)". */
const issueLabel = computed(() => {
  const issue = sample.value?.issue;
  if (!issue) return '';
  return issue.status ? `${issue.key} (${issue.status})` : issue.key;
});
const target = computed(() => matched.value?.toStatus ?? matched.value?.name ?? '');

/** A suggestion's label: the transition's name, and where it leads when that differs. */
function suggestionLabel(t: TrackerTransitionOption): string {
  const to = t.toStatus?.trim();
  return to && to.toLowerCase() !== t.name.trim().toLowerCase() ? `${t.name} → ${to}` : t.name;
}
</script>

<template>
  <div class="space-y-2 text-xs" :data-shot="`transition-fields-${from}`">
    <CheckResultLine v-if="loading" state="pending" text="Reading the workflow's transitions from Jira…" />
    <CheckResultLine
      v-else-if="error"
      state="warning"
      :text="error"
      hint="The setting still saves; Jira then checks the transition when it runs."
    />
    <p v-else-if="sample && !sample.issue" class="text-muted">
      {{
        from === 'done'
          ? `No issue in ${projectKey} is done yet, so the transitions out of Done can't be read.`
          : `${projectKey} has no open issue yet, so its transitions can't be read.`
      }}
    </p>
    <template v-else-if="sample">
      <div v-if="!matched" class="flex flex-wrap items-center gap-1 text-muted" data-testid="transition-suggestions">
        <span v-if="transition.trim()"
          >{{ issueLabel }} has no transition to “{{ transition.trim() }}”. It offers:</span
        >
        <span v-else>{{ issueLabel }} offers:</span>
        <UButton
          v-for="t in sample.transitions"
          :key="t.id"
          type="button"
          size="xs"
          color="neutral"
          variant="soft"
          :label="suggestionLabel(t)"
          @click="emit('pick', transitionSettingValue(t))"
        />
      </div>
      <template v-else>
        <p class="text-muted" data-testid="transition-check">
          <template v-if="required.length">
            Checked on {{ issueLabel }}: moving it to {{ target }} requires
            {{ joinFieldNames(required.map((f) => f.name)) }}. The value set here is sent with every move.
          </template>
          <template v-else-if="settable.length">
            Checked on {{ issueLabel }}: moving it to {{ target }} requires no field; its screen takes optional ones.
          </template>
          <template v-else>Checked on {{ issueLabel }}: it moves to {{ target }} with no field to fill.</template>
        </p>
        <TrackerFieldDefaults
          v-if="settable.length"
          v-model="values"
          :fields="matched.fields"
          :skipped="TRANSITION_SKIPPED_FIELDS"
          screen-label="this transition's screen"
          :connection-id="connectionId"
          :project-key="projectKey"
        />
        <p v-else-if="leftover.length" class="text-muted">
          {{ leftover.join(', ') }} {{ leftover.length === 1 ? 'is' : 'are' }} set for another transition, so
          {{ leftover.length === 1 ? 'it is' : 'they are' }} not sent.
          <button type="button" :class="SENTENCE_LINK_CLASS" @click="values = {}">Remove</button>
        </p>
      </template>
    </template>
  </div>
</template>
