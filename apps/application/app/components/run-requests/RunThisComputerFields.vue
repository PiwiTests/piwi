<script setup lang="ts">
/**
 * Desktop shell only: the run dialog's fields when **This computer** is its Where (`useThisComputer`): the folder's
 * link (its first-time setup, or the folder with **Change**), the run's options (`DesktopRunOptionsFields`), the
 * environment (`DesktopEnvironmentField`), the checks of the folder for the chosen tests, and the exact commands. The
 * options start from the run button's and apply to this run alone: neither the button nor the project's defaults
 * (its Local folder settings) change.
 */
import type { ThisComputer } from '~/composables/useThisComputer';

const props = defineProps<{ here: ThisComputer }>();

const dialog = computed(() => props.here.dialog);
const projectId = computed(() => props.here.projectId);
/** Link the project's folder, checked against the tests the dialog runs. */
function chooseFolder() {
  props.here.chooseFolder(dialog.value.specFiles);
}
</script>

<template>
  <div class="space-y-4" data-testid="run-dialog-local-fields">
    <div v-if="!here.linked" class="space-y-3">
      <p class="text-sm text-highlighted leading-relaxed">
        Link this project to its folder on this machine: the one that holds its Playwright config and these tests. Piwi
        runs that folder's own Playwright with the app's bundled Node, so nothing else needs to be installed.
      </p>
      <UAlert
        v-if="here.link && !here.link.exists"
        color="warning"
        variant="soft"
        icon="i-lucide-folder-x"
        title="The linked folder no longer exists"
        :description="here.link.path"
      />
      <UButton color="neutral" variant="outline" icon="i-lucide-folder-plus" :loading="here.busy" @click="chooseFolder"
        >Choose folder…</UButton
      >
    </div>

    <template v-else>
      <div class="flex items-center justify-between gap-3">
        <code class="text-xs break-all min-w-0">{{ here.link?.path }}</code>
        <UButton
          size="xs"
          color="neutral"
          variant="ghost"
          icon="i-lucide-folder-search"
          :loading="here.busy"
          @click="chooseFolder"
        >
          Change
        </UButton>
      </div>

      <DesktopRunOptionsFields v-model="dialog.options" />
      <DesktopEnvironmentField
        v-model="dialog.environment"
        v-model:confirmed="dialog.confirmed"
        :project-id="projectId"
        purpose="run"
      />
      <p class="text-xs text-muted">
        For this run only. The project's defaults are in
        <NuxtLink :to="`/projects/${projectId}?tab=settings&section=local-folder`" :class="SENTENCE_LINK_CLASS"
          >its Local folder settings</NuxtLink
        >.
      </p>

      <UAlert
        v-if="here.playwrightMissing"
        color="warning"
        variant="soft"
        icon="i-lucide-package-x"
        title="No Playwright installation found"
      >
        <template #description>
          Neither <code class="text-xs">{{ here.link?.path }}</code> nor its parents hold a
          <code class="text-xs">node_modules</code> with Playwright. Run your package manager's install in the checkout
          first: the app runs that folder's own Playwright.
          <UButton
            size="xs"
            color="neutral"
            variant="outline"
            icon="i-lucide-refresh-cw"
            class="mt-2"
            @click="here.checkEnv()"
          >
            Re-check after installing
          </UButton>
        </template>
      </UAlert>

      <UAlert
        v-if="dialog.missingSpecs.length > 0"
        color="warning"
        variant="soft"
        icon="i-lucide-file-question"
        :title="
          dialog.wrongFolder
            ? 'None of these tests are in the linked folder'
            : 'Some tests are not in the linked folder'
        "
      >
        <template #description>
          <p>
            Not found under <code class="text-xs">{{ here.link?.path }}</code
            >: <code class="text-xs">{{ dialog.missingSpecs[0] }}</code
            ><span v-if="dialog.missingSpecs.length > 1"> and {{ dialog.missingSpecs.length - 1 }} more</span>.
          </p>
          <p class="mt-1">
            <template v-if="dialog.wrongFolder">
              This project is probably linked to another folder than the one these tests come from: the folder to link
              holds the Playwright config.
            </template>
            <template v-else> Running anyway is fine when your Playwright config puts them elsewhere. </template>
          </p>
          <UButton
            v-if="dialog.wrongFolder"
            size="xs"
            color="neutral"
            variant="outline"
            icon="i-lucide-folder-search"
            class="mt-2"
            :loading="here.busy"
            @click="chooseFolder"
          >
            Choose the right folder…
          </UButton>
        </template>
      </UAlert>

      <div class="space-y-1">
        <div class="text-xs text-muted">Runs in the linked folder</div>
        <CodeBlock v-if="dialog.plan.length" :code="dialog.preview" lang="sh" />
        <p v-else class="text-sm text-highlighted">
          Nothing: Playwright cannot select these tests by {{ dialog.options.mode === 'grep' ? 'title' : 'file path' }}.
          Select them another way.
        </p>
        <p v-if="dialog.settingsProblem" class="text-xs text-warning">
          The run would not start: <ErrorText :text="dialog.settingsProblem" />
        </p>
      </div>
    </template>
  </div>
</template>
