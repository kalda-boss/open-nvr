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

import { useRef } from 'react'

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

interface PaneResizerProps {
  /** Extra height (px) the pane has now; 0 is its natural size. */
  value: number
  onChange: (px: number) => void
  /** Largest extra height allowed, read when a drag or key press starts
   *  (the space above the pane can change between drags). */
  max: () => number
  label: string
}

/**
 * The grab strip on the top edge of a player's bottom pane: drag it up to
 * give the timeline more height (the video above gives it up), double-click
 * to reset. Absolutely positioned over that edge, so place it inside the
 * pane's first `relative` element; it adds no height of its own.
 */
export function PaneResizer({ value, onChange, max, label }: PaneResizerProps) {
  const drag = useRef<{ y: number; from: number; max: number } | null>(null)

  const nudge = (delta: number) => onChange(clamp(value + delta, 0, Math.max(0, max())))

  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label={label}
      aria-valuenow={Math.round(value)}
      aria-valuemin={0}
      tabIndex={0}
      title={label}
      className="group absolute inset-x-0 -top-1.5 h-3 z-20 flex items-center justify-center cursor-row-resize touch-none outline-none"
      onPointerDown={(e) => {
        if (!e.isPrimary || e.button !== 0) return
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
        drag.current = { y: e.clientY, from: value, max: Math.max(0, max()) }
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (d) onChange(clamp(d.from + (d.y - e.clientY), 0, d.max))
      }}
      onPointerUp={() => {
        drag.current = null
      }}
      onPointerCancel={() => {
        drag.current = null
      }}
      onDoubleClick={() => onChange(0)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowUp') nudge(24)
        else if (e.key === 'ArrowDown') nudge(-24)
        else if (e.key === 'Home') onChange(0)
        else return
        e.preventDefault()
      }}
    >
      <span className="h-1 w-12 rounded-full bg-[var(--text-dim)] opacity-40 transition-opacity group-hover:opacity-90 group-focus-visible:opacity-90 group-active:opacity-100" />
    </div>
  )
}
