import json
import logging
import os
from datetime import datetime, timezone

from azure.identity.aio import DefaultAzureCredential
from azure.storage.blob import ContentSettings
from azure.storage.blob.aio import BlobServiceClient

logger = logging.getLogger(__name__)


async def save_protocol_to_blob(fields: dict, protocol_id: str, session_metadata: dict) -> str:
    account_url = os.getenv("AZURE_STORAGE_ACCOUNT_URL", "").strip()
    if not account_url:
        raise ValueError("AZURE_STORAGE_ACCOUNT_URL is required")

    container_name = os.getenv("AZURE_STORAGE_CONTAINER_NAME", "protocols").strip() or "protocols"
    session_id = session_metadata.get("session_id") or "unknown_session"
    timestamp = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    blob_name = f"{protocol_id}/{session_id}_{timestamp}.json"

    payload = {
        "protocol_id": protocol_id,
        "session_metadata": {
            "session_id": session_metadata.get("session_id", ""),
            "started_at": session_metadata.get("started_at", ""),
            "ended_at": session_metadata.get("ended_at", ""),
        },
        "extracted_fields": fields,
    }

    credential = DefaultAzureCredential()
    try:
        async with BlobServiceClient(account_url=account_url, credential=credential) as client:
            blob_client = client.get_blob_client(container=container_name, blob=blob_name)
            await blob_client.upload_blob(
                json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8"),
                overwrite=True,
                content_settings=ContentSettings(content_type="application/json"),
            )
            return blob_client.url
    except Exception:
        logger.exception(
            "Failed to save protocol to blob (protocol_id=%s, session_id=%s, container=%s)",
            protocol_id,
            session_id,
            container_name,
        )
        raise
    finally:
        await credential.close()
