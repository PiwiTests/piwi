<script setup lang="ts">
import type { NuxtError } from '#app';

const props = defineProps<{
  error: NuxtError;
}>();

const route = useRoute();

const statusCode = computed(() => props.error.statusCode || 500);
// A refusal or a missing page keeps the dashboard around it, so the sidebar
// still leads elsewhere. An ended session renders alone, as the login page does,
// and so does a server error, since the layout may be what failed.
const inLayout = computed(() => statusCode.value >= 400 && statusCode.value < 500 && statusCode.value !== 401);

const NAVBAR_TITLES: Record<number, string> = { 401: 'Signed out', 403: 'No access', 404: 'Not found' };
const navbarTitle = computed(() => NAVBAR_TITLES[statusCode.value] ?? 'Error');

const view = computed(() => {
  const title = props.error.statusMessage || (statusCode.value === 404 ? 'Page not found' : 'Something went wrong');
  const message = props.error.message && props.error.message !== title ? props.error.message : '';
  const description =
    message || (statusCode.value === 404 ? 'The link may be wrong, or what it pointed to was deleted.' : '');
  return { statusCode: statusCode.value, statusMessage: title, message: description };
});

const loginLink = computed(() => ({ path: '/login', query: { redirect: route.fullPath } }));

useSeoMeta({ title: () => `${view.value.statusMessage} — Piwi Dashboard` });

useHead({
  htmlAttrs: {
    lang: 'en',
  },
});
</script>

<template>
  <UApp>
    <NuxtLoadingIndicator />

    <NuxtLayout :name="inLayout ? 'default' : false">
      <UDashboardPanel id="error-page">
        <template #header>
          <UDashboardNavbar :title="navbarTitle" />
        </template>

        <template #body>
          <UError
            as="div"
            :error="view"
            data-shot="error-page"
            :ui="{
              root: 'min-h-full py-16',
              statusCode: 'text-xs text-muted font-mono',
              statusMessage: 'mt-2 text-lg sm:text-xl font-semibold text-highlighted text-balance',
              message: 'mt-2 max-w-md text-sm text-highlighted leading-relaxed text-balance',
              links: 'mt-6 flex flex-wrap items-center justify-center gap-3',
            }"
          >
            <template #links>
              <UButton v-if="statusCode === 401" :to="loginLink" color="primary">Sign in</UButton>
              <template v-else-if="statusCode >= 500">
                <UButton color="primary" @click="clearError()">Try again</UButton>
                <UButton color="neutral" variant="outline" @click="clearError({ redirect: '/' })">
                  Back to home
                </UButton>
              </template>
              <UButton v-else color="primary" @click="clearError({ redirect: '/' })">Back to home</UButton>
            </template>
          </UError>
        </template>
      </UDashboardPanel>
    </NuxtLayout>
  </UApp>
</template>
