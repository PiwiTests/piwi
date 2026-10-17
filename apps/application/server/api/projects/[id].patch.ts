import { generatedSpecSettingsSchema } from '#shared/handlers/bug-reports';
import { getDatabase } from '../../database';
import { z } from 'zod';
import { requireProjectAccess, requireRouteId } from '../../utils/project-access';
import { INVALID_COVERAGE_AREAS, INVALID_COVERAGE_SCOPE, updateProject } from '#shared/handlers/projects';
import { recountProjectCoverage } from '../../utils/coverage-summary';
import { encryptSecret, getEncryptionKey } from '../../utils/crypto';
import { resolveCiRerunSettings, type CiRerunSettings } from '#shared/ci-rerun';
import { resolveServerProbeSettings } from '#shared/server-probes';
import { projectTargetsSchema } from '#shared/analytics/targets';

defineRouteMeta({
  openAPI: {
    tags: ['Projects'],
    summary: 'Update a project',
    description:
      'Updates project metadata including label, description, diagnosis instructions, SCM token, whether quarantined failures turn the commit status red, whether gate evaluations post the `<statusContext>/gate` commit status (`gateStatus`, off by default), targets, the coverage scope (`coverageScope`: `include` and `exclude` lists of gitignore-style patterns over repository-relative paths, the files coverage totals count; null restores the default excludes), the coverage areas (`coverageAreas`: up to 20 `{ name, include }`, named areas of the code such as `front` and `back`, each counted apart; a file belongs to the first whose patterns match it; null or `[]` removes them), and tags. A change of the scope or the areas recounts the newest commit with coverage a few seconds later. Omitting `scmToken` keeps the stored token; `null` or an empty string removes it. A new SCM token answers HTTP 409 while `PIWI_SECRET_KEY` is unset, since it cannot be encrypted. Requires `project:manage` (Project admin on the project).',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'project:manage',
  },
});

const ciRerunSchema = z.object({
  enabled: z.boolean().optional(),
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
  defaultBranch: z.string().optional().nullable(),
  openApiUrl: z.string().url().max(2000).optional().nullable().or(z.literal('')),
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
  /** Test import and bugs folder for specs rendered from bug reports; null clears them. */
  generatedSpecs: generatedSpecSettingsSchema.optional().nullable(),
  /** Per-project targets on catalog metrics; null clears them. */
  targets: projectTargetsSchema.optional().nullable(),
  /** The files coverage totals count, `{ include, exclude }`; null restores the default excludes. */
  coverageScope: z.unknown().optional(),
  /** Named areas of the code, `[{ name, include }]`, each counted apart; null or [] removes them. */
  coverageAreas: z.unknown().optional(),
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
    defaultBranch,
    openApiUrl,
    serverProbes,
    ciRerun,
    quarantineFailsStatus,
    gateStatus,
    generatedSpecs,
    targets,
    coverageScope,
    coverageAreas,
    tagIds,
  } = validation.data;

  // Encrypt SCM token before persisting; omitted keeps the stored value, null or empty clears it
  const encryptedScmToken =
    scmToken === undefined ? undefined : scmToken?.trim() ? encryptSecret(scmToken.trim(), getEncryptionKey()) : null;

  // Normalize the CI re-run config (drops empty targets); null clears it.
  const resolvedCiRerun =
    ciRerun === undefined
      ? undefined
      : ciRerun === null
        ? null
        : resolveCiRerunSettings(ciRerun as Partial<CiRerunSettings>);

  try {
    return await updateProject(db, id, {
      label,
      description,
      diagnosisInstructions,
      aiLanguage,
      scmToken: encryptedScmToken,
      defaultBranch: defaultBranch != null ? defaultBranch.trim() || null : defaultBranch,
      openApiUrl: openApiUrl != null ? openApiUrl.trim() || null : openApiUrl,
      serverProbes:
        serverProbes === undefined
          ? undefined
          : serverProbes === null
            ? null
            : resolveServerProbeSettings(serverProbes),
      ciRerun: resolvedCiRerun,
      quarantineFailsStatus,
      gateStatus,
      generatedSpecs:
        generatedSpecs === undefined
          ? undefined
          : generatedSpecs === null
            ? null
            : { testImport: generatedSpecs.testImport || null, bugsFolder: generatedSpecs.bugsFolder || null },
      targets,
      coverageScope,
      coverageAreas,
      tagIds,
    }).then(async (project) => {
      if (coverageScope !== undefined || coverageAreas !== undefined) await recountProjectCoverage(db, id);
      return project;
    });
  } catch (e: any) {
    if (e?.message === 'Project not found') {
      throw apiError({ statusCode: 404, message: 'Project not found' });
    }
    if (
      e?.message === 'One or more tag IDs are invalid' ||
      e?.message === INVALID_COVERAGE_SCOPE ||
      e?.message === INVALID_COVERAGE_AREAS
    ) {
      throw apiError({ statusCode: 400, message: e.message });
    }
    throw e;
  }
});
