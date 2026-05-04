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

# Single source of truth for marker pixel sizing. Both the PNG generator and the layout
# math need this. The UI receives the total size in CalibrationPromptEvent so it
# doesn't have to duplicate the constant.
CALIBRATION_MARKER_INNER_PX = 200
CALIBRATION_MARKER_QUIET_ZONE_PX = 100
CALIBRATION_MARKER_TOTAL_PX = CALIBRATION_MARKER_INNER_PX + 2 * CALIBRATION_MARKER_QUIET_ZONE_PX

# Small extra gap between the marker's white edge and the work-surface boundary so the
# marker doesn't sit flush against the dashed outline.
CALIBRATION_EDGE_MARGIN_PX = 10


@dataclass
class CalibrationCapture:
    """Result of detecting projected calibration markers in a camera frame."""

    cam_corners_by_id: dict[int, np.ndarray]  # marker_id → (4, 2) in camera pixels
    rejected_count: int = 0  # quads detector found but couldn't decode (debug signal)


def make_projection_layout(ws: WorkSurface) -> list[CalibrationMarker]:
    """Return where the 4 calibration markers should be drawn in projector pixels.

    Markers are positioned so the *entire* marker image (200×200 ArUco + 50px white
    quiet zone on each side = 300×300) fits inside the work surface, with a small extra
    margin so it doesn't sit flush against the work-surface outline.

    For very small work surfaces (smaller than the markers themselves) the inset shrinks
    to whatever fits, and markers may overlap — calibration in that regime won't be
    accurate but at least won't crash.

    Order: TL=10, TR=11, BR=12, BL=13. Coordinates are the *center* of each marker.
    """
    half = CALIBRATION_MARKER_TOTAL_PX / 2
    inset = half + CALIBRATION_EDGE_MARGIN_PX
    if ws.width < 2 * inset:
        inset = max(0, ws.width / 2)
    if ws.height < 2 * inset:
        inset = min(inset, max(0, ws.height / 2))

    left = ws.x + inset
    top = ws.y + inset
    right = ws.x + ws.width - inset
    bottom = ws.y + ws.height - inset
    return [
        CalibrationMarker(marker_id=10, proj_x=left, proj_y=top),
        CalibrationMarker(marker_id=11, proj_x=right, proj_y=top),
        CalibrationMarker(marker_id=12, proj_x=right, proj_y=bottom),
        CalibrationMarker(marker_id=13, proj_x=left, proj_y=bottom),
    ]


def detect_projected_markers(frame: np.ndarray) -> CalibrationCapture:
    aruco_dict = cv2.aruco.getPredefinedDictionary(CALIBRATION_DICT)
    params = cv2.aruco.DetectorParameters()
    # Tuned for projector-rendered markers (soft edges from projection + camera blur):
    # - subpixel corner refinement gives sub-pixel accuracy on fuzzy edges
    # - lower perimeter floor accepts smaller markers in the camera frame
    # - looser polygon-approx accuracy tolerates non-perfectly-rectilinear projections
    params.cornerRefinementMethod = cv2.aruco.CORNER_REFINE_SUBPIX
    params.minMarkerPerimeterRate = 0.02
    params.polygonalApproxAccuracyRate = 0.05
    detector = cv2.aruco.ArucoDetector(aruco_dict, params)
    corners, ids, rejected = detector.detectMarkers(frame)

    out: dict[int, np.ndarray] = {}
    rejected_count = len(rejected) if rejected is not None else 0
    if ids is None:
        return CalibrationCapture(cam_corners_by_id=out, rejected_count=rejected_count)
    for marker_corners, marker_id in zip(corners, ids.flatten()):
        if int(marker_id) in CALIBRATION_MARKER_IDS:
            out[int(marker_id)] = marker_corners.reshape(4, 2)
    return CalibrationCapture(cam_corners_by_id=out, rejected_count=rejected_count)


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
    return CalibrationCapture(cam_corners_by_id=averaged, rejected_count=0)


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
