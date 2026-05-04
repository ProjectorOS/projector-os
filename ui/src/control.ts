// Control entry: regular web UI for driving the system from the laptop browser.
// Connects to the same WebSocket as the projector view; either client can issue
// commands and both stay in sync via server broadcasts.

import type { Calibration, DetectedObject, Mode, ServerEvent, WorkSurface } from "./types";
import { defaultServerHttpUrl, defaultServerWsUrl, WsClient } from "./ws-client";

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
  lastDetectionTs: number | null;
  displays: Display[];
  projectorRunning: boolean;
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

class ControlApp {
  private state: ViewState = {
    mode: "idle",
    connection: "connecting",
    calibration: null,
    projector: null,
    capturedMarkers: 0,
    calibDiag: null,
    detections: [],
    lastDetectionTs: null,
    displays: [],
    projectorRunning: false,
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
  private pendingMm = "";
  // While the user is dragging a work-surface edge, suppress full re-renders so the
  // SVG handles and pointer state stay alive. Updates apply directly via DOM refs.
  private draggingEdge: "top" | "bottom" | "left" | "right" | null = null;
  // Persistent <img> for the camera MJPEG preview. Re-used across renders so we don't
  // tear down and reopen the long-lived multipart HTTP connection on every event.
  private cameraPreviewImg: HTMLImageElement | null = null;
  // Persistent <input> for the measurement field. The calibration card re-renders ~6
  // times per second on calibration_captured events; rebuilding the input would steal
  // focus mid-keystroke and you couldn't type. Reusing the same element keeps focus
  // and the typed value alive across renders.
  private measurementInput: HTMLInputElement | null = null;
  // UI prefs persisted to localStorage (per browser).
  private workSurfaceCollapsed = readBool("workSurfaceCollapsed", false);
  private previewRotation: 0 | 180 = readNumber("previewRotation", 0) === 180 ? 180 : 0;

  constructor(private readonly root: HTMLElement) {
    this.ws = new WsClient({
      url: defaultServerWsUrl(),
      onEvent: (e) => this.onEvent(e),
      onState: (s) => {
        this.state.connection = s;
        if (s === "open") {
          void this.fetchDisplays();
          void this.fetchCameras();
        }
        this.render();
      },
    });
  }

  start(): void {
    this.render();
    this.ws.connect();
    void this.fetchDisplays();
    void this.fetchCameras();
  }

  private onEvent(ev: ServerEvent): void {
    switch (ev.type) {
      case "hello":
        this.state.mode = ev.mode;
        this.state.calibration = ev.calibration;
        this.state.projector = ev.projector;
        this.state.workSurface = ev.work_surface;
        this.state.showWorkSurfaceOutline = ev.show_work_surface_outline;
        this.state.cameraIndex = ev.camera_index;
        this.state.cameraOpen = ev.camera_open;
        break;
      case "mode_changed":
        this.state.mode = ev.mode;
        if (ev.mode !== "calibrate") {
          this.state.capturedMarkers = 0;
          this.state.calibDiag = null;
        }
        break;
      case "calibration_updated":
        this.state.calibration = ev.calibration;
        break;
      case "calibration_prompt":
        this.state.capturedMarkers = 0;
        this.state.calibDiag = null;
        break;
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
        break;
      case "projector_registered":
        this.state.projector = [ev.proj_width, ev.proj_height];
        this.state.switchingDisplay = false;
        void this.fetchDisplays();
        break;
      case "work_surface_updated":
        this.state.workSurface = ev.work_surface;
        this.state.showWorkSurfaceOutline = ev.show_outline;
        // Drop any pending edits — they're now stale.
        this.state.pendingMargins = null;
        break;
      case "camera_changed":
        this.state.cameraIndex = ev.camera_index;
        this.state.cameraOpen = ev.camera_open;
        this.state.cameraError = ev.error;
        this.state.switchingCamera = false;
        break;
      case "frame_stats":
        this.state.frameStats = {
          frameIndex: ev.frame_index,
          fps: ev.fps,
          lastFrameAgeMs: ev.last_frame_age_ms,
          detectorRuns: ev.detector_runs,
          lastDetectedCount: ev.last_detected_count,
          receivedAt: Date.now(),
        };
        break;
      case "detections":
        this.state.detections = ev.objects;
        this.state.lastDetectionTs = ev.ts;
        break;
    }
    this.render();
  }

  private async fetchDisplays(): Promise<void> {
    try {
      const res = await fetch(`${SERVER_HTTP}/displays`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as DisplaysResponse;
      this.state.displays = data.displays;
      this.state.projectorRunning = data.projector_running;
      this.state.displaysError = null;
    } catch (e) {
      this.state.displaysError = e instanceof Error ? e.message : String(e);
    }
    this.render();
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
    this.render();
  }

  private switchCamera(index: number | null): void {
    this.state.switchingCamera = true;
    this.state.cameraError = null;
    this.ws.send({ type: "set_camera", index });
    this.render();
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
      this.render();
    }
  }

  private async closeProjector(): Promise<void> {
    try {
      await fetch(`${SERVER_HTTP}/close_projector`, { method: "POST" });
      this.state.projector = null;
      this.state.switchingDisplay = false;
      await this.fetchDisplays();
    } catch {
      // Non-fatal; control panel still works.
    }
  }

  private render(): void {
    if (this.draggingEdge) return;

    // The `innerHTML = ""` below detaches every input from the DOM, which loses focus
    // and caret position even for elements we keep across renders (the measurement
    // input). Capture focus before, restore after, so typing isn't interrupted by the
    // ~6 Hz calibration_captured / 1 Hz frame_stats event stream.
    const focusSnapshot = this.captureFocus();

    this.root.innerHTML = "";
    this.root.appendChild(this.renderStatusCard());
    this.root.appendChild(this.renderDisplayCard());
    if (this.state.projector) {
      this.root.appendChild(this.renderWorkSurfaceCard());
    }
    this.root.appendChild(this.renderCameraCard());
    this.root.appendChild(this.renderModeCard());
    if (this.state.mode === "calibrate") {
      this.root.appendChild(this.renderCalibrationCard());
    }
    if (this.state.mode === "track") {
      this.root.appendChild(this.renderTrackCard());
    }

    this.restoreFocus(focusSnapshot);
  }

  private captureFocus(): { selector: string; selStart: number | null; selEnd: number | null } | null {
    const ae = document.activeElement;
    if (!(ae instanceof HTMLInputElement) && !(ae instanceof HTMLTextAreaElement)) return null;
    let selector: string | null = null;
    if (ae === this.measurementInput) {
      selector = 'input[data-role="measurement-input"]';
    } else if (ae instanceof HTMLInputElement && ae.dataset.field) {
      selector = `input[data-field="${ae.dataset.field}"]`;
    }
    if (!selector) return null;
    return {
      selector,
      selStart: ae.selectionStart,
      selEnd: ae.selectionEnd,
    };
  }

  private restoreFocus(snap: ReturnType<typeof this.captureFocus>): void {
    if (!snap) return;
    const target = this.root.querySelector(snap.selector) as
      | HTMLInputElement
      | HTMLTextAreaElement
      | null;
    if (!target) return;
    target.focus();
    if (snap.selStart !== null && snap.selEnd !== null) {
      try {
        target.setSelectionRange(snap.selStart, snap.selEnd);
      } catch {
        // setSelectionRange isn't supported on every input type (e.g. number); ignore.
      }
    }
  }

  private renderStatusCard(): HTMLElement {
    const card = el("div", "card");
    card.appendChild(el("h2", "", "Status"));

    const kv = el("div", "kv");
    kv.appendChild(el("div", "k", "Connection"));
    kv.appendChild(this.connectionPill());
    kv.appendChild(el("div", "k", "Mode"));
    kv.appendChild(this.modePill());
    kv.appendChild(el("div", "k", "Calibration"));
    kv.appendChild(
      el(
        "div",
        "v",
        this.state.calibration
          ? `${this.state.calibration.mat_width_mm.toFixed(1)} × ${this.state.calibration.mat_height_mm.toFixed(1)} mm — ${formatRelativeTime(this.state.calibration.created_at)}`
          : "not calibrated",
      ),
    );
    card.appendChild(kv);
    return card;
  }

  private renderDisplayCard(): HTMLElement {
    const card = el("div", "card");
    card.appendChild(el("h2", "", "Projector display"));

    const projectorOpen = this.state.projector !== null;
    const showPicker = !projectorOpen || this.state.switchingDisplay;

    if (projectorOpen && !this.state.switchingDisplay) {
      const [w, h] = this.state.projector!;
      const matched = this.state.displays.find((d) => d.width === w && d.height === h);
      const label = matched
        ? `${matched.name} — ${w} × ${h} px`
        : `connected — ${w} × ${h} px`;
      const row = el("div", "row");
      row.appendChild(el("span", "pill ok", "Open"));
      row.appendChild(el("div", "v", label));
      card.appendChild(row);

      const actions = el("div", "row");
      const switchBtn = el("button", "", "Switch display");
      switchBtn.addEventListener("click", () => {
        this.state.switchingDisplay = true;
        void this.fetchDisplays();
      });
      actions.appendChild(switchBtn);

      const closeBtn = el("button", "", "Close projector window");
      closeBtn.addEventListener("click", () => void this.closeProjector());
      actions.appendChild(closeBtn);
      card.appendChild(actions);
    }

    if (showPicker) {
      const help = el(
        "div",
        "help",
        projectorOpen
          ? "Pick a different display. The current projector window will be closed automatically."
          : "Pick which connected display the projector is pointing at. The kiosk window will open there in fullscreen.",
      );
      card.appendChild(help);

      if (this.state.displays.length === 0) {
        card.appendChild(
          el(
            "div",
            "help",
            this.state.displaysError
              ? `Could not list displays: ${this.state.displaysError}`
              : "No displays found.",
          ),
        );
      } else {
        const list = el("div", "displays");
        for (const d of this.state.displays) {
          list.appendChild(this.renderDisplayRow(d));
        }
        card.appendChild(list);
      }

      const actions = el("div", "row");
      const refresh = el("button", "", "Refresh list");
      refresh.addEventListener("click", () => void this.fetchDisplays());
      actions.appendChild(refresh);

      if (projectorOpen && this.state.switchingDisplay) {
        const cancel = el("button", "", "Cancel");
        cancel.addEventListener("click", () => {
          this.state.switchingDisplay = false;
          this.render();
        });
        actions.appendChild(cancel);
      }
      card.appendChild(actions);
    }

    return card;
  }

  private renderDisplayRow(d: Display): HTMLElement {
    const row = el("div", "display-row");
    const info = el("div", "display-info");
    info.appendChild(el("div", "display-name", d.name + (d.is_main ? "  (main)" : "")));
    info.appendChild(
      el(
        "div",
        "display-meta",
        `${d.width} × ${d.height} px @ (${d.x}, ${d.y})`,
      ),
    );
    row.appendChild(info);

    const launchBtn = el("button", "primary", d.is_main ? "Launch on this display" : "Launch");
    launchBtn.addEventListener("click", () => void this.launchProjector(d));
    row.appendChild(launchBtn);
    return row;
  }

  private renderWorkSurfaceCard(): HTMLElement {
    const card = el("div", "card");

    const proj = this.state.projector!;
    const ws = this.state.workSurface;
    const collapsed = this.workSurfaceCollapsed;

    // Clickable header that toggles collapse. Shows a summary on the right when collapsed.
    const header = el("div", "card-header");
    const title = el("h2", "", "Work surface");
    header.appendChild(title);
    if (collapsed) {
      const summary = el("span", "card-summary");
      summary.textContent = ws ? `${ws.width} × ${ws.height}` : "—";
      header.appendChild(summary);
    }
    const chevron = el("span", "chevron", collapsed ? "▸" : "▾");
    header.appendChild(chevron);
    header.addEventListener("click", () => {
      this.workSurfaceCollapsed = !this.workSurfaceCollapsed;
      writeBool("workSurfaceCollapsed", this.workSurfaceCollapsed);
      this.render();
    });
    card.appendChild(header);

    if (collapsed) return card;

    const margins = this.computeMargins(proj, ws);
    const pending = this.state.pendingMargins ?? {
      left: String(margins.left),
      top: String(margins.top),
      right: String(margins.right),
      bottom: String(margins.bottom),
    };
    this.state.pendingMargins = pending;

    const info = el("div", "kv");
    info.appendChild(el("div", "k", "Projector"));
    info.appendChild(el("div", "v", `${proj[0]} × ${proj[1]} px`));
    info.appendChild(el("div", "k", "Work surface"));
    const wsInfo = el("div", "v");
    wsInfo.dataset.role = "ws-info";
    wsInfo.textContent = ws ? `${ws.width} × ${ws.height} px @ (${ws.x}, ${ws.y})` : "not set";
    info.appendChild(wsInfo);
    card.appendChild(info);

    card.appendChild(
      el(
        "div",
        "help",
        "Drag the dashed edges in the preview, or type margin values directly. Changes apply when you release the edge or click Apply.",
      ),
    );

    const grid = el("div", "margin-grid");
    grid.appendChild(this.marginField("Top", "top", pending.top));
    grid.appendChild(this.marginField("Bottom", "bottom", pending.bottom));
    grid.appendChild(this.marginField("Left", "left", pending.left));
    grid.appendChild(this.marginField("Right", "right", pending.right));
    card.appendChild(grid);

    card.appendChild(this.buildWorkSurfacePreview(proj, pending));

    const toggleRow = el("label", "toggle-row");
    const toggle = el("input") as HTMLInputElement;
    toggle.type = "checkbox";
    toggle.checked = this.state.showWorkSurfaceOutline;
    toggle.addEventListener("change", () => {
      this.applyMargins(this.state.pendingMargins!, toggle.checked);
    });
    toggleRow.appendChild(toggle);
    toggleRow.appendChild(el("span", "", "Show outline on projector"));
    card.appendChild(toggleRow);

    const actions = el("div", "row");
    const apply = el("button", "primary", "Apply");
    apply.addEventListener("click", () =>
      this.applyMargins(this.state.pendingMargins!, this.state.showWorkSurfaceOutline),
    );
    actions.appendChild(apply);

    const reset = el("button", "", "Reset to full projection");
    reset.addEventListener("click", () => {
      this.state.pendingMargins = null;
      this.applyMargins(
        { left: "0", top: "0", right: "0", bottom: "0" },
        this.state.showWorkSurfaceOutline,
      );
    });
    actions.appendChild(reset);
    card.appendChild(actions);

    return card;
  }

  private marginField(label: string, name: "top" | "bottom" | "left" | "right", value: string): HTMLElement {
    const wrapper = el("label", "margin-field");
    wrapper.appendChild(el("span", "k", label));
    const input = el("input") as HTMLInputElement;
    input.type = "number";
    input.min = "0";
    input.step = "1";
    input.placeholder = "0";
    input.value = value;
    input.dataset.field = name;
    input.addEventListener("input", () => {
      const pending = { ...this.state.pendingMargins!, [name]: input.value };
      this.state.pendingMargins = pending;
      this.updatePreviewSvg(pending);
    });
    wrapper.appendChild(input);
    return wrapper;
  }

  private buildWorkSurfacePreview(proj: [number, number], pending: PendingMargins): SVGSVGElement {
    const SVG_NS = "http://www.w3.org/2000/svg";
    const previewW = 320;
    const scale = previewW / proj[0];
    const previewH = Math.round(proj[1] * scale);

    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "ws-preview");
    svg.setAttribute("width", String(previewW));
    svg.setAttribute("height", String(previewH));
    svg.setAttribute("viewBox", `0 0 ${previewW} ${previewH}`);
    svg.dataset.scale = String(scale);

    const outer = document.createElementNS(SVG_NS, "rect");
    outer.setAttribute("x", "0");
    outer.setAttribute("y", "0");
    outer.setAttribute("width", String(previewW));
    outer.setAttribute("height", String(previewH));
    outer.setAttribute("fill", "#0a0c10");
    outer.setAttribute("stroke", "#475569");
    outer.setAttribute("stroke-width", "1");
    svg.appendChild(outer);

    const innerRect = document.createElementNS(SVG_NS, "rect");
    innerRect.dataset.role = "inner-rect";
    innerRect.setAttribute("fill", "rgba(74,222,128,0.08)");
    innerRect.setAttribute("stroke", "#4ade80");
    innerRect.setAttribute("stroke-width", "1.5");
    innerRect.setAttribute("stroke-dasharray", "4 3");
    svg.appendChild(innerRect);

    // Edge handles. Each has a small hit area; pointer-events catch the drag.
    const edges: ("top" | "bottom" | "left" | "right")[] = ["top", "bottom", "left", "right"];
    for (const edge of edges) {
      const handle = document.createElementNS(SVG_NS, "rect");
      handle.dataset.edge = edge;
      handle.setAttribute("fill", "transparent");
      handle.style.cursor = edge === "top" || edge === "bottom" ? "ns-resize" : "ew-resize";
      handle.addEventListener("pointerdown", (e: PointerEvent) =>
        this.startEdgeDrag(edge, e, svg, innerRect, scale, proj),
      );
      svg.appendChild(handle);
    }

    this.applyPreviewLayout(svg, proj, pending);
    return svg;
  }

  private updatePreviewSvg(pending: PendingMargins): void {
    const svg = this.root.querySelector(".ws-preview") as SVGSVGElement | null;
    const proj = this.state.projector;
    if (!svg || !proj) return;
    this.applyPreviewLayout(svg, proj, pending);
  }

  private applyPreviewLayout(svg: SVGSVGElement, proj: [number, number], pending: PendingMargins): void {
    const scale = parseFloat(svg.dataset.scale ?? "1");
    const m = parsePending(pending);
    const innerX = m.left * scale;
    const innerY = m.top * scale;
    const innerW = Math.max(0, (proj[0] - m.left - m.right) * scale);
    const innerH = Math.max(0, (proj[1] - m.top - m.bottom) * scale);

    const innerRect = svg.querySelector('rect[data-role="inner-rect"]') as SVGRectElement | null;
    if (innerRect) {
      innerRect.setAttribute("x", String(innerX));
      innerRect.setAttribute("y", String(innerY));
      innerRect.setAttribute("width", String(innerW));
      innerRect.setAttribute("height", String(innerH));
    }

    const T = 10; // handle thickness
    const layouts: Record<"top" | "bottom" | "left" | "right", { x: number; y: number; w: number; h: number }> = {
      top: { x: innerX, y: innerY - T / 2, w: innerW, h: T },
      bottom: { x: innerX, y: innerY + innerH - T / 2, w: innerW, h: T },
      left: { x: innerX - T / 2, y: innerY, w: T, h: innerH },
      right: { x: innerX + innerW - T / 2, y: innerY, w: T, h: innerH },
    };
    for (const edge of Object.keys(layouts) as Array<keyof typeof layouts>) {
      const handle = svg.querySelector(`rect[data-edge="${edge}"]`) as SVGRectElement | null;
      if (!handle) continue;
      const { x, y, w, h } = layouts[edge];
      handle.setAttribute("x", String(x));
      handle.setAttribute("y", String(y));
      handle.setAttribute("width", String(Math.max(0, w)));
      handle.setAttribute("height", String(Math.max(0, h)));
    }
  }

  private startEdgeDrag(
    edge: "top" | "bottom" | "left" | "right",
    e: PointerEvent,
    svg: SVGSVGElement,
    _innerRect: SVGRectElement,
    scale: number,
    proj: [number, number],
  ): void {
    e.preventDefault();
    const startMargins = parsePending(this.state.pendingMargins!);
    const startClientX = e.clientX;
    const startClientY = e.clientY;
    const minWidth = 50; // projector px — never collapse below this
    const minHeight = 50;

    this.draggingEdge = edge;
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
      this.applyPreviewLayout(svg, proj, pending);
      this.syncInputsFromPending(pending);
      this.updateWsInfoLive(pending, proj);

      const now = performance.now();
      if (now - lastSentAt >= SEND_INTERVAL_MS) {
        this.applyMargins(pending, this.state.showWorkSurfaceOutline);
        lastSentAt = now;
      }
    };

    const onUp = (): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      this.draggingEdge = null;
      // Final commit so the last position (which may have been throttled out) sticks.
      this.applyMargins(this.state.pendingMargins!, this.state.showWorkSurfaceOutline);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  private syncInputsFromPending(p: PendingMargins): void {
    for (const name of ["top", "bottom", "left", "right"] as const) {
      const input = this.root.querySelector(`input[data-field="${name}"]`) as HTMLInputElement | null;
      if (input && input.value !== p[name]) input.value = p[name];
    }
  }

  private updateWsInfoLive(pending: PendingMargins, proj: [number, number]): void {
    const node = this.root.querySelector('[data-role="ws-info"]') as HTMLElement | null;
    if (!node) return;
    const m = parsePending(pending);
    const x = Math.max(0, m.left);
    const y = Math.max(0, m.top);
    const width = Math.max(1, proj[0] - m.left - m.right);
    const height = Math.max(1, proj[1] - m.top - m.bottom);
    node.textContent = `${width} × ${height} px @ (${x}, ${y})`;
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

  private renderCameraCard(): HTMLElement {
    const card = el("div", "card");
    card.appendChild(el("h2", "", "Camera"));

    const showPicker = !this.state.cameraOpen || this.state.switchingCamera;

    if (this.state.cameraOpen && this.state.cameraIndex !== null && !this.state.switchingCamera) {
      // Live: preview is the prominent thing, plus a thin status row + actions.
      card.appendChild(this.renderCameraPreview(this.state.mode === "calibrate"));

      const status = el("div", "row");
      status.appendChild(el("span", "pill ok", "Live"));
      const current = this.state.cameras.find((c) => c.index === this.state.cameraIndex);
      const label = current ? `${current.name} (index ${current.index})` : `Camera ${this.state.cameraIndex}`;
      status.appendChild(el("div", "v", label));
      card.appendChild(status);

      card.appendChild(this.renderHeartbeatRow());

      const actions = el("div", "row");
      const switchBtn = el("button", "", "Switch camera");
      switchBtn.addEventListener("click", () => {
        this.state.switchingCamera = true;
        void this.fetchCameras();
      });
      actions.appendChild(switchBtn);

      const rotateBtn = el(
        "button",
        "",
        this.previewRotation === 180 ? "Rotate preview (180°)" : "Rotate preview",
      );
      rotateBtn.title = "Cycle preview rotation. Cosmetic only — does not affect calibration.";
      rotateBtn.addEventListener("click", () => {
        this.previewRotation = this.previewRotation === 0 ? 180 : 0;
        writeNumber("previewRotation", this.previewRotation);
        this.render();
      });
      actions.appendChild(rotateBtn);

      const closeBtn = el("button", "", "Close camera");
      closeBtn.addEventListener("click", () => this.switchCamera(null));
      actions.appendChild(closeBtn);
      card.appendChild(actions);
    }

    if (this.state.cameraError) {
      card.appendChild(el("div", "help warn-text", `Error: ${this.state.cameraError}`));
    }

    if (showPicker) {
      const status = el("div", "row");
      if (this.state.switchingCamera) {
        status.appendChild(el("span", "pill warn", "Opening…"));
      } else {
        status.appendChild(el("span", "pill muted", "Closed"));
        status.appendChild(el("div", "v", "no camera selected"));
      }
      card.appendChild(status);

      card.appendChild(
        el(
          "div",
          "help",
          this.state.cameraOpen
            ? "Pick a different camera. The current one will be closed automatically."
            : "Pick which camera looks at the mat. macOS may prompt for camera permission the first time.",
        ),
      );

      if (this.state.cameras.length === 0) {
        card.appendChild(
          el(
            "div",
            "help",
            this.state.cameraError
              ? "Could not list cameras."
              : "No cameras detected. Plug in a camera and click Refresh.",
          ),
        );
      } else {
        const list = el("div", "displays");
        for (const c of this.state.cameras) {
          list.appendChild(this.renderCameraRow(c));
        }
        card.appendChild(list);
      }

      const actions = el("div", "row");
      const refresh = el("button", "", "Refresh list");
      refresh.addEventListener("click", () => void this.fetchCameras());
      actions.appendChild(refresh);

      if (this.state.cameraOpen && this.state.switchingCamera) {
        const cancel = el("button", "", "Cancel");
        cancel.addEventListener("click", () => {
          this.state.switchingCamera = false;
          this.render();
        });
        actions.appendChild(cancel);
      }
      card.appendChild(actions);
    }

    return card;
  }

  private renderHeartbeatRow(): HTMLElement {
    const stats = this.state.frameStats;
    const stale = !stats || Date.now() - stats.receivedAt > 1500;
    const row = el("div", "heartbeat-row");
    const dot = el("span", `heartbeat ${stale ? "stale" : "alive"}`);
    row.appendChild(dot);

    if (!stats) {
      row.appendChild(el("span", "heartbeat-text muted", "waiting for frames…"));
      return row;
    }

    if (stats.lastFrameAgeMs < 0) {
      row.appendChild(el("span", "heartbeat-text muted", "camera open, no frames yet"));
      return row;
    }

    const parts: string[] = [
      `${stats.fps.toFixed(1)} fps`,
      `frame #${stats.frameIndex.toLocaleString()}`,
    ];
    if (stats.lastFrameAgeMs >= 0) {
      parts.push(`last frame ${stats.lastFrameAgeMs} ms ago`);
    }
    parts.push(`${stats.detectorRuns.toLocaleString()} detector runs`);
    parts.push(`last saw ${stats.lastDetectedCount} marker${stats.lastDetectedCount === 1 ? "" : "s"}`);
    row.appendChild(el("span", "heartbeat-text", parts.join(" · ")));
    return row;
  }

  private renderCameraPreview(showMarkerOverlay: boolean): HTMLElement {
    const wrap = el("div", "calib-preview");
    if (this.previewRotation === 180) wrap.classList.add("rot-180");

    if (!this.cameraPreviewImg) {
      this.cameraPreviewImg = document.createElement("img");
      this.cameraPreviewImg.src = `${SERVER_HTTP}/camera/preview.mjpg`;
      this.cameraPreviewImg.alt = "Camera preview";
    }
    // Re-using the same element across renders keeps the MJPEG stream alive even
    // though render() blows away the rest of the DOM via innerHTML = "".
    wrap.appendChild(this.cameraPreviewImg);

    if (showMarkerOverlay) {
      const diag = this.state.calibDiag;
      if (diag && diag.frameWidth > 0 && diag.frameHeight > 0) {
        wrap.appendChild(this.buildMarkerOverlay(diag));
      }
    }
    return wrap;
  }

  private buildMarkerOverlay(diag: CalibrationDiagnostic): SVGSVGElement {
    const SVG_NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "calib-overlay");
    svg.setAttribute("viewBox", `0 0 ${diag.frameWidth} ${diag.frameHeight}`);
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
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
    return svg;
  }

  private renderCameraRow(c: CameraInfo): HTMLElement {
    const isSelected = c.index === this.state.cameraIndex && this.state.cameraOpen;
    const row = el("div", "display-row");
    const info = el("div", "display-info");
    info.appendChild(el("div", "display-name", c.name));
    info.appendChild(el("div", "display-meta", `index ${c.index}`));
    row.appendChild(info);

    const btn = el("button", isSelected ? "active" : "primary", isSelected ? "Active" : "Use");
    btn.disabled = isSelected || this.state.switchingCamera;
    btn.addEventListener("click", () => this.switchCamera(c.index));
    row.appendChild(btn);
    return row;
  }

  private renderModeCard(): HTMLElement {
    const card = el("div", "card");
    card.appendChild(el("h2", "", "Mode"));
    const row = el("div", "row");

    const idleBtn = el("button", this.state.mode === "idle" ? "active" : "", "Idle");
    idleBtn.addEventListener("click", () => this.ws.send({ type: "set_mode", mode: "idle" }));
    row.appendChild(idleBtn);

    const calBtn = el("button", this.state.mode === "calibrate" ? "active" : "primary", "Calibrate");
    calBtn.disabled = !this.state.projector;
    calBtn.addEventListener("click", () => this.ws.send({ type: "start_calibration" }));
    row.appendChild(calBtn);

    const trackBtn = el("button", this.state.mode === "track" ? "active" : "", "Track");
    trackBtn.disabled = !this.state.calibration;
    trackBtn.addEventListener("click", () => this.ws.send({ type: "set_mode", mode: "track" }));
    row.appendChild(trackBtn);

    card.appendChild(row);

    if (!this.state.projector) {
      card.appendChild(el("div", "help", "Open the projector window above before calibrating."));
    } else if (!this.state.calibration) {
      card.appendChild(el("div", "help", "Track is disabled until calibration has been completed at least once."));
    }
    return card;
  }

  private renderCalibrationCard(): HTMLElement {
    const card = el("div", "card");
    card.appendChild(el("h2", "", "Calibration"));

    if (!this.state.cameraOpen) {
      card.appendChild(
        el(
          "div",
          "help warn-text",
          "No camera open. Pick one in the Camera card above so the system can see the projected markers.",
        ),
      );
      return card;
    }

    if (!this.state.projector) {
      card.appendChild(
        el(
          "div",
          "help warn-text",
          "Projector window is not open. Launch it from the Projector display card above so the markers can be projected.",
        ),
      );
      return card;
    }

    // Status pill
    const status = el("div", "row");
    if (this.state.capturedMarkers === 4) {
      status.appendChild(el("span", "pill ok", "All 4 markers detected"));
    } else if (this.state.capturedMarkers > 0) {
      status.appendChild(el("span", "pill warn", `${this.state.capturedMarkers}/4 markers detected`));
    } else {
      status.appendChild(el("span", "pill error", "0/4 markers detected"));
    }
    card.appendChild(status);

    // Diagnostic line — what is the detector actually doing?
    const diag = this.state.calibDiag;
    if (diag && this.state.capturedMarkers === 0) {
      const rejected = diag.rejectedCount;
      let detail: string;
      if (rejected > 0) {
        detail =
          `Detector found ${rejected} candidate quad${rejected === 1 ? "" : "s"} but couldn't decode any. ` +
          "Likely causes: marker too small in camera frame, blur/glare, or wrong dictionary. " +
          "Try moving the camera closer to the mat, or reducing projector brightness if the markers look washed out.";
      } else {
        detail =
          "Detector found no candidate quads at all. " +
          "Likely causes: markers not actually projected (check the projector window), " +
          "the camera doesn't see the projection (point it at the mat), " +
          "the work surface is set to an empty rectangle, or the camera image is heavily blurred.";
      }
      card.appendChild(el("div", "help warn-text", detail));
    } else {
      card.appendChild(
        el("div", "help", "Watch the live preview in the Camera card above — green outlines mark each detected marker."),
      );
    }

    // What the projector is actually drawing (so user can confirm markers ARE projected)
    const ids = this.state.calibDiag?.detectedIds ?? [];
    const expected = [10, 11, 12, 13];
    const missing = expected.filter((id) => !ids.includes(id));
    if (missing.length > 0) {
      card.appendChild(
        el(
          "div",
          "help",
          `Expected marker IDs 10–13. Currently missing: ${missing.join(", ")}. ` +
            "If the camera doesn't see them, check that the projector is showing 4 black-and-white squares, the camera is pointed at the mat, " +
            "and the work-surface outline matches the mat edges.",
        ),
      );
    } else {
      card.appendChild(
        el(
          "div",
          "help",
          "All 4 markers visible. On the mat, lay a ruler along the amber line projected below the top markers (between the two amber tick marks), measure its length in millimeters, type it in, and click Save.",
        ),
      );
    }

    const inputRow = el("div", "row");
    inputRow.appendChild(this.getMeasurementInput());

    const saveBtn = el("button", "primary", "Save");
    saveBtn.disabled = this.state.capturedMarkers < 4;
    saveBtn.addEventListener("click", () => this.commitMeasurement());
    inputRow.appendChild(saveBtn);
    card.appendChild(inputRow);

    const hint = el("div", "measurement-hint");
    hint.dataset.role = "measurement-hint";
    card.appendChild(hint);
    // Refresh the hint after the element is in the DOM so the conversion text is up to date.
    queueMicrotask(() => this.refreshMeasurementHint());

    return card;
  }


  private getMeasurementInput(): HTMLInputElement {
    if (!this.measurementInput) {
      const input = document.createElement("input");
      input.type = "text";
      input.inputMode = "decimal";
      input.placeholder = 'e.g. 305 or 12 in';
      input.value = this.pendingMm;
      input.autocomplete = "off";
      input.dataset.role = "measurement-input";
      input.addEventListener("input", () => {
        this.pendingMm = input.value;
        this.refreshMeasurementHint();
      });
      input.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") this.commitMeasurement();
      });
      this.measurementInput = input;
    }
    return this.measurementInput;
  }

  private commitMeasurement(): void {
    const mm = parseLengthMm(this.pendingMm);
    if (mm === null || mm <= 0) return;
    if (this.state.capturedMarkers !== 4) return;
    this.ws.send({ type: "finish_calibration", horizontal_mm: mm });
    this.pendingMm = "";
    if (this.measurementInput) this.measurementInput.value = "";
    this.refreshMeasurementHint();
  }

  private refreshMeasurementHint(): void {
    const hint = this.root.querySelector('[data-role="measurement-hint"]') as HTMLElement | null;
    if (!hint) return;
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

  private renderTrackCard(): HTMLElement {
    const card = el("div", "card");
    card.appendChild(el("h2", "", "Tracked objects"));
    const objects = el("div", "objects");

    if (this.state.detections.length === 0) {
      objects.appendChild(el("div", "empty", "No objects detected. Place an ArUco-tagged item on the mat."));
    } else {
      const table = el("table");
      for (const obj of this.state.detections) {
        const tr = el("tr");
        const id = el("td", "id", `#${obj.marker_id}`);
        const center = el(
          "td",
          "",
          `(${obj.center_mm[0].toFixed(1)}, ${obj.center_mm[1].toFixed(1)}) mm`,
        );
        const angle = el("td", "", `${obj.angle_deg.toFixed(1)}°`);
        tr.appendChild(id);
        tr.appendChild(center);
        tr.appendChild(angle);
        table.appendChild(tr);
      }
      objects.appendChild(table);
    }
    card.appendChild(objects);
    return card;
  }

  private connectionPill(): HTMLElement {
    if (this.state.connection === "open") return el("span", "pill ok", "Connected");
    if (this.state.connection === "connecting") return el("span", "pill muted", "Connecting…");
    return el("span", "pill error", "Disconnected — retrying");
  }

  private modePill(): HTMLElement {
    const cls = this.state.mode === "track" ? "pill ok" : this.state.mode === "calibrate" ? "pill warn" : "pill muted";
    return el("span", cls, this.state.mode);
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

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

const root = document.getElementById("root");
if (!root) throw new Error("no #root in control.html");
new ControlApp(root).start();
