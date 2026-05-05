# ProjectorOS

A platform for projector + camera applications. The first application is a craft cutting-mat assistant: a downward-facing projector and USB webcam share a cutting mat, the system tracks objects placed on it, and projects information aligned to those objects.

## Architecture

- **Python server** (`server/`) — camera capture, calibration math, ArUco detection, WebSocket fan-out.
- **Browser UI** (`ui/`) — TypeScript + Vite, two entry points sharing the same WebSocket bus:
  - **Control panel** at `/` — opened automatically in your default laptop browser by `scripts/start.sh`. Buttons for Idle / Calibrate / Track, calibration-measurement input, and a live list of detected objects. Either client can issue commands; both stay in sync via server broadcasts.
  - **Projector view** at `/projector/` — fullscreen kiosk on the projector display. Black background, SVG overlays, no on-screen controls.
- **Coordinate spaces:** `camera_px` (camera frame) → `mat_mm` (millimeters on the mat surface, canonical world frame) → `projector_px` (browser window). Two homographies persist in `data/calibration.json`.
- **Work surface:** the projector often covers more area than the actual mat. A "work surface" rectangle (in projector pixels, persisted in `data/work_surface.json`) defines the workable subset. Calibration markers and content are positioned inside it; a dashed outline on the projector marks its bounds. Adjust margins from the **Work surface** card in the control panel.

## First-time setup

```bash
# Python
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt

# UI
cd ui && npm install && cd ..
```

## Run

```bash
./scripts/start.sh
```

This boots the server + Vite dev server and opens the control panel (`/`) in your default browser.

The control panel includes a **Projector display** card listing every connected display (name, resolution, screen origin). Click "Launch" next to a display and the server opens a fullscreen Chromium kiosk on it. Use "Switch display" to relaunch on a different one, or "Close projector window" to dismiss it.

The server enumerates displays via NSScreen (called through `osascript` JXA — no extra deps) and converts Cocoa Y-up coordinates to the Quartz Y-down coordinates Chromium's `--window-position` expects.

For UI development without the projector you can also just run the two halves separately:

```bash
.venv/bin/python -m server.main           # http://127.0.0.1:8000
cd ui && npm run dev                       # http://127.0.0.1:5173
```

## Calibration (one-time per setup)

In the **control panel** (laptop browser):

1. Click **Calibrate**. The server tells the projector view to draw 4 ArUco markers (IDs 10–13) at known projector-pixel positions near the corners of the projection.
2. The camera detects them automatically — the calibration card shows "All 4 markers detected" once it's stable.
3. With a ruler, measure the **horizontal mm distance between the centers of the top-left and top-right markers** on the mat. Type the number and click **Save**.
4. The server computes `H_cam_to_mat` and `H_mat_to_proj`, persists them to `data/calibration.json`, and switches to track mode.

**Assumption (v1):** the projection on the mat is approximately rectangular (projector roughly perpendicular to mat). Heavy keystoning will skew the calibration; use the projector's keystone correction setting to flatten it before calibrating.

## Tracking

Place an object with an ArUco marker (DICT_4X4_50, ID 0–9) on the mat. The system projects a green outline + label that follows the object as it moves.

Generate ArUco markers for printing/sticking on objects:

```
http://localhost:8000/markers/0.png
http://localhost:8000/markers/1.png
...
http://localhost:8000/markers/9.png
```

## Project layout

```
projectoros.org/
├── server/                  Python: CV + WS
│   ├── main.py             FastAPI app, mode state machine, run loop
│   ├── camera.py           threaded webcam grabber
│   ├── calibration.py      homography compute + persistence
│   ├── detection.py        ArUco object detector
│   ├── bus.py              WS fan-out
│   └── protocol.py         pydantic event/command models
├── ui/                          TypeScript: control panel + projector view
│   ├── index.html              control panel entry (laptop browser, served at /)
│   ├── control.css             control panel styles
│   ├── projector/
│   │   └── index.html          projector entry (kiosk, served at /projector/)
│   └── src/
│       ├── ws-client.ts        shared reconnecting WS client
│       ├── types.ts            shared protocol types
│       ├── control/control.ts  control-panel UI
│       └── projector/
│           ├── main.ts         projector renderer
│           ├── calibration.ts  draws calibration markers
│           ├── overlay.ts      draws tracked-object outlines
│           └── render/         renderer abstraction (SVG, HTML, Canvas)
├── scripts/start.sh
└── data/calibration.json   (generated, gitignored)
```

## What's not in v1

- Open-vocabulary object recognition (OWL-ViT / YOLO) — the ArUco interface in `server/detection.py` is the swap point.
- Hand / gesture detection (MediaPipe Hands) — separate detection module on the same WS bus.
- Workflow / instruction UI (recipe-style step engine).
- Mat-grid-based passive calibration.
