"""User preferences persisted between restarts (camera + projector display choice)."""

from __future__ import annotations

import logging
from pathlib import Path

from pydantic import BaseModel

log = logging.getLogger(__name__)


class ProjectorDisplay(BaseModel):
    x: int
    y: int
    width: int
    height: int


class Preferences(BaseModel):
    camera_index: int | None = None
    projector_display: ProjectorDisplay | None = None
    show_work_surface_outline: bool = True


def load(path: Path) -> Preferences:
    if not path.exists():
        return Preferences()
    try:
        return Preferences.model_validate_json(path.read_text())
    except Exception as e:
        log.warning("could not load preferences from %s: %s", path, e)
        return Preferences()


def save(prefs: Preferences, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(prefs.model_dump_json(indent=2))
    log.info("preferences saved to %s", path)
