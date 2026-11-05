/**
 * CI server dispatch: the target a project's CI re-run and Flake Lab dispatch
 * go to when `ciRerun.via` is `ci-server`, the preset registry that turns a few
 * fields into an HTTP request template, and the renderer that fills a template
 * with a dispatch's values.
 *
 * A request never leaves the base URL: a template names a path relative to
 * it, each placeholder fills one percent-encoded path segment or an encoded
 * query, form, header or JSON value, and the rendered URL is checked to stay
 * under the base URL. No template names the scheme, the host or the port.
 *
 * Pure and dependency-free: the transport, the credentials and the host rule
 * live in `server/utils/ci-server-dispatch.ts`.
 */

/** The presets a CI server target may name. */
export const CI_SERVER_PRESETS = ['jenkins', 'custom'] as const;
export type CiServerPreset = (typeof CI_SERVER_PRESETS)[number];

/** Where the credential goes: nowhere, HTTP Basic (user and token), a Bearer token, or one named header. */
export type CiServerAuth = 'none' | 'basic' | 'bearer' | { header: string };

/** One HTTP request a dispatch sends, before its placeholders are filled. */
export interface CiRequestTemplate {
  method: 'POST' | 'PUT';
  /** Relative to the base URL; each `{{name}}` placeholder is percent-encoded inside its path segment. */
  path: string;
  query?: [name: string, value: string][];
  headers?: [name: string, value: string][];
  /** JSON (placeholders only as whole string values) or form fields. */
  body?: { type: 'json'; template: string } | { type: 'form'; fields: [name: string, value: string][] };
  /** Where the link to watch comes from: a JSON pointer, a response header, or a path relative to the base URL. */
  link?: { pointer: string } | { header: string } | { template: string };
  /** A JSON pointer to the build number, matched against the run's `ci.buildNumber`. */
  buildNumber?: string;
}

/** The CI server a project's dispatches go to. */
export interface CiServerTarget {
  preset: CiServerPreset;
  /** The project's base URL; absent, the instance's `PIWI_CI_SERVER_URL`. */
  baseUrl?: string;
  /** The user name a Basic credential pairs with the project's token. */
  user?: string;
  /** The preset's fields for the re-run (Jenkins: `job`, `argsParameter`, `dispatchParameter`, `ref`). */
  rerun: Record<string, string>;
  /** The preset's fields for Flake Lab; absent, no Flake Lab in CI. */
  flakeLab?: Record<string, string>;
  /** Custom only: the request templates and where the credential goes. */
  custom?: { auth: CiServerAuth; rerun: CiRequestTemplate; flakeLab?: CiRequestTemplate };
}

/** What a dispatch hands its template. */
export interface CiTemplateValues {
  /** The Playwright arguments, or the `flake` command's for Flake Lab. */
  args: string;
  /** The dispatch id, which the run carries back as `PIWI_ORIGIN_REF`. */
  dispatchId: string;
  /** The run's branch, else the target's `ref` field, else empty. */
  ref: string;
  /** The run's commit, else empty. */
  commit: string;
}

/**
 * The placeholders a template may name. `branchJob` is the ref as Jenkins names
 * a multibranch pipeline's branch job (`feature/x` is the job `feature%2Fx`).
 */
export const CI_TEMPLATE_PLACEHOLDERS = ['args', 'dispatchId', 'ref', 'commit', 'branchJob'] as const;
export type CiTemplatePlaceholder = (typeof CI_TEMPLATE_PLACEHOLDERS)[number];

/** A field of a preset, as the settings form shows it. */
export interface CiServerPresetField {
  name: string;
  label: string;
  required: boolean;
  /** The value an empty field takes. */
  default?: string;
}

/** A preset: its fields, the credential it uses, and the request it builds from its fields. */
export interface CiServerPresetDefinition {
  label: string;
  auth: CiServerAuth;
  rerunFields: CiServerPresetField[];
  flakeLabFields: CiServerPresetField[];
  /** The request for these resolved fields, or null when they cannot form one. */
  template: (fields: Record<string, string>) => CiRequestTemplate | null;
}

/** The parameter names a Jenkins job declares by default: the environment variables the reporter reads. */
export const DEFAULT_ARGS_PARAMETER = 'PIWI_RERUN_ARGS';
export const DEFAULT_DISPATCH_PARAMETER = 'PIWI_ORIGIN_REF';

/** The segment of a Jenkins job path that stands for a multibranch pipeline's branch job. */
export const JENKINS_BRANCH_SEGMENT = '{branch}';

/**
 * A Jenkins job as Jenkins shows it (`polaris/e2e`, `polaris/e2e/{branch}`) as
 * the path of its job page (`job/polaris/job/e2e`), each name percent-encoded,
 * or null when a name is `.` or `..`.
 */
export function jenkinsJobPath(job: string): string | null {
  const names = job
    .split('/')
    .map((name) => name.trim())
    .filter(Boolean);
  if (names.length === 0 || names.some((name) => name === '.' || name === '..')) return null;
  return names
    .map((name) => `job/${name === JENKINS_BRANCH_SEGMENT ? '{{branchJob}}' : encodeURIComponent(name)}`)
    .join('/');
}

const jenkinsFields = (withRef: boolean): CiServerPresetField[] => [
  { name: 'job', label: 'Job', required: true },
  ...(withRef ? [{ name: 'ref', label: 'Default branch', required: false }] : []),
  { name: 'argsParameter', label: 'Arguments parameter', required: false, default: DEFAULT_ARGS_PARAMETER },
  { name: 'dispatchParameter', label: 'Dispatch id parameter', required: false, default: DEFAULT_DISPATCH_PARAMETER },
];

/** The presets that build their request from fields; Custom holds its templates itself. */
export const CI_SERVER_PRESET_REGISTRY: Record<Exclude<CiServerPreset, 'custom'>, CiServerPresetDefinition> = {
  jenkins: {
    label: 'Jenkins',
    auth: 'basic',
    rerunFields: jenkinsFields(true),
    flakeLabFields: jenkinsFields(false),
    template: (fields) => {
      const jobPath = jenkinsJobPath(fields.job ?? '');
      if (!jobPath) return null;
      return {
        method: 'POST',
        path: `${jobPath}/buildWithParameters`,
        body: {
          type: 'form',
          fields: [
            [fields.argsParameter || DEFAULT_ARGS_PARAMETER, '{{args}}'],
            [fields.dispatchParameter || DEFAULT_DISPATCH_PARAMETER, '{{dispatchId}}'],
          ],
        },
        link: { template: `${jobPath}/` },
      };
    },
  },
};

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * A base URL as a dispatch uses it: an absolute `http(s)` URL without a user,
 * a query or a fragment, its path ending in `/`. Null when it is not one.
 */
export function normalizeCiServerBaseUrl(raw: unknown): string | null {
  const value = str(raw);
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password || url.search || url.hash || !url.hostname) return null;
  if (!url.pathname.endsWith('/')) url.pathname = `${url.pathname}/`;
  return url.href;
}

/**
 * Whether `target` lies under `base`: the same scheme, host and port, no user
 * in the URL, and a path inside the base path (`/job/qa/` holds `/job/qa/x`,
 * never `/job/qa-other`).
 */
export function isUnderBaseUrl(base: string, target: string): boolean {
  let b: URL;
  let t: URL;
  try {
    b = new URL(base);
    t = new URL(target);
  } catch {
    return false;
  }
  if (t.username || t.password || b.protocol !== t.protocol || b.host !== t.host) return false;
  const basePath = b.pathname.endsWith('/') ? b.pathname : `${b.pathname}/`;
  return t.pathname.startsWith(basePath) || `${t.pathname}/` === basePath;
}

function resolveFields(input: unknown, fields: CiServerPresetField[]): Record<string, string> | null {
  const raw = isRecord(input) ? input : {};
  const out: Record<string, string> = {};
  for (const field of fields) {
    const value = str(raw[field.name]) || field.default || '';
    if (!value && field.required) return null;
    if (value) out[field.name] = value;
  }
  return out;
}

function resolvePairs(input: unknown): [string, string][] | undefined {
  if (!Array.isArray(input)) return undefined;
  const pairs = input.filter(
    (p): p is [string, string] =>
      Array.isArray(p) && p.length === 2 && typeof p[0] === 'string' && typeof p[1] === 'string' && !!p[0].trim(),
  );
  return pairs.length ? pairs.map(([name, value]) => [name.trim(), value]) : undefined;
}

function resolveAuth(input: unknown): CiServerAuth {
  if (input === 'basic' || input === 'bearer' || input === 'none') return input;
  if (isRecord(input) && str(input.header)) return { header: str(input.header) };
  return 'none';
}

/** A request template from an untrusted payload, or null when it has no usable method and path. */
export function resolveCiRequestTemplate(input: unknown): CiRequestTemplate | null {
  if (!isRecord(input)) return null;
  const method = input.method === 'PUT' ? 'PUT' : input.method === 'POST' ? 'POST' : null;
  if (!method || typeof input.path !== 'string') return null;
  const out: CiRequestTemplate = { method, path: input.path.trim() };
  const query = resolvePairs(input.query);
  if (query) out.query = query;
  const headers = resolvePairs(input.headers);
  if (headers) out.headers = headers;
  const body = input.body;
  if (isRecord(body) && body.type === 'json' && typeof body.template === 'string' && body.template.trim()) {
    out.body = { type: 'json', template: body.template };
  } else if (isRecord(body) && body.type === 'form') {
    out.body = { type: 'form', fields: resolvePairs(body.fields) ?? [] };
  }
  const link = input.link;
  if (isRecord(link)) {
    if (typeof link.pointer === 'string') out.link = { pointer: link.pointer };
    else if (str(link.header)) out.link = { header: str(link.header) };
    else if (typeof link.template === 'string') out.link = { template: link.template.trim() };
  }
  if (typeof input.buildNumber === 'string') out.buildNumber = input.buildNumber;
  return out;
}

/**
 * A CI server target from an untrusted payload, or null when it cannot dispatch:
 * an unknown preset, a missing required field, or a Custom target without a
 * re-run request. A Flake Lab part that cannot dispatch is dropped.
 */
export function resolveCiServerTarget(input: unknown): CiServerTarget | null {
  if (!isRecord(input)) return null;
  const preset = (CI_SERVER_PRESETS as readonly unknown[]).includes(input.preset)
    ? (input.preset as CiServerPreset)
    : null;
  if (!preset) return null;
  const base: Pick<CiServerTarget, 'baseUrl' | 'user'> = {};
  const baseUrl = normalizeCiServerBaseUrl(input.baseUrl);
  if (baseUrl) base.baseUrl = baseUrl;
  const user = str(input.user);
  if (user) base.user = user;

  if (preset === 'custom') {
    const custom = isRecord(input.custom) ? input.custom : null;
    const rerun = resolveCiRequestTemplate(custom?.rerun);
    if (!rerun) return null;
    const flakeLab = resolveCiRequestTemplate(custom?.flakeLab);
    const ref = str(isRecord(input.rerun) ? input.rerun.ref : '');
    return {
      preset,
      ...base,
      rerun: ref ? { ref } : {},
      custom: { auth: resolveAuth(custom?.auth), rerun, ...(flakeLab ? { flakeLab } : {}) },
    };
  }

  const definition = CI_SERVER_PRESET_REGISTRY[preset];
  const rerun = resolveFields(input.rerun, definition.rerunFields);
  if (!rerun || !definition.template(rerun)) return null;
  const flakeLab = input.flakeLab ? resolveFields(input.flakeLab, definition.flakeLabFields) : null;
  return {
    preset,
    ...base,
    rerun,
    ...(flakeLab && definition.template(flakeLab) ? { flakeLab } : {}),
  };
}

/**
 * Why a CI server target from a request cannot be saved, or null when it can:
 * a base URL that is not an http(s) URL, or a target that cannot dispatch.
 */
export function ciServerTargetProblem(input: unknown): string | null {
  const rawBaseUrl = isRecord(input) ? input.baseUrl : undefined;
  const badBaseUrl =
    typeof rawBaseUrl === 'string'
      ? rawBaseUrl.trim() !== '' && !normalizeCiServerBaseUrl(rawBaseUrl)
      : rawBaseUrl != null;
  if (badBaseUrl) return 'The CI server base URL must be an http(s) URL';
  const target = resolveCiServerTarget(input);
  if (!target) {
    return 'The CI server target cannot dispatch: it needs a known preset and its required fields';
  }
  if (sendsFlakeLab(input) && !ciServerRequestTemplate(target, 'flakeLab')) {
    return 'The CI server Flake Lab request cannot dispatch: it needs its required fields';
  }
  return null;
}

/** Whether a payload names a Flake Lab request: a Custom one, or a preset part with a field filled in. */
function sendsFlakeLab(input: unknown): boolean {
  if (!isRecord(input)) return false;
  if (input.preset === 'custom') return isRecord(input.custom) && input.custom.flakeLab != null;
  const part = input.flakeLab;
  return isRecord(part) && Object.values(part).some((value) => typeof value === 'string' && value.trim() !== '');
}

/** The request a target sends for a re-run or a Flake Lab dispatch, and its credential's place; null when it has none. */
export function ciServerRequestTemplate(
  target: CiServerTarget,
  kind: 'rerun' | 'flakeLab',
): { auth: CiServerAuth; template: CiRequestTemplate } | null {
  if (target.preset === 'custom') {
    const template = kind === 'rerun' ? target.custom?.rerun : target.custom?.flakeLab;
    return target.custom && template ? { auth: target.custom.auth, template } : null;
  }
  const definition = CI_SERVER_PRESET_REGISTRY[target.preset];
  const fields = kind === 'rerun' ? target.rerun : target.flakeLab;
  const template = fields ? definition.template(fields) : null;
  return template ? { auth: definition.auth, template } : null;
}

/** The target a preset becomes once customized: a Custom target sending exactly the preset's requests. */
export function customizeCiServerTarget(target: CiServerTarget): CiServerTarget {
  if (target.preset === 'custom') return target;
  const rerun = ciServerRequestTemplate(target, 'rerun');
  const flakeLab = ciServerRequestTemplate(target, 'flakeLab');
  return {
    preset: 'custom',
    ...(target.baseUrl ? { baseUrl: target.baseUrl } : {}),
    ...(target.user ? { user: target.user } : {}),
    rerun: target.rerun.ref ? { ref: target.rerun.ref } : {},
    ...(rerun
      ? {
          custom: {
            auth: rerun.auth,
            rerun: rerun.template,
            ...(flakeLab ? { flakeLab: flakeLab.template } : {}),
          },
        }
      : {}),
  };
}

/** A template that cannot be rendered with these values; its message is shown as the dispatch's error. */
export class CiTemplateError extends Error {}

const PLACEHOLDER = /\{\{\s*([A-Za-z]+)\s*\}\}/g;
const HAS_PLACEHOLDER = /\{\{\s*[A-Za-z]+\s*\}\}/;
const WHOLE_PLACEHOLDER = /^\{\{\s*([A-Za-z]+)\s*\}\}$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** Headers a template may not set: the transport's own, and the credential, which goes through `auth`. */
const FORBIDDEN_HEADERS = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'cookie',
  'authorization',
]);

function placeholderValues(values: CiTemplateValues): Record<CiTemplatePlaceholder, string> {
  return { ...values, branchJob: values.ref ? encodeURIComponent(values.ref) : '' };
}

function valueOf(vars: Record<string, string>, name: string): string {
  if (!(CI_TEMPLATE_PLACEHOLDERS as readonly string[]).includes(name)) {
    throw new CiTemplateError(`Unknown placeholder {{${name}}}`);
  }
  return vars[name] ?? '';
}

function fillText(text: string, vars: Record<string, string>): string {
  return text.replace(PLACEHOLDER, (_, name: string) => valueOf(vars, name));
}

/**
 * A template path filled with these values, relative and without a leading
 * `/`: each placeholder is percent-encoded inside its segment, so `/` cannot
 * add one, and a segment that is empty, `.` or `..` (once decoded) is refused.
 */
function renderPath(path: string, vars: Record<string, string>): string {
  const trimmed = path.replace(/^\/+/, '');
  if (!trimmed) return '';
  const segments = trimmed.split('/');
  return segments
    .map((segment, index) => {
      if (segment === '' && index === segments.length - 1) return '';
      const rendered = segment.replace(PLACEHOLDER, (_, name: string) => {
        const value = valueOf(vars, name);
        if (!value) throw new CiTemplateError(`The path placeholder {{${name}}} is empty`);
        // A server that decodes `%2F` before routing reads the value as segments, which must not climb.
        if (value.split(/[/\\]/).some((part) => part === '.' || part === '..')) {
          throw new CiTemplateError(`The path placeholder {{${name}}} holds a "." or ".." segment`);
        }
        return encodeURIComponent(value);
      });
      if (!rendered || /[?#\\]/.test(rendered)) throw new CiTemplateError(`Invalid path segment "${segment}"`);
      let decoded: string;
      try {
        decoded = decodeURIComponent(rendered);
      } catch {
        throw new CiTemplateError(`Invalid percent-encoding in path segment "${segment}"`);
      }
      if (decoded === '.' || decoded === '..') throw new CiTemplateError('A path segment cannot be "." or ".."');
      return rendered;
    })
    .join('/');
}

/** The URL of a path relative to the base URL, refused when it would leave it. */
function urlUnder(baseUrl: string, path: string, vars: Record<string, string>): URL {
  const base = normalizeCiServerBaseUrl(baseUrl);
  if (!base) throw new CiTemplateError('The CI server base URL is not a valid http(s) URL');
  const { origin, pathname } = new URL(base);
  const url = new URL(`${origin}${pathname}${renderPath(path, vars)}`);
  if (!isUnderBaseUrl(base, url.href)) throw new CiTemplateError('The request URL leaves the CI server base URL');
  return url;
}

function fillJson(node: unknown, vars: Record<string, string>): unknown {
  if (typeof node === 'string') {
    const whole = WHOLE_PLACEHOLDER.exec(node);
    if (whole) return valueOf(vars, whole[1]!);
    if (HAS_PLACEHOLDER.test(node)) throw new CiTemplateError('A JSON placeholder must be a whole string value');
    return node;
  }
  if (Array.isArray(node)) return node.map((item) => fillJson(item, vars));
  if (isRecord(node)) return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, fillJson(v, vars)]));
  return node;
}

/** A request ready to send, without its credential. */
export interface RenderedCiRequest {
  method: 'POST' | 'PUT';
  url: string;
  headers: [string, string][];
  body: { contentType: string; text: string } | null;
}

/** Fill a template with a dispatch's values, each encoded for its place. Throws `CiTemplateError`. */
export function renderCiRequest(
  baseUrl: string,
  template: CiRequestTemplate,
  values: CiTemplateValues,
): RenderedCiRequest {
  const vars = placeholderValues(values);
  const url = urlUnder(baseUrl, template.path, vars);
  for (const [name, value] of template.query ?? []) url.searchParams.append(name, fillText(value, vars));

  const headers: [string, string][] = [];
  for (const [name, value] of template.headers ?? []) {
    if (!HEADER_NAME.test(name)) throw new CiTemplateError(`Invalid header name "${name}"`);
    if (FORBIDDEN_HEADERS.has(name.toLowerCase())) throw new CiTemplateError(`The header ${name} cannot be set`);
    const filled = fillText(value, vars);
    if (/[\r\n\0]/.test(filled)) throw new CiTemplateError(`The header ${name} holds a line break`);
    headers.push([name, filled]);
  }

  let body: RenderedCiRequest['body'] = null;
  if (template.body?.type === 'json') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(template.body.template);
    } catch {
      throw new CiTemplateError('The JSON body template is not valid JSON');
    }
    body = { contentType: 'application/json', text: JSON.stringify(fillJson(parsed, vars)) };
  } else if (template.body?.type === 'form') {
    const form = new URLSearchParams();
    for (const [name, value] of template.body.fields) form.append(name, fillText(value, vars));
    body = { contentType: 'application/x-www-form-urlencoded', text: form.toString() };
  }
  return { method: template.method, url: url.href, headers, body };
}

/** The value at an RFC 6901 JSON pointer, or undefined. */
export function readJsonPointer(document: unknown, pointer: string): unknown {
  if (pointer === '') return document;
  if (!pointer.startsWith('/')) return undefined;
  let node: unknown = document;
  for (const token of pointer.slice(1).split('/')) {
    const key = token.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(node)) node = /^\d+$/.test(key) ? node[Number(key)] : undefined;
    else if (isRecord(node)) node = Object.prototype.hasOwnProperty.call(node, key) ? node[key] : undefined;
    else return undefined;
  }
  return node;
}

/** What a dispatch keeps of the CI server's answer. */
export interface CiServerAnswerFields {
  /** The link to watch: what the answer names, else the template's page, else the base URL. */
  link: string;
  buildNumber: string | null;
}

/**
 * A link read from an answer: an absolute http(s) URL, or a path from the root
 * of the base URL's origin. Anything else (a token, a cookie) is never kept.
 */
const answerLink = (value: string, base: string): string | null => {
  const text = value.trim();
  const absolute = /^https?:\/\//i.test(text);
  if (!absolute && !(text.startsWith('/') && !text.startsWith('//'))) return null;
  try {
    const url = new URL(text, base);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
};

/** The most digits a build number read from an answer may have. */
const BUILD_NUMBER = /^\d{1,20}$/;

/** Read the link and the build number a template names from the CI server's answer. */
export function readCiServerAnswer(
  baseUrl: string,
  template: CiRequestTemplate,
  values: CiTemplateValues,
  answer: { header: (name: string) => string | null; json: unknown },
): CiServerAnswerFields {
  let link: string | null = null;
  const spec = template.link;
  if (spec && 'pointer' in spec) {
    const value = readJsonPointer(answer.json, spec.pointer);
    link = typeof value === 'string' ? answerLink(value, baseUrl) : null;
  } else if (spec && 'header' in spec) {
    const value = answer.header(spec.header);
    link = value ? answerLink(value, baseUrl) : null;
  } else if (spec && 'template' in spec) {
    try {
      link = urlUnder(baseUrl, spec.template, placeholderValues(values)).href;
    } catch {
      link = null;
    }
  }
  let buildNumber: string | null = null;
  if (template.buildNumber != null) {
    const value = readJsonPointer(answer.json, template.buildNumber);
    const text = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
    buildNumber = BUILD_NUMBER.test(text) ? text : null;
  }
  return { link: link ?? normalizeCiServerBaseUrl(baseUrl) ?? baseUrl, buildNumber };
}
