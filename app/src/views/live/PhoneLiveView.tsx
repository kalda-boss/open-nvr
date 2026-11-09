// Copyright (c) 2026 OpenNVR
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Live View on a phone: one big camera (or a 2×2 quad) with every camera
 * listed underneath, one tap away. The desktop wall's drag-to-arrange grid
 * doesn't work by touch, and 9 tiles at ~120px wide on a phone are both
 * unreadable and 9 H.265 decodes. Here, Single plays one stream and Quad
 * at most four.
 *
 * Its own state lives under `liveview-mobile`; it never touches the wall's
 * `liveview-camera-display-order`, so a browser that crosses the breakpoint
 * (a rotated phone, a narrowed window) can't scramble the wall.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { clsx } from 'clsx'
import { Maximize, Maximize2, Minimize, ScanEye, Tv, Volume2, VolumeX } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { useCameras, type CameraItem } from '../../lib/queries'
import { useMediaQuery } from '../../hooks/useMediaQuery'
import { cameraState, STATE_INK } from '../dashboard/WidgetFrame'
import { NO_PICTURE_BG, Tile, type LiveCamera } from './LiveTile'

type Mode = 'single' | 'quad'
type Quad = [number, number, number, number]

interface PhoneState {
  mode: Mode
  /** The camera Single shows; null until the camera list arrives. */
  single: number | null
  /** Camera per quad tile; 0 marks an empty tile. */
  quad: Quad
  /** The quad tile a camera-list tap fills (0–3). */
  active: number
}

const STORAGE_KEY = 'liveview-mobile'

function loadState(): PhoneState {
  const fallback: PhoneState = { mode: 'single', single: null, quad: [0, 0, 0, 0], active: 0 }
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null')
    if (!raw || raw.v !== 1) return fallback
    const quad = Array.isArray(raw.quad) && raw.quad.length === 4 && raw.quad.every((n: unknown) => Number.isInteger(n))
      ? (raw.quad as Quad)
      : fallback.quad
    return {
      mode: raw.mode === 'quad' ? 'quad' : 'single',
      single: Number.isInteger(raw.single) ? raw.single : null,
      quad,
      active: Number.isInteger(raw.active) && raw.active >= 0 && raw.active < 4 ? raw.active : 0,
    }
  } catch {
    return fallback
  }
}

/**
 * Phone view state, kept valid against the current camera list: a deleted
 * camera falls back to the first online one in Single and leaves an empty
 * tile in Quad.
 */
function usePhoneLiveState(cameras: CameraItem[]) {
  const [state, setState] = useState<PhoneState>(loadState)
  const ids = useMemo(() => cameras.map((c) => c.id), [cameras])
  const idsKey = ids.join(',')

  // Fill in defaults and drop deleted cameras whenever the list changes.
  // Skipped while the list is still empty, so a slow first load doesn't wipe
  // the saved selection.
  useEffect(() => {
    if (ids.length === 0) return
    const known = new Set(ids)
    const firstOnline = cameras.find((c) => c.live_online === true)?.id ?? ids[0]
    setState((s) => {
      const single = s.single != null && known.has(s.single) ? s.single : firstOnline
      const neverSet = s.quad.every((id) => id === 0) && localStorage.getItem(STORAGE_KEY) == null
      const quad = (neverSet
        ? [0, 1, 2, 3].map((i) => ids[i] ?? 0)
        : s.quad.map((id) => (known.has(id) ? id : 0))) as Quad
      if (single === s.single && quad.every((id, i) => id === s.quad[i])) return s
      return { ...s, single, quad }
    })
    // `cameras` changes identity on every refetch; the ids are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey])

  useEffect(() => {
    if (state.single == null) return
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: 1, ...state }))
    } catch { /* private mode */ }
  }, [state])

  /** A camera-list tap: show it in Single, or put it in the active quad tile
   *  (swapping with the tile it was already in, if any). */
  const pick = useCallback((id: number) => {
    setState((s) => {
      if (s.mode === 'single') return { ...s, single: id }
      const quad = [...s.quad] as Quad
      const from = quad.indexOf(id)
      if (from !== -1 && from !== s.active) quad[from] = quad[s.active]
      quad[s.active] = id
      return { ...s, quad, single: id }
    })
  }, [])

  const focusTile = useCallback((i: number) => setState((s) => (s.active === i ? s : { ...s, active: i })), [])

  const setMode = useCallback((mode: Mode) => {
    setState((s) => {
      if (s.mode === mode) return s
      if (mode === 'single') {
        // Leave Quad on the camera the user was working with.
        const current = s.quad[s.active]
        return { ...s, mode, single: current || s.single }
      }
      // Into Quad: the camera on screen stays on screen, in the active tile.
      const quad = [...s.quad] as Quad
      let active = s.active
      if (s.single != null) {
        const at = quad.indexOf(s.single)
        if (at !== -1) active = at
        else quad[active] = s.single
      }
      return { ...s, mode, quad, active }
    })
  }, [])

  /** Swipe in Single: the next or previous camera in list order, wrapping. */
  const step = useCallback((dir: 1 | -1) => {
    setState((s) => {
      if (ids.length === 0) return s
      const at = s.single == null ? -1 : ids.indexOf(s.single)
      const next = ids[(at + dir + ids.length) % ids.length]
      return { ...s, single: next }
    })
  }, [ids])

  return { ...state, pick, focusTile, setMode, step }
}

/** Detection boxes on/off: the same per-browser preference as the wall's. */
function useDetectionsPref(): [boolean, () => void] {
  const [on, setOn] = useState<boolean>(() => {
    try { return localStorage.getItem('liveview-detections') === 'on' } catch { return false }
  })
  const toggle = useCallback(() => setOn((prev) => {
    const next = !prev
    try { localStorage.setItem('liveview-detections', next ? 'on' : 'off') } catch { /* private mode */ }
    return next
  }), [])
  return [on, toggle]
}

export function PhoneLiveView() {
  const { t } = useTranslation()
  const cams = useCameras()
  const cameras = useMemo(() => cams.data?.cameras ?? [], [cams.data])
  // What the tiles need, rebuilt only when one of those fields changes. The
  // list refetches every minute; a new array each time would re-run every
  // tile's stream-URL fetch. live_online is left out of the key on purpose:
  // the tile reads fresh liveness itself, and this copy only covers the
  // first paint, as on the wall.
  const tileKey = JSON.stringify(cameras.map((c) => [c.id, c.name, c.display_aspect_ratio, c.fisheye]))
  const liveCams: LiveCamera[] = useMemo(
    () => cameras.map((c) => ({
      id: c.id,
      name: c.name,
      live_online: c.live_online,
      display_aspect_ratio: c.display_aspect_ratio,
      fisheye: c.fisheye ?? null,
    })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tileKey],
  )

  const view = usePhoneLiveState(cameras)
  const [showDetections, toggleDetections] = useDetectionsPref()
  const isLandscape = useMediaQuery('(orientation: landscape)')

  // Fullscreen is a CSS overlay: iPhone Safari only lets a <video> go
  // fullscreen, and that would drop the label band and swipe. Where the
  // browser does allow element fullscreen (Android), it's requested too.
  // The whole stage box (video + exit button) goes fullscreen: requesting it
  // on the video box alone would leave the exit button outside the top layer.
  const stageBoxRef = useRef<HTMLDivElement>(null)
  const [immersive, setImmersive] = useState(false)
  const enterImmersive = () => {
    setImmersive(true)
    const el = stageBoxRef.current
    if (el && document.fullscreenEnabled && !document.fullscreenElement) {
      el.requestFullscreen?.().catch(() => { /* overlay alone is fine */ })
    }
  }
  const exitImmersive = useCallback(() => {
    setImmersive(false)
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {})
  }, [])
  useEffect(() => {
    if (!immersive) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') exitImmersive() }
    // Leaving browser fullscreen (Android back gesture) leaves the overlay too.
    const onFs = () => { if (!document.fullscreenElement) setImmersive(false) }
    window.addEventListener('keydown', onKey)
    document.addEventListener('fullscreenchange', onFs)
    return () => {
      window.removeEventListener('keydown', onKey)
      document.removeEventListener('fullscreenchange', onFs)
    }
  }, [immersive, exitImmersive])

  // Horizontal swipe on the Single stage moves between cameras. Off for a
  // fisheye camera, where a drag pans the dewarped view.
  const singleCam = cameras.find((c) => c.id === view.single)
  const swipeStart = useRef<{ x: number; y: number; t: number } | null>(null)
  const onPointerDown = (e: React.PointerEvent) => {
    swipeStart.current = null
    if (view.mode !== 'single' || singleCam?.fisheye) return
    if ((e.target as HTMLElement).closest('button, input, select, a, [role="slider"]')) return
    swipeStart.current = { x: e.clientX, y: e.clientY, t: e.timeStamp }
  }
  const onPointerUp = (e: React.PointerEvent) => {
    const s = swipeStart.current
    swipeStart.current = null
    if (!s) return
    const dx = e.clientX - s.x
    const dy = e.clientY - s.y
    if (Math.abs(dx) > 48 && Math.abs(dx) > 2 * Math.abs(dy) && e.timeStamp - s.t < 600) {
      view.step(dx < 0 ? 1 : -1)
    }
  }

  const tileOf = (id: number) => (view.mode === 'quad' ? view.quad.indexOf(id) : -1)
  const target = view.mode === 'quad' ? view.quad[view.active] : view.single

  // Sound: off on every visit, and only ever the selected camera (Single's,
  // or the outlined quad tile's). The player reports back when the browser
  // refuses sound (iOS won't autoplay audio outside a tap), so the button
  // never claims sound that isn't playing; one more tap turns it on.
  // (A camera without a WebRTC-playable track, AAC or none, still connects
  // with audio: MediaMTX fills in a silent G.711 track, so the page can't
  // tell it apart and the button stays live.)
  const [soundOn, setSoundOn] = useState(false)
  const audioCamRef = useRef(target)
  audioCamRef.current = target
  const tileAudio = (id: number) => ({
    muted: !(soundOn && id === target),
    onMutedChange: (m: boolean) => { if (id === audioCamRef.current) setSoundOn(!m) },
  })

  return (
    // -m-4 cancels <main>'s padding; dvh, not vh, so iOS's collapsing
    // toolbars don't push the bottom of the list off screen.
    <section className="-m-4 h-[calc(100dvh-3rem)] flex flex-col bg-[var(--panel-2)] overflow-hidden">
      <header className="h-11 shrink-0 flex items-center gap-2 pl-3 border-b border-[var(--border)] bg-[color-mix(in_oklab,var(--bg-2)_55%,var(--panel-2))]">
        <Tv size={14} className="text-[var(--text-dim)] shrink-0" aria-hidden="true" />
        <h1 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--text)] whitespace-nowrap">{t('live.title')}</h1>
        <div className="ml-auto flex items-center">
          <div role="group" aria-label={t('live.layouts')} className="flex border-l border-[var(--border)]">
            {(['single', 'quad'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => view.setMode(m)}
                aria-pressed={view.mode === m}
                aria-label={m === 'single' ? t('live.viewSingle') : t('live.viewQuad')}
                title={m === 'single' ? t('live.viewSingle') : t('live.viewQuad')}
                className={clsx(
                  'w-11 h-11 font-mono text-[13px] font-semibold',
                  view.mode === m ? 'bg-[var(--accent)] text-white' : 'text-[var(--text-dim)] active:bg-[var(--panel)]',
                )}
              >
                {m === 'single' ? '1' : '4'}
              </button>
            ))}
          </div>
          <HeaderIconButton
            active={showDetections}
            onClick={toggleDetections}
            aria-pressed={showDetections}
            aria-label={t('live.boxes')}
            title={t('live.boxes')}
          >
            <ScanEye size={18} />
          </HeaderIconButton>
          <HeaderIconButton onClick={enterImmersive} aria-label={t('live.fullscreen')} title={t('live.fullscreen')}>
            <Maximize size={18} />
          </HeaderIconButton>
        </div>
      </header>

      <div className={clsx('flex-1 min-h-0 flex', isLandscape ? 'flex-row' : 'flex-col')}>
        {/* Stage: 16:9, full width in portrait, fitted to the height in
            landscape. In fullscreen the same element turns into a fixed
            overlay, so the players keep playing instead of reconnecting. */}
        <div ref={stageBoxRef} className={clsx(
          'bg-black flex items-center justify-center',
          immersive
            // eslint-disable-next-line no-restricted-syntax -- not a dialog: the live stage itself goes fullscreen, staying mounted so streams don't reconnect
            ? 'fixed inset-0 z-[60] pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]'
            : isLandscape ? 'flex-1 min-w-0' : 'shrink-0',
        )}>
          <div
            onPointerDown={onPointerDown}
            onPointerUp={onPointerUp}
            onPointerCancel={() => { swipeStart.current = null }}
            className={clsx(
              'relative touch-pan-y',
              immersive ? 'w-full h-full' : isLandscape ? 'h-full max-w-full aspect-video' : 'w-full aspect-video',
            )}
          >
            {cameras.length === 0 ? (
              <div className="absolute inset-0 flex items-center justify-center text-white/45 text-[10px] font-mono uppercase tracking-[0.2em]" style={{ background: NO_PICTURE_BG }}>
                {cams.isLoading ? '…' : t('dashboard.noCameras')}
              </div>
            ) : view.mode === 'single' ? (
              view.single != null && (
                <Tile key={view.single} index={0} availableCameras={liveCams} assignedCameraId={view.single} showDetections={showDetections} {...tileAudio(view.single)} />
              )
            ) : (
              <div className="absolute inset-0 grid grid-cols-2 grid-rows-2 gap-px bg-[#1a1f29]">
                {view.quad.map((id, i) => (
                  <div
                    key={i}
                    role="button"
                    tabIndex={0}
                    aria-label={t('live.tileN', { n: i + 1 })}
                    aria-current={view.active === i ? 'true' : undefined}
                    onClick={() => view.focusTile(i)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') view.focusTile(i) }}
                    className="relative min-w-0 min-h-0"
                  >
                    {id ? (
                      <Tile index={i} availableCameras={liveCams} assignedCameraId={id} showDetections={showDetections} {...tileAudio(id)} />
                    ) : (
                      <div className="absolute inset-0 flex items-center justify-center p-2 text-center text-white/45 text-[10px] font-mono uppercase tracking-[0.15em]" style={{ background: NO_PICTURE_BG }}>
                        {view.active === i ? t('live.pickFromList') : t('live.tileN', { n: i + 1 })}
                      </div>
                    )}
                    {view.active === i && (
                      <div className="pointer-events-none absolute inset-0 z-40 ring-2 ring-inset ring-[var(--accent)]" />
                    )}
                    <span className="pointer-events-none absolute right-1 bottom-1 z-40 px-1 font-mono text-[10px] leading-4 bg-black/60 text-white/80">{i + 1}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          {immersive && (
            <button
              type="button"
              onClick={exitImmersive}
              aria-label={t('video.exitFullscreen')}
              title={t('video.exitFullscreen')}
              className="absolute z-[61] w-11 h-11 flex items-center justify-center bg-black/55 text-white active:bg-black/80 top-[calc(env(safe-area-inset-top)+2.5rem)] right-[max(0.5rem,env(safe-area-inset-right))]"
            >
              <Minimize size={18} />
            </button>
          )}
        </div>

        {/* Every camera, one tap away. */}
        <nav
          aria-label={t('live.cameraList')}
          className={clsx(
            'min-h-0 overflow-y-auto overscroll-contain',
            isLandscape ? 'w-[min(40%,16rem)] shrink-0 border-l border-[var(--border)]' : 'flex-1 border-t border-[var(--border)]',
          )}
        >
          <div className="sticky top-0 z-10 min-h-11 flex items-center gap-2 pl-3 bg-[var(--panel-2)] border-b border-[var(--border)]">
            <p aria-live="polite" className="flex-1 min-w-0 py-1.5 text-[11px] leading-tight text-[var(--text-dim)]">
              {view.mode === 'quad'
                ? t('live.pickForTile', { n: view.active + 1 })
                : <span className="font-semibold uppercase tracking-[0.12em]">{t('live.cameraList')} <span className="font-mono tabular-nums font-normal">· {cameras.length}</span></span>}
            </p>
            {target != null && target !== 0 && (
              <button
                type="button"
                onClick={() => setSoundOn((on) => !on)}
                aria-pressed={soundOn}
                aria-label={soundOn ? t('live.soundOff') : t('live.soundOn')}
                title={soundOn ? t('live.soundOff') : t('live.soundOn')}
                className={clsx(
                  'w-11 h-11 shrink-0 flex items-center justify-center border-l border-[var(--border)]',
                  soundOn ? 'bg-[var(--accent)] text-white' : 'text-[var(--text-dim)] active:bg-[var(--panel)]',
                )}
              >
                {soundOn ? <Volume2 size={18} /> : <VolumeX size={18} />}
              </button>
            )}
            {view.mode === 'quad' && view.quad[view.active] !== 0 && (
              <button
                type="button"
                onClick={() => view.setMode('single')}
                aria-label={t('live.showAlone')}
                title={t('live.showAlone')}
                className="w-11 h-11 shrink-0 flex items-center justify-center text-[var(--text-dim)] active:bg-[var(--panel)]"
              >
                <Maximize2 size={16} />
              </button>
            )}
          </div>
          <ul className={clsx(
            'grid gap-1.5 p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]',
            isLandscape ? 'grid-cols-1' : 'grid-cols-2',
          )}>
            {cameras.map((c) => {
              const selected = c.id === target
              const tile = tileOf(c.id)
              const state = cameraState(c)
              return (
                <li key={c.id} className="min-w-0">
                  <button
                    type="button"
                    onClick={() => view.pick(c.id)}
                    aria-pressed={selected}
                    className={clsx(
                      'w-full min-h-12 flex items-center gap-2 px-2.5 text-left border',
                      selected
                        ? 'border-[var(--accent)] bg-[color-mix(in_oklab,var(--accent)_16%,transparent)] text-[var(--text)]'
                        : 'border-[var(--border)] bg-[var(--bg-2)] text-[var(--text)] active:bg-[var(--panel)]',
                    )}
                  >
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ background: STATE_INK[state] }} aria-hidden="true" />
                    <span className={clsx('flex-1 min-w-0 truncate text-[13px]', state === 'offline' && 'text-[var(--text-dim)]')}>{c.name}</span>
                    {tile !== -1 ? (
                      <span className="shrink-0 w-5 h-5 flex items-center justify-center font-mono text-[11px] border border-[var(--border)] text-[var(--text-dim)]">
                        <span aria-hidden="true">{tile + 1}</span>
                        <span className="sr-only">{t('live.inTileN', { n: tile + 1 })}</span>
                      </span>
                    ) : c.recording_state === 'recording' ? (
                      <span className="shrink-0 text-[9px] font-bold tracking-[0.15em] text-[var(--danger)]">REC</span>
                    ) : null}
                  </button>
                </li>
              )
            })}
          </ul>
        </nav>
      </div>
    </section>
  )
}

function HeaderIconButton({ active = false, className, children, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return (
    <button
      type="button"
      {...rest}
      className={clsx(
        'w-11 h-11 flex items-center justify-center border-l border-[var(--border)]',
        active ? 'bg-[var(--accent)] text-white' : 'text-[var(--text-dim)] active:bg-[var(--panel)]',
        className,
      )}
    >
      {children}
    </button>
  )
}
