import {
  commentBlock,
  DATA_MOUNT,
  DEFAULT_DISK_GB,
  DEFAULT_IMAGE,
  DEFAULT_NAME,
  DEFAULT_PORT,
  HEALTH_PATH,
  quoteShellValue,
  quoteTomlValue,
  type EmitOptions,
  type EnvEntry,
} from '#shared/env-format-base';

/**
 * Fly Launch config (`fly.toml`), driven by `fly launch`. Secrets never belong
 * in this file — it is committed — so they are emitted as the `fly secrets set`
 * command to run once instead. Autoscaling stays off: the notification and
 * retention sweeps run in-process, so a suspended machine stops doing work it
 * is supposed to do on a schedule.
 */
export function emitFlyToml(entries: readonly EnvEntry[], opts: EmitOptions = {}): string {
  const name = opts.name ?? DEFAULT_NAME;
  const port = opts.port ?? DEFAULT_PORT;
  const lines = [
    `app = ${quoteTomlValue(name)}`,
    `primary_region = ${quoteTomlValue(opts.region ?? 'cdg')}`,
    '',
    '[build]',
    `  image = ${quoteTomlValue(opts.image ?? DEFAULT_IMAGE)}`,
  ];
  const envLines: string[] = [];
  const secretLines: string[] = [];
  const secretNotes: string[] = [];
  for (const entry of entries) {
    if (entry.platformValue === 'generate' || entry.secret) {
      secretLines.push(
        `${entry.name}=${entry.platformValue === 'generate' ? '$(openssl rand -hex 32)' : quoteShellValue(entry.value)}`,
      );
      // A commented secret is one the operator needs later: say why, and how to read it back.
      if (entry.comment) {
        secretNotes.push(
          `# ${entry.name}: ${entry.comment}`,
          `# Read it back with: fly ssh console -C "printenv ${entry.name}"`,
        );
      }
      continue;
    }
    if (entry.comment) envLines.push(`  # ${entry.comment}`);
    if (entry.platformValue === 'url') {
      // `fly launch` rewrites `app` when the name is taken, but not this value.
      envLines.push(`  # Update this if \`fly launch\` picked a different app name.`);
      envLines.push(`  ${entry.name} = ${quoteTomlValue(`https://${name}.fly.dev`)}`);
      continue;
    }
    envLines.push(`  ${entry.name} = ${quoteTomlValue(entry.value)}`);
  }
  if (envLines.length) lines.push('', '[env]', ...envLines);
  lines.push(
    '',
    '[mounts]',
    `  source = ${quoteTomlValue(`${name}_data`.replace(/-/g, '_'))}`,
    `  destination = ${quoteTomlValue(DATA_MOUNT)}`,
    `  initial_size = ${quoteTomlValue(`${opts.diskGB ?? DEFAULT_DISK_GB}gb`)}`,
    '',
    '[http_service]',
    `  internal_port = ${port}`,
    '  force_https = true',
    '  # One always-on machine: SQLite, the SSE bus and the cron sweeps are all in-process.',
    '  auto_stop_machines = false',
    '  auto_start_machines = false',
    '  min_machines_running = 1',
    '',
    '  [[http_service.checks]]',
    '    interval = "30s"',
    '    timeout = "5s"',
    '    grace_period = "20s"',
    '    method = "GET"',
    `    path = ${quoteTomlValue(HEALTH_PATH)}`,
    '',
    '[[vm]]',
    '  size = "shared-cpu-1x"',
    '  memory = "1gb"',
  );
  if (secretLines.length) {
    lines.push(
      '',
      '# Secrets are never committed to fly.toml. Set them once, after `fly launch --no-deploy`:',
      '#',
      `#   fly secrets set ${secretLines.join(' \\\n#     ')}`,
    );
    if (secretNotes.length) lines.push('#', ...secretNotes);
  }
  return commentBlock(opts.header) + lines.join('\n') + '\n';
}
