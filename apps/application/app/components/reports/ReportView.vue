<script setup lang="ts">
/**
 * A report bundle laid out as a document in the app: the same bands, widgets
 * and blocks the HTML, PDF and Markdown renderers draw, with the charts from
 * the shared chart geometry, so the preview and a download state the same facts.
 */
import { chartLabelAnchor, chartTickLabel, seriesGeometry } from '#shared/reports/chart';
import { makeFormatter } from '#shared/reports/format';
import { sentencesFor } from '#shared/reports/sentences';
import { reportSectionFileName } from '#shared/reports/build';
import {
  hasVerdictWidget,
  reportWidgets,
  type ReportBlock,
  type ReportBundle,
  type ReportTone,
} from '#shared/reports/types';
import type { VerdictTone } from '#shared/analytics/types';

const props = defineProps<{ bundle: ReportBundle }>();

const labels = computed(() => sentencesFor(props.bundle.language).labels);
const f = computed(() => makeFormatter(props.bundle.language, props.bundle.locale));
const runsLabel = computed(() => sentencesFor(props.bundle.language).metricLabel('runs', 'Runs'));
const showVerdict = computed(() => !hasVerdictWidget(props.bundle));

const TONE_TEXT: Record<ReportTone, string> = {
  good: STATUS_PALETTE.passed.text,
  bad: STATUS_PALETTE.failed.text,
  neutral: 'text-muted',
};
const VERDICT_DOT: Record<VerdictTone, string> = {
  good: PASS_RATE_TONES.good.bg,
  mixed: PASS_RATE_TONES.fair.bg,
  bad: PASS_RATE_TONES.poor.bg,
};

/** The widgets with a table or a series, each downloadable as its own workbook. */
const exportable = computed(
  () =>
    new Set(
      reportWidgets(props.bundle)
        .filter((w) => w.blocks.some((b) => b.kind === 'series' || (b.kind === 'table' && b.rows.length > 0)))
        .map((w) => w.key),
    ),
);

const toast = useToast();
const { saveBlob } = useDesktopDownload();

async function downloadSection(key: string) {
  const widget = reportWidgets(props.bundle).find((w) => w.key === key);
  if (!widget) return;
  try {
    const { renderWidgetXlsx, XLSX_CONTENT_TYPE } = await import('#shared/reports/render-xlsx');
    const bytes = await renderWidgetXlsx(widget, props.bundle);
    if (!bytes) return;
    await saveBlob(
      new Blob([bytes as BlobPart], { type: XLSX_CONTENT_TYPE }),
      reportSectionFileName(props.bundle, key),
    );
  } catch (error) {
    toast.add({ title: 'Couldn’t export the section', description: errorMessage(error), color: 'error' });
  }
}

const CHART = { width: 600, height: 150, left: 40, bottom: 18 };
type SeriesBlock = Extract<ReportBlock, { kind: 'series' }>;
function chart(block: SeriesBlock) {
  return seriesGeometry(block, CHART.width - CHART.left - 6, CHART.height - CHART.bottom - 6);
}
</script>

<template>
  <article class="space-y-6" data-testid="report-view" :lang="bundle.language">
    <header class="space-y-1">
      <p class="text-xs text-muted">{{ labels.qualityReport }} · {{ bundle.dashboard.name }}</p>
      <h2 class="text-lg sm:text-xl font-semibold text-highlighted">{{ bundle.title }}</h2>
      <p class="text-xs text-muted">
        {{ bundle.period.label }}
        <template v-if="bundle.comparison">
          · {{ labels.comparedWith.toLowerCase() }} {{ bundle.comparison.label }}</template
        >
      </p>
    </header>

    <div v-if="showVerdict" class="flex items-start gap-3">
      <span class="mt-1.5 size-2.5 shrink-0 rounded-full" :class="VERDICT_DOT[bundle.verdict.tone]" />
      <p class="text-sm text-highlighted leading-relaxed">{{ bundle.verdict.sentence }}</p>
    </div>

    <section v-for="band in bundle.bands" :key="band.title" class="space-y-4">
      <div>
        <h3 class="text-sm font-semibold text-highlighted">{{ band.title }}</h3>
        <p v-if="band.description" class="text-xs text-muted">{{ band.description }}</p>
      </div>

      <div v-for="widget in band.widgets" :key="widget.key" class="space-y-2" :data-report-widget="widget.key">
        <div class="flex items-center justify-between gap-2">
          <h4 class="text-xs font-medium text-muted">{{ widget.title }}</h4>
          <UButton
            v-if="exportable.has(widget.key)"
            label="Excel"
            size="xs"
            color="neutral"
            variant="ghost"
            :title="`Download ${widget.title} as an Excel workbook`"
            :data-testid="`report-section-xlsx-${widget.key}`"
            @click="downloadSection(widget.key)"
          />
        </div>
        <p v-for="note in widget.notes" :key="note" class="text-xs text-muted">{{ note }}</p>

        <template v-for="(block, i) in widget.blocks" :key="i">
          <div v-if="block.kind === 'text'" class="flex items-start gap-3">
            <span v-if="block.tone" class="mt-1.5 size-2.5 shrink-0 rounded-full" :class="VERDICT_DOT[block.tone]" />
            <p class="text-sm text-highlighted leading-relaxed">{{ block.text }}</p>
          </div>

          <StatTileGrid v-else-if="block.kind === 'stats'">
            <StatTile
              v-for="tile in block.tiles"
              :key="tile.label"
              :label="tile.label"
              :value="tile.value"
              :title="tile.definition ?? undefined"
            >
              <template v-if="tile.change || tile.note" #hint>
                <span v-if="tile.change" :class="TONE_TEXT[tile.tone]">{{ tile.change }}</span>
                <template v-if="tile.change && tile.note"> · </template>
                <span v-if="tile.note">{{ tile.note }}</span>
              </template>
            </StatTile>
          </StatTileGrid>

          <div v-else-if="block.kind === 'series'" class="space-y-1">
            <p v-if="block.summary" class="text-xs text-muted">{{ block.summary }}</p>
            <div class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
              <span v-for="line in chart(block).lines" :key="line.label" class="inline-flex items-center gap-1">
                <span class="inline-block size-2.5 rounded-full" :style="{ backgroundColor: line.color }" />
                {{ line.label }}
              </span>
            </div>
            <svg
              :viewBox="`0 0 ${CHART.width} ${CHART.height}`"
              class="block w-full h-auto"
              role="img"
              :aria-label="block.summary ?? widget.title"
            >
              <g :transform="`translate(${CHART.left},6)`">
                <g v-for="tick in chart(block).ticks" :key="tick.value">
                  <line
                    :x1="0"
                    :x2="chart(block).width"
                    :y1="tick.y"
                    :y2="tick.y"
                    class="stroke-gray-200 dark:stroke-gray-700"
                    stroke-dasharray="3 3"
                  />
                  <text :x="-6" :y="tick.y + 3" text-anchor="end" class="fill-gray-400 text-[10px]">
                    {{ chartTickLabel(block, tick.value, f) }}
                  </text>
                </g>
                <line
                  v-for="m in chart(block).markers"
                  :key="`${m.x}-${m.label}`"
                  :x1="m.x"
                  :x2="m.x"
                  :y1="0"
                  :y2="chart(block).height"
                  :stroke="STATUS_PALETTE.flaky.color"
                  stroke-dasharray="2 2"
                >
                  <title>{{ m.label }}</title>
                </line>
                <template v-for="line in chart(block).lines" :key="line.label">
                  <polyline
                    v-for="(run, r) in line.runs"
                    :key="r"
                    :points="run.map(([x, y]) => `${x},${y}`).join(' ')"
                    fill="none"
                    :stroke="line.color"
                    :stroke-width="line.faint ? 1.5 : 2"
                    :stroke-dasharray="line.faint ? '4 3' : undefined"
                  />
                </template>
                <text
                  v-for="lab in chart(block).labels"
                  :key="lab.date"
                  :x="lab.x"
                  :y="chart(block).height + 13"
                  :text-anchor="chartLabelAnchor(lab.x, chart(block).width)"
                  class="fill-gray-400 text-[10px]"
                >
                  {{ f.day(lab.date) }}
                </text>
              </g>
            </svg>
          </div>

          <TableScroller v-else-if="block.kind === 'table' && block.rows.length > 0">
            <table class="w-full text-sm">
              <thead>
                <tr class="border-b border-default">
                  <th
                    v-for="col in block.columns"
                    :key="col.key"
                    class="py-1.5 px-2 text-xs font-medium text-muted"
                    :class="col.align === 'right' ? 'text-right' : 'text-left'"
                  >
                    {{ col.label }}
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(row, r) in block.rows" :key="r" class="border-b border-default last:border-0">
                  <td
                    v-for="(col, c) in block.columns"
                    :key="col.key"
                    class="py-1.5 px-2 align-top"
                    :class="col.align === 'right' ? 'text-right tabular-nums whitespace-nowrap' : 'text-left'"
                  >
                    <a
                      v-if="c === 0 && row.link"
                      :href="row.link"
                      class="underline decoration-dotted underline-offset-2 hover:decoration-solid"
                      >{{ row.cells[col.key] }}</a
                    >
                    <template v-else>{{ row.cells[col.key] }}</template>
                  </td>
                </tr>
              </tbody>
            </table>
          </TableScroller>

          <ul v-else-if="block.kind === 'list'" class="space-y-1.5">
            <li
              v-for="(item, k) in block.items"
              :key="k"
              class="border-l-2 pl-2 text-sm text-highlighted leading-relaxed"
              :class="
                item.tone === 'bad'
                  ? 'border-status-failed'
                  : item.tone === 'good'
                    ? 'border-status-passed'
                    : 'border-default'
              "
            >
              <a
                v-if="item.link"
                :href="item.link"
                class="underline decoration-dotted underline-offset-2 hover:decoration-solid"
                >{{ item.text }}</a
              >
              <template v-else>{{ item.text }}</template>
              <p v-if="item.detail" class="text-xs text-muted">{{ item.detail }}</p>
            </li>
          </ul>
        </template>
      </div>
    </section>

    <footer class="space-y-3 border-t border-default pt-4 text-xs text-muted">
      <dl class="grid grid-cols-1 sm:grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
        <dt class="font-medium">{{ labels.projects }}</dt>
        <dd>{{ bundle.scopeText.projects }}</dd>
        <dt class="font-medium">{{ labels.branchPolicy }}</dt>
        <dd>{{ bundle.scopeText.branches }}</dd>
        <template v-if="bundle.scopeText.environments">
          <dt class="font-medium">{{ labels.environmentPolicy }}</dt>
          <dd>{{ bundle.scopeText.environments }}</dd>
        </template>
        <dt class="font-medium">{{ runsLabel }}</dt>
        <dd>{{ bundle.scopeText.runs }}</dd>
        <template v-if="bundle.scopeText.tests">
          <dt class="font-medium">{{ labels.testFilter }}</dt>
          <dd>{{ bundle.scopeText.tests }}</dd>
        </template>
      </dl>
      <div v-if="bundle.targets?.length" data-testid="report-targets">
        <p class="font-medium">{{ labels.targets }}</p>
        <ul class="list-disc pl-4">
          <li v-for="t in bundle.targets" :key="`${t.projectId}:${t.metric}`">{{ t.text }}</li>
        </ul>
      </div>
      <div v-if="bundle.definitions.length">
        <p class="font-medium">{{ labels.definitions }}</p>
        <dl class="grid grid-cols-1 sm:grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
          <template v-for="d in bundle.definitions" :key="d.id">
            <dt>{{ d.label }}</dt>
            <dd>{{ d.definition }}</dd>
          </template>
        </dl>
      </div>
      <div v-if="bundle.limits.length">
        <p class="font-medium">{{ labels.limits }}</p>
        <ul class="list-disc pl-4">
          <li v-for="limit in bundle.limits" :key="limit">{{ limit }}</li>
        </ul>
      </div>
    </footer>
  </article>
</template>
