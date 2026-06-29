"""
backend/agent.py
----------------
GPT-4o extraction agent for the voicelive-webrtc-starter.

This module defines the ExtractionAgent class, which listens to user transcripts
produced by Azure Voice Live and extracts structured lab-protocol fields using
the Azure OpenAI API (JSON mode).

It also produces a `follow_up_hint` — the most important field that is still
missing from the protocol — which the voice handler can inject back into the
Voice Live conversation to keep the interview moving forward.

Learning note:
  This is intentionally simple. In a production system you might use
  structured outputs, tool-calling, or a more sophisticated schema.
  Here we use JSON mode for clarity.
"""

import json
import logging
import os

from azure.identity import DefaultAzureCredential, get_bearer_token_provider
from openai import AsyncAzureOpenAI

logger = logging.getLogger(__name__)


class ExtractionAgent:
    """
    Extracts structured protocol fields from a running transcript.

    Usage:
        agent = ExtractionAgent(protocol=...)
        result = await agent.extract(transcript, current_fields)
        # result = {"fields": {...}, "follow_up_hint": "..."}
    """

    def __init__(self, protocol: dict) -> None:
        # Resolve the Azure OpenAI endpoint — fall back to the Voice Live endpoint
        # if no dedicated OpenAI endpoint is configured.
        openai_endpoint = os.getenv("AZURE_OPENAI_ENDPOINT") or os.getenv(
            "AZURE_VOICELIVE_ENDPOINT", ""
        )
        api_key = (os.getenv("AZURE_VOICELIVE_API_KEY") or "").strip()
        self._deployment = os.getenv("AZURE_OPENAI_DEPLOYMENT", "gpt-4o")
        self._field_keys = list((protocol.get("fields") or {}).keys())
        self._system_prompt = self._build_system_prompt(protocol)

        client_kwargs = {
            "azure_endpoint": openai_endpoint,
            "api_version": "2024-02-01",
        }
        if api_key:
            client_kwargs["api_key"] = api_key
        else:
            credential = DefaultAzureCredential()
            client_kwargs["azure_ad_token_provider"] = get_bearer_token_provider(
                credential, "https://cognitiveservices.azure.com/.default"
            )

        self._client = AsyncAzureOpenAI(**client_kwargs)

    def _build_system_prompt(self, protocol: dict) -> str:
        schema = protocol.get("fields") or {}
        empty_shape = {key: "..." for key in schema.keys()}
        return (
            f'{protocol.get("systemPrompt", "")}\n\n'
            f'Protocol schema (JSON):\n{json.dumps(schema, indent=2)}\n\n'
            "Rules:\n"
            "1. Only update a field if the transcript clearly provides new information for it.\n"
            "2. Keep the existing value if the transcript doesn't mention anything new for that field.\n"
            "3. Identify the single most important field that is still empty or incomplete and\n"
            "   return it as `follow_up_hint` (a short question the assistant should ask).\n"
            "4. If all fields are filled, return an empty string for `follow_up_hint`.\n\n"
            "Respond ONLY with valid JSON in this exact shape:\n"
            "{\n"
            f'  "fields": {json.dumps(empty_shape, indent=2)},\n'
            '  "follow_up_hint": "..."\n'
            "}\n"
        )

    async def extract(self, transcript: str, current_fields: dict) -> dict:
        """
        Extract or update protocol fields from *transcript*.

        Parameters
        ----------
        transcript:
            The latest speech-to-text transcript fragment from the user.
        current_fields:
            The current state of the protocol (may have empty strings for
            fields not yet filled in).

        Returns
        -------
        dict with two keys:
          - "fields": updated protocol fields dict
          - "follow_up_hint": string — next question to ask, or "" if complete
        """
        user_message = (
            f"Current protocol fields:\n{json.dumps(current_fields, indent=2)}\n\n"
            f"New transcript:\n{transcript}"
        )

        try:
            response = await self._client.chat.completions.create(
                model=self._deployment,
                messages=[
                    {"role": "system", "content": self._system_prompt},
                    {"role": "user", "content": user_message},
                ],
                # JSON mode ensures the model always returns parseable JSON.
                response_format={"type": "json_object"},
                temperature=0.0,  # deterministic extraction
            )

            raw = response.choices[0].message.content or "{}"
            parsed = json.loads(raw)

            # Validate structure — be lenient in case the model omits a key
            fields = parsed.get("fields", current_fields)
            follow_up_hint = parsed.get("follow_up_hint", "")

            # Merge: only overwrite non-empty extracted values
            merged = dict(current_fields)
            for key, value in fields.items():
                if key in merged and key in self._field_keys and value:
                    merged[key] = value

            logger.debug("Extraction result: %s | hint: %s", merged, follow_up_hint)
            return {"fields": merged, "follow_up_hint": follow_up_hint}

        except Exception as exc:
            # On any failure (network, parsing, quota) return the current fields
            # unchanged so the session is not disrupted.
            logger.warning("Extraction failed: %s", exc)
            return {"fields": current_fields, "follow_up_hint": ""}
