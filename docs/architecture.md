# ProjectorOS Target Architecture

Status: proposal, 2026-10-07. This describes where ProjectorOS is heading and how to get there in phases without redesigning the system at each step. For the system as it exists today, see [README.md](../README.md) and [AGENTS.md](../AGENTS.md).

## 1. What ProjectorOS is

ProjectorOS turns any surface into an interactive, camera-aware display. It runs on machines ranging from a fanless x86 mini-PC to a GPU workstation or a MacBook, connected to one or more projectors and cameras. It hosts **apps written by third parties** that draw onto physical surfaces and react to what cameras see and to what visitors do on their phones.

The craft cutting-mat assistant is the first app. It is also the reference app: every platform feature should be exercised by it, or by another first-party app, through the same public SDK that third-party developers use.

### 1.1 Principles

1. **Local-first, offline by default.** A complete installation works with no internet, no accounts, no registration and no payments. Cloud services, authentication, licensing and monetization are optional extensions, never requirements.
2. **Open core.** The platform, SDK, protocol and reference apps are open source (Apache-2.0). Optional central services, such as a public app catalog or relays, may exist later, but only behind open extension interfaces that anyone can implement or self-host.
3. **Apps are untrusted.** Third-party code runs sandboxed, gets only the data it was granted, and cannot affect the platform's stability, its UI or other apps.
4. **Physical truth, flexible views.** The canonical world is physical: metres in a scene, millimetres on a surface. Apps choose the units they work in (mm, normalized, virtual px), the way CSS lets authors choose units over one layout engine.
5. **Ask for meaning, not hardware.** Apps request capabilities such as `hands` or `touch`, never "camera 2". The platform decides how to provide them on the hardware it has.
6. **Degrade gracefully.** The same app runs on weak and strong hardware. It receives fewer or slower capabilities on weaker machines, and is told exactly what it got.
7. **Leave room for the hard features.** Irregular surfaces, multi-projector edge blending, stereo and IR sensing, and multi-machine setups are not built early, but the data model and process boundaries are chosen now so that adding them does not force a redesign.

### 1.2 Non-goals

- Not a general-purpose desktop or a web browser.
- Not a video-mapping show-control tool for timeline-driven media. Interop with those tools is welcome, but it is not the core use case.
- No mandatory central service of any kind.

## 2. People and trust

There are three kinds of people. Their trust levels drive the security model.

| Role | Owns | Typically does | Trust |
|---|---|---|---|
| **Space owner** | The machine, projectors, cameras, the room | Installs ProjectorOS, calibrates, installs apps, decides what apps may access | Full control of the device |
| **App author / operator** | Their apps; sometimes comes in to run a session | Builds apps; on site, loads and runs apps within what the owner allows | Trusted with what the owner delegates, never more |
| **Visitor** | Only their own phone | Watches, interacts with their body, joins from a phone via QR code, possibly over cellular from outside the local network | Anonymous and untrusted |

In a home setup one person is often all three roles, and the system must not force them through ceremony meant for public venues. The default for a single-person install is: the person at the device is the owner, with no login.

```mermaid
flowchart LR
  subgraph Trusted["Device trust zone (space owner)"]
    SUP[Supervisor and broker]
    SH[Shell: platform UI and compositor]
    CAP[Capture and capability workers]
  end
  subgraph Delegated["Delegated (operator session)"]
    OPS[Operator console]
  end
  subgraph Untrusted["Untrusted"]
    APP1[App sandbox A]
    APP2[App sandbox B]
    PH[Visitor phones]
  end
  OPS -- "scoped token" --> SUP
  APP1 -- "grants only" --> SUP
  APP2 -- "grants only" --> SUP
  PH -- "rate-limited, anonymous" --> SUP
```

Consequences:

- Permission prompts for sensitive capabilities, such as raw camera video, go to the **owner** (or an operator the owner delegated to), never to visitors, because visitors are being sensed but don't own the device.
- Visitors never authenticate by default. They join a session with a code or QR link, and get an ephemeral, anonymous session identity scoped to that session.
- Platform UI (calibration, operator controls, permission prompts, connection QR codes) always renders above apps, and apps cannot imitate it.

## 3. System overview

```mermaid
flowchart TB
  subgraph HW[Hardware]
    CAMS[Cameras: RGB, IR, stereo]
    PROJ[Projectors and displays]
  end

  subgraph Device["ProjectorOS device"]
    SUP["Supervisor<br/>process lifecycle, config, health"]
    BRK["Capability broker<br/>manifests x hardware x policy = grants"]
    CAPT["Capture service<br/>owns all cameras, timestamps frames"]
    FB[("Frame bus<br/>shared memory ring buffers")]
    W1["Capability worker: markers"]
    W2["Capability worker: hands / pose"]
    W3["Capability worker: presence / touch"]
    INP["Input providers<br/>HID, gamepad, MIDI, serial, OSC"]
    SCN[("Scene store<br/>calibration, surfaces, units")]
    GW["Gateway<br/>HTTP(S), WebSocket, phone sessions"]
    SHELL["Shell<br/>platform UI + surface compositor"]
    SB1["App sandbox<br/>surface view"]
    SB2["App sandbox<br/>surface view"]
    STORE[("Local app store")]
    EXT["Extensions (optional)<br/>auth, remote access, catalog, payments"]
  end

  PHONES[Visitor phones]
  OPC[Operator console: laptop or tablet]

  CAMS --> CAPT --> FB
  FB --> W1 & W2 & W3
  W1 & W2 & W3 --> BRK
  DEVS[Input devices] --> INP --> BRK
  SCN --> BRK
  SCN --> SHELL
  BRK --> SB1 & SB2
  SB1 & SB2 --> SHELL --> PROJ
  SUP -. manages .-> CAPT & W1 & W2 & W3 & SHELL & GW & SB1 & SB2
  STORE --> SUP
  GW <--> BRK
  PHONES <--> GW
  OPC <--> GW
  EXT -. plugs into .-> GW & STORE & BRK
```

| Component | Responsibility | Today's equivalent |
|---|---|---|
| Supervisor | Starts, watches and restarts every other process; owns configuration; exposes health | `scripts/start.sh` plus `server/main.py` lifespan |
| Capture service | The only process that opens cameras; timestamps frames at capture; publishes frames to the frame bus | `server/camera.py` |
| Frame bus | Zero-copy, same-machine frame sharing via shared-memory ring buffers | none (in-process) |
| Capability workers | One process per capability provider (ArUco, hand landmarks, presence, ...); stateless where possible | `server/detection.py`, called inline in the asyncio loop |
| Capability broker | Negotiates grants, routes capability streams to apps in each app's units, enforces rates and permissions | none |
| Scene store | Versioned scene description: world frame, cameras, projectors, surfaces, warps | `data/calibration.json`, `data/work_surface.json` |
| Gateway | Local HTTP(S) and WebSocket endpoint for the shell, the operator console, apps' companion pages and phones | FastAPI in `server/main.py` |
| Shell | Trusted platform UI and the compositor that maps app surfaces onto projector outputs | `ui/projector/` |
| App sandboxes | One isolated renderer per app, per surface | none (overlays are built into the projector page) |
| Operator console | Owner and operator UI: calibration, apps, permissions, sessions | `ui/index.html` control panel |
| Local app store | Installed app packages, versions, granted permissions | none |

## 4. The scene model

Calibration grows from "two homographies" into a **scene**: a versioned description of the physical setup. Everything spatial in the system is expressed against it.

```mermaid
flowchart LR
  W(("World frame<br/>metres"))
  C1["Camera<br/>intrinsics + distortion<br/>pose in world"]
  P1["Projector / output<br/>resolution<br/>warp mesh + blend mask<br/>pose in world (optional)"]
  S1["Surface 'mat'<br/>plane or mesh<br/>local frame, mm<br/>usable region"]
  S2["Surface 'wall'"]
  W --- C1
  W --- P1
  W --- S1
  W --- S2
  S1 -. "maps to" .-> P1
  C1 -. "observes" .-> S1
```

Key points:

- **World frame** in metres. It is optional in simple setups: a single flat surface can act as the world.
- **Surfaces** are named regions apps draw on and receive input in. A surface is a plane (today) or a mesh (later), with its own 2D frame in millimetres, a usable region (today's work-surface rectangle) and an orientation (where "up" is, and the default origin).
- **Cameras** carry intrinsics and a distortion model when calibrated. A camera that has only been calibrated against a surface by homography is still valid, just less capable.
- **Outputs** (projectors or displays) map surface coordinates to output pixels through a **warp mesh**. A homography is stored as a 2x2 mesh, so today's calibration is a degenerate case of the general format. Irregular surfaces and keystone correction later only need denser meshes. Each output also carries an optional **blend mask** for overlap regions with other projectors.
- **Tangibles** are the registry of known physical objects: what marker (or other method) identifies each one, its footprint and hotspot, and optionally the input device bound to it. See section 7.
- **Marker families** list which fiducial families this installation detects. See section 6.4.

Example (illustrative, not final):

```json
{
  "scene_version": 1,
  "world": { "units": "m" },
  "surfaces": {
    "mat": {
      "kind": "plane",
      "size_mm": [600, 450],
      "region_mm": [[10, 10], [590, 440]],
      "orientation": { "up": "+y", "origin": "top-left" }
    }
  },
  "cameras": {
    "cam0": {
      "device_hint": "FaceTime HD Camera",
      "resolution": [1280, 720],
      "intrinsics": null,
      "surface_maps": { "mat": { "kind": "homography", "H": [[1,0,0],[0,1,0],[0,0,1]] } }
    }
  },
  "outputs": {
    "proj0": {
      "display_hint": "EPSON PJ",
      "resolution": [1920, 1080],
      "surface_maps": {
        "mat": { "kind": "mesh", "grid": [2, 2], "points_px": [[0,0],[1920,0],[0,1080],[1920,1080]] }
      },
      "blend_mask": null
    }
  },
  "marker_families": {
    "enabled": ["apriltag/36h11", "qr"],
    "reserved": { "apriltag/36h11": { "platform": [580, 586] } }
  },
  "tangibles": {
    "cutting-ruler": {
      "marker": "apriltag/36h11/3",
      "footprint_mm": [[0, 0], [300, 0], [300, 40], [0, 40]],
      "marker_offset_mm": [15, 20]
    },
    "keyboard-1": {
      "marker": "apriltag/36h11/12",
      "footprint_mm": [[0, 0], [440, 0], [440, 130], [0, 130]],
      "layout": "ansi-104",
      "tip": { "offset_mm": [220, -25], "style": "caret" },
      "device": { "bus": "usb", "vendor_id": "046d", "product_id": "c31c", "serial": "..." }
    }
  }
}
```

The scene file is versioned with a migration path, so old calibrations keep loading as the format grows.

## 5. Coordinates and units

The canonical frame is physical. Each app picks how it sees a surface, in its manifest, and can change it at runtime.

| Unit mode | Meaning | Use for |
|---|---|---|
| `mm` | Physical millimetres on the surface | Anything sized to real objects, such as the craft mat |
| `normalized` | 0..1 over the usable region, with a `fit` mode | Resolution-independent visuals |
| `px` | A virtual resolution the app declares, such as 1920x1080, with a `fit` mode | Ports of existing screen-based apps and games |

`fit` follows CSS `object-fit`: `stretch` (x and y scaled independently; angles and circles distort), `contain` (uniform scale, letterboxed) or `cover` (uniform scale, cropped). "px" never means projector pixels, which are uneven under keystone, warp and blending.

The unit choice applies to **everything spatial an app receives**: positions, sizes, velocities and radii, not just points. Apps can always convert with SDK helpers, for example `surface.convert(20, 'mm')` to get a 20 mm hit radius in their own units.

Implementation: the shell applies one transform to an app's root so its coordinate system matches its unit choice. In `mm` mode, 1 CSS `mm` equals 1 physical millimetre on the surface, so `width: 50mm` is literally true. For SVG, the unit choice is a `viewBox`. For WebGL and WebGPU, the SDK provides the matching projection matrix.

3D capabilities, such as body pose in a room, report in the world frame (metres), with helpers to project onto a surface.

## 6. Sensing

### 6.1 Pipeline

```mermaid
sequenceDiagram
  participant Cam as Camera
  participant Cap as Capture service
  participant Bus as Frame bus
  participant Wk as Capability worker
  participant Brk as Broker
  participant App as App sandbox
  Cam->>Cap: frame
  Cap->>Bus: frame + capture timestamp + camera id
  Bus->>Wk: zero-copy read
  Wk->>Brk: results in camera space + timestamp
  Brk->>Brk: map to surface frame, filter, predict
  Brk->>App: events in app units, throttled to grant rate
```

- **One owner per camera.** On Linux, a V4L2 device usually can't be opened by two processes, and on every OS it is simpler to have one capture path. Every consumer, including apps that are granted video, reads from the frame bus.
- **Timestamps from capture.** Every event carries the capture timestamp of the frame it came from, so apps and the broker can predict motion and the system can measure its own latency.
- **Workers are separate processes.** A crashing or slow model can't take down capture or the platform. Workers can be written in any language that can read the frame bus and speak the protocol.
- **Inference runs through ONNX Runtime where possible.** Its execution providers map onto the hardware tiers: CoreML on Macs, OpenVINO on Intel mini-PCs, CUDA or TensorRT on Nvidia, DirectML on Windows. OpenCV remains for classic vision such as ArUco and contours.

### 6.2 Capabilities are semantic, providers are pluggable

An app requests a capability. The broker picks a **provider** that can deliver it on this hardware.

| Capability | What the app gets | Possible providers |
|---|---|---|
| `markers` | Fiducial family, id or payload, position, rotation on a surface | Marker-family plugins (section 6.4) on RGB or IR |
| `tangibles` | Known physical objects: pose, footprint, hotspot, and input from a bound device | Markers fused with input providers (section 7) |
| `hands` | Hand landmarks, handedness, on-surface positions | Landmark model on RGB; IR + model |
| `pointers` | Pointer-Events-like stream: fingertips, pens, laser dots, phone cursors, mice | Derived from hands, blobs, phones, tracked and screen-bound mice |
| `keyboard` | Key events, routed by focus or by keyboard location | Screen-bound keyboards (shell); tracked keyboards (section 7) |
| `controls` | Buttons, axes, knobs, notes from gamepads, MIDI and custom devices | Input providers (section 7) |
| `touch` | True contact vs hover | IR curtain or IR blob; stereo/depth height above surface. Not available on RGB-only hardware. |
| `presence` | Occupancy, bounding regions, people count | Background model on IR; person segmentation on RGB |
| `pose` | Body skeletons, 2D or 3D | Pose model; stereo for 3D |
| `video` | Camera imagery, in graded levels (section 8.3) | Capture service, possibly with segmentation |

New capabilities and providers are added as worker plugins with a declared contract: the capability's schema, sensor requirements and cost per frame. First-party providers come first; third-party providers are a later phase and run with the same isolation as workers.

### 6.3 The camera sees the projection

Projected content contaminates what an RGB camera sees. This affects capabilities differently, and the broker accounts for it:

- **Markers** are mostly robust, especially with quiet zones and high contrast.
- **Hands** are workable on RGB under moderate projected light.
- **Presence, blobs and touch** are unreliable on RGB over changing content. Reliable providers need **IR**: an IR camera, an IR illuminator, and a filter that blocks visible light, so the projector is invisible to the sensor. Stereo/depth is the other option.
- A future RGB mitigation: subtract the predicted projected image (the platform knows what it projected and the camera-to-output mapping).

IR and stereo hardware is optional. Without it, the broker simply doesn't grant `touch`, and grants `presence` with a quality flag.

**Seeing the projection is also useful: continuous calibration.** Because an RGB camera sees both physical and projected markers, it can check alignment while the system runs, not only during setup. Projectors get bumped, cameras sag on their mounts, and mats get nudged.

- **Physical reference markers** fixed to the surface give the camera-to-surface mapping.
- **Projected markers**, shown briefly or in the margin outside the usable region, give the output-to-camera mapping.
- **Comparing the two shows what moved:**

| Observation in the camera image | Likely cause | Correction |
|---|---|---|
| Physical and projected markers both shifted the same way | The camera moved | Re-solve camera-to-surface from the physical markers |
| Projected markers shifted, physical markers didn't | The projector moved | Re-solve the output warp from the projected markers |
| Physical markers shifted relative to each other or to the surface edges | The surface moved or deformed | Re-solve the surface; flag it to the operator |

- **Tangibles provide a direct alignment check.** A projected outline should sit exactly on its physical object. The offset between a tracked marker and its projected outline is the actual alignment error, measured in millimetres.
- **No ruler step after the first setup.** Physical reference markers of known size and spacing give scale directly, so recalibration doesn't need a manual measurement.
- **Small drift is corrected automatically and large drift asks the operator.** Each correction is a new scene version, so it can be undone.
- **Checks don't disturb apps.** They use the platform layer, run in short windows or at low contrast, and are skipped while an app has requested an uninterrupted surface.
- **This needs a camera that sees visible light.** An IR-only setup can't see the projection. Such setups keep a small RGB camera for calibration, or project calibration patterns in IR if the hardware supports it.

### 6.4 Marker families are plugins

Fiducial markers are not one technology. Each **marker family** is a plugin, and the owner chooses which families an installation detects ([issue #8](https://github.com/ProjectorOS/projector-os/issues/8)).

| Family | Plugin backend | Identity | Notes |
|---|---|---|---|
| **AprilTag** (`apriltag/36h11` and others) | AprilTag 3 C library (BSD); OpenCV's AprilTag dictionaries as a fallback | Integer id | **Default.** Robust, low false-positive rate, good under blur and partial light. 36h11 has 587 ids. |
| **ArUco** (`aruco/4x4_50` and others) | OpenCV `aruco` | Integer id | Supported today. Kept for existing setups and small markers. |
| **QR codes** (`qr`) | zxing-cpp (Apache-2.0) or OpenCV's QR detector | String payload | Carries data, not just an id. Slower to decode, so it runs at a lower rate and is tracked between decodes. The same plugin can later cover Micro QR, Data Matrix and Aztec. |
| **ARToolKit** (`artoolkit/...`) | ARToolKitX (LGPL), as a separate worker process | Template pattern or matrix code | Template markers allow arbitrary pictures inside the border. |
| **ARTag** | To be determined | Integer id | Availability and licensing of a detector need checking before committing to it. |
| Future | Plugins | Any | Examples: STag, CCTag, circular and nested markers, IR-only markers, retroreflective dots |

**Plugin contract.** A marker-family plugin declares and implements:

```python
class MarkerFamily(Protocol):
    key: str                           # "apriltag/36h11", "aruco/4x4_50", "qr"
    id_kind: Literal["int", "payload"]
    id_range: tuple[int, int] | None   # None for payload families
    sensors: set[str]                  # {"rgb", "ir"}
    cost_hint_ms: float                # per 1 MP frame on a reference machine

    def detect(self, gray: np.ndarray, rois: list[Rect] | None) -> list[MarkerDetection]: ...
    def render(self, id: int | str, size_px: int, quiet_zone_px: int) -> np.ndarray | None: ...
```

`MarkerDetection` carries the family key, the id or payload, the four corners in camera pixels in a canonical order, a quality score from 0 to 1, and family-specific extras such as Hamming distance. Everything after detection (mapping to surfaces, pose, filtering, occlusion handling, tangibles) is shared and does not depend on the family.

Rules:

- **Marker identity is namespaced**: `apriltag/36h11/7` and `aruco/4x4_50/7` are different markers. QR identities are their payloads (`qr/<payload>`).
- **The platform reserves ids** in its families, for example for calibration patterns. Apps can't claim reserved ids. Calibration moves from ArUco ids 10 to 13 to a reserved AprilTag range.
- **Only needed families run.** Detectors run for the families that are both enabled by the owner and needed by the platform, the tangible registry or a running app. Each family gets its own rate and can be limited to regions of interest. Payload families decode once, then track the marker cheaply until it's lost.
- **Cross-family duplicates** are resolved by overlap and quality, because one family's detector can occasionally misread another family's marker.
- **Apps request families and id ranges** in their manifest, and only see the markers they asked for. A QR app declares a payload filter, such as a URL prefix, so it never sees unrelated codes lying on the table.
- **QR payloads are untrusted input.** The platform never acts on them (no opening URLs), and they reach apps only through the filter.
- **Printing.** Plugins that can render markers back the printable endpoint, `/markers/{family}/{id}.png`, plus printable sheets, always with the quiet zone that projection surfaces require.
- **Packaging.** Python plugins run inside the shared markers worker and register through Python entry points (`projectoros.marker_families`). Plugins in other languages, such as ARToolKit, run as their own worker and send the same `MarkerDetection` messages. Third-party plugins come later, with worker isolation.

## 7. Input devices and tangibles

Not every input comes from cameras or phones. Mice, keyboards, gamepads, MIDI controllers, knobs and custom devices can take part too, either as ordinary screen-bound devices or as **tangibles**: physical objects at a known place in the scene that also produce input.

### 7.1 Input sources and routing

```mermaid
flowchart LR
  subgraph Sources
    S1["Sensing<br/>cameras, capability workers"]
    S2["Phones<br/>via gateway"]
    S3["Screen-bound devices<br/>operator mouse and keyboard, via shell"]
    S4["Input providers<br/>input bridges, seized HID, gamepad, MIDI, serial, OSC"]
  end
  S1 & S2 & S3 & S4 --> R["Broker input router<br/>fusion, binding, focus, grants"]
  R --> A1[App A]
  R --> A2[App B]
  R --> PUI["Platform UI<br/>(never visible to apps)"]
```

Everything goes through the broker's input router, including devices plugged into the machine. This matters for the rendering pipeline: in stage B (section 10), apps render offscreen and never receive native input, so the platform has to route input to them anyway. Routing through the broker from the start keeps app behavior the same in every stage.

There are two kinds of local device:

| Kind | Example | Captured by | Routed by |
|---|---|---|---|
| **Screen-bound** | The operator's mouse and keyboard; a touchscreen on a display output | The shell (Electron), as normal OS input | Spatial input through the inverse warp to surface coordinates; keys by focus |
| **Tracked** | A mouse or keyboard on the table with a marker on it | A backend input provider, through an input bridge or software seizing | Its physical pose (section 7.2) |

Input routing rules:

- **Spatial input** (pointers from any source) goes to the app that owns the surface at that point, in that app's units.
- **Non-spatial input** (keys, buttons, MIDI) goes to the app with focus, to an app the operator explicitly assigned the device to, or, for tracked devices, to the app at the device's location.
- **The platform draws all cursors**: screen-bound cursors and the projected tips of tracked devices (section 7.2), so they stay correct across surfaces, warps and blended overlaps.
- **Devices can be assigned to players or seats**, so an app sees "player 2" whether that's a gamepad, a phone, a tracked mouse or a tracked hand.

### 7.2 Tangibles

A tangible combines up to two things:

- **Where it is:** a pose from a marker (any family in section 6.4), IR LEDs, a depth or shape model, or none at all.
- **What it sends:** an event stream from HID, MIDI, serial, BLE, OSC or a phone, or none at all.

The craft mat's tracked objects are tangibles with a pose and no data stream. A keyboard with a marker is a tangible with both. Tangibles are registered in the scene (section 4) with a footprint, a marker offset, an optional **hotspot** (the point that acts as the pointer, such as the front of a mouse) and an optional key layout. Apps receive them through the `tangibles` capability, and their input also appears in `pointers`, `keyboard` and `controls`.

**Tracked mice: fuse camera and HID.**

| Source | Strength | Weakness |
|---|---|---|
| Camera via marker | Absolute position and rotation | About 30 Hz, around 100 ms of latency, lost whenever a hand covers the marker |
| HID sensor | Up to 1000 Hz, very low latency | Relative only; drifts |

The router fuses both with a filter. HID deltas drive responsiveness, and camera poses correct position and drift. HID counts are converted to millimetres with a scale learned by comparing HID motion with the camera track, and rotated into the surface frame using the mouse's current angle. When a hand covers the marker, HID dead-reckoning keeps the mouse tracked. The resulting pointer is reported at the hotspot as `pointerType: 'mouse'` with `tracked: true`.

**Tracked keyboards: location is focus.** Keystrokes go to the app, and optionally to the input zone or object, nearest the keyboard. Two people at two keyboards type into two different places without clicking to focus. If the layout is known, apps can project onto the keys themselves.

**Projected tips: the projection extends the device.** A tracked mouse or keyboard has no on-screen cursor. Instead, the platform projects its **tip** onto the surface, attached to the physical device:

- A **mouse tip** is projected at the mouse's hotspot, ahead of its front edge, so the hand and the device itself don't cover it. It moves and rotates with the mouse at the fused HID rate, so it feels attached to the device and doesn't trail behind the camera.
- A **keyboard tip** is projected in front of the keyboard and shows where typing goes: a caret, the current focus target, or a line leading to it. This answers "where will my typing go?" directly on the table.
- Tips are part of the **trusted platform layer**, like a system cursor, and always render above apps, so an app can't hide or fake where a device points. Apps can choose a tip style from a platform-provided set (like CSS `cursor`), and can hide it only while the device is over their own surface.
- The tip offset, size and style are stored per tangible in the scene, so each device can be tuned once.
- Tips also confirm binding. When a device is bound, its tip appears. A device with a marker but no tip is visibly not bound yet.

**Binding a device to its marker.** The platform has to learn which HID device belongs to which marker:

- **Motion correlation:** move a mouse, and the router matches its HID motion against marker motion.
- **Prompt:** the platform projects "press any key" next to a newly seen keyboard marker, and the keyboard that responds is bound to it.
- **Manually** in the operator console.

Bindings are stored in the tangible registry, so a known device is recognized whenever its marker appears. A phone can bind itself with no setup by showing a marker on its own screen.

**Keeping tracked devices away from the OS.** A tracked mouse must not move the system cursor, and a tracked keyboard must not type into the focused window. The preferred way to achieve this is hardware: an **input bridge** between the device and the computer, so the OS never sees a mouse or keyboard at all. Seizing devices in software is the fallback.

```mermaid
flowchart LR
  DEV["Mouse / keyboard<br/>(or its wireless receiver)"] -- USB --> BR["Input bridge<br/>microcontroller:<br/>USB host + USB device"]
  BR -- "USB, vendor-defined HID<br/>(not an input device to the OS)" --> PC["Input provider<br/>reads via hidapi"]
  BT["Bluetooth device"] -. BLE / Classic .-> BRW["Wireless bridge<br/>ESP32"]
  BRW -. "Wi-Fi or USB serial" .-> PC
  PC --> RT[Broker input router]
```

How the bridge works:

- Its firmware acts as the **USB host** for the real device and receives its raw HID reports.
- It presents itself to the computer on a **vendor-defined HID usage page**. The OS sees an unknown data device, so it moves no cursor and types nothing. Vendor-defined HID needs no driver on macOS, Linux or Windows, can be read from user space with `hidapi` (from Python or Rust, or even WebHID), and on macOS does not require the Input Monitoring permission.
- The firmware stays simple: it forwards the device's **report descriptor and raw reports**, and the input provider on the computer parses them. Supporting a new kind of device needs no firmware update.
- Each bridge has a **serial number** and can store the tangible it belongs to, such as "my device wears `apriltag/36h11/12`", in its own flash. Plugging the bridge into any ProjectorOS machine binds the device immediately, so a bridge plus a printed marker forms a reusable kit.
- **Identical devices stay separate.** Four mice on four bridges are four streams, which the OS would otherwise merge into one cursor.
- **Wireless devices** work by plugging their receiver into the bridge. Bluetooth devices pair with a wireless bridge instead of the computer.

Reference hardware (open hardware, a separate sub-project of ProjectorOS):

| Bridge | Hardware | Notes |
|---|---|---|
| USB | RP2040 (for example a Raspberry Pi Pico, or a board with a USB-A host port such as Adafruit's Feather RP2040 USB Host) running TinyUSB with Pico-PIO-USB | Full-speed and low-speed USB only, which covers nearly all mice and keyboards; adds about 1 ms of latency |
| USB, alternative | Teensy 4.1 | Native USB host port; more expensive |
| Wireless | ESP32 with Bluepad32 | Bluetooth host for mice, keyboards and gamepads; forwards over Wi-Fi or USB serial |

Existing open-source firmware already covers most of this: **hid-remapper** (RP2040, USB host to USB device HID forwarding) and **Bluepad32** (Bluetooth input host). The ProjectorOS firmware is an adaptation, not new research.

Input provider backends are interchangeable. Everything after them (fusion, binding, tips, routing) doesn't care which backend supplied a device:

| Backend | Platforms | Use |
|---|---|---|
| `bridge-usb` | macOS, Linux, Windows | **Recommended default** for tracked devices |
| `bridge-net` | macOS, Linux, Windows | Wireless bridges; devices far from the machine; multi-machine setups |
| `seize` | Linux (evdev `EVIOCGRAB`); macOS (IOHIDManager seizing, needs the Input Monitoring permission) | Software fallback with no extra hardware. Not offered on Windows, which would need a third-party kernel driver. |

Screen-bound devices for the operator are never bridged or seized; they stay ordinary OS input.

### 7.3 Security for input

- **Keyboard input is a capability** (`keyboard`) that the owner grants per app. Otherwise any app could log keystrokes meant for the platform.
- **A reserved key combination always reaches the platform** to open the operator overlay, pause apps or exit. Apps can't intercept it. Input to platform UI is never forwarded to apps, and apps can't send synthetic input to the platform.
- **Raw device access is a separate, higher-trust grant.** Apps get brokered events by default. Raw access through WebHID, WebSerial, WebMIDI, WebUSB or Web Bluetooth (which Electron routes to its main process for permission) is granted only for one specific device the owner picks.

### 7.4 Outputs use the same model

Lights (DMX or smart bulbs), sound, relays and haptics are **output providers**: the same pattern in reverse, reached through granted capabilities. A device can be both a tangible and an output, such as a lamp whose location is known. Output providers are a later phase, but they use the same provider, binding and grant mechanisms.

## 8. Capability broker and grants

### 8.1 Negotiation

```mermaid
flowchart LR
  M["App manifest<br/>required + preferred"] --> N{Broker}
  H["Hardware profile<br/>benchmarked at startup"] --> N
  P["Owner policy<br/>per-app permissions"] --> N
  X["Extension policy (optional)<br/>e.g. subscription tiers"] --> N
  N --> G["Grant<br/>what the app actually gets"]
  G --> A[App]
```

- Apps declare **required** and **preferred** levels, like media constraints in browsers (`min`, `ideal`).
- The **hardware profile** comes from a startup benchmark plus detected devices, not a static list of models.
- The **owner policy** is the space owner's permission decisions.
- An **extension policy** is optional. A future paid tier, for example, is just another policy input, and the core works without any.
- If a required capability can't be granted, the app doesn't start, and the operator sees why. Otherwise the app starts with the best grant and receives `grant.changed` events if conditions change.

### 8.2 Manifest

```json
{
  "id": "org.example.particle-wall",
  "name": "Particle Wall",
  "version": "1.2.0",
  "entry": {
    "surface": "surface/index.html",
    "companion": "phone/index.html"
  },
  "surface": { "units": "normalized", "fit": "contain", "min_size_mm": [400, 300] },
  "capabilities": {
    "hands":   { "required": true, "rate_hz": { "min": 15, "ideal": 30 } },
    "markers": { "required": false, "families": { "apriltag/36h11": { "ids": [0, 49] }, "qr": { "payload_prefix": "https://example.org/wall/" } } },
    "presence": { "required": false },
    "video":   { "required": false, "level": "silhouette" }
  },
  "interaction_class": "direct",
  "network": { "allow": [] },
  "phones": { "max_sessions": 50, "inputs": ["pointer", "buttons"] }
}
```

The grant mirrors the request with actual values, including measured latency for the interaction class, so apps can adapt instead of guessing.

### 8.3 Video access levels

Raw imagery is the most sensitive capability, so it is graded. Each level is a separate permission:

1. `none`: derived data only (the default).
2. `silhouette`: a low-resolution segmentation mask, with no identifying imagery.
3. `low`: downscaled video, for example 320 px wide at 15 fps.
4. `full`: full-resolution video.

Video is delivered as a standard `MediaStream`, so apps use ordinary web APIs. The space owner grants these levels, and the platform shows a persistent indicator on the operator console while any app is receiving video.

### 8.4 Hardware tiers and interaction classes

Hardware tiers are descriptive, not product SKUs:

| Tier | Example | Realistic scope |
|---|---|---|
| Light | Intel N100 mini-PC, integrated GPU | 1 camera, 1 output; markers and hands at reduced rates; light apps |
| Standard | Apple Silicon laptop, mid-range PC | Several cameras; hands and pose at full rate; WebGL apps |
| Heavy | Workstation with discrete GPU | Multiple outputs with warp and blend; stereo; high-fps cameras |

Developers target **interaction classes**:

| Class | Typical use | Requirement |
|---|---|---|
| `ambient` | Presence, crowds, slow visuals | Any tier |
| `direct` | Hands, markers, dragging | Measured photon-to-photon latency reported in the grant; motion prediction available |
| `fast` | Balls, lasers, fast gestures | High-fps cameras (120 fps or more) and a capable tier |

The system measures its own **photon-to-photon latency**: it projects a timed pattern and detects it with the camera. This runs during calibration and on demand, and the result is part of the hardware profile.

## 9. Apps and sandboxing

### 9.1 Package and store

An app is a static web bundle (HTML, JS, WASM, assets) plus `manifest.json`, distributed as a single archive. No server-side code runs on the device for an app.

- **Phase 1: local store.** The owner installs apps from a file, a folder (developer mode) or a URL. The store keeps versions and the owner's permission decisions.
- **Later: catalogs.** Any number of catalog sources (a self-hosted list, a community index, an optional central catalog). Packages can be signed, and the owner can require signatures. Catalogs are an extension, not a core dependency.

### 9.2 Isolation

```mermaid
flowchart TB
  subgraph Shell["Shell process (trusted)"]
    UI[Platform UI layer: always on top]
    COMP[Surface compositor]
  end
  subgraph A["App A renderer process"]
    AS[Surface view]
  end
  subgraph B["App B renderer process"]
    BS[Surface view]
  end
  AS -- "SDK over MessagePort" --> BRK[Broker]
  BS -- "SDK over MessagePort" --> BRK
  AS -- pixels --> COMP
  BS -- pixels --> COMP
  COMP --> OUT[Outputs]
  UI --> OUT
```

- Each app runs in **its own renderer process**, served from its own origin (for example `app-<id>.local.projectoros`), with no Node access, a strict Content Security Policy, and network access only to hosts listed in the manifest.
- The **only channel** to the platform is the SDK, over a `MessagePort` that the broker controls. There is no shared global and no injected `window.SpatialEngine`.
- The **shell** is trusted and separate. Platform UI renders above all apps. Apps cannot draw outside their surface region.
- **Resource governance:** per-app frame-time and memory monitoring, a watchdog that reloads a hung app, and rate caps on everything an app can send. On light hardware the broker lowers capability rates before the platform itself is starved.

The shell is built on **Electron**, for three reasons: one pinned Chromium on macOS, Linux and Windows; per-app process and session isolation; and offscreen rendering with shared GPU textures, which the warp compositor in section 10 needs. Tauri is not an option because it uses three different engines on three OSes and cannot capture app pixels. This assumption should be confirmed with a technical spike before Phase 5.

### 9.3 App lifecycle

```mermaid
stateDiagram-v2
  [*] --> Installed
  Installed --> Negotiating: launch
  Negotiating --> Blocked: required capability unavailable or denied
  Negotiating --> Running: grant issued
  Running --> Degraded: grant reduced (load, hardware change)
  Degraded --> Running: grant restored
  Running --> Suspended: operator pauses or surface reassigned
  Suspended --> Running: resume
  Running --> Crashed: watchdog timeout or crash
  Crashed --> Negotiating: auto-restart (with backoff)
  Running --> Installed: stop
  Blocked --> Installed: dismiss
```

## 10. Rendering and output

Apps draw onto **surfaces**. Only the shell knows about outputs.

```mermaid
flowchart LR
  subgraph Apps
    A1[App A on surface 'mat']
    A2[App B on surface 'wall']
  end
  A1 --> T1[Surface texture: mat]
  A2 --> T2[Surface texture: wall]
  T1 & T2 --> C["Compositor<br/>per output: warp mesh + blend mask + color"]
  C --> O1[Projector 1]
  C --> O2[Projector 2]
```

This is delivered in two stages, both behind the same app contract:

| Stage | How | Supports | Phase |
|---|---|---|---|
| A: CSS mapping | Each app's frame gets a `matrix3d()` transform derived from the surface-to-output homography | One output per surface, flat surfaces, homography only | 1 to 4 |
| B: Texture compositor | Apps render offscreen; the shell composites their textures through warp meshes and blend masks with WebGPU | Multiple projectors per surface, edge blending, irregular surfaces, color and brightness matching | 5 |

Moving from A to B changes nothing for apps, because apps never see output pixels in either stage. Projector-side calibration for Stage B uses structured light (Gray-code patterns) to solve dense projector-to-camera correspondences, which also produces the warp meshes.

## 11. SDK

The SDK is an ES module. It is the only public API for apps, and it is versioned with the protocol.

```ts
import { connect } from '@projectoros/sdk';

const pos = await connect();               // handshake with the broker; receives grant
const surface = pos.surface;                // in the units the manifest chose
console.log(pos.grant.capabilities.hands);  // { rate_hz: 30, latency_ms: 85, provider: 'rgb-landmarks' }

// Pointer-Events-like input from every source.
surface.addEventListener('pointerdown', (e) => {
  // e.pointerType: 'hand' | 'marker' | 'blob' | 'phone' | 'mouse' | 'pen' | 'touch'
  spawn(e.x, e.y, e.pointerType);
});

// Capability streams.
pos.capabilities.markers.addEventListener('update', (e) => {
  // m.family: 'apriltag/36h11' | 'qr' | ...; m.id is a number, or m.payload for payload families
  for (const m of e.markers) placeLabel(m.family, m.id ?? m.payload, m.x, m.y, m.angle);
});

// Tangibles: known objects, with input from a bound device if any.
pos.capabilities.tangibles.addEventListener('keydown', (e) => {
  // e.tangible: { id: 'keyboard-1', x, y, angle }; routed here because the keyboard sits on this app's surface
  typeInto(nearestField(e.tangible.x, e.tangible.y), e.key);
});

// Prediction compensates for measured latency.
const p = pos.capabilities.hands.predict(handId, performance.now());

// Units.
const hitRadius = surface.convert(20, 'mm');

// Phones (companion pages connect with the same SDK on the phone side).
pos.sessions.addEventListener('message', (e) => applyPhoneInput(e.session, e.data));

// Video, only if granted.
if (pos.grant.capabilities.video?.level === 'silhouette') {
  const stream: MediaStream = await pos.capabilities.video.open();
}
```

Design rules:

- Use web-platform shapes: `EventTarget`, Pointer Events semantics, `MediaStream`, promises.
- Everything is typed. Types are generated from the protocol schema (section 14), not hand-written.
- A **simulator** ships with the SDK: apps can be developed in a normal browser with mouse input standing in for hands and markers, and recorded sensor sessions can be replayed. Most app authors will not own a projector rig.

## 12. Networking and phones

### 12.1 Local-first networking

By default the device serves everything on the local network. No internet connection is needed for any part of a core installation.

```mermaid
flowchart LR
  subgraph LAN[Local network]
    D[ProjectorOS device gateway]
    P1[Phone on venue/home Wi-Fi]
    OC[Operator console]
  end
  P1 -- "scan QR, http(s)://device.local or LAN IP" --> D
  OC --> D
  subgraph Optional["Optional extensions"]
    R["Remote access provider<br/>cloudflared, Tailscale, frp, self-hosted relay"]
  end
  P2[Phone on cellular] -.-> R -.-> D
```

### 12.2 Zero-effort phone join

1. The shell projects a QR code (or the operator console shows one) containing the session URL and a short-lived join code.
2. The visitor scans it. The app's **companion page** opens in the phone's browser. No install, no account.
3. The gateway issues an anonymous session token scoped to that app session. It expires when the session ends.
4. Phone input flows phone, gateway, broker, app, with per-session rate limits and size caps. Phones never talk to an app directly.

The companion page is part of the app package, so app authors build both sides of their experience. It is sandboxed by origin like the surface view.

### 12.3 HTTPS without assuming a cloud

Many web APIs (device orientation, camera, service workers, WebAuthn, clipboard) require a secure context. Plain HTTP on a LAN works for basic touch and buttons, but not for those. There is no zero-effort way to get a publicly trusted certificate on a fully offline device, so HTTPS is tiered:

| Mode | How | Phone experience | Needs |
|---|---|---|---|
| Plain local | HTTP on LAN | Works for pointer and button input; no secure-context APIs | Nothing |
| Owner domain | The owner points a domain they control at the device's LAN address; ACME DNS-01 obtains a certificate (renewed while online, usable offline until expiry) | Full HTTPS, zero effort for visitors | A domain, occasional internet |
| Local CA | The device creates its own CA | Visitors must install a certificate, so not zero-effort | Nothing; suited to owner-only devices |
| Optional provider | A future extension, for example a community-run `*.device` naming service in the style of Plex's `plex.direct` | Full HTTPS, zero effort | That provider |

Remote access for cellular phones is an extension with pluggable providers. The core never depends on a specific one.

### 12.4 Audience scale

| Profile | Audience | Transport | Notes |
|---|---|---|---|
| Interactive | 1 to 15 | Local WebSocket; WebRTC DataChannel (unordered) later for high-rate input | Realistic latency 30 to 60 ms from phones; use client prediction. Under 16 ms is not achievable over Wi-Fi. |
| Room | 15 to 100 | Local WebSocket with input throttling and server-side aggregation | Remote participants via a remote-access extension |
| Broadcast | 100 to 10,000+ | Requires an extension: edge aggregation of inputs, and video out via WebRTC (WHEP) | Not part of the core; designed as an extension that uses the same session protocol |

## 13. Extensions

Everything that is optional is an **extension** behind an interface defined by the core. The core ships with a null implementation of each, so no extension is required.

| Extension point | Null default | Example implementations |
|---|---|---|
| Identity | No accounts; the device owner is whoever is at the device | Local accounts, passkeys, OIDC, community identity |
| Policy | Owner's decisions only | Subscription tiers, organization policies |
| Remote access | LAN only | cloudflared, Tailscale, frp, self-hosted relay |
| Certificates | Plain HTTP | ACME with the owner's domain, local CA, naming services |
| App catalogs | Local installs only | Self-hosted catalogs, community index, optional central catalog |
| Payments and licensing | None | Any vendor's licensing service |
| Telemetry | None, ever, by default | Opt-in, self-hostable |
| Capability providers | First-party providers | Third-party sensing plugins, marker families, input and output providers |

This is also the boundary for any future monetization: optional services implement extension interfaces. The open-source core stays complete without them.

## 14. Protocol and process architecture

### 14.1 Protocol first

The protocol between processes, and between the platform and apps, is the most important long-lived artifact. It should be **schema-first**: one source of truth that generates Python (Pydantic), TypeScript and Rust types. This replaces today's hand-mirroring of `server/protocol.py` and `ui/src/types.ts`.

- JSON over WebSocket or `MessagePort` for control messages and events (easy to debug, works in browsers).
- Shared memory for frames, on the same machine.
- A compact binary encoding (for example CBOR or MessagePack) is optional for high-rate streams, negotiated per connection.
- The protocol, the manifest and the scene format each have a version and a compatibility policy.

### 14.2 Languages

| Component | Language now | Later |
|---|---|---|
| Supervisor, broker, capture, gateway | Python | Rust, once the protocol is stable. Reasons: memory safety for the security boundary, single-binary deployment to mini-PCs on three OSes, long unattended uptimes. Not raw speed. |
| Capability workers | Python with OpenCV and ONNX Runtime | Any language; Python stays welcome |
| Shell, operator console, SDK | TypeScript | TypeScript |

Rewrites happen one process at a time, behind the protocol.

### 14.3 Shell and backend boundary

Electron is only the shell: windows, app sandboxes, platform UI and the compositor. It is not the backend, and no Python or Rust runs inside it by default. The backend runs as separate processes in any language, which is how the current Python server and Chromium kiosk already work.

```mermaid
flowchart TB
  SUP["Supervisor<br/>Python now, Rust later"]
  subgraph Backend["Backend processes (any language)"]
    CAPT[Capture service]
    BRK[Broker and gateway]
    WK["Capability workers<br/>Python, Rust, ..."]
  end
  subgraph Electron["Electron shell (TypeScript)"]
    MAIN["Main process<br/>windows, sessions, permissions,<br/>offscreen rendering"]
    REND["App renderers<br/>one sandboxed process per app"]
    NAT["Optional thin native module<br/>(Rust via napi-rs)"]
  end
  SUP -- starts and supervises --> CAPT & BRK & WK
  SUP -- starts and supervises --> MAIN
  MAIN --> REND
  MAIN -- "local WebSocket or Unix socket<br/>(the protocol)" --> BRK
  MAIN -. uses .-> NAT
  NAT -. "reads frames<br/>(video grants only)" .-> CAPT
```

Rules:

- **The supervisor starts Electron, not the other way around.** Electron is one supervised child among the others. This keeps the shell replaceable, lets the backend run headless (for tests, recording sensor sessions and future multi-machine nodes that have no display), and keeps the amount of privileged Node code small.
- **Electron talks to the backend only through the protocol**, over a local WebSocket or Unix domain socket, exactly as the operator console and other clients do.
- **Python cannot be embedded in Electron and does not need to be.** In packaged builds, a self-contained Python runtime (built with PyInstaller, or a `uv`-managed runtime) ships alongside the Electron app as a resource, and the supervisor launches it.
- **Rust has two allowed roles:**
  - Separate backend processes (supervisor, broker, capture) behind the same protocol. This is the main path.
  - Thin native modules in Electron's main process, built with `napi-rs`, only for tasks that must happen inside the shell. A crash in such a module takes the shell down with it, so these stay small, and logic belongs in separate processes.
- **Video is the one boundary that needs a dedicated path.** App renderers cannot read the backend's shared-memory frame bus. When an app is granted `video`, frames reach it as a `MediaStream` through one of two options, to be decided in Phase 4:
  - A thin native module in the main process reads frames from shared memory and forwards them to the app renderer as WebCodecs `VideoFrame`s, which the SDK wraps in a `MediaStreamTrackGenerator`.
  - The capture service publishes a local WebRTC stream that the app renderer receives.

  Everything else that apps receive is small, structured data and travels as protocol messages.

### 14.4 Platform abstraction

macOS-specific code today (camera enumeration via `system_profiler`, displays via JXA `NSScreen`, the Chromium launcher) moves behind interfaces with per-OS backends:

| Concern | macOS | Linux | Windows |
|---|---|---|---|
| Camera capture | AVFoundation | V4L2 / libcamera | Media Foundation |
| Display enumeration | NSScreen | DRM/KMS, X11/Wayland | DXGI |
| Shell launch | Electron | Electron (kiosk session) | Electron |
| Service management | launchd | systemd | Windows service |

## 15. Multi-machine (later)

Some installations need several machines, for example one per wall. The model: one **coordinator** owns the scene and the broker; other nodes run capture, workers and shells, and register with it. The same protocol runs over the network. A message bus with both shared-memory and network transports (Zenoh is a candidate) fits here.

Caveats to carry into that design:

- Clock sync (NTP is usually enough; PTP helps only with hardware-triggered cameras).
- Synchronized output across machines needs genlock-capable GPUs or is approximate.
- Apps spanning machines see one logical surface. The coordinator, not the app, deals with the split.

## 16. Phased plan

Each phase leaves the system usable, keeps the craft-mat app working, and preserves the seams later phases need.

```mermaid
flowchart LR
  P0["Phase 0<br/>Foundations"] --> P1["Phase 1<br/>Platform / app split"]
  P1 --> P2["Phase 2<br/>Cross-platform shell<br/>and hardware tiers"]
  P2 --> P3["Phase 3<br/>Phones and<br/>networking"]
  P2 --> P4["Phase 4<br/>Advanced sensing"]
  P3 --> P5["Phase 5<br/>Multi-surface, multi-projector"]
  P4 --> P5
  P5 --> P6["Phase 6<br/>Ecosystem and<br/>multi-machine"]
```

### Phase 0: Foundations (inside the current codebase)

Goal: fix the things that are cheap now and expensive later.

- Introduce the **scene format** (v1) with surfaces, warp meshes as 2x2 grids, and migration from `calibration.json` and `work_surface.json`.
- **Schema-first protocol**: one schema that generates the Pydantic models and the TypeScript types.
- Carry **capture timestamps** through all events.
- Move detection off the asyncio loop into **worker processes** reading frames from shared memory.
- Add **photon-to-photon latency measurement** to calibration.
- **Marker-family plugin interface** (section 6.4), with ArUco ported as the first plugin and **AprilTag 36h11 added and made the default** ([issue #8](https://github.com/ProjectorOS/projector-os/issues/8)). Namespaced marker identities, family selection in the operator console, printable markers per family, and calibration moved to a reserved AprilTag range.

Exit criteria: the craft mat behaves as today; latency is measured and shown; the protocol types are generated; AprilTag and ArUco objects can be tracked side by side.

### Phase 1: Platform / app split

Goal: the craft mat becomes the first real app.

- First version of the **SDK** (connect, surface and units, markers, hands, pointers, grant).
- First version of the **broker** with manifests and grant negotiation, still in Python.
- **App sandbox** in the existing kiosk: each app in a cross-origin iframe on its own origin, with the shell drawing platform UI above it, and CSS mapping (render stage A).
- **Local app store**: install from a folder or archive, enable or disable, per-app permissions in the operator console.
- Port the craft-mat app to the SDK. Write a second, small sample app to make sure the SDK is not shaped around one app.
- The **simulator** for developing apps without hardware.
- **QR code** marker plugin with payload filters in the manifest.
- **Tangible registry** in the scene: the craft mat's tracked objects become tangibles with footprints, offsets and hotspots.
- **Screen-bound input** through the shell: mouse and touch as `pointers`, the `keyboard` grant, and the reserved platform key combination.

Exit criteria: the craft mat runs as a packaged app through the public SDK only; a third party could build an app from the docs and the simulator.

### Phase 2: Cross-platform shell and hardware tiers

Goal: run on mini-PCs and Linux, not just a Mac.

- **Electron shell** replaces the Chromium kiosk; per-app renderer processes and sessions.
- **Platform abstraction** for cameras, displays and services on macOS and Linux (Windows when there is demand).
- **Hardware profiling** at startup; ONNX Runtime with per-platform execution providers; graceful degradation of grants.
- **Supervisor** with auto-start, health checks and restarts; reproducible packaging (installer on macOS, package or image on Linux).
- Resource governance: watchdogs, frame-time monitoring, rate caps.
- **Continuous calibration**: physical reference markers plus projected checks detect camera, projector and surface drift; small drift is corrected automatically, large drift alerts the operator.
- **Input providers** in the backend: gamepads and MIDI as `controls`; device-to-app and device-to-player assignment in the operator console.

Exit criteria: the same apps run on an N100 mini-PC and a Mac, with different grants, unattended for days.

### Phase 3: Phones and networking

Goal: zero-effort phone participation.

- Companion pages in app packages; QR join; anonymous session tokens; gateway rate limiting.
- Phone pointers merged into the `pointers` capability.
- HTTPS modes from section 12.3: plain local and owner domain first.
- First remote-access extension (one provider, behind the generic interface).

Exit criteria: a visitor joins from a phone by scanning a QR code with no install; optionally, from cellular through an extension.

### Phase 4: Advanced sensing

Goal: reliable interaction on any surface and in any lighting.

- IR camera support; `touch` and IR-based `presence` providers.
- Stereo/depth providers; 3D `pose` in the world frame.
- Graded `video` grants delivered as `MediaStream`, with the console indicator.
- Camera intrinsics calibration; multiple cameras observing one surface, fused in the broker.
- Optional: projected-image subtraction for RGB cameras.
- **Tracked devices**: input provider backends (`bridge-usb`, `bridge-net`, and `seize` as the software fallback), camera and HID fusion for tracked mice, projected mouse and keyboard tips, location-based focus for tracked keyboards, binding by motion correlation and prompts, phones bound by an on-screen marker.
- **Input bridge sub-project** (open hardware): RP2040 USB bridge firmware first, then an ESP32 wireless bridge; build guide and supported-device list.
- More input providers (serial, OSC, BLE) and raw-device grants.
- More marker families as plugins: ARToolKit, ARTag if a usable detector is available, IR-only markers.

Exit criteria: a touch app works over changing projected content on IR-equipped hardware, and is cleanly refused on RGB-only hardware.

### Phase 5: Multi-surface and multi-projector

Goal: the "someday" features, without changing the app contract.

- Technical spike first: Electron offscreen rendering with shared textures, measured on each hardware tier.
- **Texture compositor** (render stage B) with warp meshes and blend masks in WebGPU.
- **Structured-light calibration** for dense warps, multi-projector overlap, and irregular surfaces.
- Several named surfaces in one scene; apps assigned per surface by the operator.
- Brightness and color matching across projectors.

Exit criteria: one app spans two edge-blended projectors on a non-flat surface, unchanged from its single-projector version.

### Phase 6: Ecosystem and multi-machine

- App catalogs as extensions; package signing; owner policies requiring signatures.
- Third-party capability providers, marker families and input providers, with worker isolation.
- **Output providers**: lights, sound, relays, haptics.
- Optional extensions: identity, policy tiers, payments, broadcast-scale audiences.
- Multi-machine coordinator model.
- Rust rewrites of the supervisor, broker and capture service, where packaging or reliability shows the need.

## 17. Risks and open questions

| Risk or question | Mitigation or next step |
|---|---|
| Electron offscreen rendering may not meet frame-rate or latency targets on light hardware | Spike before Phase 5; stage A remains the fallback for single-projector setups |
| A schema-first protocol adds tooling friction early | Keep the generator simple; JSON Schema or a small IDL with codegen |
| Hand and pose quality on RGB under projected light | Report quality in grants; make IR the recommended path for body interaction |
| Visitor abuse via phones (spam, floods) | Session-scoped anonymous tokens, rate limits, operator kick and lock controls |
| App authors without hardware | Simulator and recorded sensor sessions from Phase 1 |
| Biometric data in non-home settings | Out of scope for the first, home-only phase; on-device processing and graded video grants keep the door open |
| Keeping tracked devices away from the OS | Input bridges make it work the same on every OS with no drivers or permissions; software seizing remains a fallback on Linux and macOS |
| Bridges are extra hardware per tracked device | Keep them cheap (about $5 to $15 in parts), publish firmware and build guides, and keep the software fallback |
| Some devices need high-speed USB, or poll faster than the bridge forwards | Rare for mice and keyboards; document supported devices; Teensy-class bridges for edge cases |
| Off-the-shelf devices with marker stickers vs custom hardware | Input bridges give off-the-shelf devices a built-in identity, so stickers plus bridges are the baseline. Custom hardware with IR LEDs could still improve tracking; the tangible model supports both |
| Too many enabled marker families slow detection on light hardware | Run only families needed by running apps; per-family rates and regions; cost hints in the hardware profile |
| Governance of the open-source project as extensions and catalogs appear | Define the extension interfaces and their stability policy before any central service exists |

## Appendix: from today's code to the target

| Today | Becomes |
|---|---|
| `server/main.py` mode state machine and run loop | Supervisor, broker and gateway; the frame loop moves into the capture service and workers |
| `server/camera.py` | Capture service |
| `server/cameras.py`, `server/displays.py`, `server/launcher.py` | Platform abstraction, macOS backend |
| `server/detection.py` (ArUco, MediaPipe hands) | `markers` worker with the ArUco marker-family plugin; `hands` capability worker |
| `server/calibration.py`, `data/calibration.json`, `data/work_surface.json` | Scene store and calibration tools; the work surface becomes a surface's usable region |
| `server/protocol.py`, `ui/src/types.ts` | Generated from the protocol schema |
| `ui/src/projector/` | Shell: platform overlays, calibration patterns, surface mapping |
| Tracked-object overlays, hand overlay, glue logic | The craft-mat app (overlays); tracked objects become entries in the tangible registry; glue and occlusion handling move into broker-side tangible tracking |
| `ui/index.html` control panel | Operator console |
| `/markers/{id}.png` endpoint | `/markers/{family}/{id}.png`, rendered by marker-family plugins |
