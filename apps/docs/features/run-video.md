---
title: Run video
description: "Play the videos Playwright recorded for a finished run, one test after another, beside a checklist that ticks as each test ends."
lang: en-US
---

# Run video

<Needs reporter />

A finished run has a **Video** tab, labelled with the number of tests that have a video (**Video (12)**). It plays the
videos Playwright recorded for the run, one test after another, beside a checklist of the tests. A test is ticked as its
video passes the end of the test, so you can follow a worker's run as it happened. The bar under the video has one block
for each test, colored by its result. Click a test or the bar to jump there: while the video is paused it shows that
frame and stays paused, and while it plays it keeps playing from there. The video, the bar and the marks under it fit
the screen without scrolling the page; only the list of tests scrolls.

## Group by Worker or File

- **Worker** plays one worker's tests in the order they ran. Pick the worker above the video.
- **File** plays every test in the order its file declares it, each marked with the worker it ran on. The tests ran in
  parallel, so this order is not the order they ran in.

Only the final attempt of a test is listed. A test that has no video stays on the checklist and takes a small block on
the bar. It is ticked as the reel moves on. The tab is off while the run is live.

## Open a video review from Evidence

On a finished execution that has a video, the Evidence header has an **Open video review** button, beside **Open trace**.
It opens the video with the same bar and checklist as the Video tab, in a window that fills a narrow screen. The window's
switch picks what plays, and it starts on **This test**:

- **This test** plays only that test, from the start of its video to its end, and stops. The file's other tests stay on
  the checklist, dimmed, and are not played.
- **Whole file** plays the file's final attempts in declared order, each marked with its worker, and starts on this test.
- **Its worker** plays the tests of this test's worker, in the order they ran, and starts on this test. A sharded run
  keeps each shard's workers apart.

In these two modes only the tests that play are ticked, and **Play** after the end starts again from this test. The
opened test is marked **This test** in every mode. Closing the window stops the video.

Only final attempts that ran are in the file and worker reels. On an earlier attempt or a skipped test, This test plays
its own video and the other two modes are off, with the reason shown under the switch. A run lists at most 2,000 tests
with a video, so a test past that limit also keeps only This test.

## Actions under the video

Under the bar, a lane of marks shows what the playing test did and when: one mark for each click, double click, fill,
type, key press, check, uncheck, select, hover and navigation, placed on the video where it happened. It shows on the
Video tab and in the Evidence video review.

- Point at a mark, or move to it with the keyboard, to read the action and its locator, for example
  `Click getByRole('button', { name: 'Save' })`. Choose a mark to go there; it plays on only if the video was playing.
- An action that failed has a red mark.
- Marks too close to tell apart merge into one mark with a count. Its tooltip lists them.
- An action outside the video is shown at the nearest edge of the lane, with a note in its tooltip.
- A test with more than 500 actions shows the first 500, and the lane says how many there are.

The marks come from what the project already stores. A test with a [trace](./evidence) uses the trace's actions, and any
other test uses its step list, so there is nothing to switch on. A test with neither shows "No recorded actions for this
test", and a failed load is one muted line; the video plays either way.

Piwi does not show what a test typed. The server masks each action before it sends it, and a locator is shown as the test
wrote it:

| Action | Shown |
|---|---|
| Fill, type | The locator and "typed N chars", never the text. "typed text", with no count, for a password, card or code field, or when no field is named |
| Press | A named key or a shortcut, such as `Enter` or `Control+A`; a single character, alone or behind Shift or Alt, shows as "a key" |
| Navigate | The origin and path, without the query string, fragment or credentials; a path segment shaped like a token is hidden |
| Check, uncheck, select | The locator only, never the chosen option |

## When there are no videos

Most suites record video only for failing tests (`video: 'retain-on-failure'`), so a run where nothing failed often has
none. The tab is then disabled, with the tooltip "no videos in this run". Set `video: 'on'` in Playwright's `use` options to record every test. Videos can be large, so
read [storage cleanup](/operate/storage#storage-management) first.

## Related

- [Failure evidence](./evidence): one failing execution, with its trace, screenshots and video
- [Storage](/operate/storage#storage-management): how long videos are kept
