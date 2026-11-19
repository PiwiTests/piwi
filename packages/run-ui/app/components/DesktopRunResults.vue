<script setup lang="ts">
/**
 * The tests of a finished run and how each came out, the same in both hosts (the dashboard's Local runs tray, Piwi
 * Runner's runs): each row has its outcome's mark in its one color (`STATUS_PALETTE`), named for a screen reader, its
 * title, the first lines of its first error (`runErrorLines`), its place and its project. The first `limit` rows show,
 * and **Show N more** the rest, the keyboard going to the first of them. A host makes a row's place a link (`#place`) and adds its actions (`#actions`): the dashboard's
 * Open, Run again and Hold failures; Piwi Runner adds none.
 */
import { STATUS_PALETTE, type StatusPaletteKey } from '@piwitests/run-ui/status-palette';
import type { RunResultRow } from '@piwitests/run-ui/run-output';
import type { RunUiPlainKey } from '../utils/run-ui-words';

const props = withDefaults(defineProps<{ rows: readonly RunResultRow[]; limit?: number }>(), { limit: 5 });

const { t, tn } = useRunUiWords();
const all = ref(false);
const list = useTemplateRef<HTMLElement>('list');
const shown = computed(() => (all.value ? props.rows : props.rows.slice(0, props.limit)));
const hidden = computed(() => props.rows.length - shown.value.length);

/** Each outcome's mark: its icon, its palette entry (none for `unknown`) and its words. */
const MARKS: Record<RunResultRow['status'], { icon: string; palette: StatusPaletteKey | null; label: RunUiPlainKey }> =
  {
    passed: { icon: 'i-lucide-circle-check', palette: 'passed', label: 'runui_resultPassed' },
    failed: { icon: 'i-lucide-circle-x', palette: 'failed', label: 'runui_resultFailed' },
    flaky: { icon: 'i-lucide-circle-alert', palette: 'flaky', label: 'runui_resultFlaky' },
    skipped: { icon: 'i-lucide-circle-minus', palette: 'skipped', label: 'runui_resultSkipped' },
    interrupted: { icon: 'i-lucide-circle-stop', palette: 'interrupted', label: 'runui_resultInterrupted' },
    'did-not-run': { icon: 'i-lucide-circle-dashed', palette: 'didnotrun', label: 'runui_resultDidNotRun' },
    unknown: { icon: 'i-lucide-circle-help', palette: null, label: 'runui_resultUnknown' },
  };

async function showAll() {
  const first = shown.value.length;
  all.value = true;
  await nextTick();
  list.value?.querySelectorAll<HTMLElement>('li')[first]?.focus();
}

function markOf(row: RunResultRow) {
  const mark = MARKS[row.status];
  return { ...mark, text: mark.palette ? STATUS_PALETTE[mark.palette].text : 'text-muted' };
}
</script>

<template>
  <div class="space-y-1" data-testid="run-results">
    <ul
      ref="list"
      :aria-label="t('runui_resultsLabel')"
      class="divide-y divide-default rounded-md border border-default"
    >
      <li
        v-for="row in shown"
        :key="row.key"
        tabindex="-1"
        class="flex flex-wrap items-start gap-x-2 gap-y-1 px-3 py-2 focus-visible:outline-2 focus-visible:outline-primary"
        :data-status="row.status"
        data-testid="run-result"
      >
        <span role="img" :aria-label="t(markOf(row).label)" class="mt-0.5 flex shrink-0">
          <UIcon :name="markOf(row).icon" class="size-4" :class="markOf(row).text" />
        </span>
        <div class="min-w-0 flex-1 basis-48">
          <p class="text-sm break-words text-highlighted">{{ row.title }}</p>
          <p
            v-for="(line, index) in row.error"
            :key="index"
            class="font-mono text-xs break-words whitespace-pre-wrap"
            :class="index === 0 ? 'text-error' : 'text-muted'"
          >
            {{ line }}
          </p>
          <div class="flex min-w-0 flex-wrap items-baseline gap-x-2 text-xs text-muted">
            <slot name="place" :row="row">
              <code v-if="row.place" class="font-mono break-all">{{ row.place }}</code>
            </slot>
            <span v-if="row.project">{{ row.project }}</span>
          </div>
        </div>
        <div class="ml-auto flex shrink-0 items-center gap-1">
          <slot name="actions" :row="row" />
        </div>
      </li>
    </ul>
    <UButton v-if="hidden > 0" size="xs" color="neutral" variant="ghost" @click="showAll">
      {{ tn('runui_resultsMore', hidden) }}
    </UButton>
  </div>
</template>
