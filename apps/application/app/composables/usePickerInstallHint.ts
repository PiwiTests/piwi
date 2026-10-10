/**
 * Whether to suggest installing Piwi Picker in this browser, and from which
 * store (`pickerStoreFor`). Never in the desktop app's window, where no
 * extension runs; never once Piwi Picker has marked the page
 * (`@piwitests/core/picker-marker`: it marks its connected instance's pages),
 * which is remembered for the visit; never after Don't show again, which this
 * browser remembers (`piwi-picker-hint-dismissed`). Decided once mounted, so
 * the server renders no hint.
 */
import { PICKER_MARKER_ATTRIBUTE, PICKER_MARKER_EVENT } from '@piwitests/core/picker-marker';
import { pickerStoreFor, type PickerStore } from '#shared/companion-links';

const DISMISSED_KEY = 'piwi-picker-hint-dismissed';

export function usePickerInstallHint() {
  const isDesktop = useIsDesktop();
  const dismissed = useLocalStorage(DISMISSED_KEY, false, { initOnMounted: true });
  const marked = useState('piwi-picker-marked', () => false);
  const store = ref<PickerStore | null>(null);

  const onMarked = () => {
    marked.value = true;
  };
  onMounted(() => {
    if (isDesktop) return;
    store.value = pickerStoreFor(navigator.userAgent);
    if (document.documentElement.hasAttribute(PICKER_MARKER_ATTRIBUTE)) marked.value = true;
    // The extension marks the page once its storage answers, which can be after this page looked.
    document.addEventListener(PICKER_MARKER_EVENT, onMarked);
  });
  onBeforeUnmount(() => document.removeEventListener(PICKER_MARKER_EVENT, onMarked));

  return {
    /** The store to suggest, or null when no hint is shown. */
    store: computed(() => (dismissed.value || marked.value ? null : store.value)),
    dismiss: () => {
      dismissed.value = true;
    },
  };
}
