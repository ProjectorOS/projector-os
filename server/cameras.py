"""Camera enumeration on macOS via system_profiler.

JXA's AVFoundation bridge is unreliable in recent macOS, so we shell out to
`system_profiler -json SPCameraDataType` to list cameras by name. The list order
matches OpenCV's `cv2.VideoCapture(index)` enumeration order in practice; if the
user picks a camera that fails to open we surface the error so they can pick another.
"""

from __future__ import annotations

import json
import logging
import subprocess
from dataclasses import dataclass

log = logging.getLogger(__name__)


@dataclass
class CameraInfo:
    index: int
    name: str
    unique_id: str

    def to_dict(self) -> dict:
        return {"index": self.index, "name": self.name, "unique_id": self.unique_id}


def list_cameras() -> list[CameraInfo]:
    try:
        res = subprocess.run(
            ["system_profiler", "-json", "SPCameraDataType"],
            capture_output=True,
            text=True,
            check=True,
            timeout=5,
        )
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError) as e:
        log.warning("camera enumeration failed: %s", e)
        return []

    try:
        data = json.loads(res.stdout)
    except json.JSONDecodeError as e:
        log.warning("could not parse system_profiler camera output: %s", e)
        return []

    items = data.get("SPCameraDataType", [])
    out: list[CameraInfo] = []
    for i, item in enumerate(items):
        out.append(
            CameraInfo(
                index=i,
                name=str(item.get("_name", f"Camera {i}")),
                unique_id=str(item.get("spcamera_unique-id", "")),
            )
        )
    return out
