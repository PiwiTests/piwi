/**
 * The one Changelog window (`ChangelogModal`, mounted by the default layout),
 * opened from the user menu, Settings → About and the desktop app's Updates
 * card.
 */
export function useChangelog() {
  const open = useState('piwi-changelog-open', () => false);

  function openChangelog() {
    open.value = true;
  }

  return { open, openChangelog };
}
