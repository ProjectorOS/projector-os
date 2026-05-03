import { SvgRenderer } from "./render/svg-renderer";
import type { Calibration, DetectedObject } from "./types";

/**
 * Apply a 3x3 homography (row-major as a 3x3 array) to a point [x, y].
 */
function applyHomography(h: number[][], x: number, y: number): [number, number] {
  const wx = h[0][0] * x + h[0][1] * y + h[0][2];
  const wy = h[1][0] * x + h[1][1] * y + h[1][2];
  const w = h[2][0] * x + h[2][1] * y + h[2][2];
  return [wx / w, wy / w];
}

export class TrackedObjectOverlay {
  constructor(private readonly svg: SvgRenderer) {}

  update(objects: DetectedObject[], calibration: Calibration | null): void {
    if (!calibration) {
      this.svg.remove("tracked");
      return;
    }
    const h = calibration.h_mat_to_proj;
    this.svg.upsert("tracked", (group: SVGGElement) => {
      for (const obj of objects) {
        const projCorners = obj.corners_mm.map(([mx, my]) => applyHomography(h, mx, my));
        const polygon = SvgRenderer.polygon(projCorners, {
          fill: "none",
          stroke: "#4ade80",
          "stroke-width": "3",
        });
        group.appendChild(polygon);

        const [cx, cy] = applyHomography(h, obj.center_mm[0], obj.center_mm[1]);
        const label = SvgRenderer.text(cx, cy - 24, `#${obj.marker_id}`, {
          fill: "#4ade80",
          "text-anchor": "middle",
          "font-size": "20",
          "font-family": "monospace",
          "font-weight": "bold",
        });
        group.appendChild(label);
      }
    });
  }

  clear(): void {
    this.svg.remove("tracked");
  }
}
