<script setup lang="ts">
/**
 * Localization — how dates and times are formatted and which time zone they
 * show in. Two layers on one page:
 *
 *  - "Your format" (every viewer): a per-browser override, applied live as it
 *    changes. It wins over the instance default for this browser only.
 *  - "Instance default" (administrators): the format everyone gets who has not
 *    set their own, stored server-side. Locked when a PIWI_LOCALE / PIWI_TIME_ZONE
 *    env var pins it.
 */
import { FOLLOW_SYSTEM } from '#shared/i18n/locale-format';
import { pageEnvVars, getSettingsPage } from '~/utils/settings-metadata';

const { canSeeAdmin } = useAuth();
const toast = useToast();

const {
  instance,
  userLocale,
  userTimeZone,
  effectiveLocale,
  effectiveTimeZone,
  supportedLocales,
  timeZoneOptions,
  refreshInstance,
  saveInstance,
  preview,
} = useLocaleSettings();

// The env-managed flags come from the server; keep them current on the page.
onMounted(() => void refreshInstance());

const envVars = pageEnvVars(getSettingsPage('localization'));

// ── Your format (per-browser) ──────────────────────────────────────────────
const followLabel = computed(
  () => `Follow the instance default (${preview(instance.value.locale, instance.value.timeZone)})`,
);
const userLocaleItems = computed(() => [
  { value: FOLLOW_SYSTEM, label: followLabel.value },
  ...supportedLocales.map((o) => ({ value: o.value, label: o.label })),
]);
const userTimeZoneItems = computed(() => [{ value: FOLLOW_SYSTEM, label: followLabel.value }, ...timeZoneOptions]);
const yourPreview = computed(() => preview(effectiveLocale.value, effectiveTimeZone.value));

// A mutable copy: SUPPORTED_LOCALES is readonly, which USelect's items prop rejects.
const localeItems = computed(() => supportedLocales.map((o) => ({ value: o.value, label: o.label })));

function resetMine() {
  userLocale.value = FOLLOW_SYSTEM;
  userTimeZone.value = FOLLOW_SYSTEM;
  toast.add({ title: 'Using the instance default', color: 'success' });
}

// ── Instance default (admin) ───────────────────────────────────────────────
const localeEnvManaged = computed(() => instance.value.localeEnvManaged);
const timeZoneEnvManaged = computed(() => instance.value.timeZoneEnvManaged);
const anyEnvManaged = computed(() => localeEnvManaged.value || timeZoneEnvManaged.value);

const draftLocale = ref(instance.value.locale);
const draftTimeZone = ref(instance.value.timeZone);
watchEffect(() => {
  draftLocale.value = instance.value.locale;
  draftTimeZone.value = instance.value.timeZone;
});
const instancePreview = computed(() => preview(draftLocale.value, draftTimeZone.value));
const saving = ref(false);

async function saveDefault() {
  saving.value = true;
  try {
    await saveInstance({
      locale: localeEnvManaged.value ? undefined : draftLocale.value,
      timeZone: timeZoneEnvManaged.value ? undefined : draftTimeZone.value,
    });
    toast.add({ title: 'Instance default saved', color: 'success' });
  } catch (error: unknown) {
    toast.add({ title: 'Save failed', description: errorMessage(error), color: 'error' });
  } finally {
    saving.value = false;
  }
}

async function resetDefault() {
  saving.value = true;
  try {
    await saveInstance({
      locale: localeEnvManaged.value ? undefined : null,
      timeZone: timeZoneEnvManaged.value ? undefined : null,
    });
    toast.add({ title: 'Reset to the built-in default', color: 'success' });
  } catch (error: unknown) {
    toast.add({ title: 'Reset failed', description: errorMessage(error), color: 'error' });
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="space-y-6" data-shot="localization-settings" data-tour="localization-page">
    <SectionCard icon="i-lucide-user-round" title="Your format" help="settings.locale">
      <template #subtitle>
        Choose how dates and times look <strong>for you</strong>, saved in this browser. This overrides the instance
        default for you only, and applies as soon as you pick it.
      </template>

      <div class="space-y-4">
        <SettingsField
          label="Date & time format"
          help="settings.locale"
          description="The locale that decides day/month order and 12-hour vs 24-hour time."
          data-tour="localization-format"
        >
          <USelect v-model="userLocale" :items="userLocaleItems" value-key="value" class="w-full max-w-md" />
        </SettingsField>

        <SettingsField
          label="Time zone"
          help="settings.time-zone"
          description="The zone times are shown in. Automatic uses this browser's own time zone."
          data-tour="localization-time-zone"
        >
          <USelectMenu
            v-model="userTimeZone"
            :items="userTimeZoneItems"
            value-key="value"
            class="w-full max-w-md"
            :search-input="{ placeholder: 'Search time zones…' }"
          />
        </SettingsField>

        <p class="text-sm text-highlighted">
          Preview: <span class="font-mono">{{ yourPreview }}</span>
        </p>
      </div>

      <template #footer>
        <div class="flex justify-end">
          <UButton
            variant="ghost"
            color="neutral"
            icon="i-lucide-rotate-ccw"
            label="Use system default"
            @click="resetMine"
          />
        </div>
      </template>
    </SectionCard>

    <SectionCard
      v-if="canSeeAdmin"
      icon="i-lucide-building-2"
      title="Instance default"
      help="settings.locale"
      data-tour="localization-instance-default"
    >
      <template #subtitle>
        The format applied to everyone who has not chosen their own. Each viewer can still override it above.
      </template>

      <div class="space-y-4">
        <EnvManagedAlert v-if="anyEnvManaged" :env-vars="envVars" />

        <SettingsField
          label="Default date & time format"
          help="settings.locale"
          :env-managed="localeEnvManaged"
          description="The locale new viewers get until they pick their own."
        >
          <USelect
            v-model="draftLocale"
            :items="localeItems"
            value-key="value"
            :disabled="localeEnvManaged"
            class="w-full max-w-md"
          />
        </SettingsField>

        <SettingsField
          label="Default time zone"
          help="settings.time-zone"
          :env-managed="timeZoneEnvManaged"
          description="Automatic shows each viewer their own browser time zone."
        >
          <USelectMenu
            v-model="draftTimeZone"
            :items="timeZoneOptions"
            value-key="value"
            :disabled="timeZoneEnvManaged"
            class="w-full max-w-md"
            :search-input="{ placeholder: 'Search time zones…' }"
          />
        </SettingsField>

        <p class="text-sm text-highlighted">
          Preview: <span class="font-mono">{{ instancePreview }}</span>
        </p>
      </div>

      <template #footer>
        <div class="flex items-center gap-2 justify-end">
          <UButton
            variant="ghost"
            color="neutral"
            :disabled="saving || anyEnvManaged"
            label="Reset to defaults"
            @click="resetDefault"
          />
          <UButton
            color="primary"
            icon="i-lucide-save"
            :loading="saving"
            :disabled="anyEnvManaged"
            label="Save"
            @click="saveDefault"
          />
        </div>
      </template>
    </SectionCard>
  </div>
</template>
