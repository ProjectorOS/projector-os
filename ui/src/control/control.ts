// Control entry: regular web UI for driving the system from the laptop browser.
// Connects to the same WebSocket as the projector view; either client can issue
// commands and both stay in sync via server broadcasts.
//
// The static structure (cards, headings, buttons, SVG skeleton, table templates)
// lives in ui/index.html. This module only:
//   - caches references to the DOM nodes via [data-role] selectors
//   - attaches event handlers once at startup
//   - mutates specific bits of text / classes / attributes in response to
//     server events and user input

import type {
  Calibration,
  CalibrationMethod,
  CameraRoi,
  DetectedObject,
  MatGridStatus,
  Mode,
  ServerEvent,
  WorkSurface,
} from "../types";
import { defaultServerHttpUrl, defaultServerWsUrl, WsClient } from "../ws-client";

interface Display {
  index: number;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  is_main: boolean;
}

interface DisplaysResponse {
  displays: Display[];
  projector_running: boolean;
}

interface CameraInfo {
  index: number;
  name: string;
  unique_id: string;
}

interface CamerasResponse {
  cameras: CameraInfo[];
  current_index: number | null;
  camera_open: boolean;
}

interface PendingMargins {
  left: string;
  top: string;
  right: string;
  bottom: string;
}

interface CalibrationDiagnostic {
  detectedIds: number[];
  detectedCorners: [number, number][][];
  frameWidth: number;
  frameHeight: number;
  rejectedCount: number;
  lastSeenAt: number;
}

interface FrameStats {
  frameIndex: number;
  fps: number;
  lastFrameAgeMs: number;
  detectorRuns: number;
  lastDetectedCount: number;
  receivedAt: number;
}

interface ExplicitGridResult {
  // Latest result from a user-triggered "Detect grid" run. Independent of the
  // auto-detection that fires when 4 ArUco markers are visible, so we can
  // surface "is the detector finding the mat at all?" diagnostically.
  status: MatGridStatus;
  intersectionsCam: [number, number][];
  weakLinesCam: [number, number, number, number][];
  strongLinesCam: [number, number, number, number][];
  axisALinesCam: [number, number, number, number][];
  axisBLinesCam: [number, number, number, number][];
  diagonalLinesCam: [number, number, number, number][];
  frameWidth: number;
  frameHeight: number;
  receivedAt: number;
}

interface ViewState {
  mode: Mode;
  connection: "connecting" | "open" | "closed";
  calibration: Calibration | null;
  projector: [number, number] | null;
  // Which calibration flow the server is currently running. Set when the user
  // clicks one of the two Calibrate buttons; reset on calibration_prompt and
  // mode_changed.
  calibrationMethod: CalibrationMethod;
  capturedMarkers: number;
  // Grid method only: number of bright-dot blob candidates the server saw
  // this frame (not necessarily 4 of them sortable into corners).
  detectedDotCount: number;
  detectedDotsCam: [number, number][];
  calibDiag: CalibrationDiagnostic | null;
  // Latest cutting-mat grid detection state from the server. null means no
  // calibration_captured event has arrived yet this session.
  matGrid: MatGridStatus | null;
  // When true, the user has explicitly chosen the manual ruler flow even
  // though a grid was detected. Reset on each start_calibration.
  useRuler: boolean;
  detections: DetectedObject[];
  displays: Display[];
  displaysError: string | null;
  switchingDisplay: boolean;
  workSurface: WorkSurface | null;
  showWorkSurfaceOutline: boolean;
  pendingMargins: PendingMargins | null;
  cameras: CameraInfo[];
  cameraIndex: number | null;
  cameraOpen: boolean;
  cameraError: string | null;
  switchingCamera: boolean;
  frameStats: FrameStats | null;
  explicitGrid: ExplicitGridResult | null;
  detectGridPending: boolean;
  cameraRoi: CameraRoi | null;
  // Camera frame size, learned from the most recent calibration_captured
  // event. Needed to scale drag interactions and to default the ROI to a
  // sane initial rectangle when the user starts dragging without one.
  cameraFrame: { width: number; height: number } | null;
}

const SERVER_HTTP = defaultServerHttpUrl();
const SVG_NS = "http://www.w3.org/2000/svg";
const PREVIEW_W = 320;
const HANDLE_THICKNESS = 10;

type Edge = "top" | "bottom" | "left" | "right";

class ControlApp {
  private state: ViewState = {
    mode: "idle",
    connection: "connecting",
    calibration: null,
    projector: null,
    calibrationMethod: "aruco",
    capturedMarkers: 0,
    detectedDotCount: 0,
    detectedDotsCam: [],
    calibDiag: null,
    matGrid: null,
    useRuler: false,
    detections: [],
    displays: [],
    displaysError: null,
    switchingDisplay: false,
    workSurface: null,
    showWorkSurfaceOutline: true,
    pendingMargins: null,
    cameras: [],
    cameraIndex: null,
    cameraOpen: false,
    cameraError: null,
    switchingCamera: false,
    frameStats: null,
    explicitGrid: null,
    detectGridPending: false,
    cameraRoi: null,
    cameraFrame: null,
  };
  private readonly ws: WsClient;
  // Whether the camera <img> currently has its MJPEG src attribute set. Used to avoid
  // restarting the long-lived multipart HTTP connection on every render.
  private cameraPreviewActive = false;
  // Same idea for the second "what OpenCV sees" stream — toggled on entering
  // grid-calibrate mode, off on leaving.
  private gridPreviewActive = false;
  // Same again for the keystone-corrected ("rectified") preview.
  private gridRectifiedPreviewActive = false;
  // Cursor-magnifier focus point in cam-pixel coords. Set from (in priority
  // order) the corner currently being dragged → cursor position over the
  // preview → camera-frame center as a fallback once dimensions are known.
  // The magnifier stays visible whenever the camera preview is live; the
  // focus point determines what's centered in the magnified view.
  private magnifierFocus: { x: number; y: number } | null = null;
  // Index of the ROI corner the magnifier is currently focused on (0=TL,
  // 1=TR, 2=BR, 3=BL). Set when hovering over OR dragging a corner handle.
  // Switches the magnifier crosshair from the default green plus to two
  // cyan rays along the polygon edges meeting at that corner.
  private magnifierCornerIdx: number | null = null;
  // True while a corner drag is in progress. Lets the corner-drag handler
  // own the magnifier focus across pointer moves without the cam-preview's
  // hover-detect handler overwriting it (e.g. when the cursor briefly
  // leaves the moving handle's hit area mid-drag).
  private magnifierCornerDragActive = false;
  private magnifierRaf: number | null = null;
  // The user's typed measurement, kept here so we can pre-fill from a saved
  // calibration without forcing a render.
  private pendingMm = "";
  // UI prefs persisted to localStorage (per browser).
  private workSurfaceCollapsed = readBool("workSurfaceCollapsed", false);
  private previewRotation: 0 | 180 = readNumber("previewRotation", 0) === 180 ? 180 : 0;
  // When true, the camera card hides the preview, heartbeat, and frame-stats line.
  // The camera itself stays open server-side; this is purely a UI declutter toggle.
  private previewHidden = readBool("previewHidden", false);

  constructor() {
    this.ws = new WsClient({
      url: defaultServerWsUrl(),
      onEvent: (e) => this.onEvent(e),
      onState: (s) => {
        this.state.connection = s;
        if (s === "open") {
          void this.fetchDisplays();
          void this.fetchCameras();
        }
        this.applyConnection();
      },
    });
    this.attachHandlers();
    // Initial paint reflects the empty default state until hello arrives.
    this.applyAll();
  }

  start(): void {
    this.ws.connect();
    void this.fetchDisplays();
    void this.fetchCameras();
  }

  // ─── DOM event wiring ────────────────────────────────────────────────────

  private attachHandlers(): void {
    // Display card
    q("display-switch-btn").addEventListener("click", () => {
      this.state.switchingDisplay = true;
      this.applyDisplayCard();
      void this.fetchDisplays();
    });
    q("display-close-btn").addEventListener("click", () => void this.closeProjector());
    q("display-refresh-btn").addEventListener("click", () => void this.fetchDisplays());
    q("display-cancel-btn").addEventListener("click", () => {
      this.state.switchingDisplay = false;
      this.applyDisplayCard();
    });

    // Work surface card
    q("ws-header").addEventListener("click", () => {
      this.workSurfaceCollapsed = !this.workSurfaceCollapsed;
      writeBool("workSurfaceCollapsed", this.workSurfaceCollapsed);
      this.applyWorkSurfaceCard();
    });
    for (const name of ["top", "bottom", "left", "right"] as const) {
      const input = document.querySelector<HTMLInputElement>(`input[data-field="${name}"]`)!;
      input.addEventListener("input", () => {
        if (!this.state.pendingMargins) return;
        this.state.pendingMargins = { ...this.state.pendingMargins, [name]: input.value };
        this.applyPreviewLayout();
        this.updateWsInfoLive();
      });
    }
    const showOutline = q<HTMLInputElement>("ws-show-outline");
    showOutline.addEventListener("change", () => {
      if (!this.state.pendingMargins) return;
      this.applyMargins(this.state.pendingMargins, showOutline.checked);
    });
    q("ws-apply-btn").addEventListener("click", () => {
      if (!this.state.pendingMargins) return;
      this.applyMargins(this.state.pendingMargins, this.state.showWorkSurfaceOutline);
    });
    q("ws-reset-btn").addEventListener("click", () => {
      this.state.pendingMargins = null;
      this.applyMargins(
        { left: "0", top: "0", right: "0", bottom: "0" },
        this.state.showWorkSurfaceOutline,
      );
    });
    for (const edge of ["top", "bottom", "left", "right"] as const) {
      const handle = document.querySelector<SVGRectElement>(`rect[data-edge="${edge}"]`)!;
      handle.addEventListener("pointerdown", (e) => this.startEdgeDrag(edge, e));
    }

    // Camera card
    q("camera-switch-btn").addEventListener("click", () => {
      this.state.switchingCamera = true;
      this.applyCameraCard();
      void this.fetchCameras();
    });
    q("camera-rotate-btn").addEventListener("click", () => {
      this.previewRotation = this.previewRotation === 0 ? 180 : 0;
      writeNumber("previewRotation", this.previewRotation);
      this.applyCameraPreviewVisuals();
    });
    q("camera-preview-toggle-btn").addEventListener("click", () =>
      this.setPreviewHidden(!this.previewHidden),
    );
    q("camera-refresh-btn").addEventListener("click", () => void this.fetchCameras());
    q("camera-cancel-btn").addEventListener("click", () => {
      this.state.switchingCamera = false;
      this.applyCameraCard();
    });

    // Mode card
    q("mode-idle-btn").addEventListener("click", () =>
      this.ws.send({ type: "set_mode", mode: "idle" }),
    );
    q("mode-calibrate-aruco-btn").addEventListener("click", () =>
      this.ws.send({ type: "start_calibration", method: "aruco" }),
    );
    q("mode-calibrate-grid-btn").addEventListener("click", () =>
      this.ws.send({ type: "start_calibration", method: "grid" }),
    );
    q("mode-track-btn").addEventListener("click", () =>
      this.ws.send({ type: "set_mode", mode: "track" }),
    );

    // Calibration card
    const measurement = q<HTMLInputElement>("measurement-input");
    measurement.addEventListener("input", () => {
      this.pendingMm = measurement.value;
      this.refreshMeasurementHint();
    });
    measurement.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") this.commitMeasurement();
    });
    q("calib-save-btn").addEventListener("click", () => this.commitMeasurement());
    q("use-ruler-toggle").addEventListener("click", () => {
      this.state.useRuler = true;
      this.applyCalibrationCard();
    });
    q("use-grid-toggle").addEventListener("click", () => {
      this.state.useRuler = false;
      this.applyCalibrationCard();
    });
    q("detect-grid-btn").addEventListener("click", () => {
      this.state.detectGridPending = true;
      this.ws.send({ type: "detect_grid" });
      this.applyCalibrationCard();
    });
    q("camera-roi-reset-btn").addEventListener("click", () => {
      this.ws.send({ type: "set_camera_roi", corners: [], clear: true });
    });

    // Cursor magnifier — always shown when the camera preview is live.
    // Pointer-move over the preview retargets the focus point; cursor
    // leaving doesn't hide the magnifier (focus stays at the last value
    // until something else updates it). Corner-drag handlers below override
    // the focus to follow the marker being dragged instead of the cursor.
    const camPreview = q("cam-preview");
    camPreview.addEventListener("pointermove", (ev) =>
      this.handleMagnifierPointerMove(ev),
    );
  }

  // ─── Server events ───────────────────────────────────────────────────────

  private onEvent(ev: ServerEvent): void {
    switch (ev.type) {
      case "frame_stats":
        this.state.frameStats = {
          frameIndex: ev.frame_index,
          fps: ev.fps,
          lastFrameAgeMs: ev.last_frame_age_ms,
          detectorRuns: ev.detector_runs,
          lastDetectedCount: ev.last_detected_count,
          receivedAt: Date.now(),
        };
        this.applyHeartbeat();
        return;
      case "calibration_captured":
        this.state.calibrationMethod = ev.method;
        this.state.capturedMarkers = ev.detected_marker_ids.length;
        this.state.detectedDotCount = ev.detected_dot_count;
        this.state.detectedDotsCam = ev.detected_dots_cam;
        this.state.calibDiag = {
          detectedIds: ev.detected_marker_ids,
          detectedCorners: ev.detected_corners_cam,
          frameWidth: ev.frame_width,
          frameHeight: ev.frame_height,
          rejectedCount: ev.rejected_count,
          lastSeenAt: Date.now(),
        };
        if (ev.frame_width > 0 && ev.frame_height > 0) {
          this.state.cameraFrame = {
            width: ev.frame_width,
            height: ev.frame_height,
          };
          this.updateCameraRoiOverlay();
        }
        this.state.matGrid = ev.mat_grid;
        this.applyCalibrationCard();
        this.updateMarkerOverlay();
        return;
      case "detections":
        this.state.detections = ev.objects;
        this.applyDetections();
        return;
      case "hello":
        this.state.mode = ev.mode;
        this.state.calibration = ev.calibration;
        this.state.projector = ev.projector;
        this.state.workSurface = ev.work_surface;
        this.state.showWorkSurfaceOutline = ev.show_work_surface_outline;
        this.state.cameraIndex = ev.camera_index;
        this.state.cameraOpen = ev.camera_open;
        this.state.cameraRoi = ev.camera_roi;
        if (ev.calibration && !this.pendingMm) {
          this.pendingMm = formatMmForInput(ev.calibration.mat_width_mm);
          q<HTMLInputElement>("measurement-input").value = this.pendingMm;
        }
        this.applyAll();
        return;
      case "mode_changed":
        this.state.mode = ev.mode;
        if (ev.mode !== "calibrate") {
          this.state.capturedMarkers = 0;
          this.state.detectedDotCount = 0;
          this.state.detectedDotsCam = [];
          this.state.calibDiag = null;
          this.state.matGrid = null;
          this.state.useRuler = false;
          this.state.explicitGrid = null;
          this.state.detectGridPending = false;
        }
        this.applyMode();
        this.applyCalibrationCard();
        this.applyDetections();
        this.updateMarkerOverlay();
        this.updateGridOverlay();
        return;
      case "calibration_updated":
        this.state.calibration = ev.calibration;
        this.applyCalibrationStatus();
        this.applyMode();
        return;
      case "calibration_prompt":
        this.state.calibrationMethod = ev.method;
        this.state.capturedMarkers = 0;
        this.state.detectedDotCount = 0;
        this.state.detectedDotsCam = [];
        this.state.calibDiag = null;
        this.state.matGrid = null;
        this.state.useRuler = false;
        this.state.explicitGrid = null;
        this.state.detectGridPending = false;
        this.applyCalibrationCard();
        this.updateMarkerOverlay();
        this.updateGridOverlay();
        return;
      case "mat_grid_detected":
        this.state.explicitGrid = {
          status: ev.grid,
          intersectionsCam: ev.intersections_cam,
          weakLinesCam: ev.weak_lines_cam,
          strongLinesCam: ev.strong_lines_cam,
          axisALinesCam: ev.axis_a_lines_cam,
          axisBLinesCam: ev.axis_b_lines_cam,
          diagonalLinesCam: ev.diagonal_lines_cam,
          frameWidth: ev.frame_width,
          frameHeight: ev.frame_height,
          receivedAt: Date.now(),
        };
        this.state.detectGridPending = false;
        this.applyCalibrationCard();
        this.updateGridOverlay();
        return;
      case "projector_registered":
        this.state.projector = [ev.proj_width, ev.proj_height];
        this.state.switchingDisplay = false;
        this.applyDisplayCard();
        this.applyWorkSurfaceCard();
        this.applyMode();
        void this.fetchDisplays();
        return;
      case "work_surface_updated":
        this.state.workSurface = ev.work_surface;
        this.state.showWorkSurfaceOutline = ev.show_outline;
        this.state.pendingMargins = null;
        this.applyWorkSurfaceCard();
        return;
      case "camera_changed":
        this.state.cameraIndex = ev.camera_index;
        this.state.cameraOpen = ev.camera_open;
        this.state.cameraError = ev.error;
        this.state.switchingCamera = false;
        this.applyCameraCard();
        this.applyCalibrationCard();
        return;
      case "camera_roi_updated":
        this.state.cameraRoi = ev.camera_roi;
        this.updateCameraRoiOverlay();
        this.applyCalibrationCard();
        return;
    }
  }

  // ─── HTTP fetches ────────────────────────────────────────────────────────

  private async fetchDisplays(): Promise<void> {
    try {
      const res = await fetch(`${SERVER_HTTP}/displays`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as DisplaysResponse;
      this.state.displays = data.displays;
      this.state.displaysError = null;
    } catch (e) {
      this.state.displaysError = e instanceof Error ? e.message : String(e);
    }
    this.applyDisplayCard();
  }

  private async fetchCameras(): Promise<void> {
    try {
      const res = await fetch(`${SERVER_HTTP}/cameras`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as CamerasResponse;
      this.state.cameras = data.cameras;
      this.state.cameraIndex = data.current_index;
      this.state.cameraOpen = data.camera_open;
    } catch (e) {
      this.state.cameraError = e instanceof Error ? e.message : String(e);
    }
    this.applyCameraCard();
  }

  private async launchProjector(d: Display): Promise<void> {
    try {
      const res = await fetch(`${SERVER_HTTP}/launch_projector`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ x: d.x, y: d.y, width: d.width, height: d.height }),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => ({ detail: `HTTP ${res.status}` }));
        throw new Error(detail.detail ?? `HTTP ${res.status}`);
      }
      this.state.switchingDisplay = false;
      await this.fetchDisplays();
    } catch (e) {
      this.state.displaysError = e instanceof Error ? e.message : String(e);
      this.applyDisplayCard();
    }
  }

  private async closeProjector(): Promise<void> {
    try {
      await fetch(`${SERVER_HTTP}/close_projector`, { method: "POST" });
      this.state.projector = null;
      this.state.switchingDisplay = false;
      this.applyDisplayCard();
      this.applyWorkSurfaceCard();
      this.applyMode();
      await this.fetchDisplays();
    } catch {
      // Non-fatal; control panel still works.
    }
  }

  // ─── Apply functions: state → DOM ────────────────────────────────────────

  private applyAll(): void {
    this.applyConnection();
    this.applyMode();
    this.applyCalibrationStatus();
    this.applyDisplayCard();
    this.applyWorkSurfaceCard();
    this.applyCameraCard();
    this.applyCalibrationCard();
    this.applyDetections();
  }

  private applyConnection(): void {
    const host = q("connection-pill");
    if (this.state.connection === "open") setPill(host, "ok", "Connected");
    else if (this.state.connection === "connecting") setPill(host, "muted", "Connecting…");
    else setPill(host, "error", "Disconnected — retrying");
  }

  private applyMode(): void {
    const cls = this.state.mode === "track" ? "ok" : this.state.mode === "calibrate" ? "warn" : "muted";
    const label =
      this.state.mode === "calibrate"
        ? `calibrate (${this.state.calibrationMethod})`
        : this.state.mode;
    setPill(q("mode-pill"), cls, label);

    setActive(q("mode-idle-btn"), this.state.mode === "idle");
    setActive(
      q("mode-calibrate-aruco-btn"),
      this.state.mode === "calibrate" && this.state.calibrationMethod === "aruco",
      "primary",
    );
    setActive(
      q("mode-calibrate-grid-btn"),
      this.state.mode === "calibrate" && this.state.calibrationMethod === "grid",
      "primary",
    );
    setActive(q("mode-track-btn"), this.state.mode === "track");

    const noProjector = !this.state.projector;
    q<HTMLButtonElement>("mode-calibrate-aruco-btn").disabled = noProjector;
    q<HTMLButtonElement>("mode-calibrate-grid-btn").disabled = noProjector;
    q<HTMLButtonElement>("mode-track-btn").disabled = !this.state.calibration;

    const help = q("mode-help");
    if (!this.state.projector) {
      help.textContent = "Open the projector window above before calibrating.";
      help.hidden = false;
    } else if (!this.state.calibration) {
      help.textContent = "Track is disabled until calibration has been completed at least once.";
      help.hidden = false;
    } else {
      help.hidden = true;
    }

    qCard("calibration").hidden = this.state.mode !== "calibrate";
    qCard("track").hidden = this.state.mode !== "track";
  }

  private applyCalibrationStatus(): void {
    const node = q("calibration-status");
    if (this.state.calibration) {
      const c = this.state.calibration;
      node.textContent = `${c.mat_width_mm.toFixed(1)} × ${c.mat_height_mm.toFixed(1)} mm — ${formatRelativeTime(c.created_at)}`;
    } else {
      node.textContent = "not calibrated";
    }
  }

  private applyDisplayCard(): void {
    const projectorOpen = this.state.projector !== null;
    const showPicker = !projectorOpen || this.state.switchingDisplay;

    q("display-open").hidden = !projectorOpen || this.state.switchingDisplay;
    q("display-picker").hidden = !showPicker;

    if (projectorOpen && !this.state.switchingDisplay) {
      const [w, h] = this.state.projector!;
      const matched = this.state.displays.find((d) => d.width === w && d.height === h);
      q("display-open-label").textContent = matched
        ? `${matched.name} — ${w} × ${h} px`
        : `connected — ${w} × ${h} px`;
    }

    if (showPicker) {
      q("display-picker-help").textContent = projectorOpen
        ? "Pick a different display. The current projector window will be closed automatically."
        : "Pick which connected display the projector is pointing at. The kiosk window will open there in fullscreen.";

      const error = q("display-picker-error");
      if (this.state.displays.length === 0 && this.state.displaysError) {
        error.textContent = `Could not list displays: ${this.state.displaysError}`;
        error.hidden = false;
      } else if (this.state.displays.length === 0) {
        error.textContent = "No displays found.";
        error.hidden = false;
      } else {
        error.hidden = true;
      }

      const list = q("display-list");
      list.replaceChildren();
      const tpl = document.querySelector<HTMLTemplateElement>("#tpl-display-row")!;
      for (const d of this.state.displays) {
        const row = tpl.content.firstElementChild!.cloneNode(true) as HTMLElement;
        row.querySelector<HTMLElement>(".display-name")!.textContent =
          d.name + (d.is_main ? "  (main)" : "");
        row.querySelector<HTMLElement>(".display-meta")!.textContent =
          `${d.width} × ${d.height} px @ (${d.x}, ${d.y})`;
        const btn = row.querySelector<HTMLButtonElement>('button[data-role="launch-btn"]')!;
        btn.textContent = d.is_main ? "Launch on this display" : "Launch";
        btn.addEventListener("click", () => void this.launchProjector(d));
        list.appendChild(row);
      }

      q("display-cancel-btn").hidden = !(projectorOpen && this.state.switchingDisplay);
    }
  }

  private applyWorkSurfaceCard(): void {
    const card = qCard("work-surface");
    if (!this.state.projector) {
      card.hidden = true;
      return;
    }
    card.hidden = false;
    card.classList.toggle("collapsed", this.workSurfaceCollapsed);
    q("ws-chevron").textContent = this.workSurfaceCollapsed ? "▸" : "▾";

    const summary = q("ws-summary");
    if (this.workSurfaceCollapsed) {
      summary.textContent = this.state.workSurface
        ? `${this.state.workSurface.width} × ${this.state.workSurface.height}`
        : "—";
      summary.hidden = false;
    } else {
      summary.hidden = true;
    }

    if (this.workSurfaceCollapsed) return;

    const proj = this.state.projector;
    const margins = this.computeMargins(proj, this.state.workSurface);
    if (!this.state.pendingMargins) {
      this.state.pendingMargins = {
        left: String(margins.left),
        top: String(margins.top),
        right: String(margins.right),
        bottom: String(margins.bottom),
      };
    }
    const pending = this.state.pendingMargins;

    q("ws-projector").textContent = `${proj[0]} × ${proj[1]} px`;
    this.updateWsInfoLive();
    this.syncInputsFromPending(pending);
    q<HTMLInputElement>("ws-show-outline").checked = this.state.showWorkSurfaceOutline;

    this.updateWorkSurfaceSvg();
  }

  private applyCameraCard(): void {
    const live = this.state.cameraOpen && this.state.cameraIndex !== null && !this.state.switchingCamera;
    const showPicker = !this.state.cameraOpen || this.state.switchingCamera;

    q("camera-live").hidden = !live;
    q("camera-picker").hidden = !showPicker;

    const camPreview = q("cam-preview");
    camPreview.hidden = this.previewHidden;
    q("heartbeat-row").hidden = this.previewHidden;
    q("camera-rotate-btn").hidden = this.previewHidden;
    q<HTMLButtonElement>("camera-preview-toggle-btn").textContent = this.previewHidden
      ? "Show preview"
      : "Close preview";

    const errorNode = q("camera-error");
    if (this.state.cameraError) {
      errorNode.textContent = `Error: ${this.state.cameraError}`;
      errorNode.hidden = false;
    } else {
      errorNode.hidden = true;
    }

    if (live) {
      const current = this.state.cameras.find((c) => c.index === this.state.cameraIndex);
      q("camera-live-label").textContent = current
        ? `${current.name} (index ${current.index})`
        : `Camera ${this.state.cameraIndex}`;
      this.applyCameraPreviewVisuals();
      this.applyHeartbeat();
      // Magnifier is always visible alongside a live preview. Focus
      // defaults to camera-frame center until the cursor or a corner drag
      // overrides it.
      if (!this.previewHidden) {
        q("cam-magnifier").removeAttribute("hidden");
        this.ensureMagnifierFocus();
        this.startMagnifierLoop();
      }
    }

    if (showPicker) {
      const statusPill = q("camera-status-pill");
      const statusLabel = q("camera-status-label");
      if (this.state.switchingCamera) {
        statusPill.className = "pill warn";
        statusPill.textContent = "Opening…";
        statusLabel.textContent = "";
      } else {
        statusPill.className = "pill muted";
        statusPill.textContent = "Closed";
        statusLabel.textContent = "no camera selected";
      }

      q("camera-picker-help").textContent = this.state.cameraOpen
        ? "Pick a different camera. The current one will be closed automatically."
        : "Pick which camera looks at the mat. macOS may prompt for camera permission the first time.";

      const list = q("camera-list");
      list.replaceChildren();
      const tpl = document.querySelector<HTMLTemplateElement>("#tpl-camera-row")!;
      for (const c of this.state.cameras) {
        const row = tpl.content.firstElementChild!.cloneNode(true) as HTMLElement;
        row.querySelector<HTMLElement>(".display-name")!.textContent = c.name;
        row.querySelector<HTMLElement>(".display-meta")!.textContent = `index ${c.index}`;
        const btn = row.querySelector<HTMLButtonElement>('button[data-role="use-btn"]')!;
        const isSelected = c.index === this.state.cameraIndex && this.state.cameraOpen;
        btn.className = isSelected ? "active" : "primary";
        btn.textContent = isSelected ? "Active" : "Use";
        btn.disabled = isSelected || this.state.switchingCamera;
        btn.addEventListener("click", () => this.switchCamera(c.index));
        list.appendChild(row);
      }

      q("camera-cancel-btn").hidden = !(this.state.cameraOpen && this.state.switchingCamera);
    }

    // Stop the MJPEG stream when the preview is no longer visible.
    if (!live || this.previewHidden) {
      this.stopCameraPreview();
      // Magnifier piggybacks on the same <img>; tear it down too. Keep the
      // last focus so it resumes from the same spot when the preview reopens.
      q("cam-magnifier").setAttribute("hidden", "");
      this.stopMagnifierLoop();
    }
  }

  private applyCameraPreviewVisuals(): void {
    const wrap = q("cam-preview");
    wrap.classList.toggle("rot-180", this.previewRotation === 180);
    q<HTMLButtonElement>("camera-rotate-btn").textContent =
      this.previewRotation === 180 ? "Rotate preview (180°)" : "Rotate preview";

    const visible = !wrap.hidden;
    if (visible && !this.cameraPreviewActive) {
      const img = q<HTMLImageElement>("cam-preview-img");
      img.src = `${SERVER_HTTP}/camera/preview.mjpg`;
      this.cameraPreviewActive = true;
    }
  }

  private handleMagnifierPointerMove(ev: PointerEvent): void {
    // While a corner drag is in progress, the drag handler owns focus +
    // cornerIdx — don't let cam-preview hover detection override it.
    if (this.magnifierCornerDragActive) return;
    // If the cursor is hovering over an ROI corner handle, snap focus to
    // that corner's exact position and switch to corner-mode crosshair.
    // The data-roi-handle attribute is set on each circle in
    // updateCameraRoiOverlay; its value is the corner index 0..3.
    const target = ev.target as Element | null;
    const handleAttr = target?.getAttribute?.("data-roi-handle") ?? null;
    const corners = this.state.cameraRoi?.corners;
    if (
      handleAttr !== null &&
      /^\d+$/.test(handleAttr) &&
      corners &&
      corners.length === 4
    ) {
      const idx = Number(handleAttr);
      if (idx >= 0 && idx < 4) {
        const c = corners[idx];
        this.magnifierFocus = { x: c[0], y: c[1] };
        this.magnifierCornerIdx = idx;
        return;
      }
    }
    const img = q<HTMLImageElement>("cam-preview-img");
    if (!img.naturalWidth || !img.naturalHeight) return;
    const rect = img.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    // The <img> uses object-fit: contain, so the rendered image may be
    // letterboxed within its bounding box. Compute the actual rendered area
    // first, then map the cursor into natural-image coordinates.
    const naturalAspect = img.naturalWidth / img.naturalHeight;
    const elAspect = rect.width / rect.height;
    let renderedW: number, renderedH: number, offsetX: number, offsetY: number;
    if (naturalAspect > elAspect) {
      renderedW = rect.width;
      renderedH = rect.width / naturalAspect;
      offsetX = 0;
      offsetY = (rect.height - renderedH) / 2;
    } else {
      renderedH = rect.height;
      renderedW = rect.height * naturalAspect;
      offsetY = 0;
      offsetX = (rect.width - renderedW) / 2;
    }
    const lx = ev.clientX - rect.left - offsetX;
    const ly = ev.clientY - rect.top - offsetY;
    if (lx < 0 || ly < 0 || lx > renderedW || ly > renderedH) {
      // Outside the rendered image area — keep the existing focus rather
      // than hiding the magnifier, since the spec is to always show it.
      return;
    }
    this.magnifierFocus = {
      x: (lx / renderedW) * img.naturalWidth,
      y: (ly / renderedH) * img.naturalHeight,
    };
    // Cursor takes over focus → leave corner mode so the crosshair reverts
    // to the default green plus.
    this.magnifierCornerIdx = null;
  }

  private ensureMagnifierFocus(): void {
    // Default focus = camera-frame center, picked once we know dimensions.
    // Used on first show before any pointer/drag has set a focus.
    if (this.magnifierFocus !== null) return;
    const img = q<HTMLImageElement>("cam-preview-img");
    if (img.naturalWidth > 0 && img.naturalHeight > 0) {
      this.magnifierFocus = {
        x: img.naturalWidth / 2,
        y: img.naturalHeight / 2,
      };
    } else if (this.state.cameraFrame) {
      this.magnifierFocus = {
        x: this.state.cameraFrame.width / 2,
        y: this.state.cameraFrame.height / 2,
      };
    }
  }

  private startMagnifierLoop(): void {
    // Make sure the magnifier <img> is connected to the same MJPEG stream as
    // the main preview. The browser opens its own connection per element —
    // a small bandwidth hit on localhost — but the upside is no per-frame JS
    // work: scaling and cropping are handled entirely by CSS transform +
    // overflow:hidden on the container.
    const magImg = q<HTMLImageElement>("cam-magnifier-img");
    const desired = `${SERVER_HTTP}/camera/preview.mjpg`;
    if (magImg.getAttribute("src") !== desired) {
      magImg.src = desired;
    }
    if (this.magnifierRaf !== null) return;
    const tick = (): void => {
      this.updateMagnifierTransform();
      this.updateMagnifierCrosshair();
      this.magnifierRaf = requestAnimationFrame(tick);
    };
    this.magnifierRaf = requestAnimationFrame(tick);
  }

  private updateMagnifierCrosshair(): void {
    const svg = q<SVGSVGElement>("cam-magnifier-crosshair");
    svg.replaceChildren();
    const cornerIdx = this.magnifierCornerIdx;
    const corners = this.state.cameraRoi?.corners;
    if (cornerIdx !== null && corners && corners.length === 4) {
      // Corner mode: two cyan rays from the magnifier center pointing along
      // the polygon's edges that meet at the dragged corner. The actual
      // edge directions are used (not just up/down/left/right) so even a
      // skewed polygon's rays match its outline.
      const center = corners[cornerIdx];
      const adjacents = [
        corners[(cornerIdx + 3) % 4], // counter-clockwise neighbor
        corners[(cornerIdx + 1) % 4], // clockwise neighbor
      ];
      // viewBox is 0..100 with preserveAspectRatio="none" → coords are
      // % of the magnifier in each axis. Center is (50, 50).
      for (const adj of adjacents) {
        const dx = adj[0] - center[0];
        const dy = adj[1] - center[1];
        if (dx === 0 && dy === 0) continue;
        // Find where the ray from (50, 50) in direction (dx, dy) exits the
        // 0..100 viewBox — that's our line endpoint.
        const tx = Math.abs(dx) > 0 ? 50 / Math.abs(dx) : Infinity;
        const ty = Math.abs(dy) > 0 ? 50 / Math.abs(dy) : Infinity;
        const t = Math.min(tx, ty);
        const ex = 50 + dx * t;
        const ey = 50 + dy * t;
        const line = document.createElementNS(SVG_NS, "line");
        line.setAttribute("x1", "50");
        line.setAttribute("y1", "50");
        line.setAttribute("x2", String(ex));
        line.setAttribute("y2", String(ey));
        line.setAttribute("stroke", "#22d3ee");
        line.setAttribute("stroke-width", "1");
        line.setAttribute("vector-effect", "non-scaling-stroke");
        svg.appendChild(line);
      }
      // Small cyan dot at the center marking the corner's exact position.
      const dot = document.createElementNS(SVG_NS, "circle");
      dot.setAttribute("cx", "50");
      dot.setAttribute("cy", "50");
      dot.setAttribute("r", "1.2");
      dot.setAttribute("fill", "#22d3ee");
      dot.setAttribute("vector-effect", "non-scaling-stroke");
      svg.appendChild(dot);
      return;
    }
    // Default: green plus crosshair with a small box.
    const box = document.createElementNS(SVG_NS, "rect");
    box.setAttribute("x", "47");
    box.setAttribute("y", "47");
    box.setAttribute("width", "6");
    box.setAttribute("height", "6");
    box.setAttribute("fill", "none");
    box.setAttribute("stroke", "#4ade80");
    box.setAttribute("stroke-width", "1");
    box.setAttribute("vector-effect", "non-scaling-stroke");
    svg.appendChild(box);
    const v = document.createElementNS(SVG_NS, "line");
    v.setAttribute("x1", "50");
    v.setAttribute("y1", "44");
    v.setAttribute("x2", "50");
    v.setAttribute("y2", "56");
    v.setAttribute("stroke", "#4ade80");
    v.setAttribute("stroke-width", "1");
    v.setAttribute("vector-effect", "non-scaling-stroke");
    svg.appendChild(v);
    const h = document.createElementNS(SVG_NS, "line");
    h.setAttribute("x1", "44");
    h.setAttribute("y1", "50");
    h.setAttribute("x2", "56");
    h.setAttribute("y2", "50");
    h.setAttribute("stroke", "#4ade80");
    h.setAttribute("stroke-width", "1");
    h.setAttribute("vector-effect", "non-scaling-stroke");
    svg.appendChild(h);
  }

  private stopMagnifierLoop(): void {
    if (this.magnifierRaf !== null) {
      cancelAnimationFrame(this.magnifierRaf);
      this.magnifierRaf = null;
    }
    const magImg = q<HTMLImageElement>("cam-magnifier-img");
    // Detach the MJPEG connection when the magnifier hides.
    magImg.removeAttribute("src");
  }

  private updateMagnifierTransform(): void {
    this.ensureMagnifierFocus();
    const focus = this.magnifierFocus;
    if (!focus) return;
    const magImg = q<HTMLImageElement>("cam-magnifier-img");
    if (!magImg.naturalWidth || !magImg.naturalHeight) return;
    const container = q<HTMLDivElement>("cam-magnifier");
    const cw = container.clientWidth;
    const ch = container.clientHeight;
    if (cw <= 0 || ch <= 0) return;
    const ZOOM = 4;
    // With transform-origin: 0 0 and transform "scale(z) translate(tx, ty)",
    // a source point (x, y) maps to (z*(x + tx), z*(y + ty)).
    // We want the focus point to land at the container center:
    //   z*(focus.x + tx) = cw/2 → tx = cw/(2z) - focus.x
    //   z*(focus.y + ty) = ch/2 → ty = ch/(2z) - focus.y
    const tx = cw / (2 * ZOOM) - focus.x;
    const ty = ch / (2 * ZOOM) - focus.y;
    const transform = `scale(${ZOOM}) translate(${tx}px, ${ty}px)`;
    if (magImg.style.transform !== transform) {
      magImg.style.transform = transform;
    }
  }

  private stopCameraPreview(): void {
    if (!this.cameraPreviewActive) return;
    const img = q<HTMLImageElement>("cam-preview-img");
    // Setting src to "" cancels the in-flight MJPEG request so we stop pulling
    // frame bytes over the network. Next time the preview is shown, src is reset.
    img.removeAttribute("src");
    this.cameraPreviewActive = false;
  }

  private applyHeartbeat(): void {
    const dot = q("heartbeat-dot");
    const text = q("heartbeat-text");
    const stats = this.state.frameStats;
    const stale = !stats || Date.now() - stats.receivedAt > 1500;
    dot.className = `heartbeat ${stale ? "stale" : "alive"}`;
    if (!stats) {
      text.className = "heartbeat-text muted";
      text.textContent = "waiting for frames…";
      return;
    }
    if (stats.lastFrameAgeMs < 0) {
      text.className = "heartbeat-text muted";
      text.textContent = "camera open, no frames yet";
      return;
    }
    const parts = [
      `${stats.fps.toFixed(1)} fps`,
      `frame #${stats.frameIndex.toLocaleString()}`,
      `last frame ${stats.lastFrameAgeMs} ms ago`,
      `${stats.detectorRuns.toLocaleString()} detector runs`,
      `last saw ${stats.lastDetectedCount} marker${stats.lastDetectedCount === 1 ? "" : "s"}`,
    ];
    text.className = "heartbeat-text";
    text.textContent = parts.join(" · ");
  }

  private applyCalibrationCard(): void {
    if (this.state.mode !== "calibrate") {
      // Tear down the grid-debug + rectified streams so we don't keep MJPEG
      // connections open after leaving calibrate mode.
      if (this.gridPreviewActive) {
        q<HTMLImageElement>("grid-debug-preview-img").removeAttribute("src");
        this.gridPreviewActive = false;
      }
      if (this.gridRectifiedPreviewActive) {
        q<HTMLImageElement>("grid-rectified-preview-img").removeAttribute("src");
        this.gridRectifiedPreviewActive = false;
      }
      return;
    }

    const noCamera = q("calib-no-camera");
    const noProjector = q("calib-no-projector");
    const body = q("calib-body");
    if (!this.state.cameraOpen) {
      noCamera.hidden = false;
      noProjector.hidden = true;
      body.hidden = true;
      return;
    }
    if (!this.state.projector) {
      noCamera.hidden = true;
      noProjector.hidden = false;
      body.hidden = true;
      return;
    }
    noCamera.hidden = true;
    noProjector.hidden = true;
    body.hidden = false;

    if (this.state.calibrationMethod === "grid") {
      this.applyCalibrationCardGrid();
      return;
    }

    // Re-show ArUco-only UI in case we switched back from grid mode.
    q("grid-detect-block").hidden = false;
    q("grid-debug-preview").hidden = true;
    q("grid-rectified-preview").hidden = true;
    q("camera-roi-controls").hidden = true;
    q<SVGSVGElement>("camera-roi-overlay").setAttribute("hidden", "");
    if (this.gridPreviewActive) {
      q<HTMLImageElement>("grid-debug-preview-img").removeAttribute("src");
      this.gridPreviewActive = false;
    }
    if (this.gridRectifiedPreviewActive) {
      q<HTMLImageElement>("grid-rectified-preview-img").removeAttribute("src");
      this.gridRectifiedPreviewActive = false;
    }

    const status = q("calib-status");
    status.replaceChildren();
    if (this.state.capturedMarkers === 4) {
      const span = document.createElement("span");
      span.className = "pill ok";
      span.textContent = "All 4 markers detected";
      status.appendChild(span);
    } else if (this.state.capturedMarkers > 0) {
      const span = document.createElement("span");
      span.className = "pill warn";
      span.textContent = `${this.state.capturedMarkers}/4 markers detected`;
      status.appendChild(span);
    } else {
      const span = document.createElement("span");
      span.className = "pill error";
      span.textContent = "0/4 markers detected";
      status.appendChild(span);
    }

    const hint = q("calib-diag-hint");
    const diag = this.state.calibDiag;
    if (diag && this.state.capturedMarkers === 0) {
      hint.className = "help warn-text";
      hint.textContent =
        diag.rejectedCount > 0
          ? `Detector found ${diag.rejectedCount} candidate quad${diag.rejectedCount === 1 ? "" : "s"} but couldn't decode any. Likely causes: marker too small in camera frame, blur/glare, or wrong dictionary.`
          : "Detector found no candidate quads at all. Likely causes: markers not actually projected (check the projector window), the camera doesn't see the projection (point it at the mat), the work surface is set to an empty rectangle, or the camera image is heavily blurred.";
    } else {
      hint.className = "help";
      hint.textContent =
        "Watch the live preview in the Camera card above — green outlines mark each detected marker.";
    }

    // Mat-grid (passive) calibration pill + ruler-input toggle.
    // The passive path is offered when (a) all 4 ArUco markers are visible
    // (so we have a quad anchor), (b) the server reports a reliable grid
    // detection, and (c) the user hasn't explicitly opted into the ruler
    // flow. Otherwise we fall back to the existing ruler input.
    const gridPill = q("calib-grid-pill");
    const measureRow = q("calib-measure-row");
    const useRulerToggle = q<HTMLButtonElement>("use-ruler-toggle");
    const useGridToggle = q<HTMLButtonElement>("use-grid-toggle");
    const grid = this.state.matGrid;
    const passiveAvailable =
      this.state.capturedMarkers === 4 &&
      grid !== null &&
      grid.detected &&
      !this.state.useRuler;
    if (passiveAvailable && grid) {
      gridPill.hidden = false;
      gridPill.replaceChildren();
      const span = document.createElement("span");
      span.className = "pill ok";
      span.textContent = describeGrid(grid);
      gridPill.appendChild(span);
      measureRow.hidden = true;
      useRulerToggle.hidden = false;
      useGridToggle.hidden = true;
    } else {
      // Either no grid was detected, or the user toggled to ruler mode.
      // Surface the detection state if it's informative (helps the user
      // adjust mat position / lighting), but stay out of the way otherwise.
      if (grid && !grid.detected && grid.reason && this.state.capturedMarkers === 4) {
        gridPill.hidden = false;
        gridPill.replaceChildren();
        const span = document.createElement("span");
        span.className = "pill muted";
        span.textContent = "Mat grid not detected";
        gridPill.appendChild(span);
      } else if (this.state.useRuler && grid && grid.detected) {
        // User dismissed an available grid; offer to switch back.
        gridPill.hidden = false;
        gridPill.replaceChildren();
        const span = document.createElement("span");
        span.className = "pill muted";
        span.textContent = "Using ruler — grid available";
        gridPill.appendChild(span);
      } else {
        gridPill.hidden = true;
        gridPill.replaceChildren();
      }
      measureRow.hidden = false;
      useRulerToggle.hidden = true;
      useGridToggle.hidden = !(this.state.useRuler && grid && grid.detected);
    }

    // Save button: passive path always enabled when offered; active path
    // requires 4 markers (existing behavior).
    q<HTMLButtonElement>("calib-save-btn").disabled =
      passiveAvailable ? false : this.state.capturedMarkers < 4;
    this.refreshMeasurementHint();
    this.applyExplicitGridResult();
  }

  private applyCalibrationCardGrid(): void {
    // Grid-only calibration UI: 4 detected dots + a detected mat grid → Save.
    // We reuse the existing DOM nodes (calib-status, calib-grid-pill,
    // calib-diag-hint, calib-save-btn) and hide the ArUco-specific bits
    // (ruler input, ruler/grid toggles, measurement hint) since neither
    // applies in grid-only mode.
    const status = q("calib-status");
    status.replaceChildren();
    const dotCount = this.state.detectedDotCount;
    const dotsSorted = this.state.detectedDotsCam.length === 4;
    const dotsPill = document.createElement("span");
    if (dotsSorted) {
      dotsPill.className = "pill ok";
      dotsPill.textContent = "All 4 dots detected";
    } else if (dotCount > 0) {
      dotsPill.className = "pill warn";
      dotsPill.textContent = `${Math.min(dotCount, 4)}/4 dots detected`;
    } else {
      dotsPill.className = "pill error";
      dotsPill.textContent = "0/4 dots detected";
    }
    status.appendChild(dotsPill);

    const gridPill = q("calib-grid-pill");
    gridPill.replaceChildren();
    gridPill.hidden = false;
    const grid = this.state.matGrid;
    const gridSpan = document.createElement("span");
    if (grid && grid.detected) {
      gridSpan.className = "pill ok";
      gridSpan.textContent = describeGrid(grid);
    } else if (grid && grid.reason) {
      gridSpan.className = "pill warn";
      gridSpan.textContent = `Grid: ${grid.reason}`;
    } else {
      gridSpan.className = "pill muted";
      gridSpan.textContent = "Waiting for grid…";
    }
    gridPill.appendChild(gridSpan);

    const hint = q("calib-diag-hint");
    hint.className = "help";
    if (!dotsSorted && dotCount === 0) {
      hint.textContent =
        "Camera doesn't see any bright dots yet. Check the projector window is open and pointed at the mat, and dim ambient light if there are competing bright surfaces.";
    } else if (!dotsSorted) {
      hint.textContent =
        "Some dots aren't visible to the camera — check that the work surface is fully in frame and there's nothing brighter in the scene.";
    } else if (!grid?.detected) {
      hint.textContent =
        "All 4 dots are visible. Now place the cutting mat under the projection so the printed grid is in view; the detector needs a clean view of the grid lines to lock on.";
    } else {
      hint.textContent =
        "Ready to save. The grid provides scale; the dots provide the projector mapping.";
    }

    // Hide ArUco-specific UI.
    q("calib-measure-row").hidden = true;
    q<HTMLButtonElement>("use-ruler-toggle").hidden = true;
    q<HTMLButtonElement>("use-grid-toggle").hidden = true;
    q("measurement-hint").textContent = "";
    // Grid runs continuously here, so the manual "Detect grid" button is
    // redundant. Hide the whole block.
    q("grid-detect-block").hidden = true;
    // Show the "what OpenCV sees" preview and start the MJPEG stream.
    q("grid-debug-preview").hidden = false;
    if (!this.gridPreviewActive) {
      q<HTMLImageElement>("grid-debug-preview-img").src = `${SERVER_HTTP}/camera/grid_preview.mjpg`;
      this.gridPreviewActive = true;
    }
    // And the keystone-corrected preview.
    q("grid-rectified-preview").hidden = false;
    if (!this.gridRectifiedPreviewActive) {
      q<HTMLImageElement>("grid-rectified-preview-img").src = `${SERVER_HTTP}/camera/grid_rectified.mjpg`;
      this.gridRectifiedPreviewActive = true;
    }

    // Camera-ROI controls — drag handles render via updateCameraRoiOverlay().
    q("camera-roi-controls").hidden = false;
    const roiInfo = q("camera-roi-info");
    const roiResetBtn = q<HTMLButtonElement>("camera-roi-reset-btn");
    if (this.state.cameraRoi && this.state.cameraRoi.corners.length === 4) {
      roiInfo.textContent =
        "Camera ROI polygon set — keystone correction is applied to grid detection. Drag any corner to refine.";
      roiResetBtn.hidden = false;
    } else {
      roiInfo.textContent =
        "No camera ROI set — drag the 4 cyan corners on the preview to align the polygon with the mat boundary.";
      roiResetBtn.hidden = true;
    }
    this.updateCameraRoiOverlay();

    q<HTMLButtonElement>("calib-save-btn").disabled =
      !(dotsSorted && grid?.detected);
  }

  private applyExplicitGridResult(): void {
    const btn = q<HTMLButtonElement>("detect-grid-btn");
    const resultRow = q("explicit-grid-result");
    btn.disabled = !this.state.cameraOpen || this.state.detectGridPending;
    btn.textContent = this.state.detectGridPending ? "Detecting…" : "Detect grid";

    // Always render the result row so the user can tell whether a click
    // produced a server response. Three states: pending (request in flight),
    // no result yet (button never clicked), and result (success or failure).
    resultRow.hidden = false;
    resultRow.replaceChildren();
    const result = this.state.explicitGrid;
    if (this.state.detectGridPending) {
      const pill = document.createElement("span");
      pill.className = "pill warn";
      pill.textContent = "Waiting for camera frame…";
      resultRow.appendChild(pill);
      return;
    }
    if (!result) {
      const pill = document.createElement("span");
      pill.className = "pill muted";
      pill.textContent = "No detection yet";
      resultRow.appendChild(pill);
      return;
    }
    const pill = document.createElement("span");
    if (result.status.detected) {
      pill.className = "pill ok";
      pill.textContent = describeGrid(result.status);
    } else {
      pill.className = "pill error";
      pill.textContent = "Not detected";
    }
    resultRow.appendChild(pill);

    const detail = document.createElement("span");
    detail.className = "help";
    if (result.status.detected) {
      const conf = (result.status.confidence * 100).toFixed(0);
      detail.textContent = `${result.status.intersection_count} intersection${result.status.intersection_count === 1 ? "" : "s"} · confidence ${conf}%`;
    } else if (result.status.reason) {
      detail.textContent = result.status.reason;
    } else {
      detail.textContent = "";
    }
    resultRow.appendChild(detail);

    // Legend mapping camera-preview overlay colors to pipeline stages so the
    // user can read "axes not separable" + a screenful of gray lines as
    // "Hough found edges but they didn't cluster into two perpendicular sets".
    const legend = document.createElement("div");
    legend.className = "help";
    legend.style.marginTop = "4px";
    const legendItems: [string, string, number][] = [
      ["#94a3b8", "━ weak", result.weakLinesCam.length],
      ["#e2e8f0", "━ strong", result.strongLinesCam.length],
      ["#22d3ee", "━ axis X", result.axisALinesCam.length],
      ["#3b82f6", "━ axis Y", result.axisBLinesCam.length],
      ["#ec4899", "━ diagonals", result.diagonalLinesCam.length],
      ["#4ade80", "● intersection", result.intersectionsCam.length],
    ];
    legendItems.forEach(([color, text, count], i) => {
      if (i > 0) legend.append(" · ");
      const swatch = document.createElement("span");
      swatch.style.color = color;
      swatch.textContent = `${text} (${count})`;
      legend.append(swatch);
    });
    resultRow.appendChild(legend);
  }

  private applyDetections(): void {
    if (this.state.mode !== "track") return;
    const tbody = q<HTMLTableSectionElement>("detections-tbody");
    // One row per ArUco object-marker ID (server allocates 0..9 for objects). Each
    // row's slot is fixed so the card never reflows as markers come and go.
    const SLOTS = 10;
    if (tbody.childElementCount !== SLOTS) {
      tbody.replaceChildren();
      const tpl = document.querySelector<HTMLTemplateElement>("#tpl-detection-row")!;
      for (let id = 0; id < SLOTS; id++) {
        const tr = tpl.content.firstElementChild!.cloneNode(true) as HTMLElement;
        tr.querySelector<HTMLElement>("td.id")!.textContent = `#${id}`;
        tbody.appendChild(tr);
      }
    }
    const byId = new Map<number, DetectedObject>();
    for (const obj of this.state.detections) byId.set(obj.marker_id, obj);
    for (let id = 0; id < SLOTS; id++) {
      const tr = tbody.children[id] as HTMLElement;
      const obj = byId.get(id);
      const pos = tr.querySelector<HTMLElement>('td[data-role="position"]')!;
      const ang = tr.querySelector<HTMLElement>('td[data-role="angle"]')!;
      if (obj) {
        tr.classList.remove("empty-slot");
        pos.textContent = `(${obj.center_mm[0].toFixed(1)}, ${obj.center_mm[1].toFixed(1)}) mm`;
        ang.textContent = `${obj.angle_deg.toFixed(1)}°`;
      } else {
        tr.classList.add("empty-slot");
        pos.textContent = "—";
        ang.textContent = "—";
      }
    }
  }

  // ─── Work-surface preview ────────────────────────────────────────────────

  private updateWorkSurfaceSvg(): void {
    const proj = this.state.projector;
    if (!proj) return;
    const svg = q<SVGSVGElement>("ws-preview");
    const scale = PREVIEW_W / proj[0];
    const previewH = Math.round(proj[1] * scale);
    svg.setAttribute("width", String(PREVIEW_W));
    svg.setAttribute("height", String(previewH));
    svg.setAttribute("viewBox", `0 0 ${PREVIEW_W} ${previewH}`);
    svg.dataset.scale = String(scale);

    const outer = svg.querySelector<SVGRectElement>('rect[data-role="ws-outer"]')!;
    outer.setAttribute("x", "0");
    outer.setAttribute("y", "0");
    outer.setAttribute("width", String(PREVIEW_W));
    outer.setAttribute("height", String(previewH));

    this.applyPreviewLayout();
  }

  private applyPreviewLayout(): void {
    const proj = this.state.projector;
    const pending = this.state.pendingMargins;
    if (!proj || !pending) return;
    const svg = q<SVGSVGElement>("ws-preview");
    const scale = parseFloat(svg.dataset.scale ?? "1");
    const m = parsePending(pending);
    const innerX = m.left * scale;
    const innerY = m.top * scale;
    const innerW = Math.max(0, (proj[0] - m.left - m.right) * scale);
    const innerH = Math.max(0, (proj[1] - m.top - m.bottom) * scale);

    const inner = svg.querySelector<SVGRectElement>('rect[data-role="ws-inner"]')!;
    inner.setAttribute("x", String(innerX));
    inner.setAttribute("y", String(innerY));
    inner.setAttribute("width", String(innerW));
    inner.setAttribute("height", String(innerH));

    const T = HANDLE_THICKNESS;
    const layouts: Record<Edge, { x: number; y: number; w: number; h: number }> = {
      top: { x: innerX, y: innerY - T / 2, w: innerW, h: T },
      bottom: { x: innerX, y: innerY + innerH - T / 2, w: innerW, h: T },
      left: { x: innerX - T / 2, y: innerY, w: T, h: innerH },
      right: { x: innerX + innerW - T / 2, y: innerY, w: T, h: innerH },
    };
    for (const edge of Object.keys(layouts) as Edge[]) {
      const handle = svg.querySelector<SVGRectElement>(`rect[data-edge="${edge}"]`)!;
      const { x, y, w, h } = layouts[edge];
      handle.setAttribute("x", String(x));
      handle.setAttribute("y", String(y));
      handle.setAttribute("width", String(Math.max(0, w)));
      handle.setAttribute("height", String(Math.max(0, h)));
    }
  }

  private startEdgeDrag(edge: Edge, e: PointerEvent): void {
    if (!this.state.projector || !this.state.pendingMargins) return;
    e.preventDefault();
    const proj = this.state.projector;
    const svg = q<SVGSVGElement>("ws-preview");
    const scale = parseFloat(svg.dataset.scale ?? "1");
    const startMargins = parsePending(this.state.pendingMargins);
    const startClientX = e.clientX;
    const startClientY = e.clientY;
    const minWidth = 50;
    const minHeight = 50;

    (e.target as Element).setPointerCapture?.(e.pointerId);

    // Live updates to the server are throttled: every move would flood the WS, but we
    // also want the projector's outline to track the cursor in real time, not just on
    // release. ~30 Hz is plenty for visual smoothness without overwhelming the bus.
    let lastSentAt = 0;
    const SEND_INTERVAL_MS = 33;

    const onMove = (ev: PointerEvent): void => {
      const dx = (ev.clientX - startClientX) / scale;
      const dy = (ev.clientY - startClientY) / scale;
      const next = { ...startMargins };
      if (edge === "left") {
        next.left = clamp(startMargins.left + dx, 0, proj[0] - startMargins.right - minWidth);
      } else if (edge === "right") {
        next.right = clamp(startMargins.right - dx, 0, proj[0] - startMargins.left - minWidth);
      } else if (edge === "top") {
        next.top = clamp(startMargins.top + dy, 0, proj[1] - startMargins.bottom - minHeight);
      } else if (edge === "bottom") {
        next.bottom = clamp(startMargins.bottom - dy, 0, proj[1] - startMargins.top - minHeight);
      }
      const pending: PendingMargins = {
        left: String(Math.round(next.left)),
        top: String(Math.round(next.top)),
        right: String(Math.round(next.right)),
        bottom: String(Math.round(next.bottom)),
      };
      this.state.pendingMargins = pending;
      this.applyPreviewLayout();
      this.syncInputsFromPending(pending);
      this.updateWsInfoLive();

      const now = performance.now();
      if (now - lastSentAt >= SEND_INTERVAL_MS) {
        this.applyMargins(pending, this.state.showWorkSurfaceOutline);
        lastSentAt = now;
      }
    };

    const onUp = (): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (this.state.pendingMargins) {
        this.applyMargins(this.state.pendingMargins, this.state.showWorkSurfaceOutline);
      }
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  private syncInputsFromPending(p: PendingMargins): void {
    for (const name of ["top", "bottom", "left", "right"] as const) {
      const input = document.querySelector<HTMLInputElement>(`input[data-field="${name}"]`)!;
      if (document.activeElement === input) continue; // don't fight the user's typing
      if (input.value !== p[name]) input.value = p[name];
    }
  }

  private updateWsInfoLive(): void {
    const proj = this.state.projector;
    const pending = this.state.pendingMargins;
    if (!proj || !pending) return;
    const m = parsePending(pending);
    const x = Math.max(0, m.left);
    const y = Math.max(0, m.top);
    const width = Math.max(1, proj[0] - m.left - m.right);
    const height = Math.max(1, proj[1] - m.top - m.bottom);
    q("ws-info").textContent = `${width} × ${height} px @ (${x}, ${y})`;
  }

  private applyMargins(pending: PendingMargins, showOutline: boolean): void {
    const proj = this.state.projector;
    if (!proj) return;
    const m = parsePending(pending);
    const x = Math.max(0, m.left);
    const y = Math.max(0, m.top);
    const width = Math.max(1, proj[0] - m.left - m.right);
    const height = Math.max(1, proj[1] - m.top - m.bottom);
    this.ws.send({ type: "set_work_surface", x, y, width, height, show_outline: showOutline });
  }

  private computeMargins(
    proj: [number, number],
    ws: WorkSurface | null,
  ): { left: number; top: number; right: number; bottom: number } {
    if (!ws) return { left: 0, top: 0, right: 0, bottom: 0 };
    return {
      left: ws.x,
      top: ws.y,
      right: proj[0] - ws.x - ws.width,
      bottom: proj[1] - ws.y - ws.height,
    };
  }

  // ─── Marker overlay (calibration mode) ───────────────────────────────────

  private updateMarkerOverlay(): void {
    const svg = q<SVGSVGElement>("marker-overlay");
    const diag = this.state.calibDiag;
    if (this.state.mode !== "calibrate" || !diag || diag.frameWidth <= 0 || diag.frameHeight <= 0) {
      svg.setAttribute("hidden", "");
      svg.replaceChildren();
      return;
    }
    svg.setAttribute("viewBox", `0 0 ${diag.frameWidth} ${diag.frameHeight}`);
    svg.replaceChildren();

    if (this.state.calibrationMethod === "grid") {
      // Grid method: show the 4 sorted dot centers. Each dot is labelled
      // with its corner role (TL/TR/BR/BL) so the user can see the corner
      // assignment is correct.
      const cornerLabels = ["TL", "TR", "BR", "BL"];
      const r = Math.max(8, Math.min(diag.frameWidth, diag.frameHeight) / 80);
      this.state.detectedDotsCam.forEach((pt, i) => {
        const dot = document.createElementNS(SVG_NS, "circle");
        dot.setAttribute("cx", String(pt[0]));
        dot.setAttribute("cy", String(pt[1]));
        dot.setAttribute("r", String(r));
        dot.setAttribute("fill", "rgba(74,222,128,0.3)");
        dot.setAttribute("stroke", "#4ade80");
        dot.setAttribute("stroke-width", "3");
        svg.appendChild(dot);
        const label = document.createElementNS(SVG_NS, "text");
        label.setAttribute("x", String(pt[0]));
        label.setAttribute("y", String(pt[1] - r - 6));
        label.setAttribute("text-anchor", "middle");
        label.setAttribute("fill", "#4ade80");
        label.setAttribute("stroke", "#0a0c10");
        label.setAttribute("stroke-width", "0.5");
        label.setAttribute("font-size", "32");
        label.setAttribute("font-weight", "bold");
        label.setAttribute("font-family", "ui-monospace, monospace");
        label.textContent = cornerLabels[i];
        svg.appendChild(label);
      });
      svg.removeAttribute("hidden");
      return;
    }

    diag.detectedIds.forEach((id, i) => {
      const corners = diag.detectedCorners[i];
      if (!corners || corners.length !== 4) return;
      const polygon = document.createElementNS(SVG_NS, "polygon");
      polygon.setAttribute("points", corners.map((c) => `${c[0]},${c[1]}`).join(" "));
      polygon.setAttribute("fill", "rgba(74,222,128,0.15)");
      polygon.setAttribute("stroke", "#4ade80");
      polygon.setAttribute("stroke-width", "4");
      svg.appendChild(polygon);

      const cx = corners.reduce((s, c) => s + c[0], 0) / 4;
      const cy = corners.reduce((s, c) => s + c[1], 0) / 4;
      const label = document.createElementNS(SVG_NS, "text");
      label.setAttribute("x", String(cx));
      label.setAttribute("y", String(cy));
      label.setAttribute("text-anchor", "middle");
      label.setAttribute("dominant-baseline", "middle");
      label.setAttribute("fill", "#0a0c10");
      label.setAttribute("stroke", "#4ade80");
      label.setAttribute("stroke-width", "1");
      label.setAttribute("font-size", "48");
      label.setAttribute("font-weight", "bold");
      label.setAttribute("font-family", "ui-monospace, monospace");
      label.textContent = String(id);
      svg.appendChild(label);
    });
    svg.removeAttribute("hidden");
  }

  private updateCameraRoiOverlay(): void {
    const svg = q<SVGSVGElement>("camera-roi-overlay");
    const visible =
      this.state.mode === "calibrate" &&
      this.state.calibrationMethod === "grid" &&
      this.state.cameraFrame !== null;
    if (!visible || !this.state.cameraFrame) {
      svg.setAttribute("hidden", "");
      svg.replaceChildren();
      return;
    }
    const fw = this.state.cameraFrame.width;
    const fh = this.state.cameraFrame.height;
    svg.setAttribute("viewBox", `0 0 ${fw} ${fh}`);

    // Default the polygon to a 10% inset rectangle when none is set yet so
    // the user has 4 corners to grab onto without making a committing API
    // call until they actually drag.
    let corners: [number, number][];
    if (this.state.cameraRoi && this.state.cameraRoi.corners.length === 4) {
      corners = this.state.cameraRoi.corners.map(
        ([x, y]) => [x, y] as [number, number],
      );
    } else {
      const ix = Math.round(fw * 0.1);
      const iy = Math.round(fh * 0.1);
      const iw = Math.round(fw * 0.8);
      const ih = Math.round(fh * 0.8);
      corners = [
        [ix, iy],            // TL
        [ix + iw, iy],       // TR
        [ix + iw, iy + ih],  // BR
        [ix, iy + ih],       // BL
      ];
    }
    svg.replaceChildren();

    // Dim mask outside the polygon. Implemented via an SVG mask: a white
    // rectangle covering the whole frame with the polygon as a black hole.
    // Multiplied against a semi-transparent black overlay, this produces a
    // dimmed area outside the polygon and a fully-clear area inside.
    const maskId = "roi-poly-mask";
    const defs = document.createElementNS(SVG_NS, "defs");
    const maskEl = document.createElementNS(SVG_NS, "mask");
    maskEl.setAttribute("id", maskId);
    const maskRect = document.createElementNS(SVG_NS, "rect");
    maskRect.setAttribute("x", "0");
    maskRect.setAttribute("y", "0");
    maskRect.setAttribute("width", String(fw));
    maskRect.setAttribute("height", String(fh));
    maskRect.setAttribute("fill", "white");
    maskEl.appendChild(maskRect);
    const maskHole = document.createElementNS(SVG_NS, "polygon");
    maskHole.setAttribute(
      "points",
      corners.map(([x, y]) => `${x},${y}`).join(" "),
    );
    maskHole.setAttribute("fill", "black");
    maskEl.appendChild(maskHole);
    defs.appendChild(maskEl);
    svg.appendChild(defs);

    const dim = document.createElementNS(SVG_NS, "rect");
    dim.setAttribute("x", "0");
    dim.setAttribute("y", "0");
    dim.setAttribute("width", String(fw));
    dim.setAttribute("height", String(fh));
    dim.setAttribute("fill", "rgba(0,0,0,0.45)");
    dim.setAttribute("mask", `url(#${maskId})`);
    svg.appendChild(dim);

    // Polygon outline — cyan dashed, drawn through the 4 corners.
    const outline = document.createElementNS(SVG_NS, "polygon");
    outline.setAttribute(
      "points",
      corners.map(([x, y]) => `${x},${y}`).join(" "),
    );
    outline.setAttribute("fill", "none");
    outline.setAttribute("stroke", "#22d3ee");
    outline.setAttribute(
      "stroke-width",
      String(Math.max(2, Math.min(fw, fh) / 300)),
    );
    outline.setAttribute(
      "stroke-dasharray",
      `${Math.max(6, fw / 100)} ${Math.max(4, fw / 200)}`,
    );
    svg.appendChild(outline);

    // 4 corner handles — circles in cam-px units sized to remain grabbable
    // at any preview scale. Labels (TL/TR/BR/BL) help the user verify the
    // corner ordering matches the mat orientation.
    const labels = ["TL", "TR", "BR", "BL"];
    const r = Math.max(12, Math.min(fw, fh) / 50);
    const fontSize = Math.max(12, Math.min(fw, fh) / 60);
    corners.forEach(([cx, cy], i) => {
      const handle = document.createElementNS(SVG_NS, "circle");
      handle.setAttribute("cx", String(cx));
      handle.setAttribute("cy", String(cy));
      handle.setAttribute("r", String(r));
      handle.setAttribute("fill", "rgba(34,211,238,0.4)");
      handle.setAttribute("stroke", "#22d3ee");
      handle.setAttribute(
        "stroke-width",
        String(Math.max(2, Math.min(fw, fh) / 300)),
      );
      handle.setAttribute("data-roi-handle", String(i));
      handle.setAttribute("style", "cursor: grab");
      handle.addEventListener("pointerdown", (ev) =>
        this.startCameraRoiCornerDrag(i, ev, corners, fw, fh),
      );
      svg.appendChild(handle);

      const label = document.createElementNS(SVG_NS, "text");
      label.setAttribute("x", String(cx));
      label.setAttribute("y", String(cy - r - 4));
      label.setAttribute("text-anchor", "middle");
      label.setAttribute("fill", "#22d3ee");
      label.setAttribute("stroke", "#0a0c10");
      label.setAttribute("stroke-width", "0.5");
      label.setAttribute("font-size", String(fontSize));
      label.setAttribute("font-family", "ui-monospace, monospace");
      label.setAttribute("font-weight", "bold");
      label.textContent = labels[i];
      svg.appendChild(label);
    });

    svg.removeAttribute("hidden");
  }

  private startCameraRoiCornerDrag(
    cornerIdx: number,
    ev: PointerEvent,
    startCorners: [number, number][],
    frameW: number,
    frameH: number,
  ): void {
    ev.preventDefault();
    const target = ev.target as Element;
    target.setPointerCapture?.(ev.pointerId);
    this.magnifierCornerDragActive = true;

    // Convert client-space deltas to cam-pixel deltas. The overlay uses
    // preserveAspectRatio="xMidYMid meet" (matching the <img>'s `object-fit:
    // contain`), so the viewBox is uniformly fit inside the SVG bounding
    // rect with letterboxing. Same uniform scale applies on both axes.
    const svg = q<SVGSVGElement>("camera-roi-overlay");
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const scale = Math.min(rect.width / frameW, rect.height / frameH);
    if (scale <= 0) return;
    const inv = 1 / scale;

    const startClientX = ev.clientX;
    const startClientY = ev.clientY;
    const initial = startCorners.map(
      ([x, y]) => [x, y] as [number, number],
    );

    let lastSentAt = 0;
    const SEND_INTERVAL_MS = 80;

    const onMove = (e: PointerEvent): void => {
      const dx = (e.clientX - startClientX) * inv;
      const dy = (e.clientY - startClientY) * inv;
      const moved: [number, number][] = initial.map((pt, i) => {
        if (i !== cornerIdx) return [pt[0], pt[1]];
        return [
          clamp(pt[0] + dx, 0, frameW),
          clamp(pt[1] + dy, 0, frameH),
        ];
      });
      this.state.cameraRoi = {
        corners: moved.map(([x, y]) => [Math.round(x), Math.round(y)]) as [
          number,
          number,
        ][],
        updated_at: 0,
      };
      // Track the dragged marker with the magnifier — the user is trying to
      // place this corner precisely, so showing the corner's current
      // position centered (rather than the cursor's) gives a stable
      // sub-pixel reference even if the cursor drifts.
      this.magnifierFocus = {
        x: moved[cornerIdx][0],
        y: moved[cornerIdx][1],
      };
      this.magnifierCornerIdx = cornerIdx;
      this.updateCameraRoiOverlay();
      const now = performance.now();
      if (now - lastSentAt >= SEND_INTERVAL_MS) {
        this.sendCameraRoi(this.state.cameraRoi);
        lastSentAt = now;
      }
    };
    const onUp = (): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (this.state.cameraRoi) this.sendCameraRoi(this.state.cameraRoi);
      // Drag ended — release magnifier ownership. Corner mode persists if
      // the cursor is still over the handle (cam-preview hover detection
      // re-establishes it); otherwise the next pointermove will revert to
      // the default green plus.
      this.magnifierCornerDragActive = false;
      this.magnifierCornerIdx = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  private sendCameraRoi(roi: CameraRoi): void {
    this.ws.send({
      type: "set_camera_roi",
      corners: roi.corners,
      clear: false,
    });
  }

  private updateGridOverlay(): void {
    const svg = q<SVGSVGElement>("grid-overlay");
    const result = this.state.explicitGrid;
    if (
      this.state.mode !== "calibrate" ||
      !result ||
      result.frameWidth <= 0 ||
      result.frameHeight <= 0
    ) {
      svg.setAttribute("hidden", "");
      svg.replaceChildren();
      return;
    }
    svg.setAttribute("viewBox", `0 0 ${result.frameWidth} ${result.frameHeight}`);
    svg.replaceChildren();
    const minDim = Math.min(result.frameWidth, result.frameHeight);

    // viewBox frame: amber outline confirms the SVG is mounted and aligned with
    // the camera image. If you see this rectangle but no lines inside, the
    // detector found nothing at the corresponding pipeline stage.
    const frame = document.createElementNS(SVG_NS, "rect");
    frame.setAttribute("x", "0");
    frame.setAttribute("y", "0");
    frame.setAttribute("width", String(result.frameWidth));
    frame.setAttribute("height", String(result.frameHeight));
    frame.setAttribute("fill", "none");
    frame.setAttribute("stroke", "#fbbf24");
    frame.setAttribute("stroke-opacity", "0.7");
    frame.setAttribute("stroke-width", String(Math.max(2, minDim / 300)));
    frame.setAttribute("stroke-dasharray", `${minDim / 60} ${minDim / 60}`);
    svg.appendChild(frame);

    // Diagnostic layers, painted in order so later (more-specific) layers
    // overpaint earlier (more-general) ones:
    //  1. weak     — every Hough segment (low threshold). Gray, thin.
    //  2. strong   — bold candidates (high threshold). White, medium.
    //  3. axis A   — strong lines that clustered into the first grid family.
    //  4. axis B   — strong lines in the perpendicular family.
    //  5. intersections — major-line crossings (already snapped to lattice).
    //
    // Stroke widths are in cam-pixel units (= viewBox units). They need to be
    // a meaningful fraction of the frame so they remain visible after the
    // browser scales the SVG down to the preview size.
    drawLineSet(svg, result.weakLinesCam, {
      stroke: "#94a3b8",
      strokeOpacity: "0.5",
      strokeWidth: String(Math.max(2, minDim / 300)),
    });
    drawLineSet(svg, result.strongLinesCam, {
      stroke: "#e2e8f0",
      strokeOpacity: "0.85",
      strokeWidth: String(Math.max(3, minDim / 200)),
    });
    drawLineSet(svg, result.axisALinesCam, {
      stroke: "#22d3ee", // bright cyan = mat X axis (grid)
      strokeOpacity: "1",
      strokeWidth: String(Math.max(5, minDim / 120)),
    });
    drawLineSet(svg, result.axisBLinesCam, {
      stroke: "#3b82f6", // bright blue = mat Y axis (grid)
      strokeOpacity: "1",
      strokeWidth: String(Math.max(5, minDim / 120)),
    });
    drawLineSet(svg, result.diagonalLinesCam, {
      stroke: "#ec4899", // pink = strong lines off both grid axes (e.g. mat angle guides)
      strokeOpacity: "0.95",
      strokeWidth: String(Math.max(4, minDim / 150)),
    });

    if (result.intersectionsCam.length > 0) {
      const dotColor = result.status.detected ? "#4ade80" : "#fb923c";
      const radius = Math.max(6, minDim / 100);
      for (const [x, y] of result.intersectionsCam) {
        const dot = document.createElementNS(SVG_NS, "circle");
        dot.setAttribute("cx", String(x));
        dot.setAttribute("cy", String(y));
        dot.setAttribute("r", String(radius));
        dot.setAttribute("fill", dotColor);
        dot.setAttribute("fill-opacity", "0.85");
        dot.setAttribute("stroke", "#0a0c10");
        dot.setAttribute("stroke-width", String(Math.max(1, minDim / 600)));
        svg.appendChild(dot);
      }
    }

    // Stage counts in the top-left corner so the user can tell at a glance
    // which pipeline step gave up — even when a stage produced 0 segments
    // (in which case there's nothing to draw for that color).
    const counts = [
      ["weak", result.weakLinesCam.length, "#94a3b8"],
      ["strong", result.strongLinesCam.length, "#e2e8f0"],
      ["axis X", result.axisALinesCam.length, "#22d3ee"],
      ["axis Y", result.axisBLinesCam.length, "#3b82f6"],
      ["diagonals", result.diagonalLinesCam.length, "#ec4899"],
      [
        "intersections",
        result.intersectionsCam.length,
        result.status.detected ? "#4ade80" : "#fb923c",
      ],
    ] as const;
    const fontSize = Math.max(14, minDim / 30);
    counts.forEach(([label, n, color], i) => {
      const text = document.createElementNS(SVG_NS, "text");
      text.setAttribute("x", String(fontSize));
      text.setAttribute("y", String(fontSize * (1.4 + i * 1.2)));
      text.setAttribute("fill", color as string);
      text.setAttribute("stroke", "#0a0c10");
      text.setAttribute("stroke-width", "1");
      text.setAttribute("paint-order", "stroke");
      text.setAttribute("font-size", String(fontSize));
      text.setAttribute("font-family", "ui-monospace, monospace");
      text.setAttribute("font-weight", "bold");
      text.textContent = `${label}: ${n}`;
      svg.appendChild(text);
    });

    svg.removeAttribute("hidden");
  }

  // ─── Misc actions ────────────────────────────────────────────────────────

  private switchCamera(index: number | null): void {
    this.state.switchingCamera = true;
    this.state.cameraError = null;
    this.ws.send({ type: "set_camera", index });
    this.applyCameraCard();
  }

  private setPreviewHidden(hidden: boolean): void {
    this.previewHidden = hidden;
    writeBool("previewHidden", hidden);
    this.applyCameraCard();
  }

  private commitMeasurement(): void {
    if (this.state.calibrationMethod === "grid") {
      // Grid-only: server reads the latest dot positions + grid capture from
      // its own state, so the command carries no measurement.
      if (
        this.state.detectedDotsCam.length !== 4 ||
        !this.state.matGrid?.detected
      )
        return;
      this.ws.send({ type: "finish_calibration", horizontal_mm: null });
      return;
    }
    if (this.state.capturedMarkers !== 4) return;
    const grid = this.state.matGrid;
    const passiveAvailable =
      grid !== null && grid.detected && !this.state.useRuler;
    if (passiveAvailable) {
      // Passive grid path: server derives mat dimensions from the detected
      // grid pitch, no ruler measurement needed.
      this.ws.send({ type: "finish_calibration", horizontal_mm: null });
      return;
    }
    const mm = parseLengthMm(this.pendingMm);
    if (mm === null || mm <= 0) return;
    this.ws.send({ type: "finish_calibration", horizontal_mm: mm });
    this.pendingMm = "";
    q<HTMLInputElement>("measurement-input").value = "";
    this.refreshMeasurementHint();
  }

  private refreshMeasurementHint(): void {
    const hint = q("measurement-hint");
    if (!this.pendingMm.trim()) {
      hint.textContent = "";
      hint.className = "measurement-hint";
      return;
    }
    const mm = parseLengthMm(this.pendingMm);
    if (mm === null) {
      hint.textContent = "couldn't parse — try '305' or '12 in'";
      hint.className = "measurement-hint warn";
    } else if (mm <= 0) {
      hint.textContent = "must be positive";
      hint.className = "measurement-hint warn";
    } else {
      // Show conversion only when the user typed a non-mm unit so it's useful, not noise.
      const looksLikeMm = /^[\d.\s]+(mm)?$/i.test(this.pendingMm.trim());
      hint.textContent = looksLikeMm ? `${mm.toFixed(1)} mm` : `→ ${mm.toFixed(1)} mm`;
      hint.className = "measurement-hint";
    }
  }
}

// ─── DOM helpers ───────────────────────────────────────────────────────────

function q<T extends Element = HTMLElement>(role: string, root: ParentNode = document): T {
  const el = root.querySelector(`[data-role="${role}"]`);
  if (!el) throw new Error(`missing element [data-role="${role}"]`);
  return el as unknown as T;
}

function qCard(name: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-card="${name}"]`);
  if (!el) throw new Error(`missing card [data-card="${name}"]`);
  return el;
}

function setPill(host: HTMLElement, kind: "ok" | "warn" | "error" | "muted", text: string): void {
  host.replaceChildren();
  const span = document.createElement("span");
  span.className = `pill ${kind}`;
  span.textContent = text;
  host.appendChild(span);
}

function drawLineSet(
  svg: SVGSVGElement,
  lines: [number, number, number, number][],
  attrs: { stroke: string; strokeOpacity: string; strokeWidth: string },
): void {
  if (lines.length === 0) return;
  const SVG_NS_LOCAL = "http://www.w3.org/2000/svg";
  for (const [x1, y1, x2, y2] of lines) {
    const line = document.createElementNS(SVG_NS_LOCAL, "line");
    line.setAttribute("x1", String(x1));
    line.setAttribute("y1", String(y1));
    line.setAttribute("x2", String(x2));
    line.setAttribute("y2", String(y2));
    line.setAttribute("stroke", attrs.stroke);
    line.setAttribute("stroke-opacity", attrs.strokeOpacity);
    line.setAttribute("stroke-width", attrs.strokeWidth);
    line.setAttribute("stroke-linecap", "round");
    svg.appendChild(line);
  }
}

function setActive(btn: HTMLElement, active: boolean, primaryWhenInactive?: string): void {
  if (active) {
    btn.className = "active";
  } else {
    btn.className = primaryWhenInactive ?? "";
  }
}

// ─── Pure helpers ──────────────────────────────────────────────────────────

function parsePending(p: PendingMargins): { left: number; top: number; right: number; bottom: number } {
  const safe = (v: string) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  };
  return { left: safe(p.left), top: safe(p.top), right: safe(p.right), bottom: safe(p.bottom) };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Build the user-facing description of a detected mat grid for the calibration
 * card pill, e.g. "Metric mat detected · 10 mm grid (1 mm subdivisions)" or
 * "Imperial mat detected · 1 inch grid (¼ inch subdivisions)".
 */
function describeGrid(grid: MatGridStatus): string {
  if (!grid.detected || !grid.grid_system || grid.subdivisions_per_major === null) {
    return "Mat grid detected";
  }
  const n = grid.subdivisions_per_major;
  if (grid.grid_system === "metric") {
    const minor = n === 10 ? "1 mm" : n === 5 ? "2 mm" : `${n} subdivisions`;
    return `Metric mat detected · 10 mm grid (${minor} subdivisions)`;
  }
  // imperial
  const fraction =
    n === 2 ? "½ inch" : n === 4 ? "¼ inch" : n === 8 ? "⅛ inch" : n === 16 ? "1⁄16 inch" : `${n} per inch`;
  return `Imperial mat detected · 1 inch grid (${fraction} subdivisions)`;
}

/**
 * Format a millimeter value for display in the measurement input. Strips trailing zeros
 * and floating-point noise so a value typed as "305" round-trips back as "305", and a
 * value typed as "12 in" (= 304.8 mm) round-trips as "304.8".
 */
function formatMmForInput(mm: number): string {
  return String(parseFloat(mm.toFixed(2)));
}

/**
 * Parse a length expression into millimeters. Accepts:
 *   "305", "305 mm", "30.5 cm", "12 in", "12 inch", "12 inches", "12\""
 * Returns null if it can't parse.
 */
function parseLengthMm(input: string): number | null {
  const m = input
    .trim()
    .toLowerCase()
    .match(/^(-?\d+(?:\.\d+)?|-?\.\d+)\s*(.*)$/);
  if (!m) return null;
  const value = parseFloat(m[1]);
  if (!Number.isFinite(value)) return null;
  const unit = m[2].trim().replace(/\.$/, "");
  switch (unit) {
    case "":
    case "mm":
    case "millimeter":
    case "millimeters":
      return value;
    case "cm":
    case "centimeter":
    case "centimeters":
      return value * 10;
    case "m":
    case "meter":
    case "meters":
      return value * 1000;
    case "in":
    case "ins":
    case "inch":
    case "inches":
    case '"':
      return value * 25.4;
    case "ft":
    case "foot":
    case "feet":
    case "'":
      return value * 304.8;
    default:
      return null;
  }
}

function readBool(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem("projectoros." + key);
    if (v === null) return fallback;
    return v === "1";
  } catch {
    return fallback;
  }
}

function writeBool(key: string, v: boolean): void {
  try {
    localStorage.setItem("projectoros." + key, v ? "1" : "0");
  } catch {
    /* ignore */
  }
}

function readNumber(key: string, fallback: number): number {
  try {
    const v = localStorage.getItem("projectoros." + key);
    if (v === null) return fallback;
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : fallback;
  } catch {
    return fallback;
  }
}

function writeNumber(key: string, v: number): void {
  try {
    localStorage.setItem("projectoros." + key, String(v));
  } catch {
    /* ignore */
  }
}

function formatRelativeTime(ts: number): string {
  const seconds = Date.now() / 1000 - ts;
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86400)} d ago`;
}

new ControlApp().start();
