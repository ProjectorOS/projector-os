import { SvgRenderer } from "./render/svg-renderer";
import type { CalibrationMarker } from "./types";

const MARKER_SIZE_PX = 200;

export class CalibrationOverlay {
  constructor(
    private readonly svg: SvgRenderer,
    private readonly serverBaseUrl: string,
  ) {}

  show(markers: CalibrationMarker[]): void {
    this.svg.upsert("calibration", (group: SVGGElement) => {
      const half = MARKER_SIZE_PX / 2;
      for (const m of markers) {
        const img = SvgRenderer.image(
          m.proj_x - half,
          m.proj_y - half,
          MARKER_SIZE_PX,
          MARKER_SIZE_PX,
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
    });
  }

  hide(): void {
    this.svg.remove("calibration");
  }
}
