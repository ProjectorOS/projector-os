import { applyHomography } from "./render/homography";
import { SvgRenderer } from "./render/svg-renderer";
import type { Calibration, DetectedObject } from "../types";

function computeMarkerEdgeMm(obj: DetectedObject): number {
  // Edge length in mat_mm. Falls back to a reasonable default if corners are degenerate.
  if (obj.corners_mm.length < 2) return 30;
  const [a, b] = obj.corners_mm;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  return len > 1 ? len : 30;
}

// Approximate mm→projector_px scale at a point in mat_mm. The homography is not a
// uniform scale, but locally it's close enough for stroke widths.
function mmToPxScale(h: number[][], xMm: number, yMm: number): number {
  const [px0, py0] = applyHomography(h, xMm, yMm);
  const [px1, py1] = applyHomography(h, xMm + 1, yMm);
  const [px2, py2] = applyHomography(h, xMm, yMm + 1);
  const sx = Math.hypot(px1 - px0, py1 - py0);
  const sy = Math.hypot(px2 - px0, py2 - py0);
  return (sx + sy) / 2;
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

// Cycle of distinct, vivid hues for the connection lines between markers. Avoids
// green (used for the marker outlines themselves) and amber (used for calibration UI).
const LINE_COLORS = [
  "#ef4444", // red
  "#3b82f6", // blue
  "#ec4899", // magenta
  "#f97316", // orange
  "#06b6d4", // cyan
  "#a855f7", // purple
];
const LINE_WIDTH_MM = 5;
const LINE_GAP_MM = 3; // distance from box edge to where the line starts/ends
const LINE_MASK_ID = "tracked-line-box-mask";
const SVG_NS = "http://www.w3.org/2000/svg";

interface ObjGeom {
  obj: DetectedObject;
  cx: number;
  cy: number;
  halfEdge: number;
  paddedProj: [number, number][];
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
    const LABEL_X_OFFSET_MM = -15; // shift label left so it doesn't overlap a straight-up arrow
    // Server-side angle_deg is the direction of the marker's TL→TR edge. Users think of
    // 0° as the marker "pointing forward" (perpendicular to that edge, away from the
    // marker body), so shift the rendered arrow by -90° to match that convention.
    const ARROW_ANGLE_OFFSET_DEG = -90;

    this.svg.upsert("tracked", (group: SVGGElement) => {
      group.setAttribute("clip-path", "url(#work-surface-clip)");

      // Pre-compute per-object geometry so we can build the connection-line mask up
      // front (every box must cut every line, not just the line that ends at it).
      const geoms: ObjGeom[] = objects.map((obj) => {
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
        return { obj, cx, cy, halfEdge: computeMarkerEdgeMm(obj) / 2, paddedProj };
      });

      this.drawConnectionLines(group, geoms, h);

      for (const g of geoms) {
        const { obj, cx, cy, halfEdge, paddedProj } = g;
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

        // Label sits LABEL_GAP_MM above the padded box, shifted horizontally by
        // LABEL_X_OFFSET_MM so it doesn't overlap the arrow when angle = 0° (which
        // points straight up). Computed in mat coordinates so the gap is physically
        // consistent regardless of viewing angle.
        const labelMm: [number, number] = [
          cx + LABEL_X_OFFSET_MM,
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

  private drawConnectionLines(
    group: SVGGElement,
    geoms: ObjGeom[],
    h: number[][],
  ): void {
    if (geoms.length < 2) return;

    // Connect markers in ascending ID order (0 → 5 → 8 → ...). Mirrors how the user
    // numbers their physical objects.
    const ordered = [...geoms].sort((a, b) => a.obj.marker_id - b.obj.marker_id);

    // Mask: full-coverage white (visible) with a black hole for every padded box, so
    // a line drawn between two markers is hidden anywhere it would cross another
    // marker's box (including non-endpoint markers that happen to lie in between).
    const defs = document.createElementNS(SVG_NS, "defs");
    const mask = document.createElementNS(SVG_NS, "mask");
    mask.setAttribute("id", LINE_MASK_ID);
    mask.setAttribute("maskUnits", "userSpaceOnUse");
    mask.appendChild(
      SvgRenderer.rect(0, 0, window.innerWidth, window.innerHeight, {
        fill: "white",
      }),
    );
    for (const g of geoms) {
      mask.appendChild(SvgRenderer.polygon(g.paddedProj, { fill: "black" }));
    }
    defs.appendChild(mask);
    group.appendChild(defs);

    const linesGroup = document.createElementNS(SVG_NS, "g");
    linesGroup.setAttribute("mask", `url(#${LINE_MASK_ID})`);

    for (let i = 0; i < ordered.length - 1; i++) {
      const a = ordered[i];
      const b = ordered[i + 1];
      const dx = b.cx - a.cx;
      const dy = b.cy - a.cy;
      const dist = Math.hypot(dx, dy);
      const startOff = a.halfEdge + 15 + LINE_GAP_MM; // box edge + 3mm gap
      const endOff = b.halfEdge + 15 + LINE_GAP_MM;
      if (dist <= startOff + endOff) continue; // boxes too close — no room for line
      const ux = dx / dist;
      const uy = dy / dist;
      const sxMm = a.cx + ux * startOff;
      const syMm = a.cy + uy * startOff;
      const exMm = b.cx - ux * endOff;
      const eyMm = b.cy - uy * endOff;
      const [sx, sy] = applyHomography(h, sxMm, syMm);
      const [ex, ey] = applyHomography(h, exMm, eyMm);
      const midX = (sxMm + exMm) / 2;
      const midY = (syMm + eyMm) / 2;
      const widthPx = LINE_WIDTH_MM * mmToPxScale(h, midX, midY);
      const color = LINE_COLORS[i % LINE_COLORS.length];
      linesGroup.appendChild(
        SvgRenderer.line(sx, sy, ex, ey, {
          stroke: color,
          "stroke-width": String(widthPx),
          "stroke-linecap": "round",
        }),
      );
    }

    group.appendChild(linesGroup);
  }

  clear(): void {
    this.svg.remove("tracked");
  }
}
