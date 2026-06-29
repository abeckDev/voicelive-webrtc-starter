import json
from pathlib import Path

_PROTOCOL_PATHS = (
    Path(__file__).parent / "protocols" / "lab_protocol.json",
    Path(__file__).parent / "protocols" / "incident_protocol.json",
)


def _load_protocols() -> list[dict]:
    loaded = []
    for path in _PROTOCOL_PATHS:
        with path.open("r", encoding="utf-8") as file:
            loaded.append(json.load(file))
    return loaded


_LOADED_PROTOCOLS = _load_protocols()


class ProtocolSelector:
    def __init__(self) -> None:
        self._protocols = list(_LOADED_PROTOCOLS)

    def get_available_protocols(self) -> list[dict]:
        return list(self._protocols)

    def select_protocol(self, protocol_id: str) -> dict:
        for protocol in self._protocols:
            if protocol.get("id") == protocol_id:
                return dict(protocol)
        raise ValueError(f"Unknown protocol id: {protocol_id}")
