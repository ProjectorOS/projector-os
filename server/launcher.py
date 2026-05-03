"""Launches and tracks the Chromium kiosk window for the projector view."""

from __future__ import annotations

import logging
import os
import subprocess
import tempfile
from pathlib import Path

log = logging.getLogger(__name__)

CHROME_PATHS = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
]


def find_chrome() -> str | None:
    for p in CHROME_PATHS:
        if Path(p).exists() and os.access(p, os.X_OK):
            return p
    return None


class ProjectorLauncher:
    def __init__(self) -> None:
        self._process: subprocess.Popen | None = None
        self._user_data_dir: str | None = None

    def is_running(self) -> bool:
        return self._process is not None and self._process.poll() is None

    def launch(self, x: int, y: int, width: int, height: int, ui_url: str) -> None:
        chrome = find_chrome()
        if chrome is None:
            raise RuntimeError("Google Chrome / Chromium is not installed at a known path.")

        self.close()

        self._user_data_dir = tempfile.mkdtemp(prefix="projectoros-chrome-")
        cmd = [
            chrome,
            f"--user-data-dir={self._user_data_dir}",
            f"--app={ui_url}",
            f"--window-position={x},{y}",
            f"--window-size={width},{height}",
            "--kiosk",
            "--no-first-run",
            "--no-default-browser-check",
        ]
        log.info("launching projector kiosk: %s", " ".join(cmd))
        self._process = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def close(self) -> None:
        if self._process is not None and self._process.poll() is None:
            log.info("terminating projector kiosk pid=%d", self._process.pid)
            try:
                self._process.terminate()
                try:
                    self._process.wait(timeout=2.0)
                except subprocess.TimeoutExpired:
                    self._process.kill()
            except ProcessLookupError:
                pass
        self._process = None
