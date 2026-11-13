<script setup lang="ts">
/**
 * Project settings → CI → CI actions: the master switch and the
 * project's list of CI actions. Each row shows what the action targets, what it
 * accepts, its environment and the kinds it is the default for, with Edit,
 * Duplicate, Check and Remove. Edits stay in the form until the settings are
 * saved; Check reads the action as it is in the form.
 */
import { duplicateCiActionName } from '~/utils/ci-action-form';
import {
  CI_ACTION_DEFAULT_KEYS,
  CI_ACTION_KINDS,
  CI_ACTION_KIND_LABELS,
  MAX_CI_ACTIONS,
  ciActionDefaultKinds,
  ciActionTargetSummary,
  newCiActionId,
  type CiAction,
  type CiActionCheckResult,
  type CiActionKind,
  type CiActionsSettings,
} from '#shared/ci-actions';

const props = defineProps<{
  projectId: number;
  /** The instance's `PIWI_CI_SERVER_URL`, or null when it sets none. */
  instanceUrl: string | null;
  /** Whether the project holds a CI server token, and the base URL it is bound to. */
  hasToken: boolean;
  tokenUrl: string | null;
}>();
const settings = defineModel<CiActionsSettings>({ required: true });

const editorOpen = ref(false);
const editing = ref<CiAction | null>(null);

const DEFAULT_BADGES: Record<CiActionKind, string> = {
  tests: 'Default for re-runs',
  flakeLab: 'Default for Flake Lab',
  suite: 'Default for Run on CI',
};
/** The badges in the order the editor lists the defaults. */
const BADGE_KINDS: CiActionKind[] = ['tests', 'flakeLab', 'suite'];

const rows = computed(() =>
  settings.value.actions.map((action) => ({
    action,
    summary: ciActionTargetSummary(action.target),
    accepts: action.accepts.map((kind) => CI_ACTION_KIND_LABELS[kind]).join(', '),
    inputs: action.inputs.map((input) =>
      input.kind === 'fixed' ? `${input.name}=${input.value}` : `${input.name} (${input.options.join(' / ')})`,
    ),
    badges: BADGE_KINDS.filter((kind) => ciActionDefaultKinds(settings.value, action.id).includes(kind)).map(
      (kind) => DEFAULT_BADGES[kind],
    ),
  })),
);

const editingDefaults = computed(() => (editing.value ? ciActionDefaultKinds(settings.value, editing.value.id) : []));
const otherNames = computed(() => settings.value.actions.filter((a) => a.id !== editing.value?.id).map((a) => a.name));
const full = computed(() => settings.value.actions.length >= MAX_CI_ACTIONS);

function add() {
  editing.value = null;
  editorOpen.value = true;
}

function edit(action: CiAction) {
  editing.value = action;
  editorOpen.value = true;
}

function saveAction(action: CiAction, defaultFor: CiActionKind[]) {
  const existing = settings.value.actions.findIndex((a) => a.id === action.id);
  const actions = [...settings.value.actions];
  if (existing >= 0) actions[existing] = action;
  else actions.push(action);
  const defaults = { ...settings.value.defaults };
  for (const kind of CI_ACTION_KINDS) {
    const key = CI_ACTION_DEFAULT_KEYS[kind];
    if (defaultFor.includes(kind) && action.accepts.includes(kind)) defaults[key] = action.id;
    else if (defaults[key] === action.id) delete defaults[key];
  }
  settings.value = { ...settings.value, actions, defaults };
  results.value = omit(results.value, action.id);
}

function duplicate(action: CiAction) {
  if (full.value) return;
  const name = duplicateCiActionName(
    action.name,
    settings.value.actions.map((a) => a.name),
  );
  const copy: CiAction = { ...structuredClone(toRaw(action)), id: newCiActionId(), name };
  const at = settings.value.actions.findIndex((a) => a.id === action.id);
  const actions = [...settings.value.actions];
  actions.splice(at + 1, 0, copy);
  settings.value = { ...settings.value, actions };
}

function remove(action: CiAction) {
  const defaults = { ...settings.value.defaults };
  for (const key of Object.values(CI_ACTION_DEFAULT_KEYS)) if (defaults[key] === action.id) delete defaults[key];
  settings.value = {
    ...settings.value,
    actions: settings.value.actions.filter((a) => a.id !== action.id),
    defaults,
  };
  results.value = omit(results.value, action.id);
}

function omit<T>(record: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _dropped, ...rest } = record;
  return rest;
}

/** The actions whose Check is running. */
const checking = ref<Record<string, boolean>>({});
const results = ref<Record<string, CiActionCheckResult | { error: string }>>({});

async function check(action: CiAction) {
  checking.value = { ...checking.value, [action.id]: true };
  results.value = omit(results.value, action.id);
  try {
    const answer = await $fetch<CiActionCheckResult>(
      `/api/projects/${props.projectId}/ci-actions/${encodeURIComponent(action.id)}/check`,
      { method: 'POST', body: { action: toRaw(action) } },
    );
    results.value = { ...results.value, [action.id]: answer };
  } catch (e) {
    results.value = { ...results.value, [action.id]: { error: errorMessage(e, 'The check failed.') } };
  } finally {
    checking.value = omit(checking.value, action.id);
  }
}

/** How a Check answer reads: a pass, a problem, or "could not be checked" (not a pass). */
function resultOf(id: string) {
  const result = results.value[id];
  if (!result) return null;
  if ('error' in result) return { tone: 'error' as const, icon: 'i-lucide-circle-alert', message: result.error };
  if (result.ok === true) return { tone: 'ok' as const, icon: 'i-lucide-circle-check', message: result.message };
  if (result.ok === false) return { tone: 'error' as const, icon: 'i-lucide-circle-alert', message: result.message };
  return { tone: 'muted' as const, icon: 'i-lucide-circle-help', message: `Not checked: ${result.message}` };
}

const RESULT_CLASS = { ok: 'text-success', error: 'text-error', muted: 'text-muted' } as const;
</script>

<template>
  <div class="space-y-3" data-testid="ci-actions" data-shot="ci-actions">
    <USwitch v-model="settings.enabled" label="Enable CI actions" data-testid="ci-actions-enabled" />

    <div v-if="settings.enabled" class="space-y-3">
      <p v-if="rows.length === 0" class="text-sm text-muted" data-testid="ci-actions-empty">
        No CI actions yet. Add one to let Piwi start CI from the failure pages.
      </p>
      <ul v-else class="divide-y divide-default rounded-md border border-default" data-testid="ci-actions-list">
        <li
          v-for="row in rows"
          :key="row.action.id"
          class="space-y-2 p-3"
          data-testid="ci-action-row"
          :data-action-id="row.action.id"
        >
          <div class="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div class="min-w-0 space-y-1">
              <div class="flex flex-wrap items-center gap-2">
                <span class="text-sm text-highlighted" data-testid="ci-action-row-name">{{ row.action.name }}</span>
                <UBadge
                  v-for="badge in row.badges"
                  :key="badge"
                  color="neutral"
                  variant="outline"
                  size="sm"
                  :label="badge"
                />
              </div>
              <p class="break-words text-xs text-muted">
                <span class="font-mono">{{ row.summary }}</span>
                · Accepts {{ row.accepts }}
                <template v-if="row.action.environment"> · Environment {{ row.action.environment }}</template>
                <template v-if="row.inputs.length">
                  · Inputs <span class="font-mono">{{ row.inputs.join(', ') }}</span></template
                >
              </p>
            </div>
            <div class="flex shrink-0 flex-wrap gap-2">
              <UButton
                size="xs"
                color="neutral"
                variant="outline"
                data-testid="ci-action-edit"
                @click="edit(row.action)"
              >
                Edit
              </UButton>
              <UButton
                size="xs"
                color="neutral"
                variant="outline"
                :disabled="full"
                :title="full ? `A project can have at most ${MAX_CI_ACTIONS} CI actions` : undefined"
                data-testid="ci-action-duplicate"
                @click="duplicate(row.action)"
              >
                Duplicate
              </UButton>
              <UButton
                size="xs"
                color="neutral"
                variant="outline"
                :loading="checking[row.action.id] === true"
                title="Read the target, without starting it, to see whether it declares what a dispatch sends"
                data-testid="ci-action-check"
                @click="check(row.action)"
              >
                Check
              </UButton>
              <UButton
                size="xs"
                color="neutral"
                variant="outline"
                data-testid="ci-action-remove"
                @click="remove(row.action)"
              >
                Remove
              </UButton>
            </div>
          </div>
          <!-- Always rendered, so a screen reader announces the text that appears in it. -->
          <p
            :class="
              resultOf(row.action.id)
                ? ['flex items-start gap-1 text-xs', RESULT_CLASS[resultOf(row.action.id)!.tone]]
                : 'sr-only'
            "
            aria-live="polite"
            data-testid="ci-action-check-result"
            data-shot="ci-action-check-result"
            :data-result="resultOf(row.action.id)?.tone"
          >
            <UIcon
              v-if="resultOf(row.action.id)"
              :name="resultOf(row.action.id)!.icon"
              class="mt-0.5 size-3.5 shrink-0"
            />
            <span>{{ resultOf(row.action.id)?.message }}</span>
          </p>
        </li>
      </ul>
      <UButton
        color="neutral"
        variant="outline"
        size="sm"
        icon="i-lucide-plus"
        :disabled="full"
        data-testid="ci-action-add"
        @click="add"
      >
        Add a CI action
      </UButton>
      <p v-if="full" class="text-xs text-muted">A project can have at most {{ MAX_CI_ACTIONS }} CI actions.</p>
    </div>

    <CiActionEditor
      v-model:open="editorOpen"
      :action="editing"
      :default-for="editingDefaults"
      :other-names="otherNames"
      :instance-url="instanceUrl"
      :has-token="hasToken"
      :token-url="tokenUrl"
      @save="saveAction"
    />
  </div>
</template>
