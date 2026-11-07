<script setup lang="ts">
/**
 * Where a run executed: each shard's runner, each project's browser and each server under test, field by field.
 * A compared field the shards disagree on is marked; a server that restarted during the run, or whose clock is off
 * the runner's, says so. Informational fields (host name, CPU) follow in the meta style.
 */
import {
  BROWSER_FIELDS,
  RUNNER_FIELDS,
  SERVER_FIELDS,
  disagreeingFields,
  environmentValue,
  serverWarnings,
  type EnvironmentField,
  type RunEnvironments,
} from '#shared/environment-snapshots';
import type { WireEnvironmentSnapshot } from '#shared/types';

const props = defineProps<{ environments: RunEnvironments }>();

interface Column {
  key: string;
  title: string;
  snapshot: WireEnvironmentSnapshot;
  warnings: string[];
}

interface Block {
  kind: 'runner' | 'browser' | 'server';
  title: string;
  columns: Column[];
  fields: readonly EnvironmentField[];
  differing: Set<string>;
}

function serverWarningText(server: Parameters<typeof serverWarnings>[0]): string[] {
  return serverWarnings(server).map((w) =>
    w === 'restarted'
      ? 'Restarted during the run'
      : `Clock ${server.clockOffsetMs! > 0 ? '+' : ''}${server.clockOffsetMs} ms off the runner's`,
  );
}

const blocks = computed<Block[]>(() => {
  const env = props.environments;
  const out: Block[] = [];
  if (env.runner.length) {
    out.push({
      kind: 'runner',
      title: 'Runner',
      fields: RUNNER_FIELDS,
      differing: new Set(disagreeingFields(env.runner).map((f) => f.key)),
      columns: env.runner.map((r) => ({
        key: `runner-${r.shardIndex ?? ''}`,
        title: r.shardIndex != null ? `Shard ${r.shardIndex}` : 'Runner',
        snapshot: r,
        warnings: r.imported ? ['From an imported report'] : [],
      })),
    });
  }
  const projects = [...new Set(env.browser.map((b) => b.project))];
  for (const project of projects) {
    const browsers = env.browser.filter((b) => b.project === project);
    out.push({
      kind: 'browser',
      title: `Browser · ${project || 'default project'}`,
      fields: BROWSER_FIELDS,
      differing: new Set(disagreeingFields(browsers).map((f) => f.key)),
      columns: browsers.map((b) => ({
        key: `browser-${b.shardIndex ?? ''}-${project}`,
        title: b.shardIndex != null ? `Shard ${b.shardIndex}` : project || 'Browser',
        snapshot: b,
        warnings: [],
      })),
    });
  }
  for (const server of env.server) {
    out.push({
      kind: 'server',
      title: `Server · ${server.origin}`,
      fields: SERVER_FIELDS.filter((f) => f.key !== 'fetchedAt' && f.key !== 'restarted'),
      differing: new Set(),
      columns: [
        { key: `server-${server.origin}`, title: server.origin, snapshot: server, warnings: serverWarningText(server) },
      ],
    });
  }
  return out;
});

function rowsOf(block: Block, informational: boolean) {
  return block.fields
    .filter((f) => !!f.informational === informational)
    .filter((f) => block.columns.some((c) => environmentValue(c.snapshot, f.key) !== null));
}
</script>

<template>
  <div class="space-y-4" data-shot="run-environment">
    <p v-if="blocks.length === 0" class="text-sm text-muted">
      No environment was recorded for this run: it comes from a reporter that does not record it, or with
      <code>collectEnvironmentInfo</code> off.
    </p>
    <section v-for="block in blocks" :key="block.title" class="space-y-2">
      <h3 class="text-sm font-semibold text-highlighted break-all">{{ block.title }}</h3>
      <p v-if="block.differing.size > 0" class="text-sm text-highlighted">
        The shards differ on
        {{ [...block.differing].map((k) => block.fields.find((f) => f.key === k)?.label).join(', ') }}.
      </p>
      <template v-for="column in block.columns" :key="column.key">
        <p v-for="warning in column.warnings" :key="warning" class="text-sm text-highlighted" data-environment-warning>
          {{ warning }}
        </p>
      </template>
      <TableScroller :min-width="block.columns.length > 2 ? '36rem' : undefined" :bleed="false">
        <table class="w-full text-sm">
          <thead v-if="block.columns.length > 1">
            <tr class="border-b border-default">
              <th class="text-left px-2 py-1 text-xs text-muted font-normal w-40">
                <span class="sr-only">Field</span>
              </th>
              <th
                v-for="column in block.columns"
                :key="column.key"
                class="text-left px-2 py-1 text-xs text-muted font-normal"
              >
                {{ column.title }}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="field in rowsOf(block, false)"
              :key="field.key"
              class="border-b last:border-b-0 border-default align-top"
              :data-differs="block.differing.has(field.key) || undefined"
            >
              <td class="px-2 py-1.5 text-muted w-40">
                {{ field.label }}<span v-if="block.differing.has(field.key)" class="text-highlighted"> · differs</span>
              </td>
              <td v-for="column in block.columns" :key="column.key" class="px-2 py-1.5 font-mono text-xs break-all">
                {{ environmentValue(column.snapshot, field.key) ?? '—' }}
              </td>
            </tr>
          </tbody>
        </table>
      </TableScroller>
      <p v-if="rowsOf(block, true).length" class="text-xs text-muted break-all">
        <template v-for="(field, i) in rowsOf(block, true)" :key="field.key">
          {{ field.label }}: {{ block.columns.map((c) => environmentValue(c.snapshot, field.key) ?? '—').join(' / ')
          }}<template v-if="i < rowsOf(block, true).length - 1"> · </template>
        </template>
      </p>
    </section>
  </div>
</template>
