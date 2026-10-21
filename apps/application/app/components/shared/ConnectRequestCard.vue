<script setup lang="ts">
/**
 * The page a signed-in user answers a client's connection request on: the
 * logo and one card with the title, the loading state or the error, and the
 * request itself in the default slot. Paired with `useConnectRequest` and
 * `ConnectRequestButtons`.
 */
import type { HelpTopicKey } from '~/utils/help-content';

defineProps<{
  title: string;
  /** The card's `data-shot`, for the feature screenshots. */
  shot: string;
  loading: boolean;
  /** Why there is no request to show. */
  error: string;
  help?: HelpTopicKey;
}>();
</script>

<template>
  <div class="min-h-screen flex flex-col items-center justify-center bg-elevated/50 gap-6 px-4 py-8">
    <BrandLogo class="h-16" />

    <UCard class="w-full max-w-md" :data-shot="shot">
      <template #header>
        <div class="flex items-center gap-2">
          <h1 class="text-lg sm:text-xl font-semibold text-highlighted">{{ title }}</h1>
          <HelpHint v-if="help" :topic="help" />
        </div>
      </template>

      <LoadingState v-if="loading" text="Loading…" />
      <p v-else-if="error" class="text-sm text-highlighted leading-relaxed">{{ error }}</p>
      <slot v-else />
    </UCard>
  </div>
</template>
