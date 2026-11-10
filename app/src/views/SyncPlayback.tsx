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

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Play,
  Pause,
  Square,
  Rewind,
  FastForward,
  Volume2,
  VolumeX,
  Maximize2,
  Minimize2,
  MonitorPlay,
  CalendarDays,
  ChevronDown,
  PanelRightClose,
  PanelRightOpen,
  Check,
  Loader2,
  Film,
  Video,
  Activity,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react'
import { warmHls } from '../lib/loadHls'
import { useCameraAspects } from '../lib/queries'
import { formatDuration, localDateKey } from '../lib/time'
import { useSnackbar } from '../components/Snackbar'
import { useTranslation, useDateFormat } from '../i18n'
import { RecordingCalendar } from '../components/RecordingCalendar'
import { PaneResizer } from '../components/PaneResizer'
import { useElementSize } from '../hooks/useElementSize'
import { useIsPhoneLayout } from '../hooks/useIsPhoneLayout'
import { usePaneExtra } from '../hooks/usePaneExtra'
import { MultiCamTimeline, type TimelineRow } from '../components/MultiCamTimeline'
import { SyncPlaybackTile } from '../components/SyncPlaybackTile'
import { VoiceFocusButton } from '../components/VoiceFocusButton'
import { PhoneRecordings } from './playback/PhoneRecordings'
import {
  MAX_TILES,
  SPEEDS,
  ZOOMS,
  formatDateLong,
  latestDay,
  usePlaybackDeepLink,
  usePlaybackSound,
  useRecordingsOverview,
  useSyncTransport,
  type DailyRecording,
  type OverviewCamera,
} from './playback/syncPlaybackEngine'

/** Least height the video wall keeps when the timeline pane is dragged
 *  taller, and the most the pane may grow (a phone's page is not
 *  height-bound, so nothing else stops it). */
const MIN_GRID_PX = 160
const MAX_PANE_EXTRA_PX = 480

/**
 * Recordings. Phones get their own view, one camera (or four) with the
 * timeline and every camera underneath to tap; everything wider gets the
 * grid with the calendar and checklist beside it. Chosen in JS, not CSS, so
 * only one of them holds playback sessions. Both run on the engine in
 * views/playback/syncPlaybackEngine.ts.
 */
export function SyncPlayback() {
  return useIsPhoneLayout() ? <PhoneRecordings /> : <DesktopSyncPlayback />
}

/**
 * CP-Plus-style synchronized playback: a grid of cameras playing the same
 * wall-clock instant, a calendar marking days that have footage, a camera
 * checklist, and one multi-track timeline driving every tile.
 */
function DesktopSyncPlayback() {
  const fmt = useDateFormat()
  const { t } = useTranslation()
  const { showError } = useSnackbar()
  const stageRef = useRef<HTMLDivElement>(null)
  // Per-camera display-aspect settings for the grid tiles (#354).
  const cameraAspects = useCameraAspects()

  // Download the hls.js chunk while the overview request is in flight — the
  // tiles will need it the moment segments land.
  useEffect(() => {
    warmHls()
  }, [])

  // ---- Overview: which cameras have recordings on which days ---------------
  const {
    overview,
    loading: overviewLoading,
    error: overviewError,
    mediamtxAvailable,
    reload: loadOverview,
    markedDates,
    recByCamDate,
  } = useRecordingsOverview()

  // ---- Deep link (?camera=&at=), read once ---------------------------------
  const link = usePlaybackDeepLink()

  // ---- Selection -----------------------------------------------------------
  const [selectedDate, setSelectedDate] = useState<string | null>(
    link.atMs != null ? localDateKey(link.atMs) : null,
  )
  const [selectedIds, setSelectedIds] = useState<number[]>(
    link.camera != null ? [link.camera] : [],
  )
  const [activeId, setActiveId] = useState<number | null>(link.camera)
  const [calOpen, setCalOpen] = useState(true)
  const [panelOpen, setPanelOpen] = useState(() => {
    try {
      return localStorage.getItem('opennvr.syncplayback.panel') !== '0'
    } catch {
      return true
    }
  })

  const togglePanel = () =>
    setPanelOpen((o) => {
      try {
        localStorage.setItem('opennvr.syncplayback.panel', o ? '0' : '1')
      } catch {
        /* storage unavailable: keep in-memory state */
      }
      return !o
    })

  // ---- Transport (the shared master clock) and sound -----------------------
  const {
    segsByCam,
    liveEdges,
    segsLoading,
    motionByCam,
    motion,
    masterMs,
    playing,
    rateIdx,
    view,
    zoomIdx,
    setPreviewMs,
    effectiveCurrent,
    skipQuiet,
    toggleSkipQuiet,
    resetDay,
    seekTo,
    togglePlay,
    jumpToActivity,
    stop,
    changeSpeed,
    applyZoom,
    panBy,
    zoomAt,
  } = useSyncTransport({ selectedIds, selectedDate, initialSeekMs: link.atMs })
  const { muted, toggleMute, voiceFocus, setVoiceFocus, soundByCam, onSound } = usePlaybackSound()
  const [isFullscreen, setIsFullscreen] = useState(false)

  // Default selection once the overview lands: latest day with footage, and
  // the first few cameras that recorded that day.
  useEffect(() => {
    if (!overview || selectedDate) return
    const latest = latestDay(overview)
    if (!latest) return
    const ids = overview.filter((c) => c.recordings.some((r) => r.date === latest)).map((c) => c.camera_id)
    setSelectedDate(latest)
    // A link that named a camera but no instant still means THAT camera —
    // landing on the fleet's latest day with five other tiles up is not
    // what "open this camera" asked for.
    setSelectedIds(link.camera != null ? [link.camera] : ids.slice(0, MAX_TILES))
    setActiveId(link.camera ?? ids[0] ?? null)
  }, [overview, selectedDate, link.camera])

  // Footage recorded on the selected day: total seconds + cameras that have any.
  const dayTotal = useMemo(() => {
    if (!selectedDate) return { seconds: 0, cams: 0 }
    let seconds = 0
    let cams = 0
    for (const c of overview || []) {
      const rec = recByCamDate.get(c.camera_id)?.get(selectedDate)
      if (rec) {
        seconds += rec.total_duration || 0
        cams++
      }
    }
    return { seconds, cams }
  }, [overview, recByCamDate, selectedDate])

  // Fullscreen tracking.
  useEffect(() => {
    const onFs = () => setIsFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', onFs)
    return () => document.removeEventListener('fullscreenchange', onFs)
  }, [])

  // ---- Handlers ------------------------------------------------------------
  const selectDate = (date: string) => {
    if (date === selectedDate) return
    if (!markedDates.has(date)) return // nothing recorded that day
    const avail = (overview || []).filter((c) => c.recordings.some((r) => r.date === date)).map((c) => c.camera_id)
    setSelectedDate(date)
    resetDay()
    setSelectedIds((prev) => {
      const kept = prev.filter((id) => avail.includes(id))
      return kept.length ? kept : avail.slice(0, 1)
    })
  }

  const toggleCamera = useCallback(
    (id: number) => {
      setSelectedIds((prev) => {
        if (prev.includes(id)) {
          const next = prev.filter((x) => x !== id)
          setActiveId((a) => (a === id ? next[0] ?? null : a))
          return next
        }
        if (prev.length >= MAX_TILES) {
          showError(`Up to ${MAX_TILES} cameras can play together`)
          return prev
        }
        setActiveId((a) => (a == null ? id : a))
        return [...prev, id]
      })
    },
    [showError]
  )

  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen?.()
    else stageRef.current?.requestFullscreen?.()
  }

  // ---- Layout derivations --------------------------------------------------
  const selectedCams = useMemo(
    () => selectedIds.map((id) => (overview || []).find((c) => c.camera_id === id)).filter(Boolean) as OverviewCamera[],
    [selectedIds, overview]
  )
  const cols = Math.max(1, Math.ceil(Math.sqrt(selectedCams.length)))
  const rows = Math.max(1, Math.ceil(selectedCams.length / cols))

  const timelineRows: TimelineRow[] = useMemo(
    () =>
      selectedCams.map((c) => ({
        id: c.camera_id,
        name: c.camera_name,
        segments: segsByCam[c.camera_id] || [],
        liveEdgeMs: liveEdges[c.camera_id] ?? null,
        motion: motionByCam[c.camera_id] ?? null,
      })),
    [selectedCams, segsByCam, liveEdges, motionByCam]
  )

  const activeCam = selectedCams.find((c) => c.camera_id === activeId)

  // ---- Resizable bottom pane ---------------------------------------------
  // Dragging the transport bar's top edge up gives the timeline rows height
  // the video wall gives up. The measured wall already excludes the extra it
  // gave up last render, so that is added back to get the room.
  const [gridRef, gridBox] = useElementSize<HTMLDivElement>()
  const [paneExtra, setPaneExtra] = usePaneExtra('opennvr.syncplayback.timelineExtra')
  const appliedExtraRef = useRef(0)
  const gridRoom = Math.min(
    MAX_PANE_EXTRA_PX,
    gridBox.h + appliedExtraRef.current - MIN_GRID_PX
  )
  const paneExtraPx = Math.max(0, Math.min(paneExtra, gridRoom))
  appliedExtraRef.current = paneExtraPx
  const rowCount = timelineRows.length
  const rowPx =
    paneExtraPx > 0 && rowCount > 0
      ? (rowCount > 2 ? 10 : 12) + paneExtraPx / rowCount
      : undefined

  // ---- Render --------------------------------------------------------------
  // While the overview loads, the page frame renders immediately with
  // skeletons in the data slots (no full-page spinner: first useful paint
  // must not wait on the slowest API call).
  if (!overviewLoading && (overviewError || !overview || overview.length === 0)) {
    return (
      <div className="space-y-4">
        <PageTitle />
        <div className="bg-[var(--panel-2)] border border-[var(--border)] p-12 text-center">
          <Film size={48} className="mx-auto mb-4 opacity-30" />
          <p className="text-[var(--text-dim)]">
            {overviewError && (overviewError as any)?.message === 'API_NETWORK_ERROR'
              ? t('dashboard.failedRecordings')
              : overviewError || t('playback.noRecordings')}
          </p>
          <p className="text-sm text-[var(--text-dim)] mt-1">
            {overviewError ? t('playback.tryRefreshing') : t('playback.recordingsAppear')}
          </p>
          <button onClick={() => loadOverview()} className="btn-primary btn mt-4">
            {t('playback.refresh')}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2 lg:flex-row lg:h-[calc(100vh-5rem)]">
      {/* Stage: one panel in the dashboard widgets' grammar — slim header,
          the wall on black split by hairlines, transport and timeline as
          its footer. */}
      <div
        ref={stageRef}
        className="flex-1 min-w-0 flex flex-col min-h-0 border border-[var(--border)] bg-[var(--panel-2)] overflow-hidden"
      >
        <div className="h-8 shrink-0 flex items-center gap-2 px-2.5 border-b border-[var(--border)] bg-[color-mix(in_oklab,var(--bg-2)_55%,var(--panel-2))]">
          <MonitorPlay size={13} className="text-[var(--text-dim)] shrink-0" aria-hidden="true" />
          <h1 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--text)] whitespace-nowrap">{t('playback.pageTitle')}</h1>
          <span className="text-[11px] text-[var(--text-dim)] font-mono tabular-nums truncate min-w-0">
            {selectedDate && `${formatDateLong(selectedDate, fmt)} · `}
            {selectedCams.length} {t('playback.cameraCount')}
            {selectedDate && dayTotal.cams > 0 && (
              <span title={`Recorded on this day across ${dayTotal.cams} camera${dayTotal.cams !== 1 ? 's' : ''}`}>
                {` · ${formatDuration(dayTotal.seconds)} ${t('playback.recorded')}`}
              </span>
            )}
          </span>
          {!mediamtxAvailable && (
            <span className="text-[11px] text-[var(--warn)] truncate">Playback server offline — playback unavailable</span>
          )}
          {!isFullscreen && (
            <button
              onClick={togglePanel}
              title={panelOpen ? 'Hide calendar & camera panel' : 'Show calendar & camera panel'}
              aria-label={panelOpen ? 'Hide calendar & camera panel' : 'Show calendar & camera panel'}
              className="ml-auto p-0.5 text-[var(--text-dim)] hover:text-[var(--text)]"
            >
              {panelOpen ? <PanelRightClose size={14} /> : <PanelRightOpen size={14} />}
            </button>
          )}
        </div>

        {/* Video grid */}
        <div
          ref={gridRef}
          className="flex-1 min-h-0 grid gap-px bg-[#1a1f29]"
          style={{
            gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
            gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
          }}
        >
          {overviewLoading ? (
            <div className="bg-black animate-pulse flex flex-col items-center justify-center gap-2 py-16 text-white/50">
              <Loader2 size={22} className="animate-spin text-[var(--accent)]" />
              <span className="text-sm">{t('playback.loadingRecordings')}</span>
            </div>
          ) : selectedCams.length === 0 ? (
            <div className="bg-black flex flex-col items-center justify-center gap-2 py-16 text-white/45">
              <Video size={20} />
              <span className="text-[10px] font-mono uppercase tracking-[0.2em]">{t('playback.selectCameras')}</span>
            </div>
          ) : (
            selectedCams.map((cam) => (
              <SyncPlaybackTile
                key={`${cam.camera_id}:${selectedDate}`}
                cameraId={cam.camera_id}
                cameraName={cam.camera_name}
                segments={segsByCam[cam.camera_id] || []}
                liveEdgeMs={liveEdges[cam.camera_id] ?? null}
                masterMs={masterMs}
                playing={playing}
                rate={SPEEDS[rateIdx]}
                muted={muted || cam.camera_id !== activeId}
                active={cam.camera_id === activeId}
                onActivate={() => setActiveId(cam.camera_id)}
                voiceFocus={voiceFocus}
                onSound={onSound}
                {...(cameraAspects[cam.camera_id] ?? {})}
              />
            ))
          )}
        </div>

        {/* Transport controls. Their top edge is the bottom pane's: drag it
            up for taller timeline rows. */}
        <div className="relative shrink-0 flex items-center gap-0.5 px-1.5 py-0.5 border-t border-[var(--border)] flex-wrap">
          {timelineRows.length > 0 && view.end > view.start && (
            <PaneResizer
              value={paneExtraPx}
              onChange={setPaneExtra}
              max={() => gridRoom}
              label={t('playback.resizeTimeline')}
            />
          )}
          <IconBtn title={playing ? 'Pause' : 'Play'} onClick={togglePlay}>
            {playing ? <Pause size={16} /> : <Play size={16} />}
          </IconBtn>
          <IconBtn title="Stop (back to first footage)" onClick={stop}>
            <Square size={13} />
          </IconBtn>

          <div className="mx-1 flex items-center gap-0.5">
            <IconBtn title="Slower" onClick={() => changeSpeed(-1)}>
              <Rewind size={14} />
            </IconBtn>
            <span className="text-[11px] font-mono w-7 text-center tabular-nums">{SPEEDS[rateIdx]}x</span>
            <IconBtn title="Faster" onClick={() => changeSpeed(1)}>
              <FastForward size={14} />
            </IconBtn>
          </div>

          <IconBtn title={muted ? 'Unmute selected camera' : 'Mute'} onClick={toggleMute}>
            {muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
          </IconBtn>
          <VoiceFocusButton level={voiceFocus} onChange={setVoiceFocus} size={14} className="p-1" />
          {activeCam && (
            <span className="text-[11px] text-[var(--text-dim)] truncate max-w-40" title={`Audio: ${activeCam.camera_name}`}>
              {activeCam.camera_name}
              {!muted && soundByCam[activeCam.camera_id] === false
                ? ` · ${t('playback.noSound')}`
                : !muted && SPEEDS[rateIdx] !== 1
                  ? ` · ${t('playback.soundAt1x')}`
                  : ''}
            </span>
          )}

          {motion && (
            <div className="mx-1 flex items-center gap-0.5">
              <IconBtn title={t('playback.prevActivity')} onClick={() => jumpToActivity(-1)}>
                <ChevronLeft size={14} />
              </IconBtn>
              <button
                title={t(skipQuiet ? 'playback.skipQuietOn' : 'playback.skipQuiet')}
                aria-pressed={skipQuiet}
                onClick={toggleSkipQuiet}
                className={`p-1 transition-colors ${
                  skipQuiet
                    ? 'bg-[var(--motion)] text-white'
                    : 'text-[var(--motion)] hover:bg-[var(--panel)]'
                }`}
              >
                <Activity size={14} />
              </button>
              <IconBtn title={t('playback.nextActivity')} onClick={() => jumpToActivity(1)}>
                <ChevronRight size={14} />
              </IconBtn>
              {motion.pending > 0 && (
                <span
                  className="ml-0.5 flex items-center gap-1 text-[10px] font-mono tabular-nums text-[var(--text-dim)]"
                  title={t('playback.motionScoringProgress', {
                    percent: String(Math.floor(motion.progress * 100)),
                  })}
                >
                  <Loader2 size={11} className="animate-spin" />
                  {Math.floor(motion.progress * 100)}%
                </span>
              )}
            </div>
          )}

          <div className="flex-1" />

          <div className="flex items-center overflow-hidden border border-[var(--border)]">
            {ZOOMS.map((z, i) => (
              <button
                key={z.label}
                onClick={() => applyZoom(i)}
                className={`px-1.5 py-0.5 text-[10px] font-mono transition-colors ${
                  i === zoomIdx
                    ? 'bg-[var(--accent)] text-white'
                    : 'text-[var(--text-dim)] hover:bg-[var(--panel)]'
                }`}
              >
                {z.label}
              </button>
            ))}
          </div>

          <IconBtn title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'} onClick={toggleFullscreen}>
            {isFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </IconBtn>
        </div>

        {/* Multi-camera timeline */}
        {timelineRows.length > 0 && view.end > view.start && (
          <div className="shrink-0 px-2 pt-0.5 pb-1 border-t border-[var(--border)]">
            {segsLoading ? (
              <div className="h-16 flex items-center justify-center text-sm text-[var(--text-dim)]">
                <Loader2 size={16} className="animate-spin mr-2 text-[var(--accent)]" /> Loading timeline…
              </div>
            ) : (
              <MultiCamTimeline
                rows={timelineRows}
                viewStart={view.start}
                viewEnd={view.end}
                currentTime={effectiveCurrent}
                onSeek={seekTo}
                onScrubPreview={setPreviewMs}
                onZoomAt={zoomAt}
                onPan={panBy}
                activeId={activeId}
                onRowClick={setActiveId}
                rowHeight={rowPx}
              />
            )}
          </div>
        )}
      </div>

      {/* Side panel: calendar + camera checklist */}
      {panelOpen && (
      <aside className="w-full lg:w-60 xl:w-64 shrink-0 flex flex-col gap-2 min-h-0">
        {/* Date picker */}
        <div className="bg-[var(--panel-2)] border border-[var(--border)]">
          <button
            onClick={() => setCalOpen((o) => !o)}
            className="w-full h-8 flex items-center gap-2 px-2.5 bg-[color-mix(in_oklab,var(--bg-2)_55%,var(--panel-2))] hover:bg-[var(--panel)]"
            aria-expanded={calOpen}
          >
            <CalendarDays size={13} className="text-[var(--text-dim)]" />
            <span className="text-[11px] font-semibold uppercase tracking-[0.12em] truncate">{selectedDate ? formatDateLong(selectedDate, fmt) : t('playback.selectDate')}</span>
            <ChevronDown size={13} className={`ml-auto text-[var(--text-dim)] transition-transform ${calOpen ? '' : '-rotate-90'}`} />
          </button>
          {calOpen && (
            <div className="px-2.5 pb-2.5 border-t border-[var(--border)] pt-1.5">
              <RecordingCalendar selected={selectedDate} onSelect={selectDate} markedDates={markedDates} />
            </div>
          )}
        </div>

        {/* Camera checklist */}
        <div className="bg-[var(--panel-2)] border border-[var(--border)] flex flex-col min-h-0 lg:flex-1">
          <div className="shrink-0 h-8 flex items-center gap-2 px-2.5 border-b border-[var(--border)] bg-[color-mix(in_oklab,var(--bg-2)_55%,var(--panel-2))]">
            <Video size={13} className="text-[var(--text-dim)]" />
            <span className="text-[11px] font-semibold uppercase tracking-[0.12em]">{t('playback.cameras')}</span>
            <span className="ml-auto text-[11px] font-mono tabular-nums text-[var(--text-dim)]">
              {selectedIds.length}/{MAX_TILES}
            </span>
          </div>
          <CameraChecklist
            overview={overview}
            overviewLoading={overviewLoading}
            recByCamDate={recByCamDate}
            selectedDate={selectedDate}
            selectedIds={selectedIds}
            activeId={activeId}
            onToggle={toggleCamera}
          />
        </div>
      </aside>
      )}
    </div>
  )
}

function PageTitle() {
  const { t } = useTranslation()
  return (
    <h1 className="text-lg font-semibold flex items-center gap-2">
      <MonitorPlay size={20} className="text-[var(--accent)]" />
      {t('playback.pageTitle')}
    </h1>
  )
}

/**
 * Camera checkbox list. Memoized so master-clock ticks (which re-render the
 * parent 4x/second) never touch it — its props only change on data load,
 * date/selection change, or toggle.
 */
const CameraChecklist = memo(function CameraChecklist({
  overview,
  overviewLoading,
  recByCamDate,
  selectedDate,
  selectedIds,
  activeId,
  onToggle,
}: {
  overview: OverviewCamera[] | null
  overviewLoading: boolean
  recByCamDate: Map<number, Map<string, DailyRecording>>
  selectedDate: string | null
  selectedIds: number[]
  activeId: number | null
  onToggle: (id: number) => void
}) {
  return (
    <div className="overflow-y-auto sidebar-scroll max-h-64 lg:max-h-none">
      {overviewLoading &&
        Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="flex items-center gap-2 px-2.5 py-1.5 animate-pulse">
            <span className="w-4 h-4 bg-[var(--panel)]" />
            <span className="h-3 flex-1 bg-[var(--panel)]" />
          </div>
        ))}
      {(overview || []).map((cam) => {
        const rec = selectedDate ? recByCamDate.get(cam.camera_id)?.get(selectedDate) : undefined
        const checked = selectedIds.includes(cam.camera_id)
        const disabled = !rec && !checked
        return (
          <button
            key={cam.camera_id}
            onClick={() => !disabled && onToggle(cam.camera_id)}
            disabled={disabled}
            title={rec ? `${formatDuration(rec.total_duration)} recorded` : 'No recordings on this date'}
            className={`group w-full flex items-center gap-2 px-2.5 py-1.5 text-xs text-left transition-colors border-l-2 focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--accent)] ${
              cam.camera_id === activeId ? 'border-l-[var(--accent)] text-[var(--accent)]' : 'border-l-transparent'
            } ${checked ? 'bg-[var(--accent)]/10' : ''} ${
              disabled ? 'opacity-40 cursor-not-allowed' : 'hover:bg-[var(--panel)]'
            }`}
          >
            <span
              className={`shrink-0 w-4 h-4 border flex items-center justify-center transition-colors ${
                checked
                  ? 'bg-[var(--accent)] border-[var(--accent)]'
                  : `border-[var(--border)] ${disabled ? '' : 'group-hover:border-[var(--accent)]/60'}`
              }`}
            >
              {checked && <Check size={12} className="text-white" />}
            </span>
            <span className="truncate flex-1">{cam.camera_name}</span>
            <span className="shrink-0 text-[10px] font-mono text-[var(--text-dim)]">
              {rec ? formatDuration(rec.total_duration) : '—'}
            </span>
          </button>
        )
      })}
    </div>
  )
})

function IconBtn({
  title,
  onClick,
  children,
}: {
  title: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      className="p-1 text-[var(--text)] hover:bg-[var(--panel)] transition-colors"
    >
      {children}
    </button>
  )
}
