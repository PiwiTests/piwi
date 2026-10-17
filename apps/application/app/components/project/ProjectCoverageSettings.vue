<script setup lang="ts">
/**
 * Project settings → Coverage: the coverage scope (the files every coverage
 * ratio counts, as include and exclude patterns) and the named areas of the
 * code (`front: apps/web/`), each counted apart on the coverage page, in the
 * trend and in the pull-request comment. Patterns use the CODEOWNERS syntax.
 */
import { DEFAULT_COVERAGE_EXCLUDES } from '@piwitests/core/coverage-scope';
import type { ProjectWithTestRuns } from '~~/types/api';
import { areasText, parseAreasText, parsePatternsText, patternsText } from '~/utils/combined-coverage';

const props = defineProps<{ project: ProjectWithTestRuns }>();
const emit = defineEmits<{ saved: [] }>();

const stored = () => ({
  include: patternsText(props.project.coverageScope?.include),
  exclude: patternsText(props.project.coverageScope?.exclude ?? [...DEFAULT_COVERAGE_EXCLUDES]),
  areas: areasText(props.project.coverageAreas),
});
const { state, dirty } = useStoredForm(stored);

const parsedAreas = computed(() => parseAreasText(state.value.areas));
const areasError = computed(() => ('error' in parsedAreas.value ? parsedAreas.value.error : undefined));

const { saving, save } = useProjectPatch(() => props.project.id);

async function submit() {
  if (!('areas' in parsedAreas.value)) return;
  // Only what changed is sent: a scope left as it was keeps its version, and the totals counted under it.
  const before = stored();
  const scopeChanged = state.value.include !== before.include || state.value.exclude !== before.exclude;
  const saved = await save(
    {
      ...(scopeChanged
        ? {
            coverageScope: {
              include: parsePatternsText(state.value.include),
              exclude: parsePatternsText(state.value.exclude),
            },
          }
        : {}),
      ...(state.value.areas !== before.areas ? { coverageAreas: parsedAreas.value.areas } : {}),
    },
    'Coverage settings saved',
  );
  if (saved) emit('saved');
}

function restoreDefaults() {
  state.value.include = '';
  state.value.exclude = DEFAULT_COVERAGE_EXCLUDES.join('\n');
}
</script>

<template>
  <UForm :state="state" @submit="submit">
    <SectionCard
      icon="i-lucide-scan-line"
      title="Coverage"
      subtitle="Which files coverage counts, and the areas of the code it counts apart"
      help="coverage.areas"
      data-shot="project-coverage-settings"
    >
      <div class="space-y-5">
        <UFormField
          label="Areas"
          name="areas"
          :error="areasError"
          description="One per line, name then patterns: “front: apps/web/, packages/ui/”. A file belongs to the first area that matches it. Each area gets its own row on the coverage page, its own line in the trend and its share of the pull request’s changed lines."
        >
          <UTextarea
            v-model="state.areas"
            :rows="4"
            autoresize
            class="w-full font-mono"
            placeholder="front: apps/web/&#10;back: src/Api/"
            aria-label="Coverage areas"
            data-testid="coverage-areas"
          />
        </UFormField>

        <UFormField label="Include" name="include" description="One pattern per line. Empty includes every file.">
          <UTextarea v-model="state.include" :rows="2" autoresize class="w-full font-mono" aria-label="Include" />
        </UFormField>

        <UFormField
          label="Exclude"
          name="exclude"
          description="One pattern per line; an exclude wins over an include. The defaults leave out tests, build output and generated sources."
        >
          <UTextarea v-model="state.exclude" :rows="4" autoresize class="w-full font-mono" aria-label="Exclude" />
        </UFormField>
      </div>

      <template #footer>
        <div class="flex flex-wrap justify-end gap-2">
          <UButton color="neutral" variant="ghost" icon="i-lucide-rotate-ccw" @click="restoreDefaults">
            Default scope
          </UButton>
          <UButton type="submit" icon="i-lucide-check" :loading="saving" :disabled="!dirty || !!areasError">
            Save changes
          </UButton>
        </div>
      </template>
    </SectionCard>
  </UForm>
</template>
