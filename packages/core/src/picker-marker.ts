/**
 * How Piwi Picker tells the dashboard it is installed in this browser. Once
 * connected to an instance, the extension runs one script on that instance's
 * own pages: it sets {@link PICKER_MARKER_ATTRIBUTE} on `<html>` to the
 * extension's version, then dispatches {@link PICKER_MARKER_EVENT} on
 * `document`, for a dashboard page that looked before the script ran. The
 * dashboard leaves out its hint to install Piwi Picker when it sees either.
 * Nothing else passes between them this way.
 */

/** Set on the instance pages' `<html>` to the extension's version: `data-piwi-picker="0.50.0"`. */
export const PICKER_MARKER_ATTRIBUTE = 'data-piwi-picker';

/** Dispatched on `document` once {@link PICKER_MARKER_ATTRIBUTE} is set. */
export const PICKER_MARKER_EVENT = 'piwi-picker-marked';
