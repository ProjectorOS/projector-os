from __future__ import annotations

import asyncio
import logging
from typing import Iterable

from fastapi import WebSocket

from server.protocol import ServerEvent

log = logging.getLogger(__name__)


class Bus:
    """Fan-out of server events to all connected WebSocket clients."""

    def __init__(self) -> None:
        self._clients: set[WebSocket] = set()
        self._lock = asyncio.Lock()

    async def add(self, ws: WebSocket) -> None:
        async with self._lock:
            self._clients.add(ws)

    async def remove(self, ws: WebSocket) -> None:
        async with self._lock:
            self._clients.discard(ws)

    async def broadcast(self, event: ServerEvent) -> None:
        payload = event.model_dump(mode="json")
        async with self._lock:
            clients: Iterable[WebSocket] = list(self._clients)
        dead: list[WebSocket] = []
        for ws in clients:
            try:
                await ws.send_json(payload)
            except Exception as e:
                log.debug("send failed, dropping client: %s", e)
                dead.append(ws)
        if dead:
            async with self._lock:
                for ws in dead:
                    self._clients.discard(ws)
