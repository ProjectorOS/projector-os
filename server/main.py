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
    CALIBRATION_MARKER_QUIET_ZONE_PX,
    CALIBRATION_MARKER_TOTAL_PX,
    average_captures,
    compute_calibration,
    detect_projected_markers,
    load_calibration,
    make_projection_layout,
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
    CameraRoi,
    CameraRoiUpdatedEvent,
    DetectedHand,
    DetectedObject,
    DetectionsEvent,
    FrameStatsEvent,
    HandsEvent,
    HelloEvent,
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
PREFERENCES_PATH = DATA_DIR / "preferences.json"
CAMERA_ROI_PATH = DATA_DIR / "camera_roi.json"
# Keep a tracked object on the projection for this long after its marker stops being
# detected. Smooths over single-frame detection misses (occlusion by a hand, motion
# blur, glare) so objects don't flicker on/off.
TRACK_GRACE_PERIOD_S = 1
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
        # User-defined polygon on the camera frame (4 cam_px corners). No
        # server-side consumer yet — purely an annotation surfaced via the
        # camera card UI. None until the user defines one.
        self.camera_roi: CameraRoi | None = cam_roi_persist.load(CAMERA_ROI_PATH)
        self.camera_index: int | None = None
        self.launcher = ProjectorLauncher()
        self.preferences = prefs_persist.load(PREFERENCES_PATH)
        self.show_work_surface_outline: bool = (
            self.preferences.show_work_surface_outline
        )
        self._calibration_layout: list = []
        self._calibration_proj_w: int = 0
        self._calibration_proj_h: int = 0
        self._calibration_captures: list = []
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

    async def set_camera_roi(
        self,
        corners: list[list[float]],
        clear: bool,
        enabled: bool | None = None,
    ) -> None:
        # Three messages: clear (drop everything), update corners (replace
        # polygon, preserve enabled unless explicitly given), and toggle
        # enabled (no corners, just flip the visibility flag).
        if clear:
            self.camera_roi = None
        elif len(corners) == 4:
            new_enabled = (
                enabled
                if enabled is not None
                else (self.camera_roi.enabled if self.camera_roi else True)
            )
            self.camera_roi = CameraRoi(
                corners=[[float(p[0]), float(p[1])] for p in corners],
                enabled=bool(new_enabled),
                updated_at=time.time(),
            )
        elif enabled is not None and self.camera_roi is not None:
            self.camera_roi = CameraRoi(
                corners=self.camera_roi.corners,
                enabled=bool(enabled),
                updated_at=time.time(),
            )
        else:
            # Nothing to apply (no corners, no clear, no enabled-only on a
            # polygon). Treat as a no-op.
            return
        cam_roi_persist.save(self.camera_roi, CAMERA_ROI_PATH)
        await self.bus.broadcast(
            CameraRoiUpdatedEvent(camera_roi=self.camera_roi)
        )

    async def _broadcast_work_surface(self) -> None:
        if self.work_surface is None:
            return
        await self.bus.broadcast(
            WorkSurfaceUpdatedEvent(
                work_surface=self.work_surface,
                show_outline=self.show_work_surface_outline,
            )
        )

    async def start_calibration(self) -> None:
        if self.projector_dims is None:
            log.warning("start_calibration called but no projector has registered yet")
            return
        if self.work_surface is None:
            self.work_surface = ws_persist.default_for(*self.projector_dims)
        proj_w, proj_h = self.projector_dims
        self._calibration_proj_w = proj_w
        self._calibration_proj_h = proj_h
        self._calibration_layout = make_projection_layout(self.work_surface)
        self._calibration_captures.clear()
        await self.set_mode("calibrate")
        await self.bus.broadcast(
            CalibrationPromptEvent(
                markers=self._calibration_layout,
                marker_size_px=CALIBRATION_MARKER_TOTAL_PX,
            )
        )

    async def finish_calibration(self, horizontal_mm: float) -> None:
        if not self._calibration_captures:
            log.warning("finish_calibration called but no marker captures yet")
            return
        averaged = average_captures(self._calibration_captures)
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

                if self.mode == "calibrate":
                    capture = detect_projected_markers(frame)
                    self._detector_runs += 1
                    self._last_detected_count = len(capture.cam_corners_by_id)
                    if len(capture.cam_corners_by_id) == 4:
                        self._calibration_captures.append(capture)
                        if len(self._calibration_captures) > 10:
                            self._calibration_captures.pop(0)
                    if ts - last_calib_broadcast >= calib_interval:
                        h, w = frame.shape[:2]
                        ids = sorted(capture.cam_corners_by_id.keys())
                        corners = [
                            capture.cam_corners_by_id[mid].tolist() for mid in ids
                        ]
                        await self.bus.broadcast(
                            CalibrationCapturedEvent(
                                detected_marker_ids=ids,
                                detected_corners_cam=corners,
                                frame_width=w,
                                frame_height=h,
                                rejected_count=capture.rejected_count,
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
                    objects = self.detector.detect(frame, self.calibration)
                    self._detector_runs += 1
                    self._last_detected_count = len(objects)
                    now = now_ts()

                    hands: list[DetectedHand] = []
                    if self.hand_detector is not None:
                        hands = self.hand_detector.detect(
                            frame, self.calibration, int(ts * 1000)
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
                await state.start_calibration()
            elif mtype == "finish_calibration":
                await state.finish_calibration(float(msg["horizontal_mm"]))
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
                raw_enabled = msg.get("enabled")
                enabled = (
                    bool(raw_enabled) if raw_enabled is not None else None
                )
                await state.set_camera_roi(
                    msg.get("corners", []),
                    bool(msg.get("clear", False)),
                    enabled,
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
