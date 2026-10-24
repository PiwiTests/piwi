/**
 * Host-side helpers for the DOM-snapshot locator picker.
 *
 * The document assembly (`buildPickerDocument` / `buildReadonlyDocument` and the
 * serialized in-iframe scripts) lives in `#shared/snapshot-picker-document`
 * so the server's `dom-snapshot-frame` endpoint can build the identical document
 * (a `src`-loaded frame escapes the desktop page CSP that blocks a `srcdoc`
 * one). It is re-exported here for call sites importing from
 * `~/utils/snapshot-picker-script`. The only host-only piece — deriving the
 * highlight hints the picker is driven with — stays below.
 */
import type { RankedLocator } from '#shared/locator-healing.types';

export {
  stripNetworkReferences,
  snapshotPickerScriptTag,
  buildPickerDocument,
  buildReadonlyDocument,
} from '#shared/snapshot-picker-document';

/** A text hint the in-iframe picker highlights on open. */
export interface PickerHint {
  text: string;
}

/**
 * Search hints for pre-highlighting the element the failing locator meant to
 * hit: the failing locator's own name/text, then any element-match / ARIA
 * candidate names. Deduped (case-insensitively), trimmed, and capped. Pure so it
 * can be unit-tested; the picker posts the result into the iframe after ready.
 */
export function deriveHighlightHints(input: {
  failingLocator?: { method: string; args: Record<string, unknown> } | null;
  fromElementMatch?: RankedLocator[] | null;
  fromAriaSnapshot?: RankedLocator[] | null;
}): PickerHint[] {
  const out: PickerHint[] = [];
  const seen = new Set<string>();
  const push = (value: unknown): void => {
    if (typeof value !== 'string') return;
    const text = value.trim();
    if (text.length < 2 || text.length > 80) return;
    const key = text.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ text });
  };
  const nameOf = (args: Record<string, unknown> | undefined): unknown =>
    args && (args.name ?? args.text ?? args.label ?? args.placeholder ?? args.alt ?? args.title);

  push(nameOf(input.failingLocator?.args));
  for (const a of input.fromElementMatch ?? []) push(nameOf(a.args));
  for (const a of input.fromAriaSnapshot ?? []) push(nameOf(a.args));
  return out.slice(0, 6);
}
