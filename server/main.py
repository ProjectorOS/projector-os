from __future__ import annotations

import asyncio
import logging
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path

import cv2
import numpy as np
from fastapi import FastAPI, HTTPException, Response, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from server import preferences as prefs_persist
from server import work_surface as ws_persist
from server.bus import Bus
from server.calibration import (
    average_captures,
    compute_calibration,
    detect_projected_markers,
    load_calibration,
    make_projection_layout,
    save_calibration,
)
from server.camera import Camera, CameraConfig
from server.cameras import list_cameras
from server.detection import ObjectDetector, now_ts
from server.displays import list_displays
from server.launcher import ProjectorLauncher
from server.protocol import (
    Calibration,
    CalibrationCapturedEvent,
    CalibrationPromptEvent,
    CalibrationUpdatedEvent,
    CameraChangedEvent,
    DetectionsEvent,
    HelloEvent,
    Mode,
    ModeChangedEvent,
    ProjectorRegisteredEvent,
    WorkSurface,
    WorkSurfaceUpdatedEvent,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("server.main")

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
CALIBRATION_PATH = DATA_DIR / "calibration.json"
WORK_SURFACE_PATH = DATA_DIR / "work_surface.json"
PREFERENCES_PATH = DATA_DIR / "preferences.json"
DETECTION_BROADCAST_HZ = 20.0


class AppState:
    def __init__(self) -> None:
        self.bus = Bus()
        self.camera: Camera | None = None
        self.detector = ObjectDetector()
        self.calibration: Calibration | None = load_calibration(CALIBRATION_PATH)
        self.mode: Mode = "idle"
        self.projector_dims: tuple[int, int] | None = None
        self.work_surface: WorkSurface | None = ws_persist.load(WORK_SURFACE_PATH)
        self.camera_index: int | None = None
        self.launcher = ProjectorLauncher()
        self.preferences = prefs_persist.load(PREFERENCES_PATH)
        self.show_work_surface_outline: bool = self.preferences.show_work_surface_outline
        self._calibration_layout: list = []
        self._calibration_proj_w: int = 0
        self._calibration_proj_h: int = 0
        self._calibration_captures: list = []
        self._loop_task: asyncio.Task | None = None

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

        # Projector: re-launch the kiosk on the previously chosen display, after a short
        # delay so the Vite dev server is reachable.
        if self.preferences.projector_display is not None:
            asyncio.create_task(self._auto_launch_projector(), name="auto-launch-projector")

    async def _auto_launch_projector(self) -> None:
        await asyncio.sleep(2.0)
        d = self.preferences.projector_display
        if d is None or self.launcher.is_running():
            return
        log.info("restoring projector kiosk on saved display (%d, %d) %dx%d", d.x, d.y, d.width, d.height)
        try:
            self.launch_projector(d.x, d.y, d.width, d.height)
        except RuntimeError as e:
            log.warning("auto-launch failed: %s", e)

    def launch_projector(self, x: int, y: int, width: int, height: int) -> None:
        ui_port = int(os.environ.get("UI_PORT", "5173"))
        ui_url = f"http://localhost:{ui_port}/"
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
            await self.bus.broadcast(CameraChangedEvent(camera_index=None, camera_open=False))
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
        if self._loop_task:
            self._loop_task.cancel()
            try:
                await self._loop_task
            except asyncio.CancelledError:
                pass
        if self.camera:
            self.camera.close()
        self.launcher.close()

    async def set_mode(self, mode: Mode) -> None:
        self.mode = mode
        if mode != "calibrate":
            self._calibration_captures.clear()
        await self.bus.broadcast(ModeChangedEvent(mode=mode))

    async def register_projector(self, proj_w: int, proj_h: int) -> None:
        self.projector_dims = (proj_w, proj_h)
        # If we have no work surface yet, default to the full projector. If we have one
        # but the projector has resized, clamp it back into bounds.
        if self.work_surface is None:
            self.work_surface = ws_persist.default_for(proj_w, proj_h)
        else:
            self.work_surface = ws_persist.clamp(self.work_surface, proj_w, proj_h)
        await self.bus.broadcast(ProjectorRegisteredEvent(proj_width=proj_w, proj_height=proj_h))
        await self._broadcast_work_surface()

    async def set_work_surface(self, x: int, y: int, w: int, h: int, show_outline: bool | None) -> None:
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
        await self.bus.broadcast(CalibrationPromptEvent(markers=self._calibration_layout))

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
        last_track_broadcast = 0.0
        track_interval = 1.0 / DETECTION_BROADCAST_HZ
        last_calib_broadcast = 0.0
        calib_interval = 1.0 / 6.0
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

                if self.mode == "calibrate":
                    capture = detect_projected_markers(frame)
                    if len(capture.cam_corners_by_id) == 4:
                        self._calibration_captures.append(capture)
                        if len(self._calibration_captures) > 10:
                            self._calibration_captures.pop(0)
                    if ts - last_calib_broadcast >= calib_interval:
                        h, w = frame.shape[:2]
                        ids = sorted(capture.cam_corners_by_id.keys())
                        corners = [capture.cam_corners_by_id[mid].tolist() for mid in ids]
                        await self.bus.broadcast(
                            CalibrationCapturedEvent(
                                detected_marker_ids=ids,
                                detected_corners_cam=corners,
                                frame_width=w,
                                frame_height=h,
                            )
                        )
                        last_calib_broadcast = ts
                elif self.mode == "track" and self.calibration is not None:
                    if ts - last_track_broadcast < track_interval:
                        continue
                    objects = self.detector.detect(frame, self.calibration)
                    await self.bus.broadcast(DetectionsEvent(objects=objects, ts=now_ts()))
                    last_track_broadcast = ts
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
    if not 0 <= marker_id < 50:
        raise HTTPException(status_code=404, detail="marker out of range")
    aruco_dict = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50)
    img = cv2.aruco.generateImageMarker(aruco_dict, marker_id, 200)
    ok, png = cv2.imencode(".png", img)
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
            ).model_dump(mode="json")
        )
        while True:
            msg = await ws.receive_json()
            mtype = msg.get("type")
            if mtype == "set_mode":
                await state.set_mode(msg["mode"])
            elif mtype == "register_projector":
                await state.register_projector(int(msg["proj_width"]), int(msg["proj_height"]))
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
