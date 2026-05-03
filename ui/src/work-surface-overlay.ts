import { SvgRenderer } from "./render/svg-renderer";
import type { WorkSurface } from "./types";

/**
 * Draws a dashed rectangle around the work surface so the user can see the bounds of
 * the workable area within the projection. The outline lives on the projector view.
 */
export class WorkSurfaceOverlay {
  constructor(private readonly svg: SvgRenderer) {}

  update(ws: WorkSurface | null, show: boolean): void {
    if (!ws || !show) {
      this.svg.remove("work-surface");
      return;
    }
    this.svg.upsert("work-surface", (group: SVGGElement) => {
      const rect = SvgRenderer.rect(ws.x, ws.y, ws.width, ws.height, {
        fill: "none",
        stroke: "#475569",
        "stroke-width": "2",
        "stroke-dasharray": "12 8",
      });
      group.appendChild(rect);
    });
  }
}
