// Copyright (c) 2026 OpenNVR
// SPDX-License-Identifier: AGPL-3.0-or-later

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { RefObject } from 'react'
import {
  defaultViews,
  dragViews,
  layoutRegions,
  mountMatrix,
  zoomViews,
} from '../../lib/fisheye'
import type { DewarpMode, DewarpViews, FisheyeLens, Region } from '../../lib/fisheye'

export interface FisheyeViewHandle {
  /** The dewarped picture as it is on screen, for snapshots. null before
      the first frame has arrived. */
  capture: () => HTMLCanvasElement | null
  /** Aim every view back at the mount's defaults. */
  reset: () => void
}

interface FisheyeViewProps {
  /** The (hidden-behind-us) <video> whose frames get dewarped. */
  videoRef: RefObject<HTMLVideoElement | null>
  lens: FisheyeLens
  mode: DewarpMode
  /** Where the views START. From then on this component owns them — a drag
      runs at frame rate without a React render — and reports them back
      through onViewsChange once each gesture settles. */
  views: DewarpViews
  onViewsChange?: (views: DewarpViews) => void
  /** Off for glance surfaces (the dashboard wall): pointer and wheel go to
      whatever is underneath, e.g. the grid's own drag handles. */
  interactive?: boolean
  /** A click that was not a drag — PlaybackConsole's click-to-pause. */
  onTap?: () => void
  /** No WebGL, a frame bigger than the GPU's texture limit, or a tainted
      video: the caller should fall back to the raw circle. */
  onUnsupported?: () => void
  className?: string
}

const VERTEX = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`

// One region per draw: viewport + scissor confine it, u_region maps
// gl_FragCoord back to 0..1 inside it. See lib/fisheye.ts for the frames.
const FRAGMENT = `
precision highp float;
uniform sampler2D u_tex;
uniform vec4 u_region;    // x, y, w, h in device px, GL (bottom-left) origin
uniform int u_kind;       // 0 perspective, 1 equirect
uniform vec2 u_angles;    // yaw, pitch (rad)
uniform vec2 u_span;      // perspective: tan(h/2), tan(v/2); equirect: h, v (rad)
uniform mat3 u_mount;     // world -> lens
uniform vec2 u_center;    // circle centre, texture uv
uniform vec2 u_radius;    // circle radius, uv units per axis
uniform float u_thetaMax; // half the lens FOV (rad)

void main() {
  vec2 p = (gl_FragCoord.xy - u_region.xy) / u_region.zw;
  float cy = cos(u_angles.x);
  float sy = sin(u_angles.x);
  vec3 dir;
  if (u_kind == 0) {
    vec3 r = normalize(vec3((p.x * 2.0 - 1.0) * u_span.x, (p.y * 2.0 - 1.0) * u_span.y, 1.0));
    float cp = cos(u_angles.y);
    float sp = sin(u_angles.y);
    r = vec3(r.x, r.y * cp + r.z * sp, r.z * cp - r.y * sp);
    dir = vec3(r.x * cy + r.z * sy, r.y, r.z * cy - r.x * sy);
  } else {
    float yaw = u_angles.x + (p.x - 0.5) * u_span.x;
    float pitch = u_angles.y + (p.y - 0.5) * u_span.y;
    dir = vec3(cos(pitch) * sin(yaw), sin(pitch), cos(pitch) * cos(yaw));
  }
  vec3 lens = u_mount * dir;
  float theta = acos(clamp(lens.z, -1.0, 1.0));
  if (theta > u_thetaMax) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  float rho = length(lens.xy);
  vec2 d = rho > 1e-6 ? lens.xy / rho : vec2(0.0);
  vec2 uv = u_center + d * (theta / u_thetaMax) * u_radius;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  gl_FragColor = texture2D(u_tex, uv);
}
`

const UNIFORMS = [
  'u_tex', 'u_region', 'u_kind', 'u_angles', 'u_span',
  'u_mount', 'u_center', 'u_radius', 'u_thetaMax',
] as const
type UniformName = (typeof UNIFORMS)[number]

/** Pixels a press may wander and still count as a click, not a drag. */
const TAP_SLOP = 4
/** Gesture-settled delay before a wheel zoom is reported (and persisted). */
const WHEEL_SETTLE_MS = 400

const RAD = Math.PI / 180

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const sh = gl.createShader(type)
  if (!sh) return null
  gl.shaderSource(sh, src)
  gl.compileShader(sh)
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.warn('[FisheyeView] shader:', gl.getShaderInfoLog(sh))
    gl.deleteShader(sh)
    return null
  }
  return sh
}

/**
 * Dewarps a fisheye <video> on the GPU into the panorama / virtual-PTZ
 * layouts of lib/fisheye.ts, and lets the operator drag (pan/tilt) and
 * scroll or pinch (zoom) each view.
 *
 * Sits ON TOP of the video rather than replacing it: the <video> keeps
 * decoding, keeps its event wiring (loading, errors, timeupdate) and stays
 * what tests and the rest of the player query. Each new frame is uploaded
 * once (requestVideoFrameCallback, so a 15 fps camera costs 15 uploads, not
 * 60) and the picture is only redrawn when a frame or a view changed.
 */
export const FisheyeView = forwardRef<FisheyeViewHandle, FisheyeViewProps>(function FisheyeView(
  { videoRef, lens, mode, views, onViewsChange, interactive = true, onTap, onUnsupported, className = '' },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  // Bumped on webglcontextrestored to rebuild every GPU resource.
  const [generation, setGeneration] = useState(0)

  // Everything the render loop and the pointer handlers read lives in refs:
  // a drag must not wait on (or cause) a React render.
  const viewsRef = useRef(views)
  const lensRef = useRef(lens)
  const modeRef = useRef(mode)
  const regionsRef = useRef<Region[]>([])
  const dirtyRef = useRef(true)
  const drawRef = useRef<() => boolean>(() => false)
  const callbacksRef = useRef({ onViewsChange, onTap, onUnsupported })
  callbacksRef.current = { onViewsChange, onTap, onUnsupported }

  useEffect(() => {
    lensRef.current = lens
    modeRef.current = mode
    dirtyRef.current = true
  }, [lens, mode])

  // ── GPU: context, program, render loop ──────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const gl = canvas.getContext('webgl', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
    })
    if (!gl) {
      callbacksRef.current.onUnsupported?.()
      return
    }

    const vs = compile(gl, gl.VERTEX_SHADER, VERTEX)
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT)
    const program = gl.createProgram()
    if (!vs || !fs || !program) {
      callbacksRef.current.onUnsupported?.()
      return
    }
    gl.attachShader(program, vs)
    gl.attachShader(program, fs)
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.warn('[FisheyeView] link:', gl.getProgramInfoLog(program))
      callbacksRef.current.onUnsupported?.()
      return
    }
    gl.useProgram(program)
    const u = Object.fromEntries(
      UNIFORMS.map((n) => [n, gl.getUniformLocation(program, n)]),
    ) as Record<UniformName, WebGLUniformLocation | null>

    // A full-viewport quad; each region narrows the viewport to itself.
    const buffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
    const aPos = gl.getAttribLocation(program, 'a_pos')
    gl.enableVertexAttribArray(aPos)
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0)

    // Video frames are NPOT, so WebGL1 needs clamp + no mipmaps.
    const texture = gl.createTexture()
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.uniform1i(u.u_tex, 0)
    const maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number

    let frameW = 0
    let frameH = 0
    let newFrame = true
    let stopped = false
    let cssW = 0
    let cssH = 0
    let dpr = 1

    const fail = () => {
      stopped = true
      callbacksRef.current.onUnsupported?.()
    }

    const upload = (video: HTMLVideoElement): boolean => {
      if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) return false
      if (video.videoWidth > maxTexture || video.videoHeight > maxTexture) {
        console.warn(`[FisheyeView] ${video.videoWidth}x${video.videoHeight} exceeds this GPU's ${maxTexture}px texture limit`)
        fail()
        return false
      }
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, video)
      } catch (e) {
        // SecurityError: a cross-origin source without CORS taints the frame.
        console.warn('[FisheyeView] cannot read video frames:', e)
        fail()
        return false
      }
      frameW = video.videoWidth
      frameH = video.videoHeight
      return true
    }

    /** Draw the current layout. False while there is no frame yet. */
    const draw = (): boolean => {
      const cw = canvas.width
      const ch = canvas.height
      gl.disable(gl.SCISSOR_TEST)
      gl.viewport(0, 0, cw, ch)
      gl.clearColor(0, 0, 0, 1)
      gl.clear(gl.COLOR_BUFFER_BIT)
      if (!frameW || !cw || !ch) return false

      const l = lensRef.current
      const regions = layoutRegions(modeRef.current, l, viewsRef.current, cssW, cssH)
      regionsRef.current = regions

      const radiusPx = l.radius * Math.min(frameW, frameH)
      gl.uniformMatrix3fv(u.u_mount, false, mountMatrix(l.mount))
      gl.uniform2f(u.u_center, l.center_x, l.center_y)
      gl.uniform2f(u.u_radius, radiusPx / frameW, radiusPx / frameH)
      gl.uniform1f(u.u_thetaMax, (l.fov / 2) * RAD)

      gl.enable(gl.SCISSOR_TEST)
      for (const r of regions) {
        const x0 = Math.round(r.x * dpr)
        const x1 = Math.round((r.x + r.w) * dpr)
        const top = Math.round(r.y * dpr)
        const bottom = Math.round((r.y + r.h) * dpr)
        const gx = x0
        const gy = ch - bottom
        const gw = x1 - x0
        const gh = bottom - top
        if (gw <= 0 || gh <= 0) continue
        gl.viewport(gx, gy, gw, gh)
        gl.scissor(gx, gy, gw, gh)
        gl.uniform4f(u.u_region, gx, gy, gw, gh)
        gl.uniform2f(u.u_angles, r.yaw * RAD, r.pitch * RAD)
        if (r.kind === 'perspective') {
          gl.uniform1i(u.u_kind, 0)
          gl.uniform2f(u.u_span, Math.tan((r.hspan / 2) * RAD), Math.tan((r.vspan / 2) * RAD))
        } else {
          gl.uniform1i(u.u_kind, 1)
          gl.uniform2f(u.u_span, r.hspan * RAD, r.vspan * RAD)
        }
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
      }
      return true
    }
    drawRef.current = () => (stopped ? false : draw())

    // Track the box in CSS px and back the canvas at device resolution
    // (capped at 2x — past that the source frame is the limit, not us).
    const resize = () => {
      const rect = canvas.getBoundingClientRect()
      dpr = Math.min(window.devicePixelRatio || 1, 2)
      cssW = rect.width
      cssH = rect.height
      const w = Math.max(1, Math.round(cssW * dpr))
      const h = Math.max(1, Math.round(cssH * dpr))
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
      }
      dirtyRef.current = true
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(canvas)

    // New-frame signal. requestVideoFrameCallback fires once per presented
    // frame; without it, a playing video is assumed to have one per tick.
    const video = videoRef.current
    let vfcHandle = 0
    const hasVfc = !!video && 'requestVideoFrameCallback' in video
    const onVideoFrame = () => {
      newFrame = true
      if (video && !stopped) vfcHandle = video.requestVideoFrameCallback(onVideoFrame)
    }
    if (video && hasVfc) vfcHandle = video.requestVideoFrameCallback(onVideoFrame)
    // A seek while paused, or a new source, presents a frame without play.
    const markFrame = () => { newFrame = true }
    const frameEvents = ['loadeddata', 'seeked', 'resize', 'playing'] as const
    frameEvents.forEach((ev) => video?.addEventListener(ev, markFrame))

    let raf = 0
    const tick = () => {
      if (stopped) return
      raf = requestAnimationFrame(tick)
      const v = videoRef.current
      if (!v) return
      if (!hasVfc && !v.paused) newFrame = true
      if (newFrame && upload(v)) {
        newFrame = false
        dirtyRef.current = true
      }
      if (dirtyRef.current && !stopped) {
        dirtyRef.current = false
        draw()
      }
    }
    raf = requestAnimationFrame(tick)

    const onLost = (e: Event) => {
      e.preventDefault() // lets the browser restore the context later
      stopped = true
      cancelAnimationFrame(raf)
    }
    const onRestored = () => setGeneration((g) => g + 1)
    canvas.addEventListener('webglcontextlost', onLost)
    canvas.addEventListener('webglcontextrestored', onRestored)

    return () => {
      stopped = true
      cancelAnimationFrame(raf)
      if (video && hasVfc && vfcHandle) video.cancelVideoFrameCallback(vfcHandle)
      frameEvents.forEach((ev) => video?.removeEventListener(ev, markFrame))
      ro.disconnect()
      canvas.removeEventListener('webglcontextlost', onLost)
      canvas.removeEventListener('webglcontextrestored', onRestored)
      drawRef.current = () => false
      // Free the resources but NOT the context: StrictMode re-runs this
      // effect on the same canvas, and a lost context would stay lost.
      gl.deleteTexture(texture)
      gl.deleteBuffer(buffer)
      gl.deleteProgram(program)
      gl.deleteShader(vs)
      gl.deleteShader(fs)
    }
  }, [videoRef, generation])

  // ── interaction: drag to pan/tilt, wheel or pinch to zoom ───────────────
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !interactive) return

    const points = new Map<number, { x: number; y: number }>()
    let drag: { x: number; y: number; region: Region; views: DewarpViews; moved: boolean } | null = null
    let pinch: { dist: number; region: Region; views: DewarpViews } | null = null
    let wheelTimer = 0

    const local = (e: { clientX: number; clientY: number }) => {
      const rect = canvas.getBoundingClientRect()
      return { x: e.clientX - rect.left, y: e.clientY - rect.top }
    }
    const regionAt = (p: { x: number; y: number }) =>
      regionsRef.current.find((r) => p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h) ?? null
    const apply = (next: DewarpViews) => {
      viewsRef.current = next
      dirtyRef.current = true
    }
    const report = () => callbacksRef.current.onViewsChange?.(viewsRef.current)
    const spread = () => {
      const [a, b] = [...points.values()]
      return Math.hypot(a.x - b.x, a.y - b.y)
    }

    const onDown = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return
      // Stop here, or a Live View tile's drag-to-rearrange starts too.
      e.stopPropagation()
      try {
        // Keep the drag alive when the cursor leaves the tile.
        canvas.setPointerCapture(e.pointerId)
      } catch {
        // Pointer already gone (released mid-dispatch): drag without capture.
      }
      const p = local(e)
      points.set(e.pointerId, p)
      if (points.size === 1) {
        const region = regionAt(p)
        drag = region ? { ...p, region, views: viewsRef.current, moved: false } : null
      } else if (points.size === 2) {
        const [a, b] = [...points.values()]
        const region = regionAt({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
        drag = null
        pinch = region && region.kind === 'perspective'
          ? { dist: spread(), region, views: viewsRef.current }
          : null
      }
      canvas.style.cursor = 'grabbing'
    }
    const onMove = (e: PointerEvent) => {
      if (!points.has(e.pointerId)) return
      const p = local(e)
      points.set(e.pointerId, p)
      if (drag) {
        const dx = p.x - drag.x
        const dy = p.y - drag.y
        if (!drag.moved && Math.hypot(dx, dy) > TAP_SLOP) drag.moved = true
        if (drag.moved) apply(dragViews(lensRef.current, drag.views, drag.region, dx, dy))
      } else if (pinch && points.size === 2) {
        const dist = spread()
        if (dist > 0) apply(zoomViews(lensRef.current, pinch.views, pinch.region.target, pinch.dist / dist))
      }
    }
    const onUp = (e: PointerEvent) => {
      if (!points.delete(e.pointerId)) return
      if (drag && !drag.moved && e.type === 'pointerup') callbacksRef.current.onTap?.()
      if ((drag && drag.moved) || pinch) report()
      drag = null
      if (points.size < 2) pinch = null
      if (points.size === 0) canvas.style.cursor = ''
    }
    const onWheel = (e: WheelEvent) => {
      const region = regionAt(local(e))
      // Panoramas don't zoom; leave the wheel to the page there.
      if (!region || region.kind !== 'perspective') return
      e.preventDefault()
      const px = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY
      apply(zoomViews(lensRef.current, viewsRef.current, region.target, Math.exp(px * 0.0015)))
      window.clearTimeout(wheelTimer)
      wheelTimer = window.setTimeout(report, WHEEL_SETTLE_MS)
    }

    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('pointerup', onUp)
    canvas.addEventListener('pointercancel', onUp)
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      window.clearTimeout(wheelTimer)
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('pointercancel', onUp)
      canvas.removeEventListener('wheel', onWheel)
    }
  }, [interactive])

  useImperativeHandle(ref, () => ({
    capture: () => {
      const canvas = canvasRef.current
      // Draw and copy in the same task: without preserveDrawingBuffer the
      // buffer is only guaranteed until the browser composites it.
      if (!canvas || !drawRef.current()) return null
      const out = document.createElement('canvas')
      out.width = canvas.width
      out.height = canvas.height
      const ctx = out.getContext('2d')
      if (!ctx) return null
      ctx.drawImage(canvas, 0, 0)
      return out
    },
    reset: () => {
      viewsRef.current = defaultViews(lensRef.current)
      dirtyRef.current = true
      callbacksRef.current.onViewsChange?.(viewsRef.current)
    },
  }), [])

  return (
    <canvas
      ref={canvasRef}
      className={`block bg-black ${interactive ? 'cursor-grab touch-none' : 'pointer-events-none'} ${className}`}
    />
  )
})
