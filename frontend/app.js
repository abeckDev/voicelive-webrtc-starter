const btnStart = document.getElementById('btn-start');
const btnStop = document.getElementById('btn-stop');
const btnExport = document.getElementById('btn-export');
const btnExportXls = document.getElementById('btn-export-xls');
const btnExportWav = document.getElementById('btn-export-wav');
const btnExportTxt = document.getElementById('btn-export-txt');
const btnSaveBlob = document.getElementById('btn-save-blob');
const exportGroup = document.getElementById('export-group');
const protocolPanel = document.getElementById('protocol-panel');
const protocolSelect = document.getElementById('protocol-select');
const protocolFieldsEl = document.getElementById('protocol-fields');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const transcriptEl = document.getElementById('transcript');
const cfgEndpoint = document.getElementById('cfg-endpoint');
const cfgApiKey = document.getElementById('cfg-api-key');
const cfgModel = document.getElementById('cfg-model');
const cfgVoice = document.getElementById('cfg-voice');

let ws = null;
let audioContext = null;
let captureNode = null;
let playbackNode = null;
let micStream = null;
let currentClientId = '';
let sessionMetadata = { session_id: '', started_at: '', ended_at: '' };
let latestFields = {};
let transcriptLines = [];
let capturedPcmChunks = [];
// Keep roughly up to ~5 minutes of 20ms chunks in memory for WAV export.
const MAX_PCM_CHUNKS = 15000;

document.addEventListener('DOMContentLoaded', async () => {
  await Promise.all([loadConfig(), loadProtocols()]);

  btnStart.addEventListener('click', startSession);
  btnStop.addEventListener('click', stopSession);
  btnExport.addEventListener('click', exportProtocol);
  btnExportXls.addEventListener('click', () => exportXls(latestFields));
  btnExportTxt.addEventListener('click', () => exportTxt(transcriptLines));
  btnExportWav.addEventListener('click', exportWav);
  btnSaveBlob.addEventListener('click', saveToBlob);
});

async function loadConfig() {
  try {
    const res = await fetch('/config');
    if (!res.ok) return;
    const cfg = await res.json();
    if (cfg.endpoint) cfgEndpoint.value = cfg.endpoint;
    if (cfg.model) cfgModel.value = cfg.model;
    if (cfg.voice) cfgVoice.value = cfg.voice;
  } catch (err) {
    console.warn('Could not fetch /config:', err);
  }
}

async function loadProtocols() {
  try {
    const res = await fetch('/protocols');
    if (!res.ok) {
      markProtocolsUnavailable('Could not load protocols from backend.');
      return;
    }
    const protocols = await res.json();
    if (!protocols.length) {
      markProtocolsUnavailable('No protocols available.');
      return;
    }
    protocolSelect.innerHTML = '';
    for (const protocol of protocols) {
      const option = document.createElement('option');
      option.value = protocol.id;
      option.textContent = `${protocol.name} — ${protocol.description}`;
      protocolSelect.appendChild(option);
    }
    btnStart.disabled = false;
  } catch (err) {
    console.warn('Could not fetch /protocols:', err);
    markProtocolsUnavailable('Could not fetch protocols.');
  }
}

function markProtocolsUnavailable(message) {
  btnStart.disabled = true;
  setStatus(message, 'error');
  appendTranscript(`⚠️ ${message}`, 'system');
}

async function startSession() {
  setStatus('Connecting…', '');
  setBtnState(true, false);
  exportGroup.hidden = true;
  protocolPanel.hidden = false;
  latestFields = {};
  transcriptLines = [];
  capturedPcmChunks = [];
  clearFieldValues();
  transcriptEl.innerHTML = '';

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.close();
  }

  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    audioContext = new AudioContext({ sampleRate: 24000 });
    await audioContext.audioWorklet.addModule('audio-capture.worklet.js');
    await audioContext.audioWorklet.addModule('audio-playback.worklet.js');

    captureNode = new AudioWorkletNode(audioContext, 'audio-capture');
    const micSource = audioContext.createMediaStreamSource(micStream);
    micSource.connect(captureNode);
    captureNode.port.onmessage = (e) => {
      capturedPcmChunks.push(e.data);
      if (capturedPcmChunks.length > MAX_PCM_CHUNKS) {
        capturedPcmChunks.shift();
      }
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'audio', data: e.data }));
      }
    };

    playbackNode = new AudioWorkletNode(audioContext, 'audio-playback');
    playbackNode.connect(audioContext.destination);

    currentClientId = crypto.randomUUID();
    sessionMetadata = {
      session_id: currentClientId,
      started_at: new Date().toISOString(),
      ended_at: '',
    };

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${location.host}/ws/${currentClientId}`;
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: 'start',
        config: {
          endpoint: cfgEndpoint.value || undefined,
          apiKey: cfgApiKey.value || undefined,
          model: cfgModel.value || undefined,
          voice: cfgVoice.value || undefined,
          protocolId: protocolSelect.value || undefined,
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
      setBtnState(false, false);
      protocolPanel.hidden = false;
    };
  } catch (err) {
    console.error('Failed to start session:', err);
    setStatus(`Error: ${err.message}`, 'error');
    await cleanup();
    setBtnState(false, false);
  }
}

async function stopSession() {
  sessionMetadata.ended_at = new Date().toISOString();
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'stop' }));
  }
  await cleanup();
  setStatus('Session stopped', '');
  setBtnState(false, true);
  exportGroup.hidden = false;
  protocolPanel.hidden = false;
}

async function cleanup() {
  micStream?.getTracks().forEach((t) => t.stop());
  await audioContext?.close();
  micStream = null;
  audioContext = null;
  captureNode = null;
  playbackNode = null;
}

function handleMessage(event) {
  let msg;
  try {
    msg = JSON.parse(event.data);
  } catch {
    return;
  }

  switch (msg.type) {
    case 'session_ready':
      setStatus('Connected', 'connected');
      appendTranscript('Session ready — start speaking!', 'system');
      protocolPanel.hidden = true;
      break;
    case 'speech_start':
      setStatus('Listening…', 'speaking');
      break;
    case 'speech_stop':
      setStatus('Processing…', 'listening');
      break;
    case 'transcript':
      appendTranscript(`${msg.role === 'user' ? '👤' : '🤖'} ${msg.text}`, msg.role);
      break;
    case 'audio':
      if (playbackNode) playbackNode.port.postMessage(msg.data);
      break;
    case 'fields':
      latestFields = { ...latestFields, ...msg.data };
      updateFields(latestFields);
      break;
    case 'response_done':
      setStatus('Connected', 'connected');
      break;
    case 'export':
      downloadJSON(msg.data, 'protocol.json');
      break;
    case 'blob_saved':
      appendTranscript(`✅ Blob saved: ${msg.url}`, 'system');
      setStatus('Blob saved', 'connected');
      break;
    case 'error':
      appendTranscript(`⚠️ ${msg.message}`, 'system');
      setStatus('Error', 'error');
      break;
    default:
      break;
  }
}

function exportProtocol() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'export' }));
  } else {
    downloadJSON(latestFields, 'protocol.json');
  }
}

function saveToBlob() {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    appendTranscript('⚠️ WebSocket is closed; start a new session to save to blob.', 'system');
    return;
  }
  ws.send(JSON.stringify({
    type: 'save_to_blob',
    protocolId: protocolSelect.value || undefined,
    session_metadata: sessionMetadata,
  }));
}

function exportXls(fields) {
  const lines = ['Field\tValue'];
  for (const [key, value] of Object.entries(fields || {})) {
    lines.push(`${escapeTsv(key)}\t${escapeTsv(String(value ?? ''))}`);
  }
  downloadBlob(lines.join('\n'), 'application/vnd.ms-excel', 'protocol.xls');
}

function exportTxt(lines) {
  downloadBlob((lines || []).join('\n'), 'text/plain;charset=utf-8', 'transcript.txt');
}

function exportWav() {
  if (!capturedPcmChunks.length) {
    appendTranscript('⚠️ No captured audio available for WAV export.', 'system');
    return;
  }

  const pcm = concatBase64PcmChunks(capturedPcmChunks);
  const wav = pcmToWav(pcm, 24000, 1, 16);
  const url = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'session.wav';
  a.click();
  URL.revokeObjectURL(url);
}

function concatBase64PcmChunks(chunks) {
  const byteArrays = chunks.map((chunk) => base64ToUint8Array(chunk));
  const totalBytes = byteArrays.reduce((sum, arr) => sum + arr.byteLength, 0);
  const output = new Uint8Array(totalBytes);
  let offset = 0;
  for (const arr of byteArrays) {
    output.set(arr, offset);
    offset += arr.byteLength;
  }
  return output;
}

function pcmToWav(pcmBytes, sampleRate, channels, bitsPerSample) {
  const dataSize = pcmBytes.byteLength;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const blockAlign = channels * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  new Uint8Array(buffer, 44).set(pcmBytes);
  return buffer;
}

function writeAscii(view, offset, text) {
  for (let i = 0; i < text.length; i += 1) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

function base64ToUint8Array(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function escapeTsv(value) {
  return value.replace(/\t/g, ' ').replace(/\n/g, ' ');
}

function downloadJSON(data, filename) {
  downloadBlob(JSON.stringify(data, null, 2), 'application/json', filename);
}

function downloadBlob(content, type, filename) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function setStatus(text, state) {
  statusText.textContent = text;
  statusDot.className = state;
}

function appendTranscript(text, role) {
  transcriptLines.push(text);
  const line = document.createElement('div');
  line.className = `transcript-line ${role}`;
  line.textContent = text;
  transcriptEl.appendChild(line);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function clearFieldValues() {
  for (const el of protocolFieldsEl.querySelectorAll('input, textarea')) {
    el.value = '';
  }
}

function ensureFieldElement(key) {
  let el = document.getElementById(`field-${key}`);
  if (el) return el;

  const group = document.createElement('div');
  group.className = 'form-group';

  const label = document.createElement('label');
  label.setAttribute('for', `field-${key}`);
  label.textContent = key;
  group.appendChild(label);

  const multiline = /(steps|description|observations|resolution)/i.test(key);
  el = document.createElement(multiline ? 'textarea' : 'input');
  el.id = `field-${key}`;
  if (!multiline) el.type = 'text';
  if (multiline) el.rows = 3;
  group.appendChild(el);

  protocolFieldsEl.appendChild(group);
  return el;
}

function updateFields(fields) {
  for (const [key, value] of Object.entries(fields || {})) {
    const el = ensureFieldElement(key);
    if (value === undefined || value === null) continue;
    el.value = String(value);
    el.classList.add('just-updated');
    setTimeout(() => el.classList.remove('just-updated'), 1500);
  }
}

function setBtnState(running, sessionEnded) {
  btnStart.disabled = running;
  btnStop.disabled = !running;

  const exportDisabled = !sessionEnded;
  btnExport.disabled = exportDisabled;
  btnExportXls.disabled = exportDisabled;
  btnExportWav.disabled = exportDisabled;
  btnExportTxt.disabled = exportDisabled;
  btnSaveBlob.disabled = exportDisabled;
}
