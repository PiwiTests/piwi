<script setup lang="ts">
/**
 * The top of the window: Piwi Runner's mark and name, where its connection stands, with a dot of its state (a click
 * opens the connection's settings, `connection`), and the window's two views, the runs, with how many run now, and the
 * settings.
 */
import type { TabsItem } from '@nuxt/ui';

const view = defineModel<string>('view', { required: true });
const emit = defineEmits<{ connection: [] }>();

const { connection } = useDesktopTeamRequests();
const { runs } = useRunnerRuns();
const words = useRunUiWords();
const { t } = useRunnerWords();

const host = computed(() => teamInstanceHost(connection.value.instance, words));
/** Where the connection stands, in a few words that name the instance. */
const status = computed(() => {
  switch (connection.value.state) {
    case 'online':
      return t('runner_connectedTo', { host: host.value });
    case 'connecting':
      return t('runner_connectingTo', { host: host.value });
    case 'offline':
      return t('runner_reconnectingTo', { host: host.value });
    case 'signing-in':
      return t('runner_signingInAt', { host: host.value });
    default:
      return connectionStateWords(connection.value.state, words);
  }
});
const running = computed(() => runs.value.filter((run) => run.status === 'running').length);
const views = computed<TabsItem[]>(() => [
  {
    label: t('runner_runsHeading'),
    value: 'runs',
    icon: 'i-lucide-list-checks',
    badge: running.value ? { label: words.number(running.value), color: 'primary', variant: 'solid' } : undefined,
  },
  { label: t('runner_settingsHeading'), value: 'settings', icon: 'i-lucide-settings' },
]);
</script>

<template>
  <header class="sticky top-0 z-10 border-b border-default bg-default/90 backdrop-blur" data-testid="runner-header">
    <div class="mx-auto flex max-w-3xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:px-6">
      <RunnerLogo class="size-10 shrink-0 rounded-xl shadow-sm" />
      <div class="min-w-0 flex-1">
        <h1 class="text-base leading-tight font-semibold text-highlighted">Piwi Runner</h1>
        <button
          type="button"
          :title="t('runner_connectionSettings')"
          class="mt-0.5 flex max-w-full items-center gap-1.5 rounded text-left text-xs text-muted hover:text-default focus-visible:outline-2 focus-visible:outline-primary"
          data-testid="runner-status"
          @click="emit('connection')"
        >
          <span aria-hidden="true" :class="['size-2 shrink-0 rounded-full', CONNECTION_STATE_DOTS[connection.state]]" />
          <span class="min-w-0 break-words">{{ status }}</span>
        </button>
      </div>
      <!-- A tab shows its view on a click, Enter or Space, never on focus alone. -->
      <UTabs
        :model-value="view"
        :items="views"
        :content="false"
        activation-mode="manual"
        size="sm"
        class="w-auto"
        @update:model-value="view = String($event)"
      />
    </div>
  </header>
</template>
