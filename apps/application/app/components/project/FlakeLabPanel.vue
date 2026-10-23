<script setup lang="ts">
/**
 * The project's Flake Lab: where each flaky test stands in the lab and the
 * `piwi flake` command it needs next, then the newest experiments across the
 * project's tests. The flaky ranking follows the page's run scope, like the
 * Flaky view.
 */
import { flakeLabNextStep } from '#shared/flake-lab';
import type { FlakeLabTest, ProjectFlakeLab } from '#shared/handlers/flake-lab';
import { FLAKE_LAB_STATE_WORDS } from '~/utils/flake-lab';
import { projectRunScopeQuery, type ProjectRunScope } from '#shared/project-run-scope';

const props = defineProps<{
  projectId: number;
  /** The project page's run scope: the flaky ranking reads its runs. */
  scope?: ProjectRunScope | null;
  /** Piwi project name, threaded so the IDE opener can default the JetBrains project. */
  projectName?: string | null;
}>();

const { data: lab, status } = await useFetch(
  () => {
    const query = new URLSearchParams(props.scope ? projectRunScopeQuery(props.scope) : {}).toString();
    return `/api/projects/${props.projectId}/flake-lab${query ? `?${query}` : ''}`;
  },
  {
    lazy: true,
    server: false,
    transform: (r: ProjectFlakeLab) => r,
  },
);
// The server renders before the client-only fetch starts (`idle`), so idle reads as loading too.
const loading = computed(() => status.value === 'idle' || status.value === 'pending');

const { copy, copied } = useCopy();
const copiedCommand = ref<string | null>(null);
async function copyCommand(command: string) {
  await copy(command, { toast: 'Command copied' });
  copiedCommand.value = command;
}

/** The state in a few words, with what backs it: the condition, the commit, the retry passes. */
function stateLine(t: FlakeLabTest): string {
  const parts = [FLAKE_LAB_STATE_WORDS[t.state]];
  if (t.state === 'verified' && t.verifiedFix?.commit) parts[0] += ` on ${t.verifiedFix.commit.slice(0, 7)}`;
  if (t.reproducedBy && t.state !== 'verified') parts.push(`reproduced by ${t.reproducedBy}`);
  if (t.retryPassRuns) parts.push(`${t.retryPassRuns} retry pass${t.retryPassRuns === 1 ? '' : 'es'}`);
  if (t.lastExperimentAt) parts.push(`last experiment ${formatRelativeTime(t.lastExperimentAt)}`);
  return parts.join(' · ');
}
</script>

<template>
  <div class="space-y-4" data-shot="flake-lab">
    <StatTileGrid v-if="lab">
      <StatTile label="Flaky tests" :value="lab.counts.flaky" :hint="`last ${lab.runs} runs`" />
      <StatTile label="Not tested" :value="lab.counts.untested" hint="flaky, never in the lab" />
      <StatTile label="Fix to verify" :value="lab.counts.awaitingFix" hint="reproduced, no fix held yet" />
      <StatTile label="Verified fixed" :value="lab.counts.verified" hint="off the flaky ranking" />
    </StatTileGrid>

    <SectionCard
      icon="i-lucide-snowflake"
      title="Tests"
      help="project.flake-lab"
      :count="lab ? lab.tests.length : null"
    >
      <LoadingState v-if="loading && !lab" text="Reading the project’s flaky tests…" />
      <EmptyState
        v-else-if="lab && lab.tests.length === 0"
        icon="i-lucide-snowflake"
        :text="`No flaky test in the last ${lab.runs} runs, and no experiment yet.`"
      />
      <ol
        v-else-if="lab"
        class="rounded-lg border border-default divide-y divide-default"
        data-testid="flake-lab-tests"
        data-tour="flake-lab-tests"
      >
        <li
          v-for="t in lab.tests"
          :key="t.testCaseId"
          class="flex flex-col md:flex-row md:items-center gap-x-4 gap-y-2 px-3 py-2.5"
          data-testid="flake-lab-test"
          :data-state="t.state"
        >
          <div class="min-w-0 flex-1 space-y-0.5">
            <NuxtLink
              :to="`/test-cases/${t.testCaseId}?tab=flakiness`"
              class="block text-sm font-semibold text-highlighted hover:underline break-words"
            >
              {{ t.title }}
            </NuxtLink>
            <OpenInIdeLink
              v-if="t.filePath"
              :file-path="t.filePath"
              :project-key="projectId"
              :project-name="projectName"
              class="text-xs"
            />
            <p class="text-xs text-muted break-words" data-testid="flake-lab-state">{{ stateLine(t) }}</p>
          </div>
          <div v-if="t.nextCommand" class="flex flex-col items-start md:items-end gap-1 min-w-0 md:max-w-[50%]">
            <UButton
              size="sm"
              color="neutral"
              variant="outline"
              :icon="copied && copiedCommand === t.nextCommand ? 'i-lucide-check' : 'i-lucide-clipboard'"
              :title="t.nextCommand"
              data-testid="flake-lab-copy"
              data-tour="flake-lab-copy-command"
              @click="copyCommand(t.nextCommand)"
            >
              {{ flakeLabNextStep(t.state) === 'verify' ? 'Copy verify command' : 'Copy command' }}
            </UButton>
            <code class="text-xs text-muted font-mono break-all">{{ t.nextCommand }}</code>
          </div>
        </li>
      </ol>
    </SectionCard>

    <SectionCard
      v-if="lab"
      icon="i-lucide-flask-conical"
      title="Experiments"
      help="case.flake-experiments"
      data-tour="flake-lab-experiments"
      :subtitle="
        lab.counts.experiments > lab.experiments.length
          ? `The newest ${lab.experiments.length} of ${lab.counts.experiments}`
          : undefined
      "
      :count="lab.counts.experiments"
    >
      <p v-if="lab.experiments.length === 0" class="text-sm text-highlighted leading-relaxed">
        None yet. Copy a test’s command above and run it from the project root: the lab applies each suspect’s condition
        next to a control, with retries off, until the failure reproduces.
      </p>
      <ol v-else class="rounded-lg border border-default divide-y divide-default" data-testid="flake-lab-experiments">
        <FlakeExperimentRow v-for="e in lab.experiments" :key="e.id" :experiment="e" :title="e.title" />
      </ol>
    </SectionCard>
  </div>
</template>
