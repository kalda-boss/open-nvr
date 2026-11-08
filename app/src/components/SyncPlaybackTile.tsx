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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type Hls from 'hls.js'
import { CameraOff, Radio, AlertCircle, Volume2 } from 'lucide-react'
import { apiService } from '../lib/apiService'
import { displayAspect, isStretched } from '../lib/aspect'
import type { AspectOverride } from '../lib/aspect'
import { useVideoSize } from '../hooks/useVideoAspect'
import { useDewarp } from '../hooks/useDewarp'
import type { FisheyeLens } from '../lib/fisheye'
import { AspectFrame, DewarpMenu, FisheyeView } from './VideoPlayer'
import type { FisheyeViewHandle } from './VideoPlayer'
import { useTranslation } from '../i18n'
import { loadHls } from '../lib/loadHls'
import type { TimelineSegment } from './PlaybackTimeline'

interface SyncPlaybackTileProps {
  cameraId: number
  cameraName: string
  /** Footage blocks for the selected day (epoch ms, sorted). */
  segments: TimelineSegment[]
  /** Start of the still-recording file — footage there is not playable as VOD. */
  liveEdgeMs: number | null
  /** Shared wall-clock playhead (epoch ms). The tile follows it. */
  masterMs: number
  playing: boolean
  rate: number
  muted: boolean
  /** Highlighted tile (audio focus). */
  active: boolean
  onActivate: () => void
  /** Per-camera display-aspect override — see lib/aspect.ts (issue #354). */
  displayAspectOverride?: AspectOverride | null
  /** 360° fisheye lens — see lib/fisheye.ts. */
  fisheye?: FisheyeLens | null
}

type TileStatus = 'idle' | 'loading' | 'ok' | 'gap' | 'live' | 'error'

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

/** Wall-clock bounds of a slot's media: startMs maps to video t=0. endMs is
 *  refined once the real duration is known — the session may resolve a
 *  physical file shorter than the listed segment. */
interface MediaWindow {
  startMs: number
  endMs: number
}

/** One of a tile's two <video> elements and the session feeding it. */
interface Slot {
  hls: Hls | null
  sessionId: string | null
  token: number
  window: MediaWindow | null
  state: 'empty' | 'loading' | 'ready' | 'failed'
  /** Wall-clock instant the session was anchored at. */
  targetMs: number | null
  /** Standby only: where the active media ended when this was prefetched. */
  fromMs: number | null
}

const emptySlot = (): Slot => ({
  hls: null,
  sessionId: null,
  token: 0,
  window: null,
  state: 'empty',
  targetMs: null,
  fromMs: null,
})

/**
 * Does the standby clip take over at master instant `m`? It covers from where
 * the active media ended (which also spans a small gap between files, and an
 * active clip that ran out early) to its own end. A standby still loading
 * covers the first few seconds past its anchor, so the swap waits for it
 * rather than starting a second load of the same clip.
 */
function standbyCovers(sb: Slot, m: number, activeEndMs: number | null): boolean {
  if (sb.state === 'ready' && sb.window) {
    const from = Math.min(sb.window.startMs, sb.fromMs ?? Infinity, activeEndMs ?? Infinity)
    return m >= from - 300 && m < sb.window.endMs - 300
  }
  if (sb.state === 'loading' && sb.targetMs != null) {
    const from = Math.min(sb.targetMs, sb.fromMs ?? Infinity, activeEndMs ?? Infinity)
    return m >= from - 300 && m < sb.targetMs + 10_000
  }
  return false
}

/**
 * One camera in the synchronized playback grid. The tile is a pure follower
 * of the shared master clock: whenever the master instant leaves the loaded
 * media window it swaps to the prefetched next clip, or opens a per-clip
 * session anchored AT that instant, and while inside the window it only
 * drift-corrects. Clip
 * boundaries, gaps and the live edge all fall out of the same follow logic —
 * there is no per-tile transport state to get out of sync.
 */
export function SyncPlaybackTile({
  cameraId,
  cameraName,
  segments,
  liveEdgeMs,
  masterMs,
  playing,
  rate,
  muted,
  active,
  onActivate,
  displayAspectOverride,
  fisheye,
}: SyncPlaybackTileProps) {
  const { t } = useTranslation()
  // Two <video> elements per tile: the ACTIVE one plays, the STANDBY one
  // preloads the clip that comes next. Recordings are one file per minute, so
  // at 8x a clip lasts ~7.5 s; opening the next one only after the current one
  // ran out (create session, fetch the header, buffer) stalled the tile at
  // every boundary. With the next clip already parked at its first frame, the
  // boundary is a swap.
  const videoARef = useRef<HTMLVideoElement>(null)
  const videoBRef = useRef<HTMLVideoElement>(null)
  const videoRefs = useMemo(() => [videoARef, videoBRef] as const, [])
  const slotsRef = useRef<[Slot, Slot]>([emptySlot(), emptySlot()])
  const activeRef = useRef(0)
  // Mirrors activeRef for rendering, and so the hooks below re-bind to the
  // element that is showing.
  const [activeIdx, setActiveIdx] = useState(0)
  const videoRef = videoRefs[activeIdx]
  // The lazily-loaded hls.js module (see lib/loadHls); null until resolved.
  const hlsLibRef = useRef<typeof Hls | null>(null)
  // Load tokens, shared by both slots: a slot's load only lands while the
  // slot still holds the token it started with.
  const tokenSeqRef = useRef(0)
  // Target of the ACTIVE load in flight, so the follow loop doesn't spawn a
  // new session on every master tick while one is being set up.
  const inFlightRef = useRef<{ targetMs: number } | null>(null)
  // Damper: after a failed load, don't retry until the master moves on. Without
  // this a segment whose metadata overstates its media would cause an endless
  // create-session/404 loop.
  const failRef = useRef<{ targetMs: number } | null>(null)
  const masterRef = useRef(masterMs)
  const playingRef = useRef(playing)
  const rateRef = useRef(rate)
  const mutedRef = useRef(muted)

  const [status, setStatus] = useState<TileStatus>('idle')
  const [buffering, setBuffering] = useState(false)

  /**
   * Drop a slot's session and invalidate any load still in flight into it.
   * `clearSrc` also releases the element's media (network + decoder); the
   * active slot skips that when a new source is about to replace it anyway.
   */
  const teardownSlot = useCallback(
    (i: number, clearSrc: boolean) => {
      const s = slotsRef.current[i]
      s.token = ++tokenSeqRef.current
      if (s.hls) {
        s.hls.destroy()
        s.hls = null
      }
      const prev = s.sessionId
      Object.assign(s, emptySlot(), { token: s.token })
      if (prev) apiService.deleteHlsPlaybackSession(prev).catch(() => {})
      const el = videoRefs[i].current
      if (clearSrc && el) {
        el.pause()
        if (el.getAttribute('src')) {
          el.removeAttribute('src')
          el.load()
        }
      }
    },
    [videoRefs]
  )

  /** Seek the active media to the CURRENT master instant and apply transport. */
  const settleAtMaster = useCallback(() => {
    const i = activeRef.current
    const el = videoRefs[i].current
    const w = slotsRef.current[i].window
    if (!el || !w) return
    const off = (masterRef.current - w.startMs) / 1000
    if (off > 0.05) {
      try {
        // Never land on the exact end — an at-end start fires 'ended' at once.
        el.currentTime = isFinite(el.duration) ? clamp(off, 0, Math.max(0, el.duration - 0.3)) : off
      } catch {
        /* seekable range not ready; starts at head */
      }
    }
    el.playbackRate = rateRef.current
    el.muted = mutedRef.current
    if (playingRef.current) el.play().catch(() => {})
  }, [videoRefs])

  /**
   * Open a per-clip HLS session anchored at `targetMs` inside `seg`, into slot
   * `i`. Anchoring at the target (not the clip start) means the media always
   * begins at the wanted instant and the backend resolves the physical file
   * that actually contains it — merged-file boundaries need no special casing.
   *
   * `fromMs` marks a standby (prefetch) load: the instant the active media
   * ends, from which this clip takes over. Whether the load lands as the
   * active or the standby is decided when it is ready, so a standby promoted
   * mid-load simply settles as the active one.
   */
  const loadInto = useCallback(
    async (i: number, seg: TimelineSegment, targetMs: number, fromMs: number | null) => {
      const el = videoRefs[i].current
      if (!el) return
      teardownSlot(i, false)
      const slot = slotsRef.current[i]
      const token = ++tokenSeqRef.current
      slot.token = token
      const anchorMs = clamp(targetMs, seg.startMs, seg.endMs - 1500)
      slot.state = 'loading'
      slot.targetMs = anchorMs
      slot.fromMs = fromMs
      const current = () => slot.token === token
      const isActive = () => activeRef.current === i
      if (isActive()) {
        inFlightRef.current = { targetMs: anchorMs }
        setStatus('loading')
      }

      const fail = () => {
        if (!current()) return
        slot.state = 'failed'
        if (isActive()) {
          inFlightRef.current = null
          failRef.current = { targetMs: anchorMs }
          setBuffering(false)
          setStatus('error')
        }
      }

      const onReady = (win: MediaWindow) => {
        if (!current()) return
        slot.window = win
        slot.state = 'ready'
        if (isActive()) {
          inFlightRef.current = null
          failRef.current = null
          setStatus('ok')
          setBuffering(false)
          settleAtMaster()
          return
        }
        // Standby: park on the takeover instant, muted and paused, so the
        // browser fetches and decodes that spot before the swap needs it.
        el.muted = true
        el.pause()
        try {
          const off = (anchorMs - win.startMs) / 1000
          if (off > 0.05) el.currentTime = isFinite(el.duration) ? clamp(off, 0, Math.max(0, el.duration - 0.3)) : off
        } catch {
          /* not seekable yet; the swap seeks */
        }
      }

      let manifestUrl: string
      let browserMp4Url: string | null = null
      let fileOffsetSec = 0
      try {
        // Kick the hls.js chunk download in parallel with the session create;
        // both are needed before playback can start.
        const [res, HlsLib] = (await Promise.all([
          apiService.createHlsPlaybackSession({
            camera_id: cameraId,
            start: new Date(anchorMs).toISOString(),
            end: new Date(seg.endMs).toISOString(),
          }),
          loadHls().catch(() => null),
        ])) as [any, typeof Hls | null]
        hlsLibRef.current = HlsLib
        const sessionId: string | null = res.data?.session_id || null
        if (!current()) {
          // Superseded while the session was being created — don't leak it.
          if (sessionId) apiService.deleteHlsPlaybackSession(sessionId).catch(() => {})
          return
        }
        manifestUrl = res.data?.manifest_url
        slot.sessionId = sessionId
        if (res.data?.needs_remux && res.data?.browser_mp4_url) {
          browserMp4Url = res.data.browser_mp4_url
          fileOffsetSec = res.data.file_offset_seconds || 0
        }
        if (!manifestUrl && !browserMp4Url) throw new Error('No manifest returned')
      } catch {
        fail()
        return
      }

      if (browserMp4Url) {
        // Remux path (H.265, or PCM audio): server-remuxed MP4 played natively. The remuxed
        // file is the whole physical on-disk file, beginning fileOffsetSec
        // before the session anchor — map the window to the file so every
        // in-file seek is a native HTTP-Range seek.
        const fileStartMs = anchorMs - fileOffsetSec * 1000
        el.src = browserMp4Url
        el.addEventListener(
          'loadedmetadata',
          () =>
            onReady({
              startMs: fileStartMs,
              endMs: fileStartMs + (isFinite(el.duration) ? el.duration * 1000 : seg.endMs - fileStartMs),
            }),
          { once: true }
        )
        el.addEventListener('error', fail, { once: true })
      } else if (hlsLibRef.current?.isSupported()) {
        const HlsLib = hlsLibRef.current
        const hls = new HlsLib({
          enableWorker: true,
          lowLatencyMode: false,
          backBufferLength: 10,
          maxBufferLength: 30,
          maxMaxBufferLength: 60,
        })
        slot.hls = hls
        hls.loadSource(manifestUrl)
        hls.attachMedia(el)
        hls.on(HlsLib.Events.MANIFEST_PARSED, () => onReady({ startMs: anchorMs, endMs: seg.endMs }))
        // Refine the window end with the real media duration: the session only
        // covers the physical file containing its anchor, which can be shorter
        // than the listed (merged) segment. Crossing that boundary then simply
        // triggers the next anchored session.
        hls.on(HlsLib.Events.LEVEL_LOADED, (_evt, data) => {
          if (!current()) return
          const dur = data?.details?.totalduration
          if (dur && slot.window) {
            slot.window = { startMs: anchorMs, endMs: anchorMs + dur * 1000 }
          }
        })
        hls.on(HlsLib.Events.ERROR, (_evt, data) => {
          if (!data.fatal) return
          if (data.type === HlsLib.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError()
          else if (data.type === HlsLib.ErrorTypes.NETWORK_ERROR) hls.startLoad()
        })
      } else if (el.canPlayType('application/vnd.apple.mpegurl')) {
        el.src = manifestUrl
        el.addEventListener(
          'loadedmetadata',
          () =>
            onReady({
              startMs: anchorMs,
              endMs: anchorMs + (isFinite(el.duration) ? el.duration * 1000 : seg.endMs - anchorMs),
            }),
          { once: true }
        )
      } else {
        fail()
      }
    },
    [cameraId, videoRefs, teardownSlot, settleAtMaster]
  )

  /** Make slot `i` (the standby) the visible, playing one. */
  const promote = useCallback(
    (i: number) => {
      const old = activeRef.current
      activeRef.current = i
      setActiveIdx(i)
      setBuffering(false)
      // Stop the old clip now, but keep its last frame until React has shown
      // the new element — clearing the source first would flash black.
      teardownSlot(old, false)
      videoRefs[old].current?.pause()
      const tok = slotsRef.current[old].token
      requestAnimationFrame(() => {
        const el = videoRefs[old].current
        if (slotsRef.current[old].token !== tok || !el || !el.getAttribute('src')) return
        el.removeAttribute('src')
        el.load()
      })
      const s = slotsRef.current[i]
      if (s.state === 'ready') {
        inFlightRef.current = null
        failRef.current = null
        setStatus('ok')
        settleAtMaster()
      } else {
        inFlightRef.current = { targetMs: s.targetMs ?? masterRef.current }
        setStatus('loading')
      }
    },
    [videoRefs, teardownSlot, settleAtMaster]
  )

  // ---- The follow loop: reconcile the tile against the master clock --------
  useEffect(() => {
    masterRef.current = masterMs
    playingRef.current = playing
    rateRef.current = rate
    mutedRef.current = muted

    const a = activeRef.current
    const sbIdx = 1 - a
    const el = videoRefs[a].current
    if (!el) return
    const m = masterMs

    // Live zone: footage here is still being written — not playable as VOD.
    if (liveEdgeMs != null && m >= liveEdgeMs) {
      if (!el.paused) el.pause()
      setStatus('live')
      return
    }

    const seg = segments.find((s) => m >= s.startMs - 200 && m < s.endMs)
    if (!seg) {
      if (!el.paused) el.pause()
      setStatus(segments.length ? 'gap' : 'idle')
      return
    }

    const w = slotsRef.current[a].window
    const inWindow = w && m >= w.startMs - 300 && m < w.endMs - 300
    if (!inWindow) {
      // Crossed into the prefetched clip: swap instead of loading.
      if (standbyCovers(slotsRef.current[sbIdx], m, w?.endMs ?? null)) {
        promote(sbIdx)
        return
      }
      // A load for (roughly) this instant is already in flight — let it land;
      // it settles at the then-current master. A far-away target supersedes it.
      if (inFlightRef.current && Math.abs(inFlightRef.current.targetMs - m) < 10_000) return
      // Recent failure at this spot — wait for the master to move on.
      if (failRef.current && Math.abs(failRef.current.targetMs - m) < 5_000) return
      // A fresh load somewhere else (a seek): the prefetched clip is moot.
      if (slotsRef.current[sbIdx].state !== 'empty') teardownSlot(sbIdx, true)
      loadInto(a, seg, m, null)
      return
    }

    // Inside the loaded media: drift-correct and apply transport state.
    if (el.readyState >= 1) {
      const wallMs = w.startMs + el.currentTime * 1000
      const tolMs = Math.max(1500, rate * 500)
      if (Math.abs(wallMs - m) > tolMs) {
        try {
          el.currentTime = clamp(
            (m - w.startMs) / 1000,
            0,
            isFinite(el.duration) ? Math.max(0, el.duration - 0.3) : Number.MAX_SAFE_INTEGER
          )
        } catch {
          /* not seekable yet */
        }
      }
    }
    if (el.playbackRate !== rate) el.playbackRate = rate
    if (el.muted !== muted) el.muted = muted
    if (playing && el.paused && !el.ended) el.play().catch(() => {})
    else if (!playing && !el.paused) el.pause()
    setStatus('ok')

    // Prefetch the next clip once the end is near — measured in footage
    // time, so faster playback starts earlier (~6 s ahead at 1x, ~34 s of
    // footage, i.e. ~4 s of real time, at 8x).
    if (playing && slotsRef.current[sbIdx].state === 'empty' && w.endMs - m < 2000 + rate * 4000) {
      const nextMs = w.endMs + 250
      const nextSeg = segments.find((s) => nextMs >= s.startMs - 200 && nextMs < s.endMs)
      if (nextSeg && !(liveEdgeMs != null && nextMs >= liveEdgeMs)) {
        loadInto(sbIdx, nextSeg, nextMs, w.endMs)
      }
    }
  }, [masterMs, playing, rate, muted, segments, liveEdgeMs, videoRefs, loadInto, promote, teardownSlot])

  // ---- Video element events ------------------------------------------------
  useEffect(() => {
    const offs = videoRefs.map((ref, i) => {
      const el = ref.current
      if (!el) return () => {}
      // The standby buffers in the background; only the shown one drives UI.
      const isActive = () => activeRef.current === i
      const onWaiting = () => isActive() && setBuffering(true)
      const onPlaying = () => isActive() && setBuffering(false)
      const onCanPlay = () => isActive() && setBuffering(false)
      const onEnded = () => {
        // Media ran out before the listed segment end (durations can overstate,
        // or the segment spans multiple physical files): shrink the window to
        // what actually played so the follow loop moves on to the next clip.
        if (!isActive()) return
        const s = slotsRef.current[i]
        if (s.window) s.window = { startMs: s.window.startMs, endMs: s.window.startMs + el.currentTime * 1000 }
      }
      el.addEventListener('waiting', onWaiting)
      el.addEventListener('playing', onPlaying)
      el.addEventListener('canplay', onCanPlay)
      el.addEventListener('ended', onEnded)
      return () => {
        el.removeEventListener('waiting', onWaiting)
        el.removeEventListener('playing', onPlaying)
        el.removeEventListener('canplay', onCanPlay)
        el.removeEventListener('ended', onEnded)
      }
    })
    return () => offs.forEach((off) => off())
  }, [videoRefs])

  // Cleanup on unmount (also covers deselecting the camera).
  useEffect(() => {
    return () => {
      teardownSlot(0, true)
      teardownSlot(1, true)
    }
  }, [teardownSlot])

  // Coded size of the loaded clip vs. the aspect it should be shown at.
  const videoSize = useVideoSize(videoRef)
  const videoAspect = useMemo(
    () => displayAspect(videoSize?.width, videoSize?.height, displayAspectOverride),
    [videoSize?.width, videoSize?.height, displayAspectOverride]
  )
  const stretched = isStretched(videoSize?.width, videoSize?.height, videoAspect)
  const dewarp = useDewarp(cameraId, fisheye)
  const fisheyeRef = useRef<FisheyeViewHandle>(null)

  const showSpinner = status === 'loading' || (status === 'ok' && buffering)

  return (
    <div
      onClick={onActivate}
      className="relative bg-black overflow-hidden cursor-pointer flex items-center justify-center aspect-video lg:aspect-auto"
      style={{ containerType: 'size' }}
    >
      {/* The clip carries the camera's coded size, which for an anamorphic
          stream is not the size to show it at — see lib/aspect.ts (#354). */}
      <AspectFrame aspect={dewarp.active ? null : videoAspect}>
        {videoRefs.map((ref, i) => (
          <video
            key={i}
            ref={ref}
            className={
              i === activeIdx
                ? `block w-full h-full ${stretched ? 'object-fill' : 'object-contain'}`
                : 'absolute inset-0 w-full h-full opacity-0 pointer-events-none'
            }
            playsInline
            preload="auto"
            crossOrigin="anonymous"
          />
        ))}
        {dewarp.active && dewarp.lens && dewarp.views && (
          <FisheyeView
            ref={fisheyeRef}
            videoRef={videoRef}
            lens={dewarp.lens}
            mode={dewarp.mode}
            views={dewarp.views}
            onViewsChange={dewarp.saveViews}
            onUnsupported={dewarp.markUnsupported}
            className="absolute inset-0 w-full h-full"
          />
        )}
      </AspectFrame>

      {dewarp.modes.length > 0 && (
        <div className="absolute right-1 top-1 z-30 text-white/80">
          <DewarpMenu
            modes={dewarp.modes}
            mode={dewarp.mode}
            onChange={dewarp.setMode}
            onReset={() => fisheyeRef.current?.reset()}
            placement="down"
            buttonClassName="p-1 rounded bg-black/40 hover:bg-black/60 transition-colors"
            iconSize={14}
          />
        </div>
      )}

      {/* Label band, as on Live View and the dashboard wall: legible over
          any picture without a solid bar. The speaker marks the tile whose
          audio is playing. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-9 bg-gradient-to-b from-black/75 to-transparent" />
      <div className="pointer-events-none absolute left-2 right-2 top-1.5 z-10 flex items-center gap-1.5 text-white">
        <span className="text-[11px] font-medium truncate [text-shadow:0_1px_2px_rgba(0,0,0,0.9)]">{cameraName}</span>
        {active && !muted && <Volume2 size={11} className="shrink-0 text-[var(--accent)]" aria-hidden="true" />}
      </div>

      {/* Selected tile: an inset ring, so the hairline grid never shifts. */}
      {active && <div className="pointer-events-none absolute inset-0 z-20 ring-1 ring-inset ring-[var(--accent)]" />}

      {showSpinner && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/30 pointer-events-none">
          <div className="w-5 h-5 border-2 border-white/25 border-t-white/80 rounded-full animate-spin" />
        </div>
      )}

      {(status === 'gap' || status === 'idle') && (
        <div
          className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 text-white/45 pointer-events-none"
          style={{ background: 'repeating-linear-gradient(135deg, #07090d 0 10px, #0b0f16 10px 20px)' }}
        >
          <CameraOff size={18} />
          <span className="text-[10px] font-mono uppercase tracking-[0.2em]">{t('shared.noRecordingNow')}</span>
        </div>
      )}

      {status === 'live' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-black/70 pointer-events-none">
          <Radio size={18} className="text-[var(--on-video-ok)] animate-pulse" />
          <span className="text-[10px] font-mono uppercase tracking-[0.2em] text-[var(--on-video)]">{t('shared.stillRecording')}</span>
        </div>
      )}

      {status === 'error' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-black/70 pointer-events-none">
          <AlertCircle size={18} className="text-[var(--on-video-warn)]" />
          <span className="text-[10px] font-mono uppercase tracking-[0.2em] text-[var(--on-video-warn)]">{t('shared.playbackFailed')}</span>
        </div>
      )}
    </div>
  )
}
