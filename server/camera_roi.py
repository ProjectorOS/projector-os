"""Persistence for the manual camera-frame ROI polygon used to scope and
keystone-correct grid detection.

The current on-disk format is a `CameraRoi` model (4 cam-pixel corners,
TL/TR/BR/BL order). Older revisions persisted an axis-aligned rectangle
(`x/y/width/height`); `load()` migrates that legacy shape into a polygon
on first read so the user keeps their previously-set ROI.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

from server.protocol import CameraRoi

log = logging.getLogger(__name__)


def clamp(roi: CameraRoi, frame_w: int, frame_h: int) -> CameraRoi:
    """Clamp every corner of the polygon to stay inside the camera frame."""
    clamped = []
    changed = False
    for cx, cy in roi.corners:
        nx = max(0.0, min(float(cx), float(frame_w - 1)))
        ny = max(0.0, min(float(cy), float(frame_h - 1)))
        clamped.append([nx, ny])
        if nx != cx or ny != cy:
            changed = True
    if not changed:
        return roi
    return CameraRoi(corners=clamped, updated_at=roi.updated_at)


def load(path: Path) -> CameraRoi | None:
    if not path.exists():
        return None
    text = path.read_text()
    try:
        return CameraRoi.model_validate_json(text)
    except Exception:
        pass
    # Migrate legacy {x, y, width, height} rectangle → 4-corner polygon.
    try:
        data = json.loads(text)
        x = float(data["x"])
        y = float(data["y"])
        w = float(data["width"])
        h = float(data["height"])
        ts = float(data.get("updated_at", 0.0))
        migrated = CameraRoi(
            corners=[
                [x, y],
                [x + w, y],
                [x + w, y + h],
                [x, y + h],
            ],
            updated_at=ts,
        )
        save(migrated, path)
        log.info("migrated legacy rectangle camera ROI in %s to polygon", path)
        return migrated
    except Exception as e:  # noqa: BLE001
        log.warning("could not load or migrate camera ROI from %s: %s", path, e)
        return None


def save(roi: CameraRoi | None, path: Path) -> None:
    """Persist the polygon to disk, or delete the file when cleared."""
    if roi is None:
        if path.exists():
            path.unlink()
            log.info("camera ROI cleared (%s deleted)", path)
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(roi.model_dump_json(indent=2))
    log.info("camera ROI polygon saved to %s", path)
