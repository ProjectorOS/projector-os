from __future__ import annotations

from typing import Literal, Union

from pydantic import BaseModel, Field

Mode = Literal["idle", "calibrate", "track"]


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


class HelloEvent(BaseModel):
    type: Literal["hello"] = "hello"
    mode: Mode
    calibration: Calibration | None
    projector: tuple[int, int] | None = None
    work_surface: WorkSurface | None = None
    show_work_surface_outline: bool = True
    camera_index: int | None = None
    camera_open: bool = False


class ModeChangedEvent(BaseModel):
    type: Literal["mode_changed"] = "mode_changed"
    mode: Mode


class DetectionsEvent(BaseModel):
    type: Literal["detections"] = "detections"
    objects: list[DetectedObject]
    ts: float


class CalibrationUpdatedEvent(BaseModel):
    type: Literal["calibration_updated"] = "calibration_updated"
    calibration: Calibration


class CalibrationPromptEvent(BaseModel):
    """Sent during calibration: the projector client should draw these markers at these projector pixels."""

    type: Literal["calibration_prompt"] = "calibration_prompt"
    markers: list[CalibrationMarker]


class CalibrationCapturedEvent(BaseModel):
    """Diagnostic broadcast at ~6 Hz while in calibrate mode.

    Always sent regardless of how many markers are detected, so the UI can show progress
    (1/4, 2/4 …) and overlay detected corners on the camera preview. Even with 0 markers
    we send the frame size so the UI knows the preview is alive.
    """

    type: Literal["calibration_captured"] = "calibration_captured"
    detected_marker_ids: list[int]
    detected_corners_cam: list[list[list[float]]] = []
    frame_width: int = 0
    frame_height: int = 0


class ProjectorRegisteredEvent(BaseModel):
    """Broadcast so control clients know what dimensions calibration will use."""

    type: Literal["projector_registered"] = "projector_registered"
    proj_width: int
    proj_height: int


class WorkSurfaceUpdatedEvent(BaseModel):
    type: Literal["work_surface_updated"] = "work_surface_updated"
    work_surface: WorkSurface
    show_outline: bool


class CameraChangedEvent(BaseModel):
    type: Literal["camera_changed"] = "camera_changed"
    camera_index: int | None
    camera_open: bool
    error: str | None = None


ServerEvent = Union[
    HelloEvent,
    ModeChangedEvent,
    DetectionsEvent,
    CalibrationUpdatedEvent,
    CalibrationPromptEvent,
    CalibrationCapturedEvent,
    ProjectorRegisteredEvent,
    WorkSurfaceUpdatedEvent,
    CameraChangedEvent,
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
    """Trigger calibration. Uses the projector dimensions registered by the projector client."""

    type: Literal["start_calibration"] = "start_calibration"


class FinishCalibrationCommand(BaseModel):
    """Sent by any client once the user has measured the on-mat horizontal distance between TL and TR markers."""

    type: Literal["finish_calibration"] = "finish_calibration"
    horizontal_mm: float


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


ClientCommand = Union[
    SetModeCommand,
    RegisterProjectorCommand,
    StartCalibrationCommand,
    FinishCalibrationCommand,
    SetWorkSurfaceCommand,
    SetCameraCommand,
]
