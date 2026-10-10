// Copyright (c) 2026 OpenNVR
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Fisheye (360°) dewarping — the geometry half. FisheyeView owns the GPU half.
 *
 * A 360° camera (Illumivue IP5VD360, and the Uniview / Hikvision / Dahua
 * fisheyes it is built like) sends the raw lens circle; its vendor client
 * flattens that into panoramas and a draggable "virtual PTZ". OpenNVR does
 * the same in the browser: the stream, the recordings and MediaMTX never
 * change, and every view is rebuilt per frame from the untouched circle.
 *
 * Model. Directions live in a WORLD frame — x right, y up, z forward —
 * that is level whichever way the camera hangs. Views are aimed with yaw
 * (about y, positive turns right) and pitch (positive looks up), in degrees.
 * The mount maps world directions into the LENS frame (x right and y down
 * in the image, z out of the lens), and an equidistant lens puts a ray
 * `theta` off the axis at `theta / (fov/2)` of the circle's radius — the
 * f-theta projection almost every surveillance fisheye uses.
 */

export type FisheyeMount = 'ceiling' | 'wall' | 'desk'

/** Mirrors server schemas.FisheyeLens. */
export interface FisheyeLens {
  mount: FisheyeMount
  /** Circle centre, as fractions of the frame's width and height. */
  center_x: number
  center_y: number
  /** Circle radius as a fraction of the frame's shorter side. */
  radius: number
  /** Field of view across the whole circle, degrees. */
  fov: number
}

export const DEFAULT_LENS: Omit<FisheyeLens, 'mount'> = {
  center_x: 0.5,
  center_y: 0.5,
  radius: 0.5,
  fov: 180,
}

/**
 * How a fisheye camera is shown. 'fisheye' is the raw circle (no GPU work at
 * all); the rest are the vendor client's usual layouts.
 */
export type DewarpMode = 'fisheye' | 'panorama' | 'dual' | 'ptz' | 'quad'

/** Modes that make sense for a mount, in menu order. A wall unit already
 *  faces the scene, so its single panorama covers what 'dual' would. */
export function dewarpModesFor(mount: FisheyeMount): DewarpMode[] {
  return mount === 'wall'
    ? ['fisheye', 'panorama', 'ptz', 'quad']
    : ['fisheye', 'panorama', 'dual', 'ptz', 'quad']
}

/** A virtual pinhole camera: where it points and its horizontal FOV. */
export interface PtzView {
  yaw: number
  pitch: number
  fov: number
}

/** Panorama strip: yaw rotates it; pitch (null = the mount's default band)
 *  tilts the band of elevations it shows. Shared by 'panorama' and 'dual'. */
export interface PanoView {
  yaw: number
  pitch: number | null
}

export interface DewarpViews {
  ptz: PtzView
  pano: PanoView
  quad: [PtzView, PtzView, PtzView, PtzView]
}

export const PTZ_MIN_FOV = 10
export const PTZ_MAX_FOV = 110

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

/** Wrap to (-180, 180] so a yaw dragged round and round stays small. */
export function wrapYaw(deg: number): number {
  const w = ((deg % 360) + 360) % 360
  return w > 180 ? w - 360 : w
}

export function defaultViews(lens: FisheyeLens): DewarpViews {
  const tilt = lens.mount === 'ceiling' ? -35 : lens.mount === 'desk' ? 35 : 0
  const quad: DewarpViews['quad'] =
    lens.mount === 'wall'
      ? [
          { yaw: -45, pitch: 20, fov: 70 },
          { yaw: 45, pitch: 20, fov: 70 },
          { yaw: -45, pitch: -25, fov: 70 },
          { yaw: 45, pitch: -25, fov: 70 },
        ]
      : [
          { yaw: 0, pitch: tilt, fov: 70 },
          { yaw: 90, pitch: tilt, fov: 70 },
          { yaw: -90, pitch: tilt, fov: 70 },
          { yaw: 180, pitch: tilt, fov: 70 },
        ]
  return { ptz: { yaw: 0, pitch: tilt, fov: 80 }, pano: { yaw: 0, pitch: null }, quad }
}

/** The mode a camera opens in before the operator has picked one: the
 *  layout that fills a 16:9 tile with the least distortion. Two stacked 180°
 *  strips are ~16:9 for a ceiling/desk unit; a wall unit's single 180°
 *  panorama already is. */
export function defaultMode(lens: FisheyeLens): DewarpMode {
  return lens.mount === 'wall' ? 'panorama' : 'dual'
}

// ── limits ────────────────────────────────────────────────────────────────

/** Half the lens FOV: the angle off-axis that lands on the circle's rim. */
const thetaMax = (lens: FisheyeLens) => lens.fov / 2

/** Pitch range a PTZ view may aim at. A ceiling unit sees from straight
 *  down up to its rim (the horizon, for a 180° lens); a desk unit is the
 *  mirror image; a wall unit sees the hemisphere in front of it. */
function ptzPitchRange(lens: FisheyeLens): [number, number] {
  const t = thetaMax(lens)
  if (lens.mount === 'ceiling') return [-90, t - 90]
  if (lens.mount === 'desk') return [90 - t, 90]
  const edge = Math.min(t, 89)
  return [-edge, edge]
}

/** Elevations a panorama band may cover. Stops 10° short of the lens axis,
 *  where a whole row of the strip comes from a few pixels and smears. */
function bandRange(lens: FisheyeLens): [number, number] {
  const t = thetaMax(lens)
  if (lens.mount === 'ceiling') return [-80, t - 90]
  if (lens.mount === 'desk') return [90 - t, 80]
  const edge = Math.min(t, 80)
  return [-edge, edge]
}

export function clampPtz(lens: FisheyeLens, v: PtzView): PtzView {
  const [lo, hi] = ptzPitchRange(lens)
  const t = thetaMax(lens)
  return {
    // A wall unit has a back — there is nothing to turn round to.
    yaw: lens.mount === 'wall' ? clamp(v.yaw, -t, t) : wrapYaw(v.yaw),
    pitch: clamp(v.pitch, lo, hi),
    fov: clamp(v.fov, PTZ_MIN_FOV, PTZ_MAX_FOV),
  }
}

// ── layout ────────────────────────────────────────────────────────────────

/** Which stored view a region reads and writes. */
export type RegionTarget = { key: 'ptz' } | { key: 'pano' } | { key: 'quad'; index: number }

/**
 * One rectangle of the canvas and the projection drawn into it. Rect in CSS
 * pixels, top-left origin. Angles in degrees.
 *
 * perspective — a pinhole camera: `hspan` is its horizontal FOV.
 * equirect    — a panorama strip: `hspan` x `vspan` degrees of yaw x pitch.
 */
export interface Region {
  x: number
  y: number
  w: number
  h: number
  kind: 'perspective' | 'equirect'
  yaw: number
  pitch: number
  hspan: number
  vspan: number
  target: RegionTarget
}

/** Hairline between the panes of the split layouts. */
const GAP = 2

function perspective(
  x: number, y: number, w: number, h: number, v: PtzView, target: RegionTarget,
): Region {
  const half = (v.fov * Math.PI) / 360
  const vspan = (2 * Math.atan(Math.tan(half) * (h / Math.max(w, 1))) * 180) / Math.PI
  return { x, y, w, h, kind: 'perspective', yaw: v.yaw, pitch: v.pitch, hspan: v.fov, vspan, target }
}

/**
 * Equirect strips covering `hspan` of yaw each, stacked, sized so a degree
 * is as tall as it is wide. When the box is taller than the usable band,
 * the strips are letterboxed rather than stretched: a stretched panorama
 * makes every person look twice their height.
 */
function strips(
  lens: FisheyeLens, pano: PanoView, w: number, h: number, hspan: number, yaws: number[],
): Region[] {
  const [lo, hi] = bandRange(lens)
  const n = yaws.length
  const gaps = GAP * (n - 1)
  const fit = (h - gaps) / n
  const stripH = Math.min(fit, (w * (hi - lo)) / hspan)
  const vspan = (hspan * stripH) / Math.max(w, 1)
  // Band centre: the stored tilt if the operator has dragged one, else
  // hugging the horizon (ceiling/desk) or level (wall), then kept inside
  // the range the lens can actually see.
  const fallback =
    lens.mount === 'ceiling' ? hi - vspan / 2 : lens.mount === 'desk' ? lo + vspan / 2 : 0
  const pitch =
    vspan >= hi - lo
      ? (lo + hi) / 2
      : clamp(pano.pitch ?? fallback, lo + vspan / 2, hi - vspan / 2)
  const top = (h - (stripH * n + gaps)) / 2
  return yaws.map((yaw, i) => ({
    x: 0,
    y: top + i * (stripH + GAP),
    w,
    h: stripH,
    kind: 'equirect' as const,
    yaw,
    pitch,
    hspan,
    vspan,
    target: { key: 'pano' as const },
  }))
}

/** The regions a mode draws into a `w` x `h` (CSS px) canvas. */
export function layoutRegions(
  mode: DewarpMode, lens: FisheyeLens, views: DewarpViews, w: number, h: number,
): Region[] {
  if (w <= 0 || h <= 0) return []
  switch (mode) {
    case 'ptz':
      return [perspective(0, 0, w, h, views.ptz, { key: 'ptz' })]
    case 'quad': {
      const qw = (w - GAP) / 2
      const qh = (h - GAP) / 2
      return views.quad.map((v, i) =>
        perspective((i % 2) * (qw + GAP), Math.floor(i / 2) * (qh + GAP), qw, qh, v, { key: 'quad', index: i }),
      )
    }
    case 'panorama':
      return lens.mount === 'wall'
        ? strips(lens, views.pano, w, h, Math.min(lens.fov, 360), [views.pano.yaw])
        : strips(lens, views.pano, w, h, 360, [views.pano.yaw])
    case 'dual':
      return strips(lens, views.pano, w, h, 180, [views.pano.yaw, wrapYaw(views.pano.yaw + 180)])
    default:
      return []
  }
}

// ── interaction ───────────────────────────────────────────────────────────

/**
 * Apply a drag of (dx, dy) CSS px to the view under `region`. `views` and
 * `region` are both as captured when the drag began. Grab-the-scene
 * semantics, as in the vendor clients and every map: the point under the
 * cursor follows the cursor.
 */
export function dragViews(
  lens: FisheyeLens, views: DewarpViews, region: Region, dx: number, dy: number,
): DewarpViews {
  const dYaw = (-dx * region.hspan) / Math.max(region.w, 1)
  const dPitch = (dy * region.vspan) / Math.max(region.h, 1)
  const t = region.target
  if (t.key === 'pano') {
    // Offset the STORED yaw rather than the region's: the lower dual strip
    // sits 180° round from it. A wall panorama already spans everything the
    // lens sees side to side, so it only tilts.
    const yaw = lens.mount === 'wall' ? 0 : wrapYaw(views.pano.yaw + dYaw)
    // region.pitch is the band as drawn, which may be the mount's default
    // rather than anything stored.
    const [lo, hi] = bandRange(lens)
    const pitch =
      region.vspan >= hi - lo
        ? null
        : clamp(region.pitch + dPitch, lo + region.vspan / 2, hi - region.vspan / 2)
    return { ...views, pano: { yaw, pitch } }
  }
  const moved = clampPtz(lens, { yaw: region.yaw + dYaw, pitch: region.pitch + dPitch, fov: region.hspan })
  if (t.key === 'ptz') return { ...views, ptz: moved }
  const quad = [...views.quad] as DewarpViews['quad']
  quad[t.index] = moved
  return { ...views, quad }
}

/** Zoom the PTZ view under `target` by `factor` (>1 zooms out). */
export function zoomViews(
  lens: FisheyeLens, views: DewarpViews, target: RegionTarget, factor: number,
): DewarpViews {
  if (target.key === 'ptz') {
    return { ...views, ptz: clampPtz(lens, { ...views.ptz, fov: views.ptz.fov * factor }) }
  }
  if (target.key === 'quad') {
    const quad = [...views.quad] as DewarpViews['quad']
    quad[target.index] = clampPtz(lens, { ...quad[target.index], fov: quad[target.index].fov * factor })
    return { ...views, quad }
  }
  return views
}

// ── GPU constants ─────────────────────────────────────────────────────────

/**
 * World -> lens rotation for a mount, column-major for uniformMatrix3fv.
 *
 * World is a left-handed frame (x right, y up, z forward) and the lens frame
 * a right-handed one (image x right, image y down, z out of the lens), so
 * every mapping has determinant -1; that is what keeps the picture from
 * coming out mirrored.
 *
 *   wall:    lens = ( x, -y,  z)   looking out, image up = world up
 *   ceiling: lens = ( x, -z, -y)   looking down, image up = world forward
 *   desk:    lens = (-x, -z,  y)   looking up — seen from below, so x flips
 */
export function mountMatrix(mount: FisheyeMount): Float32Array {
  // Rows of the row-major matrix, then transposed into column-major.
  const rows =
    mount === 'wall'
      ? [[1, 0, 0], [0, -1, 0], [0, 0, 1]]
      : mount === 'ceiling'
        ? [[1, 0, 0], [0, 0, -1], [0, -1, 0]]
        : [[-1, 0, 0], [0, 0, -1], [0, 1, 0]]
  return new Float32Array([
    rows[0][0], rows[1][0], rows[2][0],
    rows[0][1], rows[1][1], rows[2][1],
    rows[0][2], rows[1][2], rows[2][2],
  ])
}

// ── persistence ───────────────────────────────────────────────────────────

/** What the browser remembers per camera: the operator's last mode and
 *  where each view was pointing, so a reload or a jump from live to
 *  playback opens on the same picture. */
export interface StoredDewarp {
  /** The mount the views were aimed under. "Up" and "ahead" mean different
      things per mount, so a re-hung (or corrected) camera starts afresh. */
  mount: FisheyeMount
  mode: DewarpMode
  views: DewarpViews
}

const storageKey = (cameraId: number) => `dewarp:${cameraId}`

export function loadDewarp(cameraId: number | null | undefined, lens: FisheyeLens): StoredDewarp {
  const fallback: StoredDewarp = { mount: lens.mount, mode: defaultMode(lens), views: defaultViews(lens) }
  if (cameraId == null) return fallback
  try {
    const raw = localStorage.getItem(storageKey(cameraId))
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as Partial<StoredDewarp>
    if (parsed.mount !== lens.mount) return fallback
    const mode = dewarpModesFor(lens.mount).includes(parsed.mode as DewarpMode)
      ? (parsed.mode as DewarpMode)
      : fallback.mode
    const v = parsed.views
    const ok = (p: unknown): p is PtzView =>
      !!p && typeof p === 'object' &&
      ['yaw', 'pitch', 'fov'].every((k) => Number.isFinite((p as Record<string, unknown>)[k]))
    // Clamped in case the FOV setting has changed since.
    const views: DewarpViews = {
      ptz: ok(v?.ptz) ? clampPtz(lens, v.ptz) : fallback.views.ptz,
      pano: v?.pano && Number.isFinite(v.pano.yaw)
        ? { yaw: wrapYaw(v.pano.yaw), pitch: Number.isFinite(v.pano.pitch) ? v.pano.pitch : null }
        : fallback.views.pano,
      quad: Array.isArray(v?.quad) && v.quad.length === 4 && v.quad.every(ok)
        ? (v.quad.map((q) => clampPtz(lens, q)) as DewarpViews['quad'])
        : fallback.views.quad,
    }
    return { mount: lens.mount, mode, views }
  } catch {
    return fallback
  }
}

export function saveDewarp(cameraId: number | null | undefined, value: StoredDewarp): void {
  if (cameraId == null) return
  try {
    localStorage.setItem(storageKey(cameraId), JSON.stringify(value))
  } catch {
    // private mode / quota — the view just isn't remembered
  }
}
