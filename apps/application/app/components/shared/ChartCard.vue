<script setup lang="ts">
/**
 * Thin wrapper over `SectionCard` for the SVG trend charts. Gives every chart
 * the standard header (icon / title / subtitle / help / actions) and renders the
 * `legend` there, so the color key reads as part of the heading instead of
 * costing a row under the plot. The export menu copies the chart as a PNG and,
 * given `exportData`, downloads its series as an Excel workbook.
 *
 * With `foldKey`, the card is a `CollapsibleSectionCard`: folded by default to
 * its header and the `#folded` peek, its fold state kept per user in the cookie
 * `piwi-section-fold-<foldKey>`, and its legend and actions shown only while it
 * is open.
 */
import type { HelpTopicKey } from '~/utils/help-content';
import { chartFileName, chartPng, chartXlsx, copyPng, type ChartExportData } from '~/utils/chart-export';
import SectionCard from './SectionCard.vue';
import CollapsibleSectionCard from './CollapsibleSectionCard.vue';

const props = withDefaults(
  defineProps<{
    title: string;
    subtitle?: string;
    icon?: string;
    /** Tailwind color class for the header icon. */
    iconClass?: string;
    /** Inline-help topic rendered next to the title. */
    help?: HelpTopicKey;
    /** Color key for the plotted series, rendered in the header. */
    legend?: readonly { color: string; label: string }[];
    /** The chart's series as a table, for the Excel download; unset offers the PNG only. */
    exportData?: ChartExportData | null;
    /** Whether the chart is drawn as an SVG the PNG export can copy; a grid of cells is not. */
    png?: boolean;
    /** Fold the card to one line, its state kept per user under this key. */
    foldKey?: string;
  }>(),
  { png: true },
);

const cardComponent = computed(() => (props.foldKey ? CollapsibleSectionCard : SectionCard));
const cardBind = computed(() => ({
  title: props.title,
  subtitle: props.subtitle,
  icon: props.icon,
  iconClass: props.iconClass,
  help: props.help,
  ...(props.foldKey ? { storageKey: props.foldKey, hideActionsWhenFolded: true } : {}),
}));

// A folding card unfolds and scrolls into view on request.
const card = ref<{ reveal?: () => void } | null>(null);
defineExpose({ reveal: () => card.value?.reveal?.() });

const body = ref<HTMLElement | null>(null);
const toast = useToast();
const { saveBlob } = useDesktopDownload();

async function copyImage() {
  if (!body.value) return;
  try {
    const png = await chartPng(body.value, props.title);
    if (await copyPng(png)) {
      toast.add({ title: 'Chart copied as PNG', color: 'success' });
    } else {
      await saveBlob(png, `${chartFileName(props.exportData?.name ?? props.title)}.png`);
      toast.add({ title: 'Chart downloaded as PNG', description: 'This browser does not copy images.' });
    }
  } catch (error) {
    toast.add({ title: 'Couldn’t export the chart', description: errorMessage(error), color: 'error' });
  }
}

async function downloadXlsx() {
  if (!props.exportData) return;
  try {
    await saveBlob(await chartXlsx(props.exportData, props.title), `${chartFileName(props.exportData.name)}.xlsx`);
  } catch (error) {
    toast.add({ title: 'Couldn’t export the chart', description: errorMessage(error), color: 'error' });
  }
}

const exportItems = computed(() => [
  [
    ...(props.png ? [{ label: 'Copy as PNG', icon: 'i-lucide-image', onSelect: copyImage }] : []),
    ...(props.exportData?.rows.length
      ? [{ label: 'Download Excel', icon: 'i-lucide-file-spreadsheet', onSelect: downloadXlsx }]
      : []),
  ],
]);
</script>

<template>
  <component :is="cardComponent" ref="card" v-bind="cardBind">
    <template v-if="$slots.subtitle" #subtitle>
      <slot name="subtitle" />
    </template>
    <template v-if="foldKey && $slots.folded" #folded>
      <slot name="folded" />
    </template>
    <template #actions>
      <ChartLegend v-if="legend?.length" :items="legend" />
      <slot name="actions" />
      <UDropdownMenu v-if="exportItems[0]!.length > 0" :items="exportItems" :content="{ align: 'end' }">
        <UButton
          icon="i-lucide-ellipsis-vertical"
          color="neutral"
          variant="ghost"
          size="xs"
          :aria-label="`Export ${title}`"
          title="Export this chart"
          data-testid="chart-export"
          data-tour="chart-export"
        />
        <template #content-bottom>
          <div class="flex items-center gap-1 px-2.5 py-1.5 text-xs text-muted border-t border-default">
            About chart export
            <HelpHint topic="chart.export" />
          </div>
        </template>
      </UDropdownMenu>
    </template>
    <div ref="body">
      <slot />
    </div>
    <template v-if="$slots.footer" #footer>
      <slot name="footer" />
    </template>
  </component>
</template>
