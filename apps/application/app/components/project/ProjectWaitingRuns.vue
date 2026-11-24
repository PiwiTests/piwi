<script setup lang="ts">
/**
 * The waiting rows above a project's runs (`useWaitingRuns`): each CI dispatch no run has answered yet, or whose run
 * goes on, and each of the viewer's own run requests still going on, which only they see. Five show, then **Show
 * all**. A dispatch that has waited long offers its likely causes behind **Why?**.
 */
import { safeHttpUrl } from '#shared/utils/safe-url';
import { WAITING_ROWS_SHOWN, type WaitingRunRow } from '~/utils/waiting-runs';

const props = defineProps<{ rows: WaitingRunRow[] }>();

const showAll = useViewState('runs:waiting-all', () => false);
const shownRows = computed(() => (showAll.value ? props.rows : props.rows.slice(0, WAITING_ROWS_SHOWN)));
</script>

<template>
  <div v-if="rows.length" class="mb-3 space-y-2" data-testid="waiting-runs" data-shot="waiting-runs">
    <ul class="space-y-2">
      <li
        v-for="row in shownRows"
        :key="`${row.kind}-${row.id}`"
        class="flex items-start gap-2 rounded-lg border border-dashed border-default px-3 py-2"
        :data-testid="`waiting-${row.kind}`"
      >
        <span :class="['size-2.5 rounded-full mt-1.5 shrink-0', STATUS_PALETTE[row.status].bg]" aria-hidden="true" />
        <div class="min-w-0 flex-1 text-sm text-highlighted leading-relaxed break-words">
          {{ row.lead }}
          <span class="text-xs text-muted">
            <template v-if="row.facts"> · {{ row.facts }}</template>
            · {{ row.kind === 'dispatch' ? 'dispatched' : 'sent' }}
            <ClientOnly>
              <span :title="prettyDateFormat(row.at)">{{ formatRelativeTime(row.at) }}</span>
              <template #fallback>{{ formatRelativeTime(row.at) }}</template>
            </ClientOnly>
            <template v-if="row.by"> by {{ row.by }}</template>
            <template v-if="row.kind === 'request'"> · only you see it</template>
            <template v-if="row.causes.length">
              ·
              <UPopover>
                <button type="button" :class="SENTENCE_LINK_CLASS" data-testid="waiting-causes">Why?</button>
                <template #content>
                  <div class="p-3 space-y-1 max-w-sm">
                    <p class="text-sm text-highlighted">Matching goes on for six hours. Most likely:</p>
                    <ul class="list-disc pl-5 text-sm text-highlighted space-y-0.5">
                      <li v-for="cause in row.causes" :key="cause">{{ cause }}</li>
                    </ul>
                    <DocLink to="features/ci-rerun#matching-the-run" no-icon :class="['text-xs', SENTENCE_LINK_CLASS]"
                      >How a run is matched</DocLink
                    >
                  </div>
                </template>
              </UPopover>
            </template>
            <template v-if="safeHttpUrl(row.ciUrl)">
              ·
              <a :href="safeHttpUrl(row.ciUrl)!" target="_blank" rel="noopener noreferrer" :class="SENTENCE_LINK_CLASS"
                >Open in CI</a
              >
            </template>
            <template v-if="row.run">
              ·
              <NuxtLink :to="`/test-runs/${row.run.id}`" :class="SENTENCE_LINK_CLASS"
                >Open run #{{ row.run.id }}</NuxtLink
              >
            </template>
          </span>
        </div>
      </li>
    </ul>
    <UButton
      v-if="rows.length > WAITING_ROWS_SHOWN"
      size="xs"
      color="neutral"
      variant="ghost"
      :label="showAll ? 'Show fewer' : `Show all ${rows.length}`"
      @click="showAll = !showAll"
    />
  </div>
</template>
