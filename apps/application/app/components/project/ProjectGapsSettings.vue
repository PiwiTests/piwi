<script setup lang="ts">
/**
 * Project settings → Capabilities → Scenario gaps: the OpenAPI document whose
 * routes become declared Test Map nodes, and the experimental server probes.
 * Each part follows its capability (`test-map`, `server-probes`) and the card
 * renders nothing when both are hidden.
 */
import type { ProjectWithTestRuns } from '~~/types/api';

const props = defineProps<{ project: ProjectWithTestRuns; showOpenApi: boolean; showServerProbes: boolean }>();
const emit = defineEmits<{ saved: [] }>();

// Faults and routes are comma-separated in the form and split into lists on save.
const { state, dirty } = useStoredForm(() => {
  const probes = props.project.serverProbes;
  return {
    openApiUrl: props.project.openApiUrl || '',
    serverProbes: {
      enabled: probes?.enabled ?? false,
      faults: (probes?.faults ?? []).join(', '),
      routes: (probes?.routes ?? []).join(', '),
      dependencyOnStateChanging: probes?.dependencyOnStateChanging ?? false,
    },
  };
});

function splitCommaList(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const { saving, save } = useProjectPatch(() => props.project.id);

async function submit() {
  const probes = state.value.serverProbes;
  const stored = await save(
    {
      openApiUrl: state.value.openApiUrl || null,
      serverProbes: {
        enabled: probes.enabled,
        faults: splitCommaList(probes.faults),
        routes: splitCommaList(probes.routes),
        dependencyOnStateChanging: probes.dependencyOnStateChanging,
      },
    },
    'Scenario gaps saved',
  );
  if (stored) emit('saved');
}
</script>

<template>
  <UForm v-if="showOpenApi || showServerProbes" :state="state" @submit="submit">
    <SectionCard
      icon="i-lucide-radar"
      title="Scenario gaps"
      subtitle="What the Coverage tab’s gaps compare the tests against"
      data-shot="project-gaps-settings"
    >
      <div class="space-y-5">
        <UFormField
          v-if="showOpenApi"
          label="OpenAPI document URL"
          name="openApiUrl"
          description="Declared surface. Fetched server-side; its routes and documented response codes become declared graph nodes, so a route the spec documents but no test reaches is a gap. Leave empty to skip."
        >
          <UInput
            v-model="state.openApiUrl"
            placeholder="e.g. https://app.example.com/openapi.json"
            class="w-full font-mono"
          />
        </UFormField>

        <UFormField
          v-if="showServerProbes"
          name="serverProbes"
          description="Level-two probes inject a fault inside the server for one signed request, to check whether a passing test would notice. Experimental and off by default: the entry condition (client probes reporting not-noticed on at least one in ten pairs) has not been measured yet. Needs a shared probe secret on the app under test and the probe runner, and a non-production target."
        >
          <template #label>
            <span class="inline-flex items-center gap-1">
              Server probes <UBadge color="neutral" variant="subtle" size="xs">Experimental</UBadge>
            </span>
          </template>
          <div class="space-y-3">
            <USwitch v-model="state.serverProbes.enabled" label="Enable server probes for this project" />
            <div v-if="state.serverProbes.enabled" class="space-y-3">
              <UInput
                v-model="state.serverProbes.faults"
                placeholder="allowed faults, comma-separated — e.g. throw, status, delay, dependency"
                aria-label="Allowed faults"
                class="w-full font-mono"
              />
              <UInput
                v-model="state.serverProbes.routes"
                placeholder="allowed routes, comma-separated — blank allows every reached route"
                aria-label="Allowed routes"
                class="w-full font-mono"
              />
              <USwitch
                v-model="state.serverProbes.dependencyOnStateChanging"
                label="Allow dependency faults on state-changing routes (needs an ephemeral or staging database)"
              />
            </div>
          </div>
        </UFormField>
      </div>

      <template #footer>
        <div class="flex justify-end">
          <UButton type="submit" icon="i-lucide-check" :loading="saving" :disabled="!dirty">Save changes</UButton>
        </div>
      </template>
    </SectionCard>
  </UForm>
</template>
