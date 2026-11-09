/**
 * Clipboard helper shared across components.
 *
 * Wraps VueUse's `useClipboard` (auto-imported via `@vueuse/nuxt`) so call sites
 * don't each re-implement the `copied` flag + reset timer, and adds an optional
 * success toast. Returns `{ copy, copied }` where `copied` flips to `true` for
 * `duration` ms after a successful copy.
 */
export function useCopy(options: { duration?: number } = {}) {
  const {
    copy: rawCopy,
    copied,
    isSupported,
  } = useClipboard({
    copiedDuring: options.duration ?? 2000,
    legacy: true,
  });
  const toast = useToast();

  async function copy(text: string | null | undefined, opts: { toast?: boolean | string } = {}) {
    if (!text) return;
    try {
      await rawCopy(text);
    } catch {
      // Clipboard unavailable (e.g. insecure context without legacy support)
      return;
    }
    if (opts.toast) {
      toast.add({
        title: typeof opts.toast === 'string' ? opts.toast : 'Copied to clipboard',
        icon: 'i-lucide-check',
        color: 'success',
        duration: 2000,
      });
    }
  }

  return { copy, copied, isSupported };
}
