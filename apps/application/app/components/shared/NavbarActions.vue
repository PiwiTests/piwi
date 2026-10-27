<script setup lang="ts">
/**
 * Responsive action row for `UDashboardNavbar` `#right` slots. Renders each
 * action as a `UButton` whose text label collapses below the `xl` breakpoint
 * (icon-only, `aria-label`/`title` preserved), so page actions never crowd
 * the breadcrumb on phones. Extra custom controls can be placed in the
 * `leading` (before) and default (after) slots.
 */
export interface NavbarAction {
  label: string;
  icon: string;
  color?: 'primary' | 'secondary' | 'success' | 'info' | 'warning' | 'error' | 'neutral';
  variant?: 'solid' | 'outline' | 'soft' | 'subtle' | 'ghost' | 'link';
  /** Hover/name detail shown in the `title` attribute (defaults to `label`). */
  title?: string;
  to?: string;
  loading?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  /** Extra attributes for the button, such as the `'data-tour'` of a guide anchor. */
  attrs?: Record<string, string>;
}

withDefaults(
  defineProps<{
    actions: NavbarAction[];
    /** Button size, defaults to the navbar-standard `md`. */
    size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  }>(),
  { size: 'md' },
);
</script>

<template>
  <div class="flex items-center gap-1.5">
    <slot name="leading" />
    <UButton
      v-for="action in actions"
      :key="action.label"
      v-bind="action.attrs"
      :icon="action.icon"
      :size="size"
      :color="action.color"
      :variant="action.variant"
      :to="action.to"
      :loading="action.loading"
      :disabled="action.disabled"
      :aria-label="action.label"
      :title="action.title ?? action.label"
      @click="action.onClick?.()"
    >
      <span class="hidden xl:inline">{{ action.label }}</span>
    </UButton>
    <slot />
  </div>
</template>
