from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass

import cv2
import numpy as np

log = logging.getLogger(__name__)


@dataclass
class CameraConfig:
    index: int = 0
    width: int = 1920
    height: int = 1080
    fps: int = 30
    fourcc: str = "MJPG"


class Camera:
    """Threaded camera grabber. Always exposes the latest frame; old frames are dropped."""

    def __init__(self, cfg: CameraConfig | None = None) -> None:
        self.cfg = cfg or CameraConfig()
        self._cap: cv2.VideoCapture | None = None
        self._lock = threading.Lock()
        self._frame: np.ndarray | None = None
        self._frame_ts: float = 0.0
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def open(self) -> None:
        cap = cv2.VideoCapture(self.cfg.index)
        if not cap.isOpened():
            raise RuntimeError(f"Could not open camera at index {self.cfg.index}")

        fourcc = cv2.VideoWriter_fourcc(*self.cfg.fourcc)
        cap.set(cv2.CAP_PROP_FOURCC, fourcc)
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, self.cfg.width)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, self.cfg.height)
        cap.set(cv2.CAP_PROP_FPS, self.cfg.fps)

        actual_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        actual_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        actual_fps = cap.get(cv2.CAP_PROP_FPS)
        log.info("camera opened: %dx%d @ %.1f fps", actual_w, actual_h, actual_fps)

        self._cap = cap
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="camera-grabber", daemon=True)
        self._thread.start()

    def _loop(self) -> None:
        assert self._cap is not None
        while not self._stop.is_set():
            ok, frame = self._cap.read()
            if not ok:
                time.sleep(0.01)
                continue
            with self._lock:
                self._frame = frame
                self._frame_ts = time.time()

    def read_latest(self) -> tuple[np.ndarray, float] | None:
        with self._lock:
            if self._frame is None:
                return None
            return self._frame.copy(), self._frame_ts

    def close(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=1.0)
        if self._cap is not None:
            self._cap.release()
        self._cap = None
        self._thread = None
