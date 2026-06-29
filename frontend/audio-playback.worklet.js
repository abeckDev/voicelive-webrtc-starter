/**
 * frontend/audio-playback.worklet.js
 * ------------------------------------
 * AudioWorkletProcessor that receives base64 PCM audio from the main thread
 * (sent by Azure Voice Live TTS) and plays it through the speakers.
 *
 * Loading this worklet in the main thread:
 *   await audioContext.audioWorklet.addModule('audio-playback.worklet.js');
 *   const node = new AudioWorkletNode(audioContext, 'audio-playback');
 *   node.connect(audioContext.destination);
 *   // To play a chunk: node.port.postMessage(base64PcmString);
 *
 * Design:
 *   The processor maintains a ring buffer (circular FIFO) of Float32 samples.
 *   When the main thread posts a base64 chunk, it is decoded and pushed into
 *   the ring. The process() callback reads from the ring to fill the output;
 *   if the ring is empty it outputs silence (no glitching).
 *
 * Ring buffer size:
 *   4096 * 4 = 16 384 samples ≈ 682 ms at 24 kHz.
 *   This is intentionally generous to absorb network jitter without artefacts.
 */

const RING_SIZE = 4096 * 4; // Float32 samples

class AudioPlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    // Ring buffer storage and read/write pointers.
    this._ring = new Float32Array(RING_SIZE);
    this._writePos = 0;
    this._readPos = 0;
    this._available = 0; // samples currently in the buffer

    // Listen for base64 PCM chunks posted from the main thread.
    this.port.onmessage = (event) => {
      this._enqueue(event.data);
    };
  }

  /**
   * Decode a base64 PCM chunk and push samples into the ring buffer.
   * Called from the message handler (outside the audio render thread).
   */
  _enqueue(base64) {
    // Decode base64 → binary string → Uint8Array → Int16Array → Float32
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }

    // Each 16-bit sample is 2 bytes, little-endian.
    const pcm = new Int16Array(bytes.buffer);

    for (let i = 0; i < pcm.length; i++) {
      if (this._available < RING_SIZE) {
        // Normalise Int16 [-32768, 32767] → Float32 [-1, 1]
        this._ring[this._writePos] = pcm[i] / 32768.0;
        this._writePos = (this._writePos + 1) % RING_SIZE;
        this._available++;
      }
      // If the ring is full, silently drop — the alternative (stalling) sounds worse.
    }
  }

  /**
   * process() is called every render quantum.
   * Fill the output buffer from the ring; output silence for any starved samples.
   *
   * @param {Float32Array[][]} _inputs  — not used (playback only)
   * @param {Float32Array[][]} outputs  — outputs[0][0] is the mono playback channel
   */
  process(_inputs, outputs) {
    const output = outputs[0]?.[0];
    if (!output) return true;

    for (let i = 0; i < output.length; i++) {
      if (this._available > 0) {
        output[i] = this._ring[this._readPos];
        this._readPos = (this._readPos + 1) % RING_SIZE;
        this._available--;
      } else {
        output[i] = 0; // silence — ring is empty
      }
    }

    return true; // keep processor alive
  }
}

registerProcessor('audio-playback', AudioPlaybackProcessor);
