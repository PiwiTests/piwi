---
title: Run video
description: "Play the videos Playwright recorded for a finished run, one test after another, beside a checklist that ticks as each test ends."
lang: en-US
---

# Run video

<Needs reporter />

A finished run has a **Video** tab that plays the videos Playwright recorded for the run, one test after another, beside
a checklist of the tests. A test is ticked as its video passes the end of the test, so you can follow a worker's run as
it happened. The bar under the video has one block for each test, colored by its result. Click a test or the bar to jump
there.

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

The opened test carries a **This test** tag in every mode. Closing the window stops the video.

Only final attempts are in the file and worker reels. On an earlier attempt, This test plays that attempt's own video
and the other two modes are off. A run lists at most 2,000 tests with a video, so a test past that limit also keeps only
This test.

## When there are no videos

Most suites record video only for failing tests (`video: 'retain-on-failure'`), so a run where nothing failed often has
none, and the tab says so. Set `video: 'on'` in Playwright's `use` options to record every test. Videos can be large, so
read [storage cleanup](/operate/storage#storage-management) first.

## Related

- [Failure evidence](./evidence): one failing execution, with its trace, screenshots and video
- [Storage](/operate/storage#storage-management): how long videos are kept
