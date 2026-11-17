<script setup lang="ts">
/**
 * Desktop shell only: how a local folder stands with Piwi — the Playwright and
 * `@piwitests/reporter` setup checks from a `DesktopFolderInspection`, one row
 * per check. Warnings are guidance, not blockers: a project can be created or
 * linked first and set up after.
 */
import type { DesktopFolderInspection } from '~/composables/useDesktopFolderInspect';

const props = defineProps<{ inspection: DesktopFolderInspection }>();

const { copy } = useCopy();

interface Check {
  ok: boolean;
  label: string;
  /** Extra context shown dimmed after the label. */
  detail?: string;
}

const checks = computed<Check[]>(() => {
  const i = props.inspection;
  return [
    i.playwrightConfig
      ? { ok: true, label: 'Playwright config found', detail: i.playwrightConfig }
      : { ok: false, label: 'No Playwright config at the folder root' },
    i.playwrightInstalled
      ? { ok: true, label: 'Playwright is installed' }
      : { ok: false, label: 'Playwright is not installed', detail: 'run your package manager’s install first' },
    i.reporterInstalled
      ? { ok: true, label: 'Piwi reporter is installed', detail: '@piwitests/reporter' }
      : { ok: false, label: 'Piwi reporter is not installed' },
    i.reporterConfigured
      ? {
          ok: true,
          label: 'Config sends results to Piwi',
          detail: i.configuredProjectName
            ? `projectName: ${i.configuredProjectName}`
            : i.projectNameComputed
              ? 'projectName: computed by the config, with the run variables of the project it runs for'
              : undefined,
        }
      : { ok: false, label: 'Config does not use the Piwi reporter' },
  ];
});

const ready = computed(() => checks.value.every((c) => c.ok));

/**
 * One command fixes both "not installed" and "not configured". Invoked through
 * the package name so npx resolves this package even before it is a dependency
 * — a plain `npx piwi` would fetch an unrelated `piwi` from the registry.
 */
const showInitHint = computed(() => !props.inspection.reporterInstalled || !props.inspection.reporterConfigured);
const INIT_COMMAND = 'npx @piwitests/reporter init';
</script>

<template>
  <div class="space-y-2">
    <ul class="space-y-1.5">
      <li v-for="check in checks" :key="check.label" class="flex items-center gap-2 text-sm">
        <UIcon
          :name="check.ok ? 'i-lucide-circle-check-big' : 'i-lucide-triangle-alert'"
          class="size-4 shrink-0"
          :class="check.ok ? 'text-success' : 'text-warning'"
        />
        <span :class="check.ok ? '' : 'text-warning'">{{ check.label }}</span>
        <span v-if="check.detail" class="text-xs text-muted truncate" :title="check.detail">{{ check.detail }}</span>
      </li>
    </ul>

    <p v-if="showInitHint" class="flex flex-wrap items-center gap-1.5 text-xs text-muted">
      <span>Set it up from a terminal in that folder:</span>
      <span class="inline-flex items-center gap-0.5">
        <code class="px-1.5 py-0.5 rounded bg-elevated font-mono">{{ INIT_COMMAND }}</code>
        <UButton
          icon="i-lucide-copy"
          color="neutral"
          variant="ghost"
          size="xs"
          aria-label="Copy setup command"
          @click="copy(INIT_COMMAND, { toast: true })"
        />
      </span>
      <DocLink to="guide/reporter" class="text-xs">Reporter docs</DocLink>
    </p>
    <p v-else-if="ready" class="flex items-center gap-1.5 text-xs text-muted">
      <UIcon name="i-lucide-sparkles" class="size-3.5 text-success" />
      Runs from this folder will report to Piwi.
    </p>
  </div>
</template>
