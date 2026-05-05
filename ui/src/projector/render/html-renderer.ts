import type { Renderer } from "./renderer";

/**
 * Manages an absolute-positioned <div> layer for HTML overlays (instruction panels,
 * info cards, recipe-style step UIs). Each item is a child <div data-id="...">.
 */
export class HtmlRenderer implements Renderer {
  private readonly nodes = new Map<string, HTMLDivElement>();

  constructor(private readonly root: HTMLElement) {}

  upsert(id: string, render: (node: HTMLDivElement) => void): void;
  upsert(id: string, render: () => void): void;
  upsert(id: string, render: ((node: HTMLDivElement) => void) | (() => void)): void {
    let node = this.nodes.get(id);
    if (!node) {
      node = document.createElement("div");
      node.dataset.id = id;
      node.style.position = "absolute";
      this.root.appendChild(node);
      this.nodes.set(id, node);
    }
    (render as (n: HTMLDivElement) => void)(node);
  }

  remove(id: string): void {
    const node = this.nodes.get(id);
    if (!node) return;
    node.remove();
    this.nodes.delete(id);
  }

  clear(): void {
    for (const n of this.nodes.values()) n.remove();
    this.nodes.clear();
  }
}
