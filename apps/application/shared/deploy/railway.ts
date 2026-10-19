import { DATA_MOUNT, DEFAULT_IMAGE, HEALTH_PATH, type EmitOptions, type EnvEntry } from '#shared/env-format-base';

/**
 * The Railway template specification, as Markdown. Railway publishes templates
 * from its dashboard rather than from a file in the repository, so this is the
 * source of truth for what to enter there — generated from the same registry as
 * every other format so the variable list cannot drift.
 */
export function emitRailwayTemplate(entries: readonly EnvEntry[], opts: EmitOptions = {}): string {
  const railwayValue = (entry: EnvEntry): string => {
    if (entry.platformValue === 'generate') return '`${{ secret(64) }}`';
    if (entry.platformValue === 'url') return '`https://${{ RAILWAY_PUBLIC_DOMAIN }}`';
    return `\`${entry.value}\``;
  };
  const lines = [
    '# Railway template',
    '',
    'Railway publishes templates from its dashboard (**Workspace settings → Templates → New Template**),',
    'not from a file in a repository. Create one service with the settings below, publish it, and the',
    'resulting `https://railway.com/new/template/<code>` URL is what the Deploy on Railway button links to.',
    '',
    '## Service',
    '',
    '| Setting | Value |',
    '|---|---|',
    `| Source | Docker image \`${opts.image ?? DEFAULT_IMAGE}\` |`,
    `| Volume mount path | \`${DATA_MOUNT}\` |`,
    `| Health check path | \`${HEALTH_PATH}\` |`,
    `| Replicas | 1 — the SSE bus and the notification/retention cron all run in-process |`,
  ];
  if (entries.length) {
    lines.push(
      '',
      '## Variables',
      '',
      '| Variable | Value |',
      '|---|---|',
      ...entries.map((entry) => `| \`${entry.name}\` | ${railwayValue(entry)} |`),
    );
    const notes = entries.filter((entry) => entry.platformValue === 'generate' && entry.comment);
    if (notes.length) lines.push('', ...notes.map((entry) => `\`${entry.name}\`: ${entry.comment}`));
  }
  const header = opts.header?.length ? opts.header.map((line) => `> ${line}`).join('\n') + '\n\n' : '';
  return header + lines.join('\n') + '\n';
}
