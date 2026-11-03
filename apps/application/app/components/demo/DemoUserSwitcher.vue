<script setup lang="ts">
/**
 * The demo banner's "Acting as" picker: every seeded persona, administrators
 * first, each with what it can do. Picking one reloads the demo as that user
 * (`setDemoUser`). On load it takes the persona's live access, which the
 * demo's access screens may have changed (`refreshDemoAccess`).
 */
import type { DropdownMenuItem } from '@nuxt/ui';
import { InstanceRole } from '#shared/permissions';

const { demoUsers, currentDemoUserId, setDemoUser, refreshDemoAccess } = useAuth();

// The seeded access until the in-browser database answers with the live one.
onMounted(refreshDemoAccess);

const current = computed(() => demoUsers.find((u) => u.id === currentDemoUserId.value) ?? demoUsers[0]);
/** The persona's name without the role in parentheses, which a phone's banner has no room for. */
const shortName = computed(() => current.value?.name.replace(/\s*\(.*\)$/, ''));

function personaItem(u: (typeof demoUsers)[number]): DropdownMenuItem {
  return {
    label: u.label,
    description: u.description,
    icon: u.instanceRole === InstanceRole.ADMINISTRATOR ? 'i-lucide-shield' : 'i-lucide-user',
    // A checkbox item, so the active identity is marked.
    type: 'checkbox',
    checked: u.id === currentDemoUserId.value,
    onSelect: (e: Event) => {
      e.preventDefault();
      if (u.id !== currentDemoUserId.value) setDemoUser(u.id);
    },
  };
}

const items = computed<DropdownMenuItem[][]>(() =>
  [InstanceRole.ADMINISTRATOR, InstanceRole.MEMBER]
    .map((role) => demoUsers.filter((u) => u.instanceRole === role).map(personaItem))
    .filter((group) => group.length > 0),
);
</script>

<template>
  <!-- Above the demo banner (z-index 60), which wraps under the menu on a phone. -->
  <UDropdownMenu
    :items="items"
    :content="{ align: 'end', collisionPadding: 12 }"
    :ui="{ content: 'w-80 z-[70]', itemDescription: 'whitespace-normal' }"
  >
    <UButton
      color="warning"
      variant="soft"
      size="xs"
      data-tour="demo-personas"
      icon="i-lucide-user-round-cog"
      trailing-icon="i-lucide-chevrons-up-down"
      :aria-label="`Acting as: ${current?.name}`"
      :title="`Switch demo user — currently ${current?.name}: ${current?.description}`"
      :ui="{ leadingIcon: 'max-sm:hidden' }"
    >
      <span class="sm:hidden">{{ shortName }}</span>
      <span class="max-sm:hidden">Acting as: {{ current?.name }}</span>
    </UButton>
  </UDropdownMenu>
</template>
