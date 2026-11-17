<script setup lang="ts">
/**
 * Desktop shell only: links a project to its folder on this machine, the folder that holds its Playwright config (in a
 * monorepo, the config's subfolder, not the repository root). Opened by `chooseProjectFolder` (`useDesktopLinkFolder`)
 * from every **Choose folder…** of the app; mounted once in the default layout.
 *
 * It offers the folders found on this machine that hold the config and the project's tests: those its runs were
 * reported from, then the clones of its repository next to the folders already linked. A folder picked by hand is
 * checked against the tests and the repository first: one that fits is linked at once; otherwise the dialog says what
 * does not match and offers the config folders above or below it, with **Link it anyway**.
 */
import type { ApiResponse } from '~~/types/api';
import type { DesktopFolderCandidate, DesktopFolderCheck } from '~/composables/useDesktopFolderInspect';
import type { DesktopProjectLink } from '~/composables/useDesktopProjectLink';
import type { DesktopLinkFolderRequest } from '~/composables/useDesktopLinkFolder';

type FolderHints = ApiResponse<typeof import('~~/server/api/projects/[id]/folder-hints.get').default>;

const { request, open, finish } = useDesktopLinkFolder();
const toast = useToast();

const modalOpen = computed({
  get: () => open.value,
  // A folder being linked keeps the dialog open until the shell answers.
  set: (value) => {
    if (!value && !linking.value) finish(null);
  },
});

const hints = ref<FolderHints | null>(null);
const current = ref<DesktopProjectLink | null>(null);
const suggestions = ref<DesktopFolderCandidate[]>([]);
/** The check of the folder last picked by hand, shown while it does not fit. */
const check = ref<DesktopFolderCheck | null>(null);
const loading = ref(false);
const picking = ref(false);
/** The folder being linked. */
const linking = ref<string | null>(null);

const label = computed(() => request.value?.projectLabel || 'this project');
/** The spec paths a folder is checked against: the tests at hand, else the latest run's. */
const specs = computed(() => (request.value?.specs?.length ? request.value.specs : (hints.value?.specFiles ?? [])));
const repositoryUrl = computed(() => hints.value?.repositoryUrl ?? null);
const repositoryShown = computed(() => repositoryUrl.value?.replace(/^https?:\/\//, '') ?? null);

/** The folders the dialog offers: the config folders around the one picked, else those found on this machine. */
const offered = computed(() => (check.value ? check.value.alternatives : suggestions.value));

/** Counts the loads, so an answer for a request the dialog no longer shows is dropped. */
let loads = 0;

/** Whether the dialog still shows `req`: an answer that arrives once it closed or moved on is dropped. */
function stillShowing(req: DesktopLinkFolderRequest): boolean {
  return open.value && request.value === req;
}

watch(
  [open, request],
  async ([isOpen, req]) => {
    if (!isOpen || !req) return;
    const load = ++loads;
    hints.value = null;
    current.value = null;
    suggestions.value = [];
    check.value = null;
    linking.value = null;
    loading.value = true;
    try {
      const [loadedHints, link] = await Promise.all([
        $fetch<FolderHints>(`/api/projects/${req.projectId}/folder-hints`).catch(() => null),
        getDesktopProjectLink(req.projectId),
      ]);
      if (load !== loads) return;
      hints.value = loadedHints;
      current.value = link;
      const found = await suggestDesktopProjectFolders(
        loadedHints?.workingDirs ?? [],
        specs.value,
        repositoryUrl.value,
      );
      if (load !== loads) return;
      suggestions.value = found.filter((folder) => folder.path !== link?.path);
    } finally {
      if (load === loads) loading.value = false;
    }
  },
  { immediate: true },
);

async function link(path: string) {
  const req = request.value;
  if (!req || !stillShowing(req) || linking.value) return;
  linking.value = path;
  try {
    await setDesktopProjectLink(req.projectId, path);
    if (request.value === req) finish(path);
  } catch (error) {
    toast.add({ title: 'Could not link the folder', description: errorMessage(error), color: 'error' });
  } finally {
    linking.value = null;
  }
}

/** Pick a folder in the native picker, then link it when it fits, or show what does not match. */
async function browse() {
  const req = request.value;
  if (!req || loading.value || picking.value) return;
  picking.value = true;
  try {
    const path = await pickDesktopFolder({
      title: `Choose the folder of ${label.value} that holds playwright.config.ts`,
      start: current.value?.exists ? current.value.path : null,
    });
    if (!path || !stillShowing(req)) return;
    const result = await checkDesktopProjectFolder(path, specs.value, repositoryUrl.value);
    if (!stillShowing(req)) return;
    // A shell that cannot check links what was picked.
    if (!result || (result.fits && result.sameRepository !== false)) {
      await link(path);
      return;
    }
    check.value = result;
  } catch (error) {
    toast.add({ title: 'Could not open the folder picker', description: errorMessage(error), color: 'error' });
  } finally {
    picking.value = false;
  }
}

/** What the folder is checked against, in words: the tests at hand, or the latest run's. */
const testsWords = computed(() =>
  request.value?.specs?.length
    ? 'the files of these tests'
    : `the ${check.value?.specsChecked ?? 0} test files of the latest run`,
);

/** The first offered folder's **Link** is the dialog's primary action; with none, **Choose folder…** is. */
const browsePrimary = computed(() => offered.value.length === 0);
</script>

<template>
  <!-- Mounted in the layout, its layer precedes a dialog it opens from (the run dialog): it stacks above it. -->
  <UModal
    v-model:open="modalOpen"
    :title="`Link ${label} to its folder`"
    :ui="{ overlay: 'z-[60]', content: 'z-[60] max-w-2xl' }"
  >
    <template #body>
      <div class="space-y-4" data-shot="desktop-link-folder">
        <div class="space-y-1.5">
          <p class="text-sm text-highlighted leading-relaxed">
            Choose the folder that holds the Playwright config (<code class="font-mono">playwright.config.ts</code>) of
            {{ label }}. Piwi runs Playwright in that folder, so in a monorepo it is the config's subfolder, not the
            repository root.
          </p>
          <p v-if="specs.length" class="text-xs text-muted">
            The test paths of its runs start there: <code class="font-mono">{{ specs[0] }}</code> is in that folder.
          </p>
          <p v-if="current" class="text-xs text-muted">
            Linked now: <code class="font-mono break-all">{{ current.path }}</code
            ><template v-if="!current.exists"> (no longer on this machine)</template>
          </p>
        </div>

        <div
          v-if="check"
          class="rounded-md border border-default p-3 space-y-2"
          data-testid="desktop-link-folder-check"
        >
          <div class="flex items-start gap-2">
            <UIcon name="i-lucide-triangle-alert" class="size-4 mt-0.5 shrink-0 text-warning" />
            <div class="min-w-0 space-y-1">
              <p class="text-sm font-semibold text-highlighted">This folder does not match {{ label }}</p>
              <code class="block text-xs text-muted font-mono break-all">{{ check.path }}</code>
            </div>
          </div>
          <ul class="list-disc pl-10 space-y-1 text-sm text-highlighted leading-relaxed">
            <li v-if="!check.exists">It is no longer on this machine.</li>
            <li v-else-if="!check.playwrightConfig">
              It holds no Playwright config (<code class="font-mono">playwright.config.ts</code> or
              <code class="font-mono">.js</code>).
            </li>
            <li v-if="check.exists && check.specsChecked > 0 && check.specsFound === 0">
              It holds none of {{ testsWords }}, such as <code class="font-mono">{{ check.missingSpecs[0] }}</code
              >.
            </li>
            <li v-if="check.sameRepository === false">
              It is a clone of <code class="font-mono">{{ check.repository }}</code
              >, and the runs come from <code class="font-mono">{{ repositoryShown }}</code
              >.
            </li>
          </ul>
          <div class="pl-6">
            <UButton
              size="sm"
              color="neutral"
              variant="ghost"
              :loading="linking === check.path"
              :disabled="!check.exists"
              @click="link(check.path)"
            >
              Link it anyway
            </UButton>
          </div>
        </div>

        <LoadingState v-if="loading" text="Looking for the folder on this machine…" :padded="false" />

        <div v-else-if="offered.length" class="space-y-2">
          <p class="text-sm font-semibold text-highlighted">{{ check ? 'Did you mean' : 'Found on this machine' }}</p>
          <ul class="divide-y divide-default rounded-md border border-default" data-testid="desktop-link-folder-offers">
            <li
              v-for="(folder, index) in offered"
              :key="folder.path"
              class="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 p-3"
            >
              <div class="min-w-0 flex-1 space-y-0.5">
                <code class="block text-sm text-highlighted font-mono break-all">{{ folder.path }}</code>
                <p class="text-xs text-muted">
                  <template v-if="folder.source === 'run'">A run of this project came from this folder. </template>
                  <template v-else-if="folder.source === 'clone'"
                    >A clone of {{ repositoryShown ?? 'its repository' }}, next to your other linked folders.
                  </template>
                  Holds <code class="font-mono">{{ folder.playwrightConfig }}</code
                  ><template v-if="folder.specsFound > 0"> and the project's tests</template>.
                </p>
              </div>
              <UButton
                size="sm"
                :color="index === 0 ? 'primary' : 'neutral'"
                :variant="index === 0 ? 'solid' : 'outline'"
                :loading="linking === folder.path"
                :aria-label="`Link ${folder.path}`"
                @click="link(folder.path)"
              >
                Link
              </UButton>
            </li>
          </ul>
        </div>

        <p v-else-if="!check" class="text-xs text-muted">
          No folder of this project found on this machine: choose it yourself.
        </p>
      </div>
    </template>

    <template #footer>
      <div class="flex justify-end gap-2 w-full">
        <UButton color="neutral" variant="ghost" :disabled="!!linking" @click="finish(null)">Cancel</UButton>
        <UButton
          icon="i-lucide-folder-open"
          :color="browsePrimary ? 'primary' : 'neutral'"
          :variant="browsePrimary ? 'solid' : 'outline'"
          :loading="picking"
          :disabled="loading"
          @click="browse"
        >
          {{ check ? 'Choose another folder…' : 'Choose folder…' }}
        </UButton>
      </div>
    </template>
  </UModal>
</template>
