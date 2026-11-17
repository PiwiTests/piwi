import type { RunVariableShell } from '#shared/run-variables';

/** The storage key of the shell a viewer copies commands for, which `PlatformCodeBlock` shares when given it. */
export const COMMAND_SHELL_KEY = 'piwi-command-shell';

/**
 * The shell of the viewer's computer: PowerShell on Windows, bash anywhere else, from the platform the browser reports
 * (`userAgentData.platform`, else `navigator.platform`), which a user agent string set for a device does not change.
 */
export function viewerShell(): RunVariableShell {
  if (typeof navigator === 'undefined') return 'bash';
  const reported = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform;
  return /^win/i.test(reported || navigator.platform || '') ? 'powershell' : 'bash';
}

/**
 * The shell the viewer copies commands for: the one they last picked in a command block, else their computer's. One
 * value for the page, so a pick in one block changes what every copy button copies.
 */
export function useCommandShell() {
  const shell = useState<RunVariableShell>('command-shell', () => 'bash');
  const known = useState<boolean>('command-shell-known', () => false);
  onMounted(() => {
    if (known.value) return;
    known.value = true;
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(COMMAND_SHELL_KEY);
    } catch {
      // Private windows and blocked storage leave the computer's shell.
    }
    shell.value = saved === 'bash' || saved === 'powershell' ? saved : viewerShell();
  });

  function pick(next: RunVariableShell) {
    shell.value = next;
    known.value = true;
    try {
      localStorage.setItem(COMMAND_SHELL_KEY, next);
    } catch {
      // The pick still applies to this page.
    }
  }

  return { shell, pick };
}
