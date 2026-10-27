/**
 * Pure emitters that turn a list of resolved environment variable values into
 * deployment-ready configuration snippets (.env file, docker run, Docker
 * Compose, Kubernetes, systemd, shell exports, hosting-platform manifests).
 *
 * This module is the public entry point — import everything from
 * `#shared/env-format`. It owns the generic formats and the `ENV_OUTPUT_FORMATS`
 * registry, and re-exports the shared vocabulary from `#shared/env-format-base`
 * plus one module per hosting platform from `#shared/deploy/*`.
 *
 * Consumed by the docs-site configuration generator wizard (which imports this
 * module directly through the `#shared` alias wired into the VitePress build)
 * and by `scripts/generate-deploy-manifests.mjs`, so it MUST stay
 * dependency-free and browser-safe: no third-party imports, no Node APIs. All
 * quoting/escaping rules live in the base module so every surface renders
 * identical, correct output — covered by `tests/unit/env-format.test.ts`.
 */
import {
  commentBlock,
  DEFAULT_IMAGE,
  DEFAULT_NAME,
  quoteDotenvValue,
  quotePowershellValue,
  quoteShellValue,
  quoteYamlValue,
  type EmitOptions,
  type EnvEntry,
} from '#shared/env-format-base';
import { emitCoolifyCompose } from '#shared/deploy/coolify';
import { emitFlyToml } from '#shared/deploy/fly';
import { emitKoyebDeployUrl } from '#shared/deploy/koyeb';
import { emitRailwayTemplate } from '#shared/deploy/railway';
import { emitRenderBlueprint } from '#shared/deploy/render';

export {
  quoteDotenvValue,
  quotePowershellValue,
  quoteShellValue,
  quoteTomlValue,
  quoteYamlValue,
  type EmitOptions,
  type EnvEntry,
} from '#shared/env-format-base';
export { emitCoolifyCompose } from '#shared/deploy/coolify';
export { emitFlyToml } from '#shared/deploy/fly';
export { emitKoyebDeployUrl } from '#shared/deploy/koyeb';
export { emitRailwayTemplate } from '#shared/deploy/railway';
export { emitRenderBlueprint } from '#shared/deploy/render';

/** `.env` file (application/.env, `docker compose --env-file`, …). */
export function emitDotenv(entries: readonly EnvEntry[], opts: EmitOptions = {}): string {
  const lines: string[] = [];
  for (const entry of entries) {
    if (entry.comment) lines.push(`# ${entry.comment}`);
    lines.push(`${entry.name}=${quoteDotenvValue(entry.value)}`);
  }
  return commentBlock(opts.header) + lines.join('\n') + '\n';
}

/** `export NAME='value'` lines for bash/zsh. */
export function emitShellExports(entries: readonly EnvEntry[], opts: EmitOptions = {}): string {
  const lines = entries.map((entry) => `export ${entry.name}=${quoteShellValue(entry.value)}`);
  return commentBlock(opts.header) + lines.join('\n') + '\n';
}

/** `$env:NAME = 'value'` lines for PowerShell. */
export function emitPowershellEnv(entries: readonly EnvEntry[], opts: EmitOptions = {}): string {
  const lines = entries.map((entry) => `$env:${entry.name} = ${quotePowershellValue(entry.value)}`);
  return commentBlock(opts.header) + lines.join('\n') + '\n';
}

/** Multi-line `docker run` command for Linux/macOS shells. */
export function emitDockerRunBash(entries: readonly EnvEntry[], opts: EmitOptions = {}): string {
  const image = opts.image ?? DEFAULT_IMAGE;
  const name = opts.name ?? DEFAULT_NAME;
  const lines = [
    `docker run -d --name ${name} \\`,
    `  -p 3000:3000 \\`,
    `  -v "$(pwd)/.data:/app/.data" \\`,
    ...entries.map((entry) => `  -e ${entry.name}=${quoteShellValue(entry.value)} \\`),
    `  ${image}`,
  ];
  return commentBlock(opts.header) + lines.join('\n') + '\n';
}

/** Multi-line `docker run` command for Windows PowerShell. */
export function emitDockerRunPowershell(entries: readonly EnvEntry[], opts: EmitOptions = {}): string {
  const image = opts.image ?? DEFAULT_IMAGE;
  const name = opts.name ?? DEFAULT_NAME;
  const lines = [
    'docker run -d --name ' + name + ' `',
    '  -p 3000:3000 `',
    '  -v "${PWD}/.data:/app/.data" `',
    ...entries.map((entry) => `  -e ${entry.name}=${quotePowershellValue(entry.value)} \``),
    `  ${image}`,
  ];
  return commentBlock(opts.header) + lines.join('\n') + '\n';
}

/** Minimal Docker Compose service with the variables inlined. */
export function emitDockerCompose(entries: readonly EnvEntry[], opts: EmitOptions = {}): string {
  const image = opts.image ?? DEFAULT_IMAGE;
  const name = opts.name ?? DEFAULT_NAME;
  const env = entries.length
    ? entries.map((entry) => `      ${entry.name}: ${quoteYamlValue(entry.value)}`).join('\n')
    : '      {}';
  return (
    commentBlock(opts.header) +
    `services:
  ${name}:
    image: ${image}
    ports:
      - '3000:3000'
    volumes:
      - ./.data:/app/.data
    environment:
${env}
    restart: unless-stopped
`
  );
}

/**
 * Kubernetes ConfigMap (plain values) + Secret (values flagged `secret`),
 * wired into a container via `envFrom`.
 */
export function emitKubernetes(entries: readonly EnvEntry[], opts: EmitOptions = {}): string {
  const name = opts.name ?? DEFAULT_NAME;
  const plain = entries.filter((entry) => !entry.secret);
  const secret = entries.filter((entry) => entry.secret);
  const parts: string[] = [];
  const data = (list: readonly EnvEntry[]) =>
    list.length ? list.map((entry) => `  ${entry.name}: ${quoteYamlValue(entry.value)}`).join('\n') : '  {}';
  parts.push(`apiVersion: v1
kind: ConfigMap
metadata:
  name: ${name}-config
data:
${data(plain)}`);
  if (secret.length) {
    parts.push(`apiVersion: v1
kind: Secret
metadata:
  name: ${name}-secrets
type: Opaque
stringData:
${data(secret)}`);
  }
  const envFrom = [`        - configMapRef:`, `            name: ${name}-config`];
  if (secret.length) envFrom.push(`        - secretRef:`, `            name: ${name}-secrets`);
  parts.push(`# Reference from your Deployment's container spec:
#
#     spec:
#       containers:
#         - name: ${name}
#           envFrom:
${envFrom.map((line) => `#     ${line.slice(4)}`).join('\n')}`);
  return commentBlock(opts.header) + parts.join('\n---\n') + '\n';
}

/** EnvironmentFile for a systemd unit, with usage instructions inline. */
export function emitSystemd(entries: readonly EnvEntry[], opts: EmitOptions = {}): string {
  const lines: string[] = [];
  for (const entry of entries) {
    if (entry.comment) lines.push(`# ${entry.comment}`);
    lines.push(`${entry.name}=${quoteDotenvValue(entry.value)}`);
  }
  return (
    commentBlock(opts.header) +
    `# Save as /etc/piwi/piwi.env and reference it from the unit:
#
#   [Service]
#   EnvironmentFile=/etc/piwi/piwi.env
#
${lines.join('\n')}
`
  );
}

/** Tab groups the configuration generator renders, in display order. */
export const ENV_OUTPUT_GROUPS = ['Files & shells', 'Containers', 'Hosting platforms'] as const;

export type EnvOutputGroup = (typeof ENV_OUTPUT_GROUPS)[number];

export interface EnvOutputFormat {
  /** Stable identifier (also used as the wizard tab key). */
  id: string;
  /** Human label, sentence case. */
  label: string;
  /** Markdown/Shiki language for syntax highlighting. */
  language: string;
  /** Suggested filename for downloads. */
  filename: string;
  /** Row the wizard renders this format's tab in. */
  group: EnvOutputGroup;
  emit(entries: readonly EnvEntry[], opts?: EmitOptions): string;
}

/** Every output format the configuration generator offers, in display order. */
export const ENV_OUTPUT_FORMATS: readonly EnvOutputFormat[] = [
  { id: 'dotenv', label: '.env file', language: 'dotenv', filename: '.env', group: 'Files & shells', emit: emitDotenv },
  {
    id: 'systemd',
    label: 'systemd',
    language: 'ini',
    filename: 'piwi.env',
    group: 'Files & shells',
    emit: emitSystemd,
  },
  {
    id: 'shell',
    label: 'Shell exports (bash)',
    language: 'bash',
    filename: 'piwi-env.sh',
    group: 'Files & shells',
    emit: emitShellExports,
  },
  {
    id: 'powershell',
    label: 'Shell exports (PowerShell)',
    language: 'powershell',
    filename: 'piwi-env.ps1',
    group: 'Files & shells',
    emit: emitPowershellEnv,
  },
  {
    id: 'compose',
    label: 'Docker Compose',
    language: 'yaml',
    filename: 'docker-compose.yml',
    group: 'Containers',
    emit: emitDockerCompose,
  },
  {
    id: 'docker-run',
    label: 'docker run (Linux / macOS)',
    language: 'bash',
    filename: 'run-piwi.sh',
    group: 'Containers',
    emit: emitDockerRunBash,
  },
  {
    id: 'docker-run-ps',
    label: 'docker run (PowerShell)',
    language: 'powershell',
    filename: 'run-piwi.ps1',
    group: 'Containers',
    emit: emitDockerRunPowershell,
  },
  {
    id: 'kubernetes',
    label: 'Kubernetes',
    language: 'yaml',
    filename: 'piwi-env.yaml',
    group: 'Containers',
    emit: emitKubernetes,
  },
  {
    id: 'railway',
    label: 'Railway',
    language: 'markdown',
    filename: 'railway-template.md',
    group: 'Hosting platforms',
    emit: emitRailwayTemplate,
  },
  {
    id: 'render',
    label: 'Render',
    language: 'yaml',
    filename: 'render.yaml',
    group: 'Hosting platforms',
    emit: emitRenderBlueprint,
  },
  { id: 'fly', label: 'Fly.io', language: 'toml', filename: 'fly.toml', group: 'Hosting platforms', emit: emitFlyToml },
  {
    id: 'koyeb',
    label: 'Koyeb',
    language: 'bash',
    filename: 'koyeb-deploy-url.txt',
    group: 'Hosting platforms',
    emit: emitKoyebDeployUrl,
  },
  {
    id: 'coolify',
    label: 'Coolify / Dokploy',
    language: 'yaml',
    filename: 'coolify-compose.yml',
    group: 'Hosting platforms',
    emit: emitCoolifyCompose,
  },
];
