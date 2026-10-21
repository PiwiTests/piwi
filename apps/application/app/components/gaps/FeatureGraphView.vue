<script setup lang="ts">
/**
 * The feature-graph view around one node: an ego picture — the node in the
 * middle, what leads into it (tests, features, pages, controls) stacked by kind
 * on the left, what it leads to (handlers, dependencies, pages it links) on the
 * right — over the inspector list of every neighbor. Each kind shows its most
 * severe few in the picture; the rest are in the list, so a hub with three
 * hundred routes still draws as a readable star. Every edge runs from the
 * center to one neighbor, so nothing crosses. Nodes are colored by their worst
 * open gap and edges by kind; clicking a node recenters. Plain SVG, no library.
 * A file or handler node whose tests, or a suite of the latest coverage,
 * recorded coverage of it links its coverage page, unless the project
 * declined coverage.
 */
import { sameFilePath } from '@piwitests/core/locator-break';
import type { FileCoverage } from '~~/server/utils/coverage';
import type { CoverageSummary } from '~~/server/utils/coverage-summary';
import { compareBySeverity, gapClassBadgeColor, gapClassFill, graphEdgeStroke } from '~/utils/gap-classes';
import { coverageFileRoute } from '~/utils/coverage-view';
import { errorMessage } from '~/utils';

interface GraphNode {
  kind: string;
  key: string;
  class: string | null;
  depth: number;
  tests: Array<{ testCaseId: number; title: string }>;
}
interface GraphEdge {
  fromKind: string;
  fromKey: string;
  toKind: string;
  toKey: string;
  kind: string;
  confidence: number | null;
}
interface FeatureGraph {
  seed: { kind: string; key: string };
  depth: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

const props = defineProps<{ projectId: number; seedNode: string }>();
const emit = defineEmits<{ (e: 'select', node: { kind: string; key: string }): void }>();

const { isHidden, state: capabilityState } = await useProjectCapabilities(props.projectId);

const graph = ref<FeatureGraph | null>(null);
const loading = ref(false);
const loadError = ref<string | null>(null);
const hovered = ref<string | null>(null);

// A monotonic token so an out-of-order response never overwrites the current graph.
let requestToken = 0;

async function load() {
  const token = ++requestToken;
  loading.value = true;
  try {
    const result = await $fetch<FeatureGraph>(`/api/projects/${props.projectId}/graph` as `/api/projects/:id/graph`, {
      query: { node: props.seedNode, depth: 1 },
    });
    if (token !== requestToken) return; // superseded by a newer request
    graph.value = result;
    loadError.value = null;
  } catch (err) {
    // A failed fetch is an error, not an empty graph.
    if (token === requestToken) {
      graph.value = null;
      loadError.value = errorMessage(err);
    }
  } finally {
    if (token === requestToken) loading.value = false;
  }
}

watch([() => props.seedNode, () => props.projectId], load, { immediate: true });

// On a narrow screen the picture scrolls sideways; start it centered on the seed.
const scroller = ref<HTMLElement | null>(null);
watch(
  () => graph.value,
  () =>
    nextTick(() => {
      const el = scroller.value;
      if (!el) return;
      el.scrollLeft = Math.max(0, layout.value.seed.x + SEED_W / 2 - el.clientWidth / 2);
    }),
  { flush: 'post' },
);

function nodeId(kind: string, key: string): string {
  return `${kind}\x00${key}`;
}

const seed = computed<GraphNode | null>(() => {
  const g = graph.value;
  if (!g) return null;
  return g.nodes.find((n) => n.depth === 0) ?? { kind: g.seed.kind, key: g.seed.key, class: null, depth: 0, tests: [] };
});
const neighbors = computed(() => graph.value?.nodes.filter((n) => n.depth > 0) ?? []);

/**
 * The seed's coverage page when it is a file (or a route handler, a file too)
 * that tests recorded coverage of, or that a suite of the latest coverage
 * names: the file marked by test, else by suite.
 */
const coveredFile = ref<{ path: string; query: Record<string, string> } | null>(null);
watch(
  () => [seed.value?.kind, seed.value?.key, isHidden('coverage'), capabilityState('coverage')] as const,
  async ([kind, key, hidden, coverage], _old, onCleanup) => {
    let stale = false;
    onCleanup(() => (stale = true));
    coveredFile.value = null;
    if ((kind !== 'file' && kind !== 'handler') || !key || hidden) return;
    // Tests record coverage only where the capability is active; a suite's report can exist without it.
    if (coverage === 'active') {
      const read = await $fetch<FileCoverage>(`/api/projects/${props.projectId}/coverage`, {
        query: { file: key },
      }).catch(() => null);
      if (stale) return;
      if (read?.fragments.some((f) => sameFilePath(f.path, key))) {
        coveredFile.value = coverageFileRoute(props.projectId, key);
        return;
      }
    }
    const summary = await $fetch<CoverageSummary>(`/api/projects/${props.projectId}/coverage-summary`, {
      query: { file: key },
    }).catch(() => null);
    if (!stale && summary?.file) {
      const route = coverageFileRoute(props.projectId, summary.file.path);
      coveredFile.value = { ...route, query: { ...route.query, marks: 'suites' } };
    }
  },
  { immediate: true },
);

// Layout: one column each side of the seed; kinds stacked within a column.
const KIND_ORDER = ['test', 'feature', 'page', 'control', 'link', 'route', 'handler', 'dependency', 'file'];
/** The most nodes drawn per kind and side; the rest are in the inspector list. */
const MAX_PER_KIND = 6;
const NODE_W = 230;
const NODE_H = 28;
const ROW_H = 36;
const HEADER_H = 18;
const GROUP_GAP = 12;
const SEED_W = 250;
const SEED_H = 40;
const COL_GAP = 110;
const PAD = 10;

interface Placed {
  x: number;
  y: number;
  node: GraphNode;
  side: 'in' | 'out';
}
interface Marker {
  x: number;
  y: number;
  text: string;
}

/**
 * Which side a neighbor sits on: `in` when an edge runs from it to the seed
 * (it leads here), `out` when the seed leads to it. A neighbor with edges both
 * ways is drawn on the `in` side, where the traffic comes from.
 */
const sideByNode = computed(() => {
  const g = graph.value;
  const out = new Map<string, 'in' | 'out'>();
  if (!g) return out;
  for (const e of g.edges) {
    const fromSeed = e.fromKind === g.seed.kind && e.fromKey === g.seed.key;
    const toSeed = e.toKind === g.seed.kind && e.toKey === g.seed.key;
    if (toSeed && !fromSeed) out.set(nodeId(e.fromKind, e.fromKey), 'in');
    else if (fromSeed && !toSeed) {
      const nid = nodeId(e.toKind, e.toKey);
      if (!out.has(nid)) out.set(nid, 'out');
    }
  }
  return out;
});

/** Stack one side's kinds top to bottom; returns positions relative to the column top. */
function stackSide(nodes: GraphNode[], x: number, side: 'in' | 'out') {
  const byKind = new Map<string, GraphNode[]>();
  for (const n of nodes) {
    const arr = byKind.get(n.kind) ?? [];
    arr.push(n);
    byKind.set(n.kind, arr);
  }
  const order = (kind: string) => {
    const i = KIND_ORDER.indexOf(kind);
    return i < 0 ? KIND_ORDER.length : i;
  };
  const kinds = [...byKind.entries()].sort(([a], [b]) => order(a) - order(b) || a.localeCompare(b));
  const placed: Placed[] = [];
  const markers: Marker[] = [];
  let y = 0;
  for (const [kind, list] of kinds) {
    list.sort(compareBySeverity);
    markers.push({ x, y: y + HEADER_H - 6, text: `${kind} (${list.length})` });
    y += HEADER_H;
    const shown = list.slice(0, MAX_PER_KIND);
    for (const node of shown) {
      placed.push({ x, y, node, side });
      y += ROW_H;
    }
    if (list.length > shown.length) {
      markers.push({ x, y: y + 12, text: `+${list.length - shown.length} more in the list below` });
      y += HEADER_H;
    }
    y += GROUP_GAP;
  }
  return { placed, markers, height: Math.max(0, y - GROUP_GAP) };
}

const layout = computed(() => {
  const empty = {
    positions: new Map<string, Placed>(),
    markers: [] as Marker[],
    seed: { x: 0, y: 0 },
    width: 0,
    height: 0,
  };
  if (!graph.value) return empty;
  const sides = sideByNode.value;
  const inNodes = neighbors.value.filter((n) => sides.get(nodeId(n.kind, n.key)) !== 'out');
  const outNodes = neighbors.value.filter((n) => sides.get(nodeId(n.kind, n.key)) === 'out');
  // An empty side takes no column, so a feature (nothing leads into it) draws
  // its members right beside it instead of behind an empty left column.
  const leftX = PAD;
  const seedX = inNodes.length > 0 ? leftX + NODE_W + COL_GAP : PAD;
  const rightX = seedX + SEED_W + COL_GAP;
  const left = stackSide(inNodes, leftX, 'in');
  const right = stackSide(outNodes, rightX, 'out');
  const inner = Math.max(left.height, right.height, SEED_H);
  const positions = new Map<string, Placed>();
  const markers: Marker[] = [];
  for (const [stack, offset] of [
    [left, PAD + (inner - left.height) / 2],
    [right, PAD + (inner - right.height) / 2],
  ] as const) {
    for (const p of stack.placed) positions.set(nodeId(p.node.kind, p.node.key), { ...p, y: p.y + offset });
    for (const m of stack.markers) markers.push({ ...m, y: m.y + offset });
  }
  return {
    positions,
    markers,
    seed: { x: seedX, y: PAD + (inner - SEED_H) / 2 },
    width: outNodes.length > 0 ? rightX + NODE_W + PAD : seedX + SEED_W + PAD,
    height: inner + 2 * PAD,
  };
});

/** One edge per drawn neighbor, from the seed's near side, as a gentle S-curve. */
const spokes = computed(() => {
  const g = graph.value;
  if (!g) return [];
  const s = layout.value.seed;
  const seedMidY = s.y + SEED_H / 2;
  const kindByNode = new Map<string, string>();
  // An edge below full confidence (a feature inferring a node from its pages) draws dashed.
  const inferredNodes = new Set<string>();
  for (const e of g.edges) {
    const fromSeed = e.fromKind === g.seed.kind && e.fromKey === g.seed.key;
    const toSeed = e.toKind === g.seed.kind && e.toKey === g.seed.key;
    const other =
      fromSeed && !toSeed ? nodeId(e.toKind, e.toKey) : toSeed && !fromSeed ? nodeId(e.fromKind, e.fromKey) : null;
    if (!other) continue;
    kindByNode.set(other, e.kind);
    if (e.kind === 'groups' && e.confidence != null && e.confidence < 1) inferredNodes.add(other);
  }
  return [...layout.value.positions].map(([id, p]) => {
    const x1 = p.side === 'in' ? s.x : s.x + SEED_W;
    const x2 = p.side === 'in' ? p.x + NODE_W : p.x;
    const y2 = p.y + NODE_H / 2;
    const mx = (x1 + x2) / 2;
    return {
      id,
      kind: kindByNode.get(id) ?? '',
      inferred: inferredNodes.has(id),
      d: `M ${x1} ${seedMidY} C ${mx} ${seedMidY}, ${mx} ${y2}, ${x2} ${y2}`,
    };
  });
});

function shortKey(key: string, max = 30): string {
  return key.length > max ? `${key.slice(0, max - 1)}…` : key;
}

/** Reach is a test → node edge; a feature or an endpoint (test, commit, ticket) has none. */
function reachable(node: GraphNode): boolean {
  return !['feature', 'test', 'commit', 'ticket', 'cluster', 'owner'].includes(node.kind);
}

/** A `test` endpoint is keyed by id; show its title, known from the seed's reaching tests. */
function displayKey(node: GraphNode): string {
  if (node.kind !== 'test') return node.key;
  const id = Number(node.key);
  return seed.value?.tests.find((t) => t.testCaseId === id)?.title ?? `test ${node.key}`;
}

/** The full key plus the tests that reach the node — the SVG title and aria-label. */
function nodeTitle(node: GraphNode): string {
  const head = `${node.kind}: ${displayKey(node)}${node.class ? ` · ${node.class}` : ''}`;
  if (node.tests.length === 0) return head;
  const shown = node.tests.slice(0, 10).map((t) => `• ${t.title}`);
  const more = node.tests.length > 10 ? `\n…and ${node.tests.length - 10} more` : '';
  return `${head}\nReached by ${node.tests.length} test${node.tests.length === 1 ? '' : 's'}:\n${shown.join('\n')}${more}`;
}

function select(node: { kind: string; key: string }) {
  emit('select', { kind: node.kind, key: node.key });
}
</script>

<template>
  <div class="w-full space-y-4" data-shot="feature-graph">
    <ErrorState v-if="loadError" :text="`Couldn't load the graph: ${loadError}`">
      <template #action>
        <UButton size="xs" color="neutral" variant="outline" label="Retry" @click="load" />
      </template>
    </ErrorState>
    <LoadingState v-else-if="loading && !graph" />
    <EmptyState v-else-if="!graph || !seed" icon="i-lucide-radar" text="No graph for this node" />
    <template v-else>
      <div class="flex flex-wrap items-center gap-2" data-shot="feature-graph-seed">
        <span class="text-sm font-mono text-highlighted">{{ seed.kind }}:{{ seed.key }}</span>
        <UBadge v-if="seed.class" :color="gapClassBadgeColor(seed.class)" variant="subtle" size="sm">{{
          seed.class
        }}</UBadge>
        <span v-if="reachable(seed)" class="text-xs text-muted"
          >reached by {{ seed.tests.length }} test{{ seed.tests.length === 1 ? '' : 's' }}</span
        >
        <span v-if="coveredFile" class="text-xs text-muted"
          >·
          <NuxtLink
            :to="coveredFile"
            :class="SENTENCE_LINK_CLASS"
            title="Which tests and suites run each line of this file"
            data-coverage-link
            >the lines they run</NuxtLink
          ></span
        >
        <span class="text-xs text-muted"
          >· what leads here on the left, what it leads to on the right · click to recenter</span
        >
      </div>

      <div v-if="neighbors.length > 0" ref="scroller" class="overflow-x-auto" data-shot="feature-graph-picture">
        <svg
          :width="layout.width"
          :height="layout.height"
          :viewBox="`0 0 ${layout.width} ${layout.height}`"
          class="block"
        >
          <!-- Spokes first, so nodes sit on top. One per drawn neighbor, none crossing. -->
          <g>
            <path
              v-for="s in spokes"
              :key="s.id"
              :d="s.d"
              fill="none"
              :class="graphEdgeStroke(s.kind)"
              :stroke-width="hovered === s.id ? 2.5 : 1.5"
              :stroke-dasharray="s.inferred ? '4 3' : undefined"
              :opacity="hovered && hovered !== s.id ? 0.15 : 0.7"
            >
              <title>{{ s.inferred ? `${s.kind} (inferred)` : s.kind }}</title>
            </path>
          </g>
          <!-- Kind headers and overflow markers. -->
          <text
            v-for="(m, i) in layout.markers"
            :key="`m${i}`"
            :x="m.x"
            :y="m.y"
            class="fill-gray-500 dark:fill-gray-400 text-[10px] uppercase tracking-wide"
          >
            {{ m.text }}
          </text>
          <!-- The seed. -->
          <g :transform="`translate(${layout.seed.x},${layout.seed.y})`">
            <title>{{ nodeTitle(seed) }}</title>
            <rect
              :width="SEED_W"
              :height="SEED_H"
              rx="6"
              :class="gapClassFill(seed.class)"
              class="stroke-gray-900/40 dark:stroke-white/40"
              stroke-width="2"
            />
            <text :x="10" :y="SEED_H / 2" dominant-baseline="middle" class="fill-white text-[11px] font-semibold">
              {{ seed.kind }}: {{ shortKey(seed.key, 32) }}
            </text>
          </g>
          <!-- Neighbors. -->
          <g v-for="[id, pos] in layout.positions" :key="id">
            <g
              :transform="`translate(${pos.x},${pos.y})`"
              class="cursor-pointer focus:outline-none"
              role="button"
              tabindex="0"
              :aria-label="nodeTitle(pos.node)"
              :opacity="hovered && hovered !== id ? 0.35 : 1"
              @click="select(pos.node)"
              @keydown.enter.prevent="select(pos.node)"
              @keydown.space.prevent="select(pos.node)"
              @mouseenter="hovered = id"
              @mouseleave="hovered = null"
              @focus="hovered = id"
              @blur="hovered = null"
            >
              <title>{{ nodeTitle(pos.node) }}</title>
              <rect
                :width="NODE_W"
                :height="NODE_H"
                rx="4"
                class="stroke-gray-300 dark:stroke-gray-600"
                :class="[gapClassFill(pos.node.class), 'opacity-90']"
              />
              <text :x="8" :y="NODE_H / 2" dominant-baseline="middle" class="fill-white text-[10px] font-medium">
                {{ shortKey(displayKey(pos.node)) }}
              </text>
              <!-- Count of tests reaching this node. -->
              <g v-if="pos.node.tests.length > 0">
                <circle :cx="NODE_W - 12" :cy="NODE_H / 2" r="8" class="fill-slate-900/70" />
                <text
                  :x="NODE_W - 12"
                  :y="NODE_H / 2"
                  text-anchor="middle"
                  dominant-baseline="central"
                  class="fill-white text-[9px] font-semibold"
                >
                  {{ pos.node.tests.length > 99 ? '99+' : pos.node.tests.length }}
                </text>
              </g>
            </g>
          </g>
        </svg>
      </div>

      <NodeInspector :seed="seed" :neighbors="neighbors" :edges="graph.edges" :label="displayKey" @select="select" />
    </template>
  </div>
</template>
