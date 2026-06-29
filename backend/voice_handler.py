"""
backend/voice_handler.py
-------------------------
Core bridge between the browser WebSocket and the Azure Voice Live SDK.

This is the most important file in the backend for learning purposes.
It shows exactly how to:
  1. Establish a Voice Live session using the azure-ai-voicelive SDK.
  2. Stream raw PCM audio from the browser into the Voice Live input buffer.
  3. React to server-sent events (speech detection, transcripts, audio deltas).
  4. Send audio and text responses back to the browser over the WebSocket.
  5. Trigger the GPT-4o extraction agent when a user transcript arrives.
  6. Inject follow-up questions back into the Voice Live conversation.

Architecture reminder:
  Browser ──(WebSocket)──► FastAPI ──(VoiceLive SDK)──► Azure AI Services
                                    ◄──────────────────────────────────────
  The VoiceSession class manages one session per connected browser client.
"""

import asyncio
import base64
import logging
import os
from typing import TYPE_CHECKING

from azure.ai.voicelive.aio import VoiceLiveClient
from azure.ai.voicelive.models import (
    ConversationItemCreateEvent,
    InputAudioBufferAppendEvent,
    RealtimeRequestSession,
    RealtimeRequestSessionInputAudioTranscription,
    ResponseCreateEvent,
    ServerEventType,
    SessionUpdateEvent,
    TurnDetection,
    VoiceConversationItem,
    VoiceConversationItemContent,
)
from azure.core.credentials import AzureKeyCredential
from azure.identity import DefaultAzureCredential

from agent import ExtractionAgent
from protocol_selector import ProtocolSelector

if TYPE_CHECKING:
    from fastapi import WebSocket

logger = logging.getLogger(__name__)

_protocol_selector = ProtocolSelector()


class VoiceSession:
    """
    Manages one Azure Voice Live session for a single browser client.

    Lifecycle:
      1. Instantiate with the browser's WebSocket.
      2. Call `await session.start(config)` to connect to Azure.
      3. Forward audio frames with `await session.send_audio(base64_pcm)`.
      4. Call `await session.stop()` to close gracefully.

    All server events are handled internally; results are pushed back to the
    browser via `_ws.send_json(...)`.
    """

    def __init__(self, websocket: "WebSocket") -> None:
        self._ws = websocket
        # The active Voice Live connection (set in start())
        self._connection = None
        # GPT-4o extraction agent — initialized once protocol is selected
        self._agent: ExtractionAgent | None = None
        self._protocol: dict | None = None
        # Current state of the protocol fields
        self._fields: dict = {}
        # Flag to signal the event-listener loop to stop
        self._running = False

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def start(self, config: dict, protocol_id: str) -> None:
        """
        Connect to Azure Voice Live and begin listening for events.

        `config` may contain overrides for endpoint, api_key, model, and voice.
        Falls back to environment variables for any value not provided.
        """
        self._protocol = _protocol_selector.select_protocol(protocol_id)
        self._fields = {key: "" for key in (self._protocol.get("fields") or {}).keys()}
        self._agent = ExtractionAgent(protocol=self._protocol)

        endpoint = config.get("endpoint") or os.getenv("AZURE_VOICELIVE_ENDPOINT", "")
        api_key = config.get("apiKey") or os.getenv("AZURE_VOICELIVE_API_KEY") or None
        model = config.get("model") or os.getenv("VOICELIVE_MODEL", "gpt-4o")
        voice = config.get("voice") or os.getenv("VOICELIVE_VOICE", "en-US-JennyNeural")

        # Choose credential: API key for local dev, DefaultAzureCredential in production.
        # DefaultAzureCredential will use az login, env vars, or Managed Identity
        # automatically depending on the environment.
        if api_key:
            credential = AzureKeyCredential(api_key)
        else:
            credential = DefaultAzureCredential()

        logger.info("Connecting to Voice Live: endpoint=%s model=%s voice=%s", endpoint, model, voice)

        # Open the Voice Live connection.
        # The SDK manages the underlying WebSocket to Azure AI Services.
        self._connection = await VoiceLiveClient(
            endpoint=endpoint,
            credential=credential,
        ).connect(model=model)

        # Configure the session: voice, turn detection, and transcription.
        await self._connection.session.update(
            session=RealtimeRequestSession(
                voice=voice,
                instructions=self._protocol.get("systemPrompt", ""),
                # Server-side VAD (Voice Activity Detection):
                # Azure automatically detects when the user starts/stops speaking.
                turn_detection=TurnDetection(type="server_vad"),
                # Enable transcription of the user's audio so we can run
                # the extraction agent on their words.
                input_audio_transcription=RealtimeRequestSessionInputAudioTranscription(
                    model="whisper-1"
                ),
            )
        )

        # Start the event listener as a background task so this coroutine returns
        # immediately and the caller can start forwarding audio.
        self._running = True
        asyncio.create_task(self._listen_for_events())

    async def send_audio(self, base64_pcm: str) -> None:
        """
        Forward a base64-encoded PCM audio chunk from the browser to Azure.

        The browser's AudioWorklet produces raw 16-bit PCM at 24 kHz and
        base64-encodes it before sending over the WebSocket.
        """
        if self._connection is None:
            return
        # Append the audio chunk to Voice Live's input buffer.
        # Azure accumulates these until it detects end-of-speech (VAD).
        await self._connection.input_audio_buffer.append(
            audio=base64_pcm
        )

    async def stop(self) -> None:
        """Close the Voice Live connection gracefully."""
        self._running = False
        if self._connection is not None:
            try:
                await self._connection.close()
            except Exception as exc:
                logger.warning("Error closing Voice Live connection: %s", exc)
            finally:
                self._connection = None

    def get_fields(self) -> dict:
        """Return the current state of the extracted protocol fields."""
        return dict(self._fields)

    def get_protocol_id(self) -> str:
        """Return the active protocol id."""
        if not self._protocol:
            return ""
        return str(self._protocol.get("id", ""))

    # ------------------------------------------------------------------
    # Internal event handler
    # ------------------------------------------------------------------

    async def _listen_for_events(self) -> None:
        """
        Main event loop — receives server events from Azure Voice Live and
        maps each one to a JSON message sent back to the browser.

        This is the heart of the integration. Study the ServerEventType
        enum to understand the full event surface area.
        """
        try:
            async for event in self._connection:
                if not self._running:
                    break

                event_type = event.type

                # ── Session ready ─────────────────────────────────────────
                if event_type == ServerEventType.SESSION_UPDATED:
                    # The session is now configured; tell the browser it can
                    # start streaming audio.
                    await self._ws.send_json({"type": "session_ready"})
                    await self._ws.send_json({"type": "fields", "data": self._fields})

                # ── Speech detection ──────────────────────────────────────
                elif event_type == ServerEventType.INPUT_AUDIO_BUFFER_SPEECH_STARTED:
                    # User has started speaking — animate the mic indicator.
                    await self._ws.send_json({"type": "speech_start"})

                elif event_type == ServerEventType.INPUT_AUDIO_BUFFER_SPEECH_STOPPED:
                    # User has stopped speaking — Azure will now process the audio.
                    await self._ws.send_json({"type": "speech_stop"})

                # ── User transcript ───────────────────────────────────────
                elif event_type == ServerEventType.CONVERSATION_ITEM_INPUT_AUDIO_TRANSCRIPTION_COMPLETED:
                    # We now have the user's words as text.
                    transcript_text = getattr(event, "transcript", "")
                    await self._ws.send_json(
                        {"type": "transcript", "role": "user", "text": transcript_text}
                    )
                    # Run the extraction agent asynchronously so we don't block
                    # the event loop while waiting for the OpenAI API.
                    asyncio.create_task(
                        self._run_extraction(transcript_text)
                    )

                # ── TTS audio delta ───────────────────────────────────────
                elif event_type == ServerEventType.RESPONSE_AUDIO_DELTA:
                    # A chunk of the assistant's audio response has arrived.
                    # Forward it to the browser as base64 PCM so the
                    # audio-playback worklet can play it.
                    audio_data = getattr(event, "delta", "")
                    await self._ws.send_json(
                        {"type": "audio", "data": audio_data}
                    )

                # ── Assistant transcript (streaming) ──────────────────────
                elif event_type == ServerEventType.RESPONSE_AUDIO_TRANSCRIPT_DELTA:
                    # Partial assistant transcript — append to the transcript area.
                    delta_text = getattr(event, "delta", "")
                    await self._ws.send_json(
                        {"type": "transcript", "role": "assistant", "text": delta_text}
                    )

                # ── Response complete ─────────────────────────────────────
                elif event_type == ServerEventType.RESPONSE_DONE:
                    await self._ws.send_json({"type": "response_done"})

                # ── Errors ────────────────────────────────────────────────
                elif event_type == ServerEventType.ERROR:
                    error_msg = getattr(event, "error", {})
                    if isinstance(error_msg, dict):
                        error_msg = error_msg.get("message", str(error_msg))
                    logger.error("Voice Live error: %s", error_msg)
                    await self._ws.send_json(
                        {"type": "error", "message": str(error_msg)}
                    )

        except Exception as exc:
            logger.error("Event loop error: %s", exc)
            try:
                await self._ws.send_json(
                    {"type": "error", "message": f"Session error: {exc}"}
                )
            except Exception:
                pass  # WebSocket may already be closed

    async def _run_extraction(self, transcript: str) -> None:
        """
        Run the GPT-4o extraction agent against the latest transcript.

        If new field values are found, broadcast them to the browser.
        If a follow_up_hint is returned, inject it into the Voice Live
        conversation so the assistant asks the next question automatically.
        """
        if self._agent is None:
            return

        result = await self._agent.extract(transcript, self._fields)
        updated_fields = result["fields"]
        follow_up_hint = result.get("follow_up_hint", "")

        # Check whether any fields actually changed
        changed = {k: v for k, v in updated_fields.items() if v != self._fields.get(k)}
        self._fields = updated_fields

        if changed:
            # Push field updates to the browser so the form is updated live.
            await self._ws.send_json({"type": "fields", "data": updated_fields})

        # If there is a follow-up question, inject it into the Voice Live
        # conversation. This causes the assistant to ask the question aloud
        # without requiring a new user utterance.
        if follow_up_hint and self._connection is not None:
            try:
                # Step 1: Add a text message from the user side prompting
                #         the assistant to ask the follow-up.
                await self._connection.conversation.item.create(
                    item=VoiceConversationItem(
                        type="message",
                        role="user",
                        content=[
                            VoiceConversationItemContent(
                                type="input_text",
                                text=f"[system hint] Please ask: {follow_up_hint}",
                            )
                        ],
                    )
                )
                # Step 2: Ask Voice Live to generate a response to that message.
                await self._connection.response.create()
            except Exception as exc:
                logger.warning("Failed to inject follow-up hint: %s", exc)
