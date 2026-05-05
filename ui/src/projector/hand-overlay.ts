import { applyHomography } from "./render/homography";
import { SvgRenderer } from "./render/svg-renderer";
import type { Calibration, DetectedHand } from "../types";

const SVG_NS = "http://www.w3.org/2000/svg";

// MediaPipe Hand connections — pairs of landmark indices that form the hand
// skeleton. Mirrored from mediapipe.tasks.python.vision.HandLandmarksConnections.
const HAND_CONNECTIONS: [number, number][] = [
  // palm
  [0, 1], [1, 5], [5, 9], [9, 13], [13, 17], [0, 17],
  // thumb
  [1, 2], [2, 3], [3, 4],
  // index
  [5, 6], [6, 7], [7, 8],
  // middle
  [9, 10], [10, 11], [11, 12],
  // ring
  [13, 14], [14, 15], [15, 16],
  // pinky
  [17, 18], [18, 19], [19, 20],
];

const FINGERTIPS = new Set([4, 8, 12, 16, 20]);

// Colors picked to be distinct from marker green (#4ade80) and calibration amber.
const COLOR_BY_HAND: Record<"Left" | "Right", string> = {
  Left: "#60a5fa", // blue
  Right: "#f472b6", // pink
};

const SKELETON_STROKE_PX = 4;
const LANDMARK_RADIUS_PX = 4;
const FINGERTIP_RADIUS_PX = 9;

function circle(
  cx: number,
  cy: number,
  r: number,
  attrs: Record<string, string>,
): SVGCircleElement {
  const el = document.createElementNS(SVG_NS, "circle");
  el.setAttribute("cx", String(cx));
  el.setAttribute("cy", String(cy));
  el.setAttribute("r", String(r));
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

export class HandOverlay {
  constructor(private readonly svg: SvgRenderer) {}

  update(hands: DetectedHand[], calibration: Calibration | null): void {
    if (!calibration || hands.length === 0) {
      this.svg.remove("hands");
      return;
    }
    const h = calibration.h_mat_to_proj;

    this.svg.upsert("hands", (group: SVGGElement) => {
      group.setAttribute("clip-path", "url(#work-surface-clip)");

      for (const hand of hands) {
        const color = COLOR_BY_HAND[hand.handedness];
        const projected = hand.landmarks_mm.map(([x, y]) =>
          applyHomography(h, x, y),
        );

        for (const [a, b] of HAND_CONNECTIONS) {
          const [x1, y1] = projected[a];
          const [x2, y2] = projected[b];
          group.appendChild(
            SvgRenderer.line(x1, y1, x2, y2, {
              stroke: color,
              "stroke-width": String(SKELETON_STROKE_PX),
              "stroke-linecap": "round",
            }),
          );
        }

        for (let i = 0; i < projected.length; i++) {
          const [x, y] = projected[i];
          const isTip = FINGERTIPS.has(i);
          group.appendChild(
            circle(x, y, isTip ? FINGERTIP_RADIUS_PX : LANDMARK_RADIUS_PX, {
              fill: color,
            }),
          );
        }
      }
    });
  }

  clear(): void {
    this.svg.remove("hands");
  }
}
