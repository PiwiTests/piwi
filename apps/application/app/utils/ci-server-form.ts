/**
 * The CI server part of the CI re-run form: the editable state a stored target
 * opens as, the target a save sends, and the request preview the form shows.
 */
import {
  CiTemplateError,
  CI_SERVER_PRESET_REGISTRY,
  ciAuthHeaderProblem,
  ciServerRequestTemplate,
  customizeCiServerTarget,
  isUnderBaseUrl,
  normalizeCiServerBaseUrl,
  renderCiRequest,
  resolveCiServerTarget,
  type CiServerPreset,
  type CiServerTarget,
} from '#shared/ci-server';

/** The fields of the Jenkins preset the form edits, for the re-run and for Flake Lab. */
export interface CiServerPresetFields {
  job: string;
  ref: string;
  argsParameter: string;
  dispatchParameter: string;
}

export interface CiServerFormState {
  preset: CiServerPreset;
  baseUrl: string;
  user: string;
  rerun: CiServerPresetFields;
  flakeLab: CiServerPresetFields;
  /** Custom only: the default branch, and the `custom` block as JSON text (`auth`, `rerun`, `flakeLab`). */
  customRef: string;
  customJson: string;
}

const fields = (input?: Record<string, string>): CiServerPresetFields => ({
  job: input?.job ?? '',
  ref: input?.ref ?? '',
  argsParameter: input?.argsParameter ?? '',
  dispatchParameter: input?.dispatchParameter ?? '',
});

/** The state a stored target opens as; a new form starts on Jenkins. */
export function ciServerFormState(target: CiServerTarget | null | undefined): CiServerFormState {
  return {
    preset: target?.preset ?? 'jenkins',
    baseUrl: target?.baseUrl ?? '',
    user: target?.user ?? '',
    rerun: fields(target?.preset === 'custom' ? undefined : target?.rerun),
    flakeLab: fields(target?.preset === 'custom' ? undefined : target?.flakeLab),
    customRef: target?.preset === 'custom' ? (target.rerun.ref ?? '') : '',
    customJson: target?.custom ? JSON.stringify(target.custom, null, 2) : '',
  };
}

const trimmed = (input: CiServerPresetFields) =>
  Object.fromEntries(Object.entries(input).filter(([, value]) => value.trim()));

/**
 * The target a save sends, or why it cannot be saved: a Jenkins target needs
 * its job, a Custom one a re-run request in valid JSON with a header its
 * credential can go in, and a base URL, when given, must be an http(s) URL.
 * With `instanceUrl` given (null when the instance sets no CI server), a form
 * without a base URL is refused when there is no instance URL to fall back on.
 */
export function ciServerTargetFromForm(
  state: CiServerFormState,
  opts?: { instanceUrl: string | null },
): { target: CiServerTarget; error: null } | { target: null; error: string } {
  if (state.baseUrl.trim() && !normalizeCiServerBaseUrl(state.baseUrl)) {
    return { target: null, error: 'The base URL must be an http(s) URL, without a query.' };
  }
  let custom: unknown;
  if (state.preset === 'custom') {
    try {
      custom = JSON.parse(state.customJson || '{}');
    } catch {
      return { target: null, error: 'The custom request is not valid JSON.' };
    }
  }
  const target = resolveCiServerTarget({
    preset: state.preset,
    baseUrl: state.baseUrl,
    user: state.user,
    rerun: state.preset === 'custom' ? { ref: state.customRef } : trimmed(state.rerun),
    flakeLab: state.preset === 'custom' ? undefined : trimmed(state.flakeLab),
    custom,
  });
  if (!target) {
    return {
      target: null,
      error:
        state.preset === 'custom'
          ? 'The custom request needs a re-run request with a POST or PUT method and a path.'
          : `${CI_SERVER_PRESET_REGISTRY[state.preset].label} needs the job to re-run.`,
    };
  }
  const authProblem = target.custom ? ciAuthHeaderProblem(target.custom.auth) : null;
  if (authProblem) return { target: null, error: `${authProblem}.` };
  if (opts && !target.baseUrl && !opts.instanceUrl) {
    return { target: null, error: 'Set a base URL: the instance has no CI server.' };
  }
  return { target, error: null };
}

/** The form state of a preset turned into Custom, sending the same requests. */
export function customizeCiServerForm(state: CiServerFormState): CiServerFormState {
  const resolved = ciServerTargetFromForm(state);
  if (!resolved.target || resolved.target.preset === 'custom') return state;
  return ciServerFormState(customizeCiServerTarget(resolved.target));
}

/** The values a preview fills a request with, in place of a real dispatch's. */
export const CI_SERVER_PREVIEW_VALUES = {
  args: '"tests/checkout.spec.ts:12" --project="chromium"',
  dispatchId: '0f3a9c2e7b5d4e1a',
  commit: '4e1f2a9',
};

/**
 * Whether the request a dispatch sends carries a credential: `project` for a
 * token typed or stored for this base URL, `instance` for the instance's token
 * (a preset's request under the instance URL, when the instance sets one), or
 * `none`.
 */
export type CiServerPreviewCredential = 'project' | 'instance' | 'none';

export function ciServerPreviewCredential(
  state: CiServerFormState,
  opts: { instanceUrl: string | null; typedToken: boolean; tokenUrl: string | null | undefined },
): CiServerPreviewCredential {
  const baseUrl = normalizeCiServerBaseUrl(state.baseUrl) ?? opts.instanceUrl;
  if (opts.typedToken || ciServerTokenState(baseUrl, opts.tokenUrl) === 'bound') return 'project';
  if (state.preset !== 'custom' && baseUrl && opts.instanceUrl && isUnderBaseUrl(opts.instanceUrl, baseUrl)) {
    return 'instance';
  }
  return 'none';
}

/**
 * The request a dispatch would send, as text with the credential masked, or
 * why it cannot be built. Its headers are set as the server sets them: `Accept`,
 * the body's `Content-Type`, the template's headers, then the credential, each
 * replacing an earlier one of the same name.
 */
export function ciServerRequestPreview(
  state: CiServerFormState,
  kind: 'rerun' | 'flakeLab',
  opts: { instanceUrl: string | null; branch?: string; credential?: CiServerPreviewCredential },
): { text: string; error: null } | { text: null; error: string } {
  const resolved = ciServerTargetFromForm(state, { instanceUrl: opts.instanceUrl });
  if (!resolved.target) return { text: null, error: resolved.error };
  const spec = ciServerRequestTemplate(resolved.target, kind);
  if (!spec) return { text: null, error: 'No Flake Lab request is configured.' };
  const baseUrl = resolved.target.baseUrl ?? opts.instanceUrl;
  if (!baseUrl) return { text: null, error: 'Set a base URL: the instance has no CI server.' };
  const values = {
    ...CI_SERVER_PREVIEW_VALUES,
    args: kind === 'flakeLab' ? 'flake 12' : CI_SERVER_PREVIEW_VALUES.args,
    ref: opts.branch || resolved.target.rerun.ref || 'main',
  };
  try {
    const request = renderCiRequest(baseUrl, spec.template, values);
    const headers: [string, string][] = [];
    const setHeader = (name: string, value: string) => {
      const at = headers.findIndex(([n]) => n.toLowerCase() === name.toLowerCase());
      if (at >= 0) headers.splice(at, 1);
      headers.push([name, value]);
    };
    setHeader('Accept', 'application/json');
    if (request.body) setHeader('Content-Type', request.body.contentType);
    for (const [name, value] of request.headers) setHeader(name, value);
    const credential = opts.credential ?? 'project';
    const authName = spec.auth === 'none' ? null : typeof spec.auth === 'object' ? spec.auth.header : 'Authorization';
    if (authName && credential !== 'none') {
      setHeader(authName, credential === 'instance' ? '•••••••• (the instance token, when it sets one)' : '••••••••');
    }
    const lines = [`${request.method} ${request.url}`, ...headers.map(([name, value]) => `${name}: ${value}`)];
    if (request.body) lines.push('', request.body.text);
    return { text: lines.join('\n'), error: null };
  } catch (e) {
    return { text: null, error: e instanceof CiTemplateError ? e.message : 'The request cannot be built.' };
  }
}

/**
 * What the stored token says about this base URL: none stored, stored for it,
 * or stored for another URL and so not sent.
 */
export function ciServerTokenState(
  baseUrl: string | null,
  tokenUrl: string | null | undefined,
): 'none' | 'bound' | 'elsewhere' {
  if (!tokenUrl) return 'none';
  return baseUrl && isUnderBaseUrl(tokenUrl, baseUrl) ? 'bound' : 'elsewhere';
}
