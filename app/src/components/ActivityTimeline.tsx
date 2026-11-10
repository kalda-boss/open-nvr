// Copyright (c) 2026 OpenNVR
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The recordings scrubber on a phone: what happened, and when, at a glance.
 *
 * The desktop timelines (PlaybackTimeline, MultiCamTimeline) draw footage as
 * a solid block with motion as hairlines along its top. On a phone a day of
 * continuous recording made that one blue slab, and the hairlines, one
 * device pixel each, said little about where the activity was.
 *
 * Here activity is the picture. Each camera is one track:
 *   - bars: activity over time, a few pixels each (lib/motion.ts,
 *     motionBuckets), so a busy afternoon and a single visitor at night
 *     look different;
 *   - a tinted band with a rule under it wherever there is footage, green
 *     where the file is still being written; hatching where there is none;
 *   - grey stubs for footage the server has not scored yet.
 * One playhead crosses every track, with the time on a tab above it, in the
 * clock the operator's language uses. Axis labels stay inside the track.
 *
 * Touch: drag anywhere to scrub (the window pans when the drag reaches an
 * edge), pinch to zoom. A click or drag that lands where no camera has
 * footage snaps to the nearest footage.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { clsx } from 'clsx'
import { useEdgeAutoPan } from '../hooks/useEdgeAutoPan'
import { useElementSize } from '../hooks/useElementSize'
import { motionBuckets } from '../lib/motion'
import { firstLocalTick } from '../lib/time'
import { useDateFormat, useTranslation } from '../i18n'
import type { TimelineRow } from './MultiCamTimeline'

interface ActivityTimelineProps {
  /** One track per camera. */
  rows: TimelineRow[]
  /** Visible window (epoch ms), shared by every track. */
  viewStart: number
  viewEnd: number
  /** Playhead wall-clock position (epoch ms). */
  currentTime: number
  onSeek: (ms: number) => void
  /** Live preview ms while dragging; null on release. */
  onScrubPreview?: (ms: number | null) => void
  /** Pinch or wheel zoom around `anchorMs`. factor < 1 zooms in. */
  onZoomAt?: (anchorMs: number, factor: number) => void
  /** Pan the visible window by deltaMs (the parent clamps to the day). */
  onPan?: (deltaMs: number) => void
  /** Show each camera's name beside its track (the quad). */
  labels?: boolean
  /** Track height in px. */
  rowHeight?: number
  /** Camera whose label is highlighted (selection / sound). */
  activeId?: number | null
  onRowClick?: (id: number) => void
  className?: string
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

/** One activity bar and the gap after it. */
const BAR_PITCH_PX = 4
/** Width of the name column when `labels` is on. */
const LABEL_PX = 62
/** Room an axis label needs; decides how many there are. */
const AXIS_LABEL_PX = 58
/** Height of the footage rule under each track. */
const RULE_PX = 3
const KEY_STEP_MS = 10_000

const TICK_STEPS_S = [1, 5, 10, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 14400, 21600]

function tickStep(spanMs: number, widthPx: number): number {
  const want = spanMs / Math.max(2, Math.floor(widthPx / AXIS_LABEL_PX))
  for (const s of TICK_STEPS_S) if (s * 1000 >= want) return s * 1000
  return TICK_STEPS_S[TICK_STEPS_S.length - 1] * 1000
}

/**
 * Axis labels in the language's clock, as short as the step allows: "3 PM"
 * (or "15 h") on the hour, "3:10" between, with seconds only when the ticks
 * are seconds apart. AM/PM is dropped off the hour: the tab over the
 * playhead carries it, and seven "11:10 AM" don't fit a phone.
 */
function tickLabeler(locale: string, stepMs: number): (ms: number) => string {
  if (stepMs >= 3600_000) {
    const f = new Intl.DateTimeFormat(locale, { hour: 'numeric' })
    return (ms) => f.format(ms)
  }
  const f = new Intl.DateTimeFormat(locale, {
    hour: 'numeric',
    minute: '2-digit',
    ...(stepMs < 60_000 ? { second: '2-digit' } : {}),
  })
  return (ms) => f.formatToParts(ms).filter((p) => p.type !== 'dayPeriod').map((p) => p.value).join('').trim()
}

/** Where there is no footage: faint diagonal hatching over the well. */
const NO_FOOTAGE_BG =
  'repeating-linear-gradient(135deg, transparent 0 4px, color-mix(in oklab, var(--text-dim) 16%, transparent) 4px 5px)'

/**
 * One camera's track. Memoized: the parent re-renders at 4 Hz for the
 * playhead, but the bars and bands only change on zoom, pan, resize or new
 * data.
 */
const Track = memo(function Track({
  row,
  viewStart,
  viewEnd,
  height,
  bars,
}: {
  row: TimelineRow
  viewStart: number
  viewEnd: number
  height: number
  /** How many activity bars fit; 0 until the track has been measured. */
  bars: number
}) {
  const span = Math.max(1, viewEnd - viewStart)
  const pct = (ms: number) => clamp(((ms - viewStart) / span) * 100, 0, 100)

  // Footage, split at the live edge: recorded before it, still recording after.
  const bands = useMemo(() => {
    const out: { left: number; width: number; live: boolean }[] = []
    const edge = row.liveEdgeMs ?? Infinity
    const add = (from: number, to: number, live: boolean) => {
      if (to <= viewStart || from >= viewEnd || to <= from) return
      const left = pct(from)
      out.push({ left, width: pct(to) - left, live })
    }
    for (const s of row.segments) {
      add(s.startMs, Math.min(s.endMs, edge), false)
      add(Math.max(s.startMs, edge), s.endMs, true)
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row.segments, row.liveEdgeMs, viewStart, viewEnd])

  const activity = useMemo(
    () => (row.motion && bars > 0 ? motionBuckets(row.motion, viewStart, viewEnd, bars) : []),
    [row.motion, viewStart, viewEnd, bars],
  )

  return (
    <div
      className="relative flex-1 min-w-0 overflow-hidden bg-[var(--bg-2)]"
      style={{ height, backgroundImage: NO_FOOTAGE_BG }}
    >
      {bands.map((b, i) => (
        <div
          key={i}
          className="absolute inset-y-0"
          style={{
            left: `${b.left}%`,
            width: `max(1px, ${b.width}%)`,
            background: `color-mix(in oklab, var(${b.live ? '--ok' : '--accent'}) 14%, var(--bg-2))`,
            borderBottom: `${RULE_PX}px solid var(${b.live ? '--ok' : '--accent'})`,
          }}
        />
      ))}
      <div className="absolute inset-x-0 top-1" style={{ bottom: RULE_PX }}>
        {activity.map((a, i) =>
          a.level > 0 ? (
            <div
              key={i}
              className="absolute bottom-0 bg-[var(--motion)]"
              style={{
                left: `${(i / activity.length) * 100}%`,
                width: `calc(${100 / activity.length}% - 1px)`,
                height: `max(2px, ${a.level * 100}%)`,
              }}
            />
          ) : a.pending ? (
            <div
              key={i}
              className="absolute bottom-0 bg-[var(--text-dim)] opacity-35"
              style={{
                left: `${(i / activity.length) * 100}%`,
                width: `calc(${100 / activity.length}% - 1px)`,
                height: '22%',
              }}
            />
          ) : null,
        )}
      </div>
    </div>
  )
})

export function ActivityTimeline({
  rows,
  viewStart,
  viewEnd,
  currentTime,
  onSeek,
  onScrubPreview,
  onZoomAt,
  onPan,
  labels = false,
  rowHeight = 56,
  activeId = null,
  onRowClick,
  className,
}: ActivityTimelineProps) {
  const fmt = useDateFormat()
  const { t } = useTranslation()
  const [measureRef, size] = useElementSize<HTMLDivElement>()
  const surfaceRef = useRef<HTMLDivElement | null>(null)
  const setSurface = useCallback(
    (el: HTMLDivElement | null) => {
      surfaceRef.current = el
      measureRef(el)
    },
    [measureRef],
  )

  const span = Math.max(1, viewEnd - viewStart)
  const toPct = (ms: number) => clamp(((ms - viewStart) / span) * 100, 0, 100)
  const xToMs = useCallback(
    (clientX: number): number => {
      const rect = surfaceRef.current?.getBoundingClientRect()
      if (!rect || rect.width <= 0) return viewStart
      return viewStart + clamp((clientX - rect.left) / rect.width, 0, 1) * span
    },
    [viewStart, span],
  )

  // A target where NO camera has footage snaps to the nearest footage edge,
  // so a scrub always lands on video.
  const union = useMemo(() => rows.flatMap((r) => r.segments), [rows])
  const snap = useCallback(
    (ms: number): number => {
      let best = ms
      let bestDist = Infinity
      for (const s of union) {
        if (ms >= s.startMs && ms < s.endMs) return ms
        for (const edge of [s.startMs, s.endMs - 1]) {
          const d = Math.abs(edge - ms)
          if (d < bestDist) {
            bestDist = d
            best = edge
          }
        }
      }
      return best
    },
    [union],
  )

  const ticks = useMemo(() => {
    if (size.w <= 0) return []
    const step = tickStep(span, size.w)
    const label = tickLabeler(fmt.locale, step)
    const out: { pct: number; x: number; label: string }[] = []
    for (let ms = firstLocalTick(viewStart, step); ms <= viewEnd; ms += step) {
      const pct = ((ms - viewStart) / span) * 100
      out.push({ pct, x: (pct / 100) * size.w, label: label(ms) })
    }
    return out
  }, [span, viewStart, viewEnd, size.w, fmt.locale])

  // ---- Touch: one finger scrubs, two pinch --------------------------------
  const autoPan = useEdgeAutoPan({ rectRef: surfaceRef, spanMs: span, onPan })
  const pointers = useRef(new Map<number, number>())
  // Set from the second finger down until every finger is up, so lifting
  // one finger of a pinch doesn't turn the other into a scrub.
  const pinch = useRef<{ dist: number } | null>(null)
  const lastX = useRef(0)
  const [dragging, setDragging] = useState(false)
  // The same flag for the effect below, which can run after a release was
  // handled but from a render that still saw the drag: React flushes a
  // pending effect just before it renders the release, so its preview
  // would land after the release cleared it and stick.
  const draggingRef = useRef(false)
  const setDrag = (on: boolean) => {
    draggingRef.current = on
    setDragging(on)
  }

  const stopScrub = () => {
    autoPan.onDragEnd()
    setDrag(false)
    onScrubPreview?.(null)
  }

  const handleDown = (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    pointers.current.set(e.pointerId, e.clientX)
    if (pointers.current.size >= 2) {
      if (dragging) stopScrub()
      if (!pinch.current) {
        const [a, b] = [...pointers.current.values()]
        pinch.current = { dist: Math.abs(a - b) }
      }
      return
    }
    if (pinch.current) return
    setDrag(true)
    lastX.current = e.clientX
    autoPan.onDragStart(e.clientX)
    onScrubPreview?.(snap(xToMs(e.clientX)))
  }

  const handleMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return
    pointers.current.set(e.pointerId, e.clientX)
    if (pinch.current) {
      if (pointers.current.size < 2) return
      const [a, b] = [...pointers.current.values()]
      const dist = Math.abs(a - b)
      // Fingers nearly above one another say nothing about a horizontal pinch.
      if (dist < 24 || pinch.current.dist < 24) {
        pinch.current.dist = dist
        return
      }
      if (Math.abs(dist - pinch.current.dist) < 3) return
      // Around the playhead while it is on screen: it stays put, and the
      // parent's auto-follow has no reason to pull the window back to it.
      const onScreen = currentTime >= viewStart && currentTime <= viewEnd
      onZoomAt?.(onScreen ? currentTime : xToMs((a + b) / 2), pinch.current.dist / dist)
      pinch.current.dist = dist
      return
    }
    if (!dragging) return
    lastX.current = e.clientX
    autoPan.onDragMove(e.clientX)
    onScrubPreview?.(snap(xToMs(e.clientX)))
  }

  const handleEnd = (e: React.PointerEvent, commit: boolean) => {
    pointers.current.delete(e.pointerId)
    if (pinch.current) {
      if (pointers.current.size === 0) pinch.current = null
      return
    }
    if (!dragging) return
    autoPan.onDragEnd()
    setDrag(false)
    if (commit) onSeek(snap(xToMs(e.clientX)))
    onScrubPreview?.(null)
  }

  // While auto-panning the finger holds still, so no pointermove fires:
  // re-derive the preview from the moving window instead.
  useEffect(() => {
    if (draggingRef.current) onScrubPreview?.(snap(xToMs(lastX.current)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewStart, viewEnd])

  // Wheel zoom (a mouse on a narrow window). Native and non-passive, so the
  // page doesn't scroll under it.
  useEffect(() => {
    const el = surfaceRef.current
    if (!el || !onZoomAt) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      onZoomAt(xToMs(e.clientX), e.deltaY < 0 ? 0.8 : 1.25)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [onZoomAt, xToMs])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowLeft') onSeek(snap(currentTime - KEY_STEP_MS))
    else if (e.key === 'ArrowRight') onSeek(snap(currentTime + KEY_STEP_MS))
    else return
    e.preventDefault()
  }

  const before = currentTime < viewStart
  const after = currentTime > viewEnd
  const onScreen = !before && !after
  const currentPct = toPct(currentTime)
  // Two-digit parts: the tab keeps one width as the seconds tick.
  const clock = fmt.time(currentTime, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  const bars = size.w > 0 ? Math.max(1, Math.floor(size.w / BAR_PITCH_PX)) : 0
  const inset = labels ? LABEL_PX : 0

  return (
    <div className={clsx('select-none', className)}>
      {/* The time, on a tab that rides the playhead. Off-screen (zoomed in
          elsewhere) it waits at the edge the playhead is beyond. */}
      <div className="relative h-8" style={{ marginLeft: inset }}>
        <span
          data-testid="activity-timeline-clock"
          className={clsx(
            'absolute bottom-1.5 -translate-x-1/2 whitespace-nowrap px-1.5 font-mono font-semibold tabular-nums text-white bg-[var(--accent)]',
            dragging ? 'text-[13px] leading-6' : 'text-[12px] leading-5',
          )}
          style={{ left: `clamp(3.25rem, ${currentPct}%, calc(100% - 3.25rem))` }}
        >
          {before && '‹ '}
          {clock}
          {after && ' ›'}
        </span>
      </div>

      <div className="relative">
        <div className="flex flex-col gap-[3px]">
          {rows.map((row) => (
            <div key={row.id} className="flex items-center">
              {labels && (
                <button
                  type="button"
                  onClick={() => onRowClick?.(row.id)}
                  title={row.name}
                  style={{ width: LABEL_PX }}
                  className={clsx(
                    'shrink-0 self-stretch pr-1.5 text-left text-[10px] leading-none truncate',
                    row.id === activeId ? 'text-[var(--accent)] font-semibold' : 'text-[var(--text-dim)]',
                  )}
                >
                  {row.name}
                </button>
              )}
              <Track row={row} viewStart={viewStart} viewEnd={viewEnd} height={rowHeight} bars={bars} />
            </div>
          ))}
        </div>

        {/* One touch surface across every track (not the names). */}
        <div
          ref={setSurface}
          role="slider"
          tabIndex={0}
          aria-label={t('playback.timeline')}
          aria-valuemin={viewStart}
          aria-valuemax={viewEnd}
          aria-valuenow={Math.round(currentTime)}
          aria-valuetext={clock}
          data-testid="activity-timeline-track"
          onKeyDown={onKeyDown}
          onPointerDown={handleDown}
          onPointerMove={handleMove}
          onPointerUp={(e) => handleEnd(e, true)}
          onPointerCancel={(e) => handleEnd(e, false)}
          className="absolute inset-y-0 right-0 cursor-pointer touch-none outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]"
          style={{ left: inset }}
        >
          {ticks.map((tk, i) => (
            <div
              key={i}
              className="pointer-events-none absolute inset-y-0 w-px bg-[var(--text)] opacity-10"
              style={{ left: `${tk.pct}%` }}
            />
          ))}
          {onScreen && (
            <div
              className="pointer-events-none absolute inset-y-0 z-10 w-0.5 -translate-x-1/2 bg-[var(--text)] shadow-[0_0_0_1px_var(--panel-2)]"
              style={{ left: `${currentPct}%` }}
            >
              <span
                className={clsx(
                  'absolute left-1/2 top-0 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--text)] shadow-[0_0_0_1px_var(--panel-2)]',
                  dragging ? 'h-3.5 w-3.5' : 'h-2.5 w-2.5',
                )}
              />
            </div>
          )}
        </div>
      </div>

      {/* Axis: labels sit inside the track, the outermost ones flush with
          its ends, so none is cut off by the edge of the screen. */}
      <div className="relative h-4 font-mono text-[10px] leading-4 text-[var(--text-dim)]" style={{ marginLeft: inset }}>
        {ticks.map((tk, i) => {
          const nearStart = tk.x < AXIS_LABEL_PX / 2
          const nearEnd = tk.x > size.w - AXIS_LABEL_PX / 2
          return (
            <span
              key={i}
              className={clsx('absolute whitespace-nowrap', !nearStart && !nearEnd && '-translate-x-1/2')}
              style={nearEnd ? { right: `${100 - tk.pct}%` } : { left: `${tk.pct}%` }}
            >
              {tk.label}
            </span>
          )
        })}
      </div>
    </div>
  )
}
