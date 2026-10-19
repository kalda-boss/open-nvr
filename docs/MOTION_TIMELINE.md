# Motion bar on the playback timeline

Both playback views draw a motion bar along the timeline, so you can see
when something moved in the frame and skim straight to it:

* **Single-camera player** (Recordings → a day → Play): an orange lane
  above the footage track. Bar height follows how much of the picture
  changed. A hatched stretch is footage still being scored.
* **Multi-camera playback** (`/playback/sync`, the sidebar's Recordings):
  the same bars drawn over each camera's row.

Both have the same three controls next to the speed buttons:

| Control | What it does |
| --- | --- |
| ‹ | Previous activity: back to the start of this stretch of motion (once a few seconds into it), else the one before. |
| Pulse icon | Skip quiet: while playing, jump over stretches scored quiet. Combine it with 4x–8x to skim a day. Footage not scored yet is never skipped. |
| › | Next activity: jump to the next stretch of motion. |

To see the bars bigger, drag the top edge of the controls bar (just under
the video) up: the timeline takes the height the video gives up. In the
single-camera player the motion lane grows; in multi-camera playback each
camera's row does, and once there is room it becomes a lane of its own above
a thin footage strip. The size is remembered per view. Double-click the edge
to reset it, or focus it and use the up/down arrow keys.

Jumps land 2 seconds early, so you see someone walk in. In multi-camera
playback they stop for motion on any selected camera. In the single-camera
player, hovering the bar shows the time and "motion" where there is some. A
blip shorter than 4 seconds (a screen waking up, a light flicking on) stays
on the bar, but jumps don't stop for it.

## How it is measured

Core scores every recorded clip in the background
(`server/services/motion_index.py`). Nothing extra runs on the cameras or
the live streams, and it works whether or not the detect pipeline is on.

1. ffmpeg decodes only the clip's keyframes, one per GOP (2 s on these
   cameras), scaled to 256×144 grayscale. That costs about 1.2 s of CPU per
   minute of 4 MP HEVC, a few percent of a full decode.
2. Each keyframe is compared with the one before it. The frame-wide
   brightness shift is removed first (auto-exposure), a pixel counts when it
   moved more than 20 levels, and an erosion drops isolated pixels (sensor
   noise, the OSD clock).
3. The score is the changed share of the frame. A pair where over 80 % of
   the frame changed is an IR/day-night switch or the lights, and scores 0.
4. One byte per second of the clip is stored in `recordings.motion`, as
   `round(255 * sqrt(share))`. A quiet frame scores 0–4, someone walking
   through a wide shot 10–60.

This is motion, not person detection. It also fires for a door, a screen, a
vehicle or a tree in the wind. On indoor cameras with steady lighting, most
of it is people.

## Scheduling and cost

* New clips are scored newest first, about a minute after they are written.
* After the first deploy, existing footage is backfilled, newest first. A
  worker scores about 30–45 one-minute clips a minute (less when the box is
  busy), so 2 workers take roughly 4–6 hours per 20,000 clips.
* A day open in either player goes to the front of the queue, nearest the
  playhead first. With several cameras open they fill in around the shared
  playhead together.
* Each worker is one ffmpeg under `nice -n 15` with one decode thread, so
  `MOTION_INDEX_WORKERS` bounds the CPU this takes. One worker keeps up with
  new footage from 25–40 cameras, and the rest of its time goes to the
  backfill.

```
# .env
MOTION_INDEX_ENABLED=true   # false: no scoring; the bar and buttons go away
MOTION_INDEX_WORKERS=2      # raise for a faster backfill
```

Scores are stored with the clip's row, so retention removes them with the
footage. If the recordings drive is unmounted, scoring pauses for 5 minutes
and tries again. It does not mark the clips unreadable.

## API

`GET /api/v1/recordings/motion/{camera_id}` takes the same window
parameters as `/segments` (`date` + `tz`, or `start`/`end`), plus `focus`,
the instant the viewer is at. It returns `values`, base64 with one byte per
second from `start`: 0–253 is a score, 254 is footage not scored yet, 255 is
no footage. It also returns `scored`/`pending` clip counts. The response for
a whole day gzips to a few KB.
