<script setup lang="ts">
/**
 * One environment's details, opened from its row in Project → Settings → Environments: its last run, its last
 * environment incident, its recent deploy markers, and for a deployed environment the application's commits and
 * versions its recent runs ran against, each with where the commit comes from. Read when it opens.
 */
import type { EnvironmentRecord } from '#shared/environments';
import type { ApiResponse } from '~~/types/api';
import { deployedCommitSource } from '#shared/deployed-words';

const props = defineProps<{
  projectId: number;
  environment: EnvironmentRecord | null;
}>();
const open = defineModel<boolean>('open', { default: false });

type Activity = ApiResponse<
  typeof import('~~/server/api/projects/[id]/environments/[environmentId]/activity.get').default
>;

const activity = ref<Activity | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);

async function load() {
  const environment = props.environment;
  if (!open.value || !environment) return;
  loading.value = true;
  error.value = null;
  activity.value = null;
  try {
    activity.value = await $fetch<Activity>(`/api/projects/${props.projectId}/environments/${environment.id}/activity`);
  } catch (e) {
    error.value = errorMessage(e, 'The environment’s activity could not be read.');
  } finally {
    loading.value = false;
  }
}
watch([open, () => props.environment?.id], load, { immediate: true });

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
</script>

<template>
  <UModal
    v-model:open="open"
    :title="environment ? `${environment.name} activity` : 'Environment activity'"
    :ui="{ content: 'max-w-2xl' }"
  >
    <template #body>
      <LoadingState v-if="loading" text="Reading the environment’s activity…" />
      <ErrorState v-else-if="error" :text="error" />
      <div v-else-if="activity && environment" class="space-y-5" data-testid="environment-activity">
        <p class="text-sm text-highlighted leading-relaxed">
          <template v-if="activity.appFromCheckout">
            Built from the checkout: each run's application is the run's own commit.
          </template>
          <template v-else>
            Deployed: the application's version is independent of the run's commit. A run takes its deployed commit from
            its server under test, else from the latest deploy marker before it.
            <HelpHint topic="run.deployedCommit" />
          </template>
        </p>

        <section class="space-y-1.5">
          <h3 class="text-sm font-semibold text-highlighted">Last run</h3>
          <p v-if="activity.lastRun" class="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <RunStatusBadge :status="activity.lastRun.status" />
            <NuxtLink :to="`/test-runs/${activity.lastRun.id}`" :class="SENTENCE_LINK_CLASS"
              >Run #{{ activity.lastRun.id }}</NuxtLink
            >
            <BranchLabel v-if="activity.lastRun.branch" :name="activity.lastRun.branch" />
            <span class="text-xs text-muted">{{ formatRelativeTime(activity.lastRun.startTime) }}</span>
          </p>
          <p v-else class="text-sm text-muted">No run reported this environment yet.</p>
        </section>

        <section class="space-y-1.5">
          <h3 class="text-sm font-semibold text-highlighted">Last environment incident</h3>
          <p v-if="activity.lastIncident" class="text-sm text-highlighted break-words">
            {{ activity.lastIncident.reason }}
            <span class="text-xs text-muted">
              ·
              <NuxtLink
                v-if="activity.lastIncident.runId != null"
                :to="`/test-runs/${activity.lastIncident.runId}`"
                :class="SENTENCE_LINK_CLASS"
                >run #{{ activity.lastIncident.runId }}</NuxtLink
              >
              <template v-if="activity.lastIncident.runId != null"> · </template>
              {{ formatRelativeTime(activity.lastIncident.at) }}
            </span>
          </p>
          <p v-else class="text-sm text-muted">None recorded.</p>
        </section>

        <section v-if="!activity.appFromCheckout" class="space-y-1.5" data-testid="environment-versions">
          <h3 class="text-sm font-semibold text-highlighted">Deployed commits and versions</h3>
          <ul v-if="activity.versions.length" class="divide-y divide-default rounded-md border border-default">
            <li
              v-for="version in activity.versions"
              :key="version.lastRunId"
              class="flex flex-col gap-0.5 px-3 py-1.5 sm:flex-row sm:items-baseline sm:gap-3"
            >
              <span class="min-w-0 flex-1 text-sm text-highlighted break-words">
                <code v-if="version.commit" class="font-mono">{{ version.commit.slice(0, 7) }}</code>
                <span v-else class="text-muted">No commit</span>
                <template v-if="version.appVersions.length"> · {{ version.appVersions.join(', ') }}</template>
              </span>
              <span class="text-xs text-muted sm:shrink-0">
                <template v-if="version.commit && version.source">
                  {{ deployedCommitSource({ source: version.source, markerLabel: version.markerLabel ?? undefined }) }}
                  ·
                </template>
                <NuxtLink :to="`/test-runs/${version.lastRunId}`" :class="SENTENCE_LINK_CLASS"
                  >run #{{ version.lastRunId }}</NuxtLink
                >
                <template v-if="version.runs > 1"> and {{ plural(version.runs - 1, 'earlier run') }}</template>
                · {{ formatRelativeTime(version.lastSeenAt) }}
              </span>
            </li>
          </ul>
          <p v-else class="text-sm text-muted">
            No recent run named its deployed commit or version. An instrumented server under test reports both; the
            deploy pipeline can post the commit on a deploy marker.
          </p>
        </section>

        <section class="space-y-1.5" data-testid="environment-deploys">
          <h3 class="text-sm font-semibold text-highlighted">Deploys</h3>
          <ul v-if="activity.deploys.length" class="divide-y divide-default rounded-md border border-default">
            <li
              v-for="deploy in activity.deploys"
              :key="deploy.markerId"
              class="flex flex-wrap items-baseline gap-x-2 px-3 py-1.5 text-sm"
            >
              <span class="text-highlighted break-words">{{ deploy.label }}</span>
              <code v-if="deploy.commit" class="font-mono text-xs text-muted">{{ deploy.commit.slice(0, 7) }}</code>
              <span class="ml-auto text-xs text-muted">{{ formatRelativeTime(deploy.deployedAt) }}</span>
            </li>
            <li v-if="activity.moreDeploys" class="px-3 py-1.5 text-xs text-muted">Older deploys left out</li>
          </ul>
          <p v-else class="text-sm text-muted">No deploy marker names {{ environment.name }} yet.</p>
        </section>
      </div>
    </template>
  </UModal>
</template>
