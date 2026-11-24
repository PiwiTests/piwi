<script setup lang="ts">
/**
 * A value of a CI action's target, picked from what the target declares (a
 * workflow, a custom pipeline, a Jenkins job, an input) or typed: a searchable
 * menu while the target lists something, a plain input while it lists nothing
 * or while it is being typed in, so a listing that arrives never takes the
 * focus away. A value the list does not hold stays in the menu, and any name
 * can be typed in its search. Attributes (`aria-label`, `data-testid`) land on
 * the menu or the input.
 */
import type { CiDeclaredItem } from '~/utils/ci-action-form';

const value = defineModel<string>({ required: true });
const props = defineProps<{
  /** What the target declares; null while it lists nothing. */
  items: CiDeclaredItem[] | null;
  placeholder: string;
  loading?: boolean;
  /** Whether the value may be empty, which the menu's clear button sets. */
  optional?: boolean;
}>();

/** Whether the plain input has the focus: it stays until it loses it. */
const typing = ref(false);

const menuItems = computed<CiDeclaredItem[]>(() => {
  const listed = props.items ?? [];
  const current = value.value.trim();
  return current && !listed.some((item) => item.value === current)
    ? [...listed, { label: current, value: current, description: 'Typed' }]
    : listed;
});

function pick(picked: unknown) {
  value.value = typeof picked === 'string' ? picked.trim() : '';
}
</script>

<template>
  <USelectMenu
    v-if="items && !typing"
    :model-value="value || undefined"
    :items="menuItems"
    value-key="value"
    :placeholder="placeholder"
    :loading="loading"
    :clear="optional"
    :search-input="{ placeholder: 'Search, or type a name…' }"
    create-item="always"
    class="w-full font-mono"
    @update:model-value="pick"
    @create="pick"
  >
    <template #create-item-label="{ item }">Use {{ item.trim() }}</template>
  </USelectMenu>
  <UInput
    v-else
    v-model="value"
    :placeholder="placeholder"
    :loading="loading"
    class="w-full font-mono"
    @focus="typing = true"
    @blur="typing = false"
  />
</template>
