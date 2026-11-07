<script setup lang="ts">
/**
 * Settings → Capabilities: the capabilities that stay off until an administrator turns them on for this instance
 * (`optIn`). Each reads On or Off with **Turn on** or **Turn off**; a project declines one in its own settings. One
 * that needs sign-in cannot be turned on while sign-in is off.
 */
import { CAPABILITIES, CAPABILITY_BY_ID, type CapabilityId } from '#shared/capabilities';

interface OptInCopy {
  title: string;
  summary: string;
  doc: string;
}

/** Each opt-in capability's words on this page. */
const COPY: Partial<Record<CapabilityId, OptInCopy>> = {
  'machine-runs': {
    title: 'Run on my machine',
    summary:
      'A signed-in person asks the desktop app on their own machine to run tests from the dashboard; the app asks them before every run. The run is theirs alone and stays out of everything the team sees.',
    doc: 'features/run-on-my-machine',
  },
};

const isDesktop = useIsDesktop();
const authEnabled = useRuntimeConfig().public.authEnabled === true;
const { capabilities, canDecide, decide } = await useInstanceCapabilities();
const toast = useToast();

/** On only once the instance says so: a list that failed to load reads every one as off. */
const isOn = (id: CapabilityId) => capabilities.value.some((c) => c.id === id && c.state !== 'declined');

const rows = computed(() =>
  CAPABILITIES.filter((c) => c.optIn && !(isDesktop && c.hiddenOnDesktop))
    .map((c) => ({ id: c.id, copy: COPY[c.id] }))
    .filter((r): r is { id: CapabilityId; copy: OptInCopy } => r.copy !== undefined)
    .map((r) => ({ ...r, on: isOn(r.id), blocked: CAPABILITY_BY_ID[r.id].needsSignIn === true && !authEnabled })),
);

const busy = ref(false);
async function turn(id: CapabilityId, on: boolean) {
  if (busy.value) return;
  busy.value = true;
  try {
    await decide(id, on ? 'enabled' : null);
  } catch {
    toast.add({ title: on ? 'Could not turn it on' : 'Could not turn it off', color: 'error' });
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <SectionCard
    v-if="rows.length > 0"
    icon="i-lucide-toggle-left"
    title="Off until turned on"
    subtitle="These capabilities stay off until an administrator turns them on for this instance."
    data-shot="opt-in-capabilities"
  >
    <ul class="divide-y divide-default">
      <li
        v-for="row in rows"
        :key="row.id"
        class="flex flex-col sm:flex-row sm:items-start gap-3 py-4 first:pt-0 last:pb-0"
      >
        <div class="flex-1 min-w-0">
          <h4 class="text-sm font-semibold text-highlighted">{{ row.copy.title }}</h4>
          <p class="text-sm text-highlighted leading-relaxed">{{ row.copy.summary }}</p>
          <p class="text-xs text-muted mt-1">
            {{ row.on ? 'On for this instance' : 'Off' }}
            <template v-if="row.blocked && !row.on"> · Needs sign-in turned on (PIWI_AUTH_ENABLED)</template>
            · <DocLink :to="row.copy.doc" class="text-xs">Docs</DocLink>
          </p>
        </div>
        <UButton
          v-if="canDecide"
          size="sm"
          color="neutral"
          variant="outline"
          class="shrink-0"
          :label="row.on ? 'Turn off' : 'Turn on'"
          :disabled="busy || (!row.on && row.blocked)"
          @click="turn(row.id, !row.on)"
        />
      </li>
    </ul>
  </SectionCard>
</template>
