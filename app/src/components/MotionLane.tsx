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

import { useEffect, useRef, useState, type CanvasHTMLAttributes } from 'react'
import { motionLevel, motionPeak, type MotionTrack } from '../lib/motion'

/** Diagonal hatch for footage the server has not scored yet. */
function hatchPattern(ctx: CanvasRenderingContext2D, color: string, dpr: number) {
  const size = Math.max(4, Math.round(6 * dpr))
  const tile = document.createElement('canvas')
  tile.width = tile.height = size
  const t = tile.getContext('2d')
  if (!t) return null
  t.strokeStyle = color
  t.lineWidth = Math.max(1, dpr)
  t.beginPath()
  t.moveTo(0, size)
  t.lineTo(size, 0)
  t.stroke()
  return ctx.createPattern(tile, 'repeat')
}

/** Paint one bar per device-pixel column, the column's peak score as its
 *  height. A 'lane' also hatches footage still being scored and draws a
 *  faint baseline under footage scored quiet; an 'overlay' (drawn over a
 *  footage row) has room for the bars only. */
function drawMotion(
  cv: HTMLCanvasElement,
  track: MotionTrack,
  viewStart: number,
  viewEnd: number,
  variant: 'lane' | 'overlay'
) {
  const dpr = window.devicePixelRatio || 1
  const w = Math.max(1, Math.round(cv.clientWidth * dpr))
  const h = Math.max(1, Math.round(cv.clientHeight * dpr))
  if (cv.width !== w) cv.width = w
  if (cv.height !== h) cv.height = h
  const ctx = cv.getContext('2d')
  if (!ctx) return
  ctx.clearRect(0, 0, w, h)
  const css = getComputedStyle(cv)
  const ink = css.getPropertyValue('--motion').trim() || '#d95926'
  const hatch =
    variant === 'lane' ? hatchPattern(ctx, css.getPropertyValue('--text-dim').trim() || '#9ca3af', dpr) : null
  const span = Math.max(1, viewEnd - viewStart)
  const baseline = Math.max(1, Math.round(dpr))

  let hatchFrom = -1
  const flushHatch = (x: number) => {
    if (hatchFrom < 0) return
    if (hatch) {
      ctx.globalAlpha = 0.4
      ctx.fillStyle = hatch
      ctx.fillRect(hatchFrom, 0, x - hatchFrom, h)
    }
    hatchFrom = -1
  }
  for (let x = 0; x < w; x++) {
    const { peak, pending, scored } = motionPeak(
      track,
      viewStart + (x / w) * span,
      viewStart + ((x + 1) / w) * span
    )
    const level = motionLevel(peak)
    if (pending && level === 0) {
      if (hatchFrom < 0) hatchFrom = x
      continue
    }
    flushHatch(x)
    ctx.fillStyle = ink
    if (level > 0) {
      ctx.globalAlpha = 1
      const bar = Math.max(2 * baseline, Math.round(level * h))
      ctx.fillRect(x, h - bar, 1, bar)
    } else if (scored && variant === 'lane') {
      ctx.globalAlpha = 0.3
      ctx.fillRect(x, h - baseline, 1, baseline)
    }
  }
  flushHatch(w)
  ctx.globalAlpha = 1
}

interface MotionLaneProps extends CanvasHTMLAttributes<HTMLCanvasElement> {
  track: MotionTrack
  /** Visible window (epoch ms). */
  viewStart: number
  viewEnd: number
  variant?: 'lane' | 'overlay'
}

/**
 * A camera's motion activity (lib/motion.ts) over the visible window, for
 * the playback timelines. Canvas, because a day is 86,400 values and the
 * window moves on every wheel tick and pan frame; it repaints on resize and
 * on theme changes, which a canvas does not follow by itself.
 */
export function MotionLane({ track, viewStart, viewEnd, variant = 'lane', ...canvas }: MotionLaneProps) {
  const ref = useRef<HTMLCanvasElement>(null)
  const [paint, setPaint] = useState(0)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const repaint = () => setPaint((n) => n + 1)
    const ro = new ResizeObserver(repaint)
    ro.observe(el)
    const mo = new MutationObserver(repaint)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => {
      ro.disconnect()
      mo.disconnect()
    }
  }, [])

  useEffect(() => {
    if (ref.current) drawMotion(ref.current, track, viewStart, viewEnd, variant)
  }, [track, viewStart, viewEnd, variant, paint])

  return <canvas ref={ref} {...canvas} />
}
