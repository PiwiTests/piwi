<script setup lang="ts">
/**
 * Picks the environment a setting names (a CI action, a URL pattern, a marker) among the project's environments that
 * are not archived, or none (`noneLabel`). The setting keeps the environment's id and its label as written: picking one
 * sets the label to its key. An environment the list does not hold (an archived one, or a label no environment takes)
 * stays offered while the setting names it, so editing keeps it. Attributes land on the select.
 */
defineOptions({ inheritAttrs: false });

const environmentId = defineModel<number | null>('environmentId', { required: true });
const label = defineModel<string>('label', { required: true });

const props = defineProps<{
  projectId: number | null | undefined;
  /** The choice for no environment ("Every environment"). */
  noneLabel: string;
}>();

const NONE = 'none';

const { active, byId } = useProjectEnvironments(() => props.projectId);

const items = computed(() => {
  const list = [
    { label: props.noneLabel, value: NONE },
    ...active.value.map((environment) => ({ label: environment.name, value: `id:${environment.id}` })),
  ];
  if (environmentId.value != null && !active.value.some((environment) => environment.id === environmentId.value)) {
    const own = byId(environmentId.value);
    list.push({
      label: own ? `${own.name} (archived)` : label.value || 'Another environment',
      value: `id:${environmentId.value}`,
    });
  } else if (environmentId.value == null && label.value) {
    list.push({ label: label.value, value: `label:${label.value}` });
  }
  return list;
});

const picked = computed({
  get: () => (environmentId.value != null ? `id:${environmentId.value}` : label.value ? `label:${label.value}` : NONE),
  set: (value: string) => {
    if (value === NONE) {
      environmentId.value = null;
      label.value = '';
    } else if (value.startsWith('id:')) {
      const id = Number(value.slice(3));
      label.value = byId(id)?.key ?? label.value;
      environmentId.value = id;
    }
  },
});
</script>

<template>
  <USelect v-model="picked" :items="items" aria-label="Environment" v-bind="$attrs" />
</template>
