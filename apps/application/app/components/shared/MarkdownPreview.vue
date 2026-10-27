<script setup lang="ts">
import { highlightCode } from '#shared/highlight';
import { inlineMarkdownHtml, type EntityLinkOptions } from '~/utils/markdown-inline';
import { isModifiedClick } from '~/utils/link-click';

const props = withDefaults(
  defineProps<{
    text: string | null;
    loading?: boolean;
    maxHeight?: string;
    /**
     * `preview` (the default): a bordered, scrolling box in a small monospace
     * font, for a context or a document shown as written. `prose`: the text in
     * the page's body style, unboxed, for an answer read as part of the page.
     */
    variant?: 'preview' | 'prose';
    /**
     * In `prose`, the entities a `[label](piwi:<type>/<id>)` link may name
     * (`assistantEntityKey` values): each renders as a link to its page, any
     * other entity as its label.
     */
    entities?: ReadonlySet<string>;
  }>(),
  { variant: 'preview', loading: false, maxHeight: undefined, entities: undefined },
);

const emit = defineEmits<{
  /** A plain click on an entity link, which routed in the app. */
  navigate: [route: string];
}>();

type PreviewLine =
  | { kind: 'h2'; text: string }
  | { kind: 'h3'; text: string }
  | { kind: 'note'; html: string }
  | { kind: 'bullet'; html: string }
  | { kind: 'numbered'; marker: string; html: string }
  | { kind: 'text'; html: string }
  | { kind: 'rule' }
  | { kind: 'blank' }
  | { kind: 'table'; headers: string[]; rows: string[][]; hasHeader: boolean }
  | { kind: 'code-start'; lang: string }
  | { kind: 'code-block'; html: string }
  | { kind: 'code-end' };

/** Split a Markdown table row into trimmed, unescaped cells. */
function tableCells(line: string): string[] {
  return line
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.replace(/\\\|/g, '|').trim());
}

const SEPARATOR_RE = /^\|?[\s:|-]*-[\s:|-]*\|?$/;

function isTableRow(line: string): boolean {
  return line.trim().startsWith('|');
}

const NUMBERED_RE = /^(\d{1,3})[.)] (.*)$/;

function parse(text: string, inline: (raw: string) => string): PreviewLine[] {
  const result: PreviewLine[] = [];
  const src = text.split('\n');
  let i = 0;
  let inCode = false;
  let codeLang = '';
  let codeLines: string[] = [];

  while (i < src.length) {
    const line = src[i]!;
    if (inCode) {
      if (line === '```') {
        if (codeLines.length) {
          const { html } = highlightCode(codeLines.join('\n'), codeLang);
          result.push({ kind: 'code-start', lang: codeLang || 'code' });
          result.push({ kind: 'code-block', html });
          result.push({ kind: 'code-end' });
        }
        inCode = false;
      } else {
        codeLines.push(line);
      }
      i++;
      continue;
    }

    if (line.startsWith('```')) {
      inCode = true;
      codeLang = line.slice(3).trim();
      codeLines = [];
      i++;
      continue;
    }

    // A GFM table: a `|`-row followed by a `| --- |` separator.
    if (isTableRow(line) && i + 1 < src.length && SEPARATOR_RE.test(src[i + 1]!.trim()) && src[i + 1]!.includes('-')) {
      const headers = tableCells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < src.length && isTableRow(src[i]!)) {
        rows.push(tableCells(src[i]!));
        i++;
      }
      const hasHeader = headers.some((h) => h !== '');
      result.push({ kind: 'table', headers, rows, hasHeader });
      continue;
    }

    if (line.startsWith('## ')) result.push({ kind: 'h2', text: line.slice(3) });
    else if (line.startsWith('### ')) result.push({ kind: 'h3', text: line.slice(4) });
    else if (line.startsWith('> ')) result.push({ kind: 'note', html: inline(line.slice(2)) });
    else if (line.startsWith('- ') || line.startsWith('* '))
      result.push({ kind: 'bullet', html: inline(line.slice(2)) });
    else if (NUMBERED_RE.test(line)) {
      const [, marker, rest] = NUMBERED_RE.exec(line)!;
      result.push({ kind: 'numbered', marker: `${marker}.`, html: inline(rest!) });
    } else if (line.trim() === '---') result.push({ kind: 'rule' });
    else if (line.trim() === '') result.push({ kind: 'blank' });
    else result.push({ kind: 'text', html: inline(line) });
    i++;
  }

  if (inCode && codeLines.length) {
    const { html } = highlightCode(codeLines.join('\n'), codeLang);
    result.push({ kind: 'code-start', lang: codeLang || 'code' });
    result.push({ kind: 'code-block', html });
    result.push({ kind: 'code-end' });
  }

  return result;
}

const config = useRuntimeConfig();

const entityLinks = computed<EntityLinkOptions | undefined>(() =>
  props.variant === 'prose' ? { known: props.entities ?? new Set(), baseURL: config.app.baseURL } : undefined,
);

function inline(raw: string): string {
  return inlineMarkdownHtml(raw, entityLinks.value);
}

const lines = computed<PreviewLine[]>(() => (props.text ? parse(props.text, inline) : []));

const prose = computed(() => props.variant === 'prose');

/** The classes of each kind of line, in either variant. */
const lineClass = computed(() =>
  prose.value
    ? {
        h2: 'text-sm font-semibold text-highlighted mt-3 mb-1 first:mt-0',
        h3: 'text-sm font-semibold text-highlighted mt-2 mb-1 first:mt-0',
        note: 'my-1 border-l-2 border-default pl-3',
        item: 'flex gap-2',
        marker: 'text-muted shrink-0',
        text: '',
        cell: 'border border-default px-2 py-1 align-top',
        code: 'font-mono text-xs',
      }
    : {
        h2: 'text-sm font-bold text-gray-900 dark:text-white mt-4 mb-0.5 first:mt-0',
        h3: 'font-semibold text-gray-700 dark:text-gray-200 mt-2 mb-0.5',
        note: 'my-1 px-2 py-0.5 rounded bg-yellow-50 dark:bg-yellow-900/20 text-yellow-800 dark:text-yellow-300 italic',
        item: 'text-gray-600 dark:text-gray-400 flex gap-1.5',
        marker: 'text-gray-400 shrink-0',
        text: 'text-gray-600 dark:text-gray-400',
        cell: 'border border-default px-2 py-1 align-top text-gray-600 dark:text-gray-400',
        code: '',
      },
);

/** Routes a plain click on an entity link in the app; the browser keeps a modified one (a new tab). */
function onClick(event: MouseEvent): void {
  const link = (event.target as Element | null)?.closest?.('a[data-route]');
  const route = link?.getAttribute('data-route');
  if (!route || isModifiedClick(event)) return;
  event.preventDefault();
  void navigateTo(route);
  emit('navigate', route);
}
</script>

<template>
  <div
    :class="
      prose
        ? 'text-sm text-highlighted leading-relaxed break-words min-w-0'
        : 'rounded-lg border border-default overflow-hidden bg-muted min-h-16'
    "
    @click="onClick"
  >
    <div v-if="loading" class="flex items-center gap-2 p-4 text-sm text-gray-500">
      <UIcon name="i-lucide-loader-2" class="size-4 animate-spin" />
      <span>Fetching context… (includes SCM diff lookup)</span>
    </div>
    <div
      v-else-if="lines.length"
      :class="prose ? '' : 'overflow-auto p-3 max-sm:p-2 text-xs font-mono leading-relaxed'"
      :style="prose ? undefined : { maxHeight: maxHeight ?? '45vh' }"
    >
      <template v-for="(line, i) in lines" :key="i">
        <div v-if="line.kind === 'h2'" :class="lineClass.h2">
          {{ line.text }}
        </div>
        <div v-else-if="line.kind === 'h3'" :class="lineClass.h3">
          {{ line.text }}
        </div>
        <!-- eslint-disable-next-line vue/no-v-html -->
        <div v-else-if="line.kind === 'note'" :class="lineClass.note" v-html="line.html" />
        <div v-else-if="line.kind === 'bullet'" :class="lineClass.item">
          <span :class="lineClass.marker">·</span>
          <!-- eslint-disable-next-line vue/no-v-html -->
          <span class="min-w-0" v-html="line.html" />
        </div>
        <div v-else-if="line.kind === 'numbered'" :class="lineClass.item">
          <span :class="lineClass.marker" class="tabular-nums">{{ line.marker }}</span>
          <!-- eslint-disable-next-line vue/no-v-html -->
          <span class="min-w-0" v-html="line.html" />
        </div>
        <!-- eslint-disable-next-line vue/no-v-html -->
        <div v-else-if="line.kind === 'text'" :class="lineClass.text" v-html="line.html" />
        <div v-else-if="line.kind === 'rule'" class="my-2 border-t border-default" />
        <div v-else-if="line.kind === 'table'" class="my-1.5 overflow-x-auto">
          <table class="w-full border-collapse text-left">
            <thead v-if="line.hasHeader">
              <tr>
                <th
                  v-for="(h, hi) in line.headers"
                  :key="hi"
                  class="border border-default px-2 py-1 font-semibold text-gray-700 dark:text-gray-200"
                  v-html="inline(h)"
                />
              </tr>
            </thead>
            <tbody>
              <tr v-for="(row, ri) in line.rows" :key="ri">
                <td
                  v-for="(cell, ci) in row"
                  :key="ci"
                  :class="[
                    lineClass.cell,
                    { 'bg-gray-100/60 dark:bg-gray-800/40 font-medium': !line.hasHeader && ci === 0 },
                  ]"
                  v-html="inline(cell)"
                />
              </tr>
            </tbody>
          </table>
        </div>
        <div v-else-if="line.kind === 'blank'" class="h-2" />
        <div
          v-else-if="line.kind === 'code-start'"
          class="mt-2 px-2 py-0.5 bg-gray-200 dark:bg-gray-700 text-gray-500 dark:text-gray-400 rounded-t text-[10px] uppercase tracking-wide"
          :class="lineClass.code"
        >
          {{ line.lang || 'code' }}
        </div>
        <div v-else-if="line.kind === 'code-block'" class="overflow-x-auto bg-gray-50 dark:bg-gray-900/40">
          <!-- eslint-disable-next-line vue/no-v-html -->
          <pre class="hljs px-2 py-1 !bg-transparent whitespace-pre-wrap" :class="lineClass.code" v-html="line.html" />
        </div>
        <div v-else-if="line.kind === 'code-end'" class="h-1 bg-gray-100 dark:bg-gray-800/50 rounded-b mb-2" />
      </template>
    </div>
    <div v-else-if="!prose" class="p-3 text-xs text-gray-400 italic">No context loaded</div>
  </div>
</template>
