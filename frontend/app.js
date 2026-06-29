/**
 * frontend/app.js
 * ----------------
 * Main JavaScript for the voicelive-webrtc-starter demo.
 *
 * This file manages:
 *   1. Fetching /config and pre-filling the settings panel.
 *   2. Starting/stopping a voice session (mic capture + WebSocket).
 *   3. Routing incoming WebSocket messages to the UI.
 *   4. Exporting the protocol to JSON.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * WHY WEBSOCKET INSTEAD OF WEBRTC DATACANNEL (and how to change it)
 * ──────────────────────────────────────────────────────────────────────────
 * This starter intentionally uses a plain WebSocket for the audio channel
 * because it is dramatically simpler to explain and debug. Here is exactly
 * what would change to use a WebRTC DataChannel instead:
 *
 * CURRENT (WebSocket):
 *   Browser                          Server
 *   ───────────────────────────────────────────────────
 *   new WebSocket(wsUrl)         ←→  /ws/{clientId}
 *   ws.send(JSON)                     receive_json()
 *   ws.onmessage                      ws.send_json()
 *
 * WEBRTC DATACHANNEL REPLACEMENT:
 *   1. Add a signaling endpoint on the server (e.g. POST /rtc/offer) that
 *      accepts an SDP offer, creates an RTCPeerConnection, and returns an SDP answer.
 *
 *   2. In the browser:
 *        const pc = new RTCPeerConnection({ iceServers: [] });
 *        const dc = pc.createDataChannel('audio');
 *        const offer = await pc.createOffer();
 *        await pc.setLocalDescription(offer);
 *        const res = await fetch('/rtc/offer', {
 *          method: 'POST',
 *          body: JSON.stringify({ sdp: offer.sdp, type: offer.type }),
 *        });
 *        const answer = await res.json();
 *        await pc.setRemoteDescription(answer);
 *
 *   3. Replace all `ws.send(JSON.stringify({type:'audio', data: b64}))` calls
 *      with `dc.send(b64)` (or a binary ArrayBuffer for even less overhead).
 *
 *   4. Replace `ws.onmessage` with `dc.onmessage` for incoming audio/fields.
 *
 * WHY WEBRTC IS BETTER IN PRODUCTION:
 *   - Lower latency: DTLS/SRTP is faster than TCP+TLS for real-time audio.
 *   - NAT traversal: built-in ICE/STUN/TURN for peer-to-peer paths.
 *   - Congestion control: RTCP feedback adapts bitrate automatically.
 *
 * WHY WEBSOCKET IS FINE FOR LEARNING:
 *   - Zero setup: no ICE servers, no SDP negotiation, no DTLS handshake.
 *   - Bidirectional JSON: easy to inspect in DevTools Network tab.
 *   - Works on all browsers, proxies, and corporate firewalls.
 * ──────────────────────────────────────────────────────────────────────────
 */

// ── DOM references ────────────────────────────────────────────────────────
const btnStart     = document.getElementById('btn-start');
const btnStop      = document.getElementById('btn-stop');
const btnExport    = document.getElementById('btn-export');
const statusDot    = document.getElementById('status-dot');
const statusText   = document.getElementById('status-text');
const transcriptEl = document.getElementById('transcript');

// Settings inputs
const cfgEndpoint = document.getElementById('cfg-endpoint');
const cfgApiKey   = document.getElementById('cfg-api-key');
const cfgModel    = document.getElementById('cfg-model');
const cfgVoice    = document.getElementById('cfg-voice');

// Protocol form fields (keyed by the field name from agent.py)
const FIELD_IDS = [
  'researcherName',
  'experimentTitle',
  'experimentDate',
  'procedureSteps',
  'observations',
  'result',
];

// ── Session state ─────────────────────────────────────────────────────────
let ws            = null;  // WebSocket connection
let audioContext  = null;  // AudioContext (24 kHz)
let captureNode   = null;  // AudioWorkletNode for mic capture
let playbackNode  = null;  // AudioWorkletNode for TTS playback
let micStream     = null;  // MediaStream from getUserMedia

// ── Initialise on page load ───────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await loadConfig();
  btnStart.addEventListener('click', startSession);
  btnStop.addEventListener('click', stopSession);
  btnExport.addEventListener('click', exportProtocol);
});

/**
 * Fetch /config from the backend and pre-fill the settings panel.
 * This means the user only needs to override values that differ from the server defaults.
 */
async function loadConfig() {
  try {
    const res = await fetch('/config');
    if (!res.ok) return;
    const cfg = await res.json();
    if (cfg.endpoint) cfgEndpoint.value = cfg.endpoint;
    if (cfg.model)    cfgModel.value    = cfg.model;
    if (cfg.voice)    cfgVoice.value    = cfg.voice;
  } catch (err) {
    // /config is optional — ignore errors in standalone HTML mode
    console.warn('Could not fetch /config:', err);
  }
}

// ── Session management ────────────────────────────────────────────────────

/**
 * Start a voice session:
 *   1. Capture microphone audio via getUserMedia.
 *   2. Set up AudioWorklets for capture and playback.
 *   3. Open a WebSocket to the backend.
 *   4. Send a "start" message with the current settings.
 */
async function startSession() {
  setStatus('Connecting…', '');

  try {
    // Step 1 — Request microphone access.
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });

    // Step 2 — Create AudioContext at 24 kHz to match Azure Voice Live's expected sample rate.
    audioContext = new AudioContext({ sampleRate: 24000 });

    // Step 3 — Load AudioWorklet modules.
    await audioContext.audioWorklet.addModule('audio-capture.worklet.js');
    await audioContext.audioWorklet.addModule('audio-playback.worklet.js');

    // Step 4 — Set up capture worklet: mic → AudioWorkletNode → postMessage(base64PCM)
    captureNode = new AudioWorkletNode(audioContext, 'audio-capture');
    const micSource = audioContext.createMediaStreamSource(micStream);
    micSource.connect(captureNode);
    // The capture worklet posts base64 PCM strings back to this handler.
    captureNode.port.onmessage = (e) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'audio', data: e.data }));
      }
    };

    // Step 5 — Set up playback worklet: receive base64 PCM → ring buffer → speakers
    playbackNode = new AudioWorkletNode(audioContext, 'audio-playback');
    playbackNode.connect(audioContext.destination);

    // Step 6 — Open WebSocket connection.
    const clientId = crypto.randomUUID();
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${location.host}/ws/${clientId}`;
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      // Step 7 — Send "start" with any user-overridden settings.
      ws.send(JSON.stringify({
        type: 'start',
        config: {
          endpoint: cfgEndpoint.value || undefined,
          apiKey:   cfgApiKey.value   || undefined,
          model:    cfgModel.value    || undefined,
          voice:    cfgVoice.value    || undefined,
        },
      }));
    };

    ws.onmessage = handleMessage;

    ws.onerror = (err) => {
      console.error('WebSocket error:', err);
      setStatus('Connection error', 'error');
    };

    ws.onclose = () => {
      setStatus('Disconnected', '');
      setBtnState(false);
    };

    setBtnState(true);

  } catch (err) {
    console.error('Failed to start session:', err);
    setStatus(`Error: ${err.message}`, 'error');
    await cleanup();
  }
}

/**
 * Stop the voice session gracefully.
 * Sends a "stop" message to the backend, closes the WebSocket, and
 * releases all audio resources.
 */
async function stopSession() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'stop' }));
    ws.close();
  }
  await cleanup();
  setStatus('Disconnected', '');
  setBtnState(false);
}

/**
 * Release all audio resources (mic stream, AudioContext, worklet nodes).
 */
async function cleanup() {
  micStream?.getTracks().forEach(t => t.stop());
  await audioContext?.close();
  micStream    = null;
  audioContext = null;
  captureNode  = null;
  playbackNode = null;
}

// ── WebSocket message handler ─────────────────────────────────────────────

/**
 * Route incoming WebSocket messages to the appropriate UI update.
 *
 * Message types (server → browser):
 *   session_ready  — Voice Live is connected, audio can flow
 *   speech_start   — user is speaking (animate mic indicator)
 *   speech_stop    — user stopped speaking
 *   transcript     — text from user or assistant
 *   audio          — base64 PCM audio chunk for TTS playback
 *   fields         — updated protocol field values
 *   response_done  — assistant finished its response
 *   export         — response to {type:"export"} request
 *   error          — something went wrong
 */
function handleMessage(event) {
  let msg;
  try {
    msg = JSON.parse(event.data);
  } catch {
    console.warn('Non-JSON message from server:', event.data);
    return;
  }

  switch (msg.type) {

    case 'session_ready':
      setStatus('Connected', 'connected');
      appendTranscript('Session ready — start speaking!', 'system');
      btnExport.disabled = false;
      break;

    case 'speech_start':
      // User is actively speaking — pulse the mic indicator orange
      setStatus('Listening…', 'speaking');
      break;

    case 'speech_stop':
      setStatus('Processing…', 'listening');
      break;

    case 'transcript':
      // Append to the transcript area.
      // role is "user" (blue) or "assistant" (green).
      appendTranscript(`${msg.role === 'user' ? '👤' : '🤖'} ${msg.text}`, msg.role);
      break;

    case 'audio':
      // Send base64 PCM to the playback worklet's ring buffer.
      if (playbackNode) {
        playbackNode.port.postMessage(msg.data);
      }
      break;

    case 'fields':
      // Update only non-empty values in the protocol form.
      updateFields(msg.data);
      break;

    case 'response_done':
      setStatus('Connected', 'connected');
      break;

    case 'export':
      // Triggered by exportProtocol() — download the fields as JSON.
      downloadJSON(msg.data, 'protocol.json');
      break;

    case 'error':
      console.error('Server error:', msg.message);
      appendTranscript(`⚠️ ${msg.message}`, 'system');
      setStatus('Error', 'error');
      break;

    default:
      console.warn('Unknown message type:', msg.type);
  }
}

// ── Export ────────────────────────────────────────────────────────────────

/**
 * Request the current extracted fields from the backend and download them
 * as a JSON file.
 */
function exportProtocol() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'export' }));
  }
}

/**
 * Trigger a browser file download for a JSON object.
 */
function downloadJSON(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ── UI helpers ────────────────────────────────────────────────────────────

/**
 * Update the status dot and text label.
 * @param {string} text   — human-readable status
 * @param {string} state  — CSS class for the dot: 'connected'|'speaking'|'listening'|'error'|''
 */
function setStatus(text, state) {
  statusText.textContent = text;
  statusDot.className = state;
}

/**
 * Append a line to the transcript area.
 * @param {string} text  — message text
 * @param {string} role  — 'user' | 'assistant' | 'system'
 */
function appendTranscript(text, role) {
  const line = document.createElement('div');
  line.className = `transcript-line ${role}`;
  line.textContent = text;
  transcriptEl.appendChild(line);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

/**
 * Update protocol form fields from a fields object.
 * Only updates fields that have a non-empty value so partially-filled
 * fields aren't overwritten with empty strings.
 * @param {Object} fields — e.g. { researcherName: "Alice", ... }
 */
function updateFields(fields) {
  for (const key of FIELD_IDS) {
    const value = fields[key];
    if (!value) continue;

    const el = document.getElementById(`field-${key}`);
    if (!el) continue;

    el.value = value;

    // Briefly highlight the field so the user notices the update.
    el.classList.add('just-updated');
    setTimeout(() => el.classList.remove('just-updated'), 1500);
  }
}

/**
 * Toggle enabled state of Start/Stop buttons.
 * @param {boolean} running — true if a session is active
 */
function setBtnState(running) {
  btnStart.disabled = running;
  btnStop.disabled  = !running;
}
