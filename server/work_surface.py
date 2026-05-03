"""Persistence for the work-surface rectangle (subset of the projector image used as the mat)."""

from __future__ import annotations

import logging
import time
from pathlib import Path

from server.protocol import WorkSurface

log = logging.getLogger(__name__)


def default_for(proj_w: int, proj_h: int) -> WorkSurface:
    return WorkSurface(x=0, y=0, width=proj_w, height=proj_h, updated_at=time.time())


def clamp(ws: WorkSurface, proj_w: int, proj_h: int) -> WorkSurface:
    """Clamp a work surface so it stays inside the projector image (e.g. after a resize)."""
    x = max(0, min(ws.x, proj_w - 1))
    y = max(0, min(ws.y, proj_h - 1))
    w = max(1, min(ws.width, proj_w - x))
    h = max(1, min(ws.height, proj_h - y))
    if (x, y, w, h) == (ws.x, ws.y, ws.width, ws.height):
        return ws
    return WorkSurface(x=x, y=y, width=w, height=h, updated_at=ws.updated_at)


def load(path: Path) -> WorkSurface | None:
    if not path.exists():
        return None
    try:
        return WorkSurface.model_validate_json(path.read_text())
    except Exception as e:
        log.warning("could not load work surface from %s: %s", path, e)
        return None


def save(ws: WorkSurface, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(ws.model_dump_json(indent=2))
    log.info("work surface saved to %s", path)
