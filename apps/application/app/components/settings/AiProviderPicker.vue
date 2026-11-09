<script setup lang="ts">
/**
 * The provider tiles of Settings → AI, by group: cloud APIs, self-hosted
 * servers, and the command-line tools this server may run. Each tile says what
 * it needs: a key, nothing, or a sign-in. With `purpose="embed"` only the
 * tiles that answer the embeddings API show.
 */
import {
  type ModelPurpose,
  type ProviderTile,
  type ProviderTileGroup,
  type ProviderTileId,
  PROVIDER_TILES,
  isLocalCliProvider,
} from '~/utils/ai-provider-catalog';
import { SELECTED_ROW_CLASS } from '~/utils';

const props = defineProps<{
  purpose: ModelPurpose;
  /** Name of the choice, for assistive technology. */
  label: string;
  /** Leave out the note on the command-line tools this server does not run. */
  compact?: boolean;
}>();

const model = defineModel<ProviderTileId | null>({ required: true });

const form = useAiSettingsForm();
const cli = useLocalCliStatus();

const GROUPS: { id: ProviderTileGroup; label: string; hint: string }[] = [
  { id: 'cloud', label: 'Cloud APIs', hint: 'Need an API key' },
  { id: 'self-hosted', label: 'Self-hosted', hint: 'Your own server, on this machine or your network' },
  { id: 'cli', label: 'Command-line tools', hint: 'A tool installed where Piwi runs, with your own sign-in' },
];

const groups = computed(() =>
  GROUPS.filter((g) => g.id !== 'cli' || (form.showCliTiles.value && props.purpose !== 'embed'))
    .map((g) => ({
      ...g,
      tiles: PROVIDER_TILES.filter((t) => t.group === g.id && (props.purpose !== 'embed' || t.embeddings)),
    }))
    .filter((g) => g.tiles.length),
);

const showCliNote = computed(() => !props.compact && props.purpose !== 'embed' && !form.showCliTiles.value);

const DOT = { success: 'bg-success', warning: 'bg-warning', neutral: 'bg-inverted/30' } as const;

interface Trait {
  text: string;
  warning?: boolean;
  dot?: keyof typeof DOT;
}

function trait(tile: ProviderTile): Trait {
  if (isLocalCliProvider(tile.provider)) {
    if (!form.cliAllowed(tile.provider)) return { text: 'Not enabled on this server' };
    const v = cli.view(tile.provider);
    if (!v.checked) return { text: 'Checking…' };
    if (!v.installed) return { text: 'Not installed', dot: 'neutral' };
    const deepseek = tile.provider === 'deepseek-cli';
    return v.ready
      ? { text: deepseek ? 'Credentials set' : 'Signed in', dot: 'success' }
      : { text: deepseek ? 'No credentials' : 'Not signed in', dot: 'warning' };
  }
  if (tile.key === 'required') {
    return form.canStoreSecrets.value ? { text: 'API key' } : { text: 'Needs PIWI_SECRET_KEY', warning: true };
  }
  if (tile.key === 'none') return { text: 'No key needed' };
  return { text: 'Its address, a key if it asks' };
}

function isDisabled(tile: ProviderTile): boolean {
  return isLocalCliProvider(tile.provider) && !form.cliAllowed(tile.provider) && model.value !== tile.id;
}

onMounted(() => {
  if (props.purpose === 'embed') return;
  for (const tile of PROVIDER_TILES) {
    if (isLocalCliProvider(tile.provider) && form.cliAllowed(tile.provider) && !cli.view(tile.provider).checked) {
      cli.refresh(tile.provider);
    }
  }
});
</script>

<template>
  <div class="space-y-4">
    <div
      v-for="group in groups"
      :key="group.id"
      role="group"
      :aria-label="`${label}: ${group.label}`"
      class="space-y-2"
    >
      <p class="text-sm">
        <span class="font-semibold text-highlighted">{{ group.label }}</span>
        <span class="text-xs text-muted"> · {{ group.hint }}</span>
      </p>
      <div class="grid grid-cols-2 gap-2 lg:grid-cols-3">
        <button
          v-for="tile in group.tiles"
          :key="tile.id"
          type="button"
          :aria-pressed="model === tile.id ? 'true' : 'false'"
          :disabled="isDisabled(tile)"
          class="relative flex items-center gap-2 rounded-md border border-default px-2.5 py-2 text-left sm:gap-3 sm:px-3 transition-colors outline-none hover:bg-elevated/50 focus-visible:outline-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
          :class="model === tile.id ? SELECTED_ROW_CLASS : ''"
          :data-provider-tile="tile.id"
          @click="model = tile.id"
        >
          <span class="grid size-7 shrink-0 place-items-center rounded-md bg-elevated text-highlighted sm:size-8">
            <UIcon :name="tile.icon" class="size-4" />
          </span>
          <span class="min-w-0 pr-4">
            <span class="block text-sm font-semibold text-highlighted">{{ tile.label }}</span>
            <span
              class="flex items-center gap-1.5 text-xs"
              :class="trait(tile).warning ? 'text-warning' : 'text-muted'"
            >
              <span v-if="trait(tile).dot" class="size-1.5 shrink-0 rounded-full" :class="DOT[trait(tile).dot!]" />
              {{ trait(tile).text }}
            </span>
          </span>
          <UIcon
            v-if="model === tile.id"
            name="i-lucide-check"
            class="absolute top-2 right-2 size-4 text-highlighted"
          />
        </button>
      </div>
    </div>

    <details v-if="showCliNote" class="group rounded-md border border-dashed border-default text-sm">
      <summary
        class="flex cursor-pointer list-none items-center gap-2 px-3 py-2 outline-none focus-visible:outline-2 focus-visible:outline-primary [&::-webkit-details-marker]:hidden"
      >
        <span class="font-semibold text-highlighted">Command-line tools</span>
        <span class="text-xs text-muted">Not enabled on this server</span>
        <UIcon
          name="i-lucide-chevron-down"
          class="ml-auto size-4 text-muted transition-transform group-open:rotate-180"
        />
      </summary>
      <div class="space-y-2 px-3 pb-3 text-highlighted">
        <p>
          Claude Code, Codex and DeepSeek Harness run as a command on the machine that hosts Piwi, with your own sign-in
          instead of an API key. The desktop app offers all three; a server offers each one once the path of its command
          is set:
        </p>
        <ul class="list-disc space-y-0.5 pl-5">
          <li><code class="font-mono text-xs">PIWI_CLAUDE_CLI_PATH</code> for Claude Code</li>
          <li><code class="font-mono text-xs">PIWI_CODEX_CLI_PATH</code> for Codex</li>
          <li><code class="font-mono text-xs">PIWI_DEEPSEEK_CLI_PATH</code> for DeepSeek Harness</li>
        </ul>
      </div>
    </details>
  </div>
</template>
