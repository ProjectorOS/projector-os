import { SvgRenderer } from "./render/svg-renderer";
import type { CalibrationMarker, CalibrationMethod } from "../types";

// The marker image returned by /markers/{id}.png includes a white quiet zone around
// the ArUco marker — without it the marker's outer black edge would dissolve into the
// projector's black background and the detector would find nothing. The exact pixel
// size is sent by the server in CalibrationPromptEvent so we render it 1:1.

// Grid-only method renders simple solid white dots instead. The dot diameter is
// chosen to be small enough to give a precise centroid (the camera locates dots
// by connected-components centroid) but large enough to be unambiguously the
// brightest blobs in the scene. ~10% of the marker total size matches the
// existing layout's inset, so dots sit comfortably inside the work surface.
const GRID_DOT_DIAMETER_PX = 60;

export class CalibrationOverlay {
  constructor(
    private readonly svg: SvgRenderer,
    private readonly serverBaseUrl: string,
  ) {}

  /**
   * Render the calibration overlay for the chosen method.
   *
   * - `method = "aruco"`: 4 ArUco PNGs with amber zone outlines and (when
   *   `drawMeasurementGuide` is true) the "↑ measure this distance ↑" guide
   *   between markers 10 and 11. The guide is dropped once a cutting-mat grid
   *   has been reliably detected.
   * - `method = "grid"`: 4 plain solid white dots at the same proj_px corners.
   *   No measurement guide (the grid is the ruler). The dots are intentionally
   *   minimal so the camera's bright-blob detector finds them as the only
   *   bright objects in the scene.
   */
  show(
    markers: CalibrationMarker[],
    markerSizePx: number,
    drawMeasurementGuide: boolean = true,
    method: CalibrationMethod = "aruco",
  ): void {
    this.svg.upsert("calibration", (group: SVGGElement) => {
      group.setAttribute("clip-path", "url(#work-surface-clip)");
      if (method === "grid") {
        this.drawGridDots(group, markers);
        return;
      }
      this.drawArucoMarkers(group, markers, markerSizePx);
      if (drawMeasurementGuide) {
        this.drawMeasurementGuide(group, markers, markerSizePx);
      }
    });
  }

  private drawArucoMarkers(
    group: SVGGElement,
    markers: CalibrationMarker[],
    markerSizePx: number,
  ): void {
    const half = markerSizePx / 2;
    // Amber outline drawn just outside the white quiet zone, on the projector's
    // black background. Doesn't interfere with the detector (which only looks at the
    // contrast at the marker's own black border, deep inside the white quiet zone)
    // and gives the user a clearly-visible "marker zone" outline on the mat.
    const borderOffset = 8;
    const borderSize = markerSizePx + 2 * borderOffset;
    for (const m of markers) {
      const border = SvgRenderer.rect(
        m.proj_x - half - borderOffset,
        m.proj_y - half - borderOffset,
        borderSize,
        borderSize,
        {
          fill: "none",
          stroke: "#fbbf24",
          "stroke-width": "3",
          "stroke-dasharray": "8 6",
        },
      );
      group.appendChild(border);

      const img = SvgRenderer.image(
        m.proj_x - half,
        m.proj_y - half,
        markerSizePx,
        markerSizePx,
        `${this.serverBaseUrl}/markers/${m.marker_id}.png`,
      );
      img.setAttribute("image-rendering", "pixelated");
      group.appendChild(img);

      const label = SvgRenderer.text(
        m.proj_x,
        m.proj_y + half + 24,
        `id ${m.marker_id}`,
        {
          fill: "#fff",
          "text-anchor": "middle",
          "font-size": "16",
          "font-family": "monospace",
        },
      );
      group.appendChild(label);
    }
  }

  private drawGridDots(group: SVGGElement, markers: CalibrationMarker[]): void {
    const radius = GRID_DOT_DIAMETER_PX / 2;
    for (const m of markers) {
      const dot = SvgRenderer.circle(m.proj_x, m.proj_y, radius, {
        fill: "#ffffff",
      });
      group.appendChild(dot);
    }
  }

  /**
   * Project a "measure this" guide between the TL (id 10) and TR (id 11) markers so the
   * user has a tangible line to lay a ruler against — no need to eyeball where each
   * marker's center is. The guide is positioned below the markers (toward the inside of
   * the work surface) with vertical leader lines dropping from the marker centers down
   * to a horizontal measurement line. The horizontal line's endpoints are aligned with
   * the marker centers, so measuring along it gives the same number as center-to-center.
   */
  private drawMeasurementGuide(group: SVGGElement, markers: CalibrationMarker[], markerSizePx: number): void {
    const tl = markers.find((m) => m.marker_id === 10);
    const tr = markers.find((m) => m.marker_id === 11);
    if (!tl || !tr) return;
    if (Math.abs(tl.proj_y - tr.proj_y) > 1) return; // expect same Y

    const half = markerSizePx / 2;
    const x1 = tl.proj_x;
    const x2 = tr.proj_x;
    const markerBottomY = tl.proj_y + half;
    const measureY = markerBottomY + 60; // sit below "id 10" / "id 11" labels
    const color = "#fbbf24"; // amber — visually distinct from white labels and green overlays
    const stroke = "3";

    // Vertical leader lines from the marker centers down to the measurement line, so it's
    // visually clear that "this line corresponds to the marker centers".
    group.appendChild(
      SvgRenderer.line(x1, markerBottomY + 30, x1, measureY, {
        stroke: color,
        "stroke-width": "2",
        "stroke-dasharray": "4 4",
      }),
    );
    group.appendChild(
      SvgRenderer.line(x2, markerBottomY + 30, x2, measureY, {
        stroke: color,
        "stroke-width": "2",
        "stroke-dasharray": "4 4",
      }),
    );

    // The measurement line itself.
    group.appendChild(
      SvgRenderer.line(x1, measureY, x2, measureY, {
        stroke: color,
        "stroke-width": stroke,
      }),
    );

    // Tick caps at each end so the user can see exactly where the line begins and ends.
    const tickH = 14;
    group.appendChild(
      SvgRenderer.line(x1, measureY - tickH, x1, measureY + tickH, {
        stroke: color,
        "stroke-width": stroke,
      }),
    );
    group.appendChild(
      SvgRenderer.line(x2, measureY - tickH, x2, measureY + tickH, {
        stroke: color,
        "stroke-width": stroke,
      }),
    );

    group.appendChild(
      SvgRenderer.text((x1 + x2) / 2, measureY + 36, "↑ measure this distance ↑", {
        fill: color,
        "text-anchor": "middle",
        "font-size": "20",
        "font-family": "monospace",
        "font-weight": "bold",
      }),
    );
  }

  hide(): void {
    this.svg.remove("calibration");
  }
}
