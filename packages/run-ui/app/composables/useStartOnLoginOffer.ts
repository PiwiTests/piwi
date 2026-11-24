/**
 * The offer to turn on Start on login, made once the app has just connected to a team instance (the sign-in on the
 * instance's page went through) while Start on login is off: an app that does not run cannot take the instance's
 * requests, and one that starts with the computer can. The offer is the window's until it closes: **Not now** drops
 * it, and turning the setting on anywhere (the offer, the settings, the tray) ends it. The shell keeps the setting.
 */
interface StartOnLoginSettings {
  start_on_login?: boolean;
}

export function useStartOnLoginOffer() {
  /** Whether the offer shows. */
  const offered = useState('desktop-start-on-login-offer', () => false);
  const busy = useState('desktop-start-on-login-busy', () => false);
  const toast = useToast();
  const { t } = useRunUiWords();

  /** Start on login as the shell has it, or null when the shell cannot say. */
  async function startsOnLogin(): Promise<boolean | null> {
    const settings = await tauriCore()
      ?.invoke<StartOnLoginSettings>('desktop_get_service_settings')
      .catch(() => null);
    return typeof settings?.start_on_login === 'boolean' ? settings.start_on_login : null;
  }

  /** Makes the offer when Start on login is off; a shell that cannot say makes none. */
  async function offerIfOff(): Promise<void> {
    if ((await startsOnLogin()) === false) offered.value = true;
  }

  /** Drops the offer once Start on login is on, turned on while no view showed the offer. */
  async function dismissIfOn(): Promise<void> {
    if (await startsOnLogin()) offered.value = false;
  }

  /** Turns Start on login on, then drops the offer; a refusal says why in a notification, in the host's words. */
  async function turnOn(): Promise<void> {
    const core = tauriCore();
    if (!core || busy.value) return;
    busy.value = true;
    try {
      await core.invoke('desktop_set_start_on_login', { enabled: true });
      offered.value = false;
    } catch (error) {
      const description =
        typeof error === 'string' && error.trim() ? error : errorMessage(error, t('runui_commonUnknownError'));
      toast.add({ title: t('runui_startOnLoginFailed'), description, color: 'error' });
    } finally {
      busy.value = false;
    }
  }

  function dismiss(): void {
    offered.value = false;
  }

  return { offered, busy, offerIfOff, dismissIfOn, turnOn, dismiss };
}
