/**
 * Copyright (c) 2026 OpenNVR
 * This file is part of OpenNVR.
 *
 * OpenNVR is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * OpenNVR is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with OpenNVR.  If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * Motion activity for the playback timeline.
 *
 * `/recordings/motion/{id}` sends one byte per second of a camera's day,
 * scored by the server from the recording's keyframes
 * (server/services/motion_index.py): `round(255 * sqrt(f))` where `f` is the
 * fraction of the frame that changed, or one of the two sentinels below.
 */

/** A recorded second the server has not scored yet. */
export const MOTION_PENDING = 254
/** A second with no footage. */
export const MOTION_NONE = 255
/** At or below this is noise: a still scene measures 0-4 (a few pixels),
 *  a person moving far off in a wide shot ~6 and up. Never drawn. */
export const MOTION_NOISE = 4
/** Lowest score an activity jump stops at (~0.1 % of the frame, a person
 *  walking rather than a curtain twitching). */
export const MOTION_EVENT = 8
/** Score drawn at full height: ~10 % of the frame changing. */
export const MOTION_FULL = 80
/** A jump needs this much activity, or one change of at least
 *  MOTION_EVENT_STRONG: a screen waking up or a light flicking is one 2 s
 *  keyframe pair, while someone walking through spans several. The bar still
 *  draws those blips; jumps just do not stop for them. */
export const MOTION_EVENT_MIN_MS = 4000
export const MOTION_EVENT_STRONG = 20

export interface MotionResponse {
  camera_id: number
  date: string
  /** ISO instant of values[0]. */
  start: string
  /** Seconds per value. */
  step: number
  /** base64, one byte per step. */
  values: string
  scored: number
  pending: number
  /** False when the server's motion indexing is switched off. */
  enabled: boolean
}

export interface MotionTrack {
  /** Epoch ms of values[0]. */
  startMs: number
  stepMs: number
  values: Uint8Array
  /** Clips in the window the server has scored / has yet to score. */
  scored: number
  pending: number
  /** Share of the window's clips already scored, 0..1. */
  progress: number
}

export interface MotionEvent {
  startMs: number
  endMs: number
  peak: number
}

export function parseMotion(r: MotionResponse | undefined | null): MotionTrack | null {
  if (!r || !r.enabled || !r.values) return null
  const startMs = Date.parse(r.start)
  if (!Number.isFinite(startMs)) return null
  const bin = atob(r.values)
  const values = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) values[i] = bin.charCodeAt(i)
  const total = r.scored + r.pending
  return {
    startMs,
    stepMs: (r.step || 1) * 1000,
    values,
    scored: r.scored,
    pending: r.pending,
    progress: total > 0 ? r.scored / total : 1,
  }
}

/** Several cameras' tracks over the same day as one: a second is active if
 *  any camera is, else unscored if any camera is, else the quietest real
 *  score. So jumps and skip-quiet across a camera grid stop for activity on
 *  any of them and never skip what one of them has not scored yet. */
export function combineMotion(tracks: MotionTrack[]): MotionTrack | null {
  if (tracks.length === 0) return null
  if (tracks.length === 1) return tracks[0]
  const [first] = tracks
  const n = Math.max(...tracks.map((t) => t.values.length))
  const values = new Uint8Array(n).fill(MOTION_NONE)
  for (let i = 0; i < n; i++) {
    let active = -1
    let quiet = -1
    let pending = false
    for (const t of tracks) {
      const v = t.values[i] ?? MOTION_NONE
      if (v === MOTION_PENDING) pending = true
      else if (v < MOTION_PENDING) {
        if (v >= MOTION_EVENT) active = Math.max(active, v)
        else quiet = Math.max(quiet, v)
      }
    }
    if (active >= 0) values[i] = active
    else if (pending) values[i] = MOTION_PENDING
    else if (quiet >= 0) values[i] = quiet
  }
  const scored = tracks.reduce((a, t) => a + t.scored, 0)
  const pending = tracks.reduce((a, t) => a + t.pending, 0)
  return {
    startMs: first.startMs,
    stepMs: first.stepMs,
    values,
    scored,
    pending,
    progress: scored + pending > 0 ? scored / (scored + pending) : 1,
  }
}

/** Bar height (0..1) for a score; 0 for noise, no data and unscored. A
 *  floor keeps a lone walker visible next to a crowd's full-height bars. */
export function motionLevel(score: number): number {
  if (score <= MOTION_NOISE || score >= MOTION_PENDING) return 0
  return Math.min(1, 0.2 + (0.8 * (score - MOTION_NOISE)) / (MOTION_FULL - MOTION_NOISE))
}

/** Highest score in [fromMs, toMs), whether any second there is unscored,
 *  and whether any is scored footage. */
export function motionPeak(
  track: MotionTrack,
  fromMs: number,
  toMs: number
): { peak: number; pending: boolean; scored: boolean } {
  const { values, startMs, stepMs } = track
  let peak = 0
  let pending = false
  let scored = false
  const endMs = startMs + values.length * stepMs
  if (toMs <= startMs || fromMs >= endMs) return { peak, pending, scored }
  const i0 = Math.max(0, Math.floor((fromMs - startMs) / stepMs))
  const i1 = Math.min(values.length, Math.max(i0 + 1, Math.ceil((toMs - startMs) / stepMs)))
  for (let i = i0; i < i1; i++) {
    const v = values[i]
    if (v === MOTION_PENDING) pending = true
    else if (v < MOTION_PENDING) {
      scored = true
      if (v > peak) peak = v
    }
  }
  return { peak, pending, scored }
}

/** Runs of activity (score >= threshold), joined across quiet gaps of up to
 *  `mergeGapMs` so one person pausing mid-frame stays one event, without
 *  one-off blips (see MOTION_EVENT_MIN_MS). */
export function motionEvents(
  track: MotionTrack | null,
  threshold = MOTION_EVENT,
  mergeGapMs = 10_000
): MotionEvent[] {
  if (!track) return []
  const { values, startMs, stepMs } = track
  const out: MotionEvent[] = []
  let cur: MotionEvent | null = null
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (v < threshold || v >= MOTION_PENDING) continue
    const t = startMs + i * stepMs
    if (cur && t - cur.endMs <= mergeGapMs) {
      cur.endMs = t + stepMs
      if (v > cur.peak) cur.peak = v
    } else {
      cur = { startMs: t, endMs: t + stepMs, peak: v }
      out.push(cur)
    }
  }
  return out.filter(
    (e) => e.endMs - e.startMs >= MOTION_EVENT_MIN_MS || e.peak >= MOTION_EVENT_STRONG
  )
}

/** Seconds of lead-in before an event, so a jump shows someone walking in
 *  rather than already mid-frame. */
export const MOTION_PRE_ROLL_MS = 2000

/** The first event that starts after `ms`. */
export function nextMotionEvent(events: MotionEvent[], ms: number): MotionEvent | null {
  return events.find((e) => e.startMs - MOTION_PRE_ROLL_MS > ms + 500) ?? null
}

/** The event to go back to from `ms`: the one playing, once a few seconds
 *  in (like a music player's back button), else the one before it. */
export function prevMotionEvent(events: MotionEvent[], ms: number): MotionEvent | null {
  let best: MotionEvent | null = null
  for (const e of events) {
    if (e.startMs - MOTION_PRE_ROLL_MS < ms - 3000) best = e
    else break
  }
  return best
}

/** Where skip-quiet playback goes from `ms`: the next instant that is either
 *  activity (less its lead-in) or not scored yet; `'end'` when only quiet
 *  footage is left; null to keep playing. Only seconds known to be quiet are
 *  ever skipped. */
export function skipQuietTarget(
  track: MotionTrack,
  events: MotionEvent[],
  ms: number,
  tailMs = 3000
): number | 'end' | null {
  const inEvent = events.some(
    (e) => ms >= e.startMs - MOTION_PRE_ROLL_MS && ms < e.endMs + tailMs
  )
  if (inEvent) return null
  const { values, startMs, stepMs } = track
  const i = Math.floor((ms - startMs) / stepMs)
  if (i < 0 || i >= values.length || values[i] >= MOTION_PENDING) return null
  const next = nextMotionEvent(events, ms)
  let target = next ? next.startMs - MOTION_PRE_ROLL_MS : Infinity
  // Never jump past footage that has not been scored.
  const stop = Math.min(values.length, Math.ceil((target - startMs) / stepMs))
  for (let j = i + 1; j < stop; j++) {
    if (values[j] === MOTION_PENDING) {
      target = startMs + j * stepMs
      break
    }
  }
  if (!Number.isFinite(target)) return 'end'
  return target - ms > 1500 ? target : null
}
