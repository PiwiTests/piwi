<script setup lang="ts">
/**
 * Desktop shell only: picks the environment a run the shell starts is for, among the project's environments and, when
 * its linked folder is also linked to a team project, that team project's, read from the team instance by the shell
 * (`useDesktopEnvironments`); **None** leaves it to the config. The model is the environment picked, or null.
 *
 * It starts, once its lists are read, on the environment its `purpose` starts on (`#shared/desktop-environments`):
 * the last one picked for the linked folder (`run`, `repro`, which it keeps on this machine as the person picks), the
 * run's environment unless protected (`reproduce`, `runEnvironmentId`), one built from the checkout (`bisect`), the one
 * the test's runs carry most unless protected (`flake`, `carriedEnvironmentIds`). A protected environment asks the
 * person to confirm the run naming it (`confirmed`, which the page sets back after each run), and is never offered to
 * Flake Lab. It says when the team instance cannot be reached, when the environment loads an env file the linked folder
 * lacks, and, for a bisect, what a deployed environment lets it find.
 */
import {
  builtFromCheckoutChoice,
  choiceOf,
  envFileMissing,
  mostCarriedChoice,
  runEnvironmentChoice,
  samePick,
  type DesktopEnvironmentChoice,
  type DesktopEnvironmentPurpose,
} from '#shared/desktop-environments';

const environment = defineModel<DesktopEnvironmentChoice | null>({ required: true });
const confirmed = defineModel<boolean>('confirmed', { default: false });

const props = withDefaults(
  defineProps<{
    projectId: string | number | null | undefined;
    purpose?: DesktopEnvironmentPurpose;
    /** The desktop project's environment of the run the tests come from. */
    runEnvironmentId?: number | null;
    /** The desktop project's environments of a test's runs, one per run. */
    carriedEnvironmentIds?: readonly (number | null)[];
  }>(),
  { purpose: 'run', runEnvironmentId: null, carriedEnvironmentIds: () => [] },
);

const NONE = 'none';

const { choices, projectChoices, teamChoices, teamHost, teamProblem, loaded } = useDesktopEnvironments(
  () => props.projectId,
);
const { can } = useAuth();

const folder = ref<string | null>(null);
const envFiles = ref<string[] | null>(null);
const folderRead = ref(false);

watch(
  () => props.projectId,
  async (id) => {
    folderRead.value = false;
    folder.value = null;
    envFiles.value = null;
    const link = id == null ? null : await getDesktopProjectLink(id);
    folder.value = link?.exists ? link.path : null;
    envFiles.value = folder.value ? ((await inspectDesktopFolder(folder.value))?.envFiles ?? null) : null;
    folderRead.value = true;
  },
  { immediate: true },
);

/** Whether the person may pick a protected environment of the desktop project: its managers. */
const mayRunProtected = computed(() => props.projectId != null && can('project:manage', Number(props.projectId)));

function offered(choice: DesktopEnvironmentChoice): boolean {
  if (!choice.protected) return true;
  if (props.purpose === 'flake') return false;
  return choice.team || mayRunProtected.value;
}

const valueOf = (choice: DesktopEnvironmentChoice) => `${choice.team ? 't' : 'p'}:${choice.id}`;

type Item = { label: string; value?: string; icon?: string; disabled?: boolean; type?: 'label' };

const items = computed<Item[]>(() => {
  const item = (choice: DesktopEnvironmentChoice): Item => ({
    label: choice.name,
    value: valueOf(choice),
    icon: choice.protected ? 'i-lucide-lock' : 'i-lucide-server',
    disabled: !offered(choice),
  });
  const list: Item[] = [
    { label: 'None (the config decides)', value: NONE, icon: 'i-lucide-circle-dashed' },
    ...projectChoices.value.map(item),
  ];
  if (teamChoices.value.length > 0) {
    list.push({ type: 'label', label: teamHost.value ? `On ${teamHost.value}` : 'On the team instance' });
    list.push(...teamChoices.value.map(item));
  }
  return list;
});

/** The person picked one: the start no longer applies. */
const touched = ref(false);

const picked = computed({
  get: () => (environment.value ? valueOf(environment.value) : NONE),
  set: (value: string) => {
    touched.value = true;
    const choice = value === NONE ? null : (choices.value.find((c) => valueOf(c) === value) ?? null);
    environment.value = choice;
    if ((props.purpose === 'run' || props.purpose === 'repro') && folder.value) {
      rememberDesktopEnvironmentPick(folder.value, choice);
    }
  },
});

/** Where the picker starts, once its lists and the linked folder are read. */
function start(): DesktopEnvironmentChoice | null {
  switch (props.purpose) {
    case 'reproduce':
      return runEnvironmentChoice(choices.value, props.runEnvironmentId);
    case 'bisect':
      return builtFromCheckoutChoice(choices.value);
    case 'flake':
      return mostCarriedChoice(choices.value, props.carriedEnvironmentIds);
    default: {
      const last = lastDesktopEnvironmentPick(folder.value);
      const choice = choiceOf(choices.value, last ?? null);
      return choice && offered(choice) ? choice : null;
    }
  }
}

watch(
  [loaded, folderRead],
  ([lists, read]) => {
    if (lists && read && !touched.value) environment.value = start();
  },
  { immediate: true },
);

// A list read again (the team instance answered, or not) keeps the pick only while it is still offered.
watch(choices, () => {
  const current = environment.value;
  if (current && !choices.value.some((choice) => samePick(choice, current) && offered(choice))) {
    environment.value = null;
  }
});

watch(
  () => (environment.value ? valueOf(environment.value) : NONE),
  () => {
    confirmed.value = false;
  },
);

const tags = computed(() => environment.value?.requiredTags.join(', ') ?? '');
const inWorktree = computed(() => ['reproduce', 'bisect', 'flake'].includes(props.purpose));
const missingEnvFile = computed(() => envFileMissing(environment.value, envFiles.value));
</script>

<template>
  <div class="space-y-2" data-testid="desktop-environment-field">
    <UFormField label="Environment" name="environment">
      <USelect
        v-model="picked"
        :items="items"
        :loading="!loaded"
        icon="i-lucide-server"
        class="w-full sm:w-72"
        aria-label="Environment"
        data-testid="desktop-environment-picker"
      />
    </UFormField>

    <p v-if="teamProblem" class="text-xs text-muted" data-testid="desktop-environment-team-problem">
      The environments of the team project{{ teamHost ? ` on ${teamHost}` : '' }} cannot be picked now:
      {{ teamProblem }}
    </p>

    <UAlert
      v-if="environment?.protected"
      color="warning"
      variant="soft"
      icon="i-lucide-lock"
      :title="`${environment.name} is protected`"
      data-testid="desktop-environment-protected"
    >
      <template #description>
        <p>Only the tests tagged {{ tags }} run against it.</p>
        <UCheckbox v-model="confirmed" class="mt-2" :label="`Run against ${environment.name}`" />
      </template>
    </UAlert>

    <p v-if="purpose === 'bisect'" class="text-xs text-muted">
      <template v-if="environment?.appFromCheckout">
        {{ environment.name }} is built from the checkout: each step tests the application of its commit.
      </template>
      <template v-else>
        Against a deployed environment, bisect can find a change of the tests, never of the application.
      </template>
    </p>

    <p v-if="missingEnvFile" class="text-xs text-warning" data-testid="desktop-environment-env-file">
      {{ environment?.name }} loads <code>{{ environment?.envFile }}</code
      >, which the linked folder does not hold{{ inWorktree ? ': the worktree gets none' : '' }}.
    </p>
    <p v-else-if="inWorktree && environment?.envFile && envFiles" class="text-xs text-muted">
      <code>{{ environment.envFile }}</code> is copied from the linked folder into the worktree, and goes with it.
    </p>
  </div>
</template>
