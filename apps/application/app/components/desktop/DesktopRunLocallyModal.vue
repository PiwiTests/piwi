<script setup lang="ts">
/**
 * Desktop shell only: the "run with options" dialog — first-time folder setup,
 * the full options form, the spec check and the exact command preview. The
 * form starts from the run button's options and applies to the run it starts
 * alone: neither the button nor the project's defaults (those are in the
 * project's Local folder settings) change. Running hands the plan to the
 * app-wide local runs store and closes; progress streams in the runs tray, so
 * this dialog never holds a process hostage.
 */
import type { RetryCase } from '~/utils/retry-command';
import { buildLocalRunPlan, type LocalRunOptions } from '~/utils/local-run-args';
import type { SavedLocalRunOptions } from '~/composables/useDesktopLocalRuns';

const props = defineProps<{
  /** Piwi project id owning the linked folder. */
  projectId: string | number;
  projectLabel?: string | null;
  /** The cases to run. */
  cases: RetryCase[];
  /** What the run button says it runs; the dialog's title. */
  label?: string;
  /** What the Local runs tray calls the run. */
  runTitle?: string | null;
  /** The Piwi run the cases come from, which the tray compares the run's results with. */
  sourceRunId?: number | null;
  /** The run button's options, on top of the project's defaults: where the form starts. */
  buttonOptions?: LocalRunOptions;
}>();

const open = defineModel<boolean>('open', { default: false });

const store = useDesktopLocalRuns();
const { link, busy, pickAndLink } = useDesktopProjectLink(() => props.projectId);
const { missingSpecs, wrongFolder, checkSpecs } = useDesktopSpecCheck(
  () => props.projectId,
  () => props.cases,
);
const { playwrightMissing, checkEnv } = useDesktopEnvCheck(() => props.projectId);

const linked = computed(() => !!link.value?.exists);

/** This run's options: the button's, each time the dialog opens, then whatever the form changes. */
const options = ref<SavedLocalRunOptions>({ ...DEFAULT_LOCAL_RUN_OPTIONS });
watch(
  open,
  (isOpen) => {
    if (isOpen) options.value = { ...store.getProjectOptions(props.projectId), ...props.buttonOptions };
  },
  { immediate: true },
);

watch([open, () => link.value?.path, linked], () => {
  if (!open.value) return;
  void checkSpecs(linked.value);
  void checkEnv();
});

const plan = computed(() => buildLocalRunPlan(props.cases, options.value));
const preview = computed(() => plan.value.map((s) => s.display).join('\n'));

function run() {
  store.startRun({
    projectId: props.projectId,
    projectLabel: props.projectLabel,
    cases: props.cases,
    title: props.runTitle,
    sourceRunId: props.sourceRunId,
    options: options.value,
  });
  open.value = false;
}
</script>

<template>
  <UModal v-model:open="open" :ui="{ content: 'max-w-2xl' }">
    <template #header>
      <div class="flex items-center gap-2 min-w-0">
        <UIcon name="i-lucide-monitor-play" class="size-5 text-primary shrink-0" />
        <h2 class="text-base font-semibold truncate">{{ label ?? 'Run tests locally' }}</h2>
        <UBadge color="neutral" variant="subtle" size="sm"
          >{{ cases.length }} test{{ cases.length === 1 ? '' : 's' }}</UBadge
        >
      </div>
    </template>

    <template #body>
      <div class="space-y-4">
        <div v-if="!linked" class="space-y-3">
          <p class="text-sm text-muted">
            Link {{ projectLabel || 'this project' }} to its local checkout — the folder that contains these tests. Piwi
            runs that folder's own Playwright with the app's bundled Node, so nothing else needs to be installed.
          </p>
          <UAlert
            v-if="link && !link.exists"
            color="warning"
            variant="soft"
            icon="i-lucide-folder-x"
            title="The linked folder no longer exists"
            :description="link.path"
          />
          <UButton icon="i-lucide-folder-plus" :loading="busy" @click="pickAndLink">Choose folder…</UButton>
        </div>

        <template v-else>
          <div class="flex items-center justify-between gap-3">
            <div class="flex items-center gap-2 min-w-0 text-sm">
              <UIcon name="i-lucide-folder-check" class="size-4 text-success shrink-0" />
              <code class="text-xs break-all">{{ link?.path }}</code>
            </div>
            <UButton
              size="xs"
              color="neutral"
              variant="ghost"
              icon="i-lucide-folder-search"
              :loading="busy"
              @click="pickAndLink"
            >
              Change
            </UButton>
          </div>

          <DesktopRunOptionsFields v-model="options" />
          <p class="text-xs text-muted">
            For this run only. The project's defaults are in
            <NuxtLink
              :to="`/projects/${projectId}?tab=settings&section=local-folder`"
              class="underline decoration-dotted underline-offset-2 hover:decoration-solid"
              @click="open = false"
              >its Local folder settings</NuxtLink
            >.
          </p>

          <UAlert
            v-if="playwrightMissing"
            color="warning"
            variant="soft"
            icon="i-lucide-package-x"
            title="No Playwright installation found"
          >
            <template #description>
              Neither <code class="text-xs">{{ link?.path }}</code> nor its parents hold a
              <code class="text-xs">node_modules</code> with Playwright. Run your package manager's install in the
              checkout first — the app executes that folder's own Playwright.
            </template>
          </UAlert>

          <UAlert
            v-if="missingSpecs.length > 0"
            color="warning"
            variant="soft"
            icon="i-lucide-file-question"
            :title="
              wrongFolder ? 'None of these tests are in the linked folder' : 'Some tests are not in the linked folder'
            "
          >
            <template #description>
              <p>
                Not found under <code class="text-xs">{{ link?.path }}</code
                >: <code class="text-xs">{{ missingSpecs[0] }}</code
                ><span v-if="missingSpecs.length > 1"> and {{ missingSpecs.length - 1 }} more</span>.
              </p>
              <p class="mt-1">
                <template v-if="wrongFolder">
                  This project is probably linked to a different checkout than the one these tests come from.
                </template>
                <template v-else> Running anyway is fine when your Playwright config puts them elsewhere. </template>
              </p>
              <UButton
                v-if="wrongFolder"
                size="xs"
                color="warning"
                variant="soft"
                icon="i-lucide-folder-search"
                class="mt-2"
                :loading="busy"
                @click="pickAndLink"
              >
                Choose the right folder…
              </UButton>
            </template>
          </UAlert>

          <div class="space-y-1">
            <div class="text-xs text-muted">Runs in the linked folder</div>
            <CodeBlock :code="preview" lang="sh" />
          </div>

          <p class="text-xs text-muted">
            The run streams into the Local runs tray and keeps going while you browse. Results are reported by the
            folder's own Playwright config — with the Piwi reporter set up, the new run appears in this app
            automatically.
          </p>
        </template>
      </div>
    </template>

    <template #footer>
      <div class="flex items-center justify-end w-full gap-2">
        <UButton color="neutral" variant="ghost" @click="open = false">Close</UButton>
        <UButton icon="i-lucide-play" :disabled="!linked || plan.length === 0 || busy" @click="run()">Run</UButton>
      </div>
    </template>
  </UModal>
</template>
