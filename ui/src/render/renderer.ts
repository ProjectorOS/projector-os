// Renderer abstraction. Each overlay surface (SVG vector overlays, HTML info cards,
// future Canvas/WebGL layers) implements this interface so the rest of the app can
// add/remove items without caring which DOM tech draws them.

export interface Renderer {
  /** Add or update an item identified by `id`. */
  upsert(id: string, render: () => void): void;
  /** Remove an item by id. */
  remove(id: string): void;
  /** Remove every item currently managed by this renderer. */
  clear(): void;
}
