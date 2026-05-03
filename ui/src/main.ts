// Projector entry: draws calibration markers and tracked-object overlays. No controls
// are rendered on the projection itself — those live in /control.html, opened in a
// regular browser on the laptop.

import { CalibrationOverlay } from "./calibration";
import { TrackedObjectOverlay } from "./overlay";
import { HtmlRenderer } from "./render/html-renderer";
import { SvgRenderer } from "./render/svg-renderer";
import type { Calibration, Mode, ServerEvent, WorkSurface } from "./types";
import { WorkSurfaceOverlay } from "./work-surface-overlay";
import { defaultServerHttpUrl, defaultServerWsUrl, WsClient } from "./ws-client";

class ProjectorApp {
  private mode: Mode = "idle";
  private calibration: Calibration | null = null;
  private workSurface: WorkSurface | null = null;
  private showWorkSurfaceOutline = true;

  private readonly svg: SvgRenderer;
  private readonly html: HtmlRenderer;
  private readonly calibrationOverlay: CalibrationOverlay;
  private readonly trackOverlay: TrackedObjectOverlay;
  private readonly workSurfaceOverlay: WorkSurfaceOverlay;
  private readonly ws: WsClient;

  constructor() {
    const svgRoot = document.getElementById("svg-layer") as unknown as SVGSVGElement;
    const htmlRoot = document.getElementById("html-layer") as HTMLElement;
    this.setSvgViewBox(svgRoot);
    window.addEventListener("resize", () => {
      this.setSvgViewBox(svgRoot);
      this.registerDimensions();
    });

    this.svg = new SvgRenderer(svgRoot);
    this.html = new HtmlRenderer(htmlRoot);
    this.calibrationOverlay = new CalibrationOverlay(this.svg, defaultServerHttpUrl());
    this.trackOverlay = new TrackedObjectOverlay(this.svg);
    this.workSurfaceOverlay = new WorkSurfaceOverlay(this.svg);

    this.ws = new WsClient({
      url: defaultServerWsUrl(),
      onEvent: (e) => this.onEvent(e),
      onState: (s) => this.renderStatus(s),
    });
  }

  start(): void {
    this.ws.connect();
  }

  private setSvgViewBox(svgRoot: SVGSVGElement): void {
    svgRoot.setAttribute("viewBox", `0 0 ${window.innerWidth} ${window.innerHeight}`);
  }

  private registerDimensions(): void {
    this.ws.send({
      type: "register_projector",
      proj_width: window.innerWidth,
      proj_height: window.innerHeight,
    });
  }

  private onEvent(ev: ServerEvent): void {
    switch (ev.type) {
      case "hello":
        this.mode = ev.mode;
        this.calibration = ev.calibration;
        this.workSurface = ev.work_surface;
        this.showWorkSurfaceOutline = ev.show_work_surface_outline;
        this.refreshOverlay();
        this.registerDimensions();
        break;
      case "mode_changed":
        this.mode = ev.mode;
        this.refreshOverlay();
        break;
      case "detections":
        this.trackOverlay.update(ev.objects, this.calibration);
        break;
      case "calibration_updated":
        this.calibration = ev.calibration;
        break;
      case "calibration_prompt":
        this.calibrationOverlay.show(ev.markers);
        break;
      case "work_surface_updated":
        this.workSurface = ev.work_surface;
        this.showWorkSurfaceOutline = ev.show_outline;
        this.refreshOverlay();
        break;
      case "calibration_captured":
      case "projector_registered":
        // No-op for the projector view.
        break;
    }
  }

  private refreshOverlay(): void {
    if (this.mode !== "calibrate") this.calibrationOverlay.hide();
    if (this.mode !== "track") this.trackOverlay.clear();
    this.workSurfaceOverlay.update(this.workSurface, this.showWorkSurfaceOutline);
  }

  private renderStatus(s: "connecting" | "open" | "closed"): void {
    if (s === "open") {
      this.html.remove("status");
      return;
    }
    this.html.upsert("status", (node) => {
      node.style.bottom = "12px";
      node.style.right = "12px";
      node.style.top = "auto";
      node.style.left = "auto";
      node.style.padding = "6px 12px";
      node.style.background = "rgba(0,0,0,0.6)";
      node.style.border = "1px solid #555";
      node.style.borderRadius = "4px";
      node.style.fontSize = "12px";
      node.style.color = s === "closed" ? "#fb6" : "#ccc";
      node.textContent = s === "closed" ? "disconnected — retrying" : "connecting…";
    });
  }
}

new ProjectorApp().start();
