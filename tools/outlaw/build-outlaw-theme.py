#!/usr/bin/env python3
"""Build the 'clawd-outlaw' user theme: Clawd + pixel cowboy hat + toggleable
cigarette (SMIL-animated smoke/ember), in his own blocky 15x16 rect style.

Reads the built-in clawd SVG sources from the repo (assets/svg + the clawd
theme manifest), injects the accessories, and writes the result into the
repo's themes/clawd-outlaw/ so the committed sprites are reproducible:
running this script must be byte-idempotent over the committed output.

    python3 tools/outlaw/build-outlaw-theme.py            # rebuild in-repo
    python3 tools/outlaw/build-outlaw-theme.py --deploy   # also copy to the
                                                          # live user theme dir

Animations are SMIL (<animate>/<animateTransform>), never CSS keyframes:
sprites can be rendered through an <img> channel, where Chromium does not run
CSS animations inside the SVG document; SMIL runs in <img>, <object>, and
inline alike.
"""
import json
import os
import re
import shutil
import sys

REPO = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
SVG_SRC = os.path.join(REPO, "assets", "svg")
THEME_SRC = os.path.join(REPO, "themes", "clawd", "theme.json")
OUT = os.path.join(REPO, "themes", "clawd-outlaw")
DEPLOY = os.path.expanduser(
    "~/Library/Application Support/clawd-on-desk/themes/clawd-outlaw")

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
# Smoke + ember animate via SMIL, not CSS: the app can display sprites through
# an <img> channel, and Chromium never runs CSS keyframe animations inside an
# SVG loaded as an image (the original CSS smoke was invisible for exactly this
# reason). SMIL runs in <img>, <object>, and inline alike. calcMode=discrete
# keeps the pixel-art stepping; negative begin offsets stagger the puffs so the
# column is alive on the first frame.
def _puff(size, fill, begin):
    return (
        f'<rect x="15" y="10" width="{size}" height="{size}" fill="{fill}" opacity="0" class="od-smoke">'
        f'<animate attributeName="opacity" values="0;0.85;0.8;0.5;0" keyTimes="0;0.12;0.55;0.85;1" '
        f'dur="2.7s" begin="{begin}" repeatCount="indefinite"/>'
        f'<animateTransform attributeName="transform" type="translate" calcMode="discrete" '
        f'values="0 0;0.2 -1.2;-0.3 -2.4;0.5 -3.6;0 -4.8;0.7 -6" '
        f'dur="2.7s" begin="{begin}" repeatCount="indefinite"/>'
        f'</rect>'
    )

CIG = (
    '<g class="od-cig" style="display:inline">'
    '<rect x="12" y="11" width="3" height="1" fill="#EDEDE3"/>'
    '<rect x="15" y="11" width="1" height="1" fill="#FF5A00" class="od-ember">'
    '<animate attributeName="fill" values="#E03A00;#FF7A1A;#E03A00" dur="1.6s" repeatCount="indefinite"/>'
    '<animate attributeName="opacity" values="0.85;1;0.85" dur="1.6s" repeatCount="indefinite"/>'
    '</rect>'
    + _puff("0.9", "#9E9E9E", "-0.2s")
    + _puff("0.8", "#B0B0B0", "-1.1s")
    + _puff("0.7", "#C4C4C4", "-2.0s")
    + '</g>'
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

# Accessories must only be injected into RENDERED geometry. Some sprites
# repeat the torso rect inside <clipPath>/<defs> (e.g. clawd-idle-reading's
# inside-torso clip); clipPath children contribute clip GEOMETRY regardless of
# paint, so injecting there distorts the clip region. Mask those spans out,
# transform the rest, restore.
MASKED = re.compile(r"<(clipPath|defs)\b.*?</\1>", re.S)


def inject_outside_masks(svg, transform):
    spans = [m.span() for m in MASKED.finditer(svg)]
    if not spans:
        return transform(svg)
    out, pos, parts = [], 0, []
    for a, b in spans:
        parts.append(("open", svg[pos:a]))
        parts.append(("masked", svg[a:b]))
        pos = b
    parts.append(("open", svg[pos:]))
    return "".join(transform(t) if kind == "open" else t for kind, t in parts)


report = {"hat": [], "cig": [], "plain": []}
for f in sorted(files):
    src = os.path.join(SVG_SRC, f)
    svg = open(src).read()
    touched = False
    if f not in NO_HAT:
        if TORSO_STD.search(svg):
            svg = inject_outside_masks(
                svg, lambda t: TORSO_STD.sub(r"\1" + HAT_STD, t, count=1))
            touched = True
        elif TORSO_SQUASH.search(svg):
            svg = inject_outside_masks(
                svg, lambda t: TORSO_SQUASH.sub(r"\1" + HAT_SQUASH, t, count=1))
            touched = True
        if touched:
            report["hat"].append(f)
    if f not in NO_CIG and TORSO_STD.search(svg.replace(HAT_STD, "")):
        # cig only on standard pose; append right after the hat (or torso)
        if HAT_STD in svg:
            svg = svg.replace(HAT_STD, HAT_STD + CIG, 1)
        else:
            svg = inject_outside_masks(
                svg, lambda t: TORSO_STD.sub(r"\1" + CIG, t, count=1))
        report["cig"].append(f)
        touched = True
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

if "--deploy" in sys.argv:
    shutil.copytree(OUT, DEPLOY, dirs_exist_ok=True)
    print("deployed to", DEPLOY)
