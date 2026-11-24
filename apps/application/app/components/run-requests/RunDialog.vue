<script setup lang="ts">
/**
 * The run dialog of one place (`useRunPlace`): from top to bottom, a sentence that follows the pick, **What** (the
 * place's choices, with the tests a choice names, not editable), **Where** (the person's apps and the project's CI
 * actions, a row that cannot take the chosen What disabled with the reason), and the fields of the pick: the
 * environment and the run options of Copy retry command for an app, the branch and the choice inputs for a CI action.
 * After **Send**, the same window follows what was sent (`RunFollowUp`) until **New run**.
 */
import type { RunPlace, RunWhat } from '~/composables/useRunPlace';

const props = defineProps<{ place: RunPlace }>();

const branchListId = useId();
const testCount = (n: number) => `${n} test${n === 1 ? '' : 's'}`;
/** The tests a What names, shown under it: the first few, then how many more. */
const SHOWN_TESTS = 5;

/** How much a What runs, under its label: its one test's title, how many tests, or the whole suite. */
function whatSize(w: RunWhat): string | undefined {
  if (w.wholeSuite) return w.label === 'The whole suite' ? undefined : 'The whole suite';
  if (w.count === 1 && w.tests?.length === 1) return w.tests[0];
  return w.count == null ? undefined : testCount(w.count);
}
const whatItems = computed(() =>
  props.place.whats.map((w) => ({ value: w.key, label: w.label, description: whatSize(w) })),
);
const what = computed(() => props.place.what);
/** The tests of the chosen What, listed under it when it names more than one. */
const shownTests = computed(() => {
  const tests = what.value?.tests ?? [];
  return tests.length > 1 ? tests.slice(0, SHOWN_TESTS) : [];
});
const moreTests = computed(() => Math.max(0, (what.value?.tests?.length ?? 0) - SHOWN_TESTS));
/** The line under the chosen What when CI is picked. */
const ciNote = computed(() => (props.place.ciPick ? what.value?.ci?.note : undefined));
const ciInputs = computed(() => props.place.ciPick?.inputs ?? []);
const choiceInputs = computed(() => ciInputs.value.filter((i) => i.kind === 'choice'));
const fixedInputs = computed(() => ciInputs.value.flatMap((i) => (i.kind === 'fixed' ? [`${i.name}=${i.value}`] : [])));
/** The environment the picked CI action's team run is against. */
const ciEnvironment = computed(() => props.place.ciPick?.environment ?? null);

const config = useRuntimeConfig();
const instanceAddress = computed(() => {
  if (config.public.siteUrl) return config.public.siteUrl.replace(/\/$/, '');
  if (!import.meta.client) return '';
  return new URL(config.app.baseURL || '/', window.location.origin).href.replace(/\/$/, '');
});
</script>

<template>
  <UModal v-model:open="place.open" :title="place.label" :ui="{ content: 'max-w-lg' }">
    <template #body>
      <RunFollowUp
        v-if="place.followUp"
        :follow-up="place.followUp"
        :skipped="place.followUp.kind === 'request' ? place.skipped : 0"
        :error="place.followUpError ?? place.sendError"
      />

      <div v-else class="space-y-4" data-shot="run-dialog">
        <p v-if="place.appPick" class="text-sm text-highlighted leading-relaxed" data-testid="run-dialog-sentence">
          Your app shows the request with its checks and the command; nothing runs until you click
          <strong>Run</strong> there. The run reports here, and only you see it.
        </p>
        <p v-else-if="place.ciPick" class="text-sm text-highlighted leading-relaxed" data-testid="run-dialog-sentence">
          A team run: it counts in the project's history, sends its notifications and pull-request feedback, spends CI
          minutes, and runs against
          {{ ciEnvironment ? `the ${ciEnvironment} environment` : 'the environment its job sets up' }}.
        </p>

        <div v-if="what" class="space-y-1">
          <div class="text-sm font-semibold text-highlighted">What</div>
          <URadioGroup v-if="whatItems.length > 1" v-model="place.whatKey" :items="whatItems" size="sm">
            <template #description="{ item }">
              <span class="break-words">{{ item.description }}</span>
              <template v-if="item.value === what.key">
                <ul v-if="shownTests.length" class="mt-0.5 space-y-0.5" data-testid="run-dialog-tests">
                  <li v-for="(title, i) in shownTests" :key="i" class="truncate" :title="title">{{ title }}</li>
                  <li v-if="moreTests">and {{ moreTests }} more</li>
                </ul>
                <span v-if="ciNote" class="block mt-0.5">{{ ciNote }}</span>
              </template>
            </template>
          </URadioGroup>
          <template v-else>
            <p class="text-sm text-highlighted">
              {{ what.label }}
              <span v-if="whatSize(what)" class="text-xs text-muted break-words">· {{ whatSize(what) }}</span>
            </p>
            <ul v-if="shownTests.length" class="text-xs text-muted space-y-0.5" data-testid="run-dialog-tests">
              <li v-for="(title, i) in shownTests" :key="i" class="truncate" :title="title">{{ title }}</li>
              <li v-if="moreTests">and {{ moreTests }} more</li>
            </ul>
            <p v-if="ciNote" class="text-xs text-muted">{{ ciNote }}</p>
          </template>
        </div>

        <div class="space-y-2">
          <div class="text-sm font-semibold text-highlighted">Where</div>
          <LoadingState v-if="!place.ready" />
          <template v-else>
            <div v-if="place.appsShown" class="space-y-1">
              <div class="text-xs text-muted">Your apps</div>
              <URadioGroup
                v-if="place.appRows.length"
                v-model="place.where"
                :items="place.appRows"
                size="sm"
                aria-label="Your apps"
                data-testid="run-dialog-apps"
              />
              <p v-else class="text-sm text-highlighted leading-relaxed">
                No app of yours takes run requests yet. In Piwi Desktop, open
                <strong>Settings → Desktop app</strong> and connect it to
                <code class="text-xs">{{ instanceAddress }}</code> under <strong>Run on my machine</strong>.
                <DocLink to="features/run-on-my-machine" no-icon :class="SENTENCE_LINK_CLASS">How it works</DocLink>
              </p>
            </div>
            <div v-if="place.ciShown" class="space-y-1">
              <div class="text-xs text-muted">CI</div>
              <URadioGroup
                v-model="place.where"
                :items="place.ciRows"
                size="sm"
                aria-label="CI"
                data-testid="run-dialog-ci"
              />
            </div>
          </template>
        </div>

        <template v-if="place.appPick">
          <div v-if="place.environmentOffered" class="space-y-1" data-testid="run-dialog-environment">
            <div class="text-sm font-semibold text-highlighted">Environment</div>
            <EnvironmentPicker v-model="place.environmentId" :project-id="place.projectId" class="w-full sm:w-64" />
            <p v-if="place.protectedPick" class="flex items-start gap-1.5 text-xs text-highlighted">
              <UIcon name="i-lucide-triangle-alert" class="size-3.5 shrink-0 mt-px text-warning" aria-hidden="true" />
              <span
                >{{ place.protectedPick.name }} is protected: the run keeps to the tests tagged
                {{ place.protectedPick.requiredTags.join(', ') }} and the setup and teardown projects they depend on,
                and your app asks you to confirm it.</span
              >
            </p>
          </div>
          <RetryCommandOptions :projects="place.whatProjects" :naming="false" class="-mx-2" />
        </template>

        <template v-else-if="place.ciPick">
          <div class="space-y-1" data-testid="run-dialog-branch">
            <div class="text-sm font-semibold text-highlighted">Branch</div>
            <p v-if="place.ciPick.branch.mode === 'fixed'" class="text-sm text-highlighted">
              Runs on the job's configured branch
            </p>
            <template v-else>
              <UInput
                v-model="place.branch"
                :list="branchListId"
                :placeholder="place.ciPick.branch.default ?? 'The CI’s default branch'"
                aria-label="Branch"
                autocomplete="off"
                class="w-full sm:w-64"
                @update:model-value="(value: string | number) => place.searchBranches(String(value ?? ''))"
              />
              <datalist :id="branchListId">
                <option v-for="name in place.branches" :key="name" :value="name" />
              </datalist>
              <p v-if="place.refProblem" class="text-xs text-error">{{ place.refProblem }}</p>
            </template>
          </div>
          <div v-for="input in choiceInputs" :key="input.name" class="space-y-1">
            <div class="text-sm font-semibold text-highlighted">{{ input.name }}</div>
            <USelect
              v-model="place.inputs[input.name]"
              :items="input.kind === 'choice' ? input.options : []"
              :aria-label="input.name"
              class="w-full sm:w-64"
            />
          </div>
          <p v-if="fixedInputs.length" class="text-xs text-muted">Sends {{ fixedInputs.join(', ') }}</p>
        </template>

        <p v-if="place.sendError" class="text-xs text-error" data-testid="run-dialog-error">{{ place.sendError }}</p>
      </div>
    </template>

    <template #footer>
      <div class="flex flex-wrap justify-end gap-2 w-full">
        <template v-if="place.followUp">
          <UButton
            v-if="place.followUp.canStop"
            color="neutral"
            variant="outline"
            icon="i-lucide-square"
            :loading="place.stopping"
            @click="place.stopRun()"
            >Stop</UButton
          >
          <template v-else>
            <UButton color="neutral" variant="ghost" @click="place.newRun()">New run</UButton>
            <UButton
              color="neutral"
              variant="outline"
              icon="i-lucide-rotate-ccw"
              :loading="place.sending"
              @click="place.runAgain()"
              >Run again</UButton
            >
          </template>
          <UButton color="neutral" variant="ghost" @click="place.open = false">Close</UButton>
        </template>
        <template v-else>
          <UButton color="neutral" variant="ghost" @click="place.open = false">Cancel</UButton>
          <UButton icon="i-lucide-send" :disabled="!place.canSend" :loading="place.sending" @click="place.send()"
            >Send</UButton
          >
        </template>
      </div>
    </template>
  </UModal>
</template>
