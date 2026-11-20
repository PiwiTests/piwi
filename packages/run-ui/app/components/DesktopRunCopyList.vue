<script setup lang="ts">
/**
 * Desktop shell only: the code made at the stops of the runs the shell started, and the locators their tests picked,
 * the latest first, each to copy. The desktop app holds no editor's pairing, so the code is not written anywhere: an
 * Assert a region or a Mock a request, and the steps or an assertion an agent made (the app's MCP tools), shows its
 * block, which goes above the stopped line, and apart the import lines it needs at the top of its file, each with its
 * own Copy; a locator picked (the pause bar's Pick a locator, a pick on the image), or one an agent picked for the
 * stopped line, shows with the place of its call. What to check in the code is listed under it.
 */
import type { DesktopKept } from '../composables/useDesktopRunHub';
import { desktopCodeItem, desktopPickItem, type DesktopCopyItem } from '../utils/run-view';

const props = defineProps<{ kept: readonly DesktopKept[]; roots: Readonly<Record<string, string | null>> }>();
const words = useRunUiWords();
const { t } = words;

/** How many the list shows before Show all. */
const SHOWN = 3;
const all = ref(false);

const items = computed((): DesktopCopyItem[] =>
  [...props.kept]
    .reverse()
    .map((kept) =>
      kept.type === 'stop-code'
        ? desktopCodeItem(kept.code, props.roots[kept.code.ref] ?? null, `code-${kept.serial}`, words)
        : desktopPickItem(kept.pick, `pick-${kept.serial}`, words),
    ),
);
const visible = computed(() => (all.value ? items.value : items.value.slice(0, SHOWN)));

const { copy } = useCopy();
</script>

<template>
  <section
    v-if="items.length"
    aria-labelledby="desktop-run-copy-title"
    class="px-3 py-2 space-y-2"
    data-shot="desktop-run-copy"
  >
    <h3 id="desktop-run-copy-title" class="text-sm font-semibold text-highlighted">{{ t('runui_copyHeading') }}</h3>
    <article v-for="item in visible" :key="item.key" class="space-y-1.5">
      <p class="flex flex-wrap items-baseline gap-x-2 text-sm">
        <span class="font-semibold text-highlighted">{{ item.title }}</span>
        <span v-if="item.place && item.kind === 'locator'" class="font-mono text-xs text-muted break-all">{{
          item.place
        }}</span>
      </p>
      <template v-if="item.kind === 'locator'">
        <div class="flex items-center gap-1.5 min-w-0">
          <LocatorCode :locator="item.text" truncate class="min-w-0" />
          <UButton
            size="xs"
            color="neutral"
            variant="outline"
            @click="copy(item.text, { toast: t('runui_copyLocatorCopied') })"
          >
            {{ t('runui_commonCopy') }}
          </UButton>
        </div>
      </template>
      <template v-else>
        <CodeBlock
          :code="item.text"
          lang="typescript"
          :filename="item.place ? t('runui_copyAbove', { place: item.place }) : undefined"
        />
        <div class="flex flex-wrap gap-1.5">
          <UButton
            size="xs"
            color="neutral"
            variant="outline"
            @click="copy(item.text, { toast: t('runui_copyCodeCopied') })"
          >
            {{ t('runui_commonCopy') }}
          </UButton>
          <UButton
            v-if="item.imports.length"
            size="xs"
            color="neutral"
            variant="outline"
            @click="copy(item.imports.join('\n'), { toast: t('runui_copyImportsCopied') })"
          >
            {{ t('runui_copyImports') }}
          </UButton>
        </div>
        <CodeBlock
          v-if="item.imports.length"
          :code="item.imports.join('\n')"
          lang="typescript"
          :filename="t('runui_copyImportsPlace')"
        />
        <ul v-if="item.warnings.length" :aria-label="t('runui_copyWarnings')" class="space-y-0.5">
          <li v-for="warning in item.warnings" :key="warning" class="text-xs text-muted">{{ warning }}</li>
        </ul>
      </template>
    </article>
    <UButton v-if="items.length > SHOWN" size="xs" color="neutral" variant="ghost" @click="all = !all">
      {{ all ? t('runui_copyShowFewer') : t('runui_copyShowAll', { total: words.number(items.length) }) }}
    </UButton>
  </section>
</template>
