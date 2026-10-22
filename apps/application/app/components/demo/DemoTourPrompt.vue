<script setup lang="ts">
/**
 * The guided tour's prompt, a card in the toast corner: picking a role starts
 * its tour, **Later** (or Escape inside the card) asks again on a visit a day
 * later, and **×** never again. It never takes focus when it appears.
 */
import { TOUR_LANGUAGE_INFO, TOUR_LANGUAGES, type TourLanguage } from '~/utils/demo-tour/languages';
import { fillGuideText } from '~/utils/guide/markup';
import { TOUR_PROFILES } from '~/utils/demo-tour/profiles';

const { promptOpen, language, copy, setLanguage, start, snooze, dismiss } = useDemoTour();

const id = useId();
const languageItems = TOUR_LANGUAGES.map((code) => ({ label: TOUR_LANGUAGE_INFO[code].label, value: code }));
const selectedLanguage = computed({
  get: () => language.value,
  set: (value: TourLanguage) => setLanguage(value),
});
</script>

<template>
  <!-- Slides in with a slight overshoot, then its edge ripples once (`.tour-prompt-attention`);
       neither under prefers-reduced-motion. -->
  <Transition
    type="transition"
    enter-active-class="transition duration-500 ease-[cubic-bezier(0.34,1.56,0.64,1)] motion-reduce:transition-none"
    enter-from-class="opacity-0 translate-y-8"
    leave-active-class="pointer-events-none transition duration-150 ease-in motion-reduce:transition-none"
    leave-to-class="opacity-0 translate-y-3"
  >
    <section
      v-if="promptOpen"
      role="dialog"
      aria-modal="false"
      :aria-labelledby="`${id}-title`"
      :aria-describedby="`${id}-body`"
      :lang="language"
      data-testid="tour-prompt"
      data-shot="demo-tour-prompt"
      class="tour-prompt-attention fixed z-50 bottom-4 inset-x-4 sm:inset-x-auto sm:right-4 sm:w-96 bg-default ring ring-accented shadow-2xl rounded-lg p-4"
      @keydown.esc="snooze"
    >
      <div class="flex items-start gap-3">
        <span class="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
          <UIcon name="i-lucide-compass" class="size-4.5" />
        </span>
        <div class="min-w-0 flex-1">
          <div class="flex items-start justify-between gap-2">
            <h2 :id="`${id}-title`" class="text-base font-semibold text-highlighted">
              {{ copy.ui.promptTitle }}
            </h2>
            <UButton
              color="neutral"
              variant="link"
              size="sm"
              icon="i-lucide-x"
              class="-me-1.5 mt-0.5 p-0.5"
              :aria-label="copy.ui.dismiss"
              :title="copy.ui.dismiss"
              data-testid="tour-dismiss"
              @click="dismiss"
            />
          </div>
          <p :id="`${id}-body`" class="mt-0.5 text-sm text-muted">{{ copy.ui.promptBody }}</p>
        </div>
      </div>

      <ul class="mt-3 grid grid-cols-2 gap-2" :aria-label="copy.ui.roles">
        <li v-for="profile in TOUR_PROFILES" :key="profile.id">
          <button
            type="button"
            class="flex h-full w-full flex-col items-start gap-0.5 rounded-md bg-default p-2.5 text-left ring ring-inset ring-default transition-colors hover:bg-elevated hover:ring-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            :data-testid="`tour-profile-${profile.id}`"
            @click="start(profile.id)"
          >
            <span class="flex items-center gap-1.5">
              <UIcon :name="profile.icon" class="size-4 shrink-0 text-muted" />
              <span class="text-sm font-medium text-highlighted">{{ copy.profiles[profile.id].label }}</span>
            </span>
            <span class="text-xs text-muted">{{ copy.profiles[profile.id].hint }}</span>
            <span class="mt-auto pt-1 text-xs text-muted">
              {{ fillGuideText(copy.ui.stopCount, { count: profile.stops.length }) }}
            </span>
          </button>
        </li>
      </ul>

      <div class="mt-3 flex items-center justify-between gap-2">
        <USelect
          v-model="selectedLanguage"
          :items="languageItems"
          color="neutral"
          variant="ghost"
          size="xs"
          icon="i-lucide-languages"
          :aria-label="copy.ui.language"
          :title="copy.ui.language"
          :ui="{ content: 'z-[70] min-w-32' }"
          data-testid="tour-language"
        />
        <UButton
          color="neutral"
          variant="outline"
          size="xs"
          :label="copy.ui.later"
          data-testid="tour-later"
          @click="snooze"
        />
      </div>
    </section>
  </Transition>
</template>

<style scoped>
/* Once the card has slid in, a primary outline ripples out from its edge, once. */
@media (prefers-reduced-motion: no-preference) {
  .tour-prompt-attention {
    animation: tour-prompt-ripple 1.2s ease-out 0.5s 1;
  }
}

@keyframes tour-prompt-ripple {
  from {
    outline: 2px solid color-mix(in oklab, var(--ui-primary) 70%, transparent);
    outline-offset: 0;
  }

  to {
    outline: 2px solid transparent;
    outline-offset: 12px;
  }
}
</style>
