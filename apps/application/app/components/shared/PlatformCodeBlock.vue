<script setup lang="ts">
/**
 * A code block with a Linux/macOS ↔ Windows toggle, for commands shown to a
 * user where the two shells can differ. Each form keeps its own copy button
 * (the inner CodeBlock), so a reader copies exactly the platform they picked.
 */
const props = defineProps<{
  bash: string;
  powershell: string;
  /** Remember the reader's pick across blocks on the page. */
  storageKey?: string;
}>();

type Shell = 'bash' | 'powershell';
// The command shell's key shares one value with every copy button of the page (`useCommandShell`).
const shared = props.storageKey === COMMAND_SHELL_KEY ? useCommandShell() : null;
const own = ref<Shell>('bash');
const shell = computed<Shell>(() => shared?.shell.value ?? own.value);

// A per-viewer convenience only; never fails the render when storage is blocked.
onMounted(() => {
  if (shared) return;
  let saved: string | null = null;
  try {
    saved = props.storageKey ? localStorage.getItem(props.storageKey) : null;
  } catch {
    // Ignore — private windows and blocked storage both leave the computer's shell.
  }
  own.value = saved === 'bash' || saved === 'powershell' ? saved : viewerShell();
});

function pick(next: Shell) {
  if (shared) {
    shared.pick(next);
    return;
  }
  own.value = next;
  if (!props.storageKey) return;
  try {
    localStorage.setItem(props.storageKey, next);
  } catch {
    // Ignore — the choice still applies for this view.
  }
}

const code = computed(() => (shell.value === 'bash' ? props.bash : props.powershell));
const lang = computed(() => (shell.value === 'bash' ? 'bash' : 'powershell'));
</script>

<template>
  <div class="space-y-1.5">
    <div class="flex items-center gap-1" role="tablist" aria-label="Shell">
      <UButton
        size="xs"
        :color="shell === 'bash' ? 'primary' : 'neutral'"
        :variant="shell === 'bash' ? 'subtle' : 'ghost'"
        role="tab"
        :aria-selected="shell === 'bash'"
        @click="pick('bash')"
      >
        Linux / macOS
      </UButton>
      <UButton
        size="xs"
        :color="shell === 'powershell' ? 'primary' : 'neutral'"
        :variant="shell === 'powershell' ? 'subtle' : 'ghost'"
        role="tab"
        :aria-selected="shell === 'powershell'"
        @click="pick('powershell')"
      >
        Windows (PowerShell)
      </UButton>
    </div>
    <CodeBlock :code="code" :lang="lang" />
  </div>
</template>
