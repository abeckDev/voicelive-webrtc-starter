"""
backend/app.py
--------------
FastAPI application entry point for the voicelive-webrtc-starter.

This file wires together:
  - REST endpoints (/health, /config)
  - WebSocket endpoint (/ws/{client_id}) — the main session channel
  - Static file serving for the frontend (when the ../frontend directory exists)

The WebSocket endpoint handles four message types:
  - {type: "start",  config: {...}}  — open a new Voice Live session
  - {type: "audio",  data:  "..."}  — forward a base64 PCM audio chunk
  - {type: "stop"}                  — gracefully end the session
  - {type: "export"}                — return current extracted fields as JSON

Run with:
  uvicorn app:app --reload --port 8000
or simply:
  python app.py
"""

import logging
import os
import pathlib
from contextlib import asynccontextmanager
from typing import Dict

import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles

from voice_handler import VoiceSession

# ---------------------------------------------------------------------------
# Bootstrap
# ---------------------------------------------------------------------------

# Load .env from the backend directory (or parent) so the app works both when
# launched from the backend/ folder and from the repo root.
load_dotenv(dotenv_path=pathlib.Path(__file__).parent / ".env")
load_dotenv(dotenv_path=pathlib.Path(__file__).parent.parent / ".env")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(name)s — %(message)s",
)
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Application factory
# ---------------------------------------------------------------------------


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("voicelive-webrtc-starter backend starting up")
    yield
    logger.info("voicelive-webrtc-starter backend shutting down")


app = FastAPI(
    title="voicelive-webrtc-starter",
    description="Learning-focused starter for Azure Voice Live + WebRTC",
    version="0.1.0",
    lifespan=lifespan,
)

# ---------------------------------------------------------------------------
# In-memory session store
# One VoiceSession per connected client (keyed by client_id).
# ---------------------------------------------------------------------------
_sessions: Dict[str, VoiceSession] = {}

# ---------------------------------------------------------------------------
# REST endpoints
# ---------------------------------------------------------------------------


@app.get("/health")
async def health() -> dict:
    """
    Health check endpoint.
    Returns whether the backend is running and Voice Live is configured.
    """
    endpoint = os.getenv("AZURE_VOICELIVE_ENDPOINT", "")
    return {
        "status": "ok",
        "voicelive_configured": bool(endpoint),
    }


@app.get("/config")
async def get_config() -> dict:
    """
    Return current model/voice settings so the frontend can pre-fill
    its settings panel without exposing secrets.
    """
    return {
        "model": os.getenv("VOICELIVE_MODEL", "gpt-4o"),
        "voice": os.getenv("VOICELIVE_VOICE", "en-US-JennyNeural"),
        # Endpoint is returned so the frontend can display it, but the API key
        # is intentionally NOT returned — the browser should either use the
        # server-side key (default) or supply its own in the settings panel.
        "endpoint": os.getenv("AZURE_VOICELIVE_ENDPOINT", ""),
    }


# ---------------------------------------------------------------------------
# WebSocket endpoint — main session channel
# ---------------------------------------------------------------------------


@app.websocket("/ws/{client_id}")
async def websocket_session(websocket: WebSocket, client_id: str) -> None:
    """
    One WebSocket connection per browser tab / client_id.

    Protocol (browser → server):
      {type: "start",  config: {endpoint?, apiKey?, model?, voice?}}
      {type: "audio",  data:  "<base64 PCM>"}
      {type: "stop"}
      {type: "export"}

    Protocol (server → browser) — see voice_handler.py for the full list:
      {type: "session_ready"}
      {type: "speech_start"} / {type: "speech_stop"}
      {type: "transcript", role: "user"|"assistant", text: "..."}
      {type: "audio",  data: "<base64 PCM>"}
      {type: "fields", data: {...}}
      {type: "response_done"}
      {type: "error",  message: "..."}
    """
    await websocket.accept()
    logger.info("Client connected: %s", client_id)

    session: VoiceSession | None = None

    try:
        while True:
            # Receive the next message from the browser.
            message = await websocket.receive_json()
            msg_type = message.get("type")

            # ── Start session ─────────────────────────────────────────────
            if msg_type == "start":
                # Tear down any existing session for this client
                if client_id in _sessions:
                    await _sessions[client_id].stop()

                session = VoiceSession(websocket)
                _sessions[client_id] = session

                config = message.get("config", {})
                await session.start(config)
                logger.info("Session started for client: %s", client_id)

            # ── Audio chunk ───────────────────────────────────────────────
            elif msg_type == "audio":
                if session is not None:
                    # Forward the base64 PCM chunk straight to Voice Live.
                    await session.send_audio(message.get("data", ""))

            # ── Stop session ──────────────────────────────────────────────
            elif msg_type == "stop":
                if session is not None:
                    await session.stop()
                    session = None
                    _sessions.pop(client_id, None)
                    logger.info("Session stopped for client: %s", client_id)

            # ── Export fields ─────────────────────────────────────────────
            elif msg_type == "export":
                fields = session.get_fields() if session else {}
                await websocket.send_json({"type": "export", "data": fields})

            else:
                logger.warning("Unknown message type '%s' from %s", msg_type, client_id)

    except WebSocketDisconnect:
        logger.info("Client disconnected: %s", client_id)
    except Exception as exc:
        logger.error("WebSocket error for client %s: %s", client_id, exc)
        try:
            await websocket.send_json({"type": "error", "message": str(exc)})
        except Exception:
            pass
    finally:
        # Always clean up the session when the WebSocket closes.
        if client_id in _sessions:
            await _sessions[client_id].stop()
            _sessions.pop(client_id, None)


# ---------------------------------------------------------------------------
# Static file serving (frontend)
# ---------------------------------------------------------------------------

# Serve the frontend from ../frontend when running locally without a
# dedicated web server. This keeps the setup simple: one process serves both
# the API and the UI.
_frontend_path = pathlib.Path(__file__).parent.parent / "frontend"
if _frontend_path.exists():
    app.mount("/", StaticFiles(directory=str(_frontend_path), html=True), name="frontend")
    logger.info("Serving frontend from: %s", _frontend_path)

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    uvicorn.run(
        "app:app",
        host="0.0.0.0",
        port=8000,
        reload=True,
        log_level="info",
    )
