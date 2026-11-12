import { INVALID_EXTERNAL_ID_URL } from '#shared/external-id-link';
import { generatedSpecSettingsSchema } from '#shared/handlers/bug-reports';
import { getDatabase } from '../../database';
import { z } from 'zod';
import { requireProjectAccess, requireRouteId } from '../../utils/project-access';
import {
  INVALID_COVERAGE_AREAS,
  INVALID_LIVE_VIEW_MASKS,
  INVALID_COVERAGE_SCOPE,
  INVALID_REPOSITORY_URL,
  InvalidTagKeysError,
  updateProject,
} from '#shared/handlers/projects';
import { recountProjectCoverage } from '../../utils/coverage-summary';
import { encryptSecret, getEncryptionKey } from '../../utils/crypto';
import { instanceCiServer, sealCiServerToken } from '../../utils/ci-server-dispatch';
import { ciServerTargetProblem, normalizeCiServerBaseUrl } from '#shared/ci-server';
import { resolveCiRerunSettings, type CiRerunSettings } from '#shared/ci-rerun';
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
      "Updates project metadata including label, description, diagnosis instructions, SCM token, whether quarantined failures turn the commit status red, whether gate evaluations post the `<statusContext>/gate` commit status (`gateStatus`, off by default), whether people who may open a live run of the project can watch its workers’ pages from the run page (`liveView`, off by default; turning it off ends every view of the project’s runs at once, and turned on again, the runs that had a view and still run get it back), whether a signed-in reader of a run outside CI that is not shared live may ask its developer to share it (`askToWatch`, on by default; turning it off drops the asks that wait), the elements the live view paints over in each image beside the secret fields (`liveViewMasks`: up to 20 Playwright locators such as `getByLabel('IBAN')`; null or `[]` removes them; the workers of the project’s live runs mask them from their next image on), targets, the coverage scope (`coverageScope`: `include` and `exclude` lists of gitignore-style patterns over repository-relative paths, the files coverage totals count; null restores the default excludes), the coverage areas (`coverageAreas`: up to 20 `{ name, include }`, named areas of the code such as `front` and `back`, each counted apart; a file belongs to the first whose patterns match it; null or `[]` removes them), the status filter (`statusFilter`: `{ environments, branches, allBranches, fullRunsOnly }`, all four required, the run scope of the project page, which picks the runs that set the project’s status, its `latestRun` in the project list; null, or a scope every run passes, for every run), the tag key patterns (`tagKeys`: `{ issue, testCase }`, each a regular expression without flags of at most 200 characters, tested against a tag without its `@`, that reads the issue key or the test case key out of a test’s tags; it is anchored with `^` and `$` and built from literals, escapes, character classes and quantifiers, with no groups or `|`; a pattern that is left out, null or empty is off, a pattern that breaks the rule, does not compile or matches an empty tag answers HTTP 400, and null turns both off), and tags. A change of the scope or the areas recounts the commits whose totals are kept, the newest on the default branch a few seconds later and the others after it, 200 at most, and an area no longer named leaves the coverage trend. Omitting `scmToken` keeps the stored token; `null` or an empty string removes it. `repositoryUrl` is the repository every SCM call of the project reads with its token (`https://host/owner/repo`; an SSH remote is accepted and stored in that form): the first run that names a remote sets it, a run naming another repository is ignored for SCM calls, and `null` or an empty string clears it so the next run that names one sets it again. A new SCM token answers HTTP 409 while `PIWI_SECRET_KEY` is unset, since it cannot be encrypted. `ciRerun.via` is `repository` (the default: the repository host's CI, with the SCM token) or `ci-server` (one HTTP request to `ciRerun.ciServer`, a preset such as `jenkins` with its fields, or `custom` with its request templates). `ciServerToken` is the CI server credential: it is stored with the base URL in effect when it is saved (the project's `ciRerun.ciServer.baseUrl`, else the instance's `PIWI_CI_SERVER_URL`) and sent only to URLs under it; omitting it keeps the stored token, `null` or an empty string removes it, a new one answers HTTP 409 while `PIWI_SECRET_KEY` is unset and 400 when no base URL is set. A `ciRerun.ciServer` that cannot dispatch (an unknown preset, a missing required field, a base URL that is not an http(s) URL, a Flake Lab request it names that cannot dispatch) answers 400 and leaves the stored target as it is, whatever `via` and `enabled` say. Requires `project:manage` (Project admin on the project).",
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'project:manage',
  },
});

const ciRerunSchema = z.object({
  enabled: z.boolean().optional(),
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
  scmToken: z.string().optional().nullable(),
  ciServerToken: z.string().max(8192).optional().nullable(),
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
    generatedSpecs,
    targets,
    coverageScope,
    coverageAreas,
    statusFilter,
    tagKeys,
    tagIds,
  } = validation.data;

  // Encrypt SCM token before persisting; omitted keeps the stored value, null or empty clears it
  const encryptedScmToken =
    scmToken === undefined ? undefined : scmToken?.trim() ? encryptSecret(scmToken.trim(), getEncryptionKey()) : null;

  // A CI server target that cannot dispatch answers 400.
  const sentCiServer = (ciRerun as { ciServer?: unknown } | null | undefined)?.ciServer;
  if (sentCiServer != null) {
    const problem = ciServerTargetProblem(sentCiServer);
    if (problem) throw apiError({ statusCode: 400, message: problem });
  }

  // Normalize the CI re-run config (drops empty targets); null clears it.
  const resolvedCiRerun =
    ciRerun === undefined
      ? undefined
      : ciRerun === null
        ? null
        : resolveCiRerunSettings(ciRerun as Partial<CiRerunSettings>);

  // The CI server token is sealed with the base URL in effect once saved, the only URL it is sent under.
  let sealedCiServerToken: string | null | undefined = ciServerToken === undefined ? undefined : null;
  if (ciServerToken?.trim()) {
    // The base URL the request names, valid target or not; else the stored target's; else the instance's.
    const [stored] = await db.select({ ciRerun: projects.ciRerun }).from(projects).where(eq(projects.id, id));
    const sent = ciRerun === undefined ? (stored?.ciRerun as { ciServer?: unknown } | null) : ciRerun;
    const rawBaseUrl = (sent?.ciServer as { baseUrl?: unknown } | undefined)?.baseUrl;
    const projectBaseUrl = normalizeCiServerBaseUrl(rawBaseUrl);
    if (typeof rawBaseUrl === 'string' && rawBaseUrl.trim() && !projectBaseUrl) {
      throw apiError({ statusCode: 400, message: 'The CI server base URL must be an http(s) URL' });
    }
    const baseUrl = projectBaseUrl ?? instanceCiServer().url;
    if (!baseUrl) {
      throw apiError({ statusCode: 400, message: 'Set the CI server base URL before saving its token' });
    }
    sealedCiServerToken = sealCiServerToken(baseUrl, ciServerToken.trim());
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
      scmToken: encryptedScmToken,
      ciServerToken: sealedCiServerToken,
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
      tagIds,
    }).then(async (project) => {
      if (coverageScope !== undefined || coverageAreas !== undefined) await recountProjectCoverage(db, id);
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
    if (e instanceof InvalidTagKeysError) throw apiError({ statusCode: 400, message: e.message });
    if (
      e?.message === 'One or more tag IDs are invalid' ||
      e?.message === INVALID_COVERAGE_SCOPE ||
      e?.message === INVALID_COVERAGE_AREAS ||
      e?.message === INVALID_LIVE_VIEW_MASKS ||
      e?.message === INVALID_REPOSITORY_URL ||
      e?.message === INVALID_EXTERNAL_ID_URL
    ) {
      throw apiError({ statusCode: 400, message: e.message });
    }
    throw e;
  }
});
