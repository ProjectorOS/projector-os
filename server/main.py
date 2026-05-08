from __future__ import annotations

import asyncio
import logging
import math
import os
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
from fastapi import FastAPI, HTTPException, Response, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from server import camera_roi as cam_roi_persist
from server import preferences as prefs_persist
from server import work_surface as ws_persist
from server.bus import Bus
from server.calibration import (
    CALIBRATION_MARKER_INNER_PX,
    CALIBRATION_MARKER_IDS,
    CALIBRATION_MARKER_QUIET_ZONE_PX,
    CALIBRATION_MARKER_TOTAL_PX,
    MAT_GRID_CONFIDENCE_MIN,
    MatGridCapture,
    average_captures,
    compute_calibration,
    compute_grid_homography,
    compute_grid_only_calibration,
    compute_passive_calibration,
    detect_calibration_dots,
    detect_mat_grid,
    detect_projected_markers,
    grid_capture_to_status,
    load_calibration,
    make_projection_layout,
    preprocess_for_grid_detection,
    save_calibration,
)
from server.camera import Camera, CameraConfig
from server.cameras import list_cameras
from server.detection import HandDetector, ObjectDetector, now_ts
from server.displays import list_displays
from server.launcher import ProjectorLauncher
from server.protocol import (
    Calibration,
    CalibrationCapturedEvent,
    CalibrationPromptEvent,
    CalibrationUpdatedEvent,
    CameraChangedEvent,
    DetectedHand,
    DetectedObject,
    DetectionsEvent,
    FrameStatsEvent,
    HandsEvent,
    CalibrationMethod,
    CameraRoi,
    CameraRoiUpdatedEvent,
    HelloEvent,
    MatGridDetectedEvent,
    MatGridStatus,
    Mode,
    ModeChangedEvent,
    ProjectorRegisteredEvent,
    WorkSurface,
    WorkSurfaceUpdatedEvent,
)

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
)
log = logging.getLogger("server.main")

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
CALIBRATION_PATH = DATA_DIR / "calibration.json"
WORK_SURFACE_PATH = DATA_DIR / "work_surface.json"
CAMERA_ROI_PATH = DATA_DIR / "camera_roi.json"
PREFERENCES_PATH = DATA_DIR / "preferences.json"
# Keep a tracked object on the projection for this long after its marker stops being
# detected. Smooths over single-frame detection misses (occlusion by a hand, motion
# blur, glare) so objects don't flicker on/off.
TRACK_GRACE_PERIOD_S = 1
# Same idea for the 4 calibration dots in grid-mode calibrate: a single-frame blob
# detector miss (motion blur, ambient-light fluctuation, transient glare) shouldn't
# wipe the TL/TR/BR/BL labels off the camera preview. We hold the last full 4-dot
# capture for this long and treat the dots as still-present for ROI / broadcast.
DOT_GRACE_PERIOD_S = 1.0
# Below these thresholds, frame-to-frame pose differences are sensor noise from
# ArUco subpixel refinement — not real movement. Suppress broadcasts within this
# band so the WS isn't chattering with sub-mm jitter while objects sit still.
POSE_POS_EPSILON_MM = 1
POSE_ANGLE_EPSILON_DEG = 0.1
# When a marker stops being detected and a fingertip is over its last-known footprint,
# we "glue" the marker to that fingertip so the overlay tracks the finger until either
# the marker re-emerges or the user lifts the hand. Padding (mm) is added to the
# marker's quad before the fingertip-inside test — small ArUco markers are easy to
# miss the dead center of with a fingertip pad.
GLUE_PAD_MM = 15
# Drop a glue after this long even if the fingertip is still present. Bounds the
# worst-case "marker is permanently lost but the hand still hovers" scenario; the
# user can always re-glue by lifting and re-touching.
GLUE_TIMEOUT_S = 2.0
# MediaPipe Hand fingertip landmark indices: thumb, index, middle, ring, pinky.
FINGERTIP_LANDMARK_INDICES = (4, 8, 12, 16, 20)
# For each fingertip, the proximal landmark we use as the angle baseline. Long lever
# arms (whole-finger from MCP/CMC to tip) keep the measured angle stable against
# landmark jitter and follow the wrist's rotation naturally.
FINGERTIP_TO_BASE: dict[int, int] = {
    4: 1,    # thumb: CMC → tip
    8: 5,    # index: MCP → tip
    12: 9,   # middle
    16: 13,  # ring
    20: 17,  # pinky
}


@dataclass
class GlueState:
    """A marker is currently being dragged by a fingertip.

    Frozen baseline: the marker pose, fingertip position, and finger angle at the
    moment the glue formed. Each frame we recompute the marker's position from
    these baselines plus the current fingertip + finger angle — never chaining
    incremental updates, so cumulative drift can't accumulate.
    """

    handedness: str  # "Left" | "Right" (user's POV — see HandDetector)
    landmark_idx: int  # which fingertip (one of FINGERTIP_LANDMARK_INDICES)
    frozen_obj: DetectedObject  # marker pose at glue time
    frozen_fingertip_mm: tuple[float, float]
    frozen_finger_angle_rad: float  # base→tip angle at glue time
    created_ts: float


@dataclass
class TrackedObject:
    last_obj: DetectedObject
    last_seen_ts: float
    glue: GlueState | None = None


def _pose_changed(a: DetectedObject, b: DetectedObject) -> bool:
    dx = a.center_mm[0] - b.center_mm[0]
    dy = a.center_mm[1] - b.center_mm[1]
    if (dx * dx + dy * dy) > POSE_POS_EPSILON_MM * POSE_POS_EPSILON_MM:
        return True
    da = abs(a.angle_deg - b.angle_deg) % 360.0
    if da > 180.0:
        da = 360.0 - da
    return da > POSE_ANGLE_EPSILON_DEG


def _detections_changed(
    current: dict[int, DetectedObject], previous: dict[int, DetectedObject]
) -> bool:
    if current.keys() != previous.keys():
        return True
    for mid, obj in current.items():
        if _pose_changed(obj, previous[mid]):
            return True
    return False


def _padded_corners_mm(obj: DetectedObject, pad_mm: float) -> np.ndarray:
    """Push each corner outward from the marker center by pad_mm. Mirrors the UI's
    PAD_MM expansion in overlay.ts so server- and client-side bbox math agree."""
    cx, cy = obj.center_mm
    out: list[list[float]] = []
    for x, y in obj.corners_mm:
        dx = x - cx
        dy = y - cy
        length = math.hypot(dx, dy) or 1.0
        out.append([x + (dx / length) * pad_mm, y + (dy / length) * pad_mm])
    return np.array(out, dtype=np.float32)


def _finger_angle_rad(hand: DetectedHand, tip_idx: int, base_idx: int) -> float:
    tx, ty = hand.landmarks_mm[tip_idx]
    bx, by = hand.landmarks_mm[base_idx]
    return math.atan2(ty - by, tx - bx)


def _angle_delta_rad(current: float, baseline: float) -> float:
    """Shortest signed rotation from baseline to current, in (-pi, pi]. Handles
    the atan2 wraparound — without this, a rotation past +/-pi would flip sign
    and cause the marker to spin the long way around."""
    delta = (current - baseline) % (2 * math.pi)
    if delta > math.pi:
        delta -= 2 * math.pi
    return delta


def _find_fingertip_over(
    hands: list[DetectedHand], obj: DetectedObject, pad_mm: float
) -> tuple[str, int, tuple[float, float], float] | None:
    """Find the fingertip closest to the marker center that lies inside the padded
    quad. Returns (handedness, tip_idx, tip_mm, finger_angle_rad) or None."""
    quad = _padded_corners_mm(obj, pad_mm)
    cx, cy = obj.center_mm
    best: tuple[str, int, tuple[float, float], float, float] | None = None
    for hand in hands:
        for tip_idx in FINGERTIP_LANDMARK_INDICES:
            x, y = hand.landmarks_mm[tip_idx]
            if cv2.pointPolygonTest(quad, (float(x), float(y)), False) < 0:
                continue
            d2 = (x - cx) ** 2 + (y - cy) ** 2
            if best is not None and d2 >= best[4]:
                continue
            angle = _finger_angle_rad(hand, tip_idx, FINGERTIP_TO_BASE[tip_idx])
            best = (hand.handedness, tip_idx, (float(x), float(y)), angle, d2)
    if best is None:
        return None
    return best[0], best[1], best[2], best[3]


def _find_finger_pose(
    hands: list[DetectedHand], handedness: str, tip_idx: int
) -> tuple[tuple[float, float], float] | None:
    """Returns (tip_pos_mm, finger_angle_rad) for the matching hand, or None."""
    base_idx = FINGERTIP_TO_BASE[tip_idx]
    for hand in hands:
        if hand.handedness == handedness:
            x, y = hand.landmarks_mm[tip_idx]
            return ((float(x), float(y)), _finger_angle_rad(hand, tip_idx, base_idx))
    return None


def _glued_object(
    frozen_obj: DetectedObject,
    frozen_fingertip_mm: tuple[float, float],
    new_fingertip_mm: tuple[float, float],
    delta_rad: float,
) -> DetectedObject:
    """Compute the marker's current pose from frozen state + finger movement.

    The offset from fingertip to marker center, and the corners relative to that
    center, are both rotated by delta_rad. Each frame derives from the frozen
    baseline (not from last frame's pose) so rotation can't accumulate drift."""
    cos_d = math.cos(delta_rad)
    sin_d = math.sin(delta_rad)
    fcx, fcy = frozen_obj.center_mm
    fox = fcx - frozen_fingertip_mm[0]
    foy = fcy - frozen_fingertip_mm[1]
    new_cx = new_fingertip_mm[0] + cos_d * fox - sin_d * foy
    new_cy = new_fingertip_mm[1] + sin_d * fox + cos_d * foy
    new_corners: list[list[float]] = []
    for x, y in frozen_obj.corners_mm:
        rx = x - fcx
        ry = y - fcy
        new_corners.append(
            [new_cx + cos_d * rx - sin_d * ry, new_cy + sin_d * rx + cos_d * ry]
        )
    return DetectedObject(
        marker_id=frozen_obj.marker_id,
        corners_mm=new_corners,
        center_mm=[new_cx, new_cy],
        angle_deg=frozen_obj.angle_deg + math.degrees(delta_rad),
    )


class AppState:
    def __init__(self) -> None:
        self.bus = Bus()
        self.camera: Camera | None = None
        self.detector = ObjectDetector()
        self.hand_detector: HandDetector | None = None
        try:
            self.hand_detector = HandDetector()
        except FileNotFoundError as e:
            log.warning("hand detection disabled: %s", e)
        self.calibration: Calibration | None = load_calibration(CALIBRATION_PATH)
        # If we've been calibrated before, jump straight into tracking — recalibration
        # is rare and the user almost always wants the overlay live on startup.
        self.mode: Mode = "track" if self.calibration is not None else "idle"
        self.projector_dims: tuple[int, int] | None = None
        self.work_surface: WorkSurface | None = ws_persist.load(WORK_SURFACE_PATH)
        self.camera_roi: CameraRoi | None = cam_roi_persist.load(CAMERA_ROI_PATH)
        self.camera_index: int | None = None
        self.launcher = ProjectorLauncher()
        self.preferences = prefs_persist.load(PREFERENCES_PATH)
        self.show_work_surface_outline: bool = (
            self.preferences.show_work_surface_outline
        )
        self._calibration_method: CalibrationMethod = "aruco"
        self._calibration_layout: list = []
        self._calibration_proj_w: int = 0
        self._calibration_proj_h: int = 0
        self._calibration_captures: list = []
        # Grid-only path: latest 4 detected dot centers in cam_px (TL/TR/BR/BL
        # order) plus the raw blob count for progress display. Empty list when
        # fewer than 4 dots are visible — we can't tell which corner is missing
        # from a partial set.
        self._calibration_dots_cam: list[np.ndarray] = []
        self._calibration_dot_count: int = 0
        # Last frame in which all 4 dots were sortable, plus its timestamp.
        # Used to apply DOT_GRACE_PERIOD_S so a single-frame detector miss
        # doesn't strip the labels off the camera preview while the user can
        # clearly see the dots are still there.
        self._last_full_dots_cam: list[np.ndarray] = []
        self._last_full_dots_ts: float = 0.0
        # Passive (mat-grid) calibration: latest successful grid detection plus
        # the wall-clock timestamp it was observed at. Stored as the latest
        # successful capture only — the detector runs every frame and updates
        # this slot whenever it finds a reliable grid; staleness is checked
        # in finish_calibration. None = no grid currently detected.
        self._last_grid_capture: MatGridCapture | None = None
        self._last_grid_capture_ts: float = 0.0
        self._latest_grid_status: MatGridStatus | None = None
        # Set by the `detect_grid` WS command. Consumed by the frame loop on the
        # next available frame: runs detect_mat_grid(frame, None) independently
        # of ArUco markers and broadcasts the result. Useful for verifying the
        # detector against a particular cutting-mat + camera setup before (or
        # outside of) the regular ArUco-gated calibration flow.
        self._detect_grid_pending: bool = False
        # Most recent grid_capture from the per-frame detector — success OR
        # failure. The success-only `_last_grid_capture` is used for finishing
        # calibration; this one is for diagnostic broadcast / overlay
        # rendering so the user can see what the detector is finding live.
        self._last_grid_diagnostic: MatGridCapture | None = None
        # Rate-limit timestamp for the periodic per-frame grid summary log.
        self._last_grid_log_ts: float = 0.0
        # Latest "what OpenCV sees" preview as encoded JPEG bytes — the
        # CLAHE'd ROI with Canny edges painted in red and the ROI bbox in
        # cyan. Pulled by the /camera/grid_preview.mjpg endpoint. Bytes
        # swap is atomic so reading from the HTTP handler doesn't tear.
        self._last_grid_preview_jpeg: bytes | None = None
        # Latest rectified preview: the camera frame warped through
        # H_cam_to_mat so the cutting-mat grid appears orthogonal — i.e.,
        # camera keystone removed using the detected grid lines as the
        # ground truth. Pulled by /camera/grid_rectified.mjpg.
        self._last_grid_rectified_jpeg: bytes | None = None
        self._loop_task: asyncio.Task | None = None
        self._heartbeat_task: asyncio.Task | None = None
        # Frame-loop instrumentation (used by the heartbeat broadcast).
        self._frame_index = 0
        self._last_frame_ts = 0.0
        self._fps = 0.0
        self._detector_runs = 0
        self._last_detected_count = 0
        # marker_id → TrackedObject. Used to apply the grace period during track mode
        # so a single-frame detection miss doesn't cause the object's overlay to
        # flicker off, and to drag a marker with a fingertip while it's occluded.
        self._tracked_objects: dict[int, TrackedObject] = {}
        # Snapshot of what was last broadcast, for change detection. Reset on mode
        # change so re-entering track mode always emits an initial broadcast.
        self._last_broadcast_objects: dict[int, DetectedObject] = {}
        # Whether the last hands broadcast contained any hands. Lets us emit a single
        # empty-list broadcast on the present→absent transition (so the UI clears)
        # without flooding the WS while no hands are visible.
        self._last_hands_present: bool = False

    async def start(self) -> None:
        # Camera: env var wins for one-off overrides; otherwise restore the saved index.
        cam_env = os.environ.get("CAMERA_INDEX")
        if cam_env is not None:
            try:
                idx = int(cam_env)
            except ValueError:
                idx = 0
            await self._open_camera(idx)
        elif self.preferences.camera_index is not None:
            log.info("restoring saved camera index %d", self.preferences.camera_index)
            await self._open_camera(self.preferences.camera_index)

        self._loop_task = asyncio.create_task(self._run_loop(), name="frame-loop")
        self._heartbeat_task = asyncio.create_task(self._heartbeat(), name="heartbeat")

        # Projector: re-launch the kiosk on the previously chosen display, after a short
        # delay so the Vite dev server is reachable.
        if self.preferences.projector_display is not None:
            asyncio.create_task(
                self._auto_launch_projector(), name="auto-launch-projector"
            )

    async def _auto_launch_projector(self) -> None:
        await asyncio.sleep(2.0)
        d = self.preferences.projector_display
        if d is None or self.launcher.is_running():
            return
        log.info(
            "restoring projector kiosk on saved display (%d, %d) %dx%d",
            d.x,
            d.y,
            d.width,
            d.height,
        )
        try:
            self.launch_projector(d.x, d.y, d.width, d.height)
        except RuntimeError as e:
            log.warning("auto-launch failed: %s", e)

    def launch_projector(self, x: int, y: int, width: int, height: int) -> None:
        ui_port = int(os.environ.get("UI_PORT", "5173"))
        ui_url = f"http://localhost:{ui_port}/projector/"
        self.launcher.launch(x, y, width, height, ui_url)
        self.preferences.projector_display = prefs_persist.ProjectorDisplay(
            x=x, y=y, width=width, height=height
        )
        prefs_persist.save(self.preferences, PREFERENCES_PATH)

    async def _open_camera(self, index: int) -> str | None:
        """Open the given camera index, replacing any existing one. Returns error string or None."""
        if self.camera is not None:
            self.camera.close()
            self.camera = None
        try:
            cam = Camera(CameraConfig(index=index))
            cam.open()
        except RuntimeError as e:
            log.warning("camera %d not available: %s", index, e)
            self.camera_index = index
            return str(e)
        self.camera = cam
        self.camera_index = index
        return None

    async def set_camera(self, index: int | None) -> None:
        if index is None:
            if self.camera is not None:
                self.camera.close()
            self.camera = None
            self.camera_index = None
            self.preferences.camera_index = None
            prefs_persist.save(self.preferences, PREFERENCES_PATH)
            await self.bus.broadcast(
                CameraChangedEvent(camera_index=None, camera_open=False)
            )
            return
        err = await self._open_camera(index)
        # Save whatever the user chose, even if it failed to open — they can retry next time.
        self.preferences.camera_index = index
        prefs_persist.save(self.preferences, PREFERENCES_PATH)
        await self.bus.broadcast(
            CameraChangedEvent(
                camera_index=self.camera_index,
                camera_open=self.camera is not None,
                error=err,
            )
        )

    async def stop(self) -> None:
        for task in (self._loop_task, self._heartbeat_task):
            if task is None:
                continue
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        if self.camera:
            self.camera.close()
        if self.hand_detector is not None:
            self.hand_detector.close()
        self.launcher.close()

    async def _heartbeat(self) -> None:
        try:
            while True:
                await asyncio.sleep(1.0)
                last_age = -1
                if self._last_frame_ts > 0:
                    last_age = int((time.time() - self._last_frame_ts) * 1000)
                await self.bus.broadcast(
                    FrameStatsEvent(
                        mode=self.mode,
                        camera_open=self.camera is not None,
                        frame_index=self._frame_index,
                        fps=round(self._fps, 1),
                        last_frame_age_ms=last_age,
                        detector_runs=self._detector_runs,
                        last_detected_count=self._last_detected_count,
                    )
                )
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("heartbeat task crashed")
            raise

    async def set_mode(self, mode: Mode) -> None:
        self.mode = mode
        if mode != "calibrate":
            self._calibration_captures.clear()
            self._calibration_dots_cam = []
            self._calibration_dot_count = 0
            self._last_full_dots_cam = []
            self._last_full_dots_ts = 0.0
            self._last_grid_preview_jpeg = None
            self._last_grid_rectified_jpeg = None
        if mode != "track":
            self._tracked_objects.clear()
            self._last_broadcast_objects.clear()
            self._last_hands_present = False
        await self.bus.broadcast(ModeChangedEvent(mode=mode))

    async def register_projector(self, proj_w: int, proj_h: int) -> None:
        self.projector_dims = (proj_w, proj_h)
        # If we have no work surface yet, default to the full projector. If we have one
        # but the projector has resized, clamp it back into bounds.
        if self.work_surface is None:
            self.work_surface = ws_persist.default_for(proj_w, proj_h)
        else:
            self.work_surface = ws_persist.clamp(self.work_surface, proj_w, proj_h)
        await self.bus.broadcast(
            ProjectorRegisteredEvent(proj_width=proj_w, proj_height=proj_h)
        )
        await self._broadcast_work_surface()

    async def set_work_surface(
        self, x: int, y: int, w: int, h: int, show_outline: bool | None
    ) -> None:
        if self.projector_dims is None:
            log.warning("set_work_surface called before projector registered")
            return
        proj_w, proj_h = self.projector_dims
        ws = WorkSurface(x=x, y=y, width=w, height=h, updated_at=time.time())
        ws = ws_persist.clamp(ws, proj_w, proj_h)
        self.work_surface = ws
        ws_persist.save(ws, WORK_SURFACE_PATH)
        if show_outline is not None and show_outline != self.show_work_surface_outline:
            self.show_work_surface_outline = show_outline
            self.preferences.show_work_surface_outline = show_outline
            prefs_persist.save(self.preferences, PREFERENCES_PATH)
        await self._broadcast_work_surface()

    async def _broadcast_work_surface(self) -> None:
        if self.work_surface is None:
            return
        await self.bus.broadcast(
            WorkSurfaceUpdatedEvent(
                work_surface=self.work_surface,
                show_outline=self.show_work_surface_outline,
            )
        )

    async def set_camera_roi(
        self,
        corners: list[list[float]],
        clear: bool,
    ) -> None:
        if clear or len(corners) != 4:
            self.camera_roi = None
        else:
            self.camera_roi = CameraRoi(
                corners=[[float(p[0]), float(p[1])] for p in corners],
                updated_at=time.time(),
            )
        cam_roi_persist.save(self.camera_roi, CAMERA_ROI_PATH)
        await self.bus.broadcast(
            CameraRoiUpdatedEvent(camera_roi=self.camera_roi)
        )

    def request_detect_grid(self) -> None:
        """Queue a one-shot mat-grid detection on the next frame; result broadcast as MatGridDetectedEvent."""
        self._detect_grid_pending = True

    async def start_calibration(self, method: CalibrationMethod = "aruco") -> None:
        if self.projector_dims is None:
            log.warning("start_calibration called but no projector has registered yet")
            return
        if self.work_surface is None:
            self.work_surface = ws_persist.default_for(*self.projector_dims)
        proj_w, proj_h = self.projector_dims
        self._calibration_method = method
        self._calibration_proj_w = proj_w
        self._calibration_proj_h = proj_h
        self._calibration_layout = make_projection_layout(self.work_surface)
        self._calibration_captures.clear()
        self._calibration_dots_cam = []
        self._calibration_dot_count = 0
        self._last_full_dots_cam = []
        self._last_full_dots_ts = 0.0
        self._last_grid_capture = None
        self._last_grid_capture_ts = 0.0
        self._latest_grid_status = None
        self._last_grid_diagnostic = None
        self._last_grid_log_ts = 0.0
        self._last_grid_preview_jpeg = None
        self._last_grid_rectified_jpeg = None
        await self.set_mode("calibrate")
        await self.bus.broadcast(
            CalibrationPromptEvent(
                markers=self._calibration_layout,
                marker_size_px=CALIBRATION_MARKER_TOTAL_PX,
                method=method,
            )
        )

    async def finish_calibration(self, horizontal_mm: float | None) -> None:
        grid = self._last_grid_capture
        grid_fresh = (
            grid is not None
            and grid.detected
            and grid.confidence >= MAT_GRID_CONFIDENCE_MIN
            and (time.time() - self._last_grid_capture_ts) < 2.0
        )

        if self._calibration_method == "grid":
            # Grid-only path: 4 detected dots + a fresh grid capture.
            if len(self._calibration_dots_cam) != 4:
                log.warning(
                    "finish_calibration (grid): need 4 detected dots, have %d",
                    len(self._calibration_dots_cam),
                )
                return
            if not grid_fresh or grid is None:
                log.warning(
                    "finish_calibration (grid): no fresh mat-grid capture available"
                )
                return
            log.info(
                "finishing grid-only calibration (%s, %d subdivisions, "
                "%d intersections, confidence=%.2f)",
                grid.grid_system,
                grid.subdivisions_per_major,
                int(grid.intersections_cam.shape[0]),
                grid.confidence,
            )
            calib = compute_grid_only_calibration(
                dots_cam=self._calibration_dots_cam,
                grid_capture=grid,
                layout=self._calibration_layout,
                proj_w=self._calibration_proj_w,
                proj_h=self._calibration_proj_h,
            )
        else:
            # ArUco path (active ruler OR passive grid-scale).
            if not self._calibration_captures:
                log.warning("finish_calibration called but no marker captures yet")
                return
            averaged = average_captures(self._calibration_captures)
            if horizontal_mm is None:
                if not grid_fresh or grid is None:
                    log.warning(
                        "finish_calibration omitted horizontal_mm but no fresh grid "
                        "capture is available — refusing to calibrate"
                    )
                    return
                log.info(
                    "finishing calibration via passive grid (%s, %d subdivisions, "
                    "%d intersections, confidence=%.2f)",
                    grid.grid_system,
                    grid.subdivisions_per_major,
                    int(grid.intersections_cam.shape[0]),
                    grid.confidence,
                )
                calib = compute_passive_calibration(
                    aruco_capture=averaged,
                    grid_capture=grid,
                    layout=self._calibration_layout,
                    proj_w=self._calibration_proj_w,
                    proj_h=self._calibration_proj_h,
                )
            else:
                calib = compute_calibration(
                    capture=averaged,
                    layout=self._calibration_layout,
                    proj_w=self._calibration_proj_w,
                    proj_h=self._calibration_proj_h,
                    horizontal_mm=horizontal_mm,
                )
        save_calibration(calib, CALIBRATION_PATH)
        self.calibration = calib
        await self.bus.broadcast(CalibrationUpdatedEvent(calibration=calib))
        await self.set_mode("track")

    async def _run_calibrate_aruco_frame(self, frame, ts: float):
        """Per-frame ArUco-method calibrate work: detect markers, accumulate
        captures, and run mat-grid detection (gated on 4 markers, since the
        quad is the ROI and TL→TR is the axis-alignment baseline)."""
        capture = detect_projected_markers(frame)
        self._detector_runs += 1
        self._last_detected_count = len(capture.cam_corners_by_id)
        if len(capture.cam_corners_by_id) == 4:
            self._calibration_captures.append(capture)
            if len(self._calibration_captures) > 10:
                self._calibration_captures.pop(0)
            aruco_quad = np.array(
                [
                    capture.cam_corners_by_id[mid].mean(axis=0)
                    for mid in CALIBRATION_MARKER_IDS
                ],
                dtype=np.float64,
            )
            try:
                grid_capture = detect_mat_grid(frame, aruco_quad)
            except Exception as e:  # noqa: BLE001
                log.warning("mat-grid detector raised: %s", e)
                grid_capture = MatGridCapture.failure(f"detector error: {e}")
            self._latest_grid_status = grid_capture_to_status(grid_capture)
            if (
                grid_capture.detected
                and grid_capture.confidence >= MAT_GRID_CONFIDENCE_MIN
            ):
                self._last_grid_capture = grid_capture
                self._last_grid_capture_ts = ts
        else:
            self._latest_grid_status = MatGridStatus(
                detected=False,
                reason="waiting for 4 ArUco markers",
            )
        return capture

    async def _run_calibrate_grid_frame(self, frame, ts: float) -> None:
        """Per-frame grid-method calibrate work: detect 4 bright dots and
        run grid detection over the work-surface region.

        The 4 detected dots are projected at the work-surface corners, so
        their cam_px positions delimit the user's chosen working area. We
        scope grid detection to that quad — same as ArUco mode — so wood
        grain, table edges, shelves, etc. outside the work surface don't
        feed the line detector. Falls back to full-frame detection only
        when the dot quad isn't available yet (so the diagnostic overlay
        still shows whatever lines exist while the user is positioning the
        camera).
        """
        sorted_dots, dot_count = detect_calibration_dots(frame)
        self._detector_runs += 1
        self._last_detected_count = dot_count
        # Refresh the persistent 4-dot snapshot when this frame is fully
        # sortable; otherwise hold the previous snapshot for up to
        # DOT_GRACE_PERIOD_S so a single-frame miss doesn't strip the labels
        # off the preview. After grace expires, fall through to the raw
        # (possibly partial) detection.
        if len(sorted_dots) == 4:
            self._last_full_dots_cam = sorted_dots
            self._last_full_dots_ts = ts
        if (
            len(self._last_full_dots_cam) == 4
            and (ts - self._last_full_dots_ts) < DOT_GRACE_PERIOD_S
        ):
            self._calibration_dots_cam = self._last_full_dots_cam
            self._calibration_dot_count = 4
        else:
            self._calibration_dots_cam = sorted_dots
            self._calibration_dot_count = dot_count
        roi_quad = self._compute_grid_roi_quad()
        try:
            grid_capture = self._run_grid_detection_with_keystone(frame, roi_quad)
        except Exception as e:  # noqa: BLE001
            log.warning("mat-grid detector raised: %s", e)
            grid_capture = MatGridCapture.failure(f"detector error: {e}")
        self._latest_grid_status = grid_capture_to_status(grid_capture)
        self._last_grid_diagnostic = grid_capture
        self._update_grid_preview_jpeg(frame, grid_capture, roi_quad)
        self._update_grid_rectified_jpeg(frame, grid_capture, roi_quad)
        if (
            grid_capture.detected
            and grid_capture.confidence >= MAT_GRID_CONFIDENCE_MIN
        ):
            self._last_grid_capture = grid_capture
            self._last_grid_capture_ts = ts
        # Periodic INFO summary so the user can read what the detector is
        # doing without enabling DEBUG. ~1 Hz keeps the log readable.
        if ts - self._last_grid_log_ts >= 1.0:
            log.info(
                "grid calibrate: detected=%s reason=%r dots=%d/4 "
                "weak=%d strong=%d axis_a=%d axis_b=%d diag=%d intersections=%d",
                grid_capture.detected,
                grid_capture.reason,
                dot_count,
                int(grid_capture.weak_lines_cam.shape[0]),
                int(grid_capture.strong_lines_cam.shape[0]),
                int(grid_capture.axis_a_lines_cam.shape[0]),
                int(grid_capture.axis_b_lines_cam.shape[0]),
                int(grid_capture.diagonal_lines_cam.shape[0]),
                int(grid_capture.intersections_cam.shape[0]),
            )
            self._last_grid_log_ts = ts

    def _update_grid_preview_jpeg(
        self,
        frame: np.ndarray,
        grid_capture: MatGridCapture,
        roi_quad: np.ndarray | None,
    ) -> None:
        """Render the "what OpenCV sees" preview frame and cache it as JPEG.

        Layout: full-frame green-suppressed grayscale on the outside, CLAHE'd
        ROI inside the work-surface bounding box, Canny edges painted in red
        on top of the CLAHE'd region, and the ROI quad outlined in cyan.
        Skipped (cache cleared) when there's no usable preprocessing yet.
        """
        pre = grid_capture.preprocessing
        if pre is None or frame is None or frame.size == 0:
            self._last_grid_preview_jpeg = None
            return
        h, w = frame.shape[:2]
        out = cv2.cvtColor(pre.gray_full, cv2.COLOR_GRAY2BGR)
        # Dim the outside-ROI region so the user's eye is drawn to the area
        # the detector actually consumes.
        out = (out.astype(np.int32) * 0.5).clip(0, 255).astype(np.uint8)

        clahe_roi = pre.clahe_roi
        edges_roi = pre.edges_roi
        rh, rw = clahe_roi.shape[:2]
        ox, oy = int(pre.roi_origin[0]), int(pre.roi_origin[1])
        rh = min(rh, h - oy)
        rw = min(rw, w - ox)
        if rh > 0 and rw > 0:
            roi_bgr = cv2.cvtColor(clahe_roi[:rh, :rw], cv2.COLOR_GRAY2BGR)
            # Paint Canny edges bright red on top so the user can see exactly
            # what feeds Hough — gradient transitions are foreground; smooth
            # mat areas are background.
            edge_mask = edges_roi[:rh, :rw] > 0
            roi_bgr[edge_mask] = (60, 60, 255)  # BGR red
            out[oy : oy + rh, ox : ox + rw] = roi_bgr

        if roi_quad is not None and roi_quad.shape == (4, 2):
            pts = roi_quad.astype(np.int32).reshape(-1, 1, 2)
            cv2.polylines(
                out, [pts], isClosed=True, color=(255, 255, 0), thickness=2
            )  # cyan in BGR

        ok, enc = cv2.imencode(".jpg", out, [cv2.IMWRITE_JPEG_QUALITY, 70])
        if ok:
            self._last_grid_preview_jpeg = enc.tobytes()

    def _run_grid_detection_with_keystone(
        self, frame: np.ndarray, roi_quad: np.ndarray | None
    ) -> MatGridCapture:
        """Apply user-provided keystone correction (the camera-ROI polygon)
        before grid detection so the detector sees an orthogonal grid.

        Skipped when no manual polygon is set OR the polygon is essentially
        axis-aligned (auto-derived rectangle from the work-surface) — in
        those cases we just run `detect_mat_grid` on the original frame
        with the quad as the ROI.

        When keystone is applied:
          - Compute H_quad_to_rect mapping the user's 4 corners to a
            rectangle whose dimensions are the average of opposite edge
            lengths (preserves apparent mat aspect ratio).
          - Warp the frame via cv2.warpPerspective to produce the rectified
            input.
          - Run detect_mat_grid on the rectified frame (no ROI quad needed —
            the rectified frame *is* the work area).
          - Transform every spatial output back to cam_px via the inverse
            homography so the rest of the pipeline (overlays, calibration)
            keeps working in original camera coordinates.
        """
        if roi_quad is None or roi_quad.shape != (4, 2):
            return detect_mat_grid(frame, roi_quad)

        # Keystone correction is only worthwhile when the manual polygon is
        # set — auto-derived quads are already axis-aligned rectangles and
        # don't benefit. We detect "manual polygon" by checking whether the
        # current camera_roi exists.
        if self.camera_roi is None:
            return detect_mat_grid(frame, roi_quad)

        tl, tr, br, bl = roi_quad[0], roi_quad[1], roi_quad[2], roi_quad[3]
        top_w = float(np.linalg.norm(tr - tl))
        bot_w = float(np.linalg.norm(br - bl))
        left_h = float(np.linalg.norm(bl - tl))
        right_h = float(np.linalg.norm(br - tr))
        out_w = int(round((top_w + bot_w) / 2.0))
        out_h = int(round((left_h + right_h) / 2.0))
        if out_w < 50 or out_h < 50:
            return detect_mat_grid(frame, roi_quad)

        target = np.array(
            [[0, 0], [out_w, 0], [out_w, out_h], [0, out_h]], dtype=np.float32
        )
        try:
            h_quad_to_rect = cv2.getPerspectiveTransform(
                roi_quad.astype(np.float32), target
            )
            warped = cv2.warpPerspective(
                frame, h_quad_to_rect, (out_w, out_h),
                flags=cv2.INTER_LINEAR,
                borderMode=cv2.BORDER_CONSTANT,
                borderValue=(0, 0, 0),
            )
        except cv2.error:
            return detect_mat_grid(frame, roi_quad)

        capture = detect_mat_grid(warped, None)

        try:
            h_rect_to_cam = np.linalg.inv(h_quad_to_rect.astype(np.float64))
        except np.linalg.LinAlgError:
            return capture

        # Transform every spatial output back into cam-pixel coordinates.
        # Lines are stored as (x1, y1, x2, y2) per row; reshape to (N, 2, 2)
        # so we can run perspectiveTransform on all endpoints in one call.
        def warp_points(arr: np.ndarray) -> np.ndarray:
            if arr is None or arr.size == 0:
                return arr
            pts = arr.astype(np.float64).reshape(-1, 1, 2)
            warped_pts = cv2.perspectiveTransform(pts, h_rect_to_cam)
            return warped_pts.reshape(arr.shape)

        def warp_lines(arr: np.ndarray) -> np.ndarray:
            if arr is None or arr.size == 0:
                return arr
            n = arr.shape[0]
            endpoints = arr.astype(np.float64).reshape(n * 2, 1, 2)
            warped_endpoints = cv2.perspectiveTransform(endpoints, h_rect_to_cam)
            return warped_endpoints.reshape(n, 4)

        capture.intersections_cam = warp_points(capture.intersections_cam)
        capture.weak_lines_cam = warp_lines(capture.weak_lines_cam)
        capture.strong_lines_cam = warp_lines(capture.strong_lines_cam)
        capture.axis_a_lines_cam = warp_lines(capture.axis_a_lines_cam)
        capture.axis_b_lines_cam = warp_lines(capture.axis_b_lines_cam)
        capture.diagonal_lines_cam = warp_lines(capture.diagonal_lines_cam)
        # The pitch in cam_px is no longer well-defined after warping (the
        # keystone-corrected pitch is uniform but the cam_px pitch varies
        # across the polygon). Use the rectified pitch as an estimate —
        # callers that need a precise cam_px pitch should query
        # H_cam_to_mat directly rather than reading these fields.

        return capture

    def _update_grid_rectified_jpeg(
        self,
        frame: np.ndarray,
        grid_capture: MatGridCapture,
        roi_quad: np.ndarray | None,
    ) -> None:
        """Warp the camera frame using H_cam_to_mat (built from the detected
        grid intersections) so the cutting-mat grid appears straight — i.e.
        camera keystone removed. Overlays a thin orthogonal grid in mat-mm
        coords so the user can verify the rectification is accurate (lines
        on the warped image should fall on top of the overlay).
        Skipped (cache cleared) when grid detection or homography fitting
        hasn't produced a usable result yet.
        """
        h_cam_to_mat = compute_grid_homography(grid_capture)
        if h_cam_to_mat is None or roi_quad is None or roi_quad.shape != (4, 2):
            self._last_grid_rectified_jpeg = None
            return
        # Project the ROI corners into mat_mm to size the output canvas.
        quad_cam = roi_quad.astype(np.float64).reshape(-1, 1, 2)
        quad_mat = cv2.perspectiveTransform(quad_cam, h_cam_to_mat).reshape(-1, 2)
        min_x = float(quad_mat[:, 0].min())
        max_x = float(quad_mat[:, 0].max())
        min_y = float(quad_mat[:, 1].min())
        max_y = float(quad_mat[:, 1].max())
        bbox_w_mm = max_x - min_x
        bbox_h_mm = max_y - min_y
        if bbox_w_mm <= 0 or bbox_h_mm <= 0:
            self._last_grid_rectified_jpeg = None
            return
        # Pick output dims — preserve aspect ratio, cap longest side at 600 px.
        target = 600
        if bbox_w_mm >= bbox_h_mm:
            out_w = target
            out_h = max(1, int(round(target * bbox_h_mm / bbox_w_mm)))
        else:
            out_h = target
            out_w = max(1, int(round(target * bbox_w_mm / bbox_h_mm)))
        scale_x = out_w / bbox_w_mm
        scale_y = out_h / bbox_h_mm
        # Translation + scale that maps mat_mm bbox → output pixels.
        T = np.array(
            [
                [scale_x, 0.0, -min_x * scale_x],
                [0.0, scale_y, -min_y * scale_y],
                [0.0, 0.0, 1.0],
            ],
            dtype=np.float64,
        )
        try:
            warped = cv2.warpPerspective(
                frame, T @ h_cam_to_mat, (out_w, out_h),
                flags=cv2.INTER_LINEAR,
                borderMode=cv2.BORDER_CONSTANT,
                borderValue=(0, 0, 0),
            )
        except cv2.error:
            self._last_grid_rectified_jpeg = None
            return

        # Reference grid overlay: orthogonal lines at every major-pitch step
        # in mat_mm. If rectification is correct the warped grid lines match
        # the overlay precisely; mismatches highlight homography errors.
        pitch_mm = grid_capture.major_pitch_mm
        if pitch_mm > 0:
            x = math.ceil(min_x / pitch_mm) * pitch_mm
            while x <= max_x + 1e-6:
                px = int(round((x - min_x) * scale_x))
                if 0 <= px < out_w:
                    cv2.line(warped, (px, 0), (px, out_h - 1), (255, 200, 0), 1)
                x += pitch_mm
            y = math.ceil(min_y / pitch_mm) * pitch_mm
            while y <= max_y + 1e-6:
                py = int(round((y - min_y) * scale_y))
                if 0 <= py < out_h:
                    cv2.line(warped, (0, py), (out_w - 1, py), (255, 200, 0), 1)
                y += pitch_mm

        ok, enc = cv2.imencode(".jpg", warped, [cv2.IMWRITE_JPEG_QUALITY, 70])
        if ok:
            self._last_grid_rectified_jpeg = enc.tobytes()

    def _apply_camera_roi_mask(self, frame: np.ndarray) -> np.ndarray:
        """Black out pixels outside the manual camera ROI polygon; return the
        masked frame (or the original when no ROI is set). Detectors see
        only inside-polygon content; the regular MJPEG preview pulls from
        the camera directly and is unaffected.
        """
        roi = self.camera_roi
        if roi is None or len(roi.corners) != 4:
            return frame
        h, w = frame.shape[:2]
        polygon = np.array(roi.corners, dtype=np.int32).reshape(-1, 1, 2)
        mask = np.zeros((h, w), dtype=np.uint8)
        cv2.fillPoly(mask, [polygon], 255)
        if frame.ndim == 3:
            mask3 = cv2.cvtColor(mask, cv2.COLOR_GRAY2BGR)
            return cv2.bitwise_and(frame, mask3)
        return cv2.bitwise_and(frame, mask)

    def _compute_grid_roi_quad(self) -> np.ndarray | None:
        """Pick the camera-frame ROI quad for grid detection.

        Priority:
          1. Manual `camera_roi` (set via the control panel) — overrides
             everything else, used verbatim as an axis-aligned quad.
          2. Work-surface rectangle projected through a coarse proj→cam
             homography fit from the 4 detected dots.
          3. The dot quad itself, as a fallback.

        Returns `None` when no usable ROI can be built (e.g. fewer than 4
        dots are visible and no manual ROI is set).
        """
        if self.camera_roi is not None and len(self.camera_roi.corners) == 4:
            return np.array(self.camera_roi.corners, dtype=np.float64)
        if len(self._calibration_dots_cam) != 4:
            return None
        if (
            self.work_surface is None
            or len(self._calibration_layout) != 4
        ):
            return np.stack(self._calibration_dots_cam, axis=0).astype(np.float64)
        proj_pts = np.array(
            [[m.proj_x, m.proj_y] for m in self._calibration_layout],
            dtype=np.float32,
        )
        cam_pts = np.array(self._calibration_dots_cam, dtype=np.float32)
        h_proj_to_cam, _ = cv2.findHomography(proj_pts, cam_pts, method=0)
        if h_proj_to_cam is None:
            return np.stack(self._calibration_dots_cam, axis=0).astype(np.float64)
        ws = self.work_surface
        ws_corners_proj = np.array(
            [
                [ws.x, ws.y],                              # TL
                [ws.x + ws.width, ws.y],                   # TR
                [ws.x + ws.width, ws.y + ws.height],       # BR
                [ws.x, ws.y + ws.height],                  # BL
            ],
            dtype=np.float32,
        ).reshape(-1, 1, 2)
        ws_corners_cam = cv2.perspectiveTransform(
            ws_corners_proj, h_proj_to_cam
        ).reshape(-1, 2)
        return ws_corners_cam.astype(np.float64)

    @staticmethod
    def _grid_diagnostic_event(
        cap: MatGridCapture, frame_w: int, frame_h: int
    ) -> MatGridDetectedEvent:
        """Serialize a MatGridCapture into a MatGridDetectedEvent. Single
        builder used by the explicit one-shot trigger and the per-frame
        grid-calibrate broadcast so both produce the same overlay payload."""

        def segs(arr) -> list[list[float]]:
            if arr is None or arr.size == 0:
                return []
            return arr.reshape(-1, arr.shape[-1]).tolist()

        return MatGridDetectedEvent(
            grid=grid_capture_to_status(cap),
            frame_width=frame_w,
            frame_height=frame_h,
            intersections_cam=segs(cap.intersections_cam),
            weak_lines_cam=segs(cap.weak_lines_cam),
            strong_lines_cam=segs(cap.strong_lines_cam),
            axis_a_lines_cam=segs(cap.axis_a_lines_cam),
            axis_b_lines_cam=segs(cap.axis_b_lines_cam),
            diagonal_lines_cam=segs(cap.diagonal_lines_cam),
        )

    async def _broadcast_calibrate_grid(self, frame) -> None:
        h, w = frame.shape[:2]
        dots_payload = [d.tolist() for d in self._calibration_dots_cam]
        await self.bus.broadcast(
            CalibrationCapturedEvent(
                method="grid",
                detected_marker_ids=[],
                detected_corners_cam=[],
                frame_width=w,
                frame_height=h,
                rejected_count=0,
                mat_grid=self._latest_grid_status,
                detected_dots_cam=dots_payload,
                detected_dot_count=self._calibration_dot_count,
            )
        )
        # Also push the latest diagnostic line snapshot so the camera-preview
        # overlay shows what the detector is seeing live, without requiring
        # an explicit Detect-grid click.
        cap = self._last_grid_diagnostic
        if cap is not None:
            await self.bus.broadcast(self._grid_diagnostic_event(cap, w, h))

    async def _run_loop(self) -> None:
        last_calib_broadcast = 0.0
        calib_interval = 1.0 / 6.0
        prev_ts = 0.0
        try:
            while True:
                await asyncio.sleep(0.005)
                if self.camera is None:
                    await asyncio.sleep(0.1)
                    continue
                latest = self.camera.read_latest()
                if latest is None:
                    continue
                frame, ts = latest
                if ts == self._last_frame_ts:
                    # Haven't received a new frame from the grabber yet; don't double-count.
                    continue

                # Frame stats: cumulative count + EMA of FPS.
                self._frame_index += 1
                self._last_frame_ts = ts
                if prev_ts > 0:
                    dt = ts - prev_ts
                    if dt > 0:
                        inst_fps = 1.0 / dt
                        self._fps = (
                            self._fps * 0.9 + inst_fps * 0.1
                            if self._fps > 0
                            else inst_fps
                        )
                prev_ts = ts

                # Apply the manual camera ROI (if set) before any detector
                # sees the frame. Pixels outside the ROI are blacked out so
                # ArUco detection, dot detection, mat-grid, object tracking,
                # and hand detection all ignore them. The MJPEG preview
                # endpoint reads from the camera directly and stays
                # unaffected — outside-ROI pixels are still visible to the
                # user, just not to the detectors.
                detect_frame = self._apply_camera_roi_mask(frame)

                # One-shot explicit grid detection. Runs regardless of mode and
                # uses the manual ROI quad if set, else the full (already-
                # masked) frame.
                if self._detect_grid_pending:
                    self._detect_grid_pending = False
                    explicit_quad = self._compute_grid_roi_quad()
                    try:
                        explicit_grid = detect_mat_grid(detect_frame, explicit_quad)
                    except Exception as e:  # noqa: BLE001
                        log.warning("explicit mat-grid detection raised: %s", e)
                        explicit_grid = MatGridCapture.failure(f"detector error: {e}")
                    fh, fw = detect_frame.shape[:2]
                    log.info(
                        "explicit mat-grid detection: detected=%s reason=%r "
                        "weak=%d strong=%d axis_a=%d axis_b=%d diag=%d intersections=%d",
                        explicit_grid.detected,
                        explicit_grid.reason,
                        int(explicit_grid.weak_lines_cam.shape[0]),
                        int(explicit_grid.strong_lines_cam.shape[0]),
                        int(explicit_grid.axis_a_lines_cam.shape[0]),
                        int(explicit_grid.axis_b_lines_cam.shape[0]),
                        int(explicit_grid.diagonal_lines_cam.shape[0]),
                        int(explicit_grid.intersections_cam.shape[0]),
                    )
                    await self.bus.broadcast(
                        self._grid_diagnostic_event(explicit_grid, fw, fh)
                    )

                if self.mode == "calibrate":
                    if self._calibration_method == "grid":
                        await self._run_calibrate_grid_frame(detect_frame, ts)
                        if ts - last_calib_broadcast >= calib_interval:
                            await self._broadcast_calibrate_grid(detect_frame)
                            last_calib_broadcast = ts
                    else:
                        capture = await self._run_calibrate_aruco_frame(detect_frame, ts)
                        if ts - last_calib_broadcast >= calib_interval:
                            h, w = detect_frame.shape[:2]
                            ids = sorted(capture.cam_corners_by_id.keys())
                            corners = [
                                capture.cam_corners_by_id[mid].tolist() for mid in ids
                            ]
                            await self.bus.broadcast(
                                CalibrationCapturedEvent(
                                    method="aruco",
                                    detected_marker_ids=ids,
                                    detected_corners_cam=corners,
                                    frame_width=w,
                                    frame_height=h,
                                    rejected_count=capture.rejected_count,
                                    mat_grid=self._latest_grid_status,
                                )
                            )
                            last_calib_broadcast = ts
                elif self.mode == "track" and self.calibration is not None:
                    # Detect objects + hands on every frame. Broadcast only when
                    # something has actually changed (new marker, marker disappeared
                    # past grace period, or pose moved beyond sensor-noise thresholds)
                    # so we don't chatter the WS with sub-mm jitter while objects sit
                    # still. Hand detection feeds the glue logic below — when a marker
                    # disappears with a fingertip on it, we drag the marker with the
                    # finger instead of letting it flicker off.
                    objects = self.detector.detect(detect_frame, self.calibration)
                    self._detector_runs += 1
                    self._last_detected_count = len(objects)
                    now = now_ts()

                    hands: list[DetectedHand] = []
                    if self.hand_detector is not None:
                        hands = self.hand_detector.detect(
                            detect_frame, self.calibration, int(ts * 1000)
                        )

                    # 1. Fresh detections always win: clear glue, refresh timestamp.
                    fresh_ids: set[int] = set()
                    for obj in objects:
                        fresh_ids.add(obj.marker_id)
                        self._tracked_objects[obj.marker_id] = TrackedObject(
                            last_obj=obj, last_seen_ts=now, glue=None
                        )

                    # 2. For tracked markers without a fresh detection: maintain or
                    # establish a glue. Either path keeps last_seen_ts current so the
                    # grace-period filter in step 3 doesn't drop the entry. Pose each
                    # frame is derived from the glue's frozen baseline + current
                    # fingertip + finger angle, so rotation/translation can't drift.
                    for mid, t in self._tracked_objects.items():
                        if mid in fresh_ids:
                            continue
                        if t.glue is None:
                            match = _find_fingertip_over(hands, t.last_obj, GLUE_PAD_MM)
                            if match is not None:
                                handedness, idx, fingertip, finger_angle = match
                                t.glue = GlueState(
                                    handedness=handedness,
                                    landmark_idx=idx,
                                    frozen_obj=t.last_obj,
                                    frozen_fingertip_mm=fingertip,
                                    frozen_finger_angle_rad=finger_angle,
                                    created_ts=now,
                                )
                                t.last_seen_ts = now
                        else:
                            if now - t.glue.created_ts > GLUE_TIMEOUT_S:
                                t.glue = None
                            else:
                                pose = _find_finger_pose(
                                    hands, t.glue.handedness, t.glue.landmark_idx
                                )
                                if pose is None:
                                    t.glue = None
                                else:
                                    tip_mm, finger_angle = pose
                                    delta_rad = _angle_delta_rad(
                                        finger_angle,
                                        t.glue.frozen_finger_angle_rad,
                                    )
                                    t.last_obj = _glued_object(
                                        t.glue.frozen_obj,
                                        t.glue.frozen_fingertip_mm,
                                        tip_mm,
                                        delta_rad,
                                    )
                                    t.last_seen_ts = now

                    # 3. Apply grace period — drop entries we haven't seen recently
                    # (real detection or active glue both refresh last_seen_ts).
                    cutoff = now - TRACK_GRACE_PERIOD_S
                    self._tracked_objects = {
                        mid: t
                        for mid, t in self._tracked_objects.items()
                        if t.last_seen_ts >= cutoff
                    }

                    # 4. Build the broadcast set — real detections plus glued positions
                    # look identical on the wire.
                    current = {
                        mid: t.last_obj for mid, t in self._tracked_objects.items()
                    }
                    if _detections_changed(current, self._last_broadcast_objects):
                        await self.bus.broadcast(
                            DetectionsEvent(objects=list(current.values()), ts=now)
                        )
                        self._last_broadcast_objects = current

                    # 5. Hand broadcast: every frame hands are present, plus a single
                    # empty on the absent transition so the UI clears the skeleton.
                    if self.hand_detector is not None:
                        if hands or self._last_hands_present:
                            await self.bus.broadcast(
                                HandsEvent(hands=hands, ts=now)
                            )
                            self._last_hands_present = bool(hands)
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("frame loop crashed")
            raise


state = AppState()


@asynccontextmanager
async def lifespan(app: FastAPI):
    await state.start()
    try:
        yield
    finally:
        await state.stop()


app = FastAPI(lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class LaunchProjectorRequest(BaseModel):
    x: int
    y: int
    width: int
    height: int


@app.get("/displays")
async def get_displays():
    return {
        "displays": [d.to_dict() for d in list_displays()],
        "projector_running": state.launcher.is_running(),
    }


@app.post("/launch_projector")
async def launch_projector(req: LaunchProjectorRequest):
    try:
        state.launch_projector(req.x, req.y, req.width, req.height)
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))
    return {"ok": True}


@app.post("/close_projector")
async def close_projector():
    state.launcher.close()
    state.preferences.projector_display = None
    prefs_persist.save(state.preferences, PREFERENCES_PATH)
    return {"ok": True}


@app.get("/cameras")
async def get_cameras():
    return {
        "cameras": [c.to_dict() for c in list_cameras()],
        "current_index": state.camera_index,
        "camera_open": state.camera is not None,
    }


def _mjpeg_generator():
    boundary = b"--frame\r\n"
    placeholder_emitted = False
    while True:
        cam = state.camera
        if cam is None:
            if not placeholder_emitted:
                # Emit a single 1x1 black JPEG so the <img> doesn't show a broken icon.
                ok, png = cv2.imencode(".jpg", np.zeros((1, 1, 3), dtype=np.uint8))
                if ok:
                    yield boundary + b"Content-Type: image/jpeg\r\n\r\n" + png.tobytes() + b"\r\n"
                placeholder_emitted = True
            time.sleep(0.2)
            continue
        placeholder_emitted = False
        latest = cam.read_latest()
        if latest is None:
            time.sleep(0.05)
            continue
        frame, _ts = latest
        ok, jpeg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 70])
        if not ok:
            time.sleep(0.05)
            continue
        yield boundary + b"Content-Type: image/jpeg\r\n\r\n" + jpeg.tobytes() + b"\r\n"
        time.sleep(0.05)


@app.get("/camera/preview.mjpg")
async def camera_preview():
    return StreamingResponse(
        _mjpeg_generator(),
        media_type="multipart/x-mixed-replace; boundary=frame",
    )


def _grid_preview_generator():
    """Stream the cached "what OpenCV sees" frame: green-suppressed gray with
    the CLAHE'd ROI + Canny edges + ROI bbox painted on top. Updated by the
    grid-calibrate frame loop; serves a single placeholder JPEG when no
    preview is cached yet."""
    boundary = b"--frame\r\n"
    placeholder = None
    while True:
        jpeg = state._last_grid_preview_jpeg
        if jpeg is None:
            if placeholder is None:
                ok, enc = cv2.imencode(
                    ".jpg", np.zeros((1, 1, 3), dtype=np.uint8)
                )
                placeholder = enc.tobytes() if ok else b""
            yield boundary + b"Content-Type: image/jpeg\r\n\r\n" + placeholder + b"\r\n"
            time.sleep(0.2)
            continue
        yield boundary + b"Content-Type: image/jpeg\r\n\r\n" + jpeg + b"\r\n"
        time.sleep(0.1)


@app.get("/camera/grid_preview.mjpg")
async def grid_preview():
    return StreamingResponse(
        _grid_preview_generator(),
        media_type="multipart/x-mixed-replace; boundary=frame",
    )


def _grid_rectified_generator():
    """Stream the keystone-corrected camera frame: detected grid lines used as
    ground truth to warp the cutting mat into a straight orthogonal view."""
    boundary = b"--frame\r\n"
    placeholder = None
    while True:
        jpeg = state._last_grid_rectified_jpeg
        if jpeg is None:
            if placeholder is None:
                ok, enc = cv2.imencode(".jpg", np.zeros((1, 1, 3), dtype=np.uint8))
                placeholder = enc.tobytes() if ok else b""
            yield boundary + b"Content-Type: image/jpeg\r\n\r\n" + placeholder + b"\r\n"
            time.sleep(0.2)
            continue
        yield boundary + b"Content-Type: image/jpeg\r\n\r\n" + jpeg + b"\r\n"
        time.sleep(0.1)


@app.get("/camera/grid_rectified.mjpg")
async def grid_rectified():
    return StreamingResponse(
        _grid_rectified_generator(),
        media_type="multipart/x-mixed-replace; boundary=frame",
    )


@app.get("/markers/{marker_id}.png")
async def marker_png(marker_id: int) -> Response:
    """Marker PNG with a white quiet zone around it.

    The ArUco marker itself has a 1-cell BLACK border. If we project that directly onto
    the projector's black background, the marker's outer edge has zero contrast with the
    surrounding pixels and the detector can't find the marker at all. Padding with white
    gives the boundary detector something to lock onto.
    """
    if not 0 <= marker_id < 50:
        raise HTTPException(status_code=404, detail="marker out of range")
    aruco_dict = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50)
    marker = cv2.aruco.generateImageMarker(
        aruco_dict, marker_id, CALIBRATION_MARKER_INNER_PX
    )
    canvas = np.full(
        (CALIBRATION_MARKER_TOTAL_PX, CALIBRATION_MARKER_TOTAL_PX), 255, dtype=np.uint8
    )
    canvas[
        CALIBRATION_MARKER_QUIET_ZONE_PX : CALIBRATION_MARKER_QUIET_ZONE_PX
        + CALIBRATION_MARKER_INNER_PX,
        CALIBRATION_MARKER_QUIET_ZONE_PX : CALIBRATION_MARKER_QUIET_ZONE_PX
        + CALIBRATION_MARKER_INNER_PX,
    ] = marker
    ok, png = cv2.imencode(".png", canvas)
    if not ok:
        raise HTTPException(status_code=500, detail="png encode failed")
    return Response(content=png.tobytes(), media_type="image/png")


@app.get("/healthz")
async def healthz():
    return {
        "ok": True,
        "mode": state.mode,
        "has_camera": state.camera is not None,
        "has_calibration": state.calibration is not None,
    }


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket) -> None:
    await ws.accept()
    await state.bus.add(ws)
    try:
        await ws.send_json(
            HelloEvent(
                mode=state.mode,
                calibration=state.calibration,
                projector=state.projector_dims,
                work_surface=state.work_surface,
                show_work_surface_outline=state.show_work_surface_outline,
                camera_index=state.camera_index,
                camera_open=state.camera is not None,
                camera_roi=state.camera_roi,
            ).model_dump(mode="json")
        )
        while True:
            msg = await ws.receive_json()
            mtype = msg.get("type")
            if mtype == "set_mode":
                await state.set_mode(msg["mode"])
            elif mtype == "register_projector":
                await state.register_projector(
                    int(msg["proj_width"]), int(msg["proj_height"])
                )
            elif mtype == "start_calibration":
                method = msg.get("method", "aruco")
                if method not in ("aruco", "grid"):
                    method = "aruco"
                await state.start_calibration(method)
            elif mtype == "finish_calibration":
                raw_mm = msg.get("horizontal_mm")
                horizontal_mm = float(raw_mm) if raw_mm is not None else None
                await state.finish_calibration(horizontal_mm)
            elif mtype == "detect_grid":
                state.request_detect_grid()
            elif mtype == "set_work_surface":
                await state.set_work_surface(
                    int(msg["x"]),
                    int(msg["y"]),
                    int(msg["width"]),
                    int(msg["height"]),
                    msg.get("show_outline"),
                )
            elif mtype == "set_camera":
                idx = msg.get("index")
                await state.set_camera(int(idx) if idx is not None else None)
            elif mtype == "set_camera_roi":
                await state.set_camera_roi(
                    msg.get("corners", []),
                    bool(msg.get("clear", False)),
                )
            else:
                log.warning("unknown command type: %s", mtype)
    except WebSocketDisconnect:
        pass
    finally:
        await state.bus.remove(ws)


def main() -> None:
    import uvicorn

    host = os.environ.get("SERVER_HOST", "127.0.0.1")
    port = int(os.environ.get("SERVER_PORT", "8000"))
    uvicorn.run("server.main:app", host=host, port=port, reload=False, log_level="info")


if __name__ == "__main__":
    main()
