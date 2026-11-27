<script setup lang="ts">
const config = useRuntimeConfig();
const demoReady = useState('demoReady', () => false);

const isDemo = config.public.demoMode;
const showLoading = computed(() => isDemo && !demoReady.value);

// After 2 s still on the loading screen, show a first-time-setup hint.
// This covers the case where the SW takes a few seconds to install
// and claim the page on first visit.
const showSetupHint = ref(false);
onMounted(() => {
  if (!isDemo) return;
  setTimeout(() => {
    if (!demoReady.value) showSetupHint.value = true;
  }, 2000);
});
</script>

<template>
  <Teleport to="body">
    <div
      v-if="showLoading"
      class="fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-white dark:bg-gray-950 transition-opacity duration-500"
    >
      <svg
        class="w-12 h-12 text-gray-400 animate-spin mb-4"
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
        viewBox="0 0 24 24"
      >
        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
        <path
          class="opacity-75"
          fill="currentColor"
          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
        />
      </svg>
      <p class="text-base font-semibold text-gray-900 dark:text-white">Piwi — live demo</p>
      <p class="mt-1 max-w-sm px-4 text-center text-sm text-gray-500">
        Your Playwright results, kept and explained. This demo runs entirely in your browser, on sample data.
      </p>
      <!-- The loading status never belongs in a search-result snippet. -->
      <div data-nosnippet class="mt-4 flex flex-col items-center">
        <p class="text-xs text-gray-400">Preparing demo…</p>
        <p v-if="showSetupHint" class="text-xs text-gray-400 mt-1">
          Setting up service worker for first use — this only happens once.
        </p>
      </div>
    </div>
  </Teleport>
</template>
