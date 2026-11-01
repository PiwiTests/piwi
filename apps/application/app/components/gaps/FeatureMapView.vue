<script setup lang="ts">
/**
 * The feature map — the top level of the graph view. One circle per feature,
 * sized by how many routes, pages and controls it groups, colored by the worst
 * open gap under it, and linked to the features it shares nodes with (the
 * thicker the line, the more they share). The ranked list under the picture
 * carries the same features with their counts, so a project with more features
 * than fit on a circle still reads. Clicking a feature opens it in the graph.
 * Plain SVG, no charting library.
 */
import { gapClassSeverity } from '#shared/gap-classes';
import { gapClassBadgeColor, gapClassFill } from '~/utils/gap-classes';
import { errorMessage } from '~/utils';

interface MapFeature {
  key: string;
  members: { routes: number; pages: number; controls: number; inferred: number };
  tests: number;
  gaps: Record<string, number>;
  worstClass: string | null;
}
interface MapLink {
  from: string;
  to: string;
  weight: number;
}
interface FeatureMap {
  features: MapFeature[];
  links: MapLink[];
  ungrouped: { gaps: Record<string, number>; worstClass: string | null };
  shared: { nodes: number; gaps: Record<string, number>; worstClass: string | null };
}

const props = defineProps<{ projectId: number; selected?: string | null }>();
const emit = defineEmits<{ (e: 'select', node: { kind: string; key: string }): void }>();

const map = ref<FeatureMap | null>(null);
const loading = ref(false);
const loadError = ref<string | null>(null);
const hovered = ref<string | null>(null);

let requestToken = 0;
async function load() {
  const token = ++requestToken;
  loading.value = true;
  try {
    const result = await $fetch<FeatureMap>(
      `/api/projects/${props.projectId}/feature-map` as `/api/projects/:id/feature-map`,
    );
    if (token !== requestToken) return;
    map.value = result;
    loadError.value = null;
  } catch (err) {
    // A failed fetch is an error, not an empty map — show why, not "no features yet".
    if (token === requestToken) {
      map.value = null;
      loadError.value = errorMessage(err);
    }
  } finally {
    if (token === requestToken) loading.value = false;
  }
}
watch(() => props.projectId, load, { immediate: true });

/** The most features drawn on the circle; the list below always carries all of them. */
const MAX_DRAWN = 48;
const SIZE = 600;
const CENTER = SIZE / 2;
const RING = 190;
const MIN_R = 7;
const MAX_R = 22;

function memberCount(f: MapFeature): number {
  return f.members.routes + f.members.pages + f.members.controls;
}
function gapCount(f: MapFeature): number {
  let n = 0;
  for (const v of Object.values(f.gaps)) n += v;
  return n;
}

/** Feature key → its circle, evenly spaced on the ring in ranked order. */
const layout = computed(() => {
  const positions = new Map<string, { x: number; y: number; r: number; angle: number; feature: MapFeature }>();
  const m = map.value;
  if (!m) return { positions, hidden: 0 };
  const drawn = m.features.slice(0, MAX_DRAWN);
  const maxMembers = Math.max(1, ...drawn.map(memberCount));
  drawn.forEach((f, i) => {
    const angle = drawn.length === 1 ? -Math.PI / 2 : -Math.PI / 2 + (2 * Math.PI * i) / drawn.length;
    const ring = drawn.length === 1 ? 0 : RING;
    positions.set(f.key, {
      x: CENTER + ring * Math.cos(angle),
      y: CENTER + ring * Math.sin(angle),
      r: MIN_R + (MAX_R - MIN_R) * Math.sqrt(memberCount(f) / maxMembers),
      angle,
      feature: f,
    });
  });
  return { positions, hidden: m.features.length - drawn.length };
});

/** Links with both ends drawn, thickest last so it sits on top. */
const drawnLinks = computed(() => {
  const m = map.value;
  if (!m) return [];
  const pos = layout.value.positions;
  const maxWeight = Math.max(1, ...m.links.map((l) => l.weight));
  return m.links
    .filter((l) => pos.has(l.from) && pos.has(l.to))
    .map((l) => ({ ...l, width: 1 + 4 * (l.weight / maxWeight) }))
    .reverse();
});

function linkDimmed(l: MapLink): boolean {
  const focus = hovered.value ?? props.selected?.replace(/^feature:/, '') ?? null;
  return focus != null && l.from !== focus && l.to !== focus;
}

/** Label anchor and offset by which side of the ring the circle sits on. */
function labelProps(p: { x: number; y: number; r: number; angle: number }) {
  const dx = Math.cos(p.angle);
  const dy = Math.sin(p.angle);
  const anchor = Math.abs(dx) < 0.2 ? 'middle' : dx > 0 ? 'start' : 'end';
  return { x: p.x + dx * (p.r + 6), y: p.y + dy * (p.r + 6) + (Math.abs(dx) < 0.2 ? (dy > 0 ? 10 : -4) : 4), anchor };
}

function shortKey(key: string): string {
  return key.length > 20 ? `${key.slice(0, 19)}…` : key;
}

/** `n noun`, the noun plural unless `n` is one. */
function counted(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** A feature's members, as `4 routes · 1 page · 2 controls`. */
function membersLabel(f: MapFeature): string {
  return `${counted(f.members.routes, 'route')} · ${counted(f.members.pages, 'page')} · ${counted(f.members.controls, 'control')}`;
}

/** How many of a feature's members its tests do not reach, as `5 inferred from its pages and routes`, or ''. */
function inferredLabel(f: MapFeature): string {
  return f.members.inferred > 0 ? `${f.members.inferred} inferred from its pages and routes` : '';
}

function featureTitle(f: MapFeature): string {
  const gaps = gapCount(f);
  const shared = (map.value?.links ?? []).filter((l) => l.from === f.key || l.to === f.key).length;
  const inferred = inferredLabel(f);
  return `${f.key}\n${membersLabel(f)}${inferred ? ` (${inferred})` : ''} · reached by ${counted(f.tests, 'test')}\n${gaps} open gap${gaps === 1 ? '' : 's'}${f.worstClass ? ` (worst: ${f.worstClass})` : ''}${shared ? `\nshares nodes with ${shared} feature${shared === 1 ? '' : 's'}` : ''}`;
}

function isSelected(key: string): boolean {
  return props.selected === `feature:${key}`;
}

function select(f: MapFeature) {
  emit('select', { kind: 'feature', key: f.key });
}

const ungroupedCount = computed(() => {
  let n = 0;
  for (const v of Object.values(map.value?.ungrouped.gaps ?? {})) n += v;
  return n;
});

const sharedCount = computed(() => {
  let n = 0;
  for (const v of Object.values(map.value?.shared?.gaps ?? {})) n += v;
  return n;
});

/** The hubs, as one sentence up to where the list's group is named. */
const sharedLine = computed(() => {
  const shared = map.value?.shared;
  if (!shared || shared.nodes === 0) return '';
  const one = shared.nodes === 1;
  const head = one
    ? '1 hub, a node most tests reach or most features group, counts under no feature'
    : `${shared.nodes} hubs, nodes most tests reach or most features group, count under no feature`;
  if (sharedCount.value === 0) return head;
  const worst = shared.worstClass ? ` (worst: ${shared.worstClass})` : '';
  const gaps = sharedCount.value === 1 ? `1 open gap${worst} sits` : `${sharedCount.value} open gaps${worst} sit`;
  return `${head}; ${one ? 'its' : 'their'} ${gaps}`;
});

/** The classes present anywhere on the map, most severe first, for the legend. */
const legend = computed(() => {
  const set = new Set<string>();
  for (const f of map.value?.features ?? []) for (const cls of Object.keys(f.gaps)) set.add(cls);
  return [...set].sort((a, b) => gapClassSeverity(b) - gapClassSeverity(a));
});
</script>

<template>
  <div class="w-full" data-shot="feature-map">
    <ErrorState v-if="loadError" :text="`Couldn't load the feature map: ${loadError}`">
      <template #action>
        <UButton size="xs" color="neutral" variant="outline" label="Retry" @click="load" />
      </template>
    </ErrorState>
    <LoadingState v-else-if="loading && !map" />
    <EmptyState
      v-else-if="!map || map.features.length === 0"
      icon="i-lucide-map"
      text="No features yet — tag tests with piwi:feature and the routes and pages they reach group under it."
    />
    <div v-else class="flex flex-col gap-4 lg:flex-row lg:items-start">
      <div class="w-full shrink-0 lg:w-[420px]">
        <svg
          :viewBox="`0 0 ${SIZE} ${SIZE}`"
          class="block w-full h-auto max-w-[600px] mx-auto overflow-visible"
          role="img"
          data-tour="feature-map"
        >
          <title>Feature map</title>
          <g>
            <line
              v-for="l in drawnLinks"
              :key="`${l.from}→${l.to}`"
              :x1="layout.positions.get(l.from)!.x"
              :y1="layout.positions.get(l.from)!.y"
              :x2="layout.positions.get(l.to)!.x"
              :y2="layout.positions.get(l.to)!.y"
              :stroke-width="l.width"
              class="stroke-sky-400"
              :opacity="linkDimmed(l) ? 0.08 : 0.45"
            >
              <title>{{ l.from }} and {{ l.to }} share {{ l.weight }} node{{ l.weight === 1 ? '' : 's' }}</title>
            </line>
          </g>
          <g v-for="[key, p] in layout.positions" :key="key">
            <g
              class="cursor-pointer focus:outline-none"
              role="button"
              tabindex="0"
              :aria-label="featureTitle(p.feature)"
              :aria-pressed="isSelected(key)"
              :opacity="hovered && hovered !== key ? 0.45 : 1"
              @click="select(p.feature)"
              @keydown.enter.prevent="select(p.feature)"
              @keydown.space.prevent="select(p.feature)"
              @mouseenter="hovered = key"
              @mouseleave="hovered = null"
              @focus="hovered = key"
              @blur="hovered = null"
            >
              <title>{{ featureTitle(p.feature) }}</title>
              <circle
                v-if="isSelected(key)"
                :cx="p.x"
                :cy="p.y"
                :r="p.r + 4"
                class="fill-none stroke-primary"
                stroke-width="2"
              />
              <circle
                :cx="p.x"
                :cy="p.y"
                :r="p.r"
                :class="gapClassFill(p.feature.worstClass)"
                class="stroke-white/70 dark:stroke-gray-900/70 opacity-90"
              />
              <text
                v-if="gapCount(p.feature) > 0"
                :x="p.x"
                :y="p.y"
                text-anchor="middle"
                dominant-baseline="central"
                class="fill-white text-[10px] font-semibold pointer-events-none"
              >
                {{ gapCount(p.feature) > 99 ? '99+' : gapCount(p.feature) }}
              </text>
              <text
                :x="labelProps(p).x"
                :y="labelProps(p).y"
                :text-anchor="labelProps(p).anchor"
                class="fill-gray-700 dark:fill-gray-200 text-[11px] pointer-events-none"
              >
                {{ shortKey(key) }}
              </text>
            </g>
          </g>
        </svg>
        <p class="mt-1 text-xs text-muted text-center">
          Circles sized by what a feature groups, colored by its worst open gap, linked where features share nodes.
          <span v-if="layout.hidden > 0">{{ layout.hidden }} more in the list.</span>
        </p>
        <div v-if="legend.length > 0" class="mt-1 flex flex-wrap justify-center gap-1">
          <UBadge v-for="cls in legend" :key="cls" :color="gapClassBadgeColor(cls)" variant="subtle" size="sm">{{
            cls
          }}</UBadge>
          <UBadge color="success" variant="subtle" size="sm">no open gap</UBadge>
        </div>
      </div>

      <div class="min-w-0 grow">
        <div class="divide-y divide-default">
          <button
            v-for="f in map.features"
            :key="f.key"
            type="button"
            class="w-full text-left py-2 px-1 flex flex-wrap items-center gap-x-3 gap-y-1 rounded hover:bg-elevated/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            :class="isSelected(f.key) ? 'bg-elevated/60' : ''"
            :title="`Open feature:${f.key} in the graph`"
            @click="select(f)"
            @mouseenter="hovered = f.key"
            @mouseleave="hovered = null"
          >
            <span class="min-w-0 basis-40 grow truncate text-sm font-medium text-highlighted">{{ f.key }}</span>
            <span class="text-xs text-muted tabular-nums" :title="inferredLabel(f) || undefined">{{
              membersLabel(f)
            }}</span>
            <span class="text-xs text-muted tabular-nums">{{ counted(f.tests, 'test') }}</span>
            <span class="flex items-center gap-1">
              <UBadge
                v-if="gapCount(f) > 0"
                :color="gapClassBadgeColor(f.worstClass)"
                variant="subtle"
                size="sm"
                :title="
                  Object.entries(f.gaps)
                    .map(([cls, n]) => `${n} ${cls}`)
                    .join(', ')
                "
                >{{ gapCount(f) }} open · {{ f.worstClass }}</UBadge
              >
              <UBadge v-else color="success" variant="subtle" size="sm">no open gap</UBadge>
            </span>
          </button>
        </div>
        <p v-if="sharedLine" class="mt-2 text-xs text-muted" data-shot="feature-map-shared">
          {{ sharedLine
          }}<template v-if="sharedCount > 0"> under <em>Shared by most features</em> in the list</template>.
        </p>
        <p v-if="ungroupedCount > 0" class="mt-2 text-xs text-muted">
          {{ ungroupedCount }} open gap{{ ungroupedCount === 1 ? '' : 's' }} on nodes no feature groups
          <span v-if="map.ungrouped.worstClass">(worst: {{ map.ungrouped.worstClass }})</span> — they sit under
          <em>Ungrouped</em> in the list.
        </p>
      </div>
    </div>
  </div>
</template>
