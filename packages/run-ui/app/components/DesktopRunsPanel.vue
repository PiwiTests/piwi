<script setup lang="ts">
/**
 * The runs of a window beside the run shown, the same in both hosts (the dashboard's Local runs tray, Piwi Runner's
 * runs). On the left, the runs in their groups (`groups`, a group with no run left out), each line named by its run's
 * title and described by how it stands (`status`), whether a test of it waits at a stop (`waits`) and how long it ran
 * (`duration`); a click shows it (`select`). On the right, the run shown (`shown`), which the host draws in the default
 * slot. Narrower than `WIDE_PX`, a select names the run shown above it, the groups' actions beside it. A group's
 * `#group-actions` slot holds its own buttons (Clear finished). `isWorking()` says whether the keyboard is in the run
 * shown: a host leaves it shown then, as a run starts or a test stops.
 */
import type { BadgeProps } from '@nuxt/ui';
import { SELECTED_ROW_CLASS } from '@piwitests/run-ui/ui-classes';

interface RunsPanelItem {
  key: string | number;
  title: string;
  status?: { label: string; color: BadgeProps['color'] } | null;
  waits?: boolean;
  duration?: string | null;
}

interface RunsPanelGroup {
  key: string;
  title: string;
  items: readonly RunsPanelItem[];
}

const props = defineProps<{ groups: readonly RunsPanelGroup[]; shown: string | number | null }>();
const emit = defineEmits<{ select: [key: string | number] }>();
defineSlots<{
  default(): unknown;
  'group-actions'(props: { group: RunsPanelGroup }): unknown;
}>();

const words = useRunUiWords();
const id = useId();

/** The least width at which the list shows beside the run shown. */
const WIDE_PX = 720;
const root = useTemplateRef<HTMLElement>('root');
const detail = useTemplateRef<HTMLElement>('detail');
const { width } = useElementSize(root);
const wide = computed(() => width.value >= WIDE_PX);

const shownGroups = computed(() => props.groups.filter((group) => group.items.length > 0));

/** The id of the line that says how a run stands, which describes its button. */
const describedId = (group: RunsPanelGroup, item: RunsPanelItem) => `${id}-${group.key}-${item.key}`;
const described = (item: RunsPanelItem) => !!item.status || !!item.waits || !!item.duration;

/** The select's choices, narrow: each group's runs under its title, each with how it stands. */
const choices = computed(() =>
  shownGroups.value.map((group) => [
    { type: 'label' as const, label: group.title },
    ...group.items.map((item) => ({
      label: item.status ? `${item.title} · ${item.status.label}` : item.title,
      value: `${group.key}:${item.key}`,
    })),
  ]),
);

const chosenChoice = computed({
  get: () => {
    for (const group of shownGroups.value) {
      const item = group.items.find((each) => each.key === props.shown);
      if (item) return `${group.key}:${item.key}`;
    }
    return undefined;
  },
  set: (value: string | undefined) => {
    for (const group of shownGroups.value) {
      const item = group.items.find((each) => `${group.key}:${each.key}` === value);
      if (item) return emit('select', item.key);
    }
  },
});

/** Whether the keyboard is in the run shown: a control, a live view, the output's filter. */
function isWorking(): boolean {
  const active = document.activeElement;
  return !!detail.value && !!active && detail.value.contains(active);
}

defineExpose({ isWorking });
</script>

<template>
  <div ref="root" class="flex min-h-0 min-w-0 flex-1" :class="wide ? 'flex-row' : 'flex-col'">
    <!-- Narrow, a select names the run shown, so the run keeps the height. -->
    <div v-if="!wide" class="flex shrink-0 flex-wrap items-center gap-2 border-b border-default p-2">
      <USelect
        v-model="chosenChoice"
        :items="choices"
        :aria-label="words.t('runui_runsShown')"
        class="min-w-0 flex-1 basis-56"
      />
      <template v-for="group in shownGroups" :key="group.key">
        <slot name="group-actions" :group="group" />
      </template>
    </div>
    <nav v-else :aria-label="words.t('runui_runsLabel')" class="w-72 shrink-0 overflow-y-auto border-r border-default">
      <section v-for="group in shownGroups" :key="group.key" :aria-label="group.title" :data-group="group.key">
        <div class="flex min-h-7 items-center gap-2 px-3 pt-2 pb-1">
          <h3 class="min-w-0 flex-1 text-xs text-muted">{{ group.title }}</h3>
          <slot name="group-actions" :group="group" />
        </div>
        <ul>
          <li v-for="item in group.items" :key="item.key">
            <button
              type="button"
              class="flex w-full min-w-0 flex-col gap-0.5 px-3 py-1.5 text-left hover:bg-elevated/60 focus-visible:outline-2 focus-visible:outline-primary"
              :class="item.key === shown ? SELECTED_ROW_CLASS : ''"
              :aria-current="item.key === shown || undefined"
              :aria-label="item.title"
              :aria-describedby="described(item) ? describedId(group, item) : undefined"
              data-run-line
              :data-key="item.key"
              @click="emit('select', item.key)"
            >
              <span class="line-clamp-2 text-sm font-medium break-words" :title="item.title">{{ item.title }}</span>
              <!-- The line is named by its run's title alone; how the run stands describes it. -->
              <span
                v-if="described(item)"
                :id="describedId(group, item)"
                class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5"
              >
                <UBadge v-if="item.status" :color="item.status.color" variant="subtle" size="sm" class="max-w-full">
                  {{ item.status.label }}
                </UBadge>
                <span v-if="item.waits" class="flex shrink-0 items-center text-warning">
                  <UIcon name="i-lucide-circle-pause" class="size-3.5" aria-hidden="true" />
                  <span class="sr-only">{{ words.t('runui_runsWaiting') }}</span>
                </span>
                <span v-if="item.duration" class="ml-auto shrink-0 text-xs text-muted tabular-nums">
                  {{ item.duration }}
                </span>
              </span>
            </button>
          </li>
        </ul>
      </section>
    </nav>

    <div ref="detail" class="min-h-0 min-w-0 flex-1 overflow-y-auto px-3 py-2">
      <slot />
    </div>
  </div>
</template>
