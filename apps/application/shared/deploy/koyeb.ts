import {
  commentBlock,
  DATA_MOUNT,
  DEFAULT_IMAGE,
  DEFAULT_NAME,
  DEFAULT_PORT,
  HEALTH_PATH,
  qualifyImage,
  type EmitOptions,
  type EnvEntry,
} from '#shared/env-format-base';

/**
 * The Deploy-to-Koyeb button URL. Koyeb needs no file in the repository — the
 * whole service definition travels in the query string — but neither its
 * volumes nor its health check can be set that way, so both caveats are emitted
 * with the URL rather than left for the reader to discover after losing a week
 * of runs.
 */
export function emitKoyebDeployUrl(entries: readonly EnvEntry[], opts: EmitOptions = {}): string {
  const name = opts.name ?? DEFAULT_NAME;
  const port = opts.port ?? DEFAULT_PORT;
  const region = opts.region ?? 'fra';
  const params = [
    'type=docker',
    `image=${qualifyImage(opts.image ?? DEFAULT_IMAGE)}`,
    `name=${name}`,
    'instance_type=small',
    `regions=${region}`,
    `ports=${port};http;/`,
  ];
  const deferred: string[] = [];
  for (const entry of entries) {
    if (entry.platformValue) {
      deferred.push(entry.name);
      continue;
    }
    params.push(`env[${entry.name}]=${encodeURIComponent(entry.value)}`);
  }
  const notes = [
    '',
    '# Koyeb volumes cannot be attached from this URL, and without one the database and every',
    '# stored trace are lost on redeploy. Attach one before the instance holds anything you want',
    '# to keep (volumes are region-scoped, and only standard instances can mount them):',
    '#',
    `#   koyeb volumes create ${name}-data --region ${region} --size 10`,
    `#   koyeb service update ${name}/${name} --volumes ${name}-data:${DATA_MOUNT}`,
    '#',
    '# The button URL carries no health check either — Koyeb defaults to a TCP probe on the',
    `# port. Switch it to HTTP GET ${HEALTH_PATH}, which also verifies database connectivity:`,
    '#',
    `#   koyeb service update ${name}/${name} --checks ${port}:http:${HEALTH_PATH}`,
  ];
  if (deferred.length) {
    notes.push(
      '#',
      `# Set in the Koyeb console: ${deferred.join(', ')}. Generate each secret with: openssl rand -hex 32.`,
      '# Authentication is enabled above, so the service stays down until PIWI_AUTH_SECRET is set.',
      ...entries.filter((entry) => entry.platformValue && entry.comment).map((e) => `# ${e.name}: ${e.comment}`),
    );
  }
  return commentBlock(opts.header) + `https://app.koyeb.com/deploy?${params.join('&')}\n` + notes.join('\n') + '\n';
}
