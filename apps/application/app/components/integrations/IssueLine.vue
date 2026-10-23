<script setup lang="ts">
/**
 * The ticket a failure cluster is tracked in: the Issue line of the cluster
 * page's situation block, and the end of the Cluster line on the execution
 * page, where the cluster's own sentence comes first (the `lead` slot), so the
 * ticket sits beside the cluster it tracks on both pages. A tracked cluster
 * names its issue, the key a link to the tracker whose tooltip gives the
 * issue's summary, and its status; an issue Done while the failure goes on says
 * so and offers a new one (once the failure stopped, both failure pages offer to
 * resolve the cluster instead). An untracked open cluster says it has none and
 * offers to file or link one; a filing the tracker has not answered yet shows
 * as queued. Where filing is offered, a last filing that failed for good is
 * named with its age and reason, so filing again is not a blind retry, and one
 * a rule left to a person names the open issue it found and offers to link it,
 * beside a Done issue too. The page owns the create and link dialogs: this line
 * emits. The block that renders this line provides its label.
 */
import type { IssueFilingFailure } from '#shared/handlers/known-issues';
import { getProviderName, type LinkProvider } from '#shared/link-detect';
import { safeHttpUrl } from '#shared/utils/safe-url';
import {
  filingFailureSentence,
  filingSkippedSentence,
  issueKeyTitle,
  offersFoundIssueLink,
  type IssueLineForm,
} from '~/utils/issue-line';

const props = defineProps<{
  form: IssueLineForm;
  projectId: number | null;
  /** The cluster's triage status, for the Done-while-open note. */
  clusterStatus?: string | null;
  /** The failure goes on in the project's latest finished run: a Done issue then calls for a new one. */
  failureGoesOn?: boolean;
  knownIssue?: {
    key: string;
    url: string;
    provider: string;
    /** The issue's summary, for the key's tooltip. */
    title?: string | null;
    status: string | null;
    statusCategory?: string | null;
  } | null;
  /** The cluster's newest filing failed for good. */
  filingFailure?: IssueFilingFailure | null;
}>();

const emit = defineEmits<{ create: []; link: [] }>();

const { can } = useAuth();
const { hasTracker } = useTrackerStatus();
const canFile = computed(() => hasTracker.value && can('issue:create', props.projectId));
const canLink = computed(() => can('link:write', props.projectId));

const providerName = computed(() =>
  props.knownIssue ? getProviderName(props.knownIssue.provider as LinkProvider) : null,
);
const keyTitle = computed(() =>
  props.knownIssue ? issueKeyTitle(props.knownIssue.key, props.knownIssue.title, providerName.value) : undefined,
);
const doneWhileFailing = computed(
  () =>
    props.knownIssue?.statusCategory === 'done' &&
    (props.clusterStatus ?? 'open') === 'open' &&
    props.failureGoesOn === true,
);
// The age reads the browser's clock, so it shows once the line is mounted.
const mounted = ref(false);
onMounted(() => {
  mounted.value = true;
});
/** A rule left the filing to a person: the open issue it found is one click from linked. */
const linksFound = computed(() => offersFoundIssueLink(props.filingFailure, canLink.value));
const failureSentence = computed(() => {
  const failure = props.filingFailure;
  if (!failure || !(canFile.value || linksFound.value)) return null;
  const ago = mounted.value && failure.at ? formatRelativeTime(failure.at) : null;
  return failure.existingKey
    ? filingSkippedSentence(failure.existingKey, ago)
    : filingFailureSentence(failure.error, ago);
});
</script>

<template>
  <div data-shot="issue-line" data-tour="issue-line" class="space-y-1">
    <template v-if="form === 'tracked' && knownIssue">
      <p>
        <slot name="lead" />
        Tracked in
        <a
          :href="safeHttpUrl(knownIssue.url) ?? undefined"
          target="_blank"
          rel="noopener noreferrer"
          :title="keyTitle"
          :class="SENTENCE_LINK_CLASS"
          data-testid="issue-line-key"
          >{{ knownIssue.key }}</a
        ><template v-if="knownIssue.status"
          >, {{ knownIssue.status }}<template v-if="providerName"> in {{ providerName }}</template></template
        >.<template v-if="doneWhileFailing"> The issue is Done, but the failure goes on.</template>
      </p>
      <template v-if="doneWhileFailing">
        <p v-if="failureSentence" class="text-xs text-muted" data-testid="issue-line-filing-failed">
          {{ failureSentence }}
        </p>
        <div v-if="canFile || linksFound" class="flex flex-wrap items-center gap-2 pt-1">
          <UButton v-if="canFile" size="xs" color="neutral" variant="outline" @click="emit('create')"
            >File a new issue</UButton
          >
          <UButton v-if="linksFound" size="xs" color="neutral" variant="outline" @click="emit('link')">
            Link an issue
          </UButton>
        </div>
      </template>
    </template>

    <p v-else-if="form === 'queued'" data-testid="issue-line-queued">
      <slot name="lead" />
      Filing queued: Jira did not answer yet. Piwi retries and links the issue once it is created.
    </p>

    <template v-else-if="form === 'untracked'">
      <p><slot name="lead" /> No issue yet.</p>
      <p v-if="failureSentence" class="text-xs text-muted" data-testid="issue-line-filing-failed">
        {{ failureSentence }}
      </p>
      <div class="flex flex-wrap items-center gap-2 pt-1">
        <UButton
          v-if="canFile"
          size="xs"
          color="neutral"
          variant="outline"
          data-shot="issue-line-create"
          data-tour="create-issue"
          @click="emit('create')"
        >
          Create issue
        </UButton>
        <UButton
          v-if="canLink"
          size="xs"
          color="neutral"
          variant="outline"
          data-tour="link-issue"
          @click="emit('link')"
        >
          Link an issue
        </UButton>
      </div>
    </template>
  </div>
</template>
