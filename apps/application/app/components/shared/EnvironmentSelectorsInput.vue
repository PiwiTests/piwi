<script setup lang="ts">
/**
 * The environments a filter-like setting names (a notification filter, an issue automation or test management scope):
 * a project's environments that are not archived, stored by key and shown by name, or, for a setting on every project
 * (`projectId` null), the keys of the environments of the projects the viewer reads; and typed keys, labels or `*`
 * patterns (`prod*`). A run is in the setting when one of them names its environment's key or an alias, ignoring case
 * (`runEnvironmentMatches`). The model is that list. Attributes land on the input.
 */
import type { InstanceEnvironment } from '#shared/handlers/environments';
import { withTypedValue } from '~/utils/text-format';

defineOptions({ inheritAttrs: false });

const selectors = defineModel<string[]>({ required: true });

const props = defineProps<{
  /** The project whose environments are offered; null for a setting on every project. */
  projectId: number | null;
  placeholder?: string;
}>();

const { active } = useProjectEnvironments(() => props.projectId);

const instance = ref<InstanceEnvironment[]>([]);
onMounted(async () => {
  if (props.projectId != null) return;
  try {
    instance.value = (await $fetch<{ environments: InstanceEnvironment[] }>('/api/environments')).environments;
  } catch {
    // Nothing to offer: typed keys and patterns still work.
  }
});

const sameKey = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

const items = computed(() => {
  const offered =
    props.projectId != null
      ? active.value.map((environment) => ({ label: environment.name, value: environment.key }))
      : instance.value.map((environment) => ({
          label: environment.names.length > 0 ? environment.names.join(' / ') : environment.key,
          value: environment.key,
        }));
  const typed = selectors.value
    .filter((value) => !offered.some((item) => sameKey(item.value, value)))
    .map((value) => ({ label: value, value }));
  return [...offered, ...typed];
});

function addTyped(text: string) {
  selectors.value = withTypedValue(selectors.value, text);
}
</script>

<template>
  <UInputMenu
    v-model="selectors"
    :items="items"
    value-key="value"
    multiple
    create-item
    open-on-click
    :placeholder="placeholder ?? 'Any environment'"
    v-bind="$attrs"
    @create="addTyped"
  />
</template>
