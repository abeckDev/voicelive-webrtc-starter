/**
 * frontend/audio-capture.worklet.js
 * -----------------------------------
 * AudioWorkletProcessor that captures microphone audio and sends it to the
 * main thread as base64-encoded 16-bit PCM chunks.
 *
 * Loading this worklet in the main thread:
 *   await audioContext.audioWorklet.addModule('audio-capture.worklet.js');
 *   const node = new AudioWorkletNode(audioContext, 'audio-capture');
 *   micSource.connect(node);
 *   node.port.onmessage = (e) => sendOverWebSocket(e.data); // base64 PCM
 *
 * Why 24 kHz?
 *   Azure Voice Live expects 16-bit PCM at 24 000 Hz (mono).
 *   The AudioContext is created at 24 kHz in app.js, so no resampling is needed here.
 *
 * Why 480 samples per chunk?
 *   480 samples / 24 000 Hz = 20 ms — a common WebRTC frame size that balances
 *   latency vs. network overhead.
 */

const CHUNK_SIZE = 480; // samples per chunk (20 ms at 24 kHz)

class AudioCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // Internal buffer to accumulate samples until we have a full chunk.
    this._buffer = new Float32Array(CHUNK_SIZE);
    this._bufferOffset = 0;
  }

  /**
   * process() is called by the Web Audio engine for every render quantum
   * (typically 128 samples). We accumulate samples until we have CHUNK_SIZE,
   * then convert and post them to the main thread.
   *
   * @param {Float32Array[][]} inputs  — inputs[0][0] is the mono mic channel
   */
  process(inputs) {
    const input = inputs[0]?.[0]; // mono channel
    if (!input) return true;      // keep processor alive even if no input

    let inputOffset = 0;

    while (inputOffset < input.length) {
      // Copy as many samples as will fit in the current buffer slot.
      const remaining = CHUNK_SIZE - this._bufferOffset;
      const toCopy = Math.min(remaining, input.length - inputOffset);

      this._buffer.set(input.subarray(inputOffset, inputOffset + toCopy), this._bufferOffset);
      this._bufferOffset += toCopy;
      inputOffset += toCopy;

      if (this._bufferOffset === CHUNK_SIZE) {
        // We have a full 20 ms chunk — convert and send it.
        this._sendChunk();
        this._bufferOffset = 0;
      }
    }

    return true; // returning true keeps the processor alive
  }

  /**
   * Convert Float32 samples [-1, 1] to 16-bit signed PCM and post as base64.
   */
  _sendChunk() {
    const pcm = new Int16Array(CHUNK_SIZE);

    for (let i = 0; i < CHUNK_SIZE; i++) {
      // Clamp to [-1, 1] then scale to Int16 range [-32768, 32767]
      const clamped = Math.max(-1, Math.min(1, this._buffer[i]));
      pcm[i] = clamped < 0 ? clamped * 32768 : clamped * 32767;
    }

    // Convert the raw bytes to base64 for transport over WebSocket.
    // Azure Voice Live expects raw PCM (no WAV header).
    const bytes = new Uint8Array(pcm.buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const base64 = btoa(binary);

    // Post to the AudioWorkletNode's .port in the main thread.
    this.port.postMessage(base64);
  }
}

registerProcessor('audio-capture', AudioCaptureProcessor);
