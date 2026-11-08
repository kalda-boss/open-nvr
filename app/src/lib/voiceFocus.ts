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

// Voice focus: background-noise suppression on a live camera's audio, done
// entirely in THIS browser. The server, MediaMTX and the recordings never see
// it — a recording keeps every sound the camera heard (a car door, glass, a
// dog), because those are often the point of a security clip. Only what this
// viewer hears is filtered, and only while they have it switched on.
//
// The model is RNNoise (xiph, BSD) compiled to WebAssembly, run in an
// AudioWorklet by @sapphi-red/web-noise-suppressor (MIT). It works on 48 kHz
// audio in 10 ms frames; the cameras send 8 kHz G.711, which WebRTC decodes
// and the AudioContext resamples, so the model just sees an empty top band.
//
// Graph, one per playing tile, all on one shared AudioContext:
//
//   remote WebRTC audio track -> RNNoise worklet -> gain (volume) -> speakers
//
// While it runs, the <video> element is held muted so the raw audio isn't
// heard underneath the filtered copy; VideoPlayer owns that half.

import rnnoiseWorkletUrl from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url'
import rnnoiseWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url'
import rnnoiseSimdWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url'

const PREF_KEY = 'opennvr.voiceFocus'
/** RNNoise is built for 48 kHz and does not resample on its own. */
const SAMPLE_RATE = 48000

/** The browser can run the worklet at all (AudioWorklet needs a secure context). */
export function voiceFocusSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof AudioContext !== 'undefined' &&
    typeof AudioWorkletNode !== 'undefined' &&
    typeof WebAssembly !== 'undefined' &&
    window.isSecureContext
  )
}

/** This viewer's on/off choice. Off unless they turned it on. */
export function readVoiceFocusPref(): boolean {
  try {
    return localStorage.getItem(PREF_KEY) === '1'
  } catch {
    return false
  }
}

export function writeVoiceFocusPref(on: boolean): void {
  try {
    localStorage.setItem(PREF_KEY, on ? '1' : '0')
  } catch {
    // private mode / blocked storage: the toggle still works for this page
  }
}

// --- shared engine --------------------------------------------------------

type RnnoiseNodeCtor = typeof import('@sapphi-red/web-noise-suppressor').RnnoiseWorkletNode
type RnnoiseNode = InstanceType<RnnoiseNodeCtor>

interface Engine {
  ctx: AudioContext
  wasm: ArrayBuffer
  Node: RnnoiseNodeCtor
}

let sharedCtx: AudioContext | null = null
let enginePromise: Promise<Engine> | null = null
let activeChains = 0

function context(): AudioContext {
  if (!sharedCtx || sharedCtx.state === 'closed') {
    sharedCtx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' })
  }
  return sharedCtx
}

/** Web Audio on iOS follows the ringer switch unless the session says it is
    playback; the <video> it replaces ignores the switch, so match that. */
function preferPlaybackSession(): void {
  const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession
  if (session) {
    try {
      session.type = 'playback'
    } catch {
      // older Safari: nothing to set
    }
  }
}

/**
 * Create and resume the AudioContext. Call it synchronously inside the click
 * that turns sound on (unmute, or the voice-focus toggle): iOS only lets a
 * context start from within a user gesture, and the chain itself is built
 * later, from an effect, where that permission is gone.
 */
export function primeVoiceFocusAudio(): void {
  if (!voiceFocusSupported()) return
  try {
    preferPlaybackSession()
    const ctx = context()
    if (ctx.state !== 'running') void ctx.resume().catch(() => {})
  } catch {
    // start() reports the failure
  }
}

function engine(): Promise<Engine> {
  if (!enginePromise) {
    enginePromise = (async () => {
      // Imported lazily: the package's node classes extend AudioWorkletNode at
      // module load, which would throw on a browser without it.
      const mod = await import('@sapphi-red/web-noise-suppressor')
      const ctx = context()
      const [wasm] = await Promise.all([
        mod.loadRnnoise({ url: rnnoiseWasmUrl, simdUrl: rnnoiseSimdWasmUrl }),
        ctx.audioWorklet.addModule(rnnoiseWorkletUrl),
      ])
      return { ctx, wasm, Node: mod.RnnoiseWorkletNode }
    })()
    // A failed load (offline, blocked) may be retried by the next chain.
    enginePromise.catch(() => {
      enginePromise = null
    })
  }
  return enginePromise
}

// --- one tile's chain -------------------------------------------------------

export class VoiceFocusChain {
  private source: MediaStreamAudioSourceNode | null = null
  private node: RnnoiseNode | null = null
  private gain: GainNode | null = null
  private sink: HTMLAudioElement | null = null
  private ctx: AudioContext | null = null
  private level = 1
  private counted = false
  private stopped = false

  constructor(private readonly track: MediaStreamTrack) {}

  /** Build the graph. Rejects if the model can't load; the caller then puts
      the raw audio back on the <video>. */
  async start(): Promise<void> {
    const { ctx, wasm, Node } = await engine()
    if (this.stopped) return
    this.ctx = ctx
    activeChains += 1
    this.counted = true

    const stream = new MediaStream([this.track])
    // Chrome only feeds a REMOTE WebRTC track into Web Audio while some media
    // element is playing it. The <video> is muted while we run; a muted,
    // detached <audio> is the documented workaround and costs nothing.
    const sink = new Audio()
    sink.muted = true
    sink.srcObject = stream
    void sink.play().catch(() => {})
    this.sink = sink

    this.source = ctx.createMediaStreamSource(stream)
    this.node = new Node(ctx, { maxChannels: 1, wasmBinary: wasm })
    this.gain = ctx.createGain()
    this.gain.gain.value = this.level
    this.source.connect(this.node)
    this.node.connect(this.gain)
    this.gain.connect(ctx.destination)

    if (ctx.state !== 'running') {
      await ctx.resume().catch(() => {})
      // Still suspended: there was no user gesture yet (sound on at page
      // load). Start on the next tap or click anywhere.
      if ((ctx.state as AudioContextState) !== 'running') {
        const kick = () => void ctx.resume().catch(() => {})
        document.addEventListener('pointerdown', kick, { once: true, capture: true })
        document.addEventListener('keydown', kick, { once: true, capture: true })
      }
    }
  }

  /** Output volume, 0..1 — the player's volume slider. */
  setLevel(level: number): void {
    this.level = level
    if (this.gain && this.ctx) {
      this.gain.gain.setTargetAtTime(level, this.ctx.currentTime, 0.015)
    }
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    try {
      this.source?.disconnect()
      this.node?.disconnect()
      this.gain?.disconnect()
    } catch {
      // already disconnected
    }
    this.node?.destroy()
    if (this.sink) {
      this.sink.pause()
      this.sink.srcObject = null
    }
    this.source = this.node = this.gain = this.sink = null
    if (this.counted) {
      activeChains -= 1
      this.counted = false
      // Nothing playing through it: let the audio thread sleep (battery).
      if (activeChains === 0 && this.ctx?.state === 'running') {
        void this.ctx.suspend().catch(() => {})
      }
    }
  }
}
