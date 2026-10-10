<script setup lang="ts">
/**
 * The tools that ship alongside the dashboard but install elsewhere — the
 * browser extension, the desktop app, the reporter CLI, MCP agent access, the
 * editor extensions and the IDE hand-off. Unlike the capability ladder above it, none of these leave
 * evidence on the instance, so the card is informative rather than detected.
 */
import {
  DESKTOP_DOWNLOAD_URL,
  JETBRAINS_PLUGIN_URL,
  PICKER_CHROME_URL,
  PICKER_FIREFOX_URL,
} from '#shared/companion-links';

const isDesktop = useIsDesktop();
</script>

<template>
  <SectionCard icon="i-lucide-blocks" title="Companion tools" data-shot="companion-tools">
    <template #subtitle>
      Separate installs that work with this dashboard — none is required, each picks up where the dashboard leaves off.
    </template>

    <ul class="divide-y divide-default">
      <li class="flex gap-4 py-4 first:pt-0 last:pb-0">
        <div class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-elevated text-dimmed">
          <UIcon name="i-lucide-mouse-pointer-click" class="size-5" />
        </div>
        <div class="flex-1 min-w-0">
          <h3 class="font-medium mb-1">Piwi Picker browser extension</h3>
          <p class="text-sm text-gray-600 dark:text-gray-400">
            Pick ranked, uniqueness-checked Playwright locators from any live page, record interactions into a spec, and
            match recordings against a project's test-function catalog. Works standalone — connecting to this instance
            is opt-in.
          </p>
          <div class="flex items-center gap-3 mt-2 text-sm">
            <UButton :to="PICKER_CHROME_URL" target="_blank" size="xs" variant="soft" icon="i-lucide-download">
              Chrome Web Store
            </UButton>
            <UButton :to="PICKER_FIREFOX_URL" target="_blank" size="xs" variant="soft" icon="i-lucide-download">
              Firefox Add-ons
            </UButton>
            <DocLink to="features/extension" class="text-sm">Docs</DocLink>
          </div>
        </div>
      </li>

      <li v-if="!isDesktop" class="flex gap-4 py-4 first:pt-0 last:pb-0">
        <div class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-elevated text-dimmed">
          <UIcon name="i-lucide-monitor" class="size-5" />
        </div>
        <div class="flex-1 min-w-0">
          <h3 class="font-medium mb-1">Desktop app</h3>
          <p class="text-sm text-gray-600 dark:text-gray-400">
            This same dashboard as a local app — no Docker or Node needed, and the reporter finds it automatically when
            nothing else is configured. For one developer's own history on a laptop.
          </p>
          <div class="flex items-center gap-3 mt-2 text-sm">
            <UButton :to="DESKTOP_DOWNLOAD_URL" target="_blank" size="xs" variant="soft" icon="i-lucide-download">
              GitHub Releases
            </UButton>
            <DocLink to="features/desktop" class="text-sm">Docs</DocLink>
          </div>
        </div>
      </li>

      <li class="flex gap-4 py-4 first:pt-0 last:pb-0">
        <div class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-elevated text-dimmed">
          <UIcon name="i-lucide-terminal" class="size-5" />
        </div>
        <div class="flex-1 min-w-0">
          <h3 class="font-medium mb-1">Reporter CLI</h3>
          <p class="text-sm text-gray-600 dark:text-gray-400">
            The reporter package doubles as a CLI:
            <code class="bg-gray-100 dark:bg-gray-800 px-1 rounded">init</code> wires a Playwright project in one
            command, <code class="bg-gray-100 dark:bg-gray-800 px-1 rounded">gate</code> fails a build on this
            dashboard's analysis instead of the raw exit code, and
            <code class="bg-gray-100 dark:bg-gray-800 px-1 rounded">run</code> /
            <code class="bg-gray-100 dark:bg-gray-800 px-1 rounded">select</code> execute a named test selection.
          </p>
          <div class="flex items-center gap-3 mt-2 text-sm">
            <DocLink to="guide/getting-started#fast-path-one-command" class="text-sm">init</DocLink>
            <DocLink to="guide/ci#blocking-a-merge" class="text-sm">gate</DocLink>
            <DocLink to="features/test-selection" class="text-sm">run &amp; select</DocLink>
          </div>
        </div>
      </li>

      <li class="flex gap-4 py-4 first:pt-0 last:pb-0">
        <div class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-elevated text-dimmed">
          <UIcon name="i-lucide-bot" class="size-5" />
        </div>
        <div class="flex-1 min-w-0">
          <h3 class="font-medium mb-1">MCP server &amp; agent skills</h3>
          <p class="text-sm text-gray-600 dark:text-gray-400">
            AI agents query runs, flaky tests, clusters and diagnoses over MCP, and the reporter CLI installs SKILL.md
            workflows — investigate a failure, apply a healed locator, stabilize flaky tests — into your test project.
          </p>
          <div class="flex items-center gap-3 mt-2 text-sm">
            <UButton to="/mcp" size="xs" variant="soft" icon="i-lucide-plug">MCP setup</UButton>
            <DocLink to="features/agent-skills" class="text-sm">Skills docs</DocLink>
          </div>
        </div>
      </li>

      <li class="flex gap-4 py-4 first:pt-0 last:pb-0">
        <div class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-elevated text-dimmed">
          <UIcon name="i-lucide-puzzle" class="size-5" />
        </div>
        <div class="flex-1 min-w-0">
          <h3 class="font-medium mb-1">Editor extensions</h3>
          <p class="text-sm text-gray-600 dark:text-gray-400">
            The Piwi plugin for JetBrains IDEs (WebStorm, IntelliJ IDEA Ultimate, Rider) and the Piwi extension for VS
            Code put this dashboard's answers on the line you edit: the latest CI failures at their failing lines with
            the locator heal as a quick fix, and the tests behind each locator and file.
          </p>
          <div class="flex items-center gap-3 mt-2 text-sm">
            <UButton :to="JETBRAINS_PLUGIN_URL" target="_blank" size="xs" variant="soft" icon="i-lucide-download">
              JetBrains Marketplace
            </UButton>
            <DocLink to="features/editors" class="text-sm">Docs</DocLink>
          </div>
        </div>
      </li>

      <li class="flex gap-4 py-4 first:pt-0 last:pb-0">
        <div class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-elevated text-dimmed">
          <UIcon name="i-lucide-code" class="size-5" />
        </div>
        <div class="flex-1 min-w-0">
          <h3 class="font-medium mb-1">Open in IDE</h3>
          <p class="text-sm text-gray-600 dark:text-gray-400">
            Every source path in the dashboard is a click away from your editor — VS Code, JetBrains, or a custom URL
            scheme. Configured per browser from any source path, since the source lives on your machine.
          </p>
          <div class="flex items-center gap-3 mt-2 text-sm">
            <DocLink to="features/ide-integration" class="text-sm">Docs</DocLink>
          </div>
        </div>
      </li>
    </ul>
  </SectionCard>
</template>
