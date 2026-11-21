import { INVALID_EXTERNAL_ID_URL } from '#shared/external-id-link';
import { generatedSpecSettingsSchema } from '#shared/handlers/bug-reports';
import { getDatabase } from '../../database';
import { z } from 'zod';
import { requireProjectAccess, requireRouteId } from '../../utils/project-access';
import {
  INVALID_COVERAGE_AREAS,
  INVALID_LIVE_VIEW_HOLD_MINUTES,
  INVALID_LIVE_VIEW_MASKS,
  INVALID_COVERAGE_SCOPE,
  INVALID_REPOSITORY_URL,
  InvalidRunVariablesError,
  InvalidCiActionsError,
  InvalidDefaultEnvironmentError,
  InvalidTagKeysError,
  updateProject,
} from '#shared/handlers/projects';
import { recountProjectCoverage } from '../../utils/coverage-summary';
import { configuredGitlabHosts } from '../../utils/scm/gitlab-hosts';
import { importScmTokens } from '../../utils/credentials';
import { readProjectRepositoryUrl } from '../../utils/scm/project-repository';
import { ciServerTargetProblem } from '#shared/ci-server';
import { ciActionsProblem, hasCiActions, resolveCiActionsSettings } from '#shared/ci-actions';
import { ciActionsCredentialProblem, projectScmCredentialProblem } from '#shared/handlers/credentials';
import { resolveServerProbeSettings } from '#shared/server-probes';
import { projectTargetsSchema } from '#shared/analytics/targets';
import { liveViewRelay } from '../../utils/live-view';
import { askRefusal, liveAsks, type LiveViewBusState } from '../../utils/live-asks';
import { runEventBus } from '../../utils/run-events';
import { and, eq, inArray } from 'drizzle-orm';
import { projects, testRuns } from '../../database/schema';
import { UNFINISHED_RUN_STATUSES } from '#shared/run-eligibility';
import { parseLiveMasks } from '@piwitests/core/live-view';
import { refreshOpenApiSurface, undeclareOpenApiRoutes } from '../../utils/openapi-surface';
import { withProjectGraphLock } from '../../utils/project-graph-lock';
import { computeScenarioGaps } from '#shared/handlers/scenario-gaps';

defineRouteMeta({
  openAPI: {
    tags: ['Projects'],
    summary: 'Update a project',
    description:
      "Updates project metadata including label, description, diagnosis instructions, the SCM credential, whether quarantined failures turn the commit status red, whether gate evaluations post the `<statusContext>/gate` commit status (`gateStatus`, off by default), whether people who may open a live run of the project can watch its workers’ pages from the run page (`liveView`, off by default; turning it off ends every view of the project’s runs at once, and turned on again, the runs that had a view and still run get it back), whether a signed-in reader of a run outside CI that is not shared live may ask its developer to share it (`askToWatch`, on by default; turning it off drops the asks that wait), the elements the live view paints over in each image beside the secret fields (`liveViewMasks`: up to 20 Playwright locators such as `getByLabel('IBAN')`; null or `[]` removes them; the workers of the project’s live runs mask them from their next image on), whether a CI test that fails while someone with `run:control` on the project watches its worker in full waits at its failure for them (`liveViewHold`, off by default; the CI workers of the project’s live runs hear it at once, and off ends the holds of now) and for how long at most (`liveViewHoldMinutes`, 1 to 15 whole minutes, 5 by default; another value answers 400), targets, the coverage scope (`coverageScope`: `include` and `exclude` lists of gitignore-style patterns over repository-relative paths, the files coverage totals count; null restores the default excludes), the coverage areas (`coverageAreas`: up to 20 `{ name, include }`, named areas of the code such as `front` and `back`, each counted apart; a file belongs to the first whose patterns match it; null or `[]` removes them), the status filter (`statusFilter`: `{ environments, branches, allBranches, fullRunsOnly }`, all four required, the run scope of the project page, which picks the runs that set the project’s status, its `latestRun` in the project list; null, or a scope every run passes, for every run), the tag key patterns (`tagKeys`: `{ issue, testCase }`, each a regular expression without flags of at most 200 characters, tested against a tag without its `@`, that reads the issue key or the test case key out of a test’s tags; it is anchored with `^` and `$` and built from literals, escapes, character classes and quantifiers, with no groups or `|`; a pattern that is left out, null or empty is off, a pattern that breaks the rule, does not compile or matches an empty tag answers HTTP 400, and null turns both off), the run variables (`runVariables`: up to 10 `{ name, value }`, the environment variables every run Piwi starts for the project gets and every command it gives to copy starts with; a name is capital letters, digits and `_`, not starting with a digit, at most 64 characters, and never one that changes which code runs, which browser starts or where results go, such as `PATH`, `NODE_OPTIONS`, `HOME` or a name starting with `PIWI_`, `PLAYWRIGHT_`, `NODE_`, `NPM_` or `GIT_`; a value is at most 500 characters with no line break or invisible character, and never a secret, since commands and confirmations show it; a refused list answers 400 and leaves the stored one as it is; null or `[]` removes them), the default environment (`defaultEnvironmentId`: the id of one of the project’s environments that is not archived, which the project page, its tabs, the flaky list, Analytics, quarantine candidates and pull request feedback read when no environment is picked, as they read the default branch; another id answers 400; null for every environment), and tags. A change of the scope or the areas recounts the commits whose totals are kept, the newest on the default branch a few seconds later and the others after it, 200 at most, and an area no longer named leaves the coverage trend. `scmCredentialId` names the SCM credential the project's repository calls carry: a credential of the source control service shared with the project and, once the project has a repository, sent to the API of its host (400 otherwise); `null` falls back to the instance's SCM credentials. `scmToken` answers 400: an SCM token is saved as a credential (`POST /api/credentials`). `repositoryUrl` is the repository every SCM call of the project reads (`https://host/owner/repo`; an SSH remote is accepted and stored in that form): the first run that names a remote sets it, a run naming another repository is ignored for SCM calls, and `null` or an empty string clears it so the next run that names one sets it again. `ciRerun` is `{ enabled, actions, defaults }`: `actions` is a list of named CI actions (at most 20), each `{ id, name, target, inputs, accepts, environment, environmentId }`. `environmentId` names one of the project's environments (an archived one only when the action named it already, 400 otherwise), and `environment` its label as written, the environment's key by default; an `environment` with no `environmentId` resolves as a run's label does, and a run of that environment starts the action first. `target` is `{ type: 'github', workflow, ref, argsInput, dispatchIdInput?, credentialId? }`, `{ type: 'gitlab', ref, argsVariable, credentialId? }`, `{ type: 'bitbucket', pipeline, argsVariable, credentialId? }` (`credentialId` names an SCM credential shared with the project and sent to that host's API, which its dispatch and Check carry instead of the project's) or `{ type: 'ci-server', preset, baseUrl?, credentialId?, fields, custom? }` (a preset such as `jenkins` with its `fields`, or `custom` with its request; `credentialId` names a CI server credential shared with the project, whose destination is the base URL when `baseUrl` is absent, and without it the instance's credential is sent under `PIWI_CI_SERVER_URL`). `inputs` are sent beside the Playwright arguments, each `{ name, kind: 'fixed', value }` or `{ name, kind: 'choice', options, default }`; `accepts` lists `tests`, `suite` and `flakeLab`; `defaults` is `{ rerun?, flakeLab?, suite? }`, action ids. Names are unique in a project, ignoring case, and at most 80 characters; ids are unique; an input name is letters, digits and `_` (not starting with a digit), a fixed value or a choice option is at most 500 characters, a choice has at most 50 options, an action at most 20 inputs, and a GitLab or Bitbucket input may not be named `CI_*`, `GITLAB_*` or `BITBUCKET_*`. A repeat, a limit passed, an action without a name or a complete target, or a CI server target that cannot dispatch (an unknown preset, a missing required field, a base URL that is not an http(s) URL) answers 400 and leaves the stored settings as they are. A value with no `actions` list (`via`, `ciServer`, one block per provider) is converted to actions when it is saved. A CI server action whose credential, base URL or preset changed, and whose `credentialId` names a credential that does not exist, is not shared with the project or is set by the environment, whose `baseUrl` is not under the credential's destination, or a Custom request whose credential does not allow one, answers 400. `ciServerToken` answers 400: a CI server action names a credential instead (`POST /api/credentials`). Requires `project:manage` (Project admin on the project).",
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'project:manage',
  },
});

const ciRerunSchema = z.object({
  enabled: z.boolean().optional(),
  /** Checked by `ciActionsProblem`: a duplicate name or an action that cannot dispatch answers 400. */
  actions: z.array(z.unknown()).max(50).optional(),
  defaults: z.unknown().optional(),
  via: z.enum(['repository', 'ci-server']).optional(),
  /** Checked by `ciServerTargetProblem`: a target that cannot dispatch answers 400. */
  ciServer: z.unknown().optional(),
  github: z
    .object({ workflow: z.string(), ref: z.string(), inputName: z.string(), dispatchIdInput: z.string() })
    .partial()
    .optional(),
  gitlab: z.object({ ref: z.string(), variableName: z.string() }).partial().optional(),
  bitbucket: z.object({ pipeline: z.string(), variableName: z.string() }).partial().optional(),
  flakeLab: z
    .object({
      github: z.object({ workflow: z.string(), inputName: z.string() }).partial().optional(),
      gitlab: z.object({ variableName: z.string() }).partial().optional(),
      bitbucket: z.object({ pipeline: z.string(), variableName: z.string() }).partial().optional(),
    })
    .optional(),
});

const updateProjectSchema = z.object({
  label: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  diagnosisInstructions: z.string().optional().nullable(),
  aiLanguage: z.string().max(60).optional().nullable(),
  /** Refused with a 400: an SCM token is saved as a credential, which `scmCredentialId` names. */
  scmToken: z.unknown().optional(),
  scmCredentialId: z.number().int().positive().nullable().optional(),
  /** Refused with a 400: a CI server action names a credential (`credentialId`). */
  ciServerToken: z.unknown().optional(),
  repositoryUrl: z.string().max(2000).optional().nullable(),
  defaultBranch: z.string().optional().nullable(),
  openApiUrl: z.string().url().max(2000).optional().nullable().or(z.literal('')),
  /** Link to a test in the team's test management tool, holding `{id}`; null or '' removes it. */
  externalIdUrl: z.string().max(500).optional().nullable(),
  serverProbes: z
    .object({
      enabled: z.boolean().optional(),
      faults: z.array(z.string()).optional(),
      routes: z.array(z.string()).optional(),
      dependencyOnStateChanging: z.boolean().optional(),
    })
    .optional()
    .nullable(),
  ciRerun: ciRerunSchema.optional().nullable(),
  /** True turns the commit status red on a quarantined failure; false (the default) leaves it green. */
  quarantineFailsStatus: z.boolean().optional(),
  /** True also posts each gate evaluation as the `<statusContext>/gate` commit status; false (the default) does not. */
  gateStatus: z.boolean().optional(),
  /** True lets people who may open a live run of the project watch its workers' pages; false (the default) does not. */
  liveView: z.boolean().optional(),
  /** True (the default) lets a signed-in reader of a run nobody shares ask its developer to share it. */
  askToWatch: z.boolean().optional(),
  /** Playwright locators of the elements the live view paints over, beside the secret fields; null or [] removes them. */
  liveViewMasks: z.array(z.string()).optional().nullable(),
  /** True holds a CI test that fails while a controller watches its worker; false (the default) does not. */
  liveViewHold: z.boolean().optional(),
  /** How long such a test waits, 1 to 15 whole minutes; checked by `isLiveHoldMinutes`. */
  liveViewHoldMinutes: z.number().optional(),
  /** Test import and bugs folder for specs rendered from bug reports; null clears them. */
  generatedSpecs: generatedSpecSettingsSchema.optional().nullable(),
  /** Per-project targets on catalog metrics; null clears them. */
  targets: projectTargetsSchema.optional().nullable(),
  /** The files coverage totals count, `{ include, exclude }`; null restores the default excludes. */
  coverageScope: z.unknown().optional(),
  /** Named areas of the code, `[{ name, include }]`, each counted apart; null or [] removes them. */
  coverageAreas: z.unknown().optional(),
  /** The patterns that read the issue key and the test case key out of a test's tags, `{ issue, testCase }`; null turns both off. */
  tagKeys: z.unknown().optional(),
  /** The run variables, `[{ name, value }]`, checked by `parseRunVariables`; null or [] removes them. */
  runVariables: z.unknown().optional(),
  /** The environment the project's views read by default, one of its environments not archived; null for every environment. */
  defaultEnvironmentId: z.number().int().positive().max(2_147_483_647).nullable().optional(),
  /** The runs that set the project's status, a run scope; null for every run. */
  statusFilter: z
    .object({
      environments: z.array(z.string().max(200)).max(50),
      branches: z.array(z.string().max(500)).max(50),
      allBranches: z.boolean(),
      fullRunsOnly: z.boolean(),
    })
    .optional()
    .nullable(),
  tagIds: z.array(z.number()).optional(),
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'project ID');

  // `project:manage` on this project, from `x-required-permission` above.
  await requireProjectAccess(event, id);

  const db = await getDatabase();

  const body = await readBody(event);
  const validation = updateProjectSchema.safeParse(body);

  if (!validation.success) {
    throw apiError({
      statusCode: 400,
      message: 'Invalid request body',
      data: validation.error.issues,
    });
  }

  const {
    label,
    description,
    diagnosisInstructions,
    aiLanguage,
    scmToken,
    scmCredentialId,
    ciServerToken,
    repositoryUrl,
    defaultBranch,
    openApiUrl,
    externalIdUrl,
    serverProbes,
    ciRerun,
    quarantineFailsStatus,
    gateStatus,
    liveView,
    askToWatch,
    liveViewMasks,
    liveViewHold,
    liveViewHoldMinutes,
    generatedSpecs,
    targets,
    coverageScope,
    coverageAreas,
    statusFilter,
    tagKeys,
    runVariables,
    defaultEnvironmentId,
    tagIds,
  } = validation.data;

  // An action that cannot dispatch, a repeated name or id, or an input over its limits answers 400.
  const sentCiServer = (ciRerun as { ciServer?: unknown } | null | undefined)?.ciServer;
  const actionsProblem = ciActionsProblem(ciRerun);
  if (actionsProblem) throw apiError({ statusCode: 400, message: actionsProblem });
  if (!hasCiActions(ciRerun) && sentCiServer != null) {
    const problem = ciServerTargetProblem(sentCiServer);
    if (problem) throw apiError({ statusCode: 400, message: problem });
  }

  // Normalize the CI actions (a value with no `actions` list converts to actions); null clears them.
  const resolvedCiRerun =
    ciRerun === undefined ? undefined : ciRerun === null ? null : resolveCiActionsSettings(ciRerun);

  if (ciServerToken !== undefined) {
    throw apiError({
      statusCode: 400,
      message:
        'ciServerToken is replaced by credentials: create one with POST /api/credentials and name its id in the CI server action’s credentialId.',
    });
  }
  if (scmToken !== undefined) {
    throw apiError({
      statusCode: 400,
      message:
        'scmToken is replaced by credentials: create one with POST /api/credentials (service scm) and name its id in scmCredentialId.',
    });
  }
  const gitlabHosts = configuredGitlabHosts();
  // Each action's credential is shared with this project, and sent where the action sends.
  const [stored] = await db
    .select({ ciRerun: projects.ciRerun, scmCredentialId: projects.scmCredentialId })
    .from(projects)
    .where(eq(projects.id, id));
  const storedRepository = await readProjectRepositoryUrl(db, id);
  const repository = repositoryUrl === undefined ? storedRepository : repositoryUrl?.trim() || null;
  if (resolvedCiRerun) {
    const storedActions = stored?.ciRerun ? resolveCiActionsSettings(stored.ciRerun).actions : [];
    const credentialProblem = await ciActionsCredentialProblem(
      db,
      id,
      resolvedCiRerun,
      storedActions,
      gitlabHosts,
      repository,
    );
    if (credentialProblem) throw apiError({ statusCode: 400, message: credentialProblem });
  }
  // A credential named before, with the repository unchanged, is not checked again: one narrowed since is refused at use.
  const repositoryChanged = repositoryUrl !== undefined && repository !== storedRepository;
  if (typeof scmCredentialId === 'number' && (scmCredentialId !== stored?.scmCredentialId || repositoryChanged)) {
    const problem = await projectScmCredentialProblem(db, id, scmCredentialId, repository, gitlabHosts);
    if (problem) throw apiError({ statusCode: 400, message: problem });
  }

  // The OpenAPI URL before the save: the declared surface is read again only when it changes.
  const [before] =
    openApiUrl === undefined
      ? [null]
      : await db.select({ openApiUrl: projects.openApiUrl }).from(projects).where(eq(projects.id, id));
  const savedOpenApiUrl = openApiUrl === undefined ? undefined : openApiUrl?.trim() || null;
  const openApiUrlChanged = savedOpenApiUrl !== undefined && savedOpenApiUrl !== (before?.openApiUrl?.trim() || null);

  try {
    return await updateProject(db, id, {
      label,
      description,
      diagnosisInstructions,
      aiLanguage,
      scmCredentialId,
      repositoryUrl,
      defaultBranch: defaultBranch != null ? defaultBranch.trim() || null : defaultBranch,
      openApiUrl: openApiUrl != null ? openApiUrl.trim() || null : openApiUrl,
      externalIdUrl,
      serverProbes:
        serverProbes === undefined
          ? undefined
          : serverProbes === null
            ? null
            : resolveServerProbeSettings(serverProbes),
      ciRerun: resolvedCiRerun,
      quarantineFailsStatus,
      gateStatus,
      liveView,
      askToWatch,
      liveViewMasks,
      liveViewHold,
      liveViewHoldMinutes,
      generatedSpecs:
        generatedSpecs === undefined
          ? undefined
          : generatedSpecs === null
            ? null
            : { testImport: generatedSpecs.testImport || null, bugsFolder: generatedSpecs.bugsFolder || null },
      targets,
      coverageScope,
      coverageAreas,
      statusFilter,
      tagKeys,
      runVariables,
      defaultEnvironmentId,
      tagIds,
    }).then(async (project) => {
      if (coverageScope !== undefined || coverageAreas !== undefined) await recountProjectCoverage(db, id);
      // A repository set here lets an SCM token that waited for one move to a credential.
      if (repositoryUrl?.trim()) {
        await importScmTokens(db).catch((err) => console.warn('[credentials] SCM token import failed', err));
      }
      // The pages of the project's unfinished runs hear the settings; off, the views open now end and the runs' keys open
      // nothing while it stays off. On again, a run that still runs takes the keys it stores back. Either setting off
      // drops the asks to watch that wait.
      if (liveView !== undefined || askToWatch !== undefined) {
        if (liveView === false) liveViewRelay.endProject(id);
        if (liveView === false || askToWatch === false) liveAsks.endProject(id);
        const activeRuns = await db
          .select({
            id: testRuns.id,
            status: testRuns.status,
            metadata: testRuns.metadata,
            digests: testRuns.liveViewKeyDigests,
            createdAt: testRuns.createdAt,
          })
          .from(testRuns)
          .where(and(eq(testRuns.projectId, id), inArray(testRuns.status, [...UNFINISHED_RUN_STATUSES])));
        const settings = {
          liveView: project.project.liveView === true,
          askToWatch: project.project.askToWatch !== false,
        };
        for (const run of activeRuns) {
          const keyed = liveViewRelay.holdsKey(run.id, run);
          const view: LiveViewBusState = {
            enabled: settings.liveView,
            keyed,
            askable: !askRefusal({ ...run, ...settings, keyed }),
          };
          runEventBus.publish(run.id, { type: 'live-view', data: view });
        }
      }
      // The workers of the project's live runs mask the elements listed now from their next image on.
      if (liveViewMasks !== undefined) {
        const stored = project.project.liveViewMasks;
        liveViewRelay.setMasks(id, stored == null ? [] : parseLiveMasks(stored));
      }
      // The CI workers of the project's live runs hold a failing test for its controllers as set now, or no longer.
      if (liveViewHold !== undefined || liveViewHoldMinutes !== undefined) {
        const { liveViewHold: on, liveViewHoldMinutes: minutes } = project.project;
        liveViewRelay.setHold(id, on ? minutes * 60_000 : null);
      }
      // A changed OpenAPI URL is read at once, off the request, so its declared routes are gaps before the next
      // run; a cleared one declares nothing. The recompute closes no snoozed or accepted gap, as the sweep's.
      if (openApiUrlChanged) {
        void withProjectGraphLock(id, async () => {
          const declaredChanged = savedOpenApiUrl
            ? await refreshOpenApiSurface(db, id, savedOpenApiUrl)
            : (await undeclareOpenApiRoutes(db, id, null)) > 0;
          if (declaredChanged) await computeScenarioGaps(db, id, { closeTriaged: false });
        }).catch((err) => console.warn('[projects] OpenAPI refresh failed', err));
      }
      return project;
    });
  } catch (e: any) {
    if (e?.message === 'Project not found') {
      throw apiError({ statusCode: 404, message: 'Project not found' });
    }
    if (
      e instanceof InvalidTagKeysError ||
      e instanceof InvalidRunVariablesError ||
      e instanceof InvalidCiActionsError ||
      e instanceof InvalidDefaultEnvironmentError
    ) {
      throw apiError({ statusCode: 400, message: e.message });
    }
    if (
      e?.message === 'One or more tag IDs are invalid' ||
      e?.message === INVALID_COVERAGE_SCOPE ||
      e?.message === INVALID_COVERAGE_AREAS ||
      e?.message === INVALID_LIVE_VIEW_MASKS ||
      e?.message === INVALID_LIVE_VIEW_HOLD_MINUTES ||
      e?.message === INVALID_REPOSITORY_URL ||
      e?.message === INVALID_EXTERNAL_ID_URL
    ) {
      throw apiError({ statusCode: 400, message: e.message });
    }
    throw e;
  }
});
