import { SvgRenderer } from "./render/svg-renderer";
import type { Calibration, DetectedObject } from "./types";

/**
 * Apply a 3x3 homography (row-major as a 3x3 array) to a point [x, y].
 */
function applyHomography(
  h: number[][],
  x: number,
  y: number,
): [number, number] {
  const wx = h[0][0] * x + h[0][1] * y + h[0][2];
  const wy = h[1][0] * x + h[1][1] * y + h[1][2];
  const w = h[2][0] * x + h[2][1] * y + h[2][2];
  return [wx / w, wy / w];
}

function computeMarkerEdgeMm(obj: DetectedObject): number {
  // Edge length in mat_mm. Falls back to a reasonable default if corners are degenerate.
  if (obj.corners_mm.length < 2) return 30;
  const [a, b] = obj.corners_mm;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  return len > 1 ? len : 30;
}

function makeArrowhead(
  start: [number, number],
  tip: [number, number],
): SVGPolygonElement {
  // Triangular arrowhead at the tip, pointing in the line's direction.
  const angle = Math.atan2(tip[1] - start[1], tip[0] - start[0]);
  const headLen = 18; // projector px
  const headHalfWidth = 9;
  const baseX = tip[0] - Math.cos(angle) * headLen;
  const baseY = tip[1] - Math.sin(angle) * headLen;
  // Perpendicular vector for the base corners.
  const px = -Math.sin(angle) * headHalfWidth;
  const py = Math.cos(angle) * headHalfWidth;
  return SvgRenderer.polygon(
    [
      [tip[0], tip[1]],
      [baseX + px, baseY + py],
      [baseX - px, baseY - py],
    ],
    { fill: "#4ade80" },
  );
}

export class TrackedObjectOverlay {
  constructor(private readonly svg: SvgRenderer) {}

  update(objects: DetectedObject[], calibration: Calibration | null): void {
    if (!calibration) {
      this.svg.remove("tracked");
      return;
    }
    const h = calibration.h_mat_to_proj;
    const PAD_MM = 15; // padding on the bounding box outside the marker corners
    const ARROW_OUTSIDE_MM = 15; // how far past the padded box the arrow extends
    const LABEL_GAP_MM = 5; // distance from padded box edge to the ID label
    // Server-side angle_deg is the direction of the marker's TL→TR edge. Users think of
    // 0° as the marker "pointing forward" (perpendicular to that edge, away from the
    // marker body), so shift the rendered arrow by -90° to match that convention.
    const ARROW_ANGLE_OFFSET_DEG = -90;

    this.svg.upsert("tracked", (group: SVGGElement) => {
      group.setAttribute("clip-path", "url(#work-surface-clip)");
      for (const obj of objects) {
        // Padded bounding polygon: each corner pushed outward from the marker center
        // by PAD_MM along the corner's outward direction in mat coordinates.
        const cx = obj.center_mm[0];
        const cy = obj.center_mm[1];
        const paddedMm = obj.corners_mm.map(([x, y]): [number, number] => {
          const dx = x - cx;
          const dy = y - cy;
          const len = Math.hypot(dx, dy) || 1;
          return [x + (dx / len) * PAD_MM, y + (dy / len) * PAD_MM];
        });
        const paddedProj = paddedMm.map(([mx, my]) =>
          applyHomography(h, mx, my),
        );
        group.appendChild(
          SvgRenderer.polygon(paddedProj, {
            fill: "none",
            stroke: "#4ade80",
            "stroke-width": "3",
          }),
        );

        // Direction arrow: starts on the padded-box edge in the angle direction, ends
        // ARROW_OUTSIDE_MM further out. As the user rotates the physical marker the
        // projected arrow rotates with it, confirming orientation detection works.
        const angleRad =
          ((obj.angle_deg + ARROW_ANGLE_OFFSET_DEG) * Math.PI) / 180;
        const cosA = Math.cos(angleRad);
        const sinA = Math.sin(angleRad);
        const halfEdge = computeMarkerEdgeMm(obj) / 2;
        const startDistMm = halfEdge + PAD_MM;
        const tipDistMm = startDistMm + ARROW_OUTSIDE_MM;
        const arrowStartMm: [number, number] = [
          cx + cosA * startDistMm,
          cy + sinA * startDistMm,
        ];
        const arrowTipMm: [number, number] = [
          cx + cosA * tipDistMm,
          cy + sinA * tipDistMm,
        ];
        const arrowStart = applyHomography(h, arrowStartMm[0], arrowStartMm[1]);
        const arrowTip = applyHomography(h, arrowTipMm[0], arrowTipMm[1]);
        group.appendChild(
          SvgRenderer.line(
            arrowStart[0],
            arrowStart[1],
            arrowTip[0],
            arrowTip[1],
            {
              stroke: "#4ade80",
              "stroke-width": "4",
              "stroke-linecap": "round",
            },
          ),
        );
        group.appendChild(makeArrowhead(arrowStart, arrowTip));

        // Label sits LABEL_GAP_MM above the padded box, centered horizontally on the
        // marker. Computed in mat coordinates so the gap is physically consistent.
        const labelMm: [number, number] = [
          cx,
          cy - halfEdge - PAD_MM - LABEL_GAP_MM,
        ];
        const labelProj = applyHomography(h, labelMm[0], labelMm[1]);
        group.appendChild(
          SvgRenderer.text(labelProj[0], labelProj[1], `#${obj.marker_id}`, {
            fill: "#4ade80",
            "text-anchor": "middle",
            "font-size": "20",
            "font-family": "monospace",
            "font-weight": "bold",
          }),
        );
      }
    });
  }

  clear(): void {
    this.svg.remove("tracked");
  }
}
