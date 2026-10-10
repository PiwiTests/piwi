/**
 * Marks the connected instance's pages, so the dashboard knows Piwi Picker is
 * installed in this browser and leaves out its hint to install it (see
 * `@piwitests/core/picker-marker`). The worker registers it for the instance's
 * origin only (`background/instance-marker.ts`). It reads nothing from the page
 * and sends nothing.
 */
import { PICKER_MARKER_ATTRIBUTE, PICKER_MARKER_EVENT } from '@piwitests/core/picker-marker';
import { getConnectionSettings } from '../shared/connection-settings.js';
import { isInstancePage } from '../shared/instance-links.js';

void getConnectionSettings().then(({ instanceUrl }) => {
  // In Firefox the registration covers every port of the instance's host: an app under test on another port of
  // localhost is left alone.
  if (!isInstancePage(instanceUrl, location.href)) return;
  document.documentElement.setAttribute(PICKER_MARKER_ATTRIBUTE, chrome.runtime.getManifest().version);
  document.dispatchEvent(new Event(PICKER_MARKER_EVENT));
});
