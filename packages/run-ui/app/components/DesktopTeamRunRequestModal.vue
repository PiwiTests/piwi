<script setup lang="ts">
/**
 * Desktop shell only: a run request from the team instance this app is connected to, which the app claimed. It shows
 * the instance that asked, the project (by the name the instance gives it, else its id), the tests, the checks of the
 * folder linked to the request's project on this machine, and the exact
 * command. Nothing runs before **Run**; **Not now** declines it, or refuses it with the checks that failed. The shell
 * takes the command and the request token from this app's server, never from this window. **Run**, **Not now** and
 * closing the dialog answer the request shown, and only once it has been shown, unchanged, in the visible and focused
 * window for `ARM_AFTER_MS`, so a click or a key that brings the window to the front, or lands as another request takes
 * the place of the one shown, answers nothing. Once the shell is told to run a request, the modal emits `start`: the
 * host decides what shows the run.
 *
 * While the request has no folder it can run in (none linked, one that is not the project's, or an older copy without
 * all the tests), the dialog says in plain words which folder that is, and offers **Find it for me**, which asks the
 * shell to look for it on this machine and lists what it found, and **Choose the folder…**, the shell's own picker. A
 * found folder is named by its search and its place in the shell's list, never by its path, and the shell asks the
 * person in a native dialog before linking it.
 */
import type { RunRequestPromptView } from '@piwitests/editor/run-target-view';

const emit = defineEmits<{
  start: [
    run: {
      requestId: string;
      instance: string;
      projectId: number;
      projectName: string | null;
      cases: RunRequestPromptView['tests'];
      title: string;
    },
  ];
}>();

const { current, add, remove } = useDesktopTeamRequests();
const toast = useToast();
const starting = ref(false);

/** A folder the shell found for the request's project (`desktop_find_request_folders`). */
interface FoundFolder {
  path: string;
  playwrightConfig: string;
  specsFound: number;
}
/** What `desktop_find_request_folders` answers: its search's number, which the link takes back. */
interface FolderSearch {
  search: number;
  folders: FoundFolder[];
  /** Every place was searched whole. */
  complete: boolean;
}
/** The request whose folder the shell is looking for, and the one whose folder it is linking. */
const findingFor = ref<string | null>(null);
const linkingFor = ref<string | null>(null);
/** What **Find it for me** found, for the request it looked for; null before it looked. */
const found = ref<({ requestId: string } & FolderSearch) | null>(null);
/** The place of the found folder being linked. */
const linkingFound = ref<number | null>(null);

/** How long a request is shown, unchanged, in the visible and focused window before it can be answered. */
const ARM_AFTER_MS = 1000;
const armed = ref(false);
/** Whether the window is in front: counted from mount, so the arm never runs in the server render. */
const inFront = ref(false);
const readFront = () => (inFront.value = document.visibilityState === 'visible' && document.hasFocus());
let armTimer: ReturnType<typeof setTimeout> | null = null;
const shown = computed(() =>
  current.value && inFront.value ? `${current.value.id}\n${current.value.command}\n${current.value.runnable}` : null,
);
watch(
  shown,
  (value) => {
    armed.value = false;
    if (armTimer) clearTimeout(armTimer);
    armTimer = value ? setTimeout(() => (armed.value = true), ARM_AFTER_MS) : null;
  },
  { immediate: true },
);
onMounted(() => {
  readFront();
  window.addEventListener('focus', readFront);
  window.addEventListener('blur', readFront);
  document.addEventListener('visibilitychange', readFront);
});
onBeforeUnmount(() => {
  if (armTimer) clearTimeout(armTimer);
  window.removeEventListener('focus', readFront);
  window.removeEventListener('blur', readFront);
  document.removeEventListener('visibilitychange', readFront);
});

const open = computed({
  get: () => !!current.value,
  // Escape or the close button declines, once armed; before that the dialog stays.
  set: (value) => {
    if (!value && current.value && armed.value) void answer('not-now');
  },
});

const host = computed(() => teamInstanceHost(current.value?.instance));
const project = computed(() =>
  current.value ? current.value.projectName || `project ${current.value.projectId}` : '',
);
const testCount = computed(() => current.value?.tests.length ?? 0);
const answerBy = computed(() => (current.value ? new Date(current.value.answerBy) : null));
const options = computed(() => optionWords(current.value?.options));

const finding = computed(() => !!current.value && findingFor.value === current.value.id);
const linking = computed(() => !!current.value && linkingFor.value === current.value.id);

/** The request's spec files, once each. */
const specFiles = computed(() => [...new Set(current.value?.tests.map((test) => test.filePath) ?? [])]);
const failed = (id: string) => !!current.value?.checks.some((c) => c.id === id && c.level === 'fail');
/**
 * Why the request has no folder it can run in: none is linked (`none`), the linked one is not the project's
 * (`config`), or it lacks some of the tests (`tests`), which an older copy of the code does; null when it has one.
 */
const folderIssue = computed<'none' | 'config' | 'tests' | null>(() => {
  if (!current.value) return null;
  if (!current.value.hasFolder || failed('folder')) return 'none';
  if (failed('config')) return 'config';
  return failed('specs') ? 'tests' : null;
});
/** What **Find it for me** found for the request shown. */
const foundHere = computed(() => (found.value && found.value.requestId === current.value?.id ? found.value : null));

/** Which of the request's spec files a found folder holds, in words. */
function testsHeld(folder: FoundFolder): string {
  const total = specFiles.value.length;
  if (folder.specsFound < total) return `${folder.specsFound} of the ${total} test files: it may be an older copy`;
  return total === 1 ? 'the test file' : 'the test files';
}

/** Ask the shell to look for the request's folder on this machine. */
async function findFolder() {
  const request = current.value;
  const core = tauriCore();
  if (!request || !core || findingFor.value) return;
  findingFor.value = request.id;
  try {
    const answer = await core.invoke<FolderSearch>('desktop_find_request_folders', {
      projectId: String(request.projectId),
      specs: specFiles.value,
    });
    found.value = { requestId: request.id, ...answer };
  } catch (error) {
    toast.add({ title: 'Could not look for the folder', description: errorMessage(error), color: 'error' });
  } finally {
    findingFor.value = null;
  }
}

/**
 * Link the request's folder: the found folder at `place`, else the one the person picks in the shell's own picker,
 * which offers a folder above or below the one picked when that one holds the tests.
 */
async function chooseFolder(place: number | null = null) {
  const request = current.value;
  const core = tauriCore();
  if (!request || !core || linkingFor.value) return;
  linkingFor.value = request.id;
  linkingFound.value = place;
  try {
    // A found folder is named by its search and its place: the shell asks the person before linking it.
    const folder = await core.invoke<string | null>('desktop_link_request_folder', {
      projectId: String(request.projectId),
      specs: specFiles.value,
      found: place,
      search: place === null ? null : (foundHere.value?.search ?? null),
    });
    if (!folder) return;
    found.value = null;
    add(
      await $fetch<RunRequestPromptView>(`/api/desktop/run-target/requests/${request.id}/plan`, {
        method: 'POST',
        body: {},
      }),
    );
  } catch (error) {
    // Answered while its folder was linked: nothing is left to show.
    if ((error as { statusCode?: number } | null)?.statusCode === 404) return;
    toast.add({ title: 'Could not link the folder', description: errorMessage(error), color: 'error' });
  } finally {
    linkingFor.value = null;
    linkingFound.value = null;
  }
}

async function answer(decision: 'run' | 'not-now', shownId = current.value?.id) {
  const request = current.value;
  if (!request || request.id !== shownId || starting.value || !armed.value) return;
  if (decision === 'not-now') remove(request.id);
  else starting.value = true;
  try {
    const answered = await $fetch<{ launch: boolean }>(`/api/desktop/run-target/requests/${request.id}/answer`, {
      method: 'POST',
      body: { decision, command: request.command },
    });
    if (decision === 'run' && answered.launch) {
      emit('start', {
        requestId: request.id,
        instance: request.instance,
        projectId: request.projectId,
        projectName: request.projectName,
        cases: request.tests,
        title: `${testCount.value === 1 ? request.tests[0]!.title : `${testCount.value} tests`} for ${host.value}`,
      });
    }
    remove(request.id);
  } catch (error) {
    if (decision === 'run') {
      toast.add({ title: 'Could not start the run', description: errorMessage(error), color: 'error' });
    }
  } finally {
    starting.value = false;
  }
}
</script>

<template>
  <UModal v-model:open="open" title="Run on this machine?" :ui="{ content: 'max-w-2xl' }">
    <template #body>
      <div v-if="current" :key="current.id" class="space-y-4" data-shot="desktop-team-run-request">
        <p class="text-sm text-muted">
          You asked <span class="font-medium text-highlighted">{{ host }}</span> to run
          {{ testCountWords(testCount) }} of <span class="font-medium text-highlighted">{{ project }}</span> here, in
          the folder linked to that project. It runs the code of that folder on this machine; nothing runs until you
          click <strong>Run</strong>. The request ends unanswered at {{ answerBy?.toLocaleTimeString() }}.
        </p>

        <ul class="rounded-md border border-default p-3 max-h-48 overflow-y-auto space-y-1 text-sm">
          <li v-for="test in current.tests" :key="`${test.filePath}:${test.line}:${test.projectName}`" class="min-w-0">
            <span class="text-highlighted">{{ test.title }}</span>
            <code class="block text-xs text-muted break-all"
              >{{ test.filePath }}{{ test.line ? `:${test.line}` : ''
              }}{{ test.projectName ? ` (${test.projectName})` : '' }}</code
            >
          </li>
        </ul>
        <p v-if="options.length" class="text-xs text-muted">{{ options.join(' · ') }}</p>

        <ul class="space-y-1.5 text-sm" data-testid="team-run-request-checks">
          <li v-for="check in current.checks" :key="check.id" class="flex items-start gap-2">
            <UIcon :name="CHECK_ICONS[check.level]" :class="['size-4 mt-0.5 shrink-0', CHECK_COLORS[check.level]]" />
            <span>{{ check.message }}</span>
          </li>
        </ul>

        <div
          v-if="folderIssue"
          class="space-y-3 rounded-md border border-default p-3"
          data-testid="team-run-request-folder"
        >
          <p v-if="folderIssue === 'tests'" class="text-sm text-highlighted leading-relaxed">
            The linked folder lacks some of these tests: it may be an older copy of {{ project }}'s code. Get its latest
            version (or ask whoever set up these tests to), or use another copy that holds them all.
          </p>
          <p v-else class="text-sm text-highlighted leading-relaxed">
            <template v-if="folderIssue === 'config'">The linked folder is not the right one. </template>Piwi needs your
            copy of {{ project }}'s code on this computer: the folder that holds its Playwright config (<code
              class="font-mono"
              >playwright.config.ts</code
            >) and these tests, such as <code class="font-mono">{{ specFiles[0] }}</code
            >.
          </p>

          <div v-if="foundHere?.folders.length" class="space-y-1.5">
            <p class="text-sm font-semibold text-highlighted">Found on this computer</p>
            <ul class="divide-y divide-default rounded-md border border-default">
              <li
                v-for="(folder, place) in foundHere.folders"
                :key="folder.path"
                class="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 p-2.5"
              >
                <div class="min-w-0 flex-1">
                  <code class="block text-xs font-mono text-highlighted break-all">{{ folder.path }}</code>
                  <p class="text-xs text-muted">
                    Holds <code class="font-mono">{{ folder.playwrightConfig }}</code> and {{ testsHeld(folder) }}.
                  </p>
                </div>
                <UButton
                  size="sm"
                  color="neutral"
                  variant="outline"
                  :loading="linking && linkingFound === place"
                  :disabled="linking"
                  :aria-label="`Use ${folder.path}`"
                  @click="chooseFolder(place)"
                  >Use this folder</UButton
                >
              </li>
            </ul>
          </div>
          <p v-else-if="foundHere" class="text-sm text-highlighted leading-relaxed">
            {{
              foundHere.complete
                ? `No ${folderIssue === 'none' ? '' : 'other '}copy of ${project}'s code was found in the usual places on this computer.`
                : `No ${folderIssue === 'none' ? '' : 'other '}copy of ${project}'s code was found in the places Piwi could look through.`
            }}
            If you have one elsewhere, choose its folder. If not, the code has to be downloaded first: ask whoever set
            up these tests to help you.
          </p>

          <div class="flex flex-wrap gap-2">
            <UButton
              icon="i-lucide-search"
              color="neutral"
              variant="outline"
              :loading="finding"
              :disabled="linking"
              @click="findFolder"
              >{{ foundHere ? 'Look again' : 'Find it for me' }}</UButton
            >
            <UButton
              icon="i-lucide-folder-open"
              color="neutral"
              variant="ghost"
              :loading="linking && linkingFound === null"
              :disabled="linking"
              @click="chooseFolder()"
              >{{ foundHere?.folders.length ? 'Choose another folder…' : 'Choose the folder…' }}</UButton
            >
          </div>
        </div>

        <div v-if="current.command" class="space-y-1">
          <div class="text-xs text-muted">Runs in the linked folder and reports to {{ host }}</div>
          <CodeBlock :code="current.command" lang="text" />
        </div>
      </div>
    </template>

    <template #footer>
      <div class="flex justify-end gap-2 w-full">
        <UButton color="neutral" variant="ghost" :disabled="!armed" @click="answer('not-now', current?.id)">
          Not now
        </UButton>
        <UButton
          icon="i-lucide-play"
          :disabled="!current?.runnable || !armed"
          :loading="starting"
          @click="answer('run', current?.id)"
          >Run</UButton
        >
      </div>
    </template>
  </UModal>
</template>
