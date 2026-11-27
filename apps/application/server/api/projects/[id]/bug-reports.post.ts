import { readFile } from 'node:fs/promises';
import { parseBugReport } from '@piwitests/core/bug-report';
import { requireProjectAccess, requireRouteId } from '../../../utils/project-access';
import { getDatabase } from '../../../database';
import { apiError } from '../../../utils/api-error';
import { isJpeg, isPng, storeBugReport } from '../../../utils/bug-report-store';
import { streamMultipart } from '../../../utils/multipart-stream';
import { refuseFilesAtQuota } from '../../../utils/storage-quota';
import { getRequestAccess } from '../../../utils/auth';
import { bugReportIntake, fileBugReportIssue, shouldFileOnSend } from '../../../utils/integrations/bug-reports';
import { BUG_REPORT_LIMITS } from '#shared/handlers/bug-reports';
import { can } from '#shared/permissions';

defineRouteMeta({
  openAPI: {
    tags: ['Bug reports'],
    summary: 'Send a bug report',
    description:
      'What Piwi Picker’s **Send to Piwi…** sends: `multipart/form-data` with a `report` part (the bug report as JSON: `{ v: 1, steps, evidence, context }`, 1 MB at most), an optional `language` part (the language it was written in, such as `fr`), up to three PNG `screenshot` parts named as the report’s `evidence.screenshots` name them (`1-marked.png`, 5 MB each), and up to 100 JPEG `stepShot` parts, the screenshot of each step, named as `evidence.stepShots` names them (`002.jpg`, 1 MB each, 32 MB together). A `createIssue` part (`true`) asks for an issue in the project’s tracker, which takes `issue:create` on the project (Contributor and above) unless the project files every report (then one is created anyway). A JSON body `{ report, language?, createIssue? }` is accepted too, without screenshots. Answers `{ id, url, issue }`, `issue` being the create-issue outcome (`{ status, key?, url?, error? }`) or null. Once the stored bytes reach `PIWI_STORAGE_QUOTA_BYTES`, a report with screenshots answers 409 with `errorCode` `STORAGE_QUOTA_FILES_REFUSED`; one without is stored.',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'project:read',
  },
});

const LANGUAGE = /^[a-z]{2}(?:[-_][A-Za-z]{2})?$/;

interface Incoming {
  report: unknown;
  language: string | null;
  /** The sender asked for an issue to be created in the project's tracker. */
  createIssue: boolean;
  screenshots: Map<string, Buffer>;
  /** The screenshot of each step, by file name (`002.jpg`). */
  stepShots: Map<string, Buffer>;
}

async function readIncoming(event: Parameters<typeof getRequestHeader>[0]): Promise<Incoming> {
  const type = getRequestHeader(event, 'content-type') ?? '';
  const length = parseInt(getRequestHeader(event, 'content-length') ?? '0', 10);
  const screenshotsBytes = BUG_REPORT_LIMITS.screenshots * BUG_REPORT_LIMITS.screenshotBytes;
  const maxBytes = BUG_REPORT_LIMITS.jsonBytes + screenshotsBytes + BUG_REPORT_LIMITS.stepShotsBytes + 64 * 1024;
  if (length > maxBytes)
    throw apiError({
      statusCode: 413,
      message: 'A bug report is 1 MB of JSON, three 5 MB screenshots and 32 MB of step screenshots at most',
    });

  if (!type.startsWith('multipart/form-data')) {
    const body = (await readBody(event)) as { report?: unknown; language?: unknown; createIssue?: unknown } | null;
    if (JSON.stringify(body ?? {}).length > BUG_REPORT_LIMITS.jsonBytes)
      throw apiError({ statusCode: 413, message: 'The report is larger than 1 MB' });
    return {
      report: body?.report,
      language: typeof body?.language === 'string' ? body.language : null,
      createIssue: body?.createIssue === true,
      screenshots: new Map(),
      stepShots: new Map(),
    };
  }

  const multipart = await streamMultipart(event, {
    maxTotalBytes: screenshotsBytes + BUG_REPORT_LIMITS.stepShotsBytes,
    maxFieldBytes: BUG_REPORT_LIMITS.jsonBytes,
    maxFiles: BUG_REPORT_LIMITS.screenshots + BUG_REPORT_LIMITS.stepShots,
    // A report with screenshots is refused once the storage quota is reached, before any of them is written.
    beforeFiles: async (_fields, withFiles) => {
      if (withFiles) await refuseFilesAtQuota(await getDatabase());
    },
  });
  try {
    const screenshots = new Map<string, Buffer>();
    const stepShots = new Map<string, Buffer>();
    for (const file of multipart.files) {
      if (file.field === 'stepShot') {
        if (file.size > BUG_REPORT_LIMITS.stepShotBytes)
          throw apiError({ statusCode: 413, message: 'A step screenshot is 1 MB at most' });
        const bytes = await readFile(file.path);
        if (!isJpeg(bytes)) throw apiError({ statusCode: 400, message: 'A step screenshot must be a JPEG image' });
        stepShots.set(file.filename, bytes);
        continue;
      }
      if (file.field !== 'screenshot') continue;
      if (file.size > BUG_REPORT_LIMITS.screenshotBytes)
        throw apiError({ statusCode: 413, message: 'A screenshot is 5 MB at most' });
      const bytes = await readFile(file.path);
      if (!isPng(bytes)) throw apiError({ statusCode: 400, message: 'A screenshot must be a PNG image' });
      screenshots.set(file.filename, bytes);
    }
    let report: unknown;
    try {
      report = JSON.parse(multipart.fields.get('report') ?? '');
    } catch {
      throw apiError({ statusCode: 400, message: 'The report part is not JSON' });
    }
    return {
      report,
      language: multipart.fields.get('language') ?? null,
      createIssue: multipart.fields.get('createIssue') === 'true',
      screenshots,
      stepShots,
    };
  } finally {
    await multipart.cleanup();
  }
}

export default eventHandler(async (event) => {
  const projectId = requireRouteId(event, 'id', 'project ID');
  const user = await requireProjectAccess(event, projectId);
  const incoming = await readIncoming(event);

  const parsed = parseBugReport(incoming.report);
  if (!parsed.ok)
    throw apiError({ statusCode: 400, message: `Not a bug report: ${parsed.errors.slice(0, 3).join('; ')}` });

  const language = incoming.language && LANGUAGE.test(incoming.language) ? incoming.language : null;

  const db = await getDatabase();
  const canCreate = can(await getRequestAccess(event), 'issue:create', projectId);
  // A sender who may not create issues cannot ask for one; the project filing every report is not asking.
  if (incoming.createIssue && !canCreate) {
    const intake = await bugReportIntake(db, projectId, canCreate);
    if (!intake.fileEvery)
      throw apiError({ statusCode: 403, message: 'Creating an issue takes the Contributor role on this project' });
  }
  // The screenshots are sent under their file names, without the archive's folder.
  const screenshots = new Map([...incoming.screenshots].map(([name, bytes]) => [`screenshots/${name}`, bytes]));
  const stepShots = new Map([...incoming.stepShots].map(([name, bytes]) => [`steps/${name}`, bytes]));
  const { id } = await storeBugReport(db, {
    projectId,
    report: parsed.report,
    language,
    createdBy: user.id,
    screenshots,
    stepShots,
  });
  // The report is stored whatever the tracker answers; the issue follows through the outbox.
  let issue: { status: string; key?: string; url?: string; error?: string } | null = null;
  if (await shouldFileOnSend(db, projectId, incoming.createIssue, canCreate)) {
    try {
      const outcome = await fileBugReportIssue(db, { bugReportId: id, projectId, requestedBy: user.id || null });
      if (outcome) issue = { status: outcome.status, key: outcome.key, url: outcome.url, error: outcome.error };
    } catch (e) {
      issue = { status: 'failed', error: e instanceof Error ? e.message : String(e) };
    }
  }
  setResponseStatus(event, 201);
  return { id, url: `/bug-reports/${id}`, issue };
});
