/**
 * Extended clipboard helper that writes both text/plain and text/html simultaneously.
 * Rich-text editors (Slack, Jira, Notion, Google Docs) use the HTML format; plain
 * text contexts get the clean fallback. Where the rich clipboard is unavailable
 * (an instance served over plain HTTP, an older browser) it copies the plain text
 * through `useCopy`, which falls back to the legacy copy command.
 */
export function useCopyRich(options: { duration?: number } = {}) {
  const { copy, copied: plainCopied } = useCopy(options);
  const richCopied = ref(false);
  const copied = computed(() => richCopied.value || plainCopied.value);
  const toast = useToast();
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function copyRich(plain: string, html: string, opts: { toast?: boolean | string } = {}) {
    if (!(await writeRich(plain, html))) {
      await copy(plain, opts);
      return;
    }
    richCopied.value = true;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      richCopied.value = false;
      timer = null;
    }, options.duration ?? 2000);
    if (opts.toast) {
      toast.add({
        title: typeof opts.toast === 'string' ? opts.toast : 'Copied to clipboard',
        icon: 'i-lucide-check',
        color: 'success',
        duration: 2000,
      });
    }
  }

  return { copyRich, copied };
}

/** Write both formats with the async clipboard; false when it is missing or refuses. */
async function writeRich(plain: string, html: string): Promise<boolean> {
  if (typeof ClipboardItem === 'undefined' || typeof navigator === 'undefined' || !navigator.clipboard?.write) {
    return false;
  }
  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/plain': new Blob([plain], { type: 'text/plain' }),
        'text/html': new Blob([html], { type: 'text/html' }),
      }),
    ]);
    return true;
  } catch {
    return false;
  }
}
