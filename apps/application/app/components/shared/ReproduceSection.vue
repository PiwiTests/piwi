<script setup lang="ts">
/**
 * The Reproduce section of More ways to fix: a copy-paste recipe that reproduces the
 * failure locally (checkout, pinned install, browser, exact test command) and,
 * when the regression window is known, a generated `git bisect` that finds the
 * breaking commit. Both are shown in Linux/macOS and Windows forms; a missing
 * bisect window degrades to a one-line muted note with the reason.
 *
 * Inside the desktop shell (and only there — everything below feature-detects
 * the Tauri bridge, never a user agent) the same section drives the recipe and
 * the bisect for real against the linked folder, in a throwaway worktree that
 * never touches the user's checkout. The webview asks the shell to act; it never
 * passes a command to run, so the shell's stored settings stay the only source
 * of truth.
 */
import { reproScript, type ReproRecipe, type BisectResult, type ReproduceDesktopContext } from '#shared/reproduce';
import type { DesktopProjectLink } from '~/composables/useDesktopProjectLink';
import type { DesktopFolderInspection } from '~/composables/useDesktopFolderInspect';

const props = defineProps<{
  reproduce: ReproRecipe;
  bisect: BisectResult;
  /** Desktop run/persist context, when the server built one. */
  context?: ReproduceDesktopContext | null;
  /** Human label for the project, for the runs tray. */
  projectLabel?: string | null;
}>();

const recipeBash = computed(() => reproScript(props.reproduce, 'bash'));
const recipePowershell = computed(() => reproScript(props.reproduce, 'powershell'));

// The one command a reader most wants — the exact test invocation — leads; the
// full checkout/install/bisect recipe folds behind a disclosure.
const runStep = computed(
  () => props.reproduce.steps.find((s) => /run the failing test/i.test(s.step)) ?? props.reproduce.steps.at(-1) ?? null,
);
const showFull = ref(false);

const toast = useToast();
const store = useDesktopLocalRuns();

// ── Desktop bridge (resolved on mount so SSR renders only the copyable recipe) ─
const projectId = computed(() => props.context?.projectId ?? null);
const desktop = ref(false);
const link = ref<DesktopProjectLink | null>(null);
const inspection = ref<DesktopFolderInspection | null>(null);
const linking = ref(false);

async function refreshLink() {
  const id = projectId.value;
  link.value = id == null ? null : await getDesktopProjectLink(id);
  inspection.value = link.value?.exists ? await inspectDesktopFolder(link.value.path) : null;
}

onMounted(async () => {
  desktop.value = !!tauriCore();
  if (desktop.value) await refreshLink();
});
watch(projectId, () => {
  if (desktop.value) void refreshLink();
});

/** The desktop actions are live once a folder is linked and still on disk. */
const linked = computed(() => desktop.value && !!link.value?.exists);

/** The failing commit a reproduction would check out. */
const commit = computed(() => props.context?.commit ?? props.reproduce.commit ?? null);
const canReproduceHere = computed(() => linked.value && !!commit.value && (props.context?.cases.length ?? 0) > 0);
const canBisectHere = computed(
  () => linked.value && props.bisect.available && !!props.context?.good && !!props.context?.bad,
);

async function linkFolder() {
  const id = projectId.value;
  const core = tauriCore();
  if (!core || id == null) return;
  linking.value = true;
  try {
    const path = await pickDesktopFolder();
    if (!path) return;
    await core.invoke('desktop_set_project_link', { projectId: String(id), path });
    await refreshLink();
  } catch (error) {
    toast.add({ title: 'Could not link the folder', description: errorMessage(error), color: 'error' });
  } finally {
    linking.value = false;
  }
}

function reproduceHere() {
  const ctx = props.context;
  if (!ctx || !commit.value) return;
  store.startReproduce({
    projectId: ctx.projectId,
    projectLabel: props.projectLabel,
    cases: ctx.cases,
    commit: commit.value,
    browserName: ctx.browserName,
    clusterId: ctx.clusterId,
  });
}

function bisectHere() {
  const ctx = props.context;
  if (!ctx || !ctx.good || !ctx.bad) return;
  store.startBisect({
    projectId: ctx.projectId,
    projectLabel: props.projectLabel,
    cases: ctx.cases,
    good: ctx.good,
    bad: ctx.bad,
    browserName: ctx.browserName,
    target: { clusterId: ctx.clusterId, repositoryUrl: ctx.repositoryUrl },
    flakeTestCaseId: ctx.flakeArm?.testCaseId ?? null,
  });
}

// ── The bisected commit: the live result of a bisect of this cluster just run,
//    else the one persisted on the cluster from a previous session. ────────────
const liveBisected = computed(() => {
  const id = projectId.value;
  if (id == null) return null;
  const found = findLiveBisect(store.runs.value, id, props.context?.clusterId ?? null);
  if (!found) return null;
  return {
    sha: found.sha,
    subject: found.subject,
    author: found.author,
    date: found.date,
    commitUrl: bisectCommitUrl(
      { clusterId: props.context?.clusterId ?? null, repositoryUrl: props.context?.repositoryUrl ?? null },
      found.sha,
    ),
  };
});
const bisectedCommit = computed(() => liveBisected.value ?? props.context?.bisectedCommit ?? null);

const { copy: copySha, copied: shaCopied } = useCopy();

// ── The app under test ────────────────────────────────────────────────────────
const baseUrl = computed(() => props.reproduce.env.find((e) => e.label === 'Base URL')?.value ?? null);
const hasWebServer = computed(() => inspection.value?.webServer ?? false);
</script>

<template>
  <div class="space-y-3" data-shot="fix-reproduce-body" data-copies="copy-recipe">
    <div class="space-y-1.5">
      <!-- The run line first — the exact test invocation. -->
      <PlatformCodeBlock
        v-if="runStep"
        :bash="runStep.bash"
        :powershell="runStep.powershell"
        storage-key="piwi-repro-shell"
      />

      <!-- The full recipe (checkout, install, pin, browser) folds behind here. -->
      <UButton
        size="xs"
        color="neutral"
        variant="link"
        class="px-0"
        :icon="showFull ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
        @click="showFull = !showFull"
      >
        {{ showFull ? 'Hide the full recipe' : 'Show the full recipe' }}
      </UButton>
      <div v-if="showFull" class="space-y-1.5">
        <p class="text-xs text-muted">
          Reproduce the failure on your machine — check out the failing commit, install the run's Playwright version and
          browser, then run exactly the failing test.
        </p>
        <PlatformCodeBlock :bash="recipeBash" :powershell="recipePowershell" storage-key="piwi-repro-shell" />
        <div v-if="reproduce.env.length" class="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
          <span v-for="e in reproduce.env" :key="e.label">
            <span class="font-medium">{{ e.label }}:</span> <span class="font-mono">{{ e.value }}</span>
          </span>
        </div>
        <p v-for="note in reproduce.notes" :key="note" class="text-xs text-dimmed">{{ note }}</p>
      </div>

      <!-- Desktop: run the recipe for real, in a throwaway worktree. -->
      <ClientOnly>
        <div v-if="desktop" class="flex flex-wrap items-center gap-2 pt-0.5">
          <UButton
            v-if="canReproduceHere"
            size="xs"
            color="primary"
            variant="solid"
            icon="i-lucide-play"
            @click="reproduceHere"
          >
            Reproduce here
          </UButton>
          <UButton
            v-else-if="desktop && !linked"
            size="xs"
            color="neutral"
            variant="soft"
            icon="i-lucide-folder-plus"
            :loading="linking"
            @click="linkFolder"
          >
            Link a folder to reproduce here
          </UButton>
          <span v-if="linked" class="text-xs text-dimmed">
            Runs in a worktree of the failing commit — your checkout is never touched.
          </span>
        </div>
      </ClientOnly>
    </div>

    <div class="space-y-1.5">
      <div class="flex items-center gap-1.5">
        <UIcon name="i-lucide-git-branch" class="size-3.5 shrink-0 text-muted" />
        <h4 class="text-xs font-medium uppercase tracking-wide text-muted">Find the breaking commit</h4>
      </div>
      <template v-if="bisect.available">
        <PlatformCodeBlock :bash="bisect.bash" :powershell="bisect.powershell" storage-key="piwi-repro-shell" />
        <p class="text-xs text-muted">{{ bisect.explanation }}</p>
        <ClientOnly>
          <div v-if="desktop && canBisectHere" class="pt-0.5 space-y-1">
            <UButton
              size="xs"
              color="primary"
              variant="soft"
              icon="i-lucide-git-branch"
              data-testid="bisect-here"
              @click="bisectHere"
            >
              Find the breaking commit here
            </UButton>
            <p v-if="context?.flakeArm" class="text-xs text-muted" data-testid="bisect-flake-arm">
              Flake-aware: each step runs the arm that reproduced this flake ({{ context.flakeArm.label }}). A step is
              bad on a failure with the same error as in CI, good after enough clean runs.
            </p>
          </div>
        </ClientOnly>
      </template>
      <p v-else class="text-xs text-dimmed">{{ bisect.reason }}</p>

      <!-- The bisected first bad commit — live, or persisted on the cluster. -->
      <ClientOnly>
        <div
          v-if="bisectedCommit"
          class="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-default bg-elevated/40 px-2 py-1.5 text-xs"
          data-shot="fix-bisected-commit"
        >
          <UIcon name="i-lucide-git-commit-horizontal" class="size-3.5 shrink-0 text-warning" />
          <span class="font-medium">Bisected to</span>
          <code class="font-mono">{{ bisectedCommit.sha.slice(0, 12) }}</code>
          <span v-if="bisectedCommit.subject" class="text-muted truncate max-w-full"
            >— {{ bisectedCommit.subject }}</span
          >
          <span v-if="bisectedCommit.author || bisectedCommit.date" class="text-dimmed">
            ({{ [bisectedCommit.author, bisectedCommit.date].filter(Boolean).join(', ') }})
          </span>
          <span class="flex-1" />
          <UButton
            size="xs"
            color="neutral"
            variant="ghost"
            :icon="shaCopied ? 'i-lucide-check' : 'i-lucide-clipboard'"
            @click="copySha(bisectedCommit.sha, { toast: 'Commit SHA copied' })"
          >
            Copy sha
          </UButton>
          <UButton
            v-if="bisectedCommit.commitUrl"
            size="xs"
            color="neutral"
            variant="ghost"
            icon="i-lucide-external-link"
            :to="bisectedCommit.commitUrl"
            target="_blank"
            rel="noopener noreferrer"
          >
            Open commit
          </UButton>
        </div>
      </ClientOnly>
    </div>

    <!-- The app under test — a same-repo bisect only means something when the app
         is built from the same checkout. Desktop shell only; the copyable recipe
         above is unchanged for everyone else. -->
    <ClientOnly v-if="desktop">
      <div v-if="linked" class="space-y-1.5">
        <p v-if="hasWebServer" class="text-xs text-dimmed">
          Playwright's <code class="font-mono">webServer</code> starts the app at each commit.
        </p>
        <p v-else class="text-xs text-dimmed">
          Your tests target <span class="font-mono">{{ baseUrl || 'the configured base URL' }}</span
          >; reproducing or bisecting this repository only exercises test-side changes.
        </p>
      </div>
      <p class="text-xs text-dimmed">
        Piwi reproduces and bisects one repository. When the app under test lives in another repo, its history is not
        part of this bisect.
      </p>
    </ClientOnly>
  </div>
</template>
