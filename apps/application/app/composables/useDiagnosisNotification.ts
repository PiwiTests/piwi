const STORAGE_KEY = 'piwi-diagnosis-notifications';

/** Whether a finished diagnosis notifies: one value per browser, which every caller shares, and every tab follows. */
let _enabled: Ref<boolean> | null = null;

function sharedEnabled(): Ref<boolean> {
  if (import.meta.server) return ref(true);
  if (!_enabled) {
    const enabled = ref(localStorage.getItem(STORAGE_KEY) !== 'false');
    window.addEventListener('storage', (event) => {
      if (event.key === STORAGE_KEY) enabled.value = event.newValue !== 'false';
    });
    _enabled = enabled;
  }
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
