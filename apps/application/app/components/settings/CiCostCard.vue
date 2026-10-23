<script setup lang="ts">
import { formatMoney, type ResolvedCiCost } from '#shared/ci-cost';

const toast = useToast();
const { data: settings } = await useFetch<ResolvedCiCost>('/api/settings/ci-cost');

const saving = ref(false);
const amount = ref<number | null>(null);
const currency = ref('USD');

watchEffect(() => {
  const cost = settings.value?.cost;
  amount.value = cost?.amount ?? null;
  currency.value = cost?.currency ?? 'USD';
});

const envManaged = computed(() => Boolean(settings.value?.envManaged));

/** One hour of wasted CI time at the entered price, as a sanity check next to the field. */
const example = computed(() => {
  if (!amount.value || amount.value <= 0 || !/^[A-Za-z]{3}$/.test(currency.value)) return null;
  return `An hour of wasted CI time costs ${formatMoney(amount.value * 60, currency.value.toUpperCase())}.`;
});

async function put(cost: { amount: number; currency: string } | null, done: string) {
  saving.value = true;
  try {
    settings.value = await $fetch<ResolvedCiCost>('/api/settings/ci-cost', { method: 'PUT', body: { cost } });
    toast.add({ title: done, color: 'success' });
  } catch (error: unknown) {
    toast.add({ title: 'Save failed', description: errorMessage(error), color: 'error' });
  } finally {
    saving.value = false;
  }
}

function save() {
  if (!amount.value || amount.value <= 0) {
    toast.add({ title: 'Enter an amount above zero, or clear the cost', color: 'error' });
    return;
  }
  void put({ amount: amount.value, currency: currency.value.trim().toUpperCase() }, 'Cost of a CI minute saved');
}
</script>

<template>
  <SectionCard icon="i-lucide-coins" title="Cost of a CI minute" help="settings.ci-cost" data-tour="ci-minute-cost">
    <template #subtitle>
      Wasted CI time is shown as money next to the minutes wherever it appears once a cost is set.
    </template>

    <EnvManagedAlert v-if="envManaged" :env-vars="['PIWI_CI_MINUTE_COST']" class="mb-4" />

    <div class="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
      <SettingsField label="Amount per minute" help="settings.ci-cost" :env-managed="envManaged">
        <UInput
          v-model.number="amount"
          type="number"
          min="0"
          step="0.001"
          placeholder="0.008"
          class="w-full"
          data-testid="ci-cost-amount"
        />
      </SettingsField>
      <SettingsField label="Currency" description="ISO 4217 code, such as USD or EUR." :env-managed="envManaged">
        <UInput v-model="currency" maxlength="3" placeholder="USD" class="w-full" data-testid="ci-cost-currency" />
      </SettingsField>
    </div>
    <p v-if="example" class="mt-3 text-xs text-muted">{{ example }}</p>

    <template #footer>
      <div class="flex items-center justify-end gap-2">
        <UButton
          variant="ghost"
          color="neutral"
          :disabled="saving || envManaged || !settings?.cost"
          label="Clear"
          @click="put(null, 'Cost of a CI minute cleared')"
        />
        <UButton color="primary" :loading="saving" :disabled="envManaged" icon="i-lucide-save" @click="save">
          Save
        </UButton>
      </div>
    </template>
  </SectionCard>
</template>
