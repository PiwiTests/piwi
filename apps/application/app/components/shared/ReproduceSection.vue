<script setup lang="ts">
/**
 * The Reproduce section of More ways to fix: a copy-paste recipe that reproduces the
 * failure locally (checkout, pinned install, browser, exact test command) and,
 * when the regression window is known, a generated `git bisect` that finds the
 * breaking commit. Both are shown in Linux/macOS and Windows forms; a missing
 * bisect window degrades to a one-line muted note with the reason. Against a
 * deployed environment the bisect lists the deploys between the two runs.
 *
 * Inside the desktop shell (and only there — everything below feature-detects
 * the Tauri bridge, never a user agent) the same section drives the recipe and
 * the bisect for real against the linked folder, in a throwaway worktree that
 * never touches the user's checkout. The webview asks the shell to act; it never
 * passes a command to run, so the shell's stored settings stay the only source
 * of truth. Each of the two names the environment it runs for (`DesktopEnvironmentField`): the failing run's for a
 * reproduction, unless protected, and one built from the checkout for a bisect; a protected one waits for the person
 * to confirm it.
 */
import { reproScript, type ReproRecipe, type BisectResult, type ReproduceDesktopContext } from '#shared/reproduce';
import { deployText } from '#shared/deployed-words';
import { environmentReady, type DesktopEnvironmentChoice } from '#shared/desktop-environments';
import type { DesktopProjectLink } from '~/composables/useDesktopProjectLink';
import { buildReproduceArgs, canBisect } from '~/utils/local-run-args';
import type { DesktopFolderInspection } from '~/composables/useDesktopFolderInspect';

const props = defineProps<{
  reproduce: ReproRecipe;
  bisect: BisectResult;
  /** Desktop run/persist context, when the server built one. */
  context?: ReproduceDesktopContext | null;
  /** Human label for the project, for the runs tray. */
  projectLabel?: string | null;
}>();

const shellKey = COMMAND_SHELL_KEY;
const recipeBash = computed(() => reproScript(props.reproduce, 'bash'));
const recipePowershell = computed(() => reproScript(props.reproduce, 'powershell'));

// The one command a reader most wants — the exact test invocation — leads; the
// full checkout/install/bisect recipe folds behind a disclosure. A recipe with no
// run step leads with its notes, which say why.
const runStep = computed(() => props.reproduce.steps.find((s) => /run the failing test/i.test(s.step)) ?? null);
const showFull = ref(false);

const toast = useToast();
const store = useDesktopLocalRuns();

// ── Desktop bridge (resolved on mount so SSR renders only the copyable recipe) ─
const projectId = computed(() => props.context?.projectId ?? null);
const desktop = ref(false);
const link = ref<DesktopProjectLink | null>(null);
const inspection = ref<DesktopFolderInspection | null>(null);

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
const canReproduceHere = computed(
  () => linked.value && !!commit.value && buildReproduceArgs(props.context?.cases ?? []).length > 0,
);
const canBisectHere = computed(
  () =>
    linked.value &&
    props.bisect.available &&
    !!props.context?.good &&
    !!props.context?.bad &&
    canBisect(props.context.cases, props.context.flakeArm?.testCaseId),
);

const { chooseProjectFolder } = useDesktopLinkFolder();

/** Link the project's folder, checked against the failing tests. */
async function linkFolder() {
  const id = projectId.value;
  if (!tauriCore() || id == null) return;
  const specs = [...new Set((props.context?.cases ?? []).map((c) => c.filePath).filter(Boolean))];
  if (await chooseProjectFolder({ projectId: id, projectLabel: props.projectLabel, specs })) await refreshLink();
}

// The environment each runs for, and whether the person confirmed a protected one for the next run.
const reproduceEnvironment = ref<DesktopEnvironmentChoice | null>(null);
const reproduceConfirmed = ref(false);
const bisectEnvironment = ref<DesktopEnvironmentChoice | null>(null);
const bisectConfirmed = ref(false);

function reproduceHere() {
  const ctx = props.context;
  if (!ctx || !commit.value || !environmentReady(reproduceEnvironment.value, reproduceConfirmed.value)) return;
  store.startReproduce({
    projectId: ctx.projectId,
    projectLabel: props.projectLabel,
    cases: ctx.cases,
    commit: commit.value,
    browserName: ctx.browserName,
    clusterId: ctx.clusterId,
    environment: reproduceEnvironment.value,
    confirmed: reproduceConfirmed.value,
  });
  reproduceConfirmed.value = false;
}

function bisectHere() {
  const ctx = props.context;
  if (!ctx || !ctx.good || !ctx.bad || !environmentReady(bisectEnvironment.value, bisectConfirmed.value)) return;
  store.startBisect({
    projectId: ctx.projectId,
    projectLabel: props.projectLabel,
    cases: ctx.cases,
    good: ctx.good,
    bad: ctx.bad,
    browserName: ctx.browserName,
    target: { clusterId: ctx.clusterId, repositoryUrl: ctx.repositoryUrl },
    flakeTestCaseId: ctx.flakeArm?.testCaseId ?? null,
    environment: bisectEnvironment.value,
  });
  bisectConfirmed.value = false;
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
      <PlatformCodeBlock v-if="runStep" :bash="runStep.bash" :powershell="runStep.powershell" :storage-key="shellKey" />
      <template v-else>
        <p v-for="note in reproduce.notes" :key="note" class="text-xs text-muted">{{ note }}</p>
      </template>

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
        <PlatformCodeBlock :bash="recipeBash" :powershell="recipePowershell" :storage-key="shellKey" />
        <div v-if="reproduce.env.length" class="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
          <span v-for="e in reproduce.env" :key="e.label">
            <span class="font-medium">{{ e.label }}:</span> <span class="font-mono">{{ e.value }}</span>
          </span>
        </div>
        <template v-if="runStep">
          <p v-for="note in reproduce.notes" :key="note" class="text-xs text-dimmed">{{ note }}</p>
        </template>
      </div>

      <!-- Desktop: run the recipe for real, in a throwaway worktree. -->
      <ClientOnly>
        <DesktopEnvironmentField
          v-if="desktop && canReproduceHere"
          v-model="reproduceEnvironment"
          v-model:confirmed="reproduceConfirmed"
          :project-id="context?.projectId"
          purpose="reproduce"
          :run-environment-id="context?.environmentId ?? null"
          class="pt-0.5"
        />
        <div v-if="desktop" class="flex flex-wrap items-center gap-2 pt-0.5">
          <UButton
            v-if="canReproduceHere"
            size="xs"
            color="primary"
            variant="solid"
            icon="i-lucide-monitor"
            :disabled="!environmentReady(reproduceEnvironment, reproduceConfirmed)"
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
            @click="linkFolder"
          >
            Link a folder to reproduce here
          </UButton>
          <span v-if="canReproduceHere" class="text-xs text-dimmed">
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
        <PlatformCodeBlock :bash="bisect.bash" :powershell="bisect.powershell" :storage-key="shellKey" />
        <p class="text-xs text-muted">{{ bisect.explanation }}</p>
        <ClientOnly>
          <div v-if="desktop && canBisectHere" class="pt-0.5 space-y-1">
            <DesktopEnvironmentField
              v-model="bisectEnvironment"
              v-model:confirmed="bisectConfirmed"
              :project-id="context?.projectId"
              purpose="bisect"
            />
            <UButton
              size="xs"
              color="primary"
              variant="soft"
              icon="i-lucide-git-branch"
              data-testid="bisect-here"
              :disabled="!environmentReady(bisectEnvironment, bisectConfirmed)"
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
      <div v-if="bisect.deployed?.deploys.length" class="space-y-0.5 text-xs text-muted" data-testid="bisect-deploys">
        <p>Deploys of {{ bisect.deployed.environment }} between the two runs:</p>
        <ul class="space-y-0.5">
          <li v-if="bisect.deployed.more">Earlier deploys left out</li>
          <li v-for="deploy in bisect.deployed.deploys" :key="`${deploy.label}-${deploy.deployedAt}`">
            {{ deployText(deploy) }} · {{ formatRelativeTime(deploy.deployedAt) }}
          </li>
        </ul>
      </div>

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
