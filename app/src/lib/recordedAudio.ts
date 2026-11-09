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

// Sound for recorded playback. Recordings play as a video-only remux (the
// cameras' PCM audio would make the browser reject the clip), and the server
// serves the sound beside it as a 16-bit WAV whose first sample is the
// video's t=0 (server/services/hevc_remux_service.py). This plays that WAV in
// step with the <video>:
//
//   fetch (streamed, from the current position) -> 16-bit PCM in memory
//   -> short AudioBuffer blocks scheduled on the shared AudioContext
//   -> [voice-focus model] -> gain (volume) -> speakers
//
// Web Audio rather than a second <audio> element: iOS only lets a media
// element start sound from inside a tap, and every clip change would need a
// new one; the shared AudioContext is unlocked once, in the click that turns
// sound on (primeAudioOutput), and stays unlocked.
//
// It exists only while someone has sound on at 1x, so nothing is fetched (and
// the server reads no audio from disk) otherwise.

import {
  audioContext,
  createVoiceFocusNode,
  holdAudioContext,
  type VoiceFocusLevel,
  type VoiceFocusNode,
} from './voiceFocus'

export interface RecordedAudioSource {
  url: string
  sampleRate: number
  channels: number
}

const WAV_HEADER = 44
/** Each scheduled block. Short enough to resync quickly, long enough that the
    joins (sample-exact, same rate as the context) are few. */
const BLOCK_SEC = 0.2
/** How far ahead of the speakers blocks are queued. */
const LOOKAHEAD_SEC = 0.6
/** Sound further than this from the picture is re-aligned (a jump, not a
    slur): video clocks wander a little, and a stalled frame says nothing. */
const RESYNC_SEC = 0.15
const TICK_MS = 100

export class RecordedAudio {
  private readonly ctx: AudioContext
  private readonly bus: GainNode
  private readonly out: GainNode
  private model: VoiceFocusNode | null = null
  private level: VoiceFocusLevel = 'off'
  private levelToken = 0
  private release: (() => void) | null = null

  // PCM held in memory: mono floats at the source rate, from sample `base`.
  private pcm = new Float32Array(0)
  private base = 0
  private loaded = 0 // samples available from `base`
  private total = Infinity // samples in the whole clip, once known
  private fetchAbort: AbortController | null = null
  private fetching = false
  private failedAt = -Infinity // performance.now() of the last failed download

  // Scheduling state; null = not currently playing.
  private nextWhen: number | null = null
  private nextPos = 0 // media seconds at nextWhen
  private sources = new Set<AudioBufferSourceNode>()
  private timer: number | null = null
  private destroyed = false

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly src: RecordedAudioSource,
  ) {
    this.ctx = audioContext()
    this.bus = this.ctx.createGain()
    this.out = this.ctx.createGain()
    this.bus.connect(this.out)
    this.out.connect(this.ctx.destination)
    this.release = holdAudioContext()
    if (this.ctx.state !== 'running') void this.ctx.resume().catch(() => {})
    for (const ev of ['pause', 'seeking', 'ratechange', 'waiting', 'emptied'] as const) {
      video.addEventListener(ev, this.halt)
    }
    for (const ev of ['playing', 'seeked'] as const) video.addEventListener(ev, this.tick)
    this.timer = window.setInterval(this.tick, TICK_MS)
    this.tick()
  }

  /** Output volume, 0..1. */
  setVolume(v: number): void {
    this.out.gain.setTargetAtTime(v, this.ctx.currentTime, 0.015)
  }

  /** Voice focus on this sound. Off routes it straight through. A model that
      fails to load leaves the sound unfiltered (and resolves false). */
  async setVoiceFocus(level: VoiceFocusLevel): Promise<boolean> {
    if (level === this.level) return true
    this.level = level
    const token = ++this.levelToken
    let node: VoiceFocusNode | null = null
    let ok = true
    if (level !== 'off') {
      try {
        node = await createVoiceFocusNode(level)
      } catch (e) {
        console.warn('[RecordedAudio] voice focus unavailable; playing unfiltered', e)
        ok = false
      }
    }
    if (this.destroyed || token !== this.levelToken) {
      node?.destroy()
      return ok
    }
    this.bus.disconnect()
    if (this.model) {
      this.model.disconnect()
      this.model.destroy()
    }
    this.model = node
    if (node) {
      this.bus.connect(node)
      node.connect(this.out)
    } else {
      this.bus.connect(this.out)
    }
    return ok
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    if (this.timer != null) window.clearInterval(this.timer)
    for (const ev of ['pause', 'seeking', 'ratechange', 'waiting', 'emptied'] as const) {
      this.video.removeEventListener(ev, this.halt)
    }
    for (const ev of ['playing', 'seeked'] as const) this.video.removeEventListener(ev, this.tick)
    this.halt()
    this.fetchAbort?.abort()
    try {
      this.bus.disconnect()
      this.out.disconnect()
      this.model?.disconnect()
    } catch {
      // already disconnected
    }
    this.model?.destroy()
    this.model = null
    this.release?.()
    this.release = null
  }

  // --- loading --------------------------------------------------------------

  /** (Re)start the download at media second `sec`, dropping what's held. */
  private loadFrom(sec: number): void {
    this.fetchAbort?.abort()
    const ctl = new AbortController()
    this.fetchAbort = ctl
    const frame = 2 * this.src.channels
    const start = Math.max(0, Math.floor(sec * this.src.sampleRate))
    this.base = start
    this.loaded = 0
    this.pcm = new Float32Array(this.src.sampleRate * 8)
    this.fetching = true
    void this.download(start, frame, ctl)
      .catch((e) => {
        if (ctl.signal.aborted) return
        this.failedAt = performance.now()
        console.warn('[RecordedAudio] sound download failed', e)
      })
      .finally(() => {
        if (this.fetchAbort === ctl) this.fetching = false
      })
  }

  private async download(start: number, frame: number, ctl: AbortController): Promise<void> {
    const res = await fetch(this.src.url, {
      headers: { Range: `bytes=${WAV_HEADER + start * frame}-` },
      signal: ctl.signal,
      credentials: 'same-origin',
    })
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
    const range = res.headers.get('Content-Range')?.match(/\/(\d+)$/)
    if (range) this.total = Math.floor((Number(range[1]) - WAV_HEADER) / frame)
    const reader = res.body.getReader()
    let carry = new Uint8Array(0)
    for (;;) {
      const { done, value } = await reader.read()
      if (done || ctl.signal.aborted) return
      let bytes = value
      if (carry.length) {
        const joined = new Uint8Array(carry.length + value.length)
        joined.set(carry)
        joined.set(value, carry.length)
        bytes = joined
      }
      const whole = bytes.length - (bytes.length % frame)
      carry = bytes.slice(whole)
      this.append(new DataView(bytes.buffer, bytes.byteOffset, whole), whole / frame)
    }
  }

  private append(view: DataView, frames: number): void {
    const need = this.loaded + frames
    if (need > this.pcm.length) {
      const grown = new Float32Array(Math.max(need, this.pcm.length * 2))
      grown.set(this.pcm.subarray(0, this.loaded))
      this.pcm = grown
    }
    const ch = this.src.channels
    for (let i = 0; i < frames; i++) {
      let v = 0
      for (let c = 0; c < ch; c++) v += view.getInt16((i * ch + c) * 2, true)
      this.pcm[this.loaded + i] = v / (ch * 32768)
    }
    this.loaded = need
  }

  // --- playing --------------------------------------------------------------

  /** Stop everything queued; the next tick starts again from the picture. */
  private halt = (): void => {
    for (const s of this.sources) {
      try {
        s.stop()
      } catch {
        // not started yet / already ended
      }
      s.disconnect()
    }
    this.sources.clear()
    this.nextWhen = null
  }

  private tick = (): void => {
    if (this.destroyed) return
    const v = this.video
    if (v.paused || v.seeking || v.readyState < 3 || v.playbackRate !== 1) {
      if (this.nextWhen != null) this.halt()
      return
    }
    if (this.ctx.state !== 'running') return
    const now = this.ctx.currentTime
    const rate = this.src.sampleRate

    if (this.nextWhen != null) {
      // Where the picture will be when the next queued block starts.
      const want = v.currentTime + (this.nextWhen - now)
      if (this.nextWhen < now || Math.abs(want - this.nextPos) > RESYNC_SEC) this.halt()
    }
    if (this.nextWhen == null) {
      this.nextWhen = now + 0.05
      this.nextPos = v.currentTime + 0.05
    }
    if (this.nextPos * rate >= this.total) return // past the end of the sound

    // Is the sound for that moment held, or at least on its way?
    const first = Math.floor(this.nextPos * rate)
    const heldEnd = this.base + this.loaded
    if (first < this.base || first > heldEnd + rate * 2 || (!this.fetching && first >= heldEnd)) {
      if (performance.now() - this.failedAt < 3000) return // don't hammer a failing server
      this.loadFrom(this.nextPos)
      this.nextWhen = null
      return
    }

    while (this.nextWhen < now + LOOKAHEAD_SEC) {
      const block = this.block(this.nextPos, BLOCK_SEC)
      if (!block) break // not downloaded yet; the drift check realigns later
      const node = this.ctx.createBufferSource()
      node.buffer = block
      node.connect(this.bus)
      node.onended = () => {
        this.sources.delete(node)
        node.disconnect()
      }
      node.start(this.nextWhen)
      this.sources.add(node)
      this.nextWhen += BLOCK_SEC
      this.nextPos += BLOCK_SEC
    }
  }

  /** `dur` seconds of sound from media second `pos`, resampled to the
      context's rate (linear; the source is 8 kHz speech), or null if those
      samples haven't arrived. Positions are global, so consecutive blocks
      join without a seam. */
  private block(pos: number, dur: number): AudioBuffer | null {
    const srcRate = this.src.sampleRate
    const outRate = this.ctx.sampleRate
    const n = Math.round(dur * outRate)
    const step = srcRate / outRate
    const startSrc = pos * srcRate
    const lastNeeded = Math.ceil(startSrc + n * step) + 1
    if (Math.floor(startSrc) < this.base) return null
    if (lastNeeded >= this.base + this.loaded && lastNeeded < this.total) return null
    const buf = this.ctx.createBuffer(1, n, outRate)
    const outData = buf.getChannelData(0)
    const held = this.base + this.loaded
    for (let i = 0; i < n; i++) {
      const x = startSrc + i * step
      const k = Math.floor(x)
      if (k + 1 >= held) break // end of the sound: the rest stays silent
      const f = x - k
      const a = this.pcm[k - this.base]
      outData[i] = a + (this.pcm[k + 1 - this.base] - a) * f
    }
    return buf
  }
}
