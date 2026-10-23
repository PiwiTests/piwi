import type { MarkerCategoryMeta } from '#shared/marker-categories';

/**
 * Tailwind classes for a marker category's color token, written out in full
 * so Tailwind generates them: `text` for an icon, `soft` for a tinted round
 * icon holder (the markers panel list).
 */
export const MARKER_TONE_CLASSES: Record<MarkerCategoryMeta['color'], { text: string; soft: string }> = {
  primary: { text: 'text-primary', soft: 'bg-primary/10 text-primary ring-primary/25' },
  success: { text: 'text-success', soft: 'bg-success/10 text-success ring-success/25' },
  info: { text: 'text-info', soft: 'bg-info/10 text-info ring-info/25' },
  warning: { text: 'text-warning', soft: 'bg-warning/10 text-warning ring-warning/25' },
  error: { text: 'text-error', soft: 'bg-error/10 text-error ring-error/25' },
  neutral: { text: 'text-muted', soft: 'bg-elevated text-muted ring-accented' },
};
