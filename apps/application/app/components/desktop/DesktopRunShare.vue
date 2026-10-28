<script setup lang="ts">
/**
 * Desktop shell only: **Share live** for a run the shell started, which reports to a team instance: shared, its
 * workers stream their pages to the run's page there while someone watches, and say when a test is paused, for anyone
 * who can open the run on that instance. The first share in this session of the app says what goes out and to whom,
 * and waits for a yes; shared, the run says where and how many watch, with its page's link to copy and **Stop
 * sharing**. A run that cannot be shared (no instance, the project's live view off) says why when asked.
 */
import type { HubSession } from '@piwitests/core/run-hub';
import type { DesktopRunAnswer } from '~/composables/useDesktopRunHub';
import { desktopLiveText, desktopShareWarning } from '~/utils/desktop-run-view';

const props = defineProps<{ session: HubSession }>();
const emit = defineEmits<{ announce: [text: string] }>();

const hub = useDesktopRunHub();
const { copy, copied } = useCopy();

const live = computed(() => props.session.live ?? null);
const busy = ref(false);
const asking = ref(false);
/** What the last share or stop answered, while it says something the run does not show. */
const answer = ref<DesktopRunAnswer | null>(null);

async function send(on: boolean): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  const result = await hub.command({ type: 'share', ref: props.session.ref, on });
  busy.value = false;
  answer.value = result.ok ? null : result;
  if (result.message) emit('announce', result.message);
}

/** Share the run, once the person said yes to what it sends: asked the first time in this session of the app. */
function share(): void {
  if (live.value?.refused || !hub.shareAsks()) return void send(true);
  asking.value = true;
}

function confirm(): void {
  hub.shareWarned();
  asking.value = false;
  void send(true);
}
</script>

<template>
  <div v-if="live && !session.ended" class="space-y-1" data-shot="desktop-run-share">
    <div class="flex flex-wrap items-center gap-2">
      <template v-if="live.shared">
        <UBadge color="info" variant="subtle" size="sm" icon="i-lucide-radio">{{ desktopLiveText(live) }}</UBadge>
        <UButton
          v-if="live.page"
          size="xs"
          color="neutral"
          variant="ghost"
          :icon="copied ? 'i-lucide-check' : 'i-lucide-copy'"
          @click="copy(live.page)"
        >
          {{ copied ? 'Copied' : "Copy the run page's link" }}
        </UButton>
        <UButton
          size="xs"
          color="neutral"
          variant="soft"
          icon="i-lucide-circle-stop"
          :aria-disabled="busy || undefined"
          @click="send(false)"
        >
          Stop sharing
        </UButton>
      </template>
      <UTooltip v-else text="Let a teammate watch this run from its page on your Piwi instance">
        <UButton
          size="xs"
          color="neutral"
          variant="soft"
          icon="i-lucide-radio"
          :aria-disabled="busy || undefined"
          @click="share"
        >
          Share live
        </UButton>
      </UTooltip>
    </div>
    <p v-if="answer" class="text-xs text-muted" role="status">{{ answer.message }}</p>

    <UModal v-model:open="asking" title="Share this run live?" :ui="{ content: 'max-w-lg' }">
      <template #body>
        <p class="text-sm text-muted" data-shot="desktop-run-share-warning">{{ desktopShareWarning(live) }}</p>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2 w-full">
          <UButton color="neutral" variant="ghost" @click="asking = false">Cancel</UButton>
          <UButton icon="i-lucide-radio" @click="confirm">Share live</UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
