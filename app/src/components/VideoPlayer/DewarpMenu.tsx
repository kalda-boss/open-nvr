// Copyright (c) 2026 OpenNVR
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef, useState } from 'react'
import { Aperture, RotateCcw } from 'lucide-react'
import { useTranslation } from '../../i18n'
import type { DewarpMode } from '../../lib/fisheye'

/**
 * The fisheye layout picker: original circle, panorama(s), virtual PTZ,
 * quad. Rendered only for cameras configured with a fisheye lens.
 */
export function DewarpMenu({
  modes,
  mode,
  onChange,
  onReset,
  placement = 'up',
  buttonClassName = 'p-1.5 hover:bg-white/20 rounded transition-colors',
  iconSize = 18,
}: {
  modes: DewarpMode[]
  mode: DewarpMode
  onChange: (mode: DewarpMode) => void
  /** Re-aim the current layout's views; omitted while showing the raw circle. */
  onReset?: () => void
  /** Which way the menu opens — up from a bottom bar, down from a top corner. */
  placement?: 'up' | 'down'
  buttonClassName?: string
  iconSize?: number
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  if (modes.length === 0) return null

  const pick = (m: DewarpMode) => {
    onChange(m)
    setOpen(false)
  }

  return (
    <div
      className="relative"
      ref={rootRef}
      // A Live View tile is a drag source, and a sync tile selects on click.
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`${buttonClassName} ${mode !== 'fisheye' ? 'text-[var(--accent)]' : ''}`}
        title={`${t('video.dewarp')}: ${t(`video.dewarp.${mode}`)}`}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Aperture size={iconSize} />
      </button>
      {open && (
        <div
          role="menu"
          className={`absolute right-0 z-40 bg-[var(--panel)] text-[var(--text)] border border-[var(--border)] rounded shadow-lg min-w-[170px] py-1 text-sm ${
            placement === 'up' ? 'bottom-full mb-2' : 'top-full mt-1'
          }`}
        >
          <div className="px-3 pt-1 pb-1.5 text-[10px] uppercase text-[var(--text-dim)]">{t('video.dewarp')}</div>
          {modes.map((m) => (
            <button
              key={m}
              type="button"
              role="menuitemradio"
              aria-checked={m === mode}
              onClick={() => pick(m)}
              className={`menu-item block w-full text-left px-3 py-1.5 text-xs ${
                m === mode ? 'bg-[var(--accent)]/30 text-[var(--accent)]' : 'hover:bg-white/10'
              }`}
            >
              {t(`video.dewarp.${m}`)}
            </button>
          ))}
          {onReset && mode !== 'fisheye' && (
            <>
              <div className="my-1 border-t border-[var(--border)]" />
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  onReset()
                  setOpen(false)
                }}
                className="menu-item flex w-full items-center gap-2 text-left px-3 py-1.5 text-xs hover:bg-white/10"
              >
                <RotateCcw size={12} /> {t('video.dewarp.reset')}
              </button>
              <div className="px-3 pt-1 pb-0.5 text-[10px] text-[var(--text-dim)]">{t('video.dewarp.hint')}</div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
