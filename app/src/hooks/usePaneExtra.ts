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

import { useCallback, useState } from 'react'

/** Height (px) a player's bottom pane has been dragged taller by, kept per
 *  view in localStorage so the next visit opens the same way. */
export function usePaneExtra(storageKey: string): [number, (px: number) => void] {
  const [extra, setExtra] = useState(() => {
    try {
      const n = Number(localStorage.getItem(storageKey))
      return Number.isFinite(n) && n > 0 ? n : 0
    } catch {
      return 0
    }
  })
  const set = useCallback(
    (px: number) => {
      const v = Math.max(0, Math.round(px))
      setExtra(v)
      try {
        if (v > 0) localStorage.setItem(storageKey, String(v))
        else localStorage.removeItem(storageKey)
      } catch {
        /* storage unavailable: keep in-memory state */
      }
    },
    [storageKey]
  )
  return [extra, set]
}
