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

import type { Calibration, DetectedObject, Mode, ServerEvent, WorkSurface } from "../types";
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

interface ViewState {
  mode: Mode;
  connection: "connecting" | "open" | "closed";
  calibration: Calibration | null;
  projector: [number, number] | null;
  capturedMarkers: number;
  calibDiag: CalibrationDiagnostic | null;
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
    capturedMarkers: 0,
    calibDiag: null,
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
  };
  private readonly ws: WsClient;
  // Whether the camera <img> currently has its MJPEG src attribute set. Used to avoid
  // restarting the long-lived multipart HTTP connection on every render.
  private cameraPreviewActive = false;
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
    q("mode-calibrate-btn").addEventListener("click", () =>
      this.ws.send({ type: "start_calibration" }),
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
        this.state.capturedMarkers = ev.detected_marker_ids.length;
        this.state.calibDiag = {
          detectedIds: ev.detected_marker_ids,
          detectedCorners: ev.detected_corners_cam,
          frameWidth: ev.frame_width,
          frameHeight: ev.frame_height,
          rejectedCount: ev.rejected_count,
          lastSeenAt: Date.now(),
        };
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
          this.state.calibDiag = null;
        }
        this.applyMode();
        this.applyCalibrationCard();
        this.applyDetections();
        this.updateMarkerOverlay();
        return;
      case "calibration_updated":
        this.state.calibration = ev.calibration;
        this.applyCalibrationStatus();
        this.applyMode();
        return;
      case "calibration_prompt":
        this.state.capturedMarkers = 0;
        this.state.calibDiag = null;
        this.applyCalibrationCard();
        this.updateMarkerOverlay();
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
    setPill(q("mode-pill"), cls, this.state.mode);

    setActive(q("mode-idle-btn"), this.state.mode === "idle");
    setActive(q("mode-calibrate-btn"), this.state.mode === "calibrate", "primary");
    setActive(q("mode-track-btn"), this.state.mode === "track");

    q<HTMLButtonElement>("mode-calibrate-btn").disabled = !this.state.projector;
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
    if (this.state.mode !== "calibrate") return;

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

    q<HTMLButtonElement>("calib-save-btn").disabled = this.state.capturedMarkers < 4;
    this.refreshMeasurementHint();
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
    const mm = parseLengthMm(this.pendingMm);
    if (mm === null || mm <= 0) return;
    if (this.state.capturedMarkers !== 4) return;
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
