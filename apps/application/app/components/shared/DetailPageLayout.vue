<script setup lang="ts">
import type { HelpTopicKey } from '~/utils/help-content';

export interface DetailTabItem {
  label: string;
  icon?: string;
  value: string;
  slot?: string;
  /** Kept visible but not selectable — a tab that has nothing to show for this record. */
  disabled?: boolean;
  /** Why the tab is disabled; rendered as muted text beside the label (native
   *  disabled buttons swallow hover, so a tooltip would never appear). */
  disabledReason?: string;
  /** Inline-help topic for the tab; rendered beside the strip while the tab is active. */
  help?: HelpTopicKey;
}

const props = defineProps<{
  tabItems: DetailTabItem[];
  tabPanelClass?: Record<string, string>;
}>();

const activeTab = defineModel<string>({ required: true });

// Mobile only: let the user fold the (often tall) summary away so the tab
// content is reachable without a long scroll. Ignored at `lg`+ where the
// summary is pinned and the panel scrolls independently.
const summaryCollapsed = ref(false);

const activeTabIcon = computed(() => props.tabItems.find((t) => t.value === activeTab.value)?.icon);

// Desktop keeps the independent-scroll panel; on mobile the panel flows into
// the page scroll (no clipping, no nested scroll area).
function panelClasses(value: string) {
  const desktop = props.tabPanelClass?.[value] ?? 'overflow-y-auto';
  return ['min-h-0', 'lg:flex-1', desktop, 'max-lg:!block', 'max-lg:!overflow-visible'].join(' ');
}

// The strip is the Settings-style UNavigationMenu. Its active state is
// route-driven by default; tabs are view state (no routes), so each item
// carries `active` + `onSelect` explicitly. The page's `slot` field names the
// `#tab-*` templates — stripped here so the menu uses the shared `#item-label`.
// The active item also carries `aria-current` so the strip reads as "current
// view" to assistive technology; the panels below deliberately carry no
// tabpanel role (UNavigationMenu exposes plain buttons, not a tablist).
const navItems = computed(() =>
  props.tabItems.map(({ slot: _slot, ...item }) => ({
    ...item,
    active: activeTab.value === item.value,
    'aria-current': activeTab.value === item.value ? 'true' : undefined,
    onSelect: () => {
      if (!item.disabled) activeTab.value = item.value;
    },
  })),
);

// Help for the active tab renders beside the strip: `HelpHint` is a button,
// and nesting it inside the navigation trigger's label would create nested
// interactive controls (and the trigger would swallow its click).
const activeTabHelp = computed(() => props.tabItems.find((t) => t.value === activeTab.value)?.help);
</script>

<template>
  <!-- Mobile: the whole panel scrolls as one document. Desktop: fixed summary + independently scrolling tab body. -->
  <div class="flex flex-col h-full gap-4 max-lg:overflow-y-auto lg:overflow-hidden">
    <div v-if="$slots.summary" class="lg:shrink-0">
      <div :class="summaryCollapsed ? 'max-lg:hidden' : ''">
        <slot name="summary" />
      </div>
      <button
        type="button"
        class="lg:hidden mt-2 w-full flex items-center justify-center gap-1 rounded-md border border-default py-1.5 text-xs font-medium text-muted hover:bg-elevated/60 transition-colors"
        @click="summaryCollapsed = !summaryCollapsed"
      >
        <UIcon :name="summaryCollapsed ? 'i-lucide-chevron-down' : 'i-lucide-chevron-up'" class="size-3.5" />
        {{ summaryCollapsed ? 'Show summary' : 'Hide summary' }}
      </button>
    </div>

    <!-- Tab switcher: a full-width select on phones, the same UTabs strip the
         project page uses from sm up. Sticky on mobile. -->
    <div class="lg:shrink-0 max-lg:sticky max-lg:top-0 max-lg:z-10 max-lg:bg-(--ui-bg-canvas) max-lg:py-1.5">
      <USelect
        v-model="activeTab"
        :items="tabItems"
        :icon="activeTabIcon"
        size="md"
        aria-label="Select tab"
        class="w-full sm:hidden"
      />
      <!-- Desktop strip: the same UDashboardToolbar + UNavigationMenu the
           Settings header uses, so page tabs look identical everywhere. The
           toolbar must stay a flex row (`sm:flex`, not `sm:block`) so the nav
           (`flex-1`) and the active tab's inline HelpHint (`shrink-0`) sit on
           one line — a block row lets the hint wrap under the strip on Blink. -->
      <UDashboardToolbar class="hidden sm:flex p-1">
        <UNavigationMenu
          :items="navItems"
          highlight
          class="-mx-1 flex-1"
          :ui="{ list: 'overflow-x-auto', root: 'min-w-0', item: 'shrink-0' }"
        >
          <template #item-label="{ item }">
            <span>{{ item.label }}</span>
            <span
              v-if="item.disabled && item.disabledReason"
              :title="item.disabledReason"
              class="ml-1.5 font-normal opacity-70"
            >
              {{ item.disabledReason }}
            </span>
          </template>
        </UNavigationMenu>
        <ClientOnly>
          <HelpHint v-if="activeTabHelp" :topic="activeTabHelp" class="ml-2 shrink-0" />
        </ClientOnly>
      </UDashboardToolbar>
    </div>

    <template v-for="item in tabItems" :key="item.value">
      <div v-if="activeTab === item.value" :class="panelClasses(item.value)">
        <slot :name="`tab-${item.slot ?? item.value}`" />
      </div>
    </template>
  </div>
</template>
