// Copyright (c) 2026 OpenNVR
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Recordings on a phone, laid out like the phone Live View: one big camera
 * (or a 2×2 quad), then the day, the timeline and the transport at finger
 * size, then every camera in a list. The desktop grid stacked into one
 * column put four thumbnail tiles above 14px buttons and hid the camera
 * checklist below the fold, so watching one camera meant scrolling down and
 * unticking the other three.
 *
 * One camera is the default, and there are several ways to get to it:
 *   - tap it in the camera list;
 *   - pick it from the menu on the camera's name, over the video (the one
 *     way that still works in fullscreen and landscape, where the list is
 *     out of sight);
 *   - swipe the video left or right for the next or previous camera;
 *   - in the quad, double-tap a tile (or "show alone" in the list header);
 *   - a ?camera= link from Search or an alarm opens on that camera alone.
 * Switching camera keeps the day and the instant, so the same moment can be
 * checked from camera to camera.
 *
 * Portrait stacks the controls under the video. Landscape and fullscreen
 * give the video the screen and lay the controls over it; a tap shows or
 * hides them.
 *
 * Playback itself is the shared engine (syncPlaybackEngine.ts), the same
 * one the desktop grid runs. State lives under `recordings-mobile`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { clsx } from 'clsx'
import {
  Activity,
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Film,
  Loader2,
  Maximize,
  Maximize2,
  Minimize,
  MonitorPlay,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
} from 'lucide-react'
import { useTranslation, useDateFormat, type DateFormatters } from '../../i18n'
import { useCameraAspects } from '../../lib/queries'
import { warmHls } from '../../lib/loadHls'
import { formatDuration, localDateKey } from '../../lib/time'
import { useMediaQuery } from '../../hooks/useMediaQuery'
import { useSnackbar } from '../../components/Snackbar'
import { Modal } from '../../components/Modal'
import { RecordingCalendar } from '../../components/RecordingCalendar'
import { ActivityTimeline } from '../../components/ActivityTimeline'
import type { TimelineSegment } from '../../components/PlaybackTimeline'
import type { TimelineRow } from '../../components/MultiCamTimeline'
import { SyncPlaybackTile } from '../../components/SyncPlaybackTile'
import { VoiceFocusButton } from '../../components/VoiceFocusButton'
import { NO_PICTURE_BG } from '../live/LiveTile'
import {
  SPEEDS,
  ZOOMS,
  latestDay,
  usePlaybackDeepLink,
  usePlaybackSound,
  useRecordingsOverview,
  useSyncTransport,
  type DailyRecording,
  type OverviewCamera,
} from './syncPlaybackEngine'

type Mode = 'single' | 'quad'
type Quad = [number, number, number, number]

interface PhoneState {
  mode: Mode
  /** The camera Single shows; null until the recordings overview arrives. */
  single: number | null
  /** Camera per quad tile; 0 marks an empty tile. */
  quad: Quad
  /** The quad tile a camera-list tap fills (0–3). */
  active: number
}

const STORAGE_KEY = 'recordings-mobile'
const NO_SEGMENTS: TimelineSegment[] = []
const SKIP_MS = 10_000
/** Two taps on a quad tile within this long show its camera alone. */
const DOUBLE_TAP_MS = 350
/** With the controls over the video, they step aside this long after the
 *  last touch while it plays. */
const CHROME_HIDE_MS = 4000

function loadState(linkCamera: number | null): PhoneState {
  let state: PhoneState = { mode: 'single', single: null, quad: [0, 0, 0, 0], active: 0 }
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null')
    if (raw && raw.v === 1) {
      state = {
        mode: raw.mode === 'quad' ? 'quad' : 'single',
        single: Number.isInteger(raw.single) ? raw.single : null,
        quad: Array.isArray(raw.quad) && raw.quad.length === 4 && raw.quad.every((n: unknown) => Number.isInteger(n))
          ? (raw.quad as Quad)
          : state.quad,
        active: Number.isInteger(raw.active) && raw.active >= 0 && raw.active < 4 ? raw.active : 0,
      }
    }
  } catch { /* unreadable: start fresh */ }
  // A link that names a camera means that camera, alone.
  return linkCamera != null ? { ...state, mode: 'single', single: linkCamera } : state
}

/**
 * Which day and which cameras are on screen, kept valid against the
 * recordings overview: a camera with no footage left drops out, and the
 * first visit opens on the latest day with a camera that recorded on it.
 */
function usePhoneRecordingsState(
  overview: OverviewCamera[] | null,
  recByCamDate: Map<number, Map<string, DailyRecording>>,
  link: { camera: number | null; atMs: number | null },
) {
  const [selectedDate, setSelectedDate] = useState<string | null>(
    link.atMs != null ? localDateKey(link.atMs) : null,
  )
  const [state, setState] = useState<PhoneState>(() => loadState(link.camera))
  const firstRunRef = useRef(true)
  // Read before the save effect below first writes: a first visit fills the
  // quad with the day's cameras, a returning one keeps the tiles it left.
  const neverSavedRef = useRef<boolean | null>(null)
  if (neverSavedRef.current === null) {
    try { neverSavedRef.current = localStorage.getItem(STORAGE_KEY) == null } catch { neverSavedRef.current = false }
  }

  /** Cameras with footage on `date`, in list order. */
  const camerasOn = useCallback(
    (date: string) =>
      (overview || []).filter((c) => recByCamDate.get(c.camera_id)?.has(date)).map((c) => c.camera_id),
    [overview, recByCamDate],
  )

  // Runs when the overview arrives or changes. Skipped while it is empty,
  // so a slow first load doesn't wipe the saved selection.
  useEffect(() => {
    if (!overview || overview.length === 0) return
    const date = selectedDate ?? latestDay(overview)
    if (!date) return
    if (!selectedDate) setSelectedDate(date)
    const known = new Set(overview.map((c) => c.camera_id))
    const avail = camerasOn(date)
    const first = firstRunRef.current
    firstRunRef.current = false
    setState((s) => {
      let single = s.single != null && known.has(s.single) ? s.single : null
      // Open on a camera that recorded that day. A camera the link named
      // stays even if it didn't: "no recording" there is the answer.
      if (single == null || (first && link.camera == null && !avail.includes(single))) {
        single = avail[0] ?? single ?? overview[0].camera_id
      }
      let quad = s.quad.map((id) => (known.has(id) ? id : 0)) as Quad
      if (first && neverSavedRef.current && quad.every((id) => id === 0)) {
        quad = [0, 1, 2, 3].map((i) => avail[i] ?? 0) as Quad
      }
      if (single === s.single && quad.every((id, i) => id === s.quad[i])) return s
      return { ...s, single, quad }
    })
    // The day is only read to pick the first one; later day changes go
    // through setDay.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overview])

  useEffect(() => {
    if (state.single == null) return
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: 1, ...state }))
    } catch { /* private mode */ }
  }, [state])

  /** A camera-list (or camera-menu) pick: show it in Single, or put it in
   *  the active quad tile (swapping with the tile it was already in). */
  const pick = useCallback((id: number) => {
    setState((s) => {
      if (s.mode === 'single') return s.single === id ? s : { ...s, single: id }
      const quad = [...s.quad] as Quad
      const from = quad.indexOf(id)
      if (from !== -1 && from !== s.active) quad[from] = quad[s.active]
      quad[s.active] = id
      return { ...s, quad, single: id }
    })
  }, [])

  const focusTile = useCallback((i: number) => setState((s) => (s.active === i ? s : { ...s, active: i })), [])

  const setMode = useCallback((mode: Mode) => {
    setState((s) => {
      if (s.mode === mode) return s
      if (mode === 'single') {
        // Leave Quad on the camera the user was working with.
        return { ...s, mode, single: s.quad[s.active] || s.single }
      }
      // Into Quad: the camera on screen stays on screen, in the active tile.
      const quad = [...s.quad] as Quad
      let active = s.active
      if (s.single != null) {
        const at = quad.indexOf(s.single)
        if (at !== -1) active = at
        else quad[active] = s.single
      }
      return { ...s, mode, quad, active }
    })
  }, [])

  /** Show the camera in quad tile `i` alone. */
  const showAlone = useCallback((i: number) => {
    setState((s) => (s.quad[i] ? { ...s, mode: 'single', single: s.quad[i], active: i } : s))
  }, [])

  /** Swipe in Single: the next or previous camera that recorded on the
   *  selected day, wrapping. */
  const step = (dir: 1 | -1) => {
    if (!selectedDate) return
    const order = camerasOn(selectedDate)
    if (order.length === 0) return
    setState((s) => {
      const at = s.single == null ? -1 : order.indexOf(s.single)
      const next = at === -1 ? order[0] : order[(at + dir + order.length) % order.length]
      return next === s.single ? s : { ...s, single: next }
    })
  }

  /**
   * Change the day. The cameras on screen stay if they recorded that day;
   * otherwise the first camera that did takes over, and the swap is
   * returned so the caller can say so.
   */
  const setDay = (date: string): { from: number; to: number } | null => {
    const avail = camerasOn(date)
    setSelectedDate(date)
    if (avail.length === 0) return null
    if (state.mode === 'single') {
      if (state.single == null || avail.includes(state.single)) return null
      const from = state.single
      setState((s) => ({ ...s, single: avail[0] }))
      return { from, to: avail[0] }
    }
    if (state.quad.some((id) => avail.includes(id))) return null
    setState((s) => {
      const quad = [...s.quad] as Quad
      quad[s.active] = avail[0]
      return { ...s, quad, single: avail[0] }
    })
    return null
  }

  // The cameras playing, for the engine. Kept referentially stable while
  // the selection is unchanged: the engine recomputes per identity.
  const ids = useMemo(
    () =>
      state.mode === 'single'
        ? (state.single != null ? [state.single] : [])
        : [...new Set(state.quad.filter((id) => id !== 0))],
    [state.mode, state.single, state.quad],
  )

  return { ...state, selectedDate, ids, camerasOn, pick, focusTile, setMode, showAlone, step, setDay }
}

function formatDay(date: string, fmt: DateFormatters) {
  const [y, m, d] = date.split('-').map(Number)
  return fmt.date(new Date(y, m - 1, d), { weekday: 'short', day: 'numeric', month: 'short' })
}

export function PhoneRecordings() {
  const { t } = useTranslation()
  const fmt = useDateFormat()
  const { showInfo } = useSnackbar()
  // Per-camera display-aspect and fisheye settings for the tiles (#354).
  const cameraAspects = useCameraAspects()

  // Download the hls.js chunk while the overview request is in flight.
  useEffect(() => {
    warmHls()
  }, [])

  const ov = useRecordingsOverview()
  const link = usePlaybackDeepLink()
  const view = usePhoneRecordingsState(ov.overview, ov.recByCamDate, link)
  const { selectedDate } = view
  const tp = useSyncTransport({ selectedIds: view.ids, selectedDate, initialSeekMs: link.atMs })
  const sound = usePlaybackSound()

  const cameras = useMemo(() => ov.overview ?? [], [ov.overview])
  const camById = useMemo(() => new Map(cameras.map((c) => [c.camera_id, c])), [cameras])
  const recOn = (id: number) => (selectedDate ? ov.recByCamDate.get(id)?.get(selectedDate) : undefined)

  // One timeline track per camera on screen. Memoized so the tracks, which
  // are too, sit out the 4 Hz playhead re-renders.
  const timelineRows: TimelineRow[] = useMemo(
    () =>
      view.ids.flatMap((id) => {
        const cam = camById.get(id)
        return cam
          ? [{
              id,
              name: cam.camera_name,
              segments: tp.segsByCam[id] || NO_SEGMENTS,
              liveEdgeMs: tp.liveEdges[id] ?? null,
              motion: tp.motionByCam[id] ?? null,
            }]
          : []
      }),
    [view.ids, camById, tp.segsByCam, tp.liveEdges, tp.motionByCam],
  )

  const isLandscape = useMediaQuery('(orientation: landscape)')

  // ---- Fullscreen ----------------------------------------------------------
  // A CSS overlay: iPhone Safari only lets a <video> go fullscreen, and that
  // would drop the timeline and the swipe. Where the browser does allow
  // element fullscreen (Android), it's requested too.
  const boxRef = useRef<HTMLDivElement>(null)
  const [immersive, setImmersive] = useState(false)
  const enterImmersive = () => {
    setImmersive(true)
    const el = boxRef.current
    if (el && document.fullscreenEnabled && !document.fullscreenElement) {
      el.requestFullscreen?.().catch(() => { /* overlay alone is fine */ })
    }
  }
  const exitImmersive = useCallback(() => {
    setImmersive(false)
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {})
  }, [])
  useEffect(() => {
    if (!immersive) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') exitImmersive() }
    // Leaving browser fullscreen (Android back gesture) leaves the overlay too.
    const onFs = () => { if (!document.fullscreenElement) setImmersive(false) }
    window.addEventListener('keydown', onKey)
    document.addEventListener('fullscreenchange', onFs)
    return () => {
      window.removeEventListener('keydown', onKey)
      document.removeEventListener('fullscreenchange', onFs)
    }
  }, [immersive, exitImmersive])

  // ---- Controls over the video (landscape, fullscreen) ---------------------
  // There the video gets the whole box and the timeline and transport lie
  // over its lower part. A tap on the video shows or hides them; while it
  // plays they step aside on their own.
  const overVideo = immersive || isLandscape
  const [chrome, setChrome] = useState(true)
  const [chromeTouch, setChromeTouch] = useState(0)
  const pokeChrome = useCallback(() => {
    setChrome(true)
    setChromeTouch((n) => n + 1)
  }, [])
  useEffect(() => {
    if (overVideo) pokeChrome()
  }, [overVideo, pokeChrome])
  const scrubbing = tp.previewMs != null
  useEffect(() => {
    if (!overVideo || !chrome || !tp.playing || scrubbing) return
    const id = window.setTimeout(() => setChrome(false), CHROME_HIDE_MS)
    return () => window.clearTimeout(id)
  }, [overVideo, chrome, tp.playing, scrubbing, chromeTouch])

  // ---- The camera on screen ------------------------------------------------
  const target = view.mode === 'quad' ? view.quad[view.active] || null : view.single
  const targetCam = target != null ? camById.get(target) : undefined
  const tileOf = (id: number) => (view.mode === 'quad' ? view.quad.indexOf(id) : -1)
  const soundNote = sound.muted || target == null
    ? null
    : sound.soundByCam[target] === false
      ? t('playback.noSound')
      : tp.rate !== 1
        ? t('playback.soundAt1x')
        : null

  // ---- Days ----------------------------------------------------------------
  const days = useMemo(() => [...ov.markedDates].sort(), [ov.markedDates])
  const prevDay = selectedDate ? days.filter((d) => d < selectedDate).pop() ?? null : null
  const nextDay = selectedDate ? days.find((d) => d > selectedDate) ?? null : null
  const [calOpen, setCalOpen] = useState(false)
  const selectDate = (date: string) => {
    setCalOpen(false)
    if (date === selectedDate || !ov.markedDates.has(date)) return // nothing recorded that day
    const swapped = view.setDay(date)
    tp.resetDay()
    if (swapped) {
      showInfo(t('playback.switchedCamera', {
        from: camById.get(swapped.from)?.camera_name ?? '',
        to: camById.get(swapped.to)?.camera_name ?? '',
      }))
    }
  }

  // ---- Touch on the video --------------------------------------------------
  // A horizontal swipe in Single moves between cameras (off for a fisheye
  // camera, where a drag pans the dewarped view). A tap plays or pauses, or
  // shows/hides the controls when they lie over the video; in the quad it
  // selects the tile, and a second tap shows that camera alone.
  const gesture = useRef<{ x: number; y: number; t: number } | null>(null)
  const lastTap = useRef<{ tile: number; t: number } | null>(null)
  const singleIsFisheye = view.single != null && !!cameraAspects[view.single]?.fisheye
  const onPointerDown = (e: React.PointerEvent) => {
    gesture.current = null
    if (!e.isPrimary) return
    if ((e.target as HTMLElement).closest('button, input, select, label, a, [role="slider"], [data-controls]')) return
    gesture.current = { x: e.clientX, y: e.clientY, t: e.timeStamp }
  }
  const onPointerUp = (e: React.PointerEvent) => {
    const g = gesture.current
    gesture.current = null
    if (!g) return
    const dx = e.clientX - g.x
    const dy = e.clientY - g.y
    const dt = e.timeStamp - g.t
    if (view.mode === 'single' && !singleIsFisheye && Math.abs(dx) > 48 && Math.abs(dx) > 2 * Math.abs(dy) && dt < 600) {
      view.step(dx < 0 ? 1 : -1)
      return
    }
    if (Math.abs(dx) > 10 || Math.abs(dy) > 10 || dt > 500) return
    if (view.mode === 'single') {
      if (overVideo) setChrome((on) => !on)
      else tp.togglePlay()
      return
    }
    const cell = (e.target as HTMLElement).closest<HTMLElement>('[data-tile]')
    if (!cell) return
    const i = Number(cell.dataset.tile)
    const last = lastTap.current
    lastTap.current = { tile: i, t: e.timeStamp }
    if (last && last.tile === i && e.timeStamp - last.t < DOUBLE_TAP_MS) {
      lastTap.current = null
      view.showAlone(i)
    } else if (overVideo && view.active === i) {
      setChrome((on) => !on)
    } else {
      view.focusTile(i)
      if (overVideo) pokeChrome()
    }
  }

  const renderTile = (id: number, bare: boolean) => {
    const cam = camById.get(id)
    if (!cam) return null
    return (
      <SyncPlaybackTile
        key={`${id}:${selectedDate}`}
        cameraId={id}
        cameraName={cam.camera_name}
        segments={tp.segsByCam[id] || NO_SEGMENTS}
        liveEdgeMs={tp.liveEdges[id] ?? null}
        masterMs={tp.masterMs}
        playing={tp.playing}
        rate={tp.rate}
        muted={sound.muted || id !== target}
        active={id === target}
        onActivate={noop}
        voiceFocus={sound.voiceFocus}
        onSound={sound.onSound}
        fill
        bare={bare}
        {...(cameraAspects[id] ?? {})}
      />
    )
  }

  // ---- Nothing to play -----------------------------------------------------
  if (!ov.loading && (ov.error || cameras.length === 0)) {
    return (
      <section className="-m-4 h-[calc(100dvh-3rem)] flex flex-col bg-[var(--panel-2)] overflow-hidden">
        <PhoneHeader title={t('playback.title')} />
        <div className="flex-1 flex flex-col items-center justify-center gap-1 p-6 text-center">
          <Film size={40} className="mb-2 opacity-30" aria-hidden="true" />
          <p className="text-[var(--text-dim)]">{ov.error || t('playback.noRecordings')}</p>
          <p className="text-sm text-[var(--text-dim)]">
            {ov.error ? t('playback.tryRefreshing') : t('playback.recordingsAppear')}
          </p>
          <button onClick={() => ov.reload()} className="btn-primary btn mt-4">
            {t('playback.refresh')}
          </button>
        </div>
      </section>
    )
  }

  // ---- Controls ------------------------------------------------------------
  const zoomPresets = (
    <div role="group" aria-label={t('playback.zoom')} className="flex shrink-0 border-l border-[var(--border)]">
      {ZOOMS.map((z, i) => (
        <button
          key={z.label}
          type="button"
          onClick={() => tp.applyZoom(i)}
          aria-pressed={i === tp.zoomIdx}
          className={clsx(
            'w-10 font-mono text-[11px]',
            i === tp.zoomIdx ? 'bg-[var(--accent)] text-white' : 'text-[var(--text-dim)] active:bg-[var(--panel)]',
          )}
        >
          {z.label}
        </button>
      ))}
    </div>
  )

  const dayRow = (
    <div className="h-10 shrink-0 flex items-stretch border-b border-[var(--border)] bg-[var(--panel-2)]">
      <button
        type="button"
        onClick={() => prevDay && selectDate(prevDay)}
        disabled={!prevDay}
        aria-label={t('playback.prevDay')}
        title={t('playback.prevDay')}
        className="w-10 shrink-0 flex items-center justify-center text-[var(--text-dim)] active:bg-[var(--panel)] disabled:opacity-30"
      >
        <ChevronLeft size={18} />
      </button>
      <button
        type="button"
        onClick={() => setCalOpen(true)}
        title={t('playback.selectDate')}
        className="flex-1 min-w-0 flex items-center justify-center gap-1.5 px-1 text-[13px] font-medium text-[var(--text)] active:bg-[var(--panel)]"
      >
        <CalendarDays size={14} className="shrink-0 text-[var(--text-dim)]" aria-hidden="true" />
        <span className="truncate">{selectedDate ? formatDay(selectedDate, fmt) : t('playback.selectDate')}</span>
        <ChevronDown size={12} className="shrink-0 text-[var(--text-dim)]" aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={() => nextDay && selectDate(nextDay)}
        disabled={!nextDay}
        aria-label={t('playback.nextDay')}
        title={t('playback.nextDay')}
        className="w-10 shrink-0 flex items-center justify-center text-[var(--text-dim)] active:bg-[var(--panel)] disabled:opacity-30"
      >
        <ChevronRight size={18} />
      </button>
      {!overVideo && zoomPresets}
    </div>
  )

  const timelineReady = tp.view.end > tp.view.start
  // The wrapper keeps the timeline's full height while it loads, so the
  // list below doesn't jump.
  const timeline = (
    <div className={clsx('flex flex-col justify-end px-4 pt-1', !overVideo && (view.mode === 'single' ? 'min-h-[6.75rem]' : 'min-h-[8.3125rem]'))}>
      {!timelineReady ? (
        <div className="flex-1 min-h-12 flex items-center justify-center text-[var(--text-dim)]">
          <Loader2 size={18} className="animate-spin" aria-label={t('playback.loadingRecordings')} />
        </div>
      ) : (
        <ActivityTimeline
          rows={timelineRows}
          viewStart={tp.view.start}
          viewEnd={tp.view.end}
          currentTime={tp.effectiveCurrent}
          onSeek={tp.seekTo}
          onScrubPreview={tp.setPreviewMs}
          onZoomAt={tp.zoomAt}
          onPan={tp.panBy}
          labels={view.mode === 'quad'}
          rowHeight={view.mode === 'quad' ? 18 : 56}
          activeId={target}
          onRowClick={(id) => view.focusTile(Math.max(0, view.quad.indexOf(id)))}
        />
      )}
    </div>
  )

  const transport = (
    <div className="h-12 shrink-0 flex items-stretch">
      <Ctl aria-label={t('playback.back10')} title={t('playback.back10')} onClick={() => tp.seekBy(-SKIP_MS)}>
        <SkipTen back />
      </Ctl>
      <Ctl
        aria-label={tp.playing ? t('video.pause') : t('video.play')}
        title={tp.playing ? t('video.pause') : t('video.play')}
        onClick={tp.togglePlay}
        tone="accent"
      >
        {tp.playing ? <Pause size={24} fill="currentColor" /> : <Play size={24} fill="currentColor" />}
      </Ctl>
      <Ctl aria-label={t('playback.forward10')} title={t('playback.forward10')} onClick={() => tp.seekBy(SKIP_MS)}>
        <SkipTen />
      </Ctl>
      {tp.motion && (
        <>
          <Divider />
          <Ctl aria-label={t('playback.prevActivity')} title={t('playback.prevActivity')} onClick={() => tp.jumpToActivity(-1)} tone="motion">
            <SkipBack size={18} />
          </Ctl>
          <Ctl
            aria-label={t('playback.skipQuiet')}
            title={t(tp.skipQuiet ? 'playback.skipQuietOn' : 'playback.skipQuiet')}
            aria-pressed={tp.skipQuiet}
            onClick={tp.toggleSkipQuiet}
            tone="motion"
            active={tp.skipQuiet}
          >
            <Activity size={18} />
          </Ctl>
          <Ctl aria-label={t('playback.nextActivity')} title={t('playback.nextActivity')} onClick={() => tp.jumpToActivity(1)} tone="motion">
            <SkipForward size={18} />
          </Ctl>
        </>
      )}
      <Divider />
      {/* Speed: the number is the button; the picker is the phone's own. */}
      <label className="relative h-12 flex-1 min-w-0 max-w-14 flex items-center justify-center font-mono text-[13px] font-semibold tabular-nums text-[var(--text)] active:bg-[var(--panel)]">
        <span aria-hidden="true">{tp.rate}x</span>
        <select
          aria-label={t('playback.speed')}
          value={tp.rateIdx}
          onChange={(e) => tp.setRateIdx(Number(e.target.value))}
          className="absolute inset-0 w-full h-full opacity-0 text-base"
        >
          {SPEEDS.map((s, i) => (
            <option key={s} value={i}>{s}x</option>
          ))}
        </select>
      </label>
      {target != null && (
        <Ctl
          aria-label={sound.muted ? t('live.soundOn') : t('live.soundOff')}
          title={sound.muted ? t('live.soundOn') : t('live.soundOff')}
          aria-pressed={!sound.muted}
          onClick={sound.toggleMute}
          active={!sound.muted}
        >
          {sound.muted ? <VolumeX size={18} /> : <Volume2 size={18} />}
        </Ctl>
      )}
      {!sound.muted && (
        <VoiceFocusButton
          level={sound.voiceFocus}
          onChange={sound.setVoiceFocus}
          size={18}
          className="h-12 flex-1 min-w-0 max-w-14 flex items-center justify-center"
        />
      )}
      {overVideo && <div className="ml-auto flex items-stretch">{zoomPresets}</div>}
    </div>
  )

  return (
    // -m-4 cancels <main>'s padding; dvh, not vh, so iOS's collapsing
    // toolbars don't push the bottom of the list off screen.
    <section className="-m-4 h-[calc(100dvh-3rem)] flex flex-col bg-[var(--panel-2)] overflow-hidden">
      <PhoneHeader title={t('playback.title')}>
        <div role="group" aria-label={t('live.layouts')} className="flex border-l border-[var(--border)]">
          {(['single', 'quad'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => view.setMode(m)}
              aria-pressed={view.mode === m}
              aria-label={m === 'single' ? t('live.viewSingle') : t('live.viewQuad')}
              title={m === 'single' ? t('live.viewSingle') : t('live.viewQuad')}
              className={clsx(
                'w-11 h-11 font-mono text-[13px] font-semibold',
                view.mode === m ? 'bg-[var(--accent)] text-white' : 'text-[var(--text-dim)] active:bg-[var(--panel)]',
              )}
            >
              {m === 'single' ? '1' : '4'}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={enterImmersive}
          aria-label={t('live.fullscreen')}
          title={t('live.fullscreen')}
          className="w-11 h-11 flex items-center justify-center border-l border-[var(--border)] text-[var(--text-dim)] active:bg-[var(--panel)]"
        >
          <Maximize size={18} />
        </button>
      </PhoneHeader>
      {!ov.mediamtxAvailable && (
        <p className="shrink-0 px-3 py-1.5 text-[12px] text-[var(--warn)] border-b border-[var(--border)]">{t('playback.serverOffline')}</p>
      )}

      {/* Portrait scrolls as a whole only when the screen is too short to
          leave the camera list its minimum height. */}
      <div className={clsx('flex-1 min-h-0 flex', isLandscape ? 'flex-row' : 'flex-col overflow-y-auto overscroll-contain')}>
        {/* Stage: 16:9 across the top in portrait, the whole box in
            landscape. In fullscreen the same element turns into a fixed
            overlay, so the tiles keep their playback sessions. */}
        <div ref={boxRef} className={clsx(
          'bg-black',
          immersive
            // eslint-disable-next-line no-restricted-syntax -- not a dialog: the playback stage itself goes fullscreen, staying mounted so sessions aren't re-created
            ? 'fixed inset-0 z-[60] pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]'
            : isLandscape ? 'flex-1 min-w-0' : 'shrink-0 w-full aspect-video',
        )}>
          <div
            onPointerDown={onPointerDown}
            onPointerUp={onPointerUp}
            onPointerCancel={() => { gesture.current = null }}
            className="relative w-full h-full overflow-hidden touch-pan-y"
          >
            {ov.loading ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-white/50" style={{ background: NO_PICTURE_BG }}>
                <Loader2 size={22} className="animate-spin text-[var(--accent)]" />
                <span className="text-[12px]">{t('playback.loadingRecordings')}</span>
              </div>
            ) : view.mode === 'single' ? (
              <>
                <div className="absolute inset-0">{view.single != null && renderTile(view.single, true)}</div>
                {/* The camera's name is the camera menu. A native picker:
                    it opens over anything, fullscreen included. */}
                <div className="pointer-events-none absolute inset-x-0 top-0 z-20 h-12 bg-gradient-to-b from-black/75 to-transparent" />
                <label className="absolute left-0 top-0 z-30 max-w-[80%] h-11 flex items-center gap-1 pl-2.5 pr-3 text-white [text-shadow:0_1px_2px_rgba(0,0,0,0.9)]">
                  <span className="truncate text-[13px] font-medium">{targetCam?.camera_name ?? '…'}</span>
                  <ChevronDown size={14} className="shrink-0" aria-hidden="true" />
                  {!sound.muted && <Volume2 size={12} className="shrink-0 text-[var(--accent)]" aria-hidden="true" />}
                  <select
                    aria-label={t('playback.cameraMenu')}
                    value={view.single ?? ''}
                    onChange={(e) => view.pick(Number(e.target.value))}
                    className="absolute inset-0 w-full h-full opacity-0 text-base"
                  >
                    {cameras.map((c) => {
                      const has = !!recOn(c.camera_id)
                      return (
                        <option key={c.camera_id} value={c.camera_id} disabled={!has && c.camera_id !== view.single}>
                          {has ? c.camera_name : `${c.camera_name} (${t('playback.noneThatDay')})`}
                        </option>
                      )
                    })}
                  </select>
                </label>
              </>
            ) : (
              <div className="absolute inset-0 grid grid-cols-2 grid-rows-2 gap-px bg-[#1a1f29]">
                {view.quad.map((id, i) => (
                  <div
                    key={i}
                    data-tile={i}
                    role="button"
                    tabIndex={0}
                    aria-label={t('live.tileN', { n: i + 1 })}
                    aria-current={view.active === i ? 'true' : undefined}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') view.focusTile(i) }}
                    className="relative min-w-0 min-h-0"
                  >
                    {(id && renderTile(id, false)) || (
                      <div className="absolute inset-0 flex items-center justify-center p-2 text-center text-white/45 text-[10px] font-mono uppercase tracking-[0.15em]" style={{ background: NO_PICTURE_BG }}>
                        {view.active === i ? t('live.pickFromList') : t('live.tileN', { n: i + 1 })}
                      </div>
                    )}
                    {view.active === i && (
                      <div className="pointer-events-none absolute inset-0 z-30 ring-2 ring-inset ring-[var(--accent)]" />
                    )}
                    <span className="pointer-events-none absolute right-1 bottom-1 z-30 px-1 font-mono text-[10px] leading-4 bg-black/60 text-white/80">{i + 1}</span>
                  </div>
                ))}
              </div>
            )}

            {soundNote && (
              <span className="pointer-events-none absolute left-2.5 top-11 z-30 px-1.5 py-0.5 bg-black/60 text-[10px] text-white/85">{soundNote}</span>
            )}

            {immersive && (
              <button
                type="button"
                onClick={exitImmersive}
                aria-label={t('video.exitFullscreen')}
                title={t('video.exitFullscreen')}
                className="absolute z-40 top-10 right-2 w-11 h-11 flex items-center justify-center bg-black/55 text-white active:bg-black/80"
              >
                <Minimize size={18} />
              </button>
            )}

            {overVideo && (
              <div
                data-controls
                inert={!chrome}
                onPointerDown={pokeChrome}
                className={clsx(
                  'absolute inset-x-0 bottom-0 z-40 border-t border-[var(--border)] text-[var(--text)] bg-[color-mix(in_oklab,var(--panel-2)_90%,transparent)] transition-opacity duration-200',
                  chrome ? 'opacity-100' : 'opacity-0 pointer-events-none',
                )}
              >
                {timeline}
                {transport}
              </div>
            )}
          </div>
        </div>

        {!overVideo && (
          <div className="shrink-0 border-b border-[var(--border)]">
            {dayRow}
            {timeline}
            {transport}
          </div>
        )}

        {/* Every camera, one tap away. */}
        <nav
          aria-label={t('live.cameraList')}
          className={clsx(
            'overflow-y-auto overscroll-contain',
            isLandscape ? 'min-h-0 w-[min(40%,16rem)] shrink-0 border-l border-[var(--border)]' : 'flex-1 min-h-[7.5rem]',
          )}
        >
          <div className="sticky top-0 z-10 bg-[var(--panel-2)]">
            {isLandscape && dayRow}
            <div className="min-h-9 flex items-center gap-2 pl-3 border-b border-[var(--border)]">
              <p aria-live="polite" className="flex-1 min-w-0 py-1.5 text-[11px] leading-tight text-[var(--text-dim)]">
                {view.mode === 'quad'
                  ? t('live.pickForTile', { n: view.active + 1 })
                  : <span className="font-semibold uppercase tracking-[0.12em]">{t('live.cameraList')} <span className="font-mono tabular-nums font-normal">· {cameras.length}</span></span>}
              </p>
              {view.mode === 'quad' && view.quad[view.active] !== 0 && (
                <button
                  type="button"
                  onClick={() => view.showAlone(view.active)}
                  aria-label={t('live.showAlone')}
                  title={t('live.showAlone')}
                  className="w-11 h-11 shrink-0 flex items-center justify-center border-l border-[var(--border)] text-[var(--text-dim)] active:bg-[var(--panel)]"
                >
                  <Maximize2 size={16} />
                </button>
              )}
            </div>
          </div>
          <ul className={clsx(
            'grid gap-1.5 p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]',
            isLandscape ? 'grid-cols-1' : 'grid-cols-2',
          )}>
            {ov.loading && Array.from({ length: 4 }, (_, i) => (
              <li key={i} className="h-12 border border-[var(--border)] bg-[var(--bg-2)] animate-pulse" />
            ))}
            {cameras.map((c) => {
              const rec = recOn(c.camera_id)
              const selected = c.camera_id === target
              const tile = tileOf(c.camera_id)
              const disabled = !rec && !selected && tile === -1
              return (
                <li key={c.camera_id} className="min-w-0">
                  <button
                    type="button"
                    onClick={() => view.pick(c.camera_id)}
                    disabled={disabled}
                    aria-pressed={selected}
                    title={rec ? t('playback.recordedThatDay', { duration: formatDuration(rec.total_duration) }) : t('playback.noneThatDay')}
                    className={clsx(
                      'w-full min-h-12 flex items-center gap-2 px-2.5 text-left border',
                      selected
                        ? 'border-[var(--accent)] bg-[color-mix(in_oklab,var(--accent)_16%,transparent)] text-[var(--text)]'
                        : 'border-[var(--border)] bg-[var(--bg-2)] text-[var(--text)] active:bg-[var(--panel)]',
                      disabled && 'opacity-45',
                    )}
                  >
                    <span className={clsx('flex-1 min-w-0 truncate text-[13px]', !rec && 'text-[var(--text-dim)]')}>{c.camera_name}</span>
                    {tile !== -1 ? (
                      <span className="shrink-0 w-5 h-5 flex items-center justify-center font-mono text-[11px] border border-[var(--border)] text-[var(--text-dim)]">
                        <span aria-hidden="true">{tile + 1}</span>
                        <span className="sr-only">{t('live.inTileN', { n: tile + 1 })}</span>
                      </span>
                    ) : (
                      <span className="shrink-0 font-mono text-[10px] tabular-nums text-[var(--text-dim)]">
                        {rec ? formatDuration(rec.total_duration) : '—'}
                      </span>
                    )}
                  </button>
                </li>
              )
            })}
          </ul>
        </nav>
      </div>

      <Modal
        open={calOpen}
        onClose={() => setCalOpen(false)}
        title={t('playback.selectDate')}
        widthClassName="w-[21rem] max-w-[calc(100vw-1rem)]"
        bodyClassName="p-3"
      >
        <RecordingCalendar selected={selectedDate} onSelect={selectDate} markedDates={ov.markedDates} size="touch" />
      </Modal>
    </section>
  )
}

const noop = () => {}

function PhoneHeader({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <header className="h-11 shrink-0 flex items-center gap-2 pl-3 border-b border-[var(--border)] bg-[color-mix(in_oklab,var(--bg-2)_55%,var(--panel-2))]">
      <MonitorPlay size={14} className="text-[var(--text-dim)] shrink-0" aria-hidden="true" />
      <h1 className="min-w-0 truncate text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--text)]">{title}</h1>
      <div className="ml-auto flex items-center shrink-0">{children}</div>
    </header>
  )
}

const CTL_INK = { text: 'text-[var(--text)]', accent: 'text-[var(--accent)]', motion: 'text-[var(--motion)]' }
const CTL_ON = { text: 'bg-[var(--accent)]', accent: 'bg-[var(--accent)]', motion: 'bg-[var(--motion)]' }

/** One transport control: 48px tall, sharing the row's width evenly. */
function Ctl({
  active = false,
  tone = 'text',
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean; tone?: keyof typeof CTL_INK }) {
  return (
    <button
      type="button"
      {...rest}
      className={clsx(
        'h-12 flex-1 min-w-0 max-w-14 flex items-center justify-center',
        active ? `${CTL_ON[tone]} text-white` : `${CTL_INK[tone]} active:bg-[var(--panel)]`,
      )}
    >
      {children}
    </button>
  )
}

function Divider() {
  return <span aria-hidden="true" className="w-px shrink-0 my-3 bg-[var(--border)]" />
}

/** The 10-second skip glyph: a turning arrow around a "10". */
function SkipTen({ back = false }: { back?: boolean }) {
  const Arrow = back ? RotateCcw : RotateCw
  return (
    <span className="relative flex items-center justify-center" aria-hidden="true">
      <Arrow size={24} strokeWidth={1.5} />
      <span className="absolute pt-px font-mono text-[8px] font-bold leading-none">10</span>
    </span>
  )
}
