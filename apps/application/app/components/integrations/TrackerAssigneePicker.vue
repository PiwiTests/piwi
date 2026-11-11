<script setup lang="ts">
/**
 * Picks one person a tracker lets the connection assign in a project, by name
 * or email, and edits their account id. A saved id shows with its name and
 * avatar, the clear button leaves the issue unassigned, and a search Jira
 * refuses says why under the picker and what to grant. Without a project to
 * search in it asks for one and calls nothing.
 */
const props = withDefaults(
  defineProps<{
    connectionId?: number | null;
    projectKey?: string | null;
    placeholder?: string;
    size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  }>(),
  { connectionId: null, projectKey: null, placeholder: 'Unassigned', size: undefined },
);

const model = defineModel<string | undefined>();
const accountId = computed({
  get: () => model.value || undefined,
  set: (id: string | null | undefined) => (model.value = id || undefined),
});

const trackerIcon = useTrackerIcon();
const { people, loading, problem, known, ready, search, searchSoon, lookUp } = useAssignableSearch(
  () => props.connectionId,
  () => props.projectKey,
);

const itemOf = (id: string) => {
  const user = known.get(id);
  return {
    label: user?.displayName || id,
    value: id,
    avatar: trackerIcon(props.connectionId, user?.icon, 'round'),
  };
};
const items = computed(() => {
  const listed = people.value.map((user) => itemOf(user.id));
  const chosen = accountId.value;
  return chosen && !listed.some((item) => item.value === chosen) ? [itemOf(chosen), ...listed] : listed;
});
const avatar = computed(() => (accountId.value ? itemOf(accountId.value).avatar : undefined));

watch(
  [accountId, () => props.connectionId, () => props.projectKey],
  () => {
    if (accountId.value) void lookUp([accountId.value]);
  },
  { immediate: true },
);
</script>

<template>
  <div class="w-full min-w-0 space-y-1">
    <USelectMenu
      v-model="accountId"
      :items="items"
      :avatar="avatar"
      value-key="value"
      :loading="loading"
      :disabled="!ready()"
      :size="size"
      ignore-filter
      :clear="{ 'aria-label': 'Clear the assignee' }"
      :placeholder="ready() ? placeholder : 'Choose the Jira project first'"
      class="w-full"
      @update:open="(isOpen: boolean) => isOpen && search()"
      @update:search-term="(words: string) => searchSoon(words)"
    />
    <CheckResultLine v-if="problem" :state="problem.state" :text="problem.text" :hint="problem.hint" />
  </div>
</template>
