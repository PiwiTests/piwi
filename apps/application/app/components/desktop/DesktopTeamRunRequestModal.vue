<script setup lang="ts">
/**
 * Desktop shell only: a run request from the team instance this app is connected to, which the app claimed. It
 * shows the instance that asked, the tests, the checks of the folder linked to the request's project on this machine
 * (with **Choose the folder** when none is), and the exact command. Nothing runs before **Run**; **Not now** declines
 * it, or refuses it with the checks that failed. The shell takes the command and the request token from this app's
 * server, never from this window.
 */
import type { RunRequestPromptView } from '#shared/desktop-run-target';

const { current, add, remove } = useDesktopTeamRequests();
const store = useDesktopLocalRuns();
const toast = useToast();
const starting = ref(false);
const linking = ref(false);

const open = computed({
  get: () => !!current.value,
  set: (value) => {
    if (!value && current.value) void answer('not-now');
  },
});

const host = computed(() => {
  const url = current.value?.instance;
  if (!url) return 'your team instance';
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
});
const testCount = computed(() => current.value?.tests.length ?? 0);
const answerBy = computed(() => (current.value ? new Date(current.value.answerBy) : null));
const options = computed(() => {
  const o = current.value?.options;
  if (!o) return [];
  return [
    o.headed ? 'headed' : 'headless',
    o.trace ? `trace ${o.trace}` : null,
    o.repeatEach && o.repeatEach > 1 ? `repeat ${o.repeatEach}×` : null,
    o.workers ? `${o.workers} workers` : null,
    o.project ? `project ${o.project}` : null,
  ].filter(Boolean) as string[];
});

const CHECK_ICONS = {
  ok: 'i-lucide-circle-check',
  warn: 'i-lucide-triangle-alert',
  fail: 'i-lucide-circle-x',
} as const;
const CHECK_COLORS = { ok: 'text-success', warn: 'text-warning', fail: 'text-error' } as const;

async function chooseFolder() {
  const request = current.value;
  const core = tauriCore();
  if (!request || !core || linking.value) return;
  linking.value = true;
  try {
    const folder = await core.invoke<string | null>('desktop_link_request_folder', {
      projectId: String(request.projectId),
    });
    if (!folder) return;
    add(await $fetch<RunRequestPromptView>(`/api/desktop/run-target/requests/${request.id}/plan`, { method: 'POST' }));
  } catch (error) {
    toast.add({ title: 'Could not link the folder', description: errorMessage(error), color: 'error' });
  } finally {
    linking.value = false;
  }
}

async function answer(decision: 'run' | 'not-now') {
  const request = current.value;
  if (!request || starting.value) return;
  if (decision === 'not-now') remove(request.id);
  else starting.value = true;
  try {
    const answered = await $fetch<{ launch: boolean }>(`/api/desktop/run-target/requests/${request.id}/answer`, {
      method: 'POST',
      body: { decision },
    });
    if (decision === 'run' && answered.launch) {
      store.startTeamRequest({
        requestId: request.id,
        instance: request.instance,
        projectId: request.projectId,
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
      <div v-if="current" class="space-y-4" data-shot="desktop-team-run-request">
        <p class="text-sm text-muted">
          You asked <span class="font-medium text-highlighted">{{ host }}</span> to run
          {{ testCount === 1 ? 'a test' : `${testCount} tests` }} here, in the folder linked to its project. It runs the
          code of that folder on this machine; nothing runs until you click <strong>Run</strong>. The request ends
          unanswered at {{ answerBy?.toLocaleTimeString() }}.
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

        <UButton
          v-if="!current.hasFolder || current.checks.some((c) => c.id === 'folder' && c.level === 'fail')"
          icon="i-lucide-folder-open"
          color="neutral"
          variant="outline"
          :loading="linking"
          @click="chooseFolder"
          >Choose the folder</UButton
        >

        <div v-if="current.command" class="space-y-1">
          <div class="text-xs text-muted">Runs in the linked folder and reports to {{ host }}</div>
          <CodeBlock :code="current.command" lang="sh" />
        </div>
      </div>
    </template>

    <template #footer>
      <div class="flex justify-end gap-2 w-full">
        <UButton color="neutral" variant="ghost" @click="answer('not-now')">Not now</UButton>
        <UButton
          icon="i-lucide-play"
          :disabled="!current?.runnable"
          :loading="starting"
          autofocus
          @click="answer('run')"
          >Run</UButton
        >
      </div>
    </template>
  </UModal>
</template>
