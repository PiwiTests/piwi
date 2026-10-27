import { IDE_CHROME_GLOBAL, IDE_SETTINGS_KEY, type IdeRecorderSettings } from '@piwitests/core/ide-recorder';

/**
 * Whether this bundle is the IDE bundle, `record-ide.js`: the recorder built a
 * second time for the pages of a browser the editor service launched, set by
 * `scripts/build.mjs` (`buildIdeBundle`). False in every bundle of the
 * extension.
 */
declare const __PIWI_IDE__: boolean | undefined;

export const IDE_BUILD: boolean = typeof __PIWI_IDE__ === 'boolean' && __PIWI_IDE__;

/**
 * Whether the IDE bundle's host installed its `chrome` (`src/ide/host.ts`),
 * which it does only over the binding of the editor service's launcher.
 */
export function ideHostInstalled(): boolean {
  return IDE_CHROME_GLOBAL in globalThis;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** What the launcher hands the recorder under {@link IDE_SETTINGS_KEY} in `chrome.storage.local`, read field by field. */
export async function getIdeSettings(): Promise<IdeRecorderSettings> {
  const stored = (await chrome.storage.local.get(IDE_SETTINGS_KEY))[IDE_SETTINGS_KEY] as
    | Partial<Record<keyof IdeRecorderSettings, unknown>>
    | undefined;
  return {
    file: text(stored?.file),
    testIdAttribute: text(stored?.testIdAttribute),
    ...(stored?.check === true ? { check: true } : {}),
  };
}
