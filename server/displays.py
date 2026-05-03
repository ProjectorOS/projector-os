"""macOS display enumeration.

Lists every connected display (via NSScreen, called through osascript JXA so we don't
need PyObjC), and converts each frame from Cocoa coordinates (Y-up, origin at the main
display's bottom-left) to Quartz coordinates (Y-down, origin at the main display's
top-left) — which is the form Chromium's --window-position expects.
"""

from __future__ import annotations

import json
import logging
import subprocess
from dataclasses import dataclass

log = logging.getLogger(__name__)

JXA = """
ObjC.import("AppKit");
var screens = $.NSScreen.screens;
var mainHeight = $.NSScreen.mainScreen.frame.size.height;
var out = [];
for (var i = 0; i < screens.count; i++) {
  var s = screens.objectAtIndex(i);
  var f = s.frame;
  var name = "Display " + (i + 1);
  if (s.respondsToSelector("localizedName")) name = ObjC.unwrap(s.localizedName);
  out.push({
    i: i,
    name: name,
    cocoa_x: f.origin.x,
    cocoa_y: f.origin.y,
    w: f.size.width,
    h: f.size.height,
    is_main: (f.origin.x === 0 && f.origin.y === 0)
  });
}
JSON.stringify({mainHeight: mainHeight, displays: out});
"""


@dataclass
class Display:
    index: int
    name: str
    x: int
    y: int
    width: int
    height: int
    is_main: bool

    def to_dict(self) -> dict:
        return {
            "index": self.index,
            "name": self.name,
            "x": self.x,
            "y": self.y,
            "width": self.width,
            "height": self.height,
            "is_main": self.is_main,
        }


def list_displays() -> list[Display]:
    try:
        res = subprocess.run(
            ["osascript", "-l", "JavaScript", "-e", JXA],
            capture_output=True,
            text=True,
            check=True,
            timeout=5,
        )
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError) as e:
        log.warning("display enumeration failed: %s", e)
        return []

    data = json.loads(res.stdout)
    main_height = float(data["mainHeight"])
    out: list[Display] = []
    for d in data["displays"]:
        # Cocoa Y-up (origin at main bottom-left) → Quartz Y-down (origin at main top-left).
        quartz_y = main_height - d["cocoa_y"] - d["h"]
        out.append(
            Display(
                index=int(d["i"]),
                name=str(d["name"]),
                x=int(d["cocoa_x"]),
                y=int(quartz_y),
                width=int(d["w"]),
                height=int(d["h"]),
                is_main=bool(d["is_main"]),
            )
        )
    return out
