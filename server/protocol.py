from __future__ import annotations

from typing import Literal, Union

from pydantic import BaseModel, Field

Mode = Literal["idle", "calibrate", "track"]
CalibrationMethod = Literal["aruco", "grid"]


class Calibration(BaseModel):
    h_cam_to_mat: list[list[float]]
    h_mat_to_proj: list[list[float]]
    proj_width: int
    proj_height: int
    mat_width_mm: float
    mat_height_mm: float
    created_at: float


class DetectedObject(BaseModel):
    marker_id: int
    corners_mm: list[list[float]] = Field(description="4 corners, each [x_mm, y_mm], TL/TR/BR/BL order")
    center_mm: list[float]
    angle_deg: float


class DetectedHand(BaseModel):
    handedness: Literal["Left", "Right"]
    score: float
    landmarks_mm: list[list[float]] = Field(
        description="21 MediaPipe Hand landmarks, each [x_mm, y_mm] in mat coordinates"
    )


class CalibrationMarker(BaseModel):
    marker_id: int
    proj_x: float
    proj_y: float


class WorkSurface(BaseModel):
    """Rectangle in projector pixel space defining the actual workable area within the projection.

    The projector may cover an area larger than the physical mat (overshoot, off-axis mounting,
    or a smaller mat than the projection); the work surface is the subset where calibration
    markers and content are positioned.
    """

    x: int
    y: int
    width: int
    height: int
    updated_at: float


class CameraRoi(BaseModel):
    """Quadrilateral in *camera* pixel space — 4 corners in TL/TR/BR/BL order.

    Manually placed by the user during grid-method calibration. Serves two
    roles simultaneously:

    1. **Region mask** — every detector (ArUco, dots, mat-grid, object
       tracker, hand tracker) sees a frame with pixels outside the polygon
       blacked out. The MJPEG preview is unaffected — outside-polygon
       pixels are still visible to the user, just not to the detectors.

    2. **Keystone correction** — for grid detection specifically, the
       polygon is warped to a rectangle (using its average edge lengths as
       the target dimensions) so the cutting-mat grid appears orthogonal in
       the warped frame before Hough analysis. Detection results are
       transformed back to cam_px before broadcast.
    """

    # 4 [x, y] corners in TL/TR/BR/BL order. Floats so the persisted value
    # round-trips drag deltas without integer-rounding drift.
    corners: list[list[float]]
    updated_at: float


class HelloEvent(BaseModel):
    type: Literal["hello"] = "hello"
    mode: Mode
    calibration: Calibration | None
    projector: tuple[int, int] | None = None
    work_surface: WorkSurface | None = None
    show_work_surface_outline: bool = True
    camera_index: int | None = None
    camera_open: bool = False
    camera_roi: CameraRoi | None = None


class ModeChangedEvent(BaseModel):
    type: Literal["mode_changed"] = "mode_changed"
    mode: Mode


class DetectionsEvent(BaseModel):
    type: Literal["detections"] = "detections"
    objects: list[DetectedObject]
    ts: float


class HandsEvent(BaseModel):
    type: Literal["hands"] = "hands"
    hands: list[DetectedHand]
    ts: float


class CalibrationUpdatedEvent(BaseModel):
    type: Literal["calibration_updated"] = "calibration_updated"
    calibration: Calibration


class CalibrationPromptEvent(BaseModel):
    """Sent during calibration: the projector client should draw these markers at these projector pixels.

    The `method` distinguishes how the projector renders the markers:
      - "aruco" — full ArUco DICT_4X4_50 pattern PNGs at IDs 10..13 (existing flow)
      - "grid"  — plain solid white dots; the camera locates them as bright
        blobs while the printed cutting-mat grid provides camera↔mat scale
    """

    type: Literal["calibration_prompt"] = "calibration_prompt"
    markers: list[CalibrationMarker]
    marker_size_px: int  # how many projector pixels each marker image (incl. white quiet zone) occupies
    method: CalibrationMethod = "aruco"


class MatGridStatus(BaseModel):
    """Status of cutting-mat grid detection during calibration.

    Sent on every CalibrationCapturedEvent so the UI can show whether passive
    grid-based calibration is available. When `detected` is true, the system
    can finish calibration without a user ruler measurement.

    Classification rules (subdivisions = minor lines per major cell):
      - 10 or 5  → metric  (major_pitch_mm = 10.0)
      - 2/4/8/16 → imperial (major_pitch_mm = 25.4)
      - anything else → not detected, `reason` populated
    """

    detected: bool
    grid_system: Literal["metric", "imperial"] | None = None
    major_pitch_mm: float | None = None  # 10.0 (metric) or 25.4 (imperial)
    subdivisions_per_major: int | None = None  # 10, 5, 2, 4, 8, or 16
    pitch_cam_px_x: float | None = None
    pitch_cam_px_y: float | None = None
    intersection_count: int = 0
    confidence: float = 0.0
    reason: str | None = None  # populated when detected = False
    # Per-stage line counts from the detection pipeline. Surfaced so the UI
    # can render a count legend next to the debug preview without needing the
    # full line geometry (which only the explicit-detection path carries).
    weak_line_count: int = 0
    strong_line_count: int = 0
    axis_a_line_count: int = 0
    axis_b_line_count: int = 0
    diagonal_line_count: int = 0


class MatGridDetectedEvent(BaseModel):
    """Result of an explicitly-triggered mat-grid detection run.

    Independent of ArUco-marker presence: the detector runs on the full camera
    frame and skips the ArUco axis-alignment sanity check. This is purely a
    diagnostic surface so the user can verify that the mat-grid detector
    actually finds their cutting-mat, separately from the per-frame run that
    only fires when all 4 calibration markers are visible.
    """

    type: Literal["mat_grid_detected"] = "mat_grid_detected"
    grid: MatGridStatus
    frame_width: int = 0
    frame_height: int = 0
    intersections_cam: list[list[float]] = Field(
        default_factory=list,
        description="Major-line intersections in camera pixels, for overlay rendering.",
    )
    # Diagnostic line segments populated by the detector at each pipeline
    # stage — even when classification ultimately fails. Each entry is
    # `[x1, y1, x2, y2]` in cam_px. Used by the camera-preview overlay to
    # show which step gave up: weak lines = raw Hough output (low threshold),
    # strong lines = bold candidates (high threshold), axis-A/B = strong
    # lines that clustered into the two perpendicular grid families.
    weak_lines_cam: list[list[float]] = Field(default_factory=list)
    strong_lines_cam: list[list[float]] = Field(default_factory=list)
    axis_a_lines_cam: list[list[float]] = Field(default_factory=list)
    axis_b_lines_cam: list[list[float]] = Field(default_factory=list)
    # Strong lines that don't align with either grid axis — typically the
    # diagonal angle guides (30°, 45°, 60°) printed on most cutting mats.
    # Surfaced for visualization only; rejected during axis selection.
    diagonal_lines_cam: list[list[float]] = Field(default_factory=list)


class CalibrationCapturedEvent(BaseModel):
    """Diagnostic broadcast at ~6 Hz while in calibrate mode.

    Always sent regardless of how many markers are detected, so the UI can show progress
    (1/4, 2/4 …) and overlay detected corners on the camera preview. Even with 0 markers
    we send the frame size so the UI knows the preview is alive.
    """

    type: Literal["calibration_captured"] = "calibration_captured"
    method: CalibrationMethod = "aruco"
    detected_marker_ids: list[int]
    detected_corners_cam: list[list[list[float]]] = []
    frame_width: int = 0
    frame_height: int = 0
    rejected_count: int = 0  # quads found but not decoded — useful when detected count = 0
    mat_grid: MatGridStatus | None = None  # null when not yet evaluated
    # Grid-only path: cam-pixel centers of the 4 detected dots, in TL/TR/BR/BL
    # order. Empty when fewer than 4 dots are visible (we can't disambiguate
    # which corner is missing from a partial set). Always empty for method=aruco.
    detected_dots_cam: list[list[float]] = Field(default_factory=list)
    detected_dot_count: int = 0  # number of bright-dot candidates found this frame


class ProjectorRegisteredEvent(BaseModel):
    """Broadcast so control clients know what dimensions calibration will use."""

    type: Literal["projector_registered"] = "projector_registered"
    proj_width: int
    proj_height: int


class WorkSurfaceUpdatedEvent(BaseModel):
    type: Literal["work_surface_updated"] = "work_surface_updated"
    work_surface: WorkSurface
    show_outline: bool


class CameraRoiUpdatedEvent(BaseModel):
    type: Literal["camera_roi_updated"] = "camera_roi_updated"
    camera_roi: CameraRoi | None  # null when the user cleared the manual ROI


class CameraChangedEvent(BaseModel):
    type: Literal["camera_changed"] = "camera_changed"
    camera_index: int | None
    camera_open: bool
    error: str | None = None


class FrameStatsEvent(BaseModel):
    """Heartbeat broadcast at ~1 Hz so the UI can show that the frame loop is alive
    and how it's doing (FPS, frame index, last frame age). Fires regardless of mode
    or camera state — so even with no camera we still get a pulse."""

    type: Literal["frame_stats"] = "frame_stats"
    mode: Mode
    camera_open: bool
    frame_index: int
    fps: float
    last_frame_age_ms: int  # -1 if no frame ever read
    detector_runs: int
    last_detected_count: int


ServerEvent = Union[
    HelloEvent,
    ModeChangedEvent,
    DetectionsEvent,
    HandsEvent,
    CalibrationUpdatedEvent,
    CalibrationPromptEvent,
    CalibrationCapturedEvent,
    MatGridDetectedEvent,
    ProjectorRegisteredEvent,
    WorkSurfaceUpdatedEvent,
    CameraRoiUpdatedEvent,
    CameraChangedEvent,
    FrameStatsEvent,
]


class SetModeCommand(BaseModel):
    type: Literal["set_mode"] = "set_mode"
    mode: Mode


class RegisterProjectorCommand(BaseModel):
    """Sent by the projector client on connect (and on resize) so any client can trigger calibration."""

    type: Literal["register_projector"] = "register_projector"
    proj_width: int
    proj_height: int


class StartCalibrationCommand(BaseModel):
    """Trigger calibration. Uses the projector dimensions registered by the projector client.

    The `method` selects how the camera will lock onto the projection:
      - "aruco" — projects ArUco DICT_4X4_50 markers; finalize via ruler
        measurement OR (when a cutting-mat grid is also detected) the passive
        grid-derived scale.
      - "grid"  — projects 4 plain dots; the printed cutting-mat grid alone
        provides camera↔mat (axes + scale + lattice). No ArUco, no ruler.
        Requires a mat with a printed metric or imperial grid.
    """

    type: Literal["start_calibration"] = "start_calibration"
    method: CalibrationMethod = "aruco"


class FinishCalibrationCommand(BaseModel):
    """Sent by any client to finish calibration.

    Two paths:
      - Active (current): the user measured the on-mat horizontal distance between
        markers 10 and 11 with a ruler and provides `horizontal_mm`.
      - Passive (when a cutting-mat grid was reliably detected): `horizontal_mm`
        is omitted and the server derives the mm scale from the detected grid.
    """

    type: Literal["finish_calibration"] = "finish_calibration"
    horizontal_mm: float | None = None


class DetectGridCommand(BaseModel):
    """Trigger one-shot mat-grid detection on the next camera frame.

    Runs the detector independently of ArUco markers: the full camera frame is
    used as the ROI and the ArUco axis-alignment check is skipped. Result is
    broadcast as a MatGridDetectedEvent.
    """

    type: Literal["detect_grid"] = "detect_grid"


class SetWorkSurfaceCommand(BaseModel):
    """Update the work-surface rectangle. Coordinates are in projector pixels."""

    type: Literal["set_work_surface"] = "set_work_surface"
    x: int
    y: int
    width: int
    height: int
    show_outline: bool | None = None


class SetCameraCommand(BaseModel):
    """Switch to a different camera by OpenCV index. Pass null to close the current camera."""

    type: Literal["set_camera"] = "set_camera"
    index: int | None


class SetCameraRoiCommand(BaseModel):
    """Set or clear the manual camera-frame ROI polygon.

    When `clear=True`, the manual ROI is removed and grid detection falls
    back to the work-surface-derived quad. When `clear=False` (default),
    `corners` defines a 4-point polygon in cam_px (TL/TR/BR/BL order).
    """

    type: Literal["set_camera_roi"] = "set_camera_roi"
    corners: list[list[float]] = Field(default_factory=list)
    clear: bool = False


ClientCommand = Union[
    SetModeCommand,
    RegisterProjectorCommand,
    StartCalibrationCommand,
    FinishCalibrationCommand,
    DetectGridCommand,
    SetWorkSurfaceCommand,
    SetCameraCommand,
    SetCameraRoiCommand,
]
