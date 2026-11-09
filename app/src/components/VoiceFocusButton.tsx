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

import { AudioLines } from 'lucide-react'
import { useTranslation } from '../i18n'
import {
  nextVoiceFocusLevel,
  primeVoiceFocusAudio,
  voiceFocusSupported,
  writeVoiceFocusPref,
  type VoiceFocusLevel,
} from '../lib/voiceFocus'

/** The voice-focus toggle for the playback toolbars: off -> standard ->
    strong -> off, remembered with the live view's choice. Renders nothing
    where the browser can't run the filter. */
export function VoiceFocusButton({
  level,
  onChange,
  size = 16,
  className = 'p-1.5',
}: {
  level: VoiceFocusLevel
  onChange: (level: VoiceFocusLevel) => void
  size?: number
  className?: string
}) {
  const { t } = useTranslation()
  if (!voiceFocusSupported()) return null
  return (
    <button
      type="button"
      onClick={() => {
        const next = nextVoiceFocusLevel(level)
        if (next !== 'off') primeVoiceFocusAudio() // inside the click (iOS)
        writeVoiceFocusPref(next)
        onChange(next)
      }}
      title={t(`video.voiceFocus.${level}`)}
      aria-label={t('video.voiceFocus.label')}
      aria-pressed={level !== 'off'}
      className={`relative rounded transition-colors ${className} ${
        level === 'strong'
          ? 'bg-[var(--accent)] text-white'
          : level === 'standard'
            ? 'bg-[var(--accent)]/25 text-[var(--accent)]'
            : 'text-[var(--text)] hover:bg-[var(--panel)]'
      }`}
    >
      <AudioLines size={size} />
      {level === 'strong' && (
        <span
          aria-hidden
          className="absolute -top-1 -right-1 min-w-[12px] h-[12px] px-[2px] rounded-full bg-white text-[var(--accent)] text-[9px] font-bold leading-[12px] text-center"
        >
          +
        </span>
      )}
    </button>
  )
}
