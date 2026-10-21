import { t, type MessageKey } from './i18n.js';
import type { IconName } from './icons.js';

export const COPY_MODES = ['bare', 'action', 'expect'] as const;
export type CopyMode = (typeof COPY_MODES)[number];

const COPY_MODE_KEYS = {
  bare: 'common_copyModeBare',
  action: 'common_copyModeAction',
  expect: 'common_copyModeExpect',
} as const satisfies Record<CopyMode, MessageKey>;

/** The icon of a copy mode's button. */
export const COPY_MODE_ICONS: Record<CopyMode, IconName> = { bare: 'code', action: 'pointer', expect: 'check-circle' };

/** The label of a copy mode's button, in the interface language. */
export function copyModeLabel(mode: CopyMode): string {
  return t(COPY_MODE_KEYS[mode]);
}

/** Render a locator string as source in the requested copy mode. Takes just `{ locator }` (not the full `RankedLocator`) since that's the only field this ever reads — any locator-bearing candidate can reuse this, ranked or not. */
export function renderCopyMode(locator: { locator: string }, mode: CopyMode): string {
  switch (mode) {
    case 'bare':
      return `page.${locator.locator}`;
    case 'action':
      return `await page.${locator.locator}.click();`;
    case 'expect':
      return `await expect(page.${locator.locator}).toBeVisible();`;
  }
}
