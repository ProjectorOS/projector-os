// Mirrors server/protocol.py. Keep in sync by hand for v1.

export type Mode = "idle" | "calibrate" | "track";

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
    }
  | { type: "mode_changed"; mode: Mode }
  | { type: "detections"; objects: DetectedObject[]; ts: number }
  | { type: "hands"; hands: DetectedHand[]; ts: number }
  | { type: "calibration_updated"; calibration: Calibration }
  | { type: "calibration_prompt"; markers: CalibrationMarker[]; marker_size_px: number }
  | {
      type: "calibration_captured";
      detected_marker_ids: number[];
      detected_corners_cam: [number, number][][];
      frame_width: number;
      frame_height: number;
      rejected_count: number;
    }
  | { type: "projector_registered"; proj_width: number; proj_height: number }
  | { type: "work_surface_updated"; work_surface: WorkSurface; show_outline: boolean }
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
  | { type: "start_calibration" }
  | { type: "finish_calibration"; horizontal_mm: number }
  | {
      type: "set_work_surface";
      x: number;
      y: number;
      width: number;
      height: number;
      show_outline?: boolean;
    }
  | { type: "set_camera"; index: number | null };
