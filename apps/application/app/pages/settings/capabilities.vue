<script setup lang="ts">
/**
 * Settings → Capabilities: what a team wants Piwi for, and the capability
 * ladder, every optional capability grouped by whether it is active, available,
 * not set up yet or declined, with the one place to decline a capability for
 * this instance or to reconsider one.
 */
import type { SetupStatus, SetupCapabilityId } from '#shared/handlers/setup-status';
import {
  DESKTOP_HIDDEN_CAPABILITIES,
  type CapabilityId,
  type CapabilityState,
  type InstanceDecision,
} from '#shared/capabilities';
import { SETUP_CAPABILITIES, ladderGroupOf, type SetupCapabilityCopy } from '~/utils/setup-capabilities';

const isDesktop = useIsDesktop();

// The capability ladder is `settings:manage`, an administrator's; the auth
// middleware keeps everyone else off this page (`canOpenSettingsPath`).
const { can } = useAuth();
const {
  data: status,
  status: fetchStatus,
  refresh,
} = await useFetch<SetupStatus>('/api/setup-status', {
  lazy: true,
  immediate: can('settings:manage'),
  default: () => ({ capabilities: [] }) as SetupStatus,
});

// A decision through the presets or a ladder control changes the shared instance
// capabilities; re-read the setup status so the ladder regroups.
const { capabilities: instanceCaps, canDecide, decide: decideInstance } = await useInstanceCapabilities();
watch(instanceCaps, () => refresh(), { deep: true });

const isLoading = computed(() => fetchStatus.value === 'pending' && !status.value?.capabilities.length);

/** The two rows that are core evidence and carry no decline control. */
const CORE_IDS = new Set<SetupCapabilityId>(['reporter', 'clustering']);
const copyById = new Map<SetupCapabilityId, SetupCapabilityCopy>(SETUP_CAPABILITIES.map((c) => [c.id, c]));

interface LadderRow extends SetupCapabilityCopy {
  active: boolean;
  state: CapabilityState;
  decision: InstanceDecision | null;
  isNew: boolean;
  isCore: boolean;
}

const rows = computed<LadderRow[]>(() =>
  (status.value?.capabilities ?? [])
    .filter((c) => !(isDesktop && DESKTOP_HIDDEN_CAPABILITIES.has(c.id)))
    .map((c) => {
      const copy = copyById.get(c.id);
      return {
        ...(copy as SetupCapabilityCopy),
        active: c.active,
        state: c.state,
        decision: c.decision,
        isNew: c.isNew,
        isCore: CORE_IDS.has(c.id),
      };
    }),
);

const activeCount = computed(() => rows.value.filter((r) => r.active).length);

// The nudge on undecided capabilities counts the optional rows with neither data nor a decision.
const nudgeFacts = computed(() =>
  isLoading.value ? null : { undecided: rows.value.filter((r) => !r.isCore && r.state === 'undecided').length },
);

const GROUPS: { id: 'active' | 'available' | 'notset'; label: string }[] = [
  { id: 'active', label: 'Active' },
  { id: 'available', label: 'Available' },
  { id: 'notset', label: 'Not set up' },
];

const groups = computed(() =>
  GROUPS.map((g) => ({ ...g, rows: rows.value.filter((r) => ladderGroupOf(r.state) === g.id) })).filter(
    (g) => g.rows.length > 0,
  ),
);
const declinedRows = computed(() => rows.value.filter((r) => ladderGroupOf(r.state) === 'declined'));
const declinedOpen = ref(false);

const busy = ref(false);
async function decide(id: SetupCapabilityId, decision: 'declined' | null) {
  if (busy.value || CORE_IDS.has(id)) return;
  busy.value = true;
  try {
    await decideInstance(id as CapabilityId, decision);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="space-y-6" data-tour="capabilities-page">
    <!-- What a team wants Piwi for — declining a module declines its
         capabilities, which regroups the ladder below. -->
    <CapabilityPresets help="setup.presets" data-tour="capability-presets" />

    <AssistantNudge page="/settings/capabilities" :facts="nudgeFacts" />

    <UCard data-shot="setup-ladder">
      <template #header>
        <div class="flex items-center justify-between gap-3" data-tour="setup-ladder">
          <div class="flex items-center gap-3">
            <div class="p-2 bg-primary/10 rounded-lg shrink-0">
              <UIcon name="i-lucide-list-checks" class="size-5 text-primary" />
            </div>
            <div>
              <h2 class="text-xl font-semibold">What's switched on</h2>
              <p class="text-sm text-muted">
                Detected from your data, not your config — a capability reads as active once this instance has actually
                used it.
              </p>
            </div>
          </div>
          <UBadge v-if="!isLoading" color="neutral" variant="subtle" class="shrink-0 max-sm:hidden">
            {{ activeCount }} active
          </UBadge>
        </div>
      </template>

      <LoadingState v-if="isLoading" />

      <div v-else class="space-y-6">
        <!-- Active / Available / Not set up -->
        <section v-for="group in groups" :key="group.id">
          <h3 class="text-xs font-medium text-muted mb-2">{{ group.label }}</h3>
          <ul class="divide-y divide-default">
            <li v-for="row in group.rows" :key="row.id" class="flex gap-4 py-4 first:pt-0 last:pb-0">
              <div
                class="flex size-9 shrink-0 items-center justify-center rounded-lg"
                :class="row.active ? 'bg-success/10 text-success' : 'bg-elevated text-muted'"
              >
                <UIcon :name="row.icon" class="size-5" />
              </div>

              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2 flex-wrap mb-1">
                  <h4 class="font-medium text-highlighted">{{ row.title }}</h4>
                  <UBadge v-if="row.isNew" color="primary" variant="subtle" size="xs">New</UBadge>
                  <UBadge v-if="row.experimental" color="neutral" variant="subtle" size="xs">Experimental</UBadge>
                </div>

                <p class="text-sm text-highlighted leading-relaxed">{{ row.summary }}</p>
                <p v-if="row.experimental && row.experimentalNote" class="text-xs text-muted mt-1">
                  {{ row.experimentalNote }}
                </p>
                <p v-if="!row.active" class="text-xs text-muted mt-1">{{ row.how }}</p>

                <div class="flex items-center gap-3 mt-2 text-sm">
                  <UButton
                    v-if="row.to && !row.active"
                    :to="row.to"
                    size="xs"
                    color="neutral"
                    variant="soft"
                    icon="i-lucide-settings"
                  >
                    {{ row.toLabel ?? 'Configure' }}
                  </UButton>
                  <DocLink v-if="row.doc" :to="row.doc" class="text-sm">Docs</DocLink>
                  <!-- An active row that also carries a stored decline names it,
                       so an administrator can clear the stale decision. -->
                  <span v-if="row.active && row.decision === 'declined' && canDecide" class="text-xs text-muted">
                    Declined ·
                    <button type="button" :class="SENTENCE_LINK_CLASS" :disabled="busy" @click="decide(row.id, null)">
                      Reconsider
                    </button>
                  </span>
                  <!-- Every non-core row that is not active can be declined. -->
                  <button
                    v-else-if="!row.isCore && !row.active && canDecide"
                    type="button"
                    class="text-xs text-muted"
                    :class="SENTENCE_LINK_CLASS"
                    :disabled="busy"
                    @click="decide(row.id, 'declined')"
                  >
                    Not for this instance
                  </button>
                </div>
              </div>
            </li>
          </ul>
        </section>

        <!-- Declined — folded, each with Reconsider -->
        <section v-if="declinedRows.length > 0">
          <button
            type="button"
            class="flex items-center gap-1.5 text-xs font-medium text-muted"
            :aria-expanded="declinedOpen"
            @click="declinedOpen = !declinedOpen"
          >
            <UIcon
              :name="declinedOpen ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
              class="size-3.5 shrink-0"
            />
            Declined ({{ declinedRows.length }})
          </button>
          <ul v-if="declinedOpen" class="divide-y divide-default mt-2">
            <li v-for="row in declinedRows" :key="row.id" class="flex items-center gap-4 py-3 first:pt-0 last:pb-0">
              <div class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-elevated text-muted">
                <UIcon :name="row.icon" class="size-5" />
              </div>
              <div class="flex-1 min-w-0">
                <h4 class="font-medium text-highlighted">{{ row.title }}</h4>
                <p class="text-xs text-muted">{{ row.summary }}</p>
              </div>
              <button
                v-if="canDecide"
                type="button"
                class="text-sm shrink-0"
                :class="SENTENCE_LINK_CLASS"
                :disabled="busy"
                @click="decide(row.id, null)"
              >
                Reconsider
              </button>
            </li>
          </ul>
        </section>
      </div>
    </UCard>
  </div>
</template>
