<script setup lang="ts">
import type { DropdownMenuItem } from '@nuxt/ui';
import {
  DESKTOP_DOWNLOAD_URL,
  JETBRAINS_PLUGIN_URL,
  PICKER_CHROME_URL,
  PICKER_FIREFOX_URL,
  REPORTER_NPM_URL,
  VSCODE_EXTENSION_URL,
} from '#shared/companion-links';
import { DOCS_BASE_URL } from '#shared/docs';

defineProps<{
  collapsed?: boolean;
}>();

const colorMode = useColorMode();
const themeColors = useThemeColors();
const config = useRuntimeConfig();
const { authState, logout } = useAuth();
const settingsNav = await useSettingsNav();
const { openSettings: openIdeSettings } = useOpenInIde();
const isDesktop = useIsDesktop();

// Tailwind's own `neutral` palette lives under `--color-old-neutral-*`: Nuxt UI
// points `--color-neutral-*` at the active gray scale.
function chipColor(color: string): string {
  return color === 'neutral' ? 'old-neutral' : color;
}

function colorLabel(color: string): string {
  return color.charAt(0).toUpperCase() + color.slice(1);
}

const appearances = [
  { label: 'System', icon: 'i-lucide-monitor', preference: 'system' },
  { label: 'Light', icon: 'i-lucide-sun', preference: 'light' },
  { label: 'Dark', icon: 'i-lucide-moon', preference: 'dark' },
];

const user = computed(() => {
  if (config.public.authEnabled && authState.value.authenticated && authState.value.user) {
    const avatarUrl = authState.value.user.avatarUrl;
    return {
      name: authState.value.user.name || authState.value.user.username,
      icon: avatarUrl ? undefined : 'i-lucide-user',
      avatar: avatarUrl ? { src: avatarUrl } : undefined,
      role: authState.value.user.role,
    };
  }
  return {
    name: 'Configuration',
    icon: 'i-lucide-cog',
  };
});

const items = computed<DropdownMenuItem[][]>(() => {
  // Every viewer gets the settings pages they can open — `useSettingsNav`
  // already drops the admin-only ones, so a Member still reaches Account,
  // API keys, Notifications… Nav items are reused as dropdown items (both are
  // link items); the cast bridges the slightly different `type` union between
  // the two Nuxt UI types. `settingsNav` is grouped into sections — this menu
  // wants one flat list.
  const configurationMenuItems = settingsNav.value.flat() as unknown as DropdownMenuItem[];

  const baseItems: DropdownMenuItem[][] = [
    configurationMenuItems,
    [
      {
        label: 'Theme',
        icon: 'i-lucide-palette',
        ui: { content: 'w-auto' },
        children: [
          {
            label: 'Accent color',
            description: 'Buttons, links, highlights',
            slot: 'chip',
            chip: themeColors.accent.value,
            content: {
              align: 'center',
              collisionPadding: 16,
            },
            children: ACCENT_COLORS.map((color) => ({
              label: colorLabel(color),
              chip: color,
              slot: 'chip',
              checked: themeColors.accent.value === color,
              type: 'checkbox',
              onSelect: (e: Event) => {
                e.preventDefault();
                themeColors.setAccent(color);
              },
            })),
          },
          {
            label: 'Gray tone',
            description: 'Backgrounds, borders, text',
            slot: 'chip',
            chip: chipColor(themeColors.gray.value),
            content: {
              align: 'end',
              collisionPadding: 16,
            },
            children: GRAY_COLORS.map((color) => ({
              label: colorLabel(color),
              chip: chipColor(color),
              slot: 'chip',
              type: 'checkbox',
              checked: themeColors.gray.value === color,
              onSelect: (e: Event) => {
                e.preventDefault();
                themeColors.setGray(color);
              },
            })),
          },
        ],
      },
      {
        label: 'Appearance',
        icon: 'i-lucide-sun-moon',
        children: appearances.map(({ label, icon, preference }) => ({
          label,
          icon,
          type: 'checkbox',
          checked: colorMode.preference === preference,
          onSelect: (e: Event) => {
            e.preventDefault();
            colorMode.preference = preference;
          },
        })),
      },
      {
        label: 'Open in IDE…',
        icon: 'i-lucide-external-link',
        onSelect: (e: Event) => {
          e.preventDefault();
          openIdeSettings();
        },
      },
    ],
    [
      {
        // The tools that install outside the dashboard, for every user: the
        // Setup page's companion-tools card is for admins only.
        label: 'Piwi tools',
        icon: 'i-lucide-blocks',
        ui: { content: 'w-80' },
        children: [
          [
            {
              label: 'Piwi Picker for Chrome and Edge',
              description: 'Browser extension · Chrome Web Store',
              icon: 'i-lucide-mouse-pointer-click',
              to: PICKER_CHROME_URL,
              target: '_blank',
            },
            {
              label: 'Piwi Picker for Firefox',
              description: 'Browser extension · Firefox Add-ons',
              icon: 'i-lucide-mouse-pointer-click',
              to: PICKER_FIREFOX_URL,
              target: '_blank',
            },
            {
              label: 'Piwi for VS Code',
              description: 'Extension · Visual Studio Marketplace',
              icon: 'i-lucide-puzzle',
              to: VSCODE_EXTENSION_URL,
              target: '_blank',
            },
            {
              label: 'Piwi for JetBrains IDEs',
              description: 'IDE plugin · JetBrains Marketplace',
              icon: 'i-lucide-puzzle',
              to: JETBRAINS_PLUGIN_URL,
              target: '_blank',
            },
            ...(isDesktop
              ? []
              : [
                  {
                    label: 'Desktop app',
                    description: 'Installers · GitHub Releases',
                    icon: 'i-lucide-monitor',
                    to: DESKTOP_DOWNLOAD_URL,
                    target: '_blank',
                  },
                ]),
            {
              label: 'Playwright reporter',
              description: '@piwitests/reporter · npm',
              icon: 'i-lucide-package',
              to: REPORTER_NPM_URL,
              target: '_blank',
            },
          ],
          [
            {
              label: 'Documentation',
              icon: 'i-lucide-book-open',
              to: DOCS_BASE_URL,
              target: '_blank',
            },
          ],
        ],
      },
      {
        label: 'GitHub repository',
        icon: 'i-lucide-github',
        to: 'https://github.com/piwitests/platform',
        target: '_blank',
      },
    ],
  ];

  // Add logout button if authenticated (demo identities are switched via the
  // banner's "Acting as" picker, so there is no real session to log out of).
  if (config.public.authEnabled && authState.value.authenticated && !config.public.demoMode) {
    baseItems.push([
      {
        label: 'Logout',
        icon: 'i-lucide-log-out',
        onSelect: async (e: Event) => {
          e.preventDefault();
          await logout();
        },
      },
    ]);
  }

  return baseItems;
});
</script>

<template>
  <UDropdownMenu
    :items="items"
    :content="{ align: 'center', collisionPadding: 12 }"
    :ui="{ content: collapsed ? 'w-48' : 'w-(--reka-dropdown-menu-trigger-width)' }"
  >
    <UButton
      data-shot="user-menu"
      v-bind="{
        ...user,
        label: collapsed ? undefined : user?.name,
        trailingIcon: collapsed ? undefined : 'i-lucide-chevrons-up-down',
      }"
      color="neutral"
      variant="ghost"
      block
      :square="collapsed"
      class="data-[state=open]:bg-elevated"
      :ui="{
        trailingIcon: 'text-dimmed',
      }"
    />

    <template #chip-leading="{ item }">
      <div class="inline-flex items-center justify-center shrink-0 size-5">
        <span
          class="rounded-full ring ring-bg bg-(--chip-light) dark:bg-(--chip-dark) size-2"
          :style="{
            '--chip-light': `var(--color-${(item as any).chip}-500)`,
            '--chip-dark': `var(--color-${(item as any).chip}-400)`,
          }"
        />
      </div>
    </template>
  </UDropdownMenu>
</template>
