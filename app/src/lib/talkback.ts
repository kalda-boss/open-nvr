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

// Push-to-talk to a camera's speaker (server/routers/talkback.py).
//
// The mic is captured with the browser's echo cancellation and noise
// suppression on, downsampled to 8 kHz 16-bit PCM by an AudioWorklet
// (public/talkback-worklet.js) and sent as binary WebSocket frames. The
// server encodes G.711 and relays it over the camera's ONVIF backchannel.

import { api } from './api'
import { apiService } from './apiService'

export interface TalkCapability {
  supported: boolean
  /** Why not, when unsupported: no_stream | no_speaker | no_backchannel | unreachable */
  reason: string | null
  codec: string | null
  /** The caller holds talk.speak. */
  allowed: boolean
  in_use_by: string | null
}

export async function getTalkCapability(cameraId: number): Promise<TalkCapability> {
  const res = await api.get(`/api/v1/cameras/${cameraId}/talk`)
  return res.data
}

export type TalkState = 'idle' | 'connecting' | 'live' | 'error'

/** One press of the talk button: start() on press, stop() on release. */
export class TalkSession {
  private ws: WebSocket | null = null
  private ctx: AudioContext | null = null
  private stream: MediaStream | null = null
  private stopped = false

  constructor(
    private cameraId: number,
    private onState: (state: TalkState, error?: string) => void,
  ) {}

  async start(): Promise<void> {
    this.onState('connecting')
    try {
      // The mic first: if the browser asks for permission, nothing else has
      // been opened yet, and a refusal leaves no socket behind.
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
      // Released while the browser was still asking: drop the mic again.
      if (this.stopped) return this.release()
      const res = await apiService.createEventsWsTicket()
      if (this.stopped) return this.release()
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
      const ws = new WebSocket(
        `${proto}://${window.location.host}/api/v1/cameras/${this.cameraId}/talk/ws` +
        `?ticket=${encodeURIComponent(res.data.ticket)}`,
      )
      ws.binaryType = 'arraybuffer'
      this.ws = ws
      ws.onmessage = (msg) => {
        if (typeof msg.data !== 'string') return
        let frame: { type?: string; reason?: string }
        try { frame = JSON.parse(msg.data) } catch { return }
        if (frame.type === 'ready') void this.startAudio()
        else if (frame.type === 'error') this.fail(frame.reason || 'error')
      }
      ws.onclose = (ev) => {
        if (!this.stopped) this.fail(ev.reason || 'closed')
      }
    } catch (e) {
      const name = (e as { name?: string })?.name
      this.fail(name === 'NotAllowedError' ? 'mic_denied' : 'error')
    }
  }

  private async startAudio(): Promise<void> {
    if (this.stopped || !this.stream || !this.ws) return
    const ctx = new AudioContext()
    this.ctx = ctx
    await ctx.audioWorklet.addModule(`${import.meta.env.BASE_URL}talkback-worklet.js`)
    if (this.stopped) return
    const tap = new AudioWorkletNode(ctx, 'talkback-tap')
    tap.port.onmessage = (ev) => {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(ev.data as ArrayBuffer)
    }
    ctx.createMediaStreamSource(this.stream).connect(tap)
    this.onState('live')
  }

  private fail(reason: string): void {
    if (this.stopped) return
    this.release()
    this.onState('error', reason)
  }

  private release(): void {
    this.stopped = true
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
    void this.ctx?.close()
    this.ctx = null
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) this.ws.close()
    this.ws = null
  }

  stop(): void {
    if (this.stopped) return
    this.release()
    this.onState('idle')
  }
}
