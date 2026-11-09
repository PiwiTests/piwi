/**
 * Pure helpers backing the API reference's (`/settings/api`) "Try it out" console and code samples.
 *
 * These build request URLs, example request bodies, and copy-paste cURL / fetch
 * snippets from the OpenAPI spec. They are side-effect free (no network, no
 * `window`) so the request itself — the only outbound call, and only when the
 * user clicks Send against their own server — stays in the component.
 */
import type { JsonSchema, OpenApiOperation, OpenApiSpec } from './openapi';
import { resolveSchema } from './openapi';

/** Substitute `{name}` path segments with (URL-encoded) values. */
export function substitutePath(path: string, values: Record<string, string>): string {
  return path.replace(/\{([^}]+)\}/g, (whole, name: string) => {
    const value = values[name];
    return value ? encodeURIComponent(value) : whole;
  });
}

/** Build a `?a=b&c=d` query string from non-empty values (empty → ''). */
export function buildQuery(values: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== '') search.append(key, value);
  }
  const query = search.toString();
  return query ? `?${query}` : '';
}

/** Generate a representative example value for a schema (for prefilling bodies). */
export function schemaExample(
  schema: JsonSchema | undefined,
  spec: OpenApiSpec | null | undefined,
  depth = 0,
): unknown {
  const s = resolveSchema(schema, spec);
  if (!s || depth > 6) return null;
  if (s.example !== undefined) return s.example;
  if (s.default !== undefined) return s.default;
  if (s.enum?.length) return s.enum[0];

  const type = Array.isArray(s.type) ? s.type.find((t) => t !== 'null') : s.type;

  if (type === 'object' || (!type && s.properties)) {
    const obj: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(s.properties ?? {})) {
      obj[key] = schemaExample(value, spec, depth + 1);
    }
    return obj;
  }
  if (type === 'array') {
    return [schemaExample(s.items, spec, depth + 1)];
  }
  switch (type) {
    case 'string':
      if (s.format === 'date-time') return '2024-01-01T00:00:00Z';
      if (s.format === 'date') return '2024-01-01';
      if (s.format === 'uuid') return '00000000-0000-0000-0000-000000000000';
      return 'string';
    case 'integer':
    case 'number':
      return 0;
    case 'boolean':
      return false;
    default:
      return null;
  }
}

/** The JSON request-body example for an operation, pretty-printed, or null. */
export function requestBodyExample(operation: OpenApiOperation, spec: OpenApiSpec | null | undefined): string | null {
  const schema = operation.requestBody?.content?.['application/json']?.schema;
  if (!schema) return null;
  return JSON.stringify(schemaExample(schema, spec), null, 2);
}

/** Whether the operation accepts a JSON request body (interactively editable). */
export function hasJsonBody(operation: OpenApiOperation): boolean {
  return Boolean(operation.requestBody?.content?.['application/json']);
}

function shellQuote(value: string): string {
  // Single-quote for POSIX shells; escape embedded single quotes. Kept on one
  // line (no `\` continuations) so it pastes cleanly everywhere.
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface RequestShape {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

/** A single-line cURL command for the request (POSIX shell). */
export function buildCurl({ method, url, headers, body }: RequestShape): string {
  const parts = ['curl'];
  if (method.toUpperCase() !== 'GET') parts.push('-X', method.toUpperCase());
  for (const [key, value] of Object.entries(headers)) {
    parts.push('-H', shellQuote(`${key}: ${value}`));
  }
  if (body) parts.push('-d', shellQuote(body));
  parts.push(shellQuote(url));
  return parts.join(' ');
}

/** A `fetch()` snippet for the request. */
export function buildFetchSnippet({ method, url, headers, body }: RequestShape): string {
  const init: string[] = [`  method: ${JSON.stringify(method.toUpperCase())},`];
  if (Object.keys(headers).length) {
    init.push(`  headers: ${JSON.stringify(headers)},`);
  }
  if (body) {
    init.push(`  body: ${JSON.stringify(body)},`);
  }
  return `const res = await fetch(${JSON.stringify(url)}, {\n${init.join('\n')}\n});\nconst data = await res.json();`;
}
