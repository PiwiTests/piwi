const STORAGE_KEY = 'piwi-diagnosis-notifications';

/** Whether a finished diagnosis notifies: one value per browser, which every caller shares. */
let _enabled: Ref<boolean> | null = null;

function sharedEnabled(): Ref<boolean> {
  if (import.meta.server) return ref(true);
  _enabled ??= ref(localStorage.getItem(STORAGE_KEY) !== 'false');
  return _enabled;
}

export function useDiagnosisNotification() {
  const permission = ref<NotificationPermission>('default');

  const enabled = sharedEnabled();

  if (import.meta.client) {
    if ('Notification' in window) {
      permission.value = Notification.permission;
    }
  }

  const supported = computed(() => import.meta.client && 'Notification' in window);

  const active = computed(() => supported.value && permission.value === 'granted' && enabled.value);

  async function requestPermission() {
    if (!supported.value) return;
    const result = await Notification.requestPermission();
    permission.value = result;
  }

  function toggleEnabled() {
    enabled.value = !enabled.value;
    localStorage.setItem(STORAGE_KEY, String(enabled.value));
  }

  return { permission, supported, enabled, active, requestPermission, toggleEnabled };
}
