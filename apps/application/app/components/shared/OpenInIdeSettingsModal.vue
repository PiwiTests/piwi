<script setup lang="ts">
/**
 * Per-browser configuration for the "Open in IDE" affordance — which method to
 * use, the local workspace root that maps a repo-relative path to an absolute
 * one, the VS Code flavor, and the JetBrains product/port. Persisted to
 * localStorage via `useOpenInIde`; never sent to the server (the source lives on
 * the visitor's machine, so the mapping is inherently per-device).
 *
 * Mounted once (in the default layout) and toggled from the file-path chooser
 * and the user menu through the composable's shared `settingsOpen` state.
 */
import {
  IDE_METHOD_LABELS,
  JETBRAINS_PRODUCTS,
  VSCODE_SCHEME_LABELS,
  type IdeMethod,
} from '~/composables/useOpenInIde';
import type { VscodeScheme } from '~/utils/ide-links';
import { JETBRAINS_PLUGIN_URL } from '#shared/companion-links';

const { prefs, settingsOpen, settingsContext, openInIde } = useOpenInIde();
const isDesktop = useIsDesktop();

const methodItems = (Object.keys(IDE_METHOD_LABELS) as IdeMethod[]).map((value) => ({
  label: IDE_METHOD_LABELS[value],
  value,
}));
const schemeItems = (Object.keys(VSCODE_SCHEME_LABELS) as VscodeScheme[]).map((value) => ({
  label: VSCODE_SCHEME_LABELS[value],
  value,
}));

const showVscode = computed(() => prefs.value.method === 'auto' || prefs.value.method === 'vscode');
const showJetbrains = computed(() => prefs.value.method !== 'vscode');

const projectKey = computed(() => settingsContext.value.projectKey ?? null);
const projectLabel = computed(
  () => settingsContext.value.projectName || (projectKey.value ? `project ${projectKey.value}` : ''),
);

/** Bind a per-project map entry, deleting the key when the field is cleared. */
function mapEntry(map: 'projectRoots' | 'jetbrainsProjectNames') {
  return computed<string>({
    get: () => (projectKey.value ? (prefs.value[map][projectKey.value] ?? '') : ''),
    set: (val) => {
      const k = projectKey.value;
      if (!k) return;
      const next = { ...prefs.value[map] };
      if (val.trim()) next[k] = val;
      else delete next[k];
      prefs.value[map] = next;
    },
  });
}
const projectRoot = mapEntry('projectRoots');
const projectJbName = mapEntry('jetbrainsProjectNames');

// The Playwright config's real file name comes from inspecting the linked folder
// (desktop shell); off desktop, fall back to the most common name so the test
// button still opens something meaningful.
const pwConfigName = ref('playwright.config.ts');
watch(
  [settingsOpen, projectKey],
  async ([open, key]) => {
    pwConfigName.value = 'playwright.config.ts';
    if (!open || !key) return;
    const linked = await getDesktopProjectLink(key);
    if (!linked?.exists) return;
    const inspection = await inspectDesktopFolder(linked.path);
    if (inspection?.playwrightConfig) pwConfigName.value = inspection.playwrightConfig;
  },
  { immediate: true },
);

/** Open a well-known file to check the current settings actually reach the editor. */
function testOpen(filePath: string) {
  openInIde({
    filePath,
    line: 1,
    projectKey: projectKey.value,
    projectName: settingsContext.value.projectName ?? null,
  });
}
</script>

<template>
  <UModal v-model:open="settingsOpen" :ui="{ content: 'max-w-lg' }">
    <template #header>
      <div class="flex items-center gap-2" data-tour="open-in-ide-settings">
        <UIcon name="i-lucide-external-link" class="size-5 text-primary" />
        <h2 class="text-base font-semibold">Open in IDE</h2>
        <HelpHint topic="ide.open" />
      </div>
    </template>

    <template #body>
      <div class="space-y-4">
        <p class="text-sm text-muted">
          Click a source path anywhere in the dashboard to open it in your editor. These preferences are stored in this
          browser only.
        </p>

        <UAlert
          v-if="isDesktop"
          color="primary"
          variant="soft"
          icon="i-lucide-app-window"
          title="Desktop app opens files directly"
          description="Files open through your IDE's command-line launcher (code, cursor, rider, idea, …), and the app says whether it started. It finds the launcher on your PATH, then where the IDEs install it: the Toolbox scripts folder, the IDE's own folder (rider64.exe on Windows, Rider.app on macOS), VS Code's bin folder. When no launcher is found it falls back to a URL scheme."
        />

        <UAlert
          v-if="showJetbrains"
          color="primary"
          variant="soft"
          icon="i-lucide-puzzle"
          title="JetBrains: install the Piwi plugin"
          description="With the Piwi plugin in your JetBrains IDE (Rider, WebStorm, IntelliJ IDEA, …) and its project connected to this instance, files open there with no setting: the IDE finds the file in its open projects, opens it at the line, and confirms it did. Auto and both JetBrains methods ask it first, on every IDE running."
        >
          <template #actions>
            <UButton :to="JETBRAINS_PLUGIN_URL" target="_blank" size="xs" variant="soft" icon="i-lucide-download">
              JetBrains Marketplace
            </UButton>
          </template>
        </UAlert>

        <UFormField
          label="Method"
          name="method"
          description="Auto asks the Piwi JetBrains plugin first, then the IDE's command-line launcher in the desktop app, then the JetBrains local server, then falls back to a URL launch."
        >
          <USelect v-model="prefs.method" :items="methodItems" class="w-full" />
        </UFormField>

        <UFormField
          label="Workspace root"
          name="defaultRoot"
          description="Absolute path to your local checkout — repo-relative paths are joined onto it (VS Code needs this)."
        >
          <UInput v-model="prefs.defaultRoot" placeholder="/home/me/my-repo" class="w-full" />
        </UFormField>

        <UFormField v-if="showVscode" label="VS Code flavor" name="vscodeScheme">
          <USelect v-model="prefs.vscodeScheme" :items="schemeItems" class="w-full" />
        </UFormField>

        <template v-if="showJetbrains">
          <div class="grid grid-cols-2 gap-3">
            <UFormField label="JetBrains product" name="jetbrainsProduct" description="e.g. idea, webstorm, pycharm.">
              <UInput v-model="prefs.jetbrainsProduct" placeholder="idea" list="jb-products" class="w-full" />
              <datalist id="jb-products">
                <option v-for="p in JETBRAINS_PRODUCTS" :key="p" :value="p" />
              </datalist>
            </UFormField>
            <UFormField label="Local server port" name="jetbrainsPort" description="The IDE's built-in server.">
              <UInput v-model.number="prefs.jetbrainsPort" type="number" class="w-full" />
            </UFormField>
          </div>
          <UFormField name="jetbrainsHttpUsesRelativePath">
            <div class="flex items-center gap-2">
              <USwitch v-model="prefs.jetbrainsHttpUsesRelativePath" />
              <span class="text-sm">Send a content-root-relative path to the local server</span>
            </div>
          </UFormField>
        </template>

        <template v-if="projectKey">
          <USeparator />
          <p class="text-xs font-medium text-muted uppercase tracking-wider">Override for {{ projectLabel }}</p>
          <UFormField
            label="Workspace root override"
            name="projectRoot"
            description="Use a different local folder for this project (monorepos, multiple checkouts)."
          >
            <UInput v-model="projectRoot" :placeholder="prefs.defaultRoot || '/home/me/this-project'" class="w-full" />
          </UFormField>
          <UFormField
            v-if="showJetbrains"
            label="JetBrains project name"
            name="projectJbName"
            description="The open IDE project name for the jetbrains:// link."
          >
            <UInput v-model="projectJbName" :placeholder="projectLabel" class="w-full" />
          </UFormField>
        </template>

        <UAlert
          v-if="showJetbrains"
          color="neutral"
          variant="soft"
          icon="i-lucide-info"
          title="JetBrains prerequisites"
          description="Without the Piwi plugin: the jetbrains:// link needs JetBrains Toolbox and the IDE project name (in Rider, the solution's name); the local server needs the IDE Remote Control plugin with 'Allow unsigned requests', and neither can confirm the file opened. When this dashboard is served over HTTPS, some browsers block requests to the IDE on localhost, or ask for your permission first."
        />

        <USeparator />
        <UFormField
          label="Test"
          name="test"
          description="Open a known file with the current settings to check it lands in your editor."
        >
          <div class="flex flex-wrap items-center gap-2">
            <UButton
              size="sm"
              color="neutral"
              variant="soft"
              icon="i-lucide-file-code"
              @click="testOpen('package.json')"
            >
              Open package.json
            </UButton>
            <UButton size="sm" color="neutral" variant="soft" icon="i-lucide-file-cog" @click="testOpen(pwConfigName)">
              Open {{ pwConfigName }}
            </UButton>
          </div>
        </UFormField>

        <div class="flex items-center justify-between pt-1">
          <DocLink to="features/ide-integration">Learn more</DocLink>
          <UButton color="neutral" @click="settingsOpen = false">Done</UButton>
        </div>
      </div>
    </template>
  </UModal>
</template>
