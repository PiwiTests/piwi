<script setup lang="ts">
/**
 * The input for one tracker field, chosen by its kind: a pick-list for the
 * values Jira lists (two levels for a cascading select), a user search, an
 * issue search for a parent or an epic, text, a number, a date, group names, or
 * a raw API value for the types Jira gives no list for (a team, a sprint). It
 * edits a {@link FieldValue} — the value as Jira's API takes it plus a label to
 * show it back — and emits null when cleared.
 */
import {
  cascadeValue,
  parseRawFieldValue,
  textToDocument,
  type FieldValue,
  type TrackerField,
} from '#shared/integrations/fields';
import type { TrackerIssueOption, TrackerUserOption } from '#shared/integrations/types';
import { withTypedValue } from '~/utils/text-format';

const props = defineProps<{
  field: TrackerField;
  /** For a user field: the connection and project to search assignable people in. */
  connectionId?: number | null;
  projectKey?: string | null;
}>();

const model = defineModel<FieldValue | null | undefined>();

function set(value: unknown, label: string) {
  model.value = value == null || label === '' ? null : { value, label };
}

const optionItems = computed(() => (props.field.options ?? []).map((o) => ({ label: o.label, value: o.id })));
const labelOf = (id: string) => props.field.options?.find((o) => o.id === id)?.label ?? id;

// ── Pick-lists ───────────────────────────────────────────────────────────────
const optionId = computed({
  get: () => ((model.value?.value as { id?: string } | null)?.id ?? undefined) as string | undefined,
  set: (id) => (id ? set({ id }, labelOf(id)) : set(null, '')),
});
const optionIds = computed({
  get: () => ((model.value?.value as Array<{ id?: string }> | null) ?? []).map((v) => v.id).filter(Boolean) as string[],
  set: (ids: string[]) =>
    ids.length
      ? set(
          ids.map((id) => ({ id })),
          ids.map(labelOf).join(', '),
        )
      : set(null, ''),
});
/** A cascading select's value is the second level when one is chosen, else the first. */
const cascadeId = computed({
  get: () => {
    const v = model.value?.value as { id?: string; child?: { id?: string } } | null | undefined;
    return v?.child?.id ?? v?.id ?? undefined;
  },
  set: (id: string | undefined) => {
    const option = id ? props.field.options?.find((o) => o.id === id) : undefined;
    return option ? set(cascadeValue(option), option.label) : set(null, '');
  },
});

// ── Text-like values: the label is what was typed ──────────────────────────────
const text = computed({
  get: () => model.value?.label ?? '',
  set: (raw: string) => {
    const value = raw ?? '';
    if (!value.trim()) return set(null, '');
    switch (props.field.kind) {
      case 'text':
        return set(textToDocument(value), value);
      case 'number': {
        const n = Number(value);
        return Number.isFinite(n) ? set(n, value) : set(null, '');
      }
      case 'datetime': {
        const at = new Date(value);
        return Number.isNaN(at.getTime()) ? set(null, '') : set(at.toISOString().replace('Z', '+0000'), value);
      }
      case 'group':
        return set({ name: value.trim() }, value.trim());
      case 'raw':
        return set(parseRawFieldValue(value), value.trim());
      default:
        return set(value, value);
    }
  },
});

/** Free-form values: plain strings, or `{ name }` for groups. */
const tags = computed({
  get: () =>
    Array.isArray(model.value?.value)
      ? (model.value!.value as unknown[]).map((v) =>
          typeof v === 'string' ? v : ((v as { name?: string }).name ?? ''),
        )
      : [],
  set: (list: string[]) => {
    if (!list.length) return set(null, '');
    const value = props.field.kind === 'group-array' ? list.map((name) => ({ name })) : list;
    return set(value, list.join(', '));
  },
});

function addTag(text: string) {
  tags.value = withTypedValue(tags.value, text);
}

// ── People, searched among the project's assignable users ─────────────────────
const people = ref<TrackerUserOption[]>([]);
const peopleItems = computed(() => {
  const items = people.value.map((u) => ({ label: u.displayName || u.id, value: u.id }));
  // Keep the chosen people listed even before a search brings them back.
  const chosen = selectedPeople.value.filter((id) => !items.some((i) => i.value === id));
  const labels = (model.value?.label ?? '').split(', ');
  return [...chosen.map((id, i) => ({ label: labels[i] || id, value: id })), ...items];
});
const selectedPeople = computed(() => {
  const v = model.value?.value;
  if (Array.isArray(v)) return v.map((u) => (u as { accountId?: string }).accountId).filter(Boolean) as string[];
  const one = (v as { accountId?: string } | null)?.accountId;
  return one ? [one] : [];
});
const personLabel = (id: string) => peopleItems.value.find((i) => i.value === id)?.label ?? id;
const person = computed({
  get: () => selectedPeople.value[0],
  set: (id: string | undefined) => (id ? set({ accountId: id }, personLabel(id)) : set(null, '')),
});
const persons = computed({
  get: () => selectedPeople.value,
  set: (ids: string[]) =>
    ids.length
      ? set(
          ids.map((id) => ({ accountId: id })),
          ids.map(personLabel).join(', '),
        )
      : set(null, ''),
});

async function searchPeople(query = '') {
  if (!props.connectionId || !props.projectKey) return;
  try {
    const params = new URLSearchParams({ project: props.projectKey, q: query });
    const res = await $fetch<{ users: TrackerUserOption[] }>(
      `/api/integrations/connections/${props.connectionId}/assignable?${params.toString()}`,
    );
    people.value = res.users;
  } catch {
    people.value = [];
  }
}

// ── Issues, searched on the tracker: a parent, an epic ────────────────────────
const issues = ref<TrackerIssueOption[]>([]);
const issuesLoading = ref(false);
/** Increments per search, so an older answer never overwrites a newer one. */
let issueSearch = 0;
const issueLabel = (issue: TrackerIssueOption) => (issue.summary ? `${issue.key} — ${issue.summary}` : issue.key);
const chosenIssueKey = computed(() => {
  const v = model.value?.value;
  return typeof v === 'string' ? v : ((v as { key?: string } | null | undefined)?.key ?? undefined);
});
const issueItems = computed(() => {
  const items = issues.value.map((i) => ({ label: issueLabel(i), value: i.key }));
  // Keep the chosen issue listed even before a search brings it back.
  const key = chosenIssueKey.value;
  if (key && !items.some((i) => i.value === key)) items.unshift({ label: model.value?.label || key, value: key });
  return items;
});
const issueKey = computed({
  get: () => chosenIssueKey.value,
  set: (typed: string | undefined) => {
    const key = typed?.trim().toUpperCase();
    if (!key) return set(null, '');
    const hit = issues.value.find((i) => i.key === key);
    return set(props.field.kind === 'issue-key' ? key : { key }, hit ? issueLabel(hit) : key);
  },
});

async function searchIssues(query = '') {
  if (!props.connectionId) return;
  const current = ++issueSearch;
  issuesLoading.value = true;
  try {
    const params = new URLSearchParams({ q: query });
    if (props.projectKey) params.set('project', props.projectKey);
    const res = await $fetch<{ issues: TrackerIssueOption[] }>(
      `/api/integrations/connections/${props.connectionId}/issue-picker?${params.toString()}`,
    );
    if (current === issueSearch) issues.value = res.issues;
  } catch {
    if (current === issueSearch) issues.value = [];
  } finally {
    if (current === issueSearch) issuesLoading.value = false;
  }
}
const searchIssuesSoon = useDebounceFn((q: string) => searchIssues(q), 250);

/** Where a raw value comes from, for the types people meet most; else the plain API value. */
const RAW_PLACEHOLDERS: Record<string, string> = {
  'atlassian-team': 'Team id, from its page URL',
  'gh-sprint': 'Sprint id (a number)',
};
const rawPlaceholder = computed(() => RAW_PLACEHOLDERS[props.field.typeName] ?? "Jira's API value");
</script>

<template>
  <USelectMenu
    v-if="field.kind === 'option'"
    v-model="optionId"
    :items="optionItems"
    value-key="value"
    placeholder="Choose a value"
    class="w-full"
  />
  <USelectMenu
    v-else-if="field.kind === 'option-array'"
    v-model="optionIds"
    :items="optionItems"
    value-key="value"
    multiple
    placeholder="Choose values"
    class="w-full"
  />
  <USelectMenu
    v-else-if="field.kind === 'option-cascade'"
    v-model="cascadeId"
    :items="optionItems"
    value-key="value"
    placeholder="Choose a value"
    class="w-full"
  />
  <USelectMenu
    v-else-if="field.kind === 'issue' || field.kind === 'issue-key'"
    v-model="issueKey"
    :items="issueItems"
    value-key="value"
    :loading="issuesLoading"
    ignore-filter
    create-item
    placeholder="Search an issue"
    class="w-full"
    @update:open="(isOpen: boolean) => isOpen && searchIssues()"
    @update:search-term="(q: string) => searchIssuesSoon(q)"
    @create="(key: string) => (issueKey = key)"
  >
    <template #create-item-label="{ item }">Use {{ item.trim().toUpperCase() }}</template>
  </USelectMenu>
  <USelectMenu
    v-else-if="field.kind === 'user'"
    v-model="person"
    :items="peopleItems"
    value-key="value"
    searchable
    placeholder="Search a person"
    class="w-full"
    @update:open="(isOpen: boolean) => isOpen && searchPeople()"
    @update:search-term="(q: string) => searchPeople(q)"
  />
  <USelectMenu
    v-else-if="field.kind === 'user-array'"
    v-model="persons"
    :items="peopleItems"
    value-key="value"
    multiple
    searchable
    placeholder="Search people"
    class="w-full"
    @update:open="(isOpen: boolean) => isOpen && searchPeople()"
    @update:search-term="(q: string) => searchPeople(q)"
  />
  <UInputMenu
    v-else-if="field.kind === 'string-array' || field.kind === 'group-array'"
    v-model="tags"
    :items="tags"
    multiple
    create-item
    :placeholder="field.kind === 'group-array' ? 'Add group names' : 'Add values'"
    class="w-full"
    @create="addTag"
  />
  <UTextarea v-else-if="field.kind === 'text'" v-model="text" :rows="2" autoresize class="w-full" />
  <UInput v-else-if="field.kind === 'number'" v-model="text" type="number" class="w-full" />
  <UInput v-else-if="field.kind === 'date'" v-model="text" type="date" class="w-full" />
  <UInput v-else-if="field.kind === 'datetime'" v-model="text" type="datetime-local" class="w-full" />
  <UInput v-else-if="field.kind === 'group'" v-model="text" placeholder="Group name" class="w-full" />
  <UInput
    v-else
    v-model="text"
    :placeholder="field.kind === 'raw' ? rawPlaceholder : ''"
    :class="field.kind === 'raw' ? 'w-full font-mono' : 'w-full'"
  />
</template>
