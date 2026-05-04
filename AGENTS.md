# AGENTS.md

Guidance for AI coding agents working in this repo. The README covers product/usage; this file covers conventions and gotchas that aren't obvious from the code.

## What this project is

ProjectorOS: a downward-facing projector + USB webcam over a craft cutting mat. Server (Python+OpenCV) detects ArUco markers and broadcasts state over WebSocket; browser UI has two entry points sharing the bus. Target platform is macOS; nothing here is portable to Linux/Windows yet (display + camera enumeration use macOS-specific APIs).

## Run / build

```bash
./scripts/start.sh                          # boots server + vite + opens control panel
.venv/bin/python -m server.main             # server only (port 8000)
cd ui && npm run dev                        # vite only (port 5173)
cd ui && npm run build                      # type-check + bundle
```

If port 8000 is stuck after a crash: `pkill -9 -f "server.main"`. Don't sleep-and-retry.

## Architecture

Two browser entry points, one server:

- [ui/index.html](ui/index.html) → [ui/src/main.ts](ui/src/main.ts) — fullscreen projector kiosk. SVG overlays only, no controls.
- [ui/control.html](ui/control.html) → [ui/src/control.ts](ui/src/control.ts) — control panel in laptop browser. All buttons/inputs live here.
- [server/main.py](server/main.py) — FastAPI app, WS endpoint, frame loop, all HTTP endpoints (`/cameras`, `/displays`, `/markers/{id}.png`, `/camera/preview.mjpg`, `/launch_projector`, ...).

Vite is configured for both entry points in [ui/vite.config.ts](ui/vite.config.ts) — if you add a third HTML page, add it to `rollupOptions.input`.

## Coordinate spaces

Three frames, two homographies (in [data/calibration.json](data/calibration.json)):

- `camera_px` — raw camera pixels
- `mat_mm` — millimeters on the mat surface (canonical world frame)
- `projector_px` — browser window pixels on the projector

`H_cam_to_mat`, `H_mat_to_proj`. Apply with [applyHomography](ui/src/overlay.ts#L7) on the UI side. Tracked-object overlays compute geometry in `mat_mm` then transform to `projector_px` so physical distances stay consistent.

The `work_surface` rectangle is in `projector_px` (persisted in [data/work_surface.json](data/work_surface.json)). Calibration markers are positioned inside it (see [server/calibration.py](server/calibration.py) `make_projection_layout`).

## Rendering: SVG first

SVG is the default for projector overlays. Canvas is reserved for things SVG can't do (heavy per-frame pixel work). The renderer abstraction lives in [ui/src/render/](ui/src/render/) — use `SvgRenderer.upsert(id, render)` to add/replace a `<g>` group.

Overlays that draw inside the work surface should set `clip-path="url(#work-surface-clip)"` on the group (see [ui/src/main.ts](ui/src/main.ts) `updateClipRect`). Don't draw outside the work surface.

## Surgical DOM updates in the control panel

This is the most important pattern in [ui/src/control.ts](ui/src/control.ts). `render()` does a full `innerHTML = ""` rebuild. If you call it on every WS event, every button loses focus and inputs get clobbered mid-typing.

Rules:

1. **High-frequency events** (`frame_stats` ~1 Hz, `calibration_captured` ~6 Hz, `detections` ~20 Hz) early-return from `onEvent()` and call surgical updaters that look up nodes by `data-role` (e.g. `data-role="heartbeat-row"`, `data-role="detections-tbody"`).
2. **Structural events** (mode changed, calibration saved, camera changed, work surface updated, display list changed) fall through to `render()`.
3. `render()` skips entirely when `draggingEdge` is set (live work-surface drag) and captures/restores focus around the rebuild.
4. Some DOM elements are persistent across renders — kept on the class, not recreated: `cameraPreviewImg` (avoids MJPEG reconnects), `measurementInput` (preserves typing state). When you remove them, also `null` the field.

If you add a new high-frequency event or a new control surface, follow the same pattern. Don't broadcast structural-looking events at high rates — split them.

## Persistence

Server-side (gitignored, in `data/`):

- `calibration.json` — both homographies + measured TL→TR distance
- `work_surface.json` — rect in projector_px
- `preferences.json` — `camera_index`, `projector_display`, `show_work_surface_outline`

Client-side (localStorage, prefix `projectoros.`): `workSurfaceCollapsed`, `previewRotation`, `previewHidden`, etc. Use `writeBool` / `readBool` helpers in [ui/src/control.ts](ui/src/control.ts) for consistency.

## ArUco markers

- Calibration: IDs 10–13 (TL, TR, BR, BL). Tracked objects: IDs 0–9. Dictionary: `DICT_4X4_50`.
- Marker PNGs served from [server/main.py](server/main.py) include a **white quiet zone** around the inner ArUco bits. Without it the outer black border dissolves into the projector's black background and detection silently returns nothing. Constants in [server/calibration.py](server/calibration.py): `CALIBRATION_MARKER_INNER_PX=200`, `CALIBRATION_MARKER_QUIET_ZONE_PX=100`, `CALIBRATION_MARKER_TOTAL_PX=400`. If you change these, also update the projection layout inset.
- The detector uses subpixel corner refinement; rejected-quad count is broadcast in `calibration_captured` so users can tell whether OpenCV is seeing anything at all.

## macOS specifics

- **Camera enumeration:** `system_profiler -json SPCameraDataType` ([server/cameras.py](server/cameras.py)). The JXA `AVCaptureDevice` bridge is broken on modern macOS — don't try it.
- **Display enumeration:** JXA `NSScreen` via `osascript -l JavaScript` ([server/displays.py](server/displays.py)). Returns Quartz coords (Y-down from main display top). NSScreen gives Cocoa Y-up — the conversion happens in `displays.py`. PyObjC isn't available for system Python; JXA is the workaround.
- **Projector window:** Chromium kiosk launched as a subprocess by [server/launcher.py](server/launcher.py) with `--window-position`/`--window-size` in Quartz coords.
- **Stdin prompts:** if you ever spawn a Python helper that reads stdin and writes to stdout via process substitution, prompts must go to **stderr** (`print(prompt, end="", file=sys.stderr); input()`) — otherwise they corrupt the bash `read` parser.

## Conventions

- **No emojis** in code or files unless explicitly requested.
- **Comments:** explain *why*, not *what*. Most code doesn't need any. The existing comments in [ui/src/overlay.ts](ui/src/overlay.ts) and [ui/src/calibration.ts](ui/src/calibration.ts) are good examples — they explain non-obvious choices (angle convention, quiet-zone reasoning, label offset).
- **Pydantic v2** for all server protocol types in [server/protocol.py](server/protocol.py). Mirror types in [ui/src/types.ts](ui/src/types.ts) by hand — keep the two in sync when adding events/commands.
- **Imperial units:** `parseLengthMm` in [ui/src/control.ts](ui/src/control.ts) accepts mm/cm/m/in/inch/inches/"/ft/foot/feet/'. Use it for any user-entered length, not just calibration.

## Gotchas worth knowing

- The control panel and projector view are separate clients. Both can issue commands; both stay in sync via server broadcasts. If you add a command that mutates state, broadcast the resulting state — don't assume the issuing client has the truth.
- `register_projector` is sent on every projector window resize. Server `projector_dims` may flip mid-calibration if the user resizes — code that depends on it should re-read, not cache.
- The MJPEG preview is a single long-lived `<img>`. Setting `src=""` and removing it actually closes the byte stream; recreating it reconnects. Don't toggle `display:none` and expect the bytes to stop flowing — they don't.
- Work-surface drag updates are throttled to ~33ms during pointermove and re-broadcast on pointerup. Don't add more drag-time work into that hot path.

## When in doubt

Read [server/main.py](server/main.py) and [ui/src/control.ts](ui/src/control.ts) — they hold the bulk of the system's logic and most non-obvious decisions are visible there.
