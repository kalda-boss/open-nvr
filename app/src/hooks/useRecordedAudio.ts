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

import { useEffect, useRef, type RefObject } from 'react'
import { RecordedAudio, type RecordedAudioSource } from '../lib/recordedAudio'
import type { VoiceFocusLevel } from '../lib/voiceFocus'

/** The session-create response's sound fields, or null when the clip has none. */
export function recordedAudioFrom(
  data: { browser_audio_url?: string | null; audio_sample_rate?: number | null; audio_channels?: number | null } | null | undefined,
): RecordedAudioSource | null {
  const url = data?.browser_audio_url
  const sampleRate = Number(data?.audio_sample_rate)
  const channels = Number(data?.audio_channels)
  return url && sampleRate > 0 && channels > 0 ? { url, sampleRate, channels } : null
}

/**
 * Play a recording's sound in step with `videoRef`'s <video> while `enabled`
 * (sound on, 1x). Nothing is downloaded otherwise. Call primeAudioOutput()
 * inside the click that turns sound on, so iOS lets it start.
 */
export function useRecordedAudio(
  videoRef: RefObject<HTMLVideoElement | null>,
  source: RecordedAudioSource | null,
  { enabled, voiceFocus, volume = 1 }: { enabled: boolean; voiceFocus: VoiceFocusLevel; volume?: number },
): void {
  const playerRef = useRef<RecordedAudio | null>(null)
  const voiceFocusRef = useRef(voiceFocus)
  voiceFocusRef.current = voiceFocus
  const volumeRef = useRef(volume)
  volumeRef.current = volume

  const url = source?.url
  useEffect(() => {
    const video = videoRef.current
    if (!enabled || !source || !video) return
    const player = new RecordedAudio(video, source)
    player.setVolume(volumeRef.current)
    void player.setVoiceFocus(voiceFocusRef.current)
    playerRef.current = player
    return () => {
      player.destroy()
      if (playerRef.current === player) playerRef.current = null
    }
    // A new source object for the same clip is not a new clip.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, url, videoRef])

  useEffect(() => {
    void playerRef.current?.setVoiceFocus(voiceFocus)
  }, [voiceFocus])

  useEffect(() => {
    playerRef.current?.setVolume(volume)
  }, [volume])
}
