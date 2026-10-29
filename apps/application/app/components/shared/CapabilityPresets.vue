<script setup lang="ts">
/**
 * "What do you want Piwi for?" — the coarse capability presets, shown on the
 * Setup page and in the Home wizard. Seeing why tests fail is always on; the
 * other three modules are opt-out checkboxes. Unchecking a module declines
 * every capability in it at instance level; re-checking clears those decisions.
 * A module whose capabilities are only partly declined shows indeterminate.
 *
 * Renders nothing unless the viewer may decide (administrators, and everyone
 * when auth is disabled).
 */
import type { HelpTopicKey } from '~/utils/help-content';
import type { CapabilityId, InstanceDecision } from '#shared/capabilities';
import {
  CAPABILITY_PRESETS,
  DESKTOP_HIDDEN_CAPABILITIES,
  capabilitiesForModule,
  type CapabilityModule,
} from '#shared/capabilities';

defineProps<{
  /** Inline-help topic rendered beside the heading. */
  help?: HelpTopicKey;
}>();

const isDesktop = useIsDesktop();
const { state, canDecide, decideMany } = await useInstanceCapabilities();

const busy = ref(false);

/** The module's capabilities this build offers. */
function moduleCapabilities(module: CapabilityModule): CapabilityId[] {
  return capabilitiesForModule(module).filter((id) => !(isDesktop && DESKTOP_HIDDEN_CAPABILITIES.has(id)));
}

function declinedCount(module: CapabilityModule): number {
  return moduleCapabilities(module).filter((id) => state(id) === 'declined').length;
}

/** A module is on unless every capability in it is declined. */
function isOn(module: CapabilityModule): boolean {
  return declinedCount(module) < moduleCapabilities(module).length;
}

/** Some capabilities in the module are declined and some are not. */
function isMixed(module: CapabilityModule): boolean {
  const declined = declinedCount(module);
  return declined > 0 && declined < moduleCapabilities(module).length;
}

async function toggle(module: CapabilityModule, checked: boolean) {
  if (busy.value) return;
  busy.value = true;
  try {
    const decision: InstanceDecision | null = checked ? null : 'declined';
    const decisions: Partial<Record<CapabilityId, InstanceDecision | null>> = {};
    for (const id of moduleCapabilities(module)) decisions[id] = decision;
    await decideMany(decisions);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <SectionCard v-if="canDecide" title="What do you want Piwi for?" :help="help" embedded>
    <div class="flex flex-col gap-3">
      <div v-for="preset in CAPABILITY_PRESETS" :key="preset.module" class="flex items-start gap-3">
        <UCheckbox
          :model-value="preset.module === 'core' ? true : isOn(preset.module) && !isMixed(preset.module)"
          :indeterminate="preset.module === 'core' ? false : isMixed(preset.module)"
          :disabled="preset.module === 'core' || busy"
          :aria-label="preset.label"
          class="mt-0.5 shrink-0"
          @update:model-value="toggle(preset.module, $event === true)"
        />
        <div class="min-w-0">
          <p class="text-sm text-highlighted leading-relaxed">{{ preset.label }}</p>
          <p class="text-xs text-muted">
            {{ (isDesktop && preset.desktopDescription) || preset.description }}
          </p>
        </div>
      </div>
    </div>
  </SectionCard>
</template>
