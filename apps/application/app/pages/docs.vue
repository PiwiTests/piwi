<script setup lang="ts">
import type { OpenApiSpec } from '~/utils/openapi';

const config = useRuntimeConfig();
const isDemo = config.public.demoMode;
const specUrl = isDemo ? '/demo/_openapi.json' : '/_openapi.json';

// In the desktop shell a `target="_blank"` link is inert, so save the spec to
// disk instead of trying (and failing) to open it in a new window.
const { isDesktop, download } = useDesktopDownload();
function onSpecClick(event: MouseEvent) {
  if (!isDesktop) return;
  event.preventDefault();
  download(specUrl, 'piwi-openapi.json');
}

useHead({
  title: 'API Reference — Piwi Dashboard',
});

// The reference UI is rendered entirely in-app from the auto-generated spec, so
// `/docs` is self-contained: no third-party CDN, works offline / air-gapped, and
// makes no outbound calls. The only failure mode left is the spec itself being
// unreachable, which falls back to a link to the raw JSON.
const {
  data: spec,
  status,
  error,
  refresh,
} = useFetch<OpenApiSpec>(specUrl, {
  key: 'openapi-spec',
  lazy: true,
  server: !isDemo,
});
</script>

<template>
  <UDashboardPanel id="docs">
    <template #header>
      <UDashboardNavbar data-tour="api-reference-page">
        <template #leading>
          <UDashboardSidebarCollapse />
          <UBreadcrumb :items="[{ label: 'API Reference', icon: 'i-lucide-book-open' }]" />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <LoadingState v-if="status === 'pending' || (!spec && !error)" text="Loading API reference…" />

      <div v-else-if="error || !spec" class="p-6">
        <ErrorState text="Couldn't load the API reference UI.">
          <template #action>
            <p class="text-sm text-muted max-w-sm">The raw OpenAPI spec is still available directly.</p>
            <div class="flex flex-wrap justify-center gap-2 mt-1">
              <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-refresh-cw" @click="() => refresh()">
                Retry
              </UButton>
              <UButton
                :to="specUrl"
                target="_blank"
                external
                size="sm"
                variant="outline"
                icon="i-lucide-file-json"
                @click="onSpecClick"
              >
                Raw OpenAPI spec
              </UButton>
            </div>
          </template>
        </ErrorState>
      </div>

      <ApiReference v-else :spec="spec" :spec-url="specUrl" />
    </template>
  </UDashboardPanel>
</template>
