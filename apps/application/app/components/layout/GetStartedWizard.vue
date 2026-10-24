<script setup lang="ts">
import { DESKTOP_DOWNLOAD_URL } from '#shared/companion-links';
import { docsUrl } from '#shared/docs';
import { DEFAULT_PROJECT_NAME, FIXTURES_FILE, normalizeProjectName, setupSnippets } from '~/utils/setup-snippets';
import { CARD_ICON_CLASS, SEGMENTED_SELECTED_CLASS, SENTENCE_LINK_CLASS } from '~/utils';

/**
 * Connect a Playwright suite: the first thing an empty instance shows, and the
 * top of Setup. The choices above the paths (project name, where local runs go,
 * the API key) rewrite every snippet below them; each path ends in the same
 * setup, `wrapConfig` plus the capture fixtures, which is what `init` writes.
 */
const props = withDefaults(
  defineProps<{
    /**
     * Include the optional "What do you want Piwi for?" capability step. Only
     * the Home placement sets this; the Setup page owns that question through
     * its own presets card, so the wizard omits the step there.
     */
    showCapabilityStep?: boolean;
  }>(),
  { showCapabilityStep: false },
);

const config = useRuntimeConfig();
const authEnabled = computed(() => !!config.public.authEnabled);
const isDesktop = useIsDesktop();
const { canSeeAdmin } = useAuth();

// The dashboard's own address, for the snippets; the browser knows it, the server render does not.
const origin = ref('http://localhost:3000');
onMounted(() => {
  origin.value = window.location.origin;
});

const projectName = ref(DEFAULT_PROJECT_NAME);
/** Web build: a developer's local runs go to their desktop app while it runs. */
const preferDesktopApp = ref(false);
/** Desktop build: the suite's CI runs report to a team server. */
const teamServer = ref(false);
const teamServerUrl = ref('');
const TEAM_SERVER_PLACEHOLDER = 'https://piwi.example.com';

const choices = computed(() => {
  if (isDesktop) {
    const url = teamServerUrl.value.trim().replace(/\/+$/, '') || TEAM_SERVER_PLACEHOLDER;
    return {
      projectName: projectName.value,
      serverUrl: teamServer.value ? url : null,
      preferDesktopApp: teamServer.value,
      needsApiKey: teamServer.value,
    };
  }
  return {
    projectName: projectName.value,
    serverUrl: origin.value,
    preferDesktopApp: preferDesktopApp.value,
    needsApiKey: authEnabled.value,
  };
});
const snippets = computed(() => setupSnippets(choices.value));
const project = computed(() => normalizeProjectName(projectName.value));

type ConnectPath = 'command' | 'agent' | 'manual';
const PATHS: { value: ConnectPath; label: string }[] = [
  { value: 'command', label: 'One command' },
  { value: 'agent', label: 'Coding agent' },
  { value: 'manual', label: 'By hand' },
];
const path = ref<ConnectPath>('command');
const reporterEntryOpen = ref(false);

/** Where the first run lands, said once under the run command. */
const runNote = computed(() => {
  if (isDesktop) {
    return teamServer.value
      ? 'It appears here while this app runs. On CI, with PIWI_API_KEY set from a secret, it goes to the team server.'
      : 'It appears here while this app runs: the reporter finds the app on its own.';
  }
  const key = authEnabled.value ? ' Set PIWI_API_KEY first.' : '';
  return preferDesktopApp.value
    ? `On a machine running the desktop app it appears there; on CI, and everywhere else, here.${key}`
    : `It streams in while it runs, and the line at the top of this card links to it.${key}`;
});

/** What each part of the setup adds, so the reporter entry alone never reads as the whole of it. */
const PARTS = [
  {
    title: 'The reporter',
    text: 'Every run kept with its tests, errors, retries, traces and HTML report, streamed live with the branch, commit and CI build. Failures grouped by root cause, flaky tests scored.',
  },
  {
    title: 'wrapConfig',
    text: 'A screenshot and a trace of every failure unless you set them: the DOM snapshot, full call stack, network with bodies and visual diff, and the aria tree of each action on Playwright 1.63+. The run shows here while your globalSetup runs.',
  },
  {
    title: 'The capture fixtures',
    text: 'Network timing and slow endpoints, Web Vitals, console errors, the ARIA snapshot at the failure, and the locator snapshots behind locator healing.',
  },
];

/** The optional capability step: administrators only, and only in the Home placement. */
const showCapabilities = computed(() => canSeeAdmin.value && props.showCapabilityStep);
</script>

<template>
  <UCard data-tour="get-started-wizard" data-shot="get-started-wizard">
    <template #header>
      <div class="flex items-start gap-3">
        <div class="p-2 bg-primary/10 rounded-lg shrink-0">
          <UIcon name="i-lucide-plug" class="size-5" :class="CARD_ICON_CLASS" data-card-icon />
        </div>
        <div class="min-w-0 space-y-1">
          <h2 class="text-lg sm:text-xl font-semibold text-highlighted inline-flex items-center gap-1">
            Connect your Playwright suite <HelpHint topic="home.get-started" />
          </h2>
          <SetupRunStatus />
        </div>
      </div>
    </template>

    <div class="space-y-8">
      <!-- The choices every snippet below is built from -->
      <section class="grid gap-6 md:grid-cols-2" data-shot="setup-choices">
        <div class="space-y-2">
          <label for="setup-project-name" class="text-sm font-semibold text-highlighted">Project name</label>
          <UInput
            id="setup-project-name"
            v-model="projectName"
            class="w-full"
            :placeholder="DEFAULT_PROJECT_NAME"
            autocomplete="off"
            spellcheck="false"
          />
          <p class="text-xs text-muted">The runs report under this name, and the first one creates the project.</p>
        </div>

        <div v-if="!isDesktop" class="space-y-2">
          <USwitch
            v-model="preferDesktopApp"
            label="Local runs go to the desktop app"
            :ui="{ label: 'text-sm font-semibold text-highlighted' }"
          />
          <p class="text-sm text-highlighted leading-relaxed">
            While the Piwi desktop app runs on a developer's machine, their local runs land there and stay theirs. CI
            runs, and runs on a machine without the app, still come here.
          </p>
          <p class="text-xs text-muted">
            Adds <code>desktopApp: 'prefer'</code>.
            <a :href="DESKTOP_DOWNLOAD_URL" target="_blank" rel="noopener noreferrer" :class="SENTENCE_LINK_CLASS"
              >Get the desktop app</a
            >
          </p>
        </div>

        <div v-else class="space-y-2">
          <USwitch
            v-model="teamServer"
            label="CI reports to a team server"
            :ui="{ label: 'text-sm font-semibold text-highlighted' }"
          />
          <p class="text-sm text-highlighted leading-relaxed">
            Local runs come to this app while it runs; CI runs, and runs with this app closed, go to your team's Piwi
            server.
          </p>
          <UInput
            v-if="teamServer"
            v-model="teamServerUrl"
            class="w-full"
            type="url"
            :placeholder="TEAM_SERVER_PLACEHOLDER"
            aria-label="Team server URL"
          />
        </div>

        <SetupApiKey v-if="!isDesktop && authEnabled" :project-name="project" class="md:col-span-2" />
      </section>

      <!-- Three ways to the same setup -->
      <section class="space-y-5" data-shot="setup-paths">
        <div
          role="group"
          aria-label="How to connect"
          class="grid grid-cols-3 gap-0.5 rounded-md bg-elevated/60 p-0.5 sm:inline-grid"
        >
          <button
            v-for="option in PATHS"
            :key="option.value"
            type="button"
            :aria-pressed="path === option.value ? 'true' : 'false'"
            class="rounded px-2 sm:px-3 py-1 text-sm whitespace-nowrap outline-none transition-colors focus-visible:outline-2 focus-visible:outline-primary"
            :class="path === option.value ? SEGMENTED_SELECTED_CLASS : 'text-muted hover:text-default'"
            @click="path = option.value"
          >
            {{ option.label }}
          </button>
        </div>

        <ol v-if="path === 'command'" class="space-y-6">
          <SetupStep :n="1" title="Run this in your Playwright project">
            <CodeBlock :code="snippets.initCommand" lang="bash" filename="Terminal" />
            <p class="text-xs text-muted">
              It installs the reporter, wraps your config with <code>wrapConfig</code>, creates
              <code>{{ FIXTURES_FILE }}</code
              >, records the connection in <code>.env.example</code> and adds the Piwi agent skills. Safe to re-run: a
              change it won't make is reported as a manual step, with the exact edit.
            </p>
          </SetupStep>
          <SetupStep :n="2" title="Import test from the fixtures in your specs">
            <CodeBlock :code="snippets.specImport" lang="typescript" filename="tests/*.spec.ts" />
            <p class="text-xs text-muted">
              The one change <code>init</code> leaves to you. A spec still importing from
              <code>@playwright/test</code> reports, without the capture.
            </p>
          </SetupStep>
          <SetupStep :n="3" title="Run your tests" last>
            <CodeBlock :code="snippets.runCommand" lang="bash" filename="Terminal" />
            <p class="text-xs text-muted">{{ runNote }}</p>
          </SetupStep>
        </ol>

        <ol v-else-if="path === 'agent'" class="space-y-6">
          <SetupStep :n="1" title="Paste this into your coding agent" last>
            <CodeBlock :code="snippets.agentPrompt" lang="text" filename="Prompt" />
            <p class="text-xs text-muted">
              Claude Code, Cursor, Copilot or any agent that runs commands. It runs <code>init</code>, finishes what
              <code>init</code> leaves manual, and moves your specs onto the fixtures, which no command does safely.
              <template v-if="choices.needsApiKey">The prompt carries no key: you set it yourself.</template>
            </p>
          </SetupStep>
        </ol>

        <ol v-else class="space-y-6">
          <SetupStep :n="1" title="Install the reporter">
            <CodeBlock :code="snippets.installCommand" lang="bash" filename="Terminal" />
            <p class="text-xs text-muted">
              Or <code>pnpm add -D</code>, <code>yarn add -D</code>, <code>bun add -d</code>.
            </p>
          </SetupStep>
          <SetupStep :n="2" title="Wrap your config">
            <CodeBlock :code="snippets.config" lang="typescript" filename="playwright.config.ts" />
            <p class="text-xs text-muted">
              <code>wrapConfig</code> adds the reporter, registers the run before your <code>globalSetup</code>, and
              keeps a screenshot and a trace of every failure unless you set them yourself.
            </p>
            <div>
              <button
                type="button"
                class="flex items-center gap-1 text-xs text-muted hover:text-default"
                :aria-expanded="reporterEntryOpen"
                @click="reporterEntryOpen = !reporterEntryOpen"
              >
                <UIcon
                  name="i-lucide-chevron-right"
                  class="size-3.5 shrink-0 transition-transform"
                  :class="reporterEntryOpen ? 'rotate-90' : ''"
                />
                Can't wrap your config? Add the reporter entry instead
              </button>
              <div v-if="reporterEntryOpen" class="mt-3 space-y-2">
                <CodeBlock :code="snippets.reporterEntryConfig" lang="typescript" filename="playwright.config.ts" />
                <p class="text-xs text-muted">
                  Results, traces and clustering work the same. The run no longer shows while your
                  <code>globalSetup</code> runs, and the trace keeps no aria tree per action: set the screenshot and
                  trace yourself, as here.
                </p>
              </div>
            </div>
          </SetupStep>
          <SetupStep :n="3" title="Add the capture fixtures">
            <CodeBlock :code="snippets.fixtures" lang="typescript" :filename="FIXTURES_FILE" />
          </SetupStep>
          <SetupStep :n="4" title="Import test from them in your specs">
            <CodeBlock :code="snippets.specImport" lang="typescript" filename="tests/*.spec.ts" />
            <p class="text-xs text-muted">
              A spec still importing from <code>@playwright/test</code> reports, without the capture.
            </p>
          </SetupStep>
          <SetupStep :n="5" title="Run your tests" last>
            <CodeBlock :code="snippets.runCommand" lang="bash" filename="Terminal" />
            <p class="text-xs text-muted">{{ runNote }}</p>
          </SetupStep>
        </ol>
      </section>

      <!-- Why the whole setup, not the reporter entry alone -->
      <section class="space-y-3 border-t border-default pt-6" data-shot="setup-parts">
        <h3 class="text-sm font-semibold text-highlighted">What each part adds</h3>
        <dl class="grid gap-4 md:grid-cols-3">
          <div v-for="part in PARTS" :key="part.title" class="space-y-1">
            <dt class="text-sm font-semibold text-highlighted">{{ part.title }}</dt>
            <dd class="text-xs text-muted leading-relaxed">{{ part.text }}</dd>
          </div>
        </dl>
        <p class="text-xs text-muted">
          The
          <a
            :href="docsUrl('guide/capture-fixtures#with-and-without-the-fixtures')"
            target="_blank"
            rel="noopener noreferrer"
            :class="SENTENCE_LINK_CLASS"
            >capture fixtures guide</a
          >
          lists each feature with and without them.
        </p>
      </section>

      <!-- Optional, Home only: which capability modules this team wants -->
      <section v-if="showCapabilities" class="space-y-3 border-t border-default pt-6">
        <p class="text-sm text-highlighted leading-relaxed">
          Optional: tell Piwi which features your team will use and it hides the rest. Skip it and nothing is stored;
          Setup asks again any time.
        </p>
        <CapabilityPresets />
      </section>
    </div>

    <template #footer>
      <div class="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
        <span>
          Every option is in the
          <a :href="docsUrl('guide/reporter')" target="_blank" rel="noopener noreferrer" :class="SENTENCE_LINK_CLASS"
            >reporter guide</a
          >, and the pipeline examples in
          <a :href="docsUrl('guide/ci')" target="_blank" rel="noopener noreferrer" :class="SENTENCE_LINK_CLASS"
            >CI &amp; sharding</a
          >.
        </span>
        <UButton
          :to="docsUrl('demo/')"
          target="_blank"
          variant="ghost"
          size="sm"
          color="neutral"
          trailing-icon="i-lucide-external-link"
        >
          Live demo with sample data
        </UButton>
      </div>
    </template>
  </UCard>
</template>
