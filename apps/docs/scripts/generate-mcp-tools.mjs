/**
 * Generates apps/docs/reference/mcp-tools.md — the MCP tools page — from the
 * MCP tool catalog (apps/application/shared/mcp-tools.ts).
 *
 * The page is a build artifact (gitignored): `docs:dev` and `docs:build` run
 * this first, so the list can never drift from the tools the server serves. To
 * change a tool's entry, edit the catalog.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { createJiti } from 'jiti';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
// The registry imports zod. The docs build installs only apps/docs, so zod
// resolves from here rather than from the application's node_modules.
const require = createRequire(import.meta.url);
const jiti = createJiti(import.meta.url, { alias: { zod: dirname(require.resolve('zod/package.json')) } });

const { MCP_TOOL_DEFS, toolSummary } = await jiti.import(join(repoRoot, 'application/shared/mcp-tools.ts'));
const { CAPABILITY_BY_ID, CAPABILITY_MODULES, CAPABILITY_PRESETS } = await jiti.import(
  join(repoRoot, 'application/shared/capabilities.ts'),
);

const MODULE_TITLES = { core: 'Core', workflow: 'Workflow', healing: 'Healing', agents: 'Agents' };

// The docs write no em dash; the catalog text uses them for asides.
const cell = (text) =>
  text
    .replace(/\s+—\s+/g, ', ')
    .replace(/—/g, ', ')
    .replace(/\|/g, '\\|');

// "Run history, …" reads as a list after a colon; "AI diagnosis" keeps its capitals.
const lowerFirst = (text) => (/^[A-Z][a-z]/.test(text) ? text[0].toLowerCase() + text.slice(1) : text);

function capabilityCell(id) {
  if (!id) return 'none';
  const def = CAPABILITY_BY_ID[id];
  return def ? `[\`${id}\`](/${def.doc})` : `\`${id}\``;
}

const toolRow = ({ name, description, capability }) =>
  `| <code id="${name}">${name}</code> | ${cell(toolSummary(description))} | ${capabilityCell(capability)} |`;

function moduleSection(module) {
  const tools = MCP_TOOL_DEFS.filter((tool) => tool.module === module);
  if (tools.length === 0) return '';
  const preset = CAPABILITY_PRESETS.find((p) => p.module === module);
  return [
    `## ${MODULE_TITLES[module] ?? module}`,
    '',
    // "N tools" is reserved for the total: the drift test holds every page to the real count.
    [`${tools.length} of the ${MCP_TOOL_DEFS.length} tools.`, preset ? `Setup offers this module as **${preset.label}**: ${lowerFirst(preset.description)}` : '']
      .filter(Boolean)
      .join(' '),
    '',
    '| Tool | What it returns or does | Capability |',
    '|------|-------------------------|------------|',
    ...tools.map(toolRow),
    '',
  ].join('\n');
}

const unknownModules = [...new Set(MCP_TOOL_DEFS.map((t) => t.module))].filter((m) => !CAPABILITY_MODULES.includes(m));
if (unknownModules.length > 0) throw new Error(`MCP tools in unknown modules: ${unknownModules.join(', ')}`);

const page = `---
title: MCP tools
description: Every tool the dashboard's MCP server serves, by module, with the capability that removes it when declined, generated from the tool catalog.
lang: en-US
editLink: false
---

<!-- GENERATED FILE, do not edit. -->
<!-- Source of truth: apps/application/shared/mcp-tools.ts, rendered by apps/docs/scripts/generate-mcp-tools.mjs (npm run docs:gen). -->

# MCP tools

The [MCP server](/features/mcp) serves ${MCP_TOOL_DEFS.length} tools. Each belongs to one **module**, the groups the
Setup page asks about, and \`?modules=\` on the MCP URL narrows the list to some of them. A tool with a
**capability** leaves \`tools/list\` and \`tools/call\` when an administrator declines that capability for the
instance; a tool without one is always served.

Each entry here is the summary line of the description the server sends to the agent. The **MCP server** page of the
dashboard (\`/mcp\`) lists the same catalog with each tool's whole description and parameters, and leaves out the
tools of declined capabilities.

${CAPABILITY_MODULES.map(moduleSection).filter(Boolean).join('\n')}
## Related

- [MCP server](/features/mcp): authentication, client setup and prompts
- [Agent skills](/features/agent-skills): the workflows that call these tools
- [Choose what you use](/operate/capabilities): declining a capability or a module
`;

mkdirSync(join(here, '..', 'reference'), { recursive: true });
writeFileSync(join(here, '..', 'reference', 'mcp-tools.md'), page);
console.log(`generated apps/docs/reference/mcp-tools.md from ${MCP_TOOL_DEFS.length} MCP tools`);
