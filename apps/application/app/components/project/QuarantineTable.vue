<script setup lang="ts">
/**
 * The quarantine list, its exit progress, and the debt it represents.
 *
 * The streak column is the point of the view: a quarantined test still runs, so
 * it can earn its way out, and the table says when it has rather than waiting
 * to be asked: after a streak of passes, or at once when a Flake Lab verify
 * experiment proved the fix after the quarantine.
 */
import { buildTestRowBadges } from '~/utils/test-row-badges';

const props = defineProps<{
  projectId: string | number;
  projectName?: string | null;
  /** Hide the "Worth quarantining" card — its role is the flaky list's Quarantine action. */
  hideCandidates?: boolean;
}>();

const emit = defineEmits<{ count: [active: number] }>();

interface QuarantineEntry {
  id: number;
  testCaseId: number;
  title: string;
  filePath: string;
  reason: string | null;
  source: string;
  owner: string | null;
  tags: string[] | null;
  ageMs: number;
  consecutivePasses: number;
  releaseProposed: boolean;
  releaseReason: 'streak' | 'verified-fix' | null;
  verifiedFix: { commit: string | null; verifiedAt: string } | null;
  runsSinceQuarantine: number;
  /** Someone dismissed the proposed release; the test stays until a person releases it. */
  releaseDismissed: boolean;
}

interface Candidate {
  testCaseId: number;
  title: string;
  filePath: string;
  flakyScore: number;
  wastedCiMinutes: number;
  rationale: string;
  /** Dismissed since the newest run. */
  dismissed: boolean;
}

interface QuarantineResponse {
  entries: QuarantineEntry[];
  debt: { active: number; readyToRelease: number; oldestAgeMs: number; stillFailing: number };
  candidates: Candidate[];
  releaseAfterConsecutivePasses: number;
}

const toast = useToast();
// Quarantining, releasing and dismissing need `quarantine:write` on the project.
const { can } = useAuth();
const canQuarantine = computed(() => can('quarantine:write', props.projectId));
const busy = ref<number | null>(null);

// The proposals cost a flaky analysis; the server skips it when the card is hidden.
const { data, status, error, refresh } = await useFetch<QuarantineResponse>(
  () => `/api/projects/${props.projectId}/quarantine${props.hideCandidates ? '?candidates=false' : ''}`,
);

watch(data, (d) => emit('count', d?.debt.active ?? 0));

// What a quarantine leaves uncovered, or a release covers again, beside its button, where the project records coverage.
const { state: capabilityState } = await useProjectCapabilities(Number(props.projectId));
const coverageActive = computed(() => capabilityState('coverage') === 'active');

function formatAge(ms: number): string {
  const hours = Math.round(ms / 3_600_000);
  if (hours < 48) return `${Math.max(1, hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

async function quarantine(testCaseId: number, reason: string) {
  busy.value = testCaseId;
  try {
    await $fetch(`/api/projects/${props.projectId}/quarantine`, {
      method: 'POST',
      body: { testCaseId, reason, source: 'proposed' },
    });
    toast.add({ title: 'Quarantined', color: 'success' });
    await refresh();
  } catch {
    toast.add({ title: 'Could not quarantine that test', color: 'error' });
  } finally {
    busy.value = null;
  }
}

async function release(testCaseId: number) {
  busy.value = testCaseId;
  try {
    await $fetch(`/api/projects/${props.projectId}/quarantine/${testCaseId}`, { method: 'DELETE' });
    toast.add({ title: 'Released', color: 'success' });
    await refresh();
  } catch {
    toast.add({ title: 'Could not release that test', color: 'error' });
  } finally {
    busy.value = null;
  }
}
</script>

<template>
  <div class="space-y-6" data-shot="quarantine-table">
    <SectionCard title="Quarantine" icon="i-lucide-shield-alert" :count="data?.debt.active" help="project.quarantine">
      <template #subtitle>
        A quarantined test keeps running and keeps reporting — it is excluded from the CI gate's verdict and nothing
        else. That is what lets it earn its way back out.
      </template>

      <LoadingState v-if="status === 'pending'" />
      <ErrorState v-else-if="error" :text="String(error)" />

      <template v-else>
        <StatTileGrid v-if="data && data.debt.active > 0" class="mb-4">
          <StatTile label="Quarantined" :value="data.debt.active" />
          <StatTile
            label="Ready to release"
            :value="data.debt.readyToRelease"
            :value-class="data.debt.readyToRelease > 0 ? 'text-green-600 dark:text-green-400' : ''"
            hint="earned their way out"
          />
          <StatTile label="Still failing" :value="data.debt.stillFailing" hint="no passing streak" />
          <StatTile label="Oldest" :value="formatAge(data.debt.oldestAgeMs)" size="sm" />
        </StatTileGrid>

        <EmptyState
          v-if="!data || data.entries.length === 0"
          icon="i-lucide-shield-check"
          text="Nothing quarantined. Tests you quarantine appear here with their progress back out."
        />

        <div v-else class="rounded-lg border border-default overflow-hidden">
          <TestRow
            v-for="entry in data.entries"
            :key="entry.id"
            :href="`/test-cases/${entry.testCaseId}`"
            :title="entry.title"
            status="quarantined"
            icon="i-lucide-shield-alert"
            icon-class="text-amber-600 dark:text-amber-400"
            :file-path="entry.filePath"
            :badges="buildTestRowBadges({ tags: entry.tags, meta: { owner: entry.owner ?? undefined } })"
            :project-key="projectId"
            :project-name="projectName"
          >
            <template #metrics>
              <UBadge
                v-if="entry.releaseReason === 'verified-fix'"
                color="success"
                variant="soft"
                size="xs"
                :title="`Flake Lab verified the fix ${formatRelativeTime(entry.verifiedFix!.verifiedAt)}`"
                data-testid="quarantine-verified-fix"
              >
                Verified fixed{{ entry.verifiedFix?.commit ? ` on ${entry.verifiedFix.commit.slice(0, 7)}` : '' }} —
                ready
              </UBadge>
              <UBadge v-else-if="entry.releaseProposed" color="success" variant="soft" size="xs">
                {{ entry.consecutivePasses }} green — ready
              </UBadge>
              <span v-else-if="entry.runsSinceQuarantine === 0" class="text-xs">not run yet</span>
              <span v-else class="text-xs tabular-nums" title="Consecutive passes toward release">
                {{ entry.consecutivePasses }} / {{ data.releaseAfterConsecutivePasses }}
              </span>
              <span class="tabular-nums" :title="`Quarantined ${formatAge(entry.ageMs)} ago`">
                {{ formatAge(entry.ageMs) }}
              </span>
              <span
                v-if="entry.releaseProposed && entry.releaseDismissed"
                class="text-xs"
                data-testid="quarantine-release-dismissed"
              >
                release dismissed
              </span>
              <QuarantineDismissButton
                v-else-if="entry.releaseProposed && canQuarantine"
                :project-id="projectId"
                :test-case-id="entry.testCaseId"
                proposal="release"
                @dismissed="refresh()"
              />
              <CoverageLossPopover
                v-if="canQuarantine"
                :project-id="projectId"
                :project-name="projectName"
                :test-case-ids="[entry.testCaseId]"
                action="release"
                :active="coverageActive"
              >
                <UButton
                  size="xs"
                  :color="entry.releaseProposed && !entry.releaseDismissed ? 'primary' : 'neutral'"
                  variant="soft"
                  :loading="busy === entry.testCaseId"
                  @click="release(entry.testCaseId)"
                >
                  Release
                </UButton>
              </CoverageLossPopover>
            </template>

            <template v-if="entry.reason" #subline>
              <p class="text-xs text-muted">{{ entry.reason }}</p>
            </template>
          </TestRow>
        </div>
      </template>
    </SectionCard>

    <SectionCard
      v-if="!hideCandidates && data && data.candidates.length > 0"
      title="Worth quarantining"
      icon="i-lucide-lightbulb"
      :count="data.candidates.length"
    >
      <template #subtitle>
        Ranked by the CI minutes their flakiness wastes, not by how often they flake — a test that flakes constantly but
        finishes instantly costs nothing.
      </template>

      <TableScroller>
        <table class="w-full text-sm">
          <tbody>
            <tr v-for="candidate in data.candidates" :key="candidate.testCaseId" class="border-t border-default">
              <td class="px-3 py-2 min-w-0">
                <NuxtLink :to="`/test-cases/${candidate.testCaseId}`" class="text-primary hover:underline font-medium">
                  {{ candidate.title }}
                </NuxtLink>
                <div class="text-xs text-muted">{{ candidate.rationale }}</div>
              </td>
              <td class="px-3 py-2 text-right whitespace-nowrap">
                <span v-if="candidate.dismissed" class="text-xs text-muted mr-2">dismissed</span>
                <QuarantineDismissButton
                  v-else-if="canQuarantine"
                  :project-id="projectId"
                  :test-case-id="candidate.testCaseId"
                  proposal="quarantine"
                  @dismissed="refresh()"
                />
                <CoverageLossPopover
                  v-if="canQuarantine"
                  :project-id="projectId"
                  :project-name="projectName"
                  :test-case-ids="[candidate.testCaseId]"
                  :active="coverageActive"
                >
                  <UButton
                    size="xs"
                    color="neutral"
                    variant="soft"
                    :loading="busy === candidate.testCaseId"
                    @click="quarantine(candidate.testCaseId, candidate.rationale)"
                  >
                    Quarantine
                  </UButton>
                </CoverageLossPopover>
              </td>
            </tr>
          </tbody>
        </table>
      </TableScroller>
    </SectionCard>
  </div>
</template>
