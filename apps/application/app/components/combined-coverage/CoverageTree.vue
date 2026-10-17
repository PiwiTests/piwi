<script setup lang="ts">
/**
 * A commit's coverage as a foldable tree of the repository's folders and
 * files, each with its bar, its share of lines run and its lines no suite
 * ran. A folder's children are read when it opens
 * (`GET /api/projects/:id/coverage-tree?folder=`); the open folders are kept
 * per project in this browser. A folder's name selects it (`select`), its
 * chevron only folds it; a file opens its view, marked by suite. Files no
 * suite names show in place, greyed. `sort` orders each folder's children by
 * name, or by lines no suite ran, the most first.
 */
import type { CoverageTree } from '~~/server/utils/coverage-summary';
import { formatCount, formatPercent } from '~/utils/combined-coverage';

type Entry = CoverageTree['entries'][number];

const props = defineProps<{
  projectId: number;
  commit: string;
  area: string | null;
  /** The selected folder, '' for the repository root. */
  selected: string;
  sort: 'name' | 'unrun';
}>();
const emit = defineEmits<{ select: [folder: string] }>();

const expandedStore = useLocalStorage<string[]>(`piwi-coverage-tree-${props.projectId}`, [], {
  initOnMounted: true,
  writeDefaults: false,
});
const expanded = computed(() => new Set(expandedStore.value));

const children = ref(new Map<string, Entry[] | 'loading' | 'error'>());

async function load(folder: string) {
  const known = children.value.get(folder);
  if (known && known !== 'error') return;
  children.value.set(folder, 'loading');
  const at = { commit: props.commit, area: props.area };
  try {
    const tree = await $fetch<CoverageTree>(`/api/projects/${props.projectId}/coverage-tree`, {
      query: { commit: at.commit, folder: folder || undefined, area: at.area ?? undefined },
    });
    // A commit or an area changed while reading: this answer is for another tree.
    if (at.commit !== props.commit || at.area !== props.area) return;
    children.value.set(folder, tree.entries);
  } catch {
    children.value.set(folder, 'error');
  }
}

/** The folders above `folder`, and itself: `a`, `a/b` for `a/b`. */
function lineage(folder: string): string[] {
  const parts = folder ? folder.split('/') : [];
  return parts.map((_, i) => parts.slice(0, i + 1).join('/'));
}

function setExpanded(folder: string, open: boolean) {
  const next = new Set(expandedStore.value);
  if (open) next.add(folder);
  else next.delete(folder);
  expandedStore.value = [...next];
  if (open) void load(folder);
}

function toggle(entry: Entry) {
  setExpanded(entry.path, !expanded.value.has(entry.path));
}

function pick(entry: Entry) {
  if (!expanded.value.has(entry.path)) setExpanded(entry.path, true);
  emit('select', entry.path);
}

// A new commit or area is another tree: read it again, from the root and every open folder.
watch(
  () => [props.commit, props.area] as const,
  () => {
    children.value = new Map();
    void load('');
    for (const folder of expandedStore.value) void load(folder);
  },
  { immediate: true },
);
// The selected folder shows, its parents open.
watch(
  () => props.selected,
  (folder) => {
    for (const parent of lineage(folder)) if (!expanded.value.has(parent)) setExpanded(parent, true);
  },
  { immediate: true },
);
watch(expandedStore, (folders) => {
  for (const folder of folders) void load(folder);
});

function ordered(entries: Entry[]): Entry[] {
  if (props.sort === 'name') return entries;
  return [...entries].sort(
    (a, b) =>
      (a.kind === b.kind ? 0 : a.kind === 'folder' ? -1 : 1) ||
      b.unrunLines - a.unrunLines ||
      (a.path < b.path ? -1 : 1),
  );
}

interface Row {
  entry: Entry | null;
  depth: number;
  /** A row standing for a folder being read, or whose read failed. */
  state?: 'loading' | 'error';
  parent?: string;
}

const rows = computed<Row[]>(() => {
  const out: Row[] = [];
  const walk = (folder: string, depth: number) => {
    const level = children.value.get(folder);
    if (level === 'loading' || level === 'error' || level === undefined) {
      out.push({ entry: null, depth, state: level === 'error' ? 'error' : 'loading', parent: folder });
      return;
    }
    for (const entry of ordered(level)) {
      out.push({ entry, depth });
      if (entry.kind === 'folder' && expanded.value.has(entry.path)) walk(entry.path, depth + 1);
    }
  };
  walk('', 0);
  return out;
});

const name = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const indent = (depth: number) => ({ paddingLeft: `${depth * 1.25}rem` });

function fileLink(path: string) {
  return { path: `/projects/${props.projectId}/coverage`, query: { file: path, marks: 'suites' } };
}
</script>

<template>
  <div class="text-sm" role="tree" aria-label="Files" data-testid="coverage-tree">
    <div
      v-for="row in rows"
      :key="row.entry ? row.entry.path : `${row.state}:${row.parent}`"
      role="treeitem"
      :aria-expanded="row.entry?.kind === 'folder' ? expanded.has(row.entry.path) : undefined"
      :aria-selected="row.entry?.kind === 'folder' && row.entry.path === selected ? true : undefined"
      class="grid grid-cols-[minmax(0,1fr)_4rem_3.5rem] sm:grid-cols-[minmax(0,1fr)_8rem_3.5rem_6rem] items-center gap-x-3 rounded px-1 py-0.5"
      :class="row.entry?.kind === 'folder' && row.entry.path === selected ? 'bg-elevated' : 'hover:bg-elevated/50'"
      :data-entry="row.entry?.path"
    >
      <template v-if="row.entry">
        <div class="flex min-w-0 items-center gap-1" :style="indent(row.depth)">
          <button
            v-if="row.entry.kind === 'folder'"
            type="button"
            class="shrink-0 rounded text-muted hover:text-highlighted focus-visible:outline-2"
            :aria-label="`${expanded.has(row.entry.path) ? 'Fold' : 'Open'} ${row.entry.path}`"
            @click="toggle(row.entry)"
          >
            <UIcon
              :name="expanded.has(row.entry.path) ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
              class="size-4 align-middle"
            />
          </button>
          <span v-else class="inline-block size-4 shrink-0" />
          <UIcon
            :name="row.entry.kind === 'folder' ? 'i-lucide-folder' : 'i-lucide-file'"
            class="size-4 shrink-0"
            :class="row.entry.noData ? 'text-dimmed' : 'text-muted'"
          />
          <button
            v-if="row.entry.kind === 'folder'"
            type="button"
            class="min-w-0 truncate text-left font-mono text-highlighted hover:underline"
            :title="`Show ${row.entry.path}/`"
            @click="pick(row.entry)"
          >
            {{ name(row.entry.path) }}/
          </button>
          <NuxtLink
            v-else-if="!row.entry.noData"
            :to="fileLink(row.entry.path)"
            class="min-w-0 truncate font-mono text-primary hover:underline"
            :title="row.entry.path"
          >
            {{ name(row.entry.path) }}
          </NuxtLink>
          <span v-else class="min-w-0 truncate font-mono text-dimmed" :title="`${row.entry.path}: no suite names it`">
            {{ name(row.entry.path) }}
          </span>
        </div>
        <template v-if="row.entry.noData">
          <span class="col-span-2 text-xs text-dimmed sm:col-span-3">no coverage data</span>
        </template>
        <template v-else>
          <CoverageBar :counts="row.entry" />
          <span class="text-right text-xs tabular-nums text-highlighted">{{
            formatPercent(row.entry.linePercent)
          }}</span>
          <span class="hidden text-right text-xs tabular-nums text-muted sm:block">
            <template v-if="row.entry.unrunLines">{{ formatCount(row.entry.unrunLines) }} not run</template>
            <template v-else-if="row.entry.filesWithoutData">{{ row.entry.filesWithoutData }} without data</template>
          </span>
        </template>
      </template>
      <span v-else class="col-span-3 text-xs text-muted sm:col-span-4" :style="indent(row.depth)">
        {{ row.state === 'error' ? 'This folder could not be read.' : 'Reading…' }}
      </span>
    </div>
  </div>
</template>
