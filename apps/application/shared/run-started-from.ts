import { parseRunInteractive, RUN_INTERACTIVE_METADATA_KEY, RUN_ORIGIN_KINDS } from '@piwitests/core/wire';
import { runOrigin, type RunOriginRead } from '#shared/run-eligibility';

/** Where a run of each origin started, as the run page's header says it after "Started from". */
const STARTED_FROM: Record<RunOriginRead, string | null> = {
  ci: 'CI',
  'ci-rerun': 'a re-run in CI',
  local: 'a developer’s machine',
  desktop: 'the desktop app',
  editor: 'an editor',
  preflight: 'piwi preflight',
  bug: 'piwi bug',
  'flake-lab': 'Flake Lab',
  probe: 'a probe',
  bisect: 'a bisect',
  reproduce: 'a reproduction',
  import: 'an import',
  other: null,
};

/**
 * Where a run started and the tool that steers it, from its metadata, as the run page's header names them after
 * "Started from": `CI`, `VS Code`, `a developer’s machine, steered in IntelliJ IDEA`, `the desktop app`. The steering
 * tool is the editor a run's workers report to (`piwiInteractive.client`), named when the run says its name. Null for
 * an origin of a newer reporter.
 */
export function runStartedFrom(metadata: unknown): string | null {
  const origin = runOrigin(metadata);
  const meta = metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>) : null;
  const client = parseRunInteractive(meta?.[RUN_INTERACTIVE_METADATA_KEY])?.client ?? null;
  // A launcher's kind (`desktop`, `editor`) names no tool beyond the origin.
  const tool = client && !(RUN_ORIGIN_KINDS as readonly string[]).includes(client) ? client : null;
  if (origin === 'editor') return tool ?? STARTED_FROM.editor;
  const from = STARTED_FROM[origin];
  if (!from) return null;
  return tool ? `${from}, steered in ${tool}` : from;
}
