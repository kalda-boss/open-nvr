// Copyright (c) 2026 OpenNVR
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * One live tile: a camera's player, its label band, offline overlay and PTZ
 * pad. Shared by the desktop wall (views/LiveView.tsx) and the phone view
 * (views/live/PhoneLiveView.tsx).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { apiService } from '../../lib/apiService'
import { rebaseToCurrentOrigin } from '../../lib/streamUrl'
import { VideoPlayer, type VideoPlayerHandle } from '../../components/VideoPlayer'
import type { AspectOverride } from '../../lib/aspect'
import type { FisheyeLens } from '../../lib/fisheye'
import { AddCameraDialog } from '../../components/AddCameraDialog'
import { useCameraStatus } from '../../hooks/useCameraStatus'
import { CameraOff, Square, Plus, Minus, AlertCircle } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { useCameras } from '../../lib/queries'
import { STATE_INK, type CamState } from '../dashboard/WidgetFrame'

/** The dashboard wall's still-tile background, for tiles with no picture. */
export const NO_PICTURE_BG = 'repeating-linear-gradient(135deg, #07090d 0 10px, #0b0f16 10px 20px)'

/** What a live tile needs to know about a camera. */
export interface LiveCamera {
  id: number
  name: string
  live_online?: boolean | null
  display_aspect_ratio?: AspectOverride | null
  fisheye?: FisheyeLens | null
}

export function Tile({ 
  index, 
  availableCameras, 
  assignedCameraId,
  onCameraSelected,
  onCameraAdded,
  isDragging = false,
  canManage = false,
  showDetections = false,
  muted = true,
  onMutedChange,
}: { 
  index: number
  availableCameras: LiveCamera[]
  assignedCameraId?: number | null
  onCameraSelected?: (cameraId: number) => void
  onCameraAdded?: () => void
  isDragging?: boolean
  showDetections?: boolean
  canManage?: boolean
  /** Sound off (the default, and always on the wall); see VideoPlayer. */
  muted?: boolean
  onMutedChange?: (muted: boolean) => void
}) {
  const { t } = useTranslation()
  const [cameraId, setCameraId] = useState<number | null>(null)
  const [cameraName, setCameraName] = useState<string>('')
  const [urls, setUrls] = useState<{ whep?: string; hls?: string; token?: string } | null>(null)
  const playerRef = useRef<VideoPlayerHandle>(null)
  const [ptzOpen, setPtzOpen] = useState(false)
  const [showCameraDialog, setShowCameraDialog] = useState(false)

  // Close the PTZ pad when the tile's camera changes.
  useEffect(() => {
    setPtzOpen(false)
  }, [assignedCameraId])
  // Backend-pushed connectivity: `status` drives the offline overlay;
  // `version` bumps on each recovery, re-running the URL fetch below (fresh
  // 60-min stream token) and remounting the player so the stream resumes
  // without any user action.
  const { status: connectivity, version: streamVersion } = useCameraStatus(assignedCameraId)
  // The socket carries transitions, so `connectivity` stays undefined for a
  // camera that was already down when this mounted. Fall back to the state the
  // camera list reported. Deliberately NOT fed into streamVersion: the player
  // remount on recovery has to stay driven by a real transition, or a list
  // refresh would tear down a healthy stream and re-mint its token.
  const effectiveConnectivity =
    connectivity ??
    (availableCameras.find(c => c.id === assignedCameraId)?.live_online === false
      ? 'offline'
      : undefined)
  // Bumped when the player reports an auth-rejected stream request — the
  // 60-min token expired mid-session (e.g. a stream hiccup hours in; the
  // backend never saw the camera go offline, so streamVersion won't bump).
  // Re-runs the URL fetch below for a fresh token. Throttled so a
  // persistent non-auth 400 can't hammer the token endpoint.
  const [tokenVersion, setTokenVersion] = useState(0)
  const lastTokenRefreshRef = useRef(0)
  const handleAuthExpired = useCallback(() => {
    const now = Date.now()
    if (now - lastTokenRefreshRef.current < 10000) return
    lastTokenRefreshRef.current = now
    setTokenVersion((v) => v + 1)
  }, [])

  useEffect(() => {
    let alive = true
    // Use assigned camera if provided, otherwise no camera
    const camera = assignedCameraId
      ? availableCameras.find(c => c.id === assignedCameraId)
      : null
    if (camera) {
      setCameraId(camera.id)
      setCameraName(camera.name)
      ;(async () => {
        try {
          const { data } = await apiService.getStreamUrls(camera.id)
          if (!alive) return
          setUrls({
            // Rebase onto the origin the UI is being served from — the
            // backend pins these to the LAN IP, which breaks playback
            // when browsing via https://localhost (see lib/streamUrl.ts).
            whep: rebaseToCurrentOrigin(data.urls?.webrtc),
            hls: rebaseToCurrentOrigin(data.urls?.hls),
            token: data.token
          })
        } catch {
          // Show NO LINK instead of silently keeping stale URLs/token.
          if (alive) setUrls(null)
        }
      })()
    } else {
      setCameraId(null)
      setCameraName('')
      setUrls(null)
    }
    return () => { alive = false }
  }, [assignedCameraId, availableCameras, streamVersion, tokenVersion])

  const hasLink = !!urls?.whep || !!urls?.hls
  const displayName = cameraName || `Camera ${cameraId || index + 1}`
  const assignedCamera = availableCameras.find((c) => c.id === assignedCameraId)
  
  const handleSnapshot = (dataUrl: string) => {
    const a = document.createElement('a')
    a.href = dataUrl
    a.download = `${displayName.replace(/\s+/g, '-')}-${Date.now()}.jpg`
    document.body.appendChild(a)
    a.click()
    a.remove()
  }

  const handleCameraSelected = (cameraId?: number) => {
    setShowCameraDialog(false)
    if (cameraId) {
      onCameraSelected?.(cameraId)
    }
    onCameraAdded?.()
  }

  const handleExistingCameraSelected = (cameraId: number) => {
    onCameraSelected?.(cameraId)
    setShowCameraDialog(false)
  }
  
  // Label state, in the dashboard wall's terms: the list query refreshes on
  // its own, so REC and the dot follow the recorder without a remount.
  const cams = useCameras()
  const listed = cams.data?.cameras?.find((c) => c.id === cameraId)
  const rec = listed?.recording_state
  const state: CamState =
    effectiveConnectivity === 'offline' ? 'offline'
      : connectivity === 'online' || (listed?.live_online ?? assignedCamera?.live_online) === true ? 'online'
        : 'degraded'

  return (
    <div className="relative h-full overflow-hidden bg-black">
      {/* Absolute so the <video>'s intrinsic size (e.g. a 1:1 stream) can't
          stretch this box — the player sizes itself to the stream's DISPLAY
          aspect inside it and letterboxes against black. */}
      <div className="absolute inset-0">
        {hasLink ? (
          <VideoPlayer
            key={`${cameraId}-${streamVersion}`}
            ref={playerRef}
            mode="live"
            chrome="controls"
            whepUrl={urls?.whep}
            hlsUrl={urls?.hls}
            mediamtxToken={urls?.token}
            onAuthExpired={handleAuthExpired}
            title={displayName}
            preferredStreamType="webrtc"
            autoPlay
            muted={muted}
            onMutedChange={onMutedChange}
            onSnapshot={handleSnapshot}
            displayAspectOverride={assignedCamera?.display_aspect_ratio}
            fisheye={assignedCamera?.fisheye}
            cameraId={cameraId}
            showDetections={showDetections}
            onTogglePtz={() => setPtzOpen((s) => !s)}
            ptzActive={ptzOpen}
              overlay={ptzOpen && cameraId ? (
                /* Mini PTZ pad — rendered inside the player so it survives
                   the player element going fullscreen; sits above the
                   controls bar (~72px incl. gradient) */
                <div className="absolute left-2 bottom-20 z-30 bg-black/80 p-2 border border-[var(--border)] text-[10px]">
                  <div className="grid grid-cols-3 gap-1">
                    <button className="px-1 py-1 bg-[var(--panel-2)] border border-[var(--border)] hover:bg-[var(--accent)]/30" onMouseDown={() => ptzMove(cameraId, 0, 0.5)} onMouseUp={() => ptzStop(cameraId)} onMouseLeave={() => ptzStop(cameraId)}>&uarr;</button>
                    <button className="px-1 py-1 bg-[var(--panel-2)] border border-[var(--border)]" onClick={() => ptzStop(cameraId)}><Square size={12} /></button>
                    <button className="px-1 py-1 bg-[var(--panel-2)] border border-[var(--border)] hover:bg-[var(--accent)]/30" onMouseDown={() => ptzMove(cameraId, 0, -0.5)} onMouseUp={() => ptzStop(cameraId)} onMouseLeave={() => ptzStop(cameraId)}>&darr;</button>
                    <button className="px-1 py-1 bg-[var(--panel-2)] border border-[var(--border)] hover:bg-[var(--accent)]/30" onMouseDown={() => ptzMove(cameraId, -0.5, 0)} onMouseUp={() => ptzStop(cameraId)} onMouseLeave={() => ptzStop(cameraId)}>&larr;</button>
                    <button className="px-1 py-1 bg-[var(--panel-2)] border border-[var(--border)] hover:bg-[color-mix(in_oklab,var(--danger)_30%,transparent)]" onClick={() => setPtzOpen(false)}>Close</button>
                    <button className="px-1 py-1 bg-[var(--panel-2)] border border-[var(--border)] hover:bg-[var(--accent)]/30" onMouseDown={() => ptzMove(cameraId, 0.5, 0)} onMouseUp={() => ptzStop(cameraId)} onMouseLeave={() => ptzStop(cameraId)}>&rarr;</button>
                    <button className="px-1 py-1 bg-[var(--panel-2)] border border-[var(--border)] hover:bg-[var(--accent)]/30" onMouseDown={() => ptzMove(cameraId, 0, 0, 0.5)} onMouseUp={() => ptzStop(cameraId)} onMouseLeave={() => ptzStop(cameraId)}><Plus size={12} /></button>
                    <div />
                    <button className="px-1 py-1 bg-[var(--panel-2)] border border-[var(--border)] hover:bg-[var(--accent)]/30" onMouseDown={() => ptzMove(cameraId, 0, 0, -0.5)} onMouseUp={() => ptzStop(cameraId)} onMouseLeave={() => ptzStop(cameraId)}><Minus size={12} /></button>
                  </div>
                </div>
              ) : null}
            className="w-full h-full !bg-black"
          />
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center gap-2 text-white/45" style={{ background: NO_PICTURE_BG }}>
            {cameraId ? (
              <>
                <CameraOff size={18} />
                <span className="text-[10px] font-mono uppercase tracking-[0.2em]">{t('live.noStream')}</span>
              </>
            ) : canManage ? (
              <>
                <button
                  className="w-9 h-9 border border-dashed border-white/20 hover:border-[var(--accent)] hover:bg-[var(--accent)]/10 transition-colors flex items-center justify-center group"
                  onClick={() => setShowCameraDialog(true)}
                  title={t('live.addCamera')}
                >
                  <Plus size={16} className="text-white/50 group-hover:text-[var(--accent)]" />
                </button>
                <span className="text-[10px] font-mono uppercase tracking-[0.2em]">{t('live.clickToAdd')}</span>
              </>
            ) : (
              <span className="text-[10px] font-mono uppercase tracking-[0.2em]">{t('live.noAssigned')}</span>
            )}
          </div>
        )}
      </div>

      {/* Offline overlay — from the camera list on first paint, then from
          backend camera_status events. Clears itself (and the player
          restarts via the key above) when the camera comes back; no user
          interaction needed. */}
      {cameraId && effectiveConnectivity === 'offline' && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-1.5 text-white/45 text-center" style={{ background: NO_PICTURE_BG }}>
          <AlertCircle size={18} className="text-[var(--on-video-warn)]" />
          <div className="text-[10px] font-mono uppercase tracking-[0.2em] text-[var(--on-video-warn)]">{t('live.cameraOffline')}</div>
          <div className="text-[10px] text-white/35">{t('live.waitingReconnect')}</div>
        </div>
      )}

      {/* Label band, as on the dashboard wall: state dot, name, REC — legible
          over any picture without a solid bar. Above the offline overlay so
          a dead tile still says which camera it is. */}
      {cameraId && (
        <>
          <div className="pointer-events-none absolute inset-x-0 top-0 z-30 h-9 bg-gradient-to-b from-black/75 to-transparent" />
          <div className="pointer-events-none absolute left-2 right-2 top-1.5 z-30 flex items-center gap-1.5 text-white">
            <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: STATE_INK[state] }} aria-hidden="true" />
            <span className="text-[11px] font-medium truncate [text-shadow:0_1px_2px_rgba(0,0,0,0.9)]">{displayName}</span>
            <span className="ml-auto shrink-0 flex items-center gap-2 leading-none text-[9px] font-bold tracking-[0.15em] [text-shadow:0_1px_2px_rgba(0,0,0,0.9)]">
              {!hasLink && <span className="text-[var(--on-video-warn)]">{t('live.noLink')}</span>}
              {rec === 'recording' ? (
                <span className="flex items-center gap-1 text-[var(--on-video-danger)]">
                  <span className="w-1.5 h-1.5 rounded-full bg-[var(--on-video-danger)] animate-pulse" aria-hidden="true" />REC
                </span>
              ) : rec === 'stalled' ? (
                <span className="text-[var(--on-video-warn)]">{t('dashboard.stalled').toUpperCase()}</span>
              ) : null}
            </span>
          </div>
        </>
      )}

      {/* Camera Selection/Add Dialog */}
      {showCameraDialog && (
        <AddCameraDialog 
          onClose={() => setShowCameraDialog(false)}
          onCameraAdded={handleCameraSelected}
          onCameraSelected={handleExistingCameraSelected}
          existingCameras={availableCameras}
        />
      )}
    </div>
  )
}

export async function ptzMove(cameraId: number, x: number, y: number, z: number = 0) {
  console.log('PTZ Move:', { cameraId, x, y, z })
  try {
    const result = await apiService.ptzMove(cameraId, x, y, z)
    console.log('PTZ Move result:', result)
  } catch (err) {
    console.error('PTZ move failed:', err)
  }
}

export async function ptzStop(cameraId: number) {
  console.log('PTZ Stop:', { cameraId })
  try {
    const result = await apiService.ptzStop(cameraId)
    console.log('PTZ Stop result:', result)
  } catch (err) {
    console.error('PTZ stop failed:', err)
  }
}
