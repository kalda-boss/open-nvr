// Copyright (c) 2026 OpenNVR
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useState } from 'react'
import { dewarpModesFor, loadDewarp, saveDewarp } from '../lib/fisheye'
import type { DewarpMode, DewarpViews, FisheyeLens, StoredDewarp } from '../lib/fisheye'

export interface Dewarp {
  /** The camera's lens; null for an ordinary camera (everything else inert). */
  lens: FisheyeLens | null
  /** Modes to offer for this mount; [] for an ordinary camera. */
  modes: DewarpMode[]
  mode: DewarpMode
  views: DewarpViews | null
  /** True when the GPU view should be drawn over the video. */
  active: boolean
  setMode: (mode: DewarpMode) => void
  saveViews: (views: DewarpViews) => void
  /** FisheyeView could not run here (no WebGL, …): show the raw circle. */
  markUnsupported: () => void
}

/**
 * Per-camera dewarp state for a player: which layout is showing and where
 * its views point, remembered in localStorage so live, playback and a page
 * reload all open on the same picture.
 */
export function useDewarp(
  cameraId: number | null | undefined,
  lens: FisheyeLens | null | undefined,
): Dewarp {
  // The camera list refetches every minute with fresh objects, so key on
  // the lens's VALUE: only a real settings change reloads.
  const key = lens ? `${cameraId ?? ''}|${JSON.stringify(lens)}` : ''
  const load = () => ({ key, value: lens ? loadDewarp(cameraId, lens) : null })
  const [state, setState] = useState<{ key: string; value: StoredDewarp | null }>(load)
  const [unsupported, setUnsupported] = useState(false)

  let current = state
  if (state.key !== key) {
    // Derived-state reset during render (no effect, so no frame of the old
    // camera's layout): React re-renders immediately with this.
    current = load()
    setState(current)
  }
  const value = current.value

  const update = useCallback(
    (patch: Partial<StoredDewarp>) =>
      setState((s) => {
        if (!s.value) return s
        const next = { ...s.value, ...patch }
        saveDewarp(cameraId, next)
        return { ...s, value: next }
      }),
    [cameraId],
  )
  const setMode = useCallback((mode: DewarpMode) => update({ mode }), [update])
  const saveViews = useCallback((views: DewarpViews) => update({ views }), [update])
  const markUnsupported = useCallback(() => setUnsupported(true), [])

  const resolved = lens && value ? lens : null
  return {
    lens: resolved,
    modes: resolved && !unsupported ? dewarpModesFor(resolved.mount) : [],
    mode: value?.mode ?? 'fisheye',
    views: value?.views ?? null,
    active: !!resolved && !unsupported && !!value && value.mode !== 'fisheye',
    setMode,
    saveViews,
    markUnsupported,
  }
}
