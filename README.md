# voicelive-webrtc-starter

A minimal, **learning-focused** starter that shows how to build a voice application
using [Azure Voice Live API](https://learn.microsoft.com/azure/ai-services/speech-service/voice-live-overview),
connected to a custom frontend via **WebSocket** (with a detailed guide on upgrading to **WebRTC DataChannel**).

The demo use case: a voice assistant that listens to a researcher describe their experiment
and automatically fills out a lab protocol form in real time.

---

## What This Is

This repository is a deliberately simplified extraction of the key concepts from the
[LabBuddy reference implementation](https://github.com/abeckDev/LabBuddy-SmartLabProtocollationAssistant).
Every file is written for **clarity**, not feature richness. If you want to understand
how Azure Voice Live + real-time audio + structured data extraction work together,
start here.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  BROWSER                                                         │
│                                                                  │
│  getUserMedia()                                                  │
│       │                                                          │
│       ▼  Float32 samples (Web Audio)                            │
│  audio-capture.worklet.js  ──► 16-bit PCM @ 24 kHz              │
│       │                         (480 sample / 20 ms chunks)     │
│       │  base64 PCM                                              │
│       ▼                                                          │
│  app.js (WebSocket client) ──────────────────────────────────┐  │
│       ▲                                                       │  │
│       │  JSON messages                                        │  │
│  audio-playback.worklet.js ◄── base64 PCM (TTS audio)        │  │
│  Protocol form fields ◄──── {type:"fields", data:{...}}      │  │
│  Transcript display ◄─────── {type:"transcript", ...}        │  │
└──────────────────────────────────────────────────────────────┼──┘
                                                               │
                               WebSocket /ws/{clientId}        │
                                                               │
┌──────────────────────────────────────────────────────────────▼──┐
│  FASTAPI BACKEND (backend/app.py)                                │
│                                                                  │
│  /ws/{clientId} ──► VoiceSession (voice_handler.py)             │
│       │                    │                                     │
│       │                    ▼  azure-ai-voicelive SDK             │
│       │             Azure AI Services                            │
│       │             ┌─────────────────────────────────────┐     │
│       │             │  STT (Whisper)                       │     │
│       │             │  LLM (GPT-4o)  ◄── system prompt    │     │
│       │             │  TTS (Neural voice)                  │     │
│       │             └──────────────┬──────────────────────┘     │
│       │                            │ ServerEventType events      │
│       │             ┌──────────────▼──────────────────────┐     │
│       │             │  ExtractionAgent (agent.py)          │     │
│       │             │  GPT-4o → structured protocol fields │     │
│       │             └──────────────┬──────────────────────┘     │
│       └────────────────────────────┘                            │
│         JSON: transcript, audio, fields, errors                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Prerequisites

| Requirement | Notes |
|---|---|
| **Azure subscription** | [Free trial available](https://azure.microsoft.com/free/) |
| **Azure AI Services** | Resource of kind `AIServices` with Voice Live enabled. Deploy with `infra/main.bicep` or manually in the Azure portal. |
| **GPT-4o deployment** | Inside the same AI Services resource. Name: `gpt-4o` |
| **Python 3.11+** | `python --version` |
| **Modern browser** | Chrome 110+, Edge 110+, Firefox 116+, Safari 16.4+ |

---

## Quick Start

```bash
# 1. Clone the repo
git clone https://github.com/abeckDev/voicelive-webrtc-starter.git
cd voicelive-webrtc-starter

# 2. Configure environment
cp .env.sample .env
# Edit .env — fill in AZURE_VOICELIVE_ENDPOINT and AZURE_VOICELIVE_API_KEY

# 3. Install Python dependencies
pip install -r backend/requirements.txt

# 4. Start the backend (serves both the API and the frontend)
cd backend
python app.py
# → http://localhost:8000
```

Open **http://localhost:8000** in your browser, click **▶ Start**, and start talking.

### Alternative: Docker

```bash
cp .env.sample .env  # fill in your values
docker compose up --build
# → http://localhost:8000
```

---

## How It Works

### 1. Microphone Capture (browser)

`audio-capture.worklet.js` runs in an [AudioWorklet](https://developer.mozilla.org/en-US/docs/Web/API/AudioWorklet)
thread. It receives raw `Float32Array` samples from `getUserMedia()`, converts them to
**16-bit PCM at 24 kHz**, buffers them into 20 ms chunks, and posts each chunk as
a **base64 string** to the main thread via `port.postMessage()`.

### 2. WebSocket Transport (browser → backend)

`app.js` receives the base64 chunks and wraps them in a JSON envelope:
```json
{ "type": "audio", "data": "<base64 PCM>" }
```
This is sent over a plain WebSocket to `/ws/{clientId}` on the FastAPI backend.

### 3. Voice Live SDK (backend → Azure)

`voice_handler.py` feeds the PCM into Azure Voice Live using:
```python
await connection.input_audio_buffer.append(audio=base64_pcm)
```
Azure performs:
- **STT** (Whisper) — converts the audio to a transcript
- **GPT-4o** — the language model generates a spoken response using the system prompt
- **TTS** (Neural voice) — converts the response text to audio

### 4. Event Stream (Azure → backend → browser)

The SDK fires `ServerEventType` events. The backend maps them to JSON messages sent
back to the browser over the same WebSocket:

| SDK Event | Browser Message |
|---|---|
| `SESSION_UPDATED` | `{type:"session_ready"}` |
| `INPUT_AUDIO_BUFFER_SPEECH_STARTED` | `{type:"speech_start"}` |
| `INPUT_AUDIO_BUFFER_SPEECH_STOPPED` | `{type:"speech_stop"}` |
| `CONVERSATION_ITEM_INPUT_AUDIO_TRANSCRIPTION_COMPLETED` | `{type:"transcript", role:"user", text:"..."}` |
| `RESPONSE_AUDIO_DELTA` | `{type:"audio", data:"<base64 PCM>"}` |
| `RESPONSE_AUDIO_TRANSCRIPT_DELTA` | `{type:"transcript", role:"assistant", text:"..."}` |
| `RESPONSE_DONE` | `{type:"response_done"}` |
| `ERROR` | `{type:"error", message:"..."}` |

### 5. Audio Playback (browser)

`audio-playback.worklet.js` maintains a ring buffer. It receives base64 PCM chunks
from the WebSocket via `port.postMessage()`, decodes them, and drains the buffer
through the `AudioContext` destination (speakers).

### 6. Extraction Agent

When a user transcript arrives, `voice_handler.py` calls `ExtractionAgent.extract()` in
a background asyncio task. The agent sends the transcript to GPT-4o with a prompt that
describes the protocol schema. GPT-4o returns:
- Updated field values
- A `follow_up_hint` — the most important empty field to ask about next

If a follow-up hint exists, the backend injects it into the Voice Live conversation,
causing the assistant to ask the question aloud without waiting for user input.

---

## WebSocket vs WebRTC

This starter uses a **WebSocket** for the audio channel because it is dramatically
simpler to explain and debug. Here is exactly what you would change to use a
**WebRTC DataChannel** instead:

### Current (WebSocket)

```
Browser ──(WebSocket /ws/{id})──► FastAPI
```

### WebRTC DataChannel Upgrade

**Step 1** — Add a signaling endpoint to `backend/app.py`:
```python
@app.post("/rtc/offer")
async def rtc_offer(body: dict):
    # Create RTCPeerConnection, set remote SDP, return answer
    ...
```

**Step 2** — In `frontend/app.js`, replace WebSocket setup with:
```javascript
const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
const dc = pc.createDataChannel('audio');

const offer = await pc.createOffer();
await pc.setLocalDescription(offer);

const res = await fetch('/rtc/offer', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ sdp: offer.sdp, type: offer.type }),
});
const answer = await res.json();
await pc.setRemoteDescription(answer);
```

**Step 3** — Replace `ws.send(JSON.stringify({type:'audio', data: b64}))` with:
```javascript
dc.send(b64);  // or dc.send(pcmArrayBuffer) for binary
```

**Step 4** — Replace `ws.onmessage` with `dc.onmessage`.

### Why WebRTC is Better in Production

| | WebSocket | WebRTC DataChannel |
|---|---|---|
| **Latency** | ~50–150 ms (TCP) | ~10–50 ms (UDP/DTLS) |
| **NAT traversal** | Proxy required | Built-in ICE/STUN/TURN |
| **Congestion control** | None | QUIC/SCTP CC |
| **Setup complexity** | Trivial | Moderate (ICE negotiation) |
| **Debugging** | Easy (DevTools Network) | Harder (WebRTC internals) |

For a **learning project**: WebSocket ✅  
For **production** with low-latency requirements: WebRTC DataChannel ✅

---

## Configuration Reference

All configuration is via environment variables. Copy `.env.sample` to `.env`:

| Variable | Required | Default | Description |
|---|---|---|---|
| `AZURE_VOICELIVE_ENDPOINT` | ✅ | — | Azure AI Services endpoint URL |
| `AZURE_VOICELIVE_API_KEY` | ❌ | — | API key (leave empty to use Managed Identity / `az login`) |
| `AZURE_OPENAI_ENDPOINT` | ❌ | `AZURE_VOICELIVE_ENDPOINT` | Separate OpenAI endpoint (if different) |
| `AZURE_OPENAI_DEPLOYMENT` | ❌ | `gpt-4o` | GPT-4o deployment name |
| `VOICELIVE_MODEL` | ❌ | `gpt-4o` | Voice Live language model |
| `VOICELIVE_VOICE` | ❌ | `en-US-JennyNeural` | Azure Neural TTS voice |

---

## Project Structure

```
voicelive-webrtc-starter/
│
├── README.md                         # This file
├── .env.sample                       # Environment variable template
├── Dockerfile                        # Single-stage Python image
├── docker-compose.yml                # Local dev: backend + hot-reload
│
├── backend/
│   ├── app.py                        # FastAPI app + WebSocket endpoint
│   ├── voice_handler.py              # Azure Voice Live SDK bridge
│   ├── agent.py                      # GPT-4o extraction agent
│   ├── requirements.txt              # Python dependencies
│   └── .env.sample                   # Same as root (for convenience)
│
├── frontend/
│   ├── index.html                    # Single-page UI
│   ├── app.js                        # WebSocket client + field rendering
│   ├── audio-capture.worklet.js      # AudioWorklet: mic → PCM
│   ├── audio-playback.worklet.js     # AudioWorklet: PCM → speakers
│   └── style.css                     # Minimal styling
│
└── infra/
    ├── main.bicep                    # Azure AI Services + GPT-4o deployment
    └── README.md                     # Deployment instructions
```

---

## Extending This Starter

| Idea | Where to change |
|---|---|
| Add more protocol fields | `PROTOCOL_SCHEMA` in `backend/agent.py` + form fields in `frontend/index.html` |
| Change the domain (e.g., patient intake) | System prompt in `backend/voice_handler.py` + schema in `backend/agent.py` |
| Export to Excel | Add `openpyxl` to `requirements.txt`; add a `/export/xlsx` REST endpoint in `app.py` |
| Add authentication | FastAPI middleware + Azure AD MSAL in the frontend |
| Add camera / vision | Extend the WebSocket protocol with `{type:"image"}` messages + GPT-4o Vision |
| Replace WebSocket with WebRTC | See the **WebSocket vs WebRTC** section above |
| Deploy to Azure Container Apps | Add an ACA + ACR Bicep module in `infra/` (see LabBuddy reference) |

---

## Reference Implementation

This starter is distilled from the full production implementation:

**[abeckDev/LabBuddy-SmartLabProtocollationAssistant](https://github.com/abeckDev/LabBuddy-SmartLabProtocollationAssistant)**

That repository adds: camera vision, Azure Blob Storage export, multi-profile JSON configs,
Azure Container Apps deployment, and a richer domain-specific UI.

---

## License

MIT
