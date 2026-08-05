#!/usr/bin/env python3
"""Build the 'clawd-outlaw' user theme: Clawd + pixel cowboy hat + toggleable
cigarette, in his own blocky 15x16 rect style.

Reads the built-in clawd theme + SVGs from the app bundle, injects accessories,
writes to {userData}/themes/clawd-outlaw/. Rerun any time (idempotent).
"""
import json
import os
import re
import shutil

APP = "/Applications/Clawd on Desk.app/Contents/Resources"
SVG_SRC = os.path.join(APP, "app.asar.unpacked")  # not where svgs live; see below
ASAR_SVG = "/private/tmp/claude-501/-Users-anthony/368ed308-5713-49f1-87d6-2886eb11e8f9/scratchpad/clawd-asar/assets/svg"
THEME_SRC = os.path.join(APP, "app.asar.unpacked/themes/clawd/theme.json")
OUT = os.path.expanduser("~/Library/Application Support/clawd-on-desk/themes/clawd-outlaw")

# Sprites where the hat comes OFF (asleep = hat rests for the night;
# anything already on his head wins — one thing on the head at a time:
# building = his own hard hat, carrying = box hoisted overhead)
SLEEP = {"clawd-sleeping.svg", "clawd-mini-sleep.svg", "clawd-mini-enter-sleep.svg"}
HEADGEAR = {"clawd-working-building.svg", "clawd-working-carrying.svg"}
NO_HAT = SLEEP | HEADGEAR
# Sprites too small / wrong pose for the cigarette (building keeps smoking)
NO_CIG = SLEEP | {
    "clawd-error.svg",
    "clawd-mini-alert.svg", "clawd-mini-crabwalk.svg", "clawd-mini-enter.svg",
    "clawd-mini-happy.svg", "clawd-mini-idle.svg", "clawd-mini-peek.svg",
    "clawd-mini-typing.svg",
}

# Standard pose torso: x=2 y=6 w=11 h=7  (hat sits on top, cig at the mouth)
TORSO_STD = re.compile(r'(<rect[^>]*x="2"[^>]*y="6"[^>]*width="11"[^>]*height="7"[^>]*/>)')
# Error squash pose torso: x=1 y=10 w=13 h=5
TORSO_SQUASH = re.compile(r'(<rect[^>]*x="1"[^>]*y="10"[^>]*width="13"[^>]*height="5"[^>]*/>)')

HAT_STD = (
    '<g class="od-hat">'
    '<rect x="-1" y="4" width="1" height="1" fill="#A5682A"/>'   # brim tip, curled up
    '<rect x="15" y="4" width="1" height="1" fill="#A5682A"/>'   # brim tip, curled up
    '<rect x="0" y="5" width="15" height="1" fill="#A5682A"/>'   # brim, overhangs the body
    '<rect x="3" y="2" width="9" height="3" fill="#A5682A"/>'    # crown body
    '<rect x="3" y="1" width="3" height="1" fill="#A5682A"/>'    # crown bump L
    '<rect x="9" y="1" width="3" height="1" fill="#A5682A"/>'    # crown bump R (crease dip between)
    '<rect x="3" y="4" width="9" height="1" fill="#6B3E1D"/>'    # band
    '</g>'
)
HAT_SQUASH = (
    '<g class="od-hat">'
    '<rect x="-1" y="8" width="1" height="1" fill="#A5682A"/>'
    '<rect x="15" y="8" width="1" height="1" fill="#A5682A"/>'
    '<rect x="0" y="9" width="15" height="1" fill="#A5682A"/>'
    '<rect x="3" y="6" width="9" height="3" fill="#A5682A"/>'
    '<rect x="3" y="5" width="3" height="1" fill="#A5682A"/>'
    '<rect x="9" y="5" width="3" height="1" fill="#A5682A"/>'
    '<rect x="3" y="8" width="9" height="1" fill="#6B3E1D"/>'
    '</g>'
)
CIG = (
    '<g class="od-cig" style="display:inline">'
    '<rect x="12" y="11" width="3" height="1" fill="#EDEDE3"/>'
    '<rect x="14.4" y="11" width="0.6" height="1" fill="#FF8C00" class="od-ember"/>'
    '<rect x="14" y="9.4" width="0.8" height="0.8" fill="#9E9E9E" class="od-smoke od-s1"/>'
    '<rect x="14.2" y="7.4" width="0.7" height="0.7" fill="#B0B0B0" class="od-smoke od-s2"/>'
    '<rect x="13.8" y="5.4" width="0.6" height="0.6" fill="#C4C4C4" class="od-smoke od-s3"/>'
    '</g>'
)
CIG_CSS = (
    "<style>"
    ".od-ember{animation:od-ember 1.6s infinite ease-in-out}"
    "@keyframes od-ember{0%,100%{opacity:.55}50%{opacity:1}}"
    ".od-smoke{opacity:0}"
    ".od-s1{animation:od-rise 3s infinite linear}"
    ".od-s2{animation:od-rise 3s infinite linear;animation-delay:1s}"
    ".od-s3{animation:od-rise 3s infinite linear;animation-delay:2s}"
    "@keyframes od-rise{0%{transform:translate(0,1.5px);opacity:0}25%{opacity:.8}"
    "100%{transform:translate(1px,-4px);opacity:0}}"
    "</style>"
)

os.makedirs(os.path.join(OUT, "assets"), exist_ok=True)

theme = json.load(open(THEME_SRC))
files = set()


def walk(o):
    if isinstance(o, str) and o.endswith(".svg"):
        files.add(o)
    elif isinstance(o, list):
        for x in o:
            walk(x)
    elif isinstance(o, dict):
        for v in o.values():
            walk(v)


walk(theme)

report = {"hat": [], "cig": [], "plain": []}
for f in sorted(files):
    src = os.path.join(ASAR_SVG, f)
    svg = open(src).read()
    touched = False
    if f not in NO_HAT:
        if TORSO_STD.search(svg):
            svg = TORSO_STD.sub(r"\1" + HAT_STD, svg)
            touched = True
        elif TORSO_SQUASH.search(svg):
            svg = TORSO_SQUASH.sub(r"\1" + HAT_SQUASH, svg)
            touched = True
        if touched:
            report["hat"].append(f)
    if f not in NO_CIG and TORSO_STD.search(svg.replace(HAT_STD, "")):
        # cig only on standard pose; append inside same parent right after hat/torso
        if HAT_STD in svg:
            svg = svg.replace(HAT_STD, HAT_STD + CIG)
        else:
            svg = TORSO_STD.sub(r"\1" + CIG, svg, count=1)
        svg = svg.replace("</svg>", CIG_CSS + "</svg>", 1)
        report["cig"].append(f)
    if not touched:
        report["plain"].append(f)
    open(os.path.join(OUT, "assets", f), "w").write(svg)

# copy sounds referenced by theme? clawd theme uses default sounds from app; leave.

theme["name"] = "Clawd Outlaw"
theme["author"] = "Anthony + Oscar"
theme["description"] = "Clawd with a cowboy hat and a bad habit. Same pixel crab, more Westworld."
theme.pop("repo", None)
# bender: bored -> drink + smoke -> pass out (joins the random idle pool)
theme.setdefault("idleAnimations", []).append(
    {"file": "clawd-outlaw-bender.svg", "duration": 15000}
)
json.dump(theme, open(os.path.join(OUT, "theme.json"), "w"), indent=2)

print("hat on :", len(report["hat"]), "files")
print("cig on :", len(report["cig"]), "files")
print("plain  :", report["plain"])
