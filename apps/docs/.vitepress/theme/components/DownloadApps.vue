<script setup lang="ts">
/**
 * Download links for the desktop app and Piwi Runner (apps/application/shared/app-downloads.mjs). The page as built
 * lists every installer, each linking to GitHub's latest release page, so it reads the same without JavaScript. In the
 * browser it asks GitHub which files the latest release holds: a file it holds links to itself, any other to the
 * release page. The installer of the visitor's system becomes a button and the others fold under "Other systems".
 * The system is read from the browser: Windows, macOS and Linux reliably, a Mac's chip only from Chromium's client
 * hints, and never a Linux distribution, so Linux offers the AppImage first.
 *
 *   <DownloadApps />                both apps
 *   <DownloadApps app="desktop" />  one app
 */
import { computed, onMounted, ref } from 'vue'
import { withBase } from 'vitepress'
import {
  DOWNLOAD_APPS,
  DOWNLOAD_PACKAGES,
  LATEST_RELEASE_URL,
  assetName,
  detectMacChip,
  detectOs,
  downloadUrl,
  latestReleaseFiles,
  type DownloadApp,
  type DownloadOs,
  type DownloadPackage,
} from '#shared/app-downloads.mjs'

const props = defineProps<{ app?: 'desktop' | 'runner' }>()

const OS_NAMES: Record<DownloadOs, string> = { windows: 'Windows', macos: 'macOS', linux: 'Linux' }
/** The latest release's file names, kept for the visit so each page asks GitHub once. */
const FILES_KEY = 'piwi-latest-release-files'

const apps = computed(() => DOWNLOAD_APPS.filter((app) => !props.app || app.id === props.app))
const os = ref<DownloadOs | null>(null)
const intelMac = ref(false)
const files = ref<Set<string> | null>(null)

function storedFiles(): Set<string> | null {
  try {
    const stored = sessionStorage.getItem(FILES_KEY)
    return stored ? new Set(JSON.parse(stored) as string[]) : null
  } catch {
    return null
  }
}

onMounted(async () => {
  os.value = detectOs(navigator)
  if (os.value === 'macos') void detectMacChip(navigator).then((chip) => (intelMac.value = chip === 'x86'))
  files.value = storedFiles() ?? (await latestReleaseFiles((url, init) => fetch(url, init)))
  try {
    if (files.value) sessionStorage.setItem(FILES_KEY, JSON.stringify([...files.value]))
  } catch {
    // Without storage, the next page asks GitHub again.
  }
})

const own = computed(() => (os.value ? DOWNLOAD_PACKAGES.filter((pkg) => pkg.os === os.value) : []))
const others = computed(() => (os.value ? DOWNLOAD_PACKAGES.filter((pkg) => pkg.os !== os.value) : DOWNLOAD_PACKAGES))

const href = (app: DownloadApp, pkg: DownloadPackage) => downloadUrl(app, pkg, files.value)
const onRelease = (app: DownloadApp, pkg: DownloadPackage) => !!files.value?.has(assetName(app, pkg))
</script>

<template>
  <div class="downloads">
    <div v-for="app in apps" :key="app.id" class="download-app">
      <p class="download-name">
        <a :href="withBase(`/${app.doc}.html`)">{{ app.name }}</a>
        <span v-if="!props.app" class="download-summary">{{ app.summary }}</span>
      </p>
      <p v-if="os && intelMac" class="download-note">
        This Mac reports an Intel chip, and {{ app.name }} is built for Apple silicon only:
        <a class="no-icon" :href="href(app, own[0]!)">{{ own[0]!.label }}</a>.
      </p>
      <p v-else-if="os && own.length" class="download-own">
        <a class="download-button no-icon" :href="href(app, own[0]!)">{{
          files && !onRelease(app, own[0]!) ? 'Open the latest release' : `Download for ${OS_NAMES[os]}`
        }}</a>
        <span class="download-label">{{ own[0]!.label }}</span>
        <template v-for="pkg in own.slice(1)" :key="pkg.file">
          · <a class="no-icon" :href="href(app, pkg)">{{ pkg.label }}</a>
        </template>
      </p>
      <details :open="!os">
        <summary>{{ os ? 'Other systems' : 'Installers' }}</summary>
        <ul>
          <li v-for="pkg in others" :key="pkg.file">
            <a class="no-icon" :href="href(app, pkg)">{{ pkg.label }}</a>
          </li>
        </ul>
      </details>
    </div>
    <p class="download-foot">
      From the <a :href="LATEST_RELEASE_URL">latest release</a>, with its notes and every file.
    </p>
  </div>
</template>

<style scoped>
.downloads {
  margin: 16px 0;
  display: grid;
  gap: 12px;
}
.download-app {
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  padding: 12px 16px;
}
.download-app p {
  margin: 0 0 8px;
}
.download-name a {
  font-weight: 600;
}
.download-summary {
  margin-left: 8px;
  color: var(--vp-c-text-2);
  font-size: 14px;
}
.download-own {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  font-size: 14px;
}
.download-button {
  display: inline-block;
  border-radius: 20px;
  padding: 4px 16px;
  background: var(--vp-button-brand-bg);
  color: var(--vp-button-brand-text) !important;
  font-weight: 600;
  text-decoration: none !important;
}
.download-button:hover {
  background: var(--vp-button-brand-hover-bg);
}
.download-label,
.download-note {
  color: var(--vp-c-text-2);
  font-size: 14px;
}
.download-app details {
  font-size: 14px;
}
.download-app summary {
  cursor: pointer;
  color: var(--vp-c-text-2);
}
.download-app ul {
  margin: 4px 0 0;
}
.download-foot {
  margin: 0;
  color: var(--vp-c-text-2);
  font-size: 14px;
}
</style>
