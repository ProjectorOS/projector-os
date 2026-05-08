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
import math
import time
from dataclasses import dataclass, field
from pathlib import Path

import cv2
import numpy as np

from server.protocol import Calibration, CalibrationMarker, MatGridStatus, WorkSurface

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


# ---------------------------------------------------------------------------
# Cutting-mat grid detection (passive calibration)
# ---------------------------------------------------------------------------
#
# Detect a printed metric or imperial grid in the camera frame and use it as a
# scale reference, eliminating the need for the user's ruler measurement.
# Classification is by minor-line subdivisions per major cell:
#   - 10 (or 5) subdivisions  → metric  (1 cm major, major_pitch_mm = 10.0)
#   - 2/4/8/16 subdivisions   → imperial (1 inch major, major_pitch_mm = 25.4)
# Anything else aborts; the existing ArUco + ruler flow remains the fallback.

MAT_GRID_METRIC_MAJOR_MM = 10.0
MAT_GRID_IMPERIAL_MAJOR_MM = 25.4
MAT_GRID_METRIC_SUBDIVISIONS = {10, 5}  # 1 mm or 2 mm minor lines per cm
MAT_GRID_IMPERIAL_SUBDIVISIONS = {2, 4, 8, 16}  # ½, ¼, ⅛, ⅟₁₆ inch
MAT_GRID_MIN_LINES_PER_AXIS = 4
MAT_GRID_PITCH_CV_MAX = 0.10  # max coefficient-of-variation on major-line spacing
MAT_GRID_AXIS_TOLERANCE_RAD = math.radians(5.0)  # grid axis vs ArUco TL→TR
# Half-window for classifying a strong line as belonging to an axis vs being a
# diagonal. Wider than the ArUco-alignment tolerance because real-world camera
# distortion + mat skew can rotate individual grid lines several degrees off
# the global axis even when the axis itself is well-defined.
MAT_GRID_LINE_AXIS_TOLERANCE_RAD = math.radians(10.0)
MAT_GRID_SNAP_TOLERANCE_MM = 1.0
MAT_GRID_CONFIDENCE_MIN = 0.7


def _empty_segments() -> np.ndarray:
    """An (N=0, 4) array — same shape Hough returns for line endpoints."""
    return np.zeros((0, 4), dtype=np.float64)


@dataclass
class GridPreprocessing:
    """Output of `preprocess_for_grid_detection` — the intermediate images
    the detector sees, exposed for the processed-frame preview."""

    gray_full: np.ndarray  # (H, W) uint8, green-suppressed grayscale of the whole frame
    clahe_roi: np.ndarray  # (h, w) uint8, CLAHE'd ROI used for edge detection
    edges_roi: np.ndarray  # (h, w) uint8, Canny edge map of the ROI
    roi_origin: np.ndarray  # (2,) float64, top-left of the ROI in cam_px
    # Set by the keystone-correction path (`_run_grid_detection_with_keystone`)
    # when the detector ran on a warped image instead of the original frame.
    # Maps cam_px → preview_px so the debug overlay can forward-project lines
    # and intersections (which are stored in original cam_px on the wire) onto
    # the warped preview canvas. None means the preview canvas IS in cam_px
    # — no transform needed.
    h_cam_to_preview: np.ndarray | None = None


def preprocess_for_grid_detection(
    frame: np.ndarray, roi_quad_cam: np.ndarray | None = None
) -> GridPreprocessing | None:
    """Run the same preprocessing chain `detect_mat_grid` uses: green-
    suppressing grayscale → optional ROI crop → CLAHE → Gaussian blur →
    Canny. Returns `None` when the ROI quad is too small to crop, mirroring
    the detector's early-out so the caller can skip visualization in lockstep.

    The crop is the *exact* bounding box of `roi_quad_cam` — when the user
    selects a manual camera ROI we honor it edge-to-edge instead of
    shrinking it. ArUco/dot markers don't produce strong-Hough-class lines
    at typical camera resolutions, so leaving them in the ROI is fine.
    """
    # Color cutting mats (typically dark green or dark blue) are low-contrast
    # in standard luminance grayscale: cvtColor BGR→GRAY weights green ~60 %,
    # which makes a green mat *brighter* than the printed gray lines and
    # collapses the line/background contrast. Using (R + B) / 2 instead
    # suppresses the dominant-color background on green and blue mats while
    # keeping achromatic gray lines bright. For non-color mats this is just a
    # different luminance estimator with similar behavior.
    if frame.ndim == 3:
        b, _g, r = cv2.split(frame)
        gray = ((b.astype(np.uint16) + r.astype(np.uint16)) // 2).astype(np.uint8)
    else:
        gray = frame.copy()

    if roi_quad_cam is not None and roi_quad_cam.shape == (4, 2):
        x0 = float(np.min(roi_quad_cam[:, 0]))
        x1 = float(np.max(roi_quad_cam[:, 0]))
        y0 = float(np.min(roi_quad_cam[:, 1]))
        y1 = float(np.max(roi_quad_cam[:, 1]))
        x0i = int(max(0, math.floor(x0)))
        y0i = int(max(0, math.floor(y0)))
        x1i = int(min(gray.shape[1], math.ceil(x1)))
        y1i = int(min(gray.shape[0], math.ceil(y1)))
        if x1i - x0i < 50 or y1i - y0i < 50:
            return None
        roi = gray[y0i:y1i, x0i:x1i].copy()
        roi_origin = np.array([x0i, y0i], dtype=np.float64)
    else:
        roi = gray.copy()
        roi_origin = np.array([0.0, 0.0], dtype=np.float64)

    # CLAHE locally equalizes contrast inside the work-surface ROI so the
    # subtle gray-on-green grid lines produce strong-enough Canny edges to
    # pass the strict Hough threshold. clipLimit=3 / 8×8 tiles is a standard
    # recipe — aggressive enough to recover faint majors, conservative
    # enough not to amplify camera noise into spurious edges.
    clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))
    clahe_roi = clahe.apply(roi)

    blurred = cv2.GaussianBlur(clahe_roi, (3, 3), 0)
    median = float(np.median(blurred))
    lower = int(max(0, 0.66 * median))
    upper = int(min(255, 1.33 * median))
    if upper <= lower:
        upper = lower + 1
    edges = cv2.Canny(blurred, lower, upper)

    return GridPreprocessing(
        gray_full=gray,
        clahe_roi=clahe_roi,
        edges_roi=edges,
        roi_origin=roi_origin,
    )


@dataclass
class MatGridCapture:
    """Result of detecting a cutting-mat grid in one camera frame.

    `intersections_cam` is the (N, 2) array of major-line intersection points in
    camera pixels, used as correspondences for the refined homography fit.

    The `*_lines_cam` fields are diagnostic snapshots from the pipeline: every
    early-return path populates whatever it computed before bailing, so the UI
    can render an "explain what the detector saw" overlay regardless of whether
    classification ultimately succeeded. Each entry is a 4-tuple
    `[x1, y1, x2, y2]` line segment in camera pixels.
    """

    detected: bool
    intersections_cam: np.ndarray  # (N, 2)
    pitch_cam_px_x: float
    pitch_cam_px_y: float
    axis_x_angle_rad: float
    axis_y_angle_rad: float
    subdivisions_per_major: int
    grid_system: str  # "metric" or "imperial" (empty when not detected)
    major_pitch_mm: float
    confidence: float
    reason: str | None = None
    # Diagnostic line sets in cam-pixel coordinates. weak ⊇ strong;
    # axis_a_lines_cam ∪ axis_b_lines_cam ∪ diagonal_lines_cam ⊆ strong_lines_cam.
    # `diagonal_lines_cam` is the set of strong lines that *aren't* aligned
    # with either grid axis — typically the 30° / 45° / 60° angle guides
    # printed on most cutting mats. The detector explicitly rejects them
    # for axis selection, but they're useful to surface visually so the
    # user can see "we did see those lines, we just didn't use them".
    weak_lines_cam: np.ndarray = field(default_factory=_empty_segments)
    strong_lines_cam: np.ndarray = field(default_factory=_empty_segments)
    axis_a_lines_cam: np.ndarray = field(default_factory=_empty_segments)
    axis_b_lines_cam: np.ndarray = field(default_factory=_empty_segments)
    diagonal_lines_cam: np.ndarray = field(default_factory=_empty_segments)
    # Intermediate preprocessing images (green-suppressed gray, CLAHE'd ROI,
    # Canny edges) so the processed-frame preview can show what the detector
    # actually consumed. Not serialized over the wire.
    preprocessing: "GridPreprocessing | None" = None

    @classmethod
    def failure(cls, reason: str) -> "MatGridCapture":
        return cls(
            detected=False,
            intersections_cam=np.zeros((0, 2), dtype=np.float64),
            pitch_cam_px_x=0.0,
            pitch_cam_px_y=0.0,
            axis_x_angle_rad=0.0,
            axis_y_angle_rad=0.0,
            subdivisions_per_major=0,
            grid_system="",
            major_pitch_mm=0.0,
            confidence=0.0,
            reason=reason,
        )


def grid_capture_to_status(capture: MatGridCapture) -> MatGridStatus:
    """Project the internal capture (with intersection arrays) onto the
    wire-friendly status payload sent in CalibrationCapturedEvent."""
    if capture.detected:
        return MatGridStatus(
            detected=True,
            grid_system=capture.grid_system,  # type: ignore[arg-type]
            major_pitch_mm=capture.major_pitch_mm,
            subdivisions_per_major=capture.subdivisions_per_major,
            pitch_cam_px_x=capture.pitch_cam_px_x,
            pitch_cam_px_y=capture.pitch_cam_px_y,
            intersection_count=int(capture.intersections_cam.shape[0]),
            confidence=capture.confidence,
            reason=None,
        )
    return MatGridStatus(
        detected=False,
        grid_system=None,
        major_pitch_mm=None,
        subdivisions_per_major=None,
        pitch_cam_px_x=None,
        pitch_cam_px_y=None,
        intersection_count=0,
        confidence=0.0,
        reason=capture.reason,
    )


def _line_angle(line: np.ndarray) -> float:
    """Orientation of a line segment in [0, π). Lines are unoriented (segments
    going (a,b)→(c,d) and (c,d)→(a,b) have the same angle)."""
    x1, y1, x2, y2 = float(line[0]), float(line[1]), float(line[2]), float(line[3])
    a = math.atan2(y2 - y1, x2 - x1)
    if a < 0:
        a += math.pi
    return a


def _line_normal_distance(line: np.ndarray, axis_angle_rad: float) -> float:
    """Signed distance from origin to the line's midpoint, projected along the
    axis-perpendicular direction. Sorting parallel lines by this value orders
    them across the grid."""
    nx = -math.sin(axis_angle_rad)
    ny = math.cos(axis_angle_rad)
    x1, y1, x2, y2 = float(line[0]), float(line[1]), float(line[2]), float(line[3])
    mx = 0.5 * (x1 + x2)
    my = 0.5 * (y1 + y2)
    return mx * nx + my * ny


def _angle_diff_rad(a: float, b: float) -> float:
    """Smallest unsigned difference between two unoriented angles (mod π)."""
    d = abs(a - b) % math.pi
    if d > math.pi / 2:
        d = math.pi - d
    return d


def _modal_pitch(values: list[float]) -> tuple[float, float]:
    """Median pitch + coefficient of variation from a list of perpendicular
    distances. Filters out tiny deltas (sub-pixel duplicates of the same
    detected line). Returns (0, 1) when there's nothing usable."""
    if len(values) < 2:
        return 0.0, 1.0
    arr = np.sort(np.asarray(values, dtype=np.float64))
    deltas = np.diff(arr)
    if deltas.size == 0:
        return 0.0, 1.0
    med = float(np.median(deltas))
    if med <= 0:
        return 0.0, 1.0
    keep = deltas[deltas > 0.5 * med]
    if keep.size == 0:
        return 0.0, 1.0
    pitch = float(np.median(keep))
    cv = float(np.std(keep) / pitch) if pitch > 0 else 1.0
    return pitch, cv


def _detect_grid_axes(strong_lines: np.ndarray) -> tuple[float, float] | None:
    """Find two perpendicular dominant orientations from the strong-line set.

    Cutting mats often print diagonal angle guides (30°, 45°, 60°) alongside
    the main grid. Picking the global histogram max as the primary axis can
    therefore land on a diagonal when the grid axes themselves have similar
    or fewer line votes. We instead pick the *perpendicular pair* with the
    highest combined support: the grid produces many parallel lines on both
    of two perpendicular axes, while diagonal angle guides typically appear
    as a few lines without a strong perpendicular partner. This naturally
    skips the diagonals in favor of the actual grid.
    """
    if strong_lines is None or len(strong_lines) < 2 * MAT_GRID_MIN_LINES_PER_AXIS:
        return None
    angles = np.array([_line_angle(l) for l in strong_lines], dtype=np.float64)
    nbins = 90  # 2° bins
    hist, _ = np.histogram(angles, bins=nbins, range=(0.0, math.pi))
    kernel = np.array([1, 2, 4, 2, 1], dtype=np.float64)
    kernel /= kernel.sum()
    hist_s = np.convolve(hist.astype(np.float64), kernel, mode="same")
    if hist_s.max() < MAT_GRID_MIN_LINES_PER_AXIS:
        return None

    band = max(1, nbins // 18)  # ±5° tolerance around the perpendicular bin
    perp_offset = nbins // 2  # nbins=90 covers 0..π so perp = +π/2 = +45 bins
    best_score = -1.0
    best_pair: tuple[int, int] | None = None
    for i in range(nbins):
        if hist_s[i] < MAT_GRID_MIN_LINES_PER_AXIS:
            continue
        # Find the strongest bin within ±band of the perpendicular direction.
        j_center = (i + perp_offset) % nbins
        best_j = j_center
        best_j_score = -1.0
        for dj in range(-band, band + 1):
            j = (j_center + dj) % nbins
            if hist_s[j] > best_j_score:
                best_j_score = hist_s[j]
                best_j = j
        if best_j_score < MAT_GRID_MIN_LINES_PER_AXIS:
            continue
        score = float(hist_s[i] + best_j_score)
        if score > best_score:
            best_score = score
            best_pair = (i, best_j)
    if best_pair is None:
        return None
    idx_a, idx_b = best_pair
    # Convention: axis A is the orientation with more line support.
    if hist_s[idx_a] < hist_s[idx_b]:
        idx_a, idx_b = idx_b, idx_a
    angle_a = (idx_a + 0.5) * (math.pi / nbins)
    angle_b = (idx_b + 0.5) * (math.pi / nbins)
    return angle_a, angle_b


def _lines_for_axis(
    lines: np.ndarray, axis_angle_rad: float, tolerance_rad: float
) -> np.ndarray:
    if lines is None or len(lines) == 0:
        return np.zeros((0, 4), dtype=np.float64)
    out: list[np.ndarray] = []
    for l in lines:
        if _angle_diff_rad(_line_angle(l), axis_angle_rad) <= tolerance_rad:
            out.append(l)
    if not out:
        return np.zeros((0, 4), dtype=np.float64)
    return np.array(out, dtype=np.float64)


def _lines_off_axes(
    lines: np.ndarray,
    angle_a: float,
    angle_b: float,
    tolerance_rad: float,
) -> np.ndarray:
    """Return strong lines that align with *neither* grid axis. These are the
    cutting-mat angle guides (typically 30°, 45°, 60°) we want to show in the
    diagnostic overlay but exclude from axis selection / pitch detection."""
    if lines is None or len(lines) == 0:
        return np.zeros((0, 4), dtype=np.float64)
    out: list[np.ndarray] = []
    for l in lines:
        ang = _line_angle(l)
        if (
            _angle_diff_rad(ang, angle_a) > tolerance_rad
            and _angle_diff_rad(ang, angle_b) > tolerance_rad
        ):
            out.append(l)
    if not out:
        return np.zeros((0, 4), dtype=np.float64)
    return np.array(out, dtype=np.float64)


def _line_intersection(
    line_a: np.ndarray, line_b: np.ndarray
) -> tuple[float, float] | None:
    """Intersect two lines given by endpoints; returns None if (near-)parallel."""
    x1, y1, x2, y2 = (
        float(line_a[0]),
        float(line_a[1]),
        float(line_a[2]),
        float(line_a[3]),
    )
    x3, y3, x4, y4 = (
        float(line_b[0]),
        float(line_b[1]),
        float(line_b[2]),
        float(line_b[3]),
    )
    denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4)
    if abs(denom) < 1e-9:
        return None
    t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom
    px = x1 + t * (x2 - x1)
    py = y1 + t * (y2 - y1)
    return (float(px), float(py))


def _count_subdivisions(
    major_d: np.ndarray, all_d: np.ndarray, tolerance: float
) -> int:
    """Count minor-line subdivisions per major cell along one axis.

    For each pair of adjacent major lines, count the unique line positions
    strictly between them (deduped by `tolerance`) and add 1 — that's the
    number of subdivisions in the cell. Take the mode across all cells so a
    stray missed/spurious minor line doesn't corrupt the result.
    """
    if major_d.size < 2 or all_d.size < 2:
        return 1
    major_sorted = np.sort(major_d)
    all_sorted = np.sort(all_d)
    counts: list[int] = []
    for i in range(major_sorted.size - 1):
        a = major_sorted[i]
        b = major_sorted[i + 1]
        mask = (all_sorted > a + tolerance) & (all_sorted < b - tolerance)
        between = all_sorted[mask]
        if between.size == 0:
            counts.append(1)
            continue
        deduped = [float(between[0])]
        for v in between[1:]:
            if float(v) - deduped[-1] > tolerance:
                deduped.append(float(v))
        counts.append(len(deduped) + 1)
    if not counts:
        return 1
    arr = np.array(counts)
    vals, cnts = np.unique(arr, return_counts=True)
    return int(vals[int(np.argmax(cnts))])


def _classify_grid_system(n_x: int, n_y: int) -> tuple[str, float, int] | None:
    """Map per-axis subdivision counts to (grid_system, major_pitch_mm, n).

    Both axes must agree on N — disagreement means we likely picked up two
    different patterns (e.g., a ruler edge vs the mat grid).
    """
    if n_x != n_y:
        return None
    n = n_x
    if n in MAT_GRID_METRIC_SUBDIVISIONS:
        return ("metric", MAT_GRID_METRIC_MAJOR_MM, n)
    if n in MAT_GRID_IMPERIAL_SUBDIVISIONS:
        return ("imperial", MAT_GRID_IMPERIAL_MAJOR_MM, n)
    return None


def detect_mat_grid(
    frame: np.ndarray, roi_quad_cam: np.ndarray | None = None
) -> MatGridCapture:
    """Detect a printed cutting-mat grid in the camera frame.

    `roi_quad_cam` (optional, shape (4, 2)): four cam_px points in TL/TR/BR/BL
    order delimiting the work surface — typically the 4 ArUco marker centers
    (ArUco method) or the 4 projected dot centers (grid-only method). When
    supplied:
      - the search is restricted to the bounding box of the quad
      - the dominant grid axis is sanity-checked against the TL→TR direction
        (catches mis-detection of wood grain, tile, paper rules, etc.)

    Returns a `MatGridCapture` with `detected=False` and a `reason` string on
    any failure path — every caller should silently fall back to the existing
    ArUco + ruler flow when this happens.
    """
    if frame is None or frame.size == 0:
        return MatGridCapture.failure("empty frame")

    pre = preprocess_for_grid_detection(frame, roi_quad_cam)
    if pre is None:
        cap = MatGridCapture.failure("work-surface quad too small to crop")
        return cap
    roi, edges, roi_origin = pre.clahe_roi, pre.edges_roi, pre.roi_origin

    h, w = roi.shape[:2]
    min_dim = min(h, w)
    if min_dim < 50:
        return MatGridCapture.failure("ROI too small for line detection")

    # Two thresholds: strong = major lines (bold cm/inch), weak = all lines.
    strong_segments = cv2.HoughLinesP(
        edges,
        rho=1,
        theta=np.pi / 360.0,
        threshold=int(min_dim * 0.4),
        minLineLength=int(min_dim * 0.4),
        maxLineGap=int(min_dim * 0.05),
    )
    weak_segments = cv2.HoughLinesP(
        edges,
        rho=1,
        theta=np.pi / 360.0,
        threshold=int(min_dim * 0.15),
        minLineLength=int(min_dim * 0.1),
        maxLineGap=int(min_dim * 0.05),
    )
    # Hough returns None when *no* lines were found in that pass; we coerce to
    # an empty (0, 4) array so the diagnostic surface always has the same
    # shape and the UI can read "weak: N, strong: N" from the response even
    # when one or both passes found nothing.
    strong = (
        strong_segments.reshape(-1, 4).astype(np.float64)
        if strong_segments is not None
        else np.zeros((0, 4), dtype=np.float64)
    )
    weak = (
        weak_segments.reshape(-1, 4).astype(np.float64)
        if weak_segments is not None
        else np.zeros((0, 4), dtype=np.float64)
    )
    # Translate ROI coordinates back to full-frame coordinates.
    if strong.shape[0]:
        strong[:, [0, 2]] += roi_origin[0]
        strong[:, [1, 3]] += roi_origin[1]
    if weak.shape[0]:
        weak[:, [0, 2]] += roi_origin[0]
        weak[:, [1, 3]] += roi_origin[1]

    # `out` is built incrementally so any early-return preserves the partial
    # diagnostic state (which lines did we see, did we find axes, etc.) for
    # the camera-preview overlay. Each pipeline step writes to it just before
    # the corresponding gate.
    out = MatGridCapture.failure("unknown")
    out.preprocessing = pre
    out.weak_lines_cam = weak
    out.strong_lines_cam = strong

    if strong.shape[0] == 0 and weak.shape[0] == 0:
        out.reason = "not enough lines detected"
        return out

    axes = _detect_grid_axes(strong)
    if axes is None:
        out.reason = "grid axes not separable"
        return out
    angle_a, angle_b = axes
    out.axis_x_angle_rad = angle_a
    out.axis_y_angle_rad = angle_b

    strong_a = _lines_for_axis(strong, angle_a, tolerance_rad=MAT_GRID_LINE_AXIS_TOLERANCE_RAD)
    strong_b = _lines_for_axis(strong, angle_b, tolerance_rad=MAT_GRID_LINE_AXIS_TOLERANCE_RAD)
    weak_a = _lines_for_axis(weak, angle_a, tolerance_rad=MAT_GRID_LINE_AXIS_TOLERANCE_RAD)
    weak_b = _lines_for_axis(weak, angle_b, tolerance_rad=MAT_GRID_LINE_AXIS_TOLERANCE_RAD)
    out.axis_a_lines_cam = strong_a
    out.axis_b_lines_cam = strong_b
    out.diagonal_lines_cam = _lines_off_axes(
        strong, angle_a, angle_b, tolerance_rad=MAT_GRID_LINE_AXIS_TOLERANCE_RAD
    )

    if (
        len(strong_a) < MAT_GRID_MIN_LINES_PER_AXIS
        or len(strong_b) < MAT_GRID_MIN_LINES_PER_AXIS
    ):
        out.reason = "too few major lines"
        return out

    d_strong_a = np.array([_line_normal_distance(l, angle_a) for l in strong_a])
    d_strong_b = np.array([_line_normal_distance(l, angle_b) for l in strong_b])
    d_weak_a = np.array([_line_normal_distance(l, angle_a) for l in weak_a])
    d_weak_b = np.array([_line_normal_distance(l, angle_b) for l in weak_b])

    pitch_a, cv_a = _modal_pitch(d_strong_a.tolist())
    pitch_b, cv_b = _modal_pitch(d_strong_b.tolist())
    if pitch_a <= 0 or pitch_b <= 0:
        out.reason = "major-line pitch undetermined"
        return out
    if cv_a > MAT_GRID_PITCH_CV_MAX or cv_b > MAT_GRID_PITCH_CV_MAX:
        out.reason = "major-line pitch too irregular"
        return out
    out.pitch_cam_px_x = pitch_a
    out.pitch_cam_px_y = pitch_b

    # Tolerance for "is this minor line the same as that major line" = 25 % of
    # the major pitch. Within that band we treat a weak detection as a duplicate
    # of the strong line at that location.
    n_x = _count_subdivisions(d_strong_a, d_weak_a, tolerance=0.25 * pitch_a)
    n_y = _count_subdivisions(d_strong_b, d_weak_b, tolerance=0.25 * pitch_b)
    classification = _classify_grid_system(n_x, n_y)
    if classification is None:
        out.reason = (
            f"subdivision count ({n_x}, {n_y}) is neither metric nor imperial"
        )
        return out
    grid_system, major_pitch_mm, subdivisions = classification

    # Sanity check: at least one detected axis must align with TL→TR. Swap if
    # axis B is the closer match — we want axis A to be the mat's X axis.
    if roi_quad_cam is not None:
        tl, tr = roi_quad_cam[0], roi_quad_cam[1]
        ref_x_angle = math.atan2(float(tr[1] - tl[1]), float(tr[0] - tl[0]))
        if ref_x_angle < 0:
            ref_x_angle += math.pi
        diff_a = _angle_diff_rad(angle_a, ref_x_angle)
        diff_b = _angle_diff_rad(angle_b, ref_x_angle)
        if (
            diff_a > MAT_GRID_AXIS_TOLERANCE_RAD
            and diff_b > MAT_GRID_AXIS_TOLERANCE_RAD
        ):
            out.reason = "grid axes not aligned with work-surface quad"
            return out
        if diff_b < diff_a:
            angle_a, angle_b = angle_b, angle_a
            strong_a, strong_b = strong_b, strong_a
            pitch_a, pitch_b = pitch_b, pitch_a
            out.axis_x_angle_rad = angle_a
            out.axis_y_angle_rad = angle_b
            out.axis_a_lines_cam = strong_a
            out.axis_b_lines_cam = strong_b
            out.pitch_cam_px_x = pitch_a
            out.pitch_cam_px_y = pitch_b

    # Compute intersections of major lines (axis-A × axis-B) and keep only
    # those inside the work-surface quad's bounding box.
    if roi_quad_cam is not None:
        x0_b = float(np.min(roi_quad_cam[:, 0]))
        x1_b = float(np.max(roi_quad_cam[:, 0]))
        y0_b = float(np.min(roi_quad_cam[:, 1]))
        y1_b = float(np.max(roi_quad_cam[:, 1]))
    else:
        x0_b, y0_b = 0.0, 0.0
        x1_b, y1_b = float(frame.shape[1]), float(frame.shape[0])
    intersections: list[tuple[float, float]] = []
    for la in strong_a:
        for lb in strong_b:
            p = _line_intersection(la, lb)
            if p is None:
                continue
            px, py = p
            if x0_b <= px <= x1_b and y0_b <= py <= y1_b:
                intersections.append((px, py))
    out.intersections_cam = np.array(intersections, dtype=np.float64).reshape(-1, 2)
    if len(intersections) < 4:
        out.reason = "too few major-line intersections"
        return out

    # Confidence: combine line counts (more = better), pitch CVs (lower =
    # better), and the strict (n_x == n_y) check that we already passed.
    line_score = min(1.0, (len(strong_a) + len(strong_b)) / 16.0)
    pitch_score = max(0.0, 1.0 - max(cv_a, cv_b) / MAT_GRID_PITCH_CV_MAX)
    subdivision_score = 1.0
    confidence = float(0.5 * line_score + 0.3 * pitch_score + 0.2 * subdivision_score)

    out.detected = True
    out.subdivisions_per_major = subdivisions
    out.grid_system = grid_system
    out.major_pitch_mm = major_pitch_mm
    out.confidence = confidence
    out.reason = None
    return out


# ---------------------------------------------------------------------------
# Calibration-dot detection (used by the grid-only calibration method)
# ---------------------------------------------------------------------------
#
# In grid-only mode the projector draws 4 plain solid white dots at the work-
# surface corners. The camera finds them as the 4 brightest, roughly-circular
# blobs in the frame. Unlike ArUco, the dots carry no embedded identity — we
# disambiguate TL/TR/BR/BL purely by their 2-D positions in the camera frame.

CALIBRATION_DOT_BRIGHTNESS_THRESHOLD = 200  # 0..255; very bright pixels only
CALIBRATION_DOT_MIN_AREA_PX = 50
CALIBRATION_DOT_MAX_AREA_PX = 50000
CALIBRATION_DOT_MIN_FILL = 0.4  # area / bbox-area; rejects elongated streaks
CALIBRATION_DOT_MAX_ASPECT = 2.0


def detect_calibration_dots(frame: np.ndarray) -> tuple[list[np.ndarray], int]:
    """Locate up to 4 bright dots in the camera frame.

    Returns `(sorted_dots, candidate_count)`:
      - `candidate_count` is the number of bright-blob candidates found, useful
        for progress UI ("2/4 dots visible") even before all 4 are present.
      - `sorted_dots` is a 4-element list of `(x, y)` cam_px centers in
        TL/TR/BR/BL order **only when exactly 4 candidates are present**;
        otherwise it's empty (we can't tell which corner is missing from a
        partial set without a prior projector→camera mapping).

    The detector assumes the projector dots are the brightest things in the
    scene — true on a dark mat under typical room lighting. On overlit
    workspaces this will pick up other bright objects; that's a documented
    limitation, dim the room or close the blinds.
    """
    if frame is None or frame.size == 0:
        return ([], 0)
    if frame.ndim == 3:
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    else:
        gray = frame
    _, binary = cv2.threshold(
        gray, CALIBRATION_DOT_BRIGHTNESS_THRESHOLD, 255, cv2.THRESH_BINARY
    )
    # Close small gaps so the detector doesn't fragment a single dot into
    # multiple components (cheap glare / sub-pixel halo cleanup).
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel)

    num_labels, _labels, stats, centroids = cv2.connectedComponentsWithStats(
        binary, connectivity=8
    )
    candidates: list[tuple[int, float, float]] = []  # (area, cx, cy)
    for i in range(1, num_labels):  # 0 = background
        x, y, w, h, area = (
            int(stats[i, cv2.CC_STAT_LEFT]),
            int(stats[i, cv2.CC_STAT_TOP]),
            int(stats[i, cv2.CC_STAT_WIDTH]),
            int(stats[i, cv2.CC_STAT_HEIGHT]),
            int(stats[i, cv2.CC_STAT_AREA]),
        )
        if area < CALIBRATION_DOT_MIN_AREA_PX or area > CALIBRATION_DOT_MAX_AREA_PX:
            continue
        if max(w, h) / max(1, min(w, h)) > CALIBRATION_DOT_MAX_ASPECT:
            continue
        if area / max(1, w * h) < CALIBRATION_DOT_MIN_FILL:
            continue
        cx, cy = float(centroids[i, 0]), float(centroids[i, 1])
        candidates.append((area, cx, cy))

    candidates.sort(key=lambda c: -c[0])  # largest first
    top = candidates[:4]
    count = len(top)
    if count != 4:
        return ([], count)

    # Assign TL/TR/BR/BL by position. Sort by Y first (top half vs bottom
    # half), then by X within each half. This works reliably as long as the
    # camera is roughly upright relative to the projection — same assumption
    # the existing ArUco layout makes.
    pts = [(cx, cy) for _, cx, cy in top]
    pts.sort(key=lambda p: p[1])
    top_two = sorted(pts[:2], key=lambda p: p[0])    # TL, TR
    bottom_two = sorted(pts[2:], key=lambda p: p[0]) # BL, BR
    sorted_dots = [
        np.array(top_two[0], dtype=np.float64),     # TL
        np.array(top_two[1], dtype=np.float64),     # TR
        np.array(bottom_two[1], dtype=np.float64),  # BR
        np.array(bottom_two[0], dtype=np.float64),  # BL
    ]
    return (sorted_dots, count)


def compute_grid_homography(grid_capture: MatGridCapture) -> np.ndarray | None:
    """Compute H_cam_to_mat from grid detection alone — no projector dots
    required. Mat-mm origin is arbitrary (one of the detected intersections);
    callers that need a fixed origin (e.g. TL anchor) compose a translation.

    Used by both the full grid-only calibration flow and the rectified-frame
    preview (which warps the camera image into mat space so the user can see
    the grid drawn straight, with camera keystone removed).
    """
    if not grid_capture.detected:
        return None
    if grid_capture.intersections_cam.shape[0] < 4:
        return None
    pitch_mm = grid_capture.major_pitch_mm
    origin_cam = grid_capture.intersections_cam[0].astype(np.float64)
    ux = np.array(
        [
            math.cos(grid_capture.axis_x_angle_rad) * grid_capture.pitch_cam_px_x,
            math.sin(grid_capture.axis_x_angle_rad) * grid_capture.pitch_cam_px_x,
        ],
        dtype=np.float64,
    )
    uy = np.array(
        [
            math.cos(grid_capture.axis_y_angle_rad) * grid_capture.pitch_cam_px_y,
            math.sin(grid_capture.axis_y_angle_rad) * grid_capture.pitch_cam_px_y,
        ],
        dtype=np.float64,
    )
    cam_basis = np.column_stack([ux, uy])
    try:
        cam_basis_inv = np.linalg.inv(cam_basis)
    except np.linalg.LinAlgError:
        return None
    A = cam_basis_inv * pitch_mm
    t = -A @ origin_cam
    h_coarse = np.array(
        [[A[0, 0], A[0, 1], t[0]],
         [A[1, 0], A[1, 1], t[1]],
         [0.0,     0.0,     1.0]],
        dtype=np.float64,
    )
    inter_cam = grid_capture.intersections_cam.astype(np.float64).reshape(-1, 1, 2)
    inter_mat = cv2.perspectiveTransform(inter_cam, h_coarse).reshape(-1, 2)
    snapped = np.round(inter_mat / pitch_mm) * pitch_mm
    residuals = np.linalg.norm(inter_mat - snapped, axis=1)
    keep = residuals <= MAT_GRID_SNAP_TOLERANCE_MM
    if int(keep.sum()) < 8:
        return None
    cam_kept = grid_capture.intersections_cam[keep].astype(np.float32)
    mat_kept = snapped[keep].astype(np.float32)
    h_cam_to_mat, _ = cv2.findHomography(
        cam_kept, mat_kept, method=cv2.RANSAC, ransacReprojThreshold=1.0
    )
    return h_cam_to_mat


def compute_grid_only_calibration(
    dots_cam: list[np.ndarray],
    grid_capture: MatGridCapture,
    layout: list[CalibrationMarker],
    proj_w: int,
    proj_h: int,
) -> Calibration:
    """Compute calibration from 4 projected dots + a detected cutting-mat grid.

    No ArUco markers are used. The grid alone provides camera↔mat (axes +
    scale via grid pitch); the 4 dots provide projector↔mat (transform their
    cam_px positions to mat_mm via H_cam_to_mat, then fit H_mat_to_proj from
    the 4 known proj_px positions in the layout).

    Mat-frame convention matches the ArUco path: TL dot at (0, 0), TR on the
    positive X axis. Final mat_mm origin is anchored at the TL dot via a
    translation composed onto the refined H_cam_to_mat.
    """
    if len(dots_cam) != 4:
        raise RuntimeError(
            f"expected 4 detected dots, got {len(dots_cam)} — cannot calibrate"
        )
    if not grid_capture.detected:
        raise RuntimeError(
            "grid_capture is not detected — cannot compute grid-only calibration"
        )
    if grid_capture.intersections_cam.shape[0] < 4:
        raise RuntimeError("not enough grid intersections")

    pitch_mm = grid_capture.major_pitch_mm

    # Step 1: build a coarse H_cam_to_mat from the grid alone. The mat frame
    # at this stage is anchored at the *first detected intersection* (origin
    # is arbitrary and gets re-anchored at the TL dot in step 3). Axes and
    # scale come from the grid's `axis_*_angle_rad` and `pitch_cam_px_*`.
    origin_cam = grid_capture.intersections_cam[0].astype(np.float64)
    angle_x = grid_capture.axis_x_angle_rad
    angle_y = grid_capture.axis_y_angle_rad
    ux = np.array(
        [math.cos(angle_x) * grid_capture.pitch_cam_px_x,
         math.sin(angle_x) * grid_capture.pitch_cam_px_x],
        dtype=np.float64,
    )
    uy = np.array(
        [math.cos(angle_y) * grid_capture.pitch_cam_px_y,
         math.sin(angle_y) * grid_capture.pitch_cam_px_y],
        dtype=np.float64,
    )
    cam_basis = np.column_stack([ux, uy])  # cam_dxy = cam_basis @ mat_lattice_dxy
    cam_basis_inv = np.linalg.inv(cam_basis)
    A = cam_basis_inv * pitch_mm  # cam_dxy → mat_mm_dxy
    t = -A @ origin_cam
    h_coarse = np.array(
        [[A[0, 0], A[0, 1], t[0]],
         [A[1, 0], A[1, 1], t[1]],
         [0.0,     0.0,     1.0]],
        dtype=np.float64,
    )

    # Step 2: snap intersections to the lattice and refit with RANSAC over
    # many points (mirrors the passive-calibration logic).
    inter_cam = grid_capture.intersections_cam.astype(np.float64).reshape(-1, 1, 2)
    inter_mat = cv2.perspectiveTransform(inter_cam, h_coarse).reshape(-1, 2)
    snapped = np.round(inter_mat / pitch_mm) * pitch_mm
    residuals = np.linalg.norm(inter_mat - snapped, axis=1)
    keep = residuals <= MAT_GRID_SNAP_TOLERANCE_MM
    if int(keep.sum()) < 8:
        raise RuntimeError("not enough grid intersections snap to the lattice")
    cam_kept = grid_capture.intersections_cam[keep].astype(np.float32)
    mat_kept = snapped[keep].astype(np.float32)
    h_cam_to_mat, _ = cv2.findHomography(
        cam_kept, mat_kept, method=cv2.RANSAC, ransacReprojThreshold=1.0
    )
    if h_cam_to_mat is None:
        raise RuntimeError("findHomography (cam→mat) failed")

    # Step 3: transform dot cam_px → mat_mm. TL dot becomes the new origin;
    # compose a translation onto H_cam_to_mat so mat_mm coordinates start at
    # (0, 0) at the TL dot, matching the ArUco path's convention.
    dot_cam_arr = np.array(dots_cam, dtype=np.float64).reshape(-1, 1, 2)
    dot_mat = cv2.perspectiveTransform(dot_cam_arr, h_cam_to_mat).reshape(-1, 2)
    tl_mat = dot_mat[0].copy()
    dot_mat_anchored = dot_mat - tl_mat
    translation = np.array(
        [[1.0, 0.0, -tl_mat[0]], [0.0, 1.0, -tl_mat[1]], [0.0, 0.0, 1.0]],
        dtype=np.float64,
    )
    h_cam_to_mat = translation @ h_cam_to_mat

    # Step 4: fit H_mat_to_proj from the 4 (mat_mm, proj_px) correspondences.
    layout_by_id = {m.marker_id: m for m in layout}
    proj_pts = np.array(
        [
            [layout_by_id[mid].proj_x, layout_by_id[mid].proj_y]
            for mid in CALIBRATION_MARKER_IDS  # TL=10, TR=11, BR=12, BL=13
        ],
        dtype=np.float32,
    )
    h_mat_to_proj, _ = cv2.findHomography(
        dot_mat_anchored.astype(np.float32), proj_pts, method=0
    )
    if h_mat_to_proj is None:
        raise RuntimeError("findHomography (mat→proj) failed")

    # Width/height from TL→TR and TL→BL spans, matching the ArUco path.
    mat_width_mm = float(np.linalg.norm(dot_mat_anchored[1] - dot_mat_anchored[0]))
    mat_height_mm = float(np.linalg.norm(dot_mat_anchored[3] - dot_mat_anchored[0]))

    return Calibration(
        h_cam_to_mat=h_cam_to_mat.tolist(),
        h_mat_to_proj=h_mat_to_proj.tolist(),
        proj_width=proj_w,
        proj_height=proj_h,
        mat_width_mm=mat_width_mm,
        mat_height_mm=mat_height_mm,
        created_at=time.time(),
    )


def compute_passive_calibration(
    aruco_capture: CalibrationCapture,
    grid_capture: MatGridCapture,
    layout: list[CalibrationMarker],
    proj_w: int,
    proj_h: int,
) -> Calibration:
    """Compute calibration without a user ruler measurement.

    The grid_capture's `major_pitch_mm` (10.0 metric or 25.4 imperial) provides
    the mm scale; the ArUco markers anchor projector ↔ mat. Mirrors the shape
    of `compute_calibration` so the persisted Calibration schema is unchanged.
    """
    if not grid_capture.detected:
        raise RuntimeError(
            "grid_capture is not detected — cannot compute passive calibration"
        )
    layout_by_id = {m.marker_id: m for m in layout}
    for mid in CALIBRATION_MARKER_IDS:
        if mid not in aruco_capture.cam_corners_by_id:
            raise RuntimeError(
                f"Calibration marker {mid} was not detected in the camera frame."
            )

    cam_centers = {
        mid: aruco_capture.cam_corners_by_id[mid].mean(axis=0)
        for mid in CALIBRATION_MARKER_IDS
    }

    # Step 1: coarse mat dimensions from the cam_px ratio between the ArUco
    # span and one detected major cell. This gives us a starting H_cam_to_mat
    # accurate enough to project grid intersections back to mat_mm and snap.
    aruco_horizontal_cam_px = float(np.linalg.norm(cam_centers[11] - cam_centers[10]))
    aruco_vertical_cam_px = float(np.linalg.norm(cam_centers[13] - cam_centers[10]))
    coarse_horizontal_mm = (
        grid_capture.major_pitch_mm
        * aruco_horizontal_cam_px
        / grid_capture.pitch_cam_px_x
    )
    coarse_vertical_mm = (
        grid_capture.major_pitch_mm
        * aruco_vertical_cam_px
        / grid_capture.pitch_cam_px_y
    )

    cam_pts = np.array(
        [cam_centers[mid] for mid in CALIBRATION_MARKER_IDS], dtype=np.float32
    )
    coarse_mat_pts = np.array(
        [
            [0.0, 0.0],
            [coarse_horizontal_mm, 0.0],
            [coarse_horizontal_mm, coarse_vertical_mm],
            [0.0, coarse_vertical_mm],
        ],
        dtype=np.float32,
    )
    h_coarse, _ = cv2.findHomography(cam_pts, coarse_mat_pts, method=0)
    if h_coarse is None:
        raise RuntimeError("coarse findHomography failed")

    # Step 2: project intersections to mat_mm, snap each to its nearest
    # major-pitch lattice point, drop ones that miss by more than the snap
    # tolerance (those are spurious detections).
    inter_cam = grid_capture.intersections_cam.astype(np.float64).reshape(-1, 1, 2)
    inter_mat = cv2.perspectiveTransform(inter_cam, h_coarse).reshape(-1, 2)
    pitch_mm = grid_capture.major_pitch_mm
    snapped = np.round(inter_mat / pitch_mm) * pitch_mm
    residuals = np.linalg.norm(inter_mat - snapped, axis=1)
    keep = residuals <= MAT_GRID_SNAP_TOLERANCE_MM
    if int(keep.sum()) < 8:
        raise RuntimeError("not enough grid intersections snap to the lattice")
    cam_kept = grid_capture.intersections_cam[keep].astype(np.float32)
    mat_kept = snapped[keep].astype(np.float32)

    # Step 3: refit H_cam_to_mat using RANSAC over many points (much lower
    # per-point error than the 4-corner ArUco-only fit).
    h_cam_to_mat, _ = cv2.findHomography(
        cam_kept, mat_kept, method=cv2.RANSAC, ransacReprojThreshold=1.0
    )
    if h_cam_to_mat is None:
        raise RuntimeError("refined findHomography failed")

    # Step 4: re-derive ArUco centers in mat_mm using the refined H, then fit
    # H_mat_to_proj from those mat_mm centers and the known proj_px positions.
    aruco_mat = cv2.perspectiveTransform(
        cam_pts.reshape(-1, 1, 2).astype(np.float64), h_cam_to_mat
    ).reshape(-1, 2)
    proj_pts = np.array(
        [
            [layout_by_id[mid].proj_x, layout_by_id[mid].proj_y]
            for mid in CALIBRATION_MARKER_IDS
        ],
        dtype=np.float32,
    )
    h_mat_to_proj, _ = cv2.findHomography(
        aruco_mat.astype(np.float32), proj_pts, method=0
    )
    if h_mat_to_proj is None:
        raise RuntimeError("findHomography for mat_to_proj failed")

    mat_width_mm = float(np.linalg.norm(aruco_mat[1] - aruco_mat[0]))
    mat_height_mm = float(np.linalg.norm(aruco_mat[3] - aruco_mat[0]))

    return Calibration(
        h_cam_to_mat=h_cam_to_mat.tolist(),
        h_mat_to_proj=h_mat_to_proj.tolist(),
        proj_width=proj_w,
        proj_height=proj_h,
        mat_width_mm=mat_width_mm,
        mat_height_mm=mat_height_mm,
        created_at=time.time(),
    )
