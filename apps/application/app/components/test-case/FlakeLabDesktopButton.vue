<script setup lang="ts">
/**
 * Desktop app only: Reproduce this flake. Runs a Flake Lab session on the test
 * against the project's linked folder: the shell checks out the commit of the
 * test's latest failure in a throwaway worktree and runs `piwi flake` there,
 * streaming its output into the Local runs tray. The webview passes the test
 * and the options only; the shell reads the commit and builds the command.
 *
 * Renders nothing outside the desktop app (no bridge) and in the demo. Emits
 * `finished` when a session on this test ends, so the tab reloads its
 * experiments.
 */
import type { FlakeLabOptions } from '~/composables/useDesktopLocalRuns';

const props = defineProps<{
  testCaseId: number;
  projectId: number | null;
  projectLabel?: string | null;
  /** How many suspects the profile ranks, for the arm picker. */
  suspectCount: number;
}>();
const emit = defineEmits<{ finished: [] }>();

const config = useRuntimeConfig();
const toast = useToast();
const store = useDesktopLocalRuns();

const desktop = ref(false);
const linked = ref(false);
const linking = ref(false);
const open = ref(false);

async function refreshLink() {
  const link = await getDesktopProjectLink(props.projectId);
  linked.value = !!link?.exists;
}

onMounted(async () => {
  desktop.value = !!tauriCore() && !config.public.demoMode;
  if (desktop.value) await refreshLink();
});
watch(
  () => props.projectId,
  () => {
    if (desktop.value) void refreshLink();
  },
);

async function linkFolder() {
  const core = tauriCore();
  if (!core || props.projectId == null) return;
  linking.value = true;
  try {
    const path = await pickDesktopFolder();
    if (!path) return;
    await core.invoke('desktop_set_project_link', { projectId: String(props.projectId), path });
    await refreshLink();
  } catch (error) {
    toast.add({ title: 'Could not link the folder', description: errorMessage(error), color: 'error' });
  } finally {
    linking.value = false;
  }
}

/** `each` runs every arm in turn, `all` adds every condition at once, a number one suspect. */
const arms = ref<string>('each');
const runs = ref<number | string | undefined>(undefined);
const budgetMinutes = ref<number | string | undefined>(undefined);

const armItems = computed(() => [
  { label: 'Every suspect, one at a time', value: 'each' },
  { label: 'Every suspect, then all at once', value: 'all' },
  ...Array.from({ length: props.suspectCount }, (_, i) => ({ label: `Suspect ${i + 1} only`, value: String(i + 1) })),
]);

/** A whole number within bounds, or null for the command's default. */
function bounded(value: number | string | undefined, max: number): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= max ? value : null;
}

function options(): FlakeLabOptions {
  const suspect = /^\d+$/.test(arms.value) ? Number(arms.value) : null;
  return {
    suspect,
    all: arms.value === 'all',
    runs: bounded(runs.value, 100),
    budgetMinutes: bounded(budgetMinutes.value, 240),
  };
}

function start() {
  open.value = false;
  store.startFlakeLab({
    projectId: props.projectId,
    projectLabel: props.projectLabel,
    testCaseId: props.testCaseId,
    options: options(),
  });
}

const current = computed(() =>
  store.runs.value.find((r) => r.kind === 'flake' && r.flake?.testCaseId === props.testCaseId),
);
const running = computed(() => current.value?.status === 'running');

watch(
  () => current.value?.status,
  (status, previous) => {
    if (previous === 'running' && status && status !== 'running') emit('finished');
  },
);
</script>

<template>
  <template v-if="desktop">
    <UButton
      v-if="!linked"
      size="sm"
      color="neutral"
      variant="outline"
      icon="i-lucide-folder-plus"
      :loading="linking"
      data-testid="flake-lab-link-folder"
      title="Link the project's folder on this machine to run the lab in the desktop app"
      @click="linkFolder"
    >
      Link folder to reproduce
    </UButton>
    <UPopover v-else v-model:open="open">
      <UButton
        size="sm"
        color="primary"
        variant="soft"
        icon="i-lucide-flask-conical"
        :loading="running"
        :disabled="running"
        data-testid="flake-lab-desktop"
        data-tour="flake-lab-reproduce"
      >
        {{ running ? 'Running the lab…' : 'Reproduce this flake' }}
      </UButton>
      <template #content>
        <form class="w-72 p-3 space-y-3" data-testid="flake-lab-desktop-options" @submit.prevent="start">
          <p class="text-xs text-muted leading-relaxed">
            Runs the lab at the commit of the latest failure, in a throwaway worktree of the linked folder. Your
            checkout is untouched.
          </p>
          <UFormField label="Arms" size="sm">
            <USelect v-model="arms" :items="armItems" class="w-full" data-testid="flake-lab-arms" />
          </UFormField>
          <div class="grid grid-cols-2 gap-2">
            <UFormField label="Runs per arm" size="sm">
              <UInput
                v-model.number="runs"
                type="number"
                min="1"
                max="100"
                placeholder="10"
                class="w-full"
                data-testid="flake-lab-runs"
              />
            </UFormField>
            <UFormField label="Budget (min)" size="sm">
              <UInput
                v-model.number="budgetMinutes"
                type="number"
                min="1"
                max="240"
                placeholder="15"
                class="w-full"
                data-testid="flake-lab-budget"
              />
            </UFormField>
          </div>
          <UButton type="submit" block size="sm" icon="i-lucide-play" data-testid="flake-lab-desktop-run">
            Run the lab
          </UButton>
        </form>
      </template>
    </UPopover>
  </template>
</template>
