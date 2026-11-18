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
 * A request that names an environment says so in the title, and its checks and command show its key
 * (`PIWI_ENVIRONMENT`). A protected one's run keeps to the tests carrying one of its required tags, and **Run** stays
 * off until the person ticks the box naming it; the answer names the environment they confirmed, and the host
 * refuses **Run** without it.
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
const words = useRunUiWords();
const { t, tn } = words;
const starting = ref(false);

/** A folder the shell found for the request's project (`desktop_find_request_folders`). */
interface FoundFolder {
  path: string;
  playwrightConfig: string;
  specsFound: number;
  /** A folder the person's own `run` came from, a `clone` of the project's repository, or one a `search` found. */
  source: string;
}
/** What `desktop_find_request_folders` answers: its search's number, which the link takes back. */
interface FolderSearch {
  search: number;
  folders: FoundFolder[];
  /** Every place was searched whole. */
  complete: boolean;
  /** The project's repository as the instance names it, without its scheme: `github.com/acme/shop`. */
  repository: string | null;
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
/** What the person is asked: the request, its command, whether it runs, and the environment it is for. */
const asked = computed(() =>
  current.value
    ? `${current.value.id}\n${current.value.command}\n${current.value.runnable}\n${current.value.environment?.key ?? ''}`
    : null,
);
const shown = computed(() => (inFront.value ? asked.value : null));
/** Whether the person ticked the box naming the protected environment of the request shown, as it is shown now. */
const confirmedProtected = ref(false);
watch(
  shown,
  (value) => {
    armed.value = false;
    if (armTimer) clearTimeout(armTimer);
    armTimer = value ? setTimeout(() => (armed.value = true), ARM_AFTER_MS) : null;
  },
  { immediate: true },
);
// A request or a command shown anew is confirmed anew; the window coming to the front keeps the answer.
watch(asked, () => (confirmedProtected.value = false));
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

const host = computed(() => teamInstanceHost(current.value?.instance, words));
const project = computed(() =>
  current.value ? current.value.projectName || t('runui_requestProject', { id: current.value.projectId }) : '',
);
const testCount = computed(() => current.value?.tests.length ?? 0);
const answerBy = computed(() => (current.value ? words.time(new Date(current.value.answerBy)) : ''));
const options = computed(() => optionWords(current.value?.options, words));
/** The environment the request runs for, and whether it is a protected one that waits for the person's confirmation. */
const environment = computed(() => current.value?.environment ?? null);
const protectedEnvironment = computed(() => (environment.value?.protected ? environment.value : null));
const title = computed(() =>
  environment.value ? t('runui_requestTitleFor', { environment: environment.value.name }) : t('runui_requestTitle'),
);
/** Whether **Run** may be clicked: the checks pass and, for a protected environment, the person confirmed it. */
const runAllowed = computed(
  () => !!current.value?.runnable && (!protectedEnvironment.value || confirmedProtected.value),
);

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
/** The project's repository, once a search named it. */
const repository = computed(() => foundHere.value?.repository ?? null);
/** The project's code, in words: `Acme Checkout's code`. */
const projectCode = computed(() => t('runui_requestProjectCode', { project: project.value }));
/** The project's code and its repository, once known: `Acme Checkout's code (github.com/acme/shop)`. */
const projectCodeAt = computed(() =>
  repository.value
    ? t('runui_requestProjectCodeAt', { project: project.value, repository: repository.value })
    : projectCode.value,
);

/** Which of the request's spec files a found folder holds, in words. */
function testsHeld(folder: FoundFolder): string {
  const total = specFiles.value.length;
  if (folder.specsFound < total) {
    return t('runui_requestSomeTestFiles', { found: words.number(folder.specsFound), total: words.number(total) });
  }
  return total === 1 ? t('runui_requestTestFile') : t('runui_requestTestFiles');
}

/** What the dialog says when **Find it for me** found no folder. */
const noneFound = computed(() => {
  const other = folderIssue.value !== 'none';
  const key = foundHere.value?.complete
    ? other
      ? 'runui_requestNoOtherFound'
      : 'runui_requestNoneFound'
    : other
      ? 'runui_requestNoOtherFoundPartly'
      : 'runui_requestNoneFoundPartly';
  return t(key, { code: projectCode.value });
});

/** Ask the shell to look for the request's folder on this machine. */
async function findFolder() {
  const request = current.value;
  const core = tauriCore();
  if (!request || !core || findingFor.value) return;
  findingFor.value = request.id;
  try {
    // The window names the request alone: the shell reads its tests and the instance's hints from this app's server.
    const answer = await core.invoke<FolderSearch>('desktop_find_request_folders', { requestId: request.id });
    found.value = { requestId: request.id, ...answer };
  } catch (error) {
    toast.add({
      title: t('runui_requestFindFailed'),
      description: errorMessage(error, t('runui_commonUnknownError')),
      color: 'error',
    });
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
      requestId: request.id,
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
    toast.add({
      title: t('runui_requestLinkFailed'),
      description: errorMessage(error, t('runui_commonUnknownError')),
      color: 'error',
    });
  } finally {
    linkingFor.value = null;
    linkingFound.value = null;
  }
}

async function answer(decision: 'run' | 'not-now', shownId = current.value?.id) {
  const request = current.value;
  if (!request || request.id !== shownId || starting.value || !armed.value) return;
  if (decision === 'run' && !runAllowed.value) return;
  if (decision === 'not-now') remove(request.id);
  else starting.value = true;
  try {
    const confirmed = decision === 'run' && request.environment?.protected ? request.environment.key : undefined;
    const answered = await $fetch<{ launch: boolean }>(`/api/desktop/run-target/requests/${request.id}/answer`, {
      method: 'POST',
      body: { decision, command: request.command, ...(confirmed ? { environment: confirmed } : {}) },
    });
    if (decision === 'run' && answered.launch) {
      emit('start', {
        requestId: request.id,
        instance: request.instance,
        projectId: request.projectId,
        projectName: request.projectName,
        cases: request.tests,
        title: t('runui_requestRunTitle', {
          tests: testCount.value === 1 ? request.tests[0]!.title : tn('runui_tests', testCount.value),
          host: host.value,
        }),
      });
    }
    remove(request.id);
  } catch (error) {
    if (decision === 'run') {
      toast.add({
        title: t('runui_requestStartFailed'),
        description: errorMessage(error, t('runui_commonUnknownError')),
        color: 'error',
      });
    }
  } finally {
    starting.value = false;
  }
}
</script>

<template>
  <UModal v-model:open="open" :title="title" :ui="{ content: 'max-w-2xl' }">
    <template #body>
      <div v-if="current" :key="current.id" class="space-y-4" data-shot="desktop-team-run-request">
        <p class="text-sm text-muted">
          <RunUiText name="runui_requestIntro" :args="{ tests: testCountWords(testCount, words), time: answerBy }">
            <template #host>
              <span class="font-medium text-highlighted">{{ host }}</span>
            </template>
            <template #project>
              <span class="font-medium text-highlighted">{{ project }}</span>
            </template>
            <template #run>
              <strong>{{ t('runui_requestRun') }}</strong>
            </template>
          </RunUiText>
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
            <span>{{ requestCheckWords(check, words) }}</span>
          </li>
        </ul>

        <div
          v-if="folderIssue"
          class="space-y-3 rounded-md border border-default p-3"
          data-testid="team-run-request-folder"
        >
          <p v-if="folderIssue === 'tests'" class="text-sm text-highlighted leading-relaxed">
            {{ t('runui_requestFolderOlderCopy', { code: projectCode }) }}
          </p>
          <p v-else class="text-sm text-highlighted leading-relaxed">
            <template v-if="folderIssue === 'config'">{{ `${t('runui_requestFolderNotRight')} ` }}</template>
            <RunUiText name="runui_requestFolderNeeded" :args="{ code: projectCodeAt }">
              <template #config>
                <code class="font-mono">playwright.config.ts</code>
              </template>
              <template #spec>
                <code class="font-mono">{{ specFiles[0] }}</code>
              </template>
            </RunUiText>
          </p>

          <div v-if="foundHere?.folders.length" class="space-y-1.5">
            <p class="text-sm font-semibold text-highlighted">{{ t('runui_requestFoundHeading') }}</p>
            <ul class="divide-y divide-default rounded-md border border-default">
              <li
                v-for="(folder, place) in foundHere.folders"
                :key="folder.path"
                class="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 p-2.5"
              >
                <div class="min-w-0 flex-1">
                  <code class="block text-xs font-mono text-highlighted break-all">{{ folder.path }}</code>
                  <p class="text-xs text-muted">
                    <template v-if="folder.source === 'run'">{{ `${t('runui_requestFoundFromRun')} ` }}</template>
                    <template v-else-if="folder.source === 'clone' && repository">{{
                      `${t('runui_requestFoundClone', { repository })} `
                    }}</template>
                    <RunUiText name="runui_requestFoundHolds" :args="{ tests: testsHeld(folder) }">
                      <template #config>
                        <code class="font-mono">{{ folder.playwrightConfig }}</code>
                      </template>
                    </RunUiText>
                  </p>
                </div>
                <UButton
                  size="sm"
                  color="neutral"
                  variant="outline"
                  :loading="linking && linkingFound === place"
                  :disabled="linking"
                  :aria-label="t('runui_requestUseFolderLabel', { path: folder.path })"
                  @click="chooseFolder(place)"
                  >{{ t('runui_requestUseFolder') }}</UButton
                >
              </li>
            </ul>
          </div>
          <p v-else-if="foundHere" class="text-sm text-highlighted leading-relaxed">
            {{ noneFound }}
            {{ repository ? t('runui_requestSetUpFirstFrom', { repository }) : t('runui_requestSetUpFirst') }}
          </p>

          <div class="flex flex-wrap gap-2">
            <UButton
              icon="i-lucide-search"
              color="neutral"
              variant="outline"
              :loading="finding"
              :disabled="linking"
              @click="findFolder"
              >{{ foundHere ? t('runui_requestLookAgain') : t('runui_requestFindFolder') }}</UButton
            >
            <UButton
              icon="i-lucide-folder-open"
              color="neutral"
              variant="ghost"
              :loading="linking && linkingFound === null"
              :disabled="linking"
              @click="chooseFolder()"
              >{{
                foundHere?.folders.length ? t('runui_requestChooseOtherFolder') : t('runui_requestChooseFolder')
              }}</UButton
            >
          </div>
        </div>

        <div v-if="current.command" class="space-y-1">
          <div class="text-xs text-muted">{{ t('runui_requestRunsIn', { host }) }}</div>
          <CodeBlock :code="current.command" lang="text" />
        </div>

        <div
          v-if="protectedEnvironment && current.runnable"
          class="space-y-2 rounded-md border border-warning/40 bg-warning/10 p-3"
          data-testid="team-run-request-protected"
        >
          <p class="flex items-start gap-2 text-sm text-highlighted leading-relaxed">
            <UIcon :name="CHECK_ICONS.warn" :class="['size-4 mt-0.5 shrink-0', CHECK_COLORS.warn]" />
            <span>{{
              t('runui_requestProtectedNote', {
                environment: protectedEnvironment.name,
                tags: protectedEnvironment.requiredTags.join(', '),
              })
            }}</span>
          </p>
          <UCheckbox
            v-model="confirmedProtected"
            :disabled="!armed"
            :label="t('runui_requestProtectedConfirm', { environment: protectedEnvironment.name })"
          />
        </div>
      </div>
    </template>

    <template #footer>
      <div class="flex justify-end gap-2 w-full">
        <UButton color="neutral" variant="ghost" :disabled="!armed" @click="answer('not-now', current?.id)">
          {{ t('runui_requestNotNow') }}
        </UButton>
        <UButton
          icon="i-lucide-play"
          :disabled="!runAllowed || !armed"
          :loading="starting"
          @click="answer('run', current?.id)"
          >{{ t('runui_requestRun') }}</UButton
        >
      </div>
    </template>
  </UModal>
</template>
