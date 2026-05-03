import type { Renderer } from "./renderer";

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Manages a fullscreen <svg> layer. Each item is a <g data-id="..."> child; upserting
 * an item clears its previous contents and lets the caller append fresh children.
 */
export class SvgRenderer implements Renderer {
  private readonly groups = new Map<string, SVGGElement>();

  constructor(private readonly root: SVGSVGElement) {}

  /**
   * Begin or update an item. The render callback is given a fresh <g> to populate.
   */
  upsert(id: string, render: (group: SVGGElement) => void): void;
  upsert(id: string, render: () => void): void;
  upsert(id: string, render: ((group: SVGGElement) => void) | (() => void)): void {
    let group = this.groups.get(id);
    if (!group) {
      group = document.createElementNS(SVG_NS, "g");
      group.setAttribute("data-id", id);
      this.root.appendChild(group);
      this.groups.set(id, group);
    } else {
      while (group.firstChild) group.removeChild(group.firstChild);
    }
    (render as (g: SVGGElement) => void)(group);
  }

  remove(id: string): void {
    const group = this.groups.get(id);
    if (!group) return;
    group.remove();
    this.groups.delete(id);
  }

  clear(): void {
    for (const g of this.groups.values()) g.remove();
    this.groups.clear();
  }

  /** Convenience constructors for common shapes. */
  static rect(x: number, y: number, w: number, h: number, attrs: Record<string, string> = {}): SVGRectElement {
    const el = document.createElementNS(SVG_NS, "rect");
    el.setAttribute("x", String(x));
    el.setAttribute("y", String(y));
    el.setAttribute("width", String(w));
    el.setAttribute("height", String(h));
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  }

  static polygon(points: [number, number][], attrs: Record<string, string> = {}): SVGPolygonElement {
    const el = document.createElementNS(SVG_NS, "polygon");
    el.setAttribute("points", points.map(([x, y]) => `${x},${y}`).join(" "));
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  }

  static text(x: number, y: number, content: string, attrs: Record<string, string> = {}): SVGTextElement {
    const el = document.createElementNS(SVG_NS, "text");
    el.setAttribute("x", String(x));
    el.setAttribute("y", String(y));
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    el.textContent = content;
    return el;
  }

  static image(x: number, y: number, w: number, h: number, href: string): SVGImageElement {
    const el = document.createElementNS(SVG_NS, "image");
    el.setAttribute("x", String(x));
    el.setAttribute("y", String(y));
    el.setAttribute("width", String(w));
    el.setAttribute("height", String(h));
    el.setAttribute("href", href);
    return el;
  }
}
