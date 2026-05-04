# Contributing to ProjectorOS

Thanks for your interest. ProjectorOS is a small project at this stage, so this guide is intentionally short.

## Before you start

- **Platform:** development currently targets macOS only. Display enumeration uses JXA + NSScreen, camera enumeration uses `system_profiler`, and the projector kiosk is launched via Chromium subprocess. Linux/Windows ports are welcome but the relevant code in `server/displays.py`, `server/cameras.py`, and `server/launcher.py` will need real work, not just a flag.
- **Hardware to actually test changes:** anything that touches the frame loop, calibration, projection geometry, or hand/marker tracking needs a real projector + camera setup. Synthetic tests can verify math but not feel.
- **Read [AGENTS.md](AGENTS.md):** it captures conventions and the load-bearing patterns that aren't obvious from the code (SVG-first rendering, surgical DOM updates in the control panel, coordinate spaces, ArUco quiet zones). Read it before opening a non-trivial PR.

## Setup

Follow [README.md](README.md) for first-time setup (`pip install -r requirements.txt`, `npm install`, optional MediaPipe model download).

To run the full stack:

```bash
./scripts/start.sh
```

To run halves separately during UI work:

```bash
.venv/bin/python -m server.main           # http://127.0.0.1:8000
cd ui && npm run dev                       # http://127.0.0.1:5173
```

## Workflow

1. **Branch from `main`.** Use a short, descriptive branch name (`hand-detection`, `marker-finger-glue`, `default-track-mode`).
2. **Keep PRs focused.** One feature or fix per PR. If you find unrelated cleanup along the way, open a separate PR.
3. **Commits explain the *why*.** Subject line is what changed; body should answer why and what subtle tradeoffs were considered. Don't restate what `git diff` already shows.
4. **Squash-merge** is the project default. PR titles become commit messages on `main`, so write them well.
5. **Update [AGENTS.md](AGENTS.md)** when you introduce a new convention or a non-obvious gotcha that future contributors (human or AI) would benefit from knowing.

## Code conventions

- Match the surrounding code. The repo is small enough that consistency matters more than personal preference.
- **No emojis** in code or generated files unless they're explicitly part of the user-facing UI.
- **Comments:** explain *why*, not *what*. Most code doesn't need any. The existing comments in `ui/src/overlay.ts` and `server/main.py` are reference-quality examples.
- **Pydantic v2** for all server protocol types. When you add an event or command, mirror it by hand in `ui/src/types.ts` and update both unions.
- **SVG first** for projector overlays. Canvas only when SVG genuinely cannot do it.
- **Coordinate discipline.** Compute geometry in `mat_mm` and transform to `projector_px` at the render boundary. Don't bake projector pixels into intermediate math.

## Testing

Before opening a PR:

- **UI:** `cd ui && npx tsc -b` (or `npm run build`) — must be clean.
- **Server:** `.venv/bin/python -m py_compile server/*.py` — quick syntax check; for substantive changes, run the actual stack.
- **End-to-end:** for changes that touch the frame loop, calibration, hand detection, or marker tracking — restart `./scripts/start.sh`, calibrate if needed, and exercise the feature on the real rig.

State the manual test plan in the PR body. CI is intentionally minimal at this stage and the burden of correctness is on the contributor.

## Licensing

By contributing, you agree that your contributions will be licensed under the [Apache License 2.0](LICENSE), the same license as the rest of the project. This is the standard "inbound = outbound" arrangement; no separate CLA.

## Reporting issues

Open a GitHub issue with:

- What you saw vs. what you expected.
- Steps to reproduce, including hardware (projector model, camera model, macOS version) when the bug touches CV or projection.
- Relevant log output from the server console.

Bugs that only reproduce on a real rig are still worth filing — note the hardware specifics so someone with similar gear can pick it up.
