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

from openai import AsyncAzureOpenAI

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Protocol schema
# ---------------------------------------------------------------------------
# The six fields that make up a minimal lab protocol.
# All fields are strings; the extraction agent populates them from the
# running transcript and leaves unchanged any field the user hasn't mentioned yet.
PROTOCOL_SCHEMA = {
    "researcherName": "string — full name of the researcher",
    "experimentTitle": "string — short descriptive title of the experiment",
    "experimentDate": "string — date in DD.MM.YYYY format",
    "procedureSteps": "string — numbered list of procedure steps",
    "observations": "string — what was observed during the experiment",
    "result": "string — outcome: 'pass' or 'fail' plus brief notes",
}

SYSTEM_PROMPT = """You are a data-extraction assistant for lab protocols.
Given the latest transcript snippet and the current state of the protocol fields,
extract or update any field values you can infer from the transcript.

Protocol schema (JSON):
{schema}

Rules:
1. Only update a field if the transcript clearly provides new information for it.
2. Keep the existing value if the transcript doesn't mention anything new for that field.
3. Use DD.MM.YYYY for dates.
4. For `result`, start with "pass" or "fail" followed by any notes.
5. Identify the single most important field that is still empty or incomplete and
   return it as `follow_up_hint` (a short question the assistant should ask).
   If all fields are filled, return an empty string for `follow_up_hint`.

Respond ONLY with valid JSON in this exact shape:
{{
  "fields": {{
    "researcherName": "...",
    "experimentTitle": "...",
    "experimentDate": "...",
    "procedureSteps": "...",
    "observations": "...",
    "result": "..."
  }},
  "follow_up_hint": "..."
}}
""".format(
    schema=json.dumps(PROTOCOL_SCHEMA, indent=2)
)


class ExtractionAgent:
    """
    Extracts structured protocol fields from a running transcript.

    Usage:
        agent = ExtractionAgent()
        result = await agent.extract(transcript, current_fields)
        # result = {"fields": {...}, "follow_up_hint": "..."}
    """

    def __init__(self) -> None:
        # Resolve the Azure OpenAI endpoint — fall back to the Voice Live endpoint
        # if no dedicated OpenAI endpoint is configured.
        openai_endpoint = os.getenv("AZURE_OPENAI_ENDPOINT") or os.getenv(
            "AZURE_VOICELIVE_ENDPOINT", ""
        )
        api_key = os.getenv("AZURE_VOICELIVE_API_KEY") or None
        self._deployment = os.getenv("AZURE_OPENAI_DEPLOYMENT", "gpt-4o")

        # AsyncAzureOpenAI client — uses api_key when provided,
        # otherwise falls back to DefaultAzureCredential via the azure-identity
        # token provider (not shown here for brevity; add if needed).
        self._client = AsyncAzureOpenAI(
            azure_endpoint=openai_endpoint,
            api_key=api_key,
            api_version="2024-02-01",
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
                    {"role": "system", "content": SYSTEM_PROMPT},
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
                if key in merged and value:
                    merged[key] = value

            logger.debug("Extraction result: %s | hint: %s", merged, follow_up_hint)
            return {"fields": merged, "follow_up_hint": follow_up_hint}

        except Exception as exc:
            # On any failure (network, parsing, quota) return the current fields
            # unchanged so the session is not disrupted.
            logger.warning("Extraction failed: %s", exc)
            return {"fields": current_fields, "follow_up_hint": ""}
