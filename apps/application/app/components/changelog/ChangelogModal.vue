<script setup lang="ts">
/**
 * The changelog shipped with this build (`GET /api/changelog`), newest release
 * first, ten at a time: one fold per release (`ReleaseNotesAccordion`), the
 * release of the running version marked and open. Read the first time the
 * window opens, then kept. Opened through `useChangelog`.
 */
import type { ChangelogPage } from '#shared/changelog';
import { PROJECT_LINKS } from '#shared/piwi-ecosystem';

const { open } = useChangelog();
const config = useRuntimeConfig();
const appVersion = config.public.appVersion as string;

const pages = ref<ChangelogPage[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const openReleases = ref<string[]>([]);

const lastPage = computed(() => pages.value[pages.value.length - 1] ?? null);
const total = computed(() => lastPage.value?.total ?? 0);
const releases = computed(() =>
  pages.value.flatMap((page) => page.releases.map((release) => changelogReleaseItem(release, appVersion))),
);

async function load(cursor: string | null) {
  if (loading.value) return;
  loading.value = true;
  error.value = null;
  try {
    const page = await $fetch<ChangelogPage>('/api/changelog', { query: cursor ? { cursor } : {} });
    pages.value = [...pages.value, page];
    if (!cursor) {
      const first = page.releases.map((release) => changelogReleaseItem(release, appVersion));
      const shown = first.find((release) => release.current) ?? first[0];
      openReleases.value = shown ? [shown.key] : [];
    }
  } catch (err) {
    error.value = errorMessage(err);
  } finally {
    loading.value = false;
  }
}

watch(
  open,
  (isOpen) => {
    if (isOpen && !pages.value.length) void load(null);
  },
  { immediate: true },
);

function loadOlder() {
  const cursor = lastPage.value?.nextCursor;
  if (cursor) void load(cursor);
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The running version and the number of releases, as the window's description names them. */
const facts = computed(() =>
  [appVersion ? `You are on v${appVersion}` : null, total.value ? plural(total.value, 'release', 'releases') : null]
    .filter(Boolean)
    .join(' · '),
);

const PROSE_LINK = 'underline decoration-dotted underline-offset-2 hover:decoration-solid';
</script>

<template>
  <UModal v-model:open="open" title="Changelog" :ui="{ content: 'sm:max-w-2xl' }">
    <template #description>
      <template v-if="facts">{{ facts }} · </template>
      <ULink :to="PROJECT_LINKS.changelog" target="_blank" rel="noopener noreferrer" :class="PROSE_LINK"
        >Changelog on GitHub</ULink
      >
    </template>

    <template #body>
      <div class="space-y-4" data-shot="changelog">
        <LoadingState v-if="loading && !pages.length" text="Loading the changelog…" />
        <ErrorState v-else-if="error && !pages.length" :text="`Could not load the changelog: ${error}`">
          <template #action>
            <UButton size="xs" color="neutral" variant="outline" @click="load(null)">Try again</UButton>
          </template>
        </ErrorState>
        <p v-else-if="pages.length && !total" class="text-sm text-highlighted leading-relaxed">
          This build ships without its changelog. Read it
          <ULink :to="PROJECT_LINKS.changelog" target="_blank" rel="noopener noreferrer" :class="PROSE_LINK"
            >on GitHub</ULink
          >.
        </p>
        <template v-else-if="releases.length">
          <ReleaseNotesAccordion v-model="openReleases" :releases="releases" />
          <div v-if="lastPage?.nextCursor || error" class="flex flex-wrap items-center gap-x-3 gap-y-1">
            <UButton
              v-if="lastPage?.nextCursor"
              size="xs"
              color="neutral"
              variant="outline"
              :loading="loading"
              data-testid="changelog-older"
              @click="loadOlder"
            >
              Show older releases
            </UButton>
            <p v-if="error" class="text-xs text-muted">Could not load them: {{ error }}</p>
          </div>
        </template>
      </div>
    </template>

    <template #footer>
      <div class="flex justify-end w-full">
        <UButton color="neutral" variant="outline" @click="open = false">Close</UButton>
      </div>
    </template>
  </UModal>
</template>
