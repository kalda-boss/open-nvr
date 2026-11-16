// Copyright (c) 2026 OpenNVR
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Synchronized playback without the layout: which days have footage, the
 * shared master clock every tile follows, the timeline window, motion jumps
 * and sound. The desktop grid (views/SyncPlayback.tsx) and the phone view
 * (views/playback/PhoneRecordings.tsx) lay these out differently but must
 * play the same way, so they share this.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  MOTION_PRE_ROLL_MS,
  combineMotion,
  motionEvents,
  nextMotionEvent,
  parseMotion,
  prevMotionEvent,
  skipQuietTarget,
  type MotionTrack,
} from '../../lib/motion'
import { useMotionForCameras, useRecordingsByDate, useSegmentsForCameras } from '../../lib/queries'
import { localDayEnd, localDayStart } from '../../lib/time'
import { useSnackbar } from '../../components/Snackbar'
import { useTranslation, type DateFormatters } from '../../i18n'
import type { TimelineSegment } from '../../components/PlaybackTimeline'
import { primeAudioOutput, readVoiceFocusPref, type VoiceFocusLevel } from '../../lib/voiceFocus'

export interface DailyRecording {
  date: string
  total_duration: number
  segment_count: number
  first_start: string
  playback_url: string | null
}

export interface OverviewCamera {
  camera_id: number
  camera_name: string
  path: string
  recording_count: number
  total_duration: number
  recordings: DailyRecording[]
}

interface RawSegment {
  start: string
  duration: number
  playback_url: string
}

export const ZOOMS: { label: string; span: number }[] = [
  { label: '24h', span: 24 * 3600_000 },
  { label: '6h', span: 6 * 3600_000 },
  { label: '1h', span: 3600_000 },
  { label: '10m', span: 600_000 },
]

/** Play speeds, forward or (while rewinding) backward. There is no slow
 *  motion: the button that used to step down to 0.25x is now Rewind. */
export const SPEEDS = [1, 2, 4, 8, 16]
export const RATE_1X = 0
/** Where Rewind starts, and where Fast-forward goes from a rewind. */
export const RATE_2X = 1
/** Grid limit — also keeps concurrent HLS sessions within the server cap. */
export const MAX_TILES = 4

export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

function parseSegments(raw: RawSegment[]): TimelineSegment[] {
  return raw
    .map((r) => {
      const startMs = Date.parse(r.start)
      return { startMs, endMs: startMs + (r.duration || 0) * 1000 }
    })
    .filter((s) => Number.isFinite(s.startMs))
    .sort((a, b) => a.startMs - b.startMs)
}

// Day windows are LOCAL days (midnight -> midnight in the browser's zone),
// matching the API's local-day grouping — see lib/time.ts.

export function formatDateLong(date: string, fmt: DateFormatters) {
  const [y, m, d] = date.split('-').map(Number)
  return fmt.date(new Date(y, m - 1, d), {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

/** The most recent day any camera recorded on. */
export function latestDay(overview: OverviewCamera[]): string | null {
  let latest: string | null = null
  for (const c of overview) for (const r of c.recordings) if (!latest || r.date > latest) latest = r.date
  return latest
}

/**
 * Which cameras have recordings on which days. react-query: cached across
 * navigations (Dashboard -> Recordings renders instantly from cache), deduped
 * across concurrent mounts.
 */
export function useRecordingsOverview() {
  const { t } = useTranslation()
  const query = useRecordingsByDate()
  const overview = (query.data?.cameras as OverviewCamera[] | undefined) ?? null
  const message = (query.error as { message?: string } | null)?.message
  const error = query.error
    ? (message === 'API_NETWORK_ERROR' ? t('dashboard.failedRecordings') : message || t('dashboard.failedRecordings'))
    : null

  // Calendar marks: every day with footage from any camera.
  const markedDates = useMemo(() => {
    const s = new Set<string>()
    for (const c of overview || []) for (const r of c.recordings) s.add(r.date)
    return s
  }, [overview])

  // O(1) lookups instead of scanning every camera's recordings array on
  // every render (the camera lists would do that 4x/second on clock ticks).
  const recByCamDate = useMemo(() => {
    const m = new Map<number, Map<string, DailyRecording>>()
    for (const c of overview || []) {
      const dm = new Map<string, DailyRecording>()
      for (const r of c.recordings) dm.set(r.date, r)
      m.set(c.camera_id, dm)
    }
    return m
  }, [overview])

  return {
    overview,
    loading: query.isPending,
    error,
    mediamtxAvailable: query.data?.mediamtx_available !== false,
    reload: query.refetch,
    markedDates,
    recByCamDate,
  }
}

/**
 * ``/playback/sync?camera=3&at=2026-09-18T14:32:07Z`` opens on that camera,
 * that day, with the playhead at that instant. Search results, alarms and
 * the app pages all end at a camera and a moment; without this they end at
 * a timestamp the operator has to find by hand, which is most of the work.
 *
 * Read ONCE: a later read would fight the views' day selection, and an
 * operator who then scrubs somewhere else must not be yanked back by their
 * own URL.
 */
export function usePlaybackDeepLink(): { camera: number | null; atMs: number | null } {
  const [searchParams] = useSearchParams()
  const link = useRef<{ camera: number | null; atMs: number | null } | null>(null)
  if (link.current === null) {
    const rawCam = Number(searchParams.get('camera'))
    const rawAt = Date.parse(searchParams.get('at') || '')
    link.current = {
      camera: Number.isFinite(rawCam) && rawCam > 0 ? rawCam : null,
      atMs: Number.isFinite(rawAt) ? rawAt : null,
    }
  }
  return link.current
}

/**
 * Sound for the playback views: off on every visit, one tap turns on the
 * selected camera's. The tiles report which loaded clips carry sound at all
 * (false: no mic, or AAC sound).
 */
export function usePlaybackSound() {
  const [muted, setMuted] = useState(true)
  const [voiceFocus, setVoiceFocus] = useState<VoiceFocusLevel>(readVoiceFocusPref)
  const [soundByCam, setSoundByCam] = useState<Record<number, boolean>>({})
  const onSound = useCallback(
    (id: number, has: boolean) => setSoundByCam((m) => (m[id] === has ? m : { ...m, [id]: has })),
    [],
  )
  const toggleMute = () => {
    if (muted) primeAudioOutput() // inside the click: iOS needs the gesture
    setMuted(!muted)
  }
  return { muted, toggleMute, voiceFocus, setVoiceFocus, soundByCam, onSound }
}

/**
 * The shared transport: one wall-clock playhead (`masterMs`) that every tile
 * of `selectedIds` follows on `selectedDate`, the visible timeline window,
 * and the motion data that drives the jumps and skip-quiet.
 *
 * `selectedIds` must keep its identity between renders while the selection
 * is unchanged, and hold at most MAX_TILES cameras.
 */
export function useSyncTransport({
  selectedIds,
  selectedDate,
  initialSeekMs,
}: {
  selectedIds: number[]
  selectedDate: string | null
  /** A deep link's instant: the first day to load opens there, once. */
  initialSeekMs: number | null
}) {
  const { t } = useTranslation()
  const { showInfo } = useSnackbar()

  //: Consumed by the per-day initialiser below, then cleared — so it seeks
  //: once rather than every time the day's segments reload.
  const pendingSeekMs = useRef<number | null>(initialSeekMs)

  const [masterMs, setMasterMs] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [rateIdx, setRateIdx] = useState(RATE_1X)
  // Rewinding: the master clock runs backward at SPEEDS[rateIdx]. `playing`
  // stays true meanwhile; the tiles hold their video paused and step it back.
  const [reverse, setReverse] = useState(false)
  const [view, setView] = useState<{ start: number; end: number }>({ start: 0, end: 0 })
  const [zoomIdx, setZoomIdx] = useState(0)
  const [previewMs, setPreviewMs] = useState<number | null>(null)

  const masterMsRef = useRef(masterMs)
  useEffect(() => {
    masterMsRef.current = masterMs
  }, [masterMs])

  const dayStart = selectedDate ? localDayStart(selectedDate) : 0
  const dayEnd = selectedDate ? localDayEnd(selectedDate) : 0
  const dayBoundsRef = useRef({ start: dayStart, end: dayEnd })
  dayBoundsRef.current = { start: dayStart, end: dayEnd }

  // Marks masterMs/view as initialized for the current day.
  const dateInitRef = useRef<string | null>(null)

  // ---- Fetch segments for the selected cameras/day -------------------------
  // One react-query per camera+day. Polling (today only) is handled by the
  // hook; structural sharing keeps unchanged responses referentially stable,
  // so a poll tick that changes nothing invalidates nothing downstream —
  // the old hand-rolled loop replaced every array on every tick and re-fired
  // every tile's follow loop.
  const segQueries = useSegmentsForCameras(selectedIds, selectedDate, { poll: true })

  // Fixed-length deps (MAX_TILES = 4) keep the hook contract while still
  // recomputing only when a query's (structurally shared) data changes.
  const segData0 = segQueries[0]?.data
  const segData1 = segQueries[1]?.data
  const segData2 = segQueries[2]?.data
  const segData3 = segQueries[3]?.data

  const segsByCam = useMemo(() => {
    const datas = [segData0, segData1, segData2, segData3]
    const out: Record<number, TimelineSegment[]> = {}
    selectedIds.forEach((id, i) => {
      out[id] = parseSegments((datas[i]?.segments as RawSegment[]) || [])
    })
    return out
  }, [selectedIds, segData0, segData1, segData2, segData3])

  const liveEdges = useMemo(() => {
    const datas = [segData0, segData1, segData2, segData3]
    const out: Record<number, number | null> = {}
    selectedIds.forEach((id, i) => {
      const raw = datas[i]?.live_edge_start
      const edge = raw ? Date.parse(raw) : NaN
      out[id] = Number.isFinite(edge) ? edge : null
    })
    return out
  }, [selectedIds, segData0, segData1, segData2, segData3])

  const segsLoading = selectedIds.length > 0 && segQueries.some((q) => q.isPending)
  const segsLoadingRef = useRef(segsLoading)
  segsLoadingRef.current = segsLoading

  // ---- Motion activity (motion on each timeline row; jumps, skip-quiet) ----
  // The shared playhead rides along so the server scores the clips around
  // it first (none until the day has placed it).
  const motionQueries = useMotionForCameras(selectedIds, selectedDate, previewMs ?? (masterMs || undefined))
  const motionData0 = motionQueries[0]?.data
  const motionData1 = motionQueries[1]?.data
  const motionData2 = motionQueries[2]?.data
  const motionData3 = motionQueries[3]?.data
  const motionByCam = useMemo(() => {
    const datas = [motionData0, motionData1, motionData2, motionData3]
    const out: Record<number, MotionTrack | null> = {}
    selectedIds.forEach((id, i) => {
      out[id] = parseMotion(datas[i])
    })
    return out
  }, [selectedIds, motionData0, motionData1, motionData2, motionData3])
  // Every selected camera as one track: a jump stops for any of them.
  const motion = useMemo(
    () => combineMotion(selectedIds.map((id) => motionByCam[id]).filter((m): m is MotionTrack => !!m)),
    [selectedIds, motionByCam]
  )
  const activity = useMemo(() => motionEvents(motion), [motion])
  const [skipQuiet, setSkipQuiet] = useState(false)
  // The master clock runs in an interval; it reads these through refs.
  const skipRef = useRef({ on: false, motion, activity, endSaid: false })
  skipRef.current.on = skipQuiet
  skipRef.current.motion = motion
  skipRef.current.activity = activity
  const sayNoMoreRef = useRef(() => {})
  sayNoMoreRef.current = () => showInfo(t('playback.noActivityAfter'))

  // Union of all selected cameras' footage — used for snapping, gap skipping
  // and picking the day's starting instant.
  const unionSegs = useMemo(() => {
    const all = Object.values(segsByCam).flat()
    return all.sort((a, b) => a.startMs - b.startMs)
  }, [segsByCam])
  const unionRef = useRef(unionSegs)
  useEffect(() => {
    unionRef.current = unionSegs
  }, [unionSegs])

  // Initialize the playhead and window once per selected day.
  useEffect(() => {
    if (segsLoading || !selectedDate) return
    if (dateInitRef.current === selectedDate) return
    if (Object.keys(segsByCam).length === 0) return
    dateInitRef.current = selectedDate
    const first = unionSegs.length ? unionSegs[0].startMs : dayStart
    // A deep link asked for an instant: honour it, clamped into the day, and
    // spend it — reloads of this day's segments must not drag the playhead
    // back to where the link pointed an hour ago.
    const asked = pendingSeekMs.current
    pendingSeekMs.current = null
    setMasterMs(
      asked != null && asked >= dayStart && asked < dayEnd ? asked : first,
    )
    setView({ start: dayStart, end: dayEnd })
    setZoomIdx(0)
    setPlaying(true)
  }, [segsLoading, selectedDate, segsByCam, unionSegs, dayStart, dayEnd])

  // ---- Master clock: advances wall-clock time, skipping global gaps --------
  useEffect(() => {
    if (!playing) return
    let last = performance.now()
    const id = setInterval(() => {
      const now = performance.now()
      const delta = (now - last) * SPEEDS[rateIdx]
      last = now
      const u = unionRef.current
      if (reverse) {
        // Rewind: back through the footage, over dead air to the end of the
        // footage before it. Skip-quiet only ever skips forward.
        let next = masterMsRef.current - delta
        if (!u.some((s) => next >= s.startMs && next < s.endMs)) {
          let prev: TimelineSegment | null = null
          for (const s of u) if (s.endMs <= next && (!prev || s.endMs > prev.endMs)) prev = s
          // Land a second inside the earlier footage: tiles treat the last
          // moments of a clip as already past it.
          if (prev) next = Math.max(prev.startMs, prev.endMs - 1000)
          // A camera that was only just selected has no footage list yet.
          else if (segsLoadingRef.current) return
          else {
            // Back at the day's first footage: stop there, paused.
            next = u.length ? u[0].startMs : masterMsRef.current
            setPlaying(false)
            setReverse(false)
            setRateIdx(RATE_1X)
          }
        }
        setMasterMs(Math.max(next, dayBoundsRef.current.start))
        return
      }
      let next = masterMsRef.current + delta
      // Dead air where NO selected camera has footage is skipped to the next
      // recorded instant instead of played through in real time.
      if (!u.some((s) => next >= s.startMs && next < s.endMs)) {
        const nx = u.find((s) => s.startMs > next)
        if (nx) next = nx.startMs
        // A camera that was only just selected has no footage list yet:
        // hold here until it arrives rather than calling the day over.
        else if (segsLoadingRef.current) return
        else {
          setPlaying(false)
          return
        }
      }
      // Skip-quiet: past the end of a stretch of motion, go to the next one.
      const sq = skipRef.current
      if (sq.on && sq.motion) {
        const target = skipQuietTarget(sq.motion, sq.activity, next)
        if (typeof target === 'number') next = target
        else if (target === 'end' && !sq.endSaid) {
          sq.endSaid = true
          sayNoMoreRef.current()
        }
      }
      // Never chase into footage still being written (or the end of the day).
      const cap = Math.min(Date.now() - 60_000, dayBoundsRef.current.end - 1)
      if (next >= cap) {
        setPlaying(false)
        next = Math.min(masterMsRef.current, cap)
      }
      setMasterMs(next)
    }, 250)
    return () => clearInterval(id)
  }, [playing, rateIdx, reverse])

  // Keep the playhead inside the visible window while playing (auto-follow).
  useEffect(() => {
    if (previewMs != null) return
    if (masterMs < view.start || masterMs > view.end) {
      const span = view.end - view.start
      if (span <= 0) return
      let start = clamp(masterMs - span / 2, dayStart, dayEnd - span)
      if (span >= dayEnd - dayStart) start = dayStart
      setView({ start, end: start + span })
    }
  }, [masterMs, previewMs, view.start, view.end, dayStart, dayEnd])

  // ---- Handlers ------------------------------------------------------------

  /** Call when the selected day changes: the new day re-initialises the
   *  playhead and window, and starts paused until its footage has loaded. */
  const resetDay = () => {
    dateInitRef.current = null
    skipRef.current.endSaid = false
    setPlaying(false)
  }

  const seekTo = (ms: number) => {
    setMasterMs(clamp(ms, dayStart, dayEnd - 1))
  }

  /** Step the playhead by `deltaMs`, landing on footage: a step that would
   *  end in a gap goes to the far side of it (forward: where footage
   *  resumes; back: the same distance before the gap began). */
  const seekBy = (deltaMs: number) => {
    const target = masterMs + deltaMs
    if (unionSegs.some((s) => target >= s.startMs && target < s.endMs)) {
      seekTo(target)
      return
    }
    if (deltaMs > 0) {
      const nx = unionSegs.find((s) => s.startMs > target)
      if (nx) seekTo(nx.startMs)
      return
    }
    let prev: TimelineSegment | null = null
    for (const s of unionSegs) if (s.endMs <= target && (!prev || s.endMs > prev.endMs)) prev = s
    if (prev) seekTo(Math.max(prev.startMs, prev.endMs + deltaMs))
  }

  /** Play/pause. From a rewind, Play goes forward again at normal speed. */
  const togglePlay = () => {
    if (reverse) {
      setReverse(false)
      setRateIdx(RATE_1X)
      setPlaying(true)
      return
    }
    setPlaying((p) => !p)
  }

  // Jump to the next / previous stretch of motion on any selected camera.
  const jumpToActivity = (dir: 1 | -1) => {
    const at = previewMs ?? masterMs
    const ev = dir > 0 ? nextMotionEvent(activity, at) : prevMotionEvent(activity, at)
    if (!ev) {
      showInfo(t(dir > 0 ? 'playback.noActivityAfter' : 'playback.noActivityBefore'))
      return
    }
    seekTo(ev.startMs - MOTION_PRE_ROLL_MS)
  }

  const toggleSkipQuiet = () => {
    skipRef.current.endSaid = false
    setSkipQuiet((on) => !on)
  }

  const stop = () => {
    setPlaying(false)
    setReverse(false)
    setMasterMs(unionSegs.length ? unionSegs[0].startMs : dayStart)
  }

  /** Rewind: play backward from 2x; again for 4x, 8x, 16x. */
  const rewind = () => {
    setRateIdx((i) => (reverse ? Math.min(i + 1, SPEEDS.length - 1) : RATE_2X))
    setReverse(true)
    setPlaying(true)
  }

  /** Fast-forward: one speed up. From a rewind, forward again at 2x. */
  const fastForward = () => {
    if (reverse) {
      setReverse(false)
      setRateIdx(RATE_2X)
      setPlaying(true)
      return
    }
    setRateIdx((i) => Math.min(i + 1, SPEEDS.length - 1))
  }

  /** Back to forward at 1x, playing or paused as before. */
  const normalSpeed = () => {
    setReverse(false)
    setRateIdx(RATE_1X)
  }

  /** Pick a forward speed (the phone's speed menu). */
  const setSpeed = (idx: number) => {
    setReverse(false)
    setRateIdx(clamp(idx, 0, SPEEDS.length - 1))
  }

  const applyZoom = (idx: number) => {
    const span = ZOOMS[idx].span
    setZoomIdx(idx)
    const center = previewMs ?? masterMs
    const total = dayEnd - dayStart
    if (span >= total) {
      setView({ start: dayStart, end: dayEnd })
      return
    }
    const start = clamp(center - span / 2, dayStart, dayEnd - span)
    setView({ start, end: start + span })
  }

  // Edge auto-scroll while scrubbing: shift the window, keep the span (and
  // the active zoom preset). Returning the same object when clamped-unchanged
  // avoids re-render churn at the day boundaries.
  const panBy = useCallback(
    (deltaMs: number) => {
      setView((v) => {
        const span = v.end - v.start
        if (span <= 0) return v
        const start = clamp(v.start + deltaMs, dayStart, Math.max(dayStart, dayEnd - span))
        return start === v.start ? v : { start, end: start + span }
      })
    },
    [dayStart, dayEnd]
  )

  const zoomAt = useCallback(
    (anchorMs: number, factor: number) => {
      setZoomIdx(-1)
      setView((v) => {
        const span = v.end - v.start
        const total = dayEnd - dayStart
        const MIN_SPAN = 30_000
        const newSpan = clamp(span * factor, MIN_SPAN, total)
        if (newSpan >= total) return { start: dayStart, end: dayEnd }
        const rel = span > 0 ? (anchorMs - v.start) / span : 0.5
        const start = clamp(anchorMs - rel * newSpan, dayStart, dayEnd - newSpan)
        return { start, end: start + newSpan }
      })
    },
    [dayStart, dayEnd]
  )

  return {
    dayStart,
    dayEnd,
    segsByCam,
    liveEdges,
    segsLoading,
    unionSegs,
    motionByCam,
    motion,
    activity,
    masterMs,
    playing,
    rateIdx,
    setSpeed,
    rate: SPEEDS[rateIdx],
    reverse,
    view,
    zoomIdx,
    previewMs,
    setPreviewMs,
    /** Where the playhead reads: the scrub preview while dragging. */
    effectiveCurrent: previewMs ?? masterMs,
    skipQuiet,
    toggleSkipQuiet,
    resetDay,
    seekTo,
    seekBy,
    togglePlay,
    jumpToActivity,
    stop,
    rewind,
    fastForward,
    normalSpeed,
    applyZoom,
    panBy,
    zoomAt,
  }
}
