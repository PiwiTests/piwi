/**
 * Generates apps/docs/reference/reporter-options.md — the reporter options
 * reference page — from the `PiwiDashboardOptions` interface in
 * packages/reporter/src/public/options.ts.
 *
 * The page is a build artifact (gitignored): `docs:dev` and `docs:build` run
 * this first, so the reference can never drift from the options type. To change
 * the page, edit the JSDoc in options.ts.
 *
 * How the page is built:
 *  - Members are read with the TypeScript compiler API, in source order.
 *  - A `// ── Title ──…` line comment inside the interface starts a group
 *    (an `## Title` section); plain `//` comments right after a heading become
 *    that section's intro paragraph.
 *  - A member whose type is an object literal (e.g. `ai`) contributes its own
 *    JSDoc as an intro paragraph and one row per nested member (`ai.mode`, …).
 *  - Default: a `@default` tag, else a "Defaults to x" / "Default: x" /
 *    "`x` (default)" phrase in the JSDoc, else the `DEFAULTS` object in
 *    packages/reporter/src/internal/config/env.ts, else "—".
 *  - Environment variable: `PIWI_ENV_KEYS` in env.ts, keyed by option name
 *    (nested options use the camelCase key, `ai.mode` → `aiMode`).
 *  - Anchor scheme: each option cell is `<code id="…">`, where the id is the
 *    option path lowercased with dots turned into hyphens (`uploadTraces` →
 *    `uploadtraces`, `ai.mode` → `ai-mode`). Keep it stable: other pages link it.
 *
 * Fails (non-zero exit) when an option has no JSDoc, so a new undocumented
 * option breaks the docs build.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const optionsPath = join(repoRoot, 'packages/reporter/src/public/options.ts');
const envPath = join(repoRoot, 'packages/reporter/src/internal/config/env.ts');

const parse = (path) => {
  const text = readFileSync(path, 'utf8');
  return { text, sf: ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS) };
};

function fail(message) {
  console.error(`generate-reporter-options: ${message}`);
  process.exit(1);
}

// ── env.ts: PIWI_ENV_KEYS and DEFAULTS ──────────────────────────────────────

/** Finds `const <name> = { … }` (unwrapping `as const` / type annotations). */
function findObjectLiteral(sf, name) {
  let found;
  const visit = (node) => {
    if (found) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer) {
      let init = node.initializer;
      while (ts.isAsExpression(init) || ts.isSatisfiesExpression(init) || ts.isParenthesizedExpression(init))
        init = init.expression;
      if (ts.isObjectLiteralExpression(init)) found = init;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (!found) fail(`could not find \`${name}\` in ${envPath}`);
  return found;
}

const propName = (prop) => (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : undefined);

/** Renders a literal initializer as its value; folds simple numeric arithmetic. */
function literalText(expr) {
  if (ts.isStringLiteral(expr)) return `'${expr.text}'`;
  if (ts.isNumericLiteral(expr)) return expr.text;
  if (expr.kind === ts.SyntaxKind.TrueKeyword) return 'true';
  if (expr.kind === ts.SyntaxKind.FalseKeyword) return 'false';
  if (expr.kind === ts.SyntaxKind.NullKeyword) return 'null';
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.AsteriskToken) {
    const l = Number(literalText(expr.left));
    const r = Number(literalText(expr.right));
    if (Number.isFinite(l) && Number.isFinite(r)) return String(l * r);
  }
  return expr.getText();
}

const env = parse(envPath);
const envKeys = new Map();
for (const prop of findObjectLiteral(env.sf, 'PIWI_ENV_KEYS').properties) {
  if (ts.isPropertyAssignment(prop) && ts.isStringLiteral(prop.initializer)) envKeys.set(propName(prop), prop.initializer.text);
}
const codeDefaults = new Map();
for (const prop of findObjectLiteral(env.sf, 'DEFAULTS').properties) {
  if (ts.isPropertyAssignment(prop)) codeDefaults.set(propName(prop), literalText(prop.initializer));
}

// ── options.ts: the PiwiDashboardOptions interface ──────────────────────────

const opts = parse(optionsPath);
const iface = opts.sf.statements.find((s) => ts.isInterfaceDeclaration(s) && s.name.text === 'PiwiDashboardOptions');
if (!iface) fail(`could not find interface PiwiDashboardOptions in ${optionsPath}`);

/** JSDoc comment text, with `{@link X}` rendered as `X` in code. */
function commentText(comment) {
  if (!comment) return '';
  if (typeof comment === 'string') return comment;
  return comment
    .map((part) => {
      if (ts.isJSDocLink(part) || ts.isJSDocLinkCode(part) || ts.isJSDocLinkPlain(part)) {
        const target = part.name ? part.name.getText() : '';
        const label = part.text?.trim();
        return `\`${label || target}\``;
      }
      return part.text;
    })
    .join('');
}

/** { description, defaultTag } from a member's JSDoc, or undefined when it has none. */
function readJsDoc(member) {
  const docs = ts.getJSDocCommentsAndTags(member).filter(ts.isJSDoc);
  if (docs.length === 0) return undefined;
  const doc = docs[docs.length - 1];
  const parts = [commentText(doc.comment)];
  let defaultTag;
  for (const tag of doc.tags ?? []) {
    const name = tag.tagName.text;
    const text = commentText(tag.comment).trim();
    if (name === 'default' || name === 'defaultValue') defaultTag = text;
    else if (name === 'example' && text) parts.push(`Example: \`${text.replace(/\s+/g, ' ')}\``);
    else if (name === 'deprecated') parts.push(`*Deprecated.*${text ? ` ${text}` : ''}`);
    else if (name === 'see' && text) parts.push(`See ${text}.`);
  }
  const description = parts.join(' ').replace(/\s+/g, ' ').trim();
  return description ? { description, defaultTag } : undefined;
}

/** Pulls a default out of the prose: "Defaults to x", "Default: x", "`x` (default)". */
function defaultFromText(text) {
  const plain = text.replace(/\*\*/g, '');
  const phrase = plain.match(/Defaults? (?:to|is|:)\s*(.+?)(?:[.;](?:\s|$)| — |,|$)/i);
  if (phrase) return phrase[1].trim();
  const marked = text.match(/`([^`]+)` \(default\)/);
  if (marked) return `\`${marked[1]}\``;
  return undefined;
}

/** Group headings and intro text from the line comments before a member. */
function leadingGroup(member) {
  const ranges = ts.getLeadingCommentRanges(opts.text, member.pos) ?? [];
  let group;
  for (const range of ranges) {
    if (range.kind !== ts.SyntaxKind.SingleLineCommentTrivia) continue;
    const line = opts.text.slice(range.pos + 2, range.end).trim();
    if (line.startsWith('──')) {
      group = { title: line.replace(/^─+/, '').replace(/─+$/, '').trim(), intro: [] };
    } else if (group) {
      group.intro.push(line);
    }
  }
  if (!group) return undefined;
  group.intro = group.intro.join(' ').replace(/\s+/g, ' ').trim();
  return group;
}

const oneLine = (s) => s.replace(/\s+/g, ' ').trim();
const envKeyFor = (path) =>
  envKeys.get(path.length === 1 ? path[0] : path[0] + path.slice(1).map((p) => p[0].toUpperCase() + p.slice(1)).join(''));

const groups = [];
const undocumented = [];
let optionCount = 0;

function addRow(group, member, path) {
  const name = path.join('.');
  const doc = readJsDoc(member);
  if (!doc) {
    undocumented.push(name);
    return;
  }
  optionCount++;
  let def = doc.defaultTag || defaultFromText(doc.description);
  if (!def && path.length === 1 && codeDefaults.has(name)) def = `\`${codeDefaults.get(name)}\``;
  if (def && !def.includes('`')) def = `\`${def}\``;
  const envKey = envKeyFor(path);
  group.rows.push({
    name,
    type: member.type ? oneLine(member.type.getText()) : 'unknown',
    def: def ?? '—',
    env: envKey ? `\`${envKey}\`` : '—',
    description: doc.description,
  });
}

for (const member of iface.members) {
  if (!ts.isPropertySignature(member)) continue;
  const heading = leadingGroup(member);
  if (heading) groups.push({ ...heading, rows: [], notes: [] });
  if (groups.length === 0) groups.push({ title: 'General', intro: '', rows: [], notes: [] });
  const group = groups[groups.length - 1];
  const name = propName(member);

  if (member.type && ts.isTypeLiteralNode(member.type)) {
    // Nested options object: its JSDoc introduces the rows of its members.
    const doc = readJsDoc(member);
    if (!doc) undocumented.push(name);
    else group.notes.push(`**\`${name}\`** (object). ${doc.description}`);
    for (const child of member.type.members) {
      if (ts.isPropertySignature(child)) addRow(group, child, [name, propName(child)]);
    }
  } else {
    addRow(group, member, [name]);
  }
}

if (undocumented.length > 0) {
  fail(
    `${undocumented.length} option(s) of PiwiDashboardOptions have no JSDoc: ${undocumented.join(', ')}.\n` +
      `Add a /** … */ comment to each in packages/reporter/src/public/options.ts.`,
  );
}

// ── Render ──────────────────────────────────────────────────────────────────

/**
 * Renders bare URLs as code spans (VitePress would otherwise linkify them into
 * dead links). Text already inside backticks or a markdown link target is kept.
 */
const codeifyBareLinks = (text) =>
  text
    .split('`')
    .map((segment, i) => (i % 2 === 1 ? segment : segment.replace(/(?<!\]\()(https?:\/\/[^\s|)`]+)/g, '`$1`')))
    .join('`');

const cell = (text) => codeifyBareLinks(text).replace(/\n/g, ' ').replace(/\|/g, '\\|');
const anchorId = (name) => name.toLowerCase().replace(/\./g, '-');

function groupMarkdown(group) {
  const lines = [`## ${group.title}`, ''];
  if (group.intro) lines.push(codeifyBareLinks(group.intro), '');
  for (const note of group.notes) lines.push(codeifyBareLinks(note), '');
  // Three columns, like the configuration reference: the variable sits under
  // the option and the default under the type, so the description keeps room.
  lines.push('| Option and variable | Type and default | Description |', '|---|---|---|');
  for (const row of group.rows) {
    const option = `<code id="${anchorId(row.name)}">${row.name}</code>${row.env === '—' ? '' : `<br>${row.env}`}`;
    const typeAndDefault = `${cell(`\`${row.type}\``)}<br>${row.def === '—' ? 'no default' : cell(row.def)}`;
    lines.push(`| ${option} | ${typeAndDefault} | ${cell(row.description)} |`);
  }
  lines.push('');
  return lines.join('\n');
}

const page = `---
title: Reporter options
description: Every option of the Piwi Playwright reporter, with its type, default and environment variable, generated from the reporter's options type.
lang: en-US
editLink: false
---

<!-- GENERATED FILE — do not edit. -->
<!-- Source of truth: packages/reporter/src/public/options.ts (PiwiDashboardOptions), rendered by apps/docs/scripts/generate-reporter-options.mjs (npm run docs:gen). -->

# Reporter options

These options go in the reporter's options object in \`playwright.config.ts\`, or in \`wrapConfig\`'s second argument (see [Reporter](/guide/reporter#configuration-options)). Most of them can also be set with the environment variable shown in their row. The variable only fills in an option you left unset, so an explicit option always wins, with one exception: on a plain reporter entry, \`PIWI_VERBOSE\` overrides even an explicit \`verbose\` option (under \`wrapConfig\` the option wins).

## Values from \`.env\`

\`PIWI_DASHBOARD_URL\`, \`PIWI_API_KEY\` and \`PIWI_PROJECT_NAME\` (\`serverUrl\`, \`apiKey\` and \`projectName\`) are also read from the \`.env\` file in the Playwright config's folder, the file [\`init\`](/reference/cli#init) writes, so a key kept there reaches the run without loading the file in your config. A value in the file only fills what the config and the environment leave unset, one variable at a time, as if the file were loaded into the environment without overriding it: an option in the config wins, then an environment variable, then \`.env\`, then the [desktop app](/guide/reporter#finding-the-desktop-app-automatically). An empty value (\`PIWI_API_KEY=\`) counts as unset. The file is parsed as the [command line](/reference/cli) parses it: \`KEY=value\` lines, an optional \`export\`, quotes and \`#\` comments, no variable expansion.

The reporter and Piwi's [global setup](/guide/reporter#global-setup-phase) read the same file, in the folder of the config the run uses (the one \`-c\` names) rather than the working directory, so the run is registered and uploaded with the same server and key. Other variables in the file are not read: set them in the environment, or load the file in your config yourself (\`process.loadEnvFile()\` or the \`dotenv\` package). \`.env\` stays out of git, so in CI the same variables come from the pipeline's secrets. With \`PIWI_VERBOSE=true\`, the reporter logs which variables it took from the file.

${groups.map(groupMarkdown).join('\n')}
## Related

- [Reporter](/guide/reporter): installing the reporter and wiring it into \`playwright.config.ts\`.
- [Test metadata](/reference/test-metadata): annotations and tags the reporter reads from your tests.
- [Configuration reference](/reference/configuration): the \`PIWI_*\` environment variables the dashboard server reads.
`;

mkdirSync(join(here, '..', 'reference'), { recursive: true });
writeFileSync(join(here, '..', 'reference', 'reporter-options.md'), page);
console.log(`generated apps/docs/reference/reporter-options.md from ${optionCount} options in ${groups.length} groups`);
