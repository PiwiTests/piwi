<script setup lang="ts">
/**
 * The "What changed" line of the cluster page's situation block: one sentence on
 * the commits between the last passing run and this failure. With a resolved
 * diff or a hand-picked commit range it sums the range up — commits, files, what
 * they are counted from — and links to the full card below the block, where the
 * baseline picker, the commits and the diff live. A gap the configuration fills
 * (no commit or repository recorded, a host Piwi does not read or that did not
 * answer) is the range in the meta style, the host's error when it returned one,
 * the host's compare page when there is one, and a help hint that says what to
 * set up; the page's More actions copy the `git log` command. Any other case
 * with nothing to diff says why, keeps the range usable where it is known, and
 * offers the commit browser where one can work, so a cluster without a baseline
 * is not a dead end: picking commits opens the card. Until the coverage
 * arrives, the line says it is looking.
 *
 * With a resolved diff, the line adds what the suspect lines say: how many of
 * the changed lines the failing tests ran and the most suspect file, linked to
 * the card's list. When the project records coverage and the failing tests
 * recorded none, a help hint says why that can be; a project that records no
 * coverage hears nothing of it, and any other reason adds nothing.
 */
import { suspectLinesSentence } from '~/utils/suspect-lines';

const {
  clusterId,
  coverage,
  scmChanges,
  selectedCommitShas,
  autoSelectedCommits,
  contextLoading,
  contextLoaded,
  hasChangesToShow,
  suspectLines,
  loadSuspectLines,
} = useClusterDiagnosis();

onMounted(() => void loadSuspectLines());
const suspectSentence = computed(() => suspectLinesSentence(suspectLines.value, 'cluster'));
const props = defineProps<{
  /** Whether the project records coverage (its `coverage` capability is active). */
  coverageActive?: boolean;
}>();
const noCoverage = computed(() => props.coverageActive === true && suspectLines.value?.reason === 'no-coverage');

const emit = defineEmits<{
  /** "See the changes" — the page scrolls to the card below the block. */
  see: [];
}>();

const { copy, copied } = useCopy();
const status = computed(() => describeScmStatus(coverage.value?.scm));
const commitBrowserOpen = ref(false);

// The browser lists the repository's commits, which needs a repository the run
// reported and a host we support: with a last passing run the server has said
// which; without one it has not looked, so the browser gets its chance.
const canBrowse = computed(() => {
  const scm = coverage.value?.scm;
  if (!scm || status.value.kind === 'no-repository' || status.value.kind === 'unsupported-host') return false;
  return Boolean(scm.provider || !scm.hasLastGreen);
});

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** What the range is counted from: the last passing run, the test's own last pass, or the baseline picked. */
const baseline = computed(() => {
  const scm = coverage.value?.scm;
  if (scm?.baseCommitUsed && scm.baselineKind === 'test-green') return 'this test last passed';
  return scm?.baseCommitUsed ? `baseline ${scm.baseCommitUsed.slice(0, 7)}` : 'the last passing run';
});

/** The range in one clause: how many commits and files, counted from where. */
const summary = computed(() => {
  const changes = scmChanges.value;
  if (!changes) return null;
  const files = `${count(changes.files.length, 'file')} changed`;
  if (selectedCommitShas.value.length) return `${count(selectedCommitShas.value.length, 'selected commit')}, ${files}`;
  if (changes.commits.length) return `${count(changes.commits.length, 'commit')} since ${baseline.value}, ${files}`;
  return `${files} since ${baseline.value}`;
});
</script>

<template>
  <p data-shot="what-changed" data-tour="what-changed-line" class="flex flex-wrap items-center gap-x-2 gap-y-1">
    <!-- Resolving: the context has not arrived yet, or is being fetched with no diff yet -->
    <template v-if="!contextLoaded || (contextLoading && !scmChanges)">
      <UIcon name="i-lucide-loader-circle" class="size-3.5 animate-spin shrink-0" />
      <span>Looking for the change that broke this…</span>
    </template>

    <!-- A resolved diff: the range in one clause, what the suspect lines say, and the way to the card -->
    <template v-else-if="summary">
      <span>{{ summary }}<template v-if="suspectSentence">.</template></span>
      <SuspectLinesSentence v-if="suspectSentence" :sentence="suspectSentence" @open="emit('see')" />
      <button type="button" :class="SENTENCE_LINK_CLASS" @click="emit('see')">See the changes</button>
      <HelpHint v-if="noCoverage" topic="cluster.suspect-lines-coverage" />
    </template>

    <!-- A hand-picked range whose diff did not resolve: the card holds the picker -->
    <template v-else-if="hasChangesToShow">
      <span>
        {{ status.text }}
        <span v-if="status.detail" class="text-muted">— {{ status.detail }}</span>
      </span>
      <span v-if="status.errorText" class="text-xs text-muted break-words" data-testid="what-changed-error">
        {{ status.errorText }}
      </span>
      <button type="button" :class="SENTENCE_LINK_CLASS" @click="emit('see')">Change the range</button>
    </template>

    <!-- A setup gap: the range, the host's error, its compare page, and the help that says what to set up -->
    <template v-else-if="status.setupGap">
      <!-- The whole line is one meta style, the range included (the typography rule's one exception to mono code). -->
      <span class="text-xs text-muted" data-testid="what-changed-range">
        <template v-if="status.range">{{ status.range }} {{ status.origin }}</template>
        <template v-else>No commit recorded</template>
      </span>
      <span v-if="status.errorText" class="text-xs text-muted break-words" data-testid="what-changed-error">
        {{ status.errorText }}
      </span>
      <a
        v-if="status.compare"
        :href="status.compare.url"
        target="_blank"
        rel="noopener"
        :class="[SENTENCE_LINK_CLASS, 'text-xs text-muted']"
        data-testid="what-changed-compare"
      >
        {{ status.compare.label }}
      </a>
      <HelpHint v-if="status.help" :topic="status.help" />
    </template>

    <!-- Nothing to diff: why, what to do, and the range where it is known -->
    <template v-else>
      <span>
        {{ status.text }}
        <span v-if="status.detail" class="text-muted">— {{ status.detail }}</span>
      </span>
      <a
        v-if="status.compare"
        :href="status.compare.url"
        target="_blank"
        rel="noopener"
        :class="SENTENCE_LINK_CLASS"
        data-testid="what-changed-compare"
      >
        {{ status.compare.label }}
      </a>
      <UButton
        v-if="status.gitCommand"
        size="xs"
        variant="ghost"
        color="neutral"
        :icon="copied ? 'i-lucide-check' : undefined"
        :label="copied ? 'Copied' : 'Copy git log'"
        :title="status.gitCommand"
        class="shrink-0"
        data-testid="what-changed-git-log"
        @click="copy(status.gitCommand)"
      />
      <UButton
        v-if="canBrowse"
        size="xs"
        variant="ghost"
        color="neutral"
        label="Browse commits"
        class="shrink-0"
        @click="commitBrowserOpen = true"
      />
      <CommitBrowserModal
        v-if="canBrowse"
        v-model:open="commitBrowserOpen"
        :cluster-id="clusterId"
        :initial-selected="selectedCommitShas"
        :auto-selected-shas="autoSelectedCommits"
        @confirm="selectedCommitShas = $event"
      />
    </template>
  </p>
</template>
