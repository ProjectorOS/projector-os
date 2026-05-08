// Mirrors server/protocol.py. Keep in sync by hand for v1.

export type Mode = "idle" | "calibrate" | "track";
export type CalibrationMethod = "aruco" | "grid";

export interface Calibration {
  h_cam_to_mat: number[][];
  h_mat_to_proj: number[][];
  proj_width: number;
  proj_height: number;
  mat_width_mm: number;
  mat_height_mm: number;
  created_at: number;
}

export interface DetectedObject {
  marker_id: number;
  corners_mm: [number, number][];
  center_mm: [number, number];
  angle_deg: number;
}

export interface DetectedHand {
  handedness: "Left" | "Right";
  score: number;
  // 21 MediaPipe Hand landmarks in mat_mm.
  landmarks_mm: [number, number][];
}

export interface CalibrationMarker {
  marker_id: number;
  proj_x: number;
  proj_y: number;
}

export interface WorkSurface {
  x: number;
  y: number;
  width: number;
  height: number;
  updated_at: number;
}

export interface CameraRoi {
  // 4 [x, y] cam-pixel corners in TL/TR/BR/BL order.
  corners: [number, number][];
  updated_at: number;
}

// Status of cutting-mat grid detection during calibration. Sent in every
// CalibrationCapturedEvent so the UI can show whether passive grid-based
// calibration is available. When `detected` is true, the user can finish
// calibration without supplying a ruler measurement.
export interface MatGridStatus {
  detected: boolean;
  grid_system: "metric" | "imperial" | null;
  major_pitch_mm: number | null; // 10.0 (metric) or 25.4 (imperial)
  subdivisions_per_major: number | null; // 10, 5, 2, 4, 8, or 16
  pitch_cam_px_x: number | null;
  pitch_cam_px_y: number | null;
  intersection_count: number;
  confidence: number;
  reason: string | null; // populated when detected=false
  // Per-stage line counts from the detector — surfaced so the UI can render a
  // count legend next to the debug preview without needing line geometry.
  weak_line_count: number;
  strong_line_count: number;
  axis_a_line_count: number;
  axis_b_line_count: number;
  diagonal_line_count: number;
}

export type ServerEvent =
  | {
      type: "hello";
      mode: Mode;
      calibration: Calibration | null;
      projector: [number, number] | null;
      work_surface: WorkSurface | null;
      show_work_surface_outline: boolean;
      camera_index: number | null;
      camera_open: boolean;
      camera_roi: CameraRoi | null;
    }
  | { type: "mode_changed"; mode: Mode }
  | { type: "detections"; objects: DetectedObject[]; ts: number }
  | { type: "hands"; hands: DetectedHand[]; ts: number }
  | { type: "calibration_updated"; calibration: Calibration }
  | {
      type: "calibration_prompt";
      markers: CalibrationMarker[];
      marker_size_px: number;
      method: CalibrationMethod;
    }
  | {
      type: "calibration_captured";
      method: CalibrationMethod;
      detected_marker_ids: number[];
      detected_corners_cam: [number, number][][];
      frame_width: number;
      frame_height: number;
      rejected_count: number;
      mat_grid: MatGridStatus | null;
      // Grid-method only: detected dot centers in cam_px (TL/TR/BR/BL order)
      // and the raw blob count for progress UI. Empty / 0 for ArUco method.
      detected_dots_cam: [number, number][];
      detected_dot_count: number;
    }
  | {
      // Result of an explicitly-triggered grid detection run; independent of
      // ArUco markers (full-frame ROI, no axis sanity check). Carries a
      // snapshot of every pipeline stage's line set so the camera preview
      // can show which step the detector gave up at.
      type: "mat_grid_detected";
      grid: MatGridStatus;
      frame_width: number;
      frame_height: number;
      intersections_cam: [number, number][];
      weak_lines_cam: [number, number, number, number][];
      strong_lines_cam: [number, number, number, number][];
      axis_a_lines_cam: [number, number, number, number][];
      axis_b_lines_cam: [number, number, number, number][];
      diagonal_lines_cam: [number, number, number, number][];
    }
  | { type: "projector_registered"; proj_width: number; proj_height: number }
  | { type: "work_surface_updated"; work_surface: WorkSurface; show_outline: boolean }
  | { type: "camera_roi_updated"; camera_roi: CameraRoi | null }
  | { type: "camera_changed"; camera_index: number | null; camera_open: boolean; error: string | null }
  | {
      type: "frame_stats";
      mode: Mode;
      camera_open: boolean;
      frame_index: number;
      fps: number;
      last_frame_age_ms: number;
      detector_runs: number;
      last_detected_count: number;
    };

export type ClientCommand =
  | { type: "set_mode"; mode: Mode }
  | { type: "register_projector"; proj_width: number; proj_height: number }
  | { type: "start_calibration"; method: CalibrationMethod }
  // horizontal_mm is null/omitted when finishing via passive grid detection;
  // the server derives mat dimensions from the detected grid in that case.
  | { type: "finish_calibration"; horizontal_mm: number | null }
  | { type: "detect_grid" }
  | {
      type: "set_work_surface";
      x: number;
      y: number;
      width: number;
      height: number;
      show_outline?: boolean;
    }
  | { type: "set_camera"; index: number | null }
  | {
      type: "set_camera_roi";
      corners: [number, number][];
      clear?: boolean;
    };
