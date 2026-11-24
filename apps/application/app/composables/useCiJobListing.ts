import type { CiJob, CiJobField, CiJobFieldListing, CiJobListing } from '#shared/ci-job-fields';

/**
 * What a CI action's target declares, for the action editor: the jobs it can
 * dispatch and the fields of the job picked, read again (after a pause, since
 * a ref or a base URL is typed) whenever the target changes, and cleared while
 * nothing can be read. `target` is what `ciListingTargetOfDraft` posts; null
 * reads nothing (a Custom request, or the editor closed). `name` and
 * `actionId` name the action being edited, in a refusal and in the credential
 * log.
 */
export function useCiJobListing(
  projectId: () => number,
  target: () => Record<string, unknown> | null,
  name: () => string,
  actionId: () => string,
) {
  const jobs = ref<CiJob[] | null>(null);
  const jobsMessage = ref<string | null>(null);
  const jobsLoading = ref(false);
  const fields = ref<CiJobField[] | null>(null);
  const fieldsMessage = ref<string | null>(null);
  const fieldsLoading = ref(false);
  /** Increment per request and per change of target, so an answer for an older target is never applied. */
  let jobsGeneration = 0;
  let fieldsGeneration = 0;

  /** The target a job listing reads: without the job picked, null for GitLab, whose pipeline has no job to pick. */
  const jobsTarget = computed(() => {
    const t = target();
    if (!t || t.type === 'gitlab') return null;
    if (t.type === 'github') return { ...t, workflow: '' };
    if (t.type === 'bitbucket') return { ...t, pipeline: '' };
    return { ...t, fields: { ...(t.fields as Record<string, unknown>), job: '' } };
  });
  /** The target a field listing reads: one with its job picked, or a GitLab one (its CI file). */
  const fieldsTarget = computed(() => {
    const t = target();
    if (!t) return null;
    if (t.type === 'gitlab') return t;
    const job =
      t.type === 'github' ? t.workflow : t.type === 'bitbucket' ? t.pipeline : (t.fields as { job?: string }).job;
    return job ? t : null;
  });

  const post = <T>(path: 'jobs' | 'fields', body: Record<string, unknown>, refresh: boolean) =>
    $fetch<T>(`/api/projects/${projectId()}/ci-actions/${path}`, {
      method: 'POST',
      body: { target: body, name: name(), actionId: actionId(), refresh },
    });

  async function loadJobs(refresh = false) {
    const t = jobsTarget.value;
    const current = ++jobsGeneration;
    if (!t) {
      jobs.value = null;
      jobsMessage.value = null;
      jobsLoading.value = false;
      return;
    }
    jobsLoading.value = true;
    try {
      const answer = await post<CiJobListing>('jobs', t, refresh);
      if (current !== jobsGeneration) return;
      jobs.value = answer.jobs;
      jobsMessage.value = answer.message;
    } catch (err) {
      if (current !== jobsGeneration) return;
      jobs.value = null;
      jobsMessage.value = errorMessage(err, 'The jobs could not be listed.');
    } finally {
      if (current === jobsGeneration) jobsLoading.value = false;
    }
  }

  async function loadFields(refresh = false) {
    const t = fieldsTarget.value;
    const current = ++fieldsGeneration;
    if (!t) {
      fields.value = null;
      fieldsMessage.value = null;
      fieldsLoading.value = false;
      return;
    }
    fieldsLoading.value = true;
    try {
      const answer = await post<CiJobFieldListing>('fields', t, refresh);
      if (current !== fieldsGeneration) return;
      fields.value = answer.fields;
      fieldsMessage.value = answer.message;
    } catch (err) {
      if (current !== fieldsGeneration) return;
      fields.value = null;
      fieldsMessage.value = errorMessage(err, 'The fields could not be read.');
    } finally {
      if (current === fieldsGeneration) fieldsLoading.value = false;
    }
  }

  const jobsKey = computed(() => JSON.stringify(jobsTarget.value));
  const fieldsKey = computed(() => JSON.stringify(fieldsTarget.value));
  const loadJobsLater = useDebounceFn(() => loadJobs(), 400);
  const loadFieldsLater = useDebounceFn(() => loadFields(), 400);
  // Another kind of target lists other things: what the last one listed goes at once.
  watch(
    () => target()?.type,
    () => {
      jobs.value = null;
      jobsMessage.value = null;
      fields.value = null;
      fieldsMessage.value = null;
    },
  );
  // A changed target is being read from then on: an answer still on its way for the one before is dropped.
  watch(
    jobsKey,
    () => {
      jobsGeneration++;
      jobsLoading.value = jobsTarget.value !== null;
      void loadJobsLater();
    },
    { immediate: true },
  );
  watch(
    fieldsKey,
    () => {
      fieldsGeneration++;
      fieldsLoading.value = fieldsTarget.value !== null;
      void loadFieldsLater();
    },
    { immediate: true },
  );

  /** Read both again from the target, past what the server kept. */
  async function refresh() {
    await Promise.all([loadJobs(true), loadFields(true)]);
  }

  return { jobs, jobsMessage, jobsLoading, fields, fieldsMessage, fieldsLoading, refresh };
}
