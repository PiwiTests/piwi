<script setup lang="ts">
/**
 * Desktop shell only: check for and install app updates. Renders nothing
 * without the IPC bridge; on builds without update support (dev builds,
 * releases made without the signing key) it explains why instead of showing a
 * dead button. Progress arrives as `piwi:update-progress` events while the
 * shell downloads and installs; the restart happens only when the user asks.
 * An update the shell's startup check already found shows without a click, and
 * a checkbox turns that check's native notification on or off.
 *
 * Once an update is on offer, the shell reads the release notes of every
 * version in between from GitHub (`desktop_get_release_notes`, once per offered
 * version): the card sums them up (how many releases, how many breaking
 * changes, the newest highlights) and What's new opens them in full. Without
 * them the card links to the releases page, and installing works the same.
 */
import { parseReleaseNotes } from '#shared/changelog';

const props = defineProps<{ currentVersion?: string | null }>();

interface UpdateStatus {
  state: 'unsupported' | 'uptodate' | 'available';
  version: string | null;
  date: string | null;
}

interface UpdateSettings {
  supported: boolean;
  notify_on_startup: boolean;
  pending: UpdateStatus | null;
}

const toast = useToast();

const available = ref(false);
const checking = ref(false);
const installing = ref(false);
const installed = ref(false);
const status = ref<UpdateStatus | null>(null);
const progress = ref<{ downloaded: number; total: number | null } | null>(null);
const supported = ref(false);
const notifyOnStartup = ref(true);
const savingNotify = ref(false);
const notes = ref<DesktopReleaseNotes | null>(null);
const notesError = ref<string | null>(null);
const notesLoading = ref(false);
const notesOpen = ref(false);

let unlisten: (() => void) | null = null;

onMounted(async () => {
  const core = tauriCore();
  available.value = !!core;
  if (!core) return;
  try {
    const settings = await core.invoke<UpdateSettings>('desktop_get_update_settings');
    supported.value = settings.supported;
    notifyOnStartup.value = settings.notify_on_startup;
    if (settings.pending && !status.value) status.value = settings.pending;
  } catch {
    // Leaves the checkbox hidden; checking by hand still works.
  }
});

async function setNotifyOnStartup(value: boolean) {
  const core = tauriCore();
  if (!core) return;
  savingNotify.value = true;
  try {
    await core.invoke('desktop_set_update_notification', { enabled: value });
    notifyOnStartup.value = value;
  } catch (error) {
    toast.add({
      title: 'Could not save the update notification setting',
      description: errorMessage(error),
      color: 'error',
    });
  } finally {
    savingNotify.value = false;
  }
}

onScopeDispose(() => {
  unlisten?.();
});

async function check() {
  const core = tauriCore();
  if (!core || checking.value) return;
  checking.value = true;
  try {
    status.value = await core.invoke<UpdateStatus>('desktop_check_update');
  } catch (error) {
    toast.add({ title: 'Update check failed', description: errorMessage(error), color: 'error' });
  } finally {
    checking.value = false;
  }
}

async function install() {
  const core = tauriCore();
  const events = tauriEvent();
  if (!core || installing.value) return;
  installing.value = true;
  progress.value = { downloaded: 0, total: null };
  try {
    if (events && !unlisten) {
      unlisten = await events.listen<{ downloaded: number; total: number | null }>(
        'piwi:update-progress',
        ({ payload }) => {
          progress.value = payload;
        },
      );
    }
    await core.invoke('desktop_install_update');
    installed.value = true;
  } catch (error) {
    toast.add({ title: 'Update failed', description: errorMessage(error), color: 'error' });
    progress.value = null;
  } finally {
    installing.value = false;
  }
}

async function restart() {
  const core = tauriCore();
  if (!core) return;
  try {
    await core.invoke('desktop_restart_app');
  } catch {
    // The process is replacing itself — a dropped IPC response is expected.
  }
}

/** The version whose notes were last asked for, so each offered version is read once. */
let notesFor: string | null = null;

async function loadNotes(version: string) {
  const core = tauriCore();
  if (!core || notesFor === version) return;
  notesFor = version;
  notesLoading.value = true;
  notesError.value = null;
  try {
    const answer = await core.invoke<DesktopReleaseNotes>('desktop_get_release_notes');
    if (notesFor === version) notes.value = answer;
  } catch (error) {
    if (notesFor === version) {
      notes.value = null;
      notesError.value = (typeof error === 'string' ? error : errorMessage(error)).replace(/\.$/, '');
    }
  } finally {
    if (notesFor === version) notesLoading.value = false;
  }
}

watch(
  () => (status.value?.state === 'available' ? status.value.version : null),
  (version) => {
    if (version) void loadNotes(version);
  },
);

const notesSummary = computed(() =>
  notes.value ? summarizeReleaseNotes(notes.value.releases.map(parseReleaseNotes)) : null,
);

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const PROSE_LINK = 'underline decoration-dotted underline-offset-2 hover:decoration-solid';

const progressPercent = computed(() => {
  const p = progress.value;
  if (!p?.total) return null;
  return Math.min(100, Math.round((p.downloaded / p.total) * 100));
});
</script>

<template>
  <SectionCard v-if="available" icon="i-lucide-arrow-up-circle" title="Updates">
    <template #subtitle>
      Updates install from GitHub releases and apply on restart{{
        currentVersion ? ` — you are on v${currentVersion}` : ''
      }}.
    </template>

    <div class="space-y-3">
      <div v-if="!status" class="flex items-center justify-between gap-3">
        <p class="text-sm text-muted">Check GitHub for a newer version of the desktop app.</p>
        <UButton size="xs" icon="i-lucide-refresh-cw" :loading="checking" @click="check">Check for updates</UButton>
      </div>

      <template v-else-if="status.state === 'unsupported'">
        <p class="text-sm text-muted">
          This build has no update channel — dev builds and releases made without the update signing key cannot
          self-update. Grab new versions from the
          <ULink
            to="https://github.com/piwitests/piwi/releases/latest"
            target="_blank"
            rel="noopener noreferrer"
            class="text-primary hover:underline"
            >latest release</ULink
          >.
        </p>
      </template>

      <template v-else-if="status.state === 'uptodate'">
        <div class="flex items-center justify-between gap-3">
          <p class="text-sm flex items-center gap-2">
            <UIcon name="i-lucide-check-circle" class="size-4 text-success" /> You're on the latest version.
          </p>
          <UButton
            size="xs"
            color="neutral"
            variant="soft"
            icon="i-lucide-refresh-cw"
            :loading="checking"
            @click="check"
          >
            Check again
          </UButton>
        </div>
      </template>

      <template v-else>
        <div class="flex items-start justify-between gap-3" data-shot="desktop-update-card">
          <div class="space-y-1 min-w-0">
            <p class="text-sm font-medium">Version {{ status.version }} is available</p>
            <p v-if="notesLoading" class="text-xs text-muted">Loading what's new…</p>
            <p v-else-if="notesError" class="text-xs text-muted">
              What's new is unavailable: {{ notesError }}.
              <ULink :to="RELEASES_PAGE_URL" target="_blank" rel="noopener noreferrer" :class="PROSE_LINK"
                >Read the release notes on GitHub</ULink
              >
            </p>
            <template v-else-if="notes && notesSummary">
              <p class="text-xs text-muted" data-testid="release-notes-summary">
                <template v-if="notesSummary.count">
                  {{ plural(notesSummary.count, 'release', 'releases') }} since v{{ notes.installed }}
                </template>
                <template v-else>No release notes found since v{{ notes.installed }}</template>
                <template v-if="notesSummary.breaking.length">
                  · {{ plural(notesSummary.breaking.length, 'breaking change', 'breaking changes') }}
                </template>
              </p>
              <ul v-if="notesSummary.preview.length" class="space-y-0.5">
                <!-- eslint-disable-next-line vue/no-v-html -- inlineMarkdownHtml escapes before it adds its tags -->
                <li
                  v-for="(line, i) in notesSummary.preview"
                  :key="i"
                  class="text-sm text-highlighted leading-relaxed line-clamp-3 before:content-['•'] before:mr-2 before:text-muted"
                  v-html="inlineMarkdownHtml(line)"
                />
              </ul>
              <UButton
                size="xs"
                color="neutral"
                variant="outline"
                class="mt-1"
                data-testid="release-notes-open"
                @click="notesOpen = true"
              >
                What's new
              </UButton>
            </template>
          </div>
          <UButton
            v-if="!installed"
            size="xs"
            icon="i-lucide-download"
            :loading="installing"
            class="shrink-0"
            @click="install"
          >
            {{ installing ? 'Installing…' : 'Install update' }}
          </UButton>
          <UButton v-else size="xs" color="success" icon="i-lucide-rotate-cw" class="shrink-0" @click="restart">
            Restart now
          </UButton>
        </div>
        <UProgress v-if="installing && progressPercent !== null" :model-value="progressPercent" size="sm" />
        <p v-if="installed" class="text-xs text-muted">
          The update is installed — it applies the next time the app starts.
        </p>
        <DesktopReleaseNotesModal
          v-if="notes"
          v-model:open="notesOpen"
          :notes="notes"
          :installing="installing"
          :installed="installed"
          @install="install"
        />
      </template>

      <UCheckbox
        v-if="supported"
        :model-value="notifyOnStartup"
        :disabled="savingNotify"
        label="Show a notification at startup when an update is available"
        description="Checks GitHub for a newer release each time the app starts."
        @update:model-value="setNotifyOnStartup($event === true)"
      />
    </div>
  </SectionCard>
</template>
