import { SvgRenderer } from "./render/svg-renderer";
import type { CalibrationMarker } from "./types";

// The marker image returned by /markers/{id}.png includes a white quiet zone around
// the ArUco marker — without it the marker's outer black edge would dissolve into the
// projector's black background and the detector would find nothing. The exact pixel
// size is sent by the server in CalibrationPromptEvent so we render it 1:1.

export class CalibrationOverlay {
  constructor(
    private readonly svg: SvgRenderer,
    private readonly serverBaseUrl: string,
  ) {}

  show(markers: CalibrationMarker[], markerSizePx: number): void {
    this.svg.upsert("calibration", (group: SVGGElement) => {
      const half = markerSizePx / 2;
      for (const m of markers) {
        const img = SvgRenderer.image(
          m.proj_x - half,
          m.proj_y - half,
          markerSizePx,
          markerSizePx,
          `${this.serverBaseUrl}/markers/${m.marker_id}.png`,
        );
        img.setAttribute("image-rendering", "pixelated");
        group.appendChild(img);

        // Label sits below the marker's white quiet zone, on the projector's black bg
        // (so it doesn't compete with the marker for the detector's attention).
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
    });
  }

  hide(): void {
    this.svg.remove("calibration");
  }
}
