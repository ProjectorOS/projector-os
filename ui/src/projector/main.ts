// Projector entry: draws calibration markers and tracked-object overlays. No controls
// are rendered on the projection itself — those live at / (the control panel),
// opened in a regular browser on the laptop.

import { CalibrationOverlay } from "./calibration";
import { HandOverlay } from "./hand-overlay";
import { TrackedObjectOverlay } from "./overlay";
import { HtmlRenderer } from "./render/html-renderer";
import { SvgRenderer } from "./render/svg-renderer";
import type { Calibration, Mode, ServerEvent, WorkSurface } from "../types";
import { WorkSurfaceOverlay } from "./work-surface-overlay";
import { defaultServerHttpUrl, defaultServerWsUrl, WsClient } from "../ws-client";

class ProjectorApp {
  private mode: Mode = "idle";
  private calibration: Calibration | null = null;
  private workSurface: WorkSurface | null = null;
  private showWorkSurfaceOutline = true;

  private readonly svg: SvgRenderer;
  private readonly html: HtmlRenderer;
  private readonly calibrationOverlay: CalibrationOverlay;
  private readonly trackOverlay: TrackedObjectOverlay;
  private readonly handOverlay: HandOverlay;
  private readonly workSurfaceOverlay: WorkSurfaceOverlay;
  private readonly ws: WsClient;
  private readonly clipRect: SVGRectElement;

  constructor() {
    const svgRoot = document.getElementById("svg-layer") as unknown as SVGSVGElement;
    const htmlRoot = document.getElementById("html-layer") as HTMLElement;
    this.setSvgViewBox(svgRoot);
    window.addEventListener("resize", () => {
      this.setSvgViewBox(svgRoot);
      this.registerDimensions();
      this.updateClipRect();
    });

    // SVG clipPath that confines all overlay drawing (calibration markers, tracked
    // objects, etc.) to inside the work-surface rectangle. Updated whenever work_surface
    // changes; default covers the full window so nothing is clipped before we know the
    // work surface.
    const SVG_NS = "http://www.w3.org/2000/svg";
    const defs = document.createElementNS(SVG_NS, "defs");
    const clipPath = document.createElementNS(SVG_NS, "clipPath");
    clipPath.setAttribute("id", "work-surface-clip");
    this.clipRect = document.createElementNS(SVG_NS, "rect");
    clipPath.appendChild(this.clipRect);
    defs.appendChild(clipPath);
    svgRoot.insertBefore(defs, svgRoot.firstChild);
    this.updateClipRect();

    this.svg = new SvgRenderer(svgRoot);
    this.html = new HtmlRenderer(htmlRoot);
    this.calibrationOverlay = new CalibrationOverlay(this.svg, defaultServerHttpUrl());
    this.trackOverlay = new TrackedObjectOverlay(this.svg);
    this.handOverlay = new HandOverlay(this.svg);
    this.workSurfaceOverlay = new WorkSurfaceOverlay(this.svg);

    this.ws = new WsClient({
      url: defaultServerWsUrl(),
      onEvent: (e) => this.onEvent(e),
      onState: (s) => this.renderStatus(s),
    });
  }

  private updateClipRect(): void {
    const ws = this.workSurface;
    if (ws) {
      this.clipRect.setAttribute("x", String(ws.x));
      this.clipRect.setAttribute("y", String(ws.y));
      this.clipRect.setAttribute("width", String(ws.width));
      this.clipRect.setAttribute("height", String(ws.height));
    } else {
      // No work surface known yet — let everything render so the projector view isn't
      // blank during initial load.
      this.clipRect.setAttribute("x", "0");
      this.clipRect.setAttribute("y", "0");
      this.clipRect.setAttribute("width", String(window.innerWidth));
      this.clipRect.setAttribute("height", String(window.innerHeight));
    }
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
        this.updateClipRect();
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
      case "hands":
        this.handOverlay.update(ev.hands, this.calibration);
        break;
      case "calibration_updated":
        this.calibration = ev.calibration;
        break;
      case "calibration_prompt":
        this.calibrationOverlay.show(ev.markers, ev.marker_size_px);
        break;
      case "work_surface_updated":
        this.workSurface = ev.work_surface;
        this.showWorkSurfaceOutline = ev.show_outline;
        this.updateClipRect();
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
    if (this.mode !== "track") {
      this.trackOverlay.clear();
      this.handOverlay.clear();
    }
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
