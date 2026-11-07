<script setup lang="ts">
/**
 * **Run on my machine**: asks one of the person's own apps (the desktop app) to run tests of this page. The menu picks
 * what runs, which app, and the run options of Copy retry command; the app shows the request with its checks and the
 * command, and runs nothing before the person clicks **Run** there. Once sent, the same window follows the request
 * until it ends, with **Stop** while it goes on and **Run again** after.
 */
import type { RunRequestOptions } from '@piwitests/core/run-request';
import type { RunOnMyMachineChoice, RunRequestSourceChoice } from '~/composables/useRunOnMyMachine';

const props = defineProps<{
  projectId: number;
  /** What the page can send, the first one chosen. */
  choices: RunOnMyMachineChoice[];
  /** The Playwright projects the tests ran in. */
  projects?: readonly string[];
}>();

const { shown, apps, appsLoaded, loadApps, send } = await useRunOnMyMachine(props.projectId);
const { prefs, project } = useRetryOptions();
const { request, error: progressError, follow, stop, reset } = useRunRequestProgress();
const config = useRuntimeConfig();

const open = ref(false);
const sending = ref(false);
const stopping = ref(false);
const sendError = ref<string | null>(null);
const skipped = ref(0);
const choiceIndex = ref(0);
const targetId = ref<number | undefined>(undefined);
const lastSent = ref<{ source: RunRequestSourceChoice; options: RunRequestOptions; targetId: number | null } | null>(
  null,
);

const choice = computed(() => props.choices[choiceIndex.value] ?? props.choices[0]);
const choiceProjects = computed(() => choice.value?.projects ?? props.projects ?? []);
const choiceItems = computed(() =>
  props.choices.map((c, i) => ({ value: i, label: c.label, description: testCount(c.count) })),
);

function testCount(n: number) {
  return `${n} test${n === 1 ? '' : 's'}`;
}

const appItems = computed(() =>
  apps.value.map((app) => ({
    value: app.target.id,
    label: app.name,
    description: [
      app.target.online ? 'Online' : 'Offline',
      app.target.projectIds.includes(props.projectId)
        ? 'has a folder for this project'
        : 'asks for the folder of this project',
    ].join(' · '),
  })),
);

watch(apps, (list) => {
  if (targetId.value != null && list.some((app) => app.target.id === targetId.value)) return;
  targetId.value = (list.find((app) => app.target.online) ?? list[0])?.target.id;
});

const instanceAddress = computed(() => {
  if (config.public.siteUrl) return config.public.siteUrl.replace(/\/$/, '');
  if (!import.meta.client) return '';
  return new URL(config.app.baseURL || '/', window.location.origin).href.replace(/\/$/, '');
});

/** The run options of Copy retry command, as a request takes them. */
function requestOptions(): RunRequestOptions {
  const p = prefs.value;
  const options: RunRequestOptions = { headed: p.headed };
  if (p.trace) options.trace = p.trace;
  if (p.repeatEach > 1) options.repeatEach = p.repeatEach;
  if (p.workers) options.workers = p.workers;
  const projects = choiceProjects.value;
  if (project.value && projects.length > 1 && projects.includes(project.value)) options.project = project.value;
  return options;
}

function openMenu() {
  open.value = true;
  // A request still going on is shown again; one that ended makes way for a new one.
  if (request.value && !runRequestIsFinal(request.value)) return;
  reset();
  sendError.value = null;
  choiceIndex.value = 0;
  void loadApps();
}

async function sendRequest(again = false) {
  const body = again && lastSent.value ? lastSent.value : null;
  const source = body?.source ?? choice.value?.source;
  if (!source || sending.value) return;
  const options = body?.options ?? requestOptions();
  const target = body ? body.targetId : (targetId.value ?? null);
  sending.value = true;
  sendError.value = null;
  try {
    const made = await send(source, options, target);
    skipped.value = made.skipped;
    lastSent.value = { source, options, targetId: target };
    follow(made);
  } catch (error) {
    sendError.value = errorMessage(error);
  } finally {
    sending.value = false;
  }
}

async function stopRequest() {
  stopping.value = true;
  try {
    await stop();
  } finally {
    stopping.value = false;
  }
}

const canSend = computed(() => !!choice.value && apps.value.length > 0);
</script>

<template>
  <template v-if="shown && choices.length">
    <UButton
      size="xs"
      color="neutral"
      variant="outline"
      icon="i-lucide-monitor-play"
      aria-label="Run on my machine"
      data-testid="run-on-my-machine"
      @click="openMenu"
    >
      <span class="hidden sm:inline">Run on my machine</span>
    </UButton>

    <UModal v-model:open="open" title="Run on my machine" :ui="{ content: 'max-w-lg' }">
      <template #body>
        <div v-if="request" class="space-y-3" data-shot="run-request-progress">
          <div class="flex items-start gap-2">
            <span
              :class="['size-2.5 rounded-full mt-1.5 shrink-0', STATUS_PALETTE[runRequestStatusKey(request)].bg]"
              aria-hidden="true"
            />
            <p class="text-sm text-highlighted leading-relaxed" data-testid="run-request-state">
              {{ runRequestSentence(request) }}
            </p>
          </div>
          <p class="text-xs text-muted break-words">
            {{ request.tests.length === 1 ? request.tests[0]!.title : testCount(request.tests.length) }}
            <template v-if="skipped">
              · {{ skipped }} left out: no recorded line, or a path the request refuses</template
            >
          </p>
          <p v-if="request.runId" class="text-sm text-highlighted">
            The run reports here, and only you see it:
            <NuxtLink :to="`/test-runs/${request.runId}`" :class="SENTENCE_LINK_CLASS"
              >open run #{{ request.runId }}</NuxtLink
            >
          </p>
          <p v-if="progressError" class="text-xs text-error">{{ progressError }}</p>
          <p v-if="sendError" class="text-xs text-error">{{ sendError }}</p>
        </div>

        <div v-else class="space-y-4" data-shot="run-on-my-machine-menu">
          <p class="text-sm text-highlighted leading-relaxed">
            Your app shows the request with its checks and the command; nothing runs until you click
            <strong>Run</strong> there. The run reports here, and only you see it.
          </p>

          <div v-if="choices.length > 1" class="space-y-1">
            <div class="text-sm font-semibold text-highlighted">What</div>
            <URadioGroup v-model="choiceIndex" :items="choiceItems" size="sm" />
          </div>

          <div class="space-y-1">
            <div class="text-sm font-semibold text-highlighted">Where</div>
            <LoadingState v-if="!appsLoaded" />
            <URadioGroup v-else-if="appItems.length" v-model="targetId" :items="appItems" size="sm" />
            <p v-else class="text-sm text-highlighted leading-relaxed">
              No app of yours takes run requests yet. In Piwi Desktop, open <strong>Settings → Desktop app</strong> and
              connect it to <code class="text-xs">{{ instanceAddress }}</code> under <strong>Run on my machine</strong>.
              <DocLink to="features/run-on-my-machine" no-icon :class="SENTENCE_LINK_CLASS">How it works</DocLink>
            </p>
          </div>

          <RetryCommandOptions :projects="choiceProjects" :naming="false" class="-mx-2" />

          <p v-if="sendError" class="text-xs text-error">{{ sendError }}</p>
        </div>
      </template>

      <template #footer>
        <div class="flex justify-end gap-2 w-full">
          <template v-if="request">
            <UButton
              v-if="runRequestCanStop(request)"
              color="neutral"
              variant="outline"
              :loading="stopping"
              @click="stopRequest"
              >Stop</UButton
            >
            <UButton v-else color="neutral" variant="outline" :loading="sending" @click="sendRequest(true)"
              >Run again</UButton
            >
            <UButton color="neutral" variant="ghost" @click="open = false">Close</UButton>
          </template>
          <template v-else>
            <UButton color="neutral" variant="ghost" @click="open = false">Cancel</UButton>
            <UButton icon="i-lucide-send" :disabled="!canSend" :loading="sending" @click="sendRequest()">Send</UButton>
          </template>
        </div>
      </template>
    </UModal>
  </template>
</template>
