<script setup lang="ts">
/**
 * Picks the environment a run Piwi starts is for, among the project's environments that are not archived, or **None**,
 * where Piwi sets no environment and the config decides. A protected environment is offered only to the project's
 * managers, with a lock; with `protectedRefused`, the words why a protected one cannot be picked here, it is offered to
 * no one and shows them. The model is the environment's id, or null for none. Attributes land on the select.
 */
defineOptions({ inheritAttrs: false });

const environmentId = defineModel<number | null>({ required: true });

const props = defineProps<{
  projectId: number | null | undefined;
  /** Why a protected environment cannot be picked here ("Flake Lab runs every test"); unset offers it to managers. */
  protectedRefused?: string;
}>();

const NONE = 'none';

const { active } = useProjectEnvironments(() => props.projectId);
const { can } = useAuth();

const mayRunProtected = computed(() => props.projectId != null && can('project:manage', props.projectId));

const items = computed(() => [
  { label: 'None', value: NONE, icon: 'i-lucide-circle-dashed' },
  ...active.value.map((environment) => ({
    label:
      environment.protected && props.protectedRefused
        ? `${environment.name}: ${props.protectedRefused}`
        : environment.name,
    value: String(environment.id),
    icon: environment.protected ? 'i-lucide-lock' : 'i-lucide-server',
    disabled: environment.protected && (!!props.protectedRefused || !mayRunProtected.value),
  })),
]);

const picked = computed({
  get: () => (environmentId.value == null ? NONE : String(environmentId.value)),
  set: (value: string) => {
    environmentId.value = value === NONE ? null : Number(value);
  },
});
</script>

<template>
  <USelect
    v-model="picked"
    :items="items"
    size="sm"
    icon="i-lucide-server"
    class="min-w-[180px]"
    aria-label="Environment"
    v-bind="$attrs"
  />
</template>
