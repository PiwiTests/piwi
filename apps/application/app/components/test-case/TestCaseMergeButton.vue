<script setup lang="ts">
/**
 * Merge another test case of the project into this one: the other one's history (executions, quarantine, clusters,
 * locators, coverage…) moves here and the other one is deleted. It joins the two halves of a renamed or moved test
 * Piwi did not match, for example one renamed before it declared an external ID. Project managers only; refused for
 * two tests that ran in the same run.
 */
import { errorMessage } from '~/utils';
import { testLabel } from '#shared/utils/test-label';

const props = defineProps<{
  testCaseId: number;
  projectId: number;
  /** This test's label, named in the confirmation. */
  label: string;
}>();
const emit = defineEmits<{ merged: [] }>();

const { can } = useAuth();
const allowed = computed(() => can('project:manage', props.projectId));

interface Candidate {
  id: number;
  title: string;
  displayTitle?: string | null;
  externalId?: string | null;
  filePath: string;
  totalRuns: number;
}

const open = ref(false);
const query = ref('');
const candidates = ref<Candidate[]>([]);
const searching = ref(false);
const selected = ref<Candidate | null>(null);
const merging = ref(false);
const toast = useToast();

const search = useDebounceFn(async (q: string) => {
  if (!q.trim()) {
    candidates.value = [];
    return;
  }
  searching.value = true;
  try {
    const page = await $fetch<{ items: Candidate[] }>(`/api/projects/${props.projectId}/test-cases`, {
      query: { q, limit: 10 },
    });
    candidates.value = page.items.filter((c) => c.id !== props.testCaseId);
  } catch {
    candidates.value = [];
  } finally {
    searching.value = false;
  }
}, 250);

watch(query, (q) => {
  selected.value = null;
  void search(q);
});
watch(open, (isOpen) => {
  if (isOpen) return;
  query.value = '';
  candidates.value = [];
  selected.value = null;
});

async function merge() {
  if (!selected.value) return;
  merging.value = true;
  try {
    const result = await $fetch<{ executionsMoved: number }>(`/api/test-cases/${props.testCaseId}/merge`, {
      method: 'POST',
      body: { sourceId: selected.value.id },
    });
    toast.add({
      title: 'Test cases merged',
      description: `${result.executionsMoved} execution${result.executionsMoved === 1 ? '' : 's'} moved to this test.`,
      color: 'success',
    });
    open.value = false;
    emit('merged');
  } catch (error) {
    toast.add({ title: 'Could not merge the test cases', description: errorMessage(error), color: 'error' });
  } finally {
    merging.value = false;
  }
}
</script>

<template>
  <template v-if="allowed">
    <UButton
      size="sm"
      variant="ghost"
      color="neutral"
      icon="i-lucide-merge"
      data-testid="test-case-merge"
      @click="open = true"
    >
      Merge…
    </UButton>
    <UModal v-model:open="open" title="Merge a test case into this one">
      <template #body>
        <div class="space-y-3">
          <p class="text-sm text-muted">
            The history of the test you pick moves to <strong class="text-highlighted">{{ label }}</strong
            >, and that test case is deleted. Use it for a test renamed or moved that Piwi did not match. This cannot be
            undone.
          </p>
          <UInput
            v-model="query"
            icon="i-lucide-search"
            placeholder="Search by title, file or id:…"
            class="w-full"
            :loading="searching"
            autofocus
            data-testid="test-case-merge-search"
          />
          <ul v-if="candidates.length" class="divide-y divide-default rounded-md border border-default">
            <li v-for="c in candidates" :key="c.id">
              <button
                type="button"
                class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-elevated"
                :class="selected?.id === c.id ? 'bg-elevated' : ''"
                :aria-pressed="selected?.id === c.id"
                @click="selected = c"
              >
                <UIcon
                  :name="selected?.id === c.id ? 'i-lucide-circle-check' : 'i-lucide-circle'"
                  class="size-4 shrink-0 text-muted"
                />
                <!-- A plain badge: the row is the button, and the chip would nest a link or a button in it. -->
                <UBadge
                  v-if="c.externalId"
                  color="neutral"
                  variant="subtle"
                  size="xs"
                  class="shrink-0 font-mono tabular-nums"
                  >{{ c.externalId }}</UBadge
                >
                <span class="min-w-0 flex-1 truncate text-highlighted">{{ testLabel(c) }}</span>
                <span class="shrink-0 text-xs text-muted">{{ c.totalRuns }} runs</span>
              </button>
            </li>
          </ul>
          <p v-else-if="query.trim() && !searching" class="text-sm text-muted">No other test matches.</p>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full items-center justify-end gap-3">
          <UButton color="neutral" variant="ghost" :disabled="merging" @click="open = false">Cancel</UButton>
          <UButton
            color="error"
            icon="i-lucide-merge"
            :disabled="!selected"
            :loading="merging"
            data-testid="test-case-merge-confirm"
            @click="merge"
          >
            Merge into this test
          </UButton>
        </div>
      </template>
    </UModal>
  </template>
</template>
