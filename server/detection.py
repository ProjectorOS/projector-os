"""ArUco-based object detection. Reports objects in mat_mm coordinates.

For v1 we use ArUco markers (DICT_4X4_50, IDs 0..9) stuck to physical objects (tools,
material pieces). This is rock-solid and gives us position + orientation; once the
end-to-end pipeline is validated we'll swap in an ML model on this same interface.
"""

from __future__ import annotations

import math
import time

import cv2
import numpy as np

from server.calibration import cam_to_mat
from server.protocol import Calibration, DetectedObject

OBJECT_DICT = cv2.aruco.DICT_4X4_50
OBJECT_MARKER_ID_RANGE = range(0, 10)  # IDs 0..9 are objects; 10..13 are calibration markers


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


def now_ts() -> float:
    return time.time()
