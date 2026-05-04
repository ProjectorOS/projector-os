"""ArUco-based object detection + MediaPipe hand detection. Reports both in mat_mm.

For v1 objects use ArUco markers (DICT_4X4_50, IDs 0..9) stuck to physical objects
(tools, material pieces). This is rock-solid and gives us position + orientation;
once the end-to-end pipeline is validated we'll swap in an ML model on this same
interface.

Hands use MediaPipe HandLandmarker (Tasks API), running in VIDEO mode so the model
keeps inter-frame state for stable tracking.
"""

from __future__ import annotations

import logging
import math
import time
from pathlib import Path

import cv2
import mediapipe as mp
import numpy as np
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision as mp_vision

from server.calibration import cam_to_mat
from server.protocol import Calibration, DetectedHand, DetectedObject

log = logging.getLogger(__name__)

OBJECT_DICT = cv2.aruco.DICT_4X4_50
OBJECT_MARKER_ID_RANGE = range(0, 10)  # IDs 0..9 are objects; 10..13 are calibration markers

HAND_MODEL_PATH = Path(__file__).resolve().parent.parent / "data" / "models" / "hand_landmarker.task"


class ObjectDetector:
    def __init__(self) -> None:
        self._dict = cv2.aruco.getPredefinedDictionary(OBJECT_DICT)
        self._detector = cv2.aruco.ArucoDetector(self._dict, cv2.aruco.DetectorParameters())

    def detect(self, frame: np.ndarray, calib: Calibration) -> list[DetectedObject]:
        corners, ids, _ = self._detector.detectMarkers(frame)
        if ids is None:
            return []

        objects: list[DetectedObject] = []
        for marker_corners, marker_id in zip(corners, ids.flatten()):
            mid = int(marker_id)
            if mid not in OBJECT_MARKER_ID_RANGE:
                continue

            cam_pts = marker_corners.reshape(4, 2)
            mat_pts = cam_to_mat(calib, cam_pts)
            center = mat_pts.mean(axis=0)

            # Marker corner order from ArUco is TL, TR, BR, BL (in marker frame).
            # The "top" edge (TL→TR) gives orientation in mat_mm.
            top_edge = mat_pts[1] - mat_pts[0]
            angle = math.degrees(math.atan2(top_edge[1], top_edge[0]))

            objects.append(
                DetectedObject(
                    marker_id=mid,
                    corners_mm=mat_pts.tolist(),
                    center_mm=center.tolist(),
                    angle_deg=angle,
                )
            )
        return objects


class HandDetector:
    """MediaPipe HandLandmarker wrapper. Returns hands with landmarks in mat_mm.

    The detector keeps internal frame-to-frame state (RunningMode.VIDEO), so callers
    must hand it monotonic timestamps. The first frame after a long pause may be
    detection-only; subsequent frames use tracking and are cheaper.
    """

    def __init__(self, model_path: Path = HAND_MODEL_PATH, max_hands: int = 2) -> None:
        if not model_path.exists():
            raise FileNotFoundError(
                f"Hand landmarker model not found at {model_path}. Download from "
                f"https://storage.googleapis.com/mediapipe-models/hand_landmarker/"
                f"hand_landmarker/float16/1/hand_landmarker.task"
            )
        opts = mp_vision.HandLandmarkerOptions(
            base_options=mp_python.BaseOptions(model_asset_path=str(model_path)),
            running_mode=mp_vision.RunningMode.VIDEO,
            num_hands=max_hands,
            min_hand_detection_confidence=0.5,
            min_hand_presence_confidence=0.5,
            min_tracking_confidence=0.5,
        )
        self._landmarker = mp_vision.HandLandmarker.create_from_options(opts)

    def detect(
        self, frame: np.ndarray, calib: Calibration, frame_ts_ms: int
    ) -> list[DetectedHand]:
        # MediaPipe expects RGB. Camera frames from OpenCV are BGR.
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
        result = self._landmarker.detect_for_video(mp_image, frame_ts_ms)

        if not result.hand_landmarks:
            return []

        h, w = frame.shape[:2]
        hands: list[DetectedHand] = []
        for landmarks, handedness_list in zip(result.hand_landmarks, result.handedness):
            # MediaPipe gives normalized [0,1] coords; lift to camera_px then mat_mm.
            cam_pts = np.array([[lm.x * w, lm.y * h] for lm in landmarks], dtype=np.float64)
            mat_pts = cam_to_mat(calib, cam_pts)
            top = handedness_list[0]
            # Camera sees the user's hands mirrored, so MediaPipe's "Left"/"Right"
            # is from the camera's POV. Flip so it matches the user's own hand.
            label = "Right" if top.category_name == "Left" else "Left"
            hands.append(
                DetectedHand(
                    handedness=label,
                    score=float(top.score),
                    landmarks_mm=mat_pts.tolist(),
                )
            )
        return hands

    def close(self) -> None:
        self._landmarker.close()


def now_ts() -> float:
    return time.time()
