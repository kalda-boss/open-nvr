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

// Talk-back microphone tap (see app/src/lib/talkback.ts). Runs on the audio
// thread: averages the mic's native rate down to 8 kHz (the box average is
// the anti-alias filter; good enough for speech into G.711) and posts 20 ms
// frames of 16-bit PCM, 160 samples each, to the main thread.

const OUT_RATE = 8000
const FRAME = 160

class TalkbackTap extends AudioWorkletProcessor {
  constructor() {
    super()
    this.step = sampleRate / OUT_RATE
    this.acc = 0
    this.count = 0
    this.pos = 0
    this.frame = new Int16Array(FRAME)
    this.n = 0
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (!ch) return true
    for (let i = 0; i < ch.length; i++) {
      this.acc += ch[i]
      this.count++
      this.pos++
      if (this.pos >= this.step) {
        this.pos -= this.step
        const v = Math.max(-1, Math.min(1, this.acc / this.count))
        this.frame[this.n++] = v < 0 ? v * 0x8000 : v * 0x7fff
        this.acc = 0
        this.count = 0
        if (this.n === FRAME) {
          this.port.postMessage(this.frame.buffer, [this.frame.buffer])
          this.frame = new Int16Array(FRAME)
          this.n = 0
        }
      }
    }
    return true
  }
}

registerProcessor('talkback-tap', TalkbackTap)
