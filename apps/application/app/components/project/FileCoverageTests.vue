<script setup lang="ts">
/**
 * The tests panel of a file's coverage page: with no line selected, every
 * test that ran the version shown; with a line or a range selected, the tests
 * that ran at least one of its lines, each with its latest outcome. On lines
 * no test runs it says so, and names the nearest test to copy when one runs
 * the function around them. The first 50 show; the rest unfold.
 */
import type { LineRange } from '@piwitests/core/coverage';
import type { LocatorIndexTest } from '#shared/locator-index';
import { intersectLineRanges } from '@piwitests/core/coverage';
import { linesText, testsOnLines, type FileCoverageVersion } from '~/utils/file-coverage';

const props = defineProps<{
  projectId: number;
  projectName?: string | null;
  /** Every test the file's coverage names; the version and its fragments hold positions in it. */
  tests: LocatorIndexTest[];
  version: FileCoverageVersion;
  selection: LineRange | null;
  /** The nearest test to copy, when no test ran the selection and one runs the code around it. */
  nearest?: { testCaseId: number; title: string; filePath: string; status: LocatorIndexTest['status'] } | null;
  /** What the nearest test runs around the selection, in one sentence. */
  nearestSentence?: string | null;
}>();

const emit = defineEmits<{ clear: [] }>();

const SHOWN = 50;
const showAll = ref(false);
watch(
  () => [props.selection, props.version.key],
  () => (showAll.value = false),
);

const rows = computed(() => {
  const positions = props.selection ? testsOnLines(props.version, props.selection) : props.version.tests;
  return positions.flatMap((p) => (props.tests[p] ? [props.tests[p]!] : []));
});
const shown = computed(() => (showAll.value ? rows.value : rows.value.slice(0, SHOWN)));

/** Whether the run's executable lines say the selection holds no executable code. */
const notExecutable = computed(
  () =>
    props.selection != null &&
    props.version.executable != null &&
    intersectLineRanges(props.version.executable, [props.selection]).length === 0,
);

const subtitle = computed(() => {
  const total = props.version.tests.length;
  if (!props.selection) {
    return `Every test that ran this version of the file. Select a line, or Shift-click a range, for the tests that ran it.`;
  }
  const where = linesText(props.selection);
  const lead = where.charAt(0).toUpperCase() + where.slice(1);
  if (rows.value.length === 0) {
    return notExecutable.value ? `${lead} holds no executable code.` : `No test runs ${where}.`;
  }
  const single = props.selection[0] === props.selection[1];
  const of =
    rows.value.length === total
      ? total === 1
        ? 'The one test'
        : `All ${total} tests`
      : `${rows.value.length} of the ${total} tests`;
  return single ? `${lead}: ${of} ran it.` : `${lead}: ${of} ran at least one of them.`;
});

const nearestTest = computed(() =>
  props.nearest && rows.value.length === 0 && !notExecutable.value
    ? {
        id: props.nearest.testCaseId,
        title: props.nearest.title,
        file: props.nearest.filePath,
        status: props.nearest.status,
      }
    : null,
);
</script>

<template>
  <SectionCard title="Tests" icon="i-lucide-list-checks" :count="rows.length" data-shot="coverage-file-tests">
    <template #subtitle>
      <span data-testid="coverage-file-selection">{{ subtitle }}</span>
    </template>
    <template v-if="selection" #actions>
      <UButton size="xs" color="neutral" variant="ghost" label="All tests" @click="emit('clear')" />
    </template>

    <ul v-if="shown.length" class="divide-y divide-default" data-coverage-tests>
      <li v-for="test in shown" :key="test.id" class="py-1.5" :data-coverage-test="test.title">
        <CoverageTestRow :test="test" :project-id="projectId" :project-name="projectName" />
      </li>
    </ul>
    <UButton
      v-if="rows.length > shown.length"
      size="xs"
      color="neutral"
      variant="ghost"
      class="mt-1"
      :label="`Show all ${rows.length}`"
      @click="showAll = true"
    />

    <div v-if="nearestTest" class="space-y-1" data-nearest-test>
      <p class="text-sm font-semibold text-highlighted">Nearest test to copy</p>
      <CoverageTestRow :test="nearestTest" :project-id="projectId" :project-name="projectName" />
      <p v-if="nearestSentence" class="pl-4 text-xs text-muted">{{ nearestSentence }}</p>
    </div>
    <p v-else-if="selection && rows.length === 0" class="text-xs text-muted">
      {{
        notExecutable
          ? 'Coverage marks statements only, not blank lines, comments or declarations.'
          : 'No test runs a function around it either, so there is no nearest test to copy.'
      }}
    </p>
  </SectionCard>
</template>
