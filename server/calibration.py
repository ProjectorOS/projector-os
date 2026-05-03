"""Camera ↔ projector ↔ mat calibration.

Coordinate spaces:
  - cam_px:    pixels in the camera frame
  - mat_mm:    millimeters on the physical mat surface (canonical world frame)
  - proj_px:   pixels in the projector window (= browser window in fullscreen)

Calibration flow:
  1. UI draws 4 ArUco markers (DICT_4X4_50, IDs 10..13) at 10% inset from each corner
     of the projector window and sends their proj_px positions.
  2. Camera detects those markers → cam_px corners.
  3. User measures the on-mat horizontal distance between TL and TR markers (one ruler
     measurement) and sends it. We assume the projection on the mat is approximately
     rectangular (projector ~perpendicular to mat). The vertical mm distance is then
     derived from the projector's pixel aspect ratio of the marker rectangle.
  4. We compute and persist:
       H_cam_to_mat   (cam_px → mat_mm)
       H_mat_to_proj  (mat_mm → proj_px)

  The "rectangular projection" assumption breaks under heavy keystoning. v1 documents
  this; v2 can ask the user for two measurements (horizontal + vertical) or all four.
"""

from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

from server.protocol import Calibration, CalibrationMarker, WorkSurface

log = logging.getLogger(__name__)

CALIBRATION_DICT = cv2.aruco.DICT_4X4_50
CALIBRATION_MARKER_IDS = [10, 11, 12, 13]  # TL, TR, BR, BL — distinct from object IDs (0..9)
CALIBRATION_INSET_FRAC = 0.10
CALIBRATION_MARKER_SIZE_PX = 200


@dataclass
class CalibrationCapture:
    """Result of detecting projected calibration markers in a camera frame."""

    cam_corners_by_id: dict[int, np.ndarray]  # marker_id → (4, 2) in camera pixels


def make_projection_layout(ws: WorkSurface) -> list[CalibrationMarker]:
    """Return where the 4 calibration markers should be drawn in projector pixels.

    Markers are inset 10% inside the *work surface* (not the full projector), so they
    land on the actual mat when the projection overshoots it.

    Order: TL=10, TR=11, BR=12, BL=13. Coordinates are the *center* of each marker.
    """
    inset_x = ws.width * CALIBRATION_INSET_FRAC
    inset_y = ws.height * CALIBRATION_INSET_FRAC
    left = ws.x + inset_x
    top = ws.y + inset_y
    right = ws.x + ws.width - inset_x
    bottom = ws.y + ws.height - inset_y
    return [
        CalibrationMarker(marker_id=10, proj_x=left, proj_y=top),
        CalibrationMarker(marker_id=11, proj_x=right, proj_y=top),
        CalibrationMarker(marker_id=12, proj_x=right, proj_y=bottom),
        CalibrationMarker(marker_id=13, proj_x=left, proj_y=bottom),
    ]


def detect_projected_markers(frame: np.ndarray) -> CalibrationCapture:
    aruco_dict = cv2.aruco.getPredefinedDictionary(CALIBRATION_DICT)
    detector = cv2.aruco.ArucoDetector(aruco_dict, cv2.aruco.DetectorParameters())
    corners, ids, _ = detector.detectMarkers(frame)

    out: dict[int, np.ndarray] = {}
    if ids is None:
        return CalibrationCapture(cam_corners_by_id=out)
    for marker_corners, marker_id in zip(corners, ids.flatten()):
        if int(marker_id) in CALIBRATION_MARKER_IDS:
            out[int(marker_id)] = marker_corners.reshape(4, 2)
    return CalibrationCapture(cam_corners_by_id=out)


def average_captures(captures: list[CalibrationCapture]) -> CalibrationCapture:
    """Average corner positions across multiple frames to denoise. All captures must have the same IDs."""
    if not captures:
        return CalibrationCapture(cam_corners_by_id={})
    common_ids = set(captures[0].cam_corners_by_id.keys())
    for c in captures[1:]:
        common_ids &= set(c.cam_corners_by_id.keys())
    averaged: dict[int, np.ndarray] = {}
    for mid in common_ids:
        stack = np.stack([c.cam_corners_by_id[mid] for c in captures], axis=0)
        averaged[mid] = stack.mean(axis=0)
    return CalibrationCapture(cam_corners_by_id=averaged)


def compute_calibration(
    capture: CalibrationCapture,
    layout: list[CalibrationMarker],
    proj_w: int,
    proj_h: int,
    horizontal_mm: float,
) -> Calibration:
    """Compute H_cam_to_mat and H_mat_to_proj from a marker capture and a single ruler measurement.

    Mat frame: TL marker at (0,0), TR marker on positive X axis. mat_mm is right-handed,
    Y points "down" toward BL (matches image conventions).

    The vertical mm distance is derived assuming the projection on the mat preserves the
    projector's aspect ratio for the calibration rectangle. This is exact when projector
    is perpendicular to mat; documented assumption.
    """
    layout_by_id = {m.marker_id: m for m in layout}

    for mid in CALIBRATION_MARKER_IDS:
        if mid not in capture.cam_corners_by_id:
            raise RuntimeError(
                f"Calibration marker {mid} was not detected in the camera frame. "
                "Check projector visibility, focus, and that the camera sees the full mat."
            )

    # Use marker centers (mean of 4 corners) as the calibration points.
    cam_centers = {mid: capture.cam_corners_by_id[mid].mean(axis=0) for mid in CALIBRATION_MARKER_IDS}
    proj_centers = {mid: np.array([layout_by_id[mid].proj_x, layout_by_id[mid].proj_y]) for mid in CALIBRATION_MARKER_IDS}

    # Derive vertical mm from projector geometry of the marker rectangle.
    horizontal_proj_px = float(np.linalg.norm(proj_centers[11] - proj_centers[10]))
    vertical_proj_px = float(np.linalg.norm(proj_centers[13] - proj_centers[10]))
    vertical_mm = horizontal_mm * (vertical_proj_px / horizontal_proj_px)

    mat_centers = {
        10: np.array([0.0, 0.0]),
        11: np.array([horizontal_mm, 0.0]),
        12: np.array([horizontal_mm, vertical_mm]),
        13: np.array([0.0, vertical_mm]),
    }

    cam_pts = np.array([cam_centers[mid] for mid in CALIBRATION_MARKER_IDS], dtype=np.float32)
    mat_pts = np.array([mat_centers[mid] for mid in CALIBRATION_MARKER_IDS], dtype=np.float32)
    proj_pts = np.array([proj_centers[mid] for mid in CALIBRATION_MARKER_IDS], dtype=np.float32)

    h_cam_to_mat, _ = cv2.findHomography(cam_pts, mat_pts, method=0)
    h_mat_to_proj, _ = cv2.findHomography(mat_pts, proj_pts, method=0)
    if h_cam_to_mat is None or h_mat_to_proj is None:
        raise RuntimeError("findHomography failed; check that the 4 markers are not collinear.")

    return Calibration(
        h_cam_to_mat=h_cam_to_mat.tolist(),
        h_mat_to_proj=h_mat_to_proj.tolist(),
        proj_width=proj_w,
        proj_height=proj_h,
        mat_width_mm=horizontal_mm,
        mat_height_mm=vertical_mm,
        created_at=time.time(),
    )


def save_calibration(calib: Calibration, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(calib.model_dump_json(indent=2))
    log.info("calibration saved to %s", path)


def load_calibration(path: Path) -> Calibration | None:
    if not path.exists():
        return None
    try:
        return Calibration.model_validate_json(path.read_text())
    except Exception as e:
        log.warning("failed to load calibration from %s: %s", path, e)
        return None


def cam_to_mat(calib: Calibration, points_cam: np.ndarray) -> np.ndarray:
    """Transform an (N, 2) array of camera-pixel points to mat-mm points."""
    h = np.array(calib.h_cam_to_mat, dtype=np.float64)
    pts = np.asarray(points_cam, dtype=np.float64).reshape(-1, 1, 2)
    out = cv2.perspectiveTransform(pts, h)
    return out.reshape(-1, 2)
