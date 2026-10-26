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

import { useEffect, useRef, useState } from 'react'
import { Loader2, Mic, MicOff } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { getTalkCapability, TalkSession, type TalkState } from '../../lib/talkback'

/** Refusals with their own message; anything else reads as generic. */
const KNOWN_ERRORS = new Set(['mic_denied', 'in_use', 'camera_refused', 'forbidden', 'time_limit'])

/**
 * Hold-to-talk. Renders nothing unless the camera has a speaker it can be
 * reached on (``supported``) and the user holds talk.speak (``allowed``).
 * A camera with a speaker but no talk channel shows a disabled mic whose
 * tooltip says what to change on the camera. A line-out-only camera (the
 * fisheye domes) gets no button at all.
 */
export function TalkButton({ cameraId }: { cameraId: number }) {
  const { t } = useTranslation()
  const [cap, setCap] = useState<{ supported: boolean; allowed: boolean; reason: string | null } | null>(null)
  const [state, setState] = useState<TalkState>('idle')
  const [error, setError] = useState<string | null>(null)
  const session = useRef<TalkSession | null>(null)

  useEffect(() => {
    let live = true
    getTalkCapability(cameraId)
      .then((c) => { if (live) setCap(c) })
      .catch(() => { if (live) setCap(null) })
    return () => {
      live = false
      session.current?.stop()
      session.current = null
    }
  }, [cameraId])

  if (!cap || !cap.allowed) return null
  if (!cap.supported) {
    if (cap.reason !== 'no_backchannel') return null
    return (
      <span
        className="p-1.5 rounded flex-shrink-0 opacity-40 cursor-not-allowed @max-[240px]:hidden"
        title={t('video.talk.noBackchannel')}
      >
        <MicOff size={18} />
      </span>
    )
  }

  const begin = (e: React.PointerEvent) => {
    e.preventDefault()
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
    if (session.current) return
    setError(null)
    const s = new TalkSession(cameraId, (next, reason) => {
      setState(next)
      if (next === 'error') {
        setError(reason || 'error')
        session.current = null
      }
    })
    session.current = s
    void s.start()
  }
  const end = () => {
    session.current?.stop()
    session.current = null
  }

  const title =
    state === 'live' ? t('video.talk.live')
      : error ? t(KNOWN_ERRORS.has(error) ? `video.talk.error.${error}` : 'video.talk.error.generic')
        : t('video.talk.hold')

  return (
    <button
      onPointerDown={begin}
      onPointerUp={end}
      onPointerCancel={end}
      onContextMenu={(e) => e.preventDefault()}
      className={`p-1.5 rounded transition-colors flex-shrink-0 touch-none select-none @max-[240px]:hidden ${
        state === 'live' ? 'bg-[var(--danger)]/60 text-white animate-pulse'
          : error ? 'text-[var(--danger)] hover:bg-white/20'
            : 'hover:bg-white/20'
      }`}
      title={title}
      aria-label={title}
      aria-pressed={state === 'live'}
    >
      {state === 'connecting' ? <Loader2 size={18} className="animate-spin" /> : <Mic size={18} />}
    </button>
  )
}
