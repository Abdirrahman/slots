"""Procedurally build, export, render, and validate the complete toy-car set.

Each car is a moulded toy slot car: a lofted body with wheel arches, a tinted canopy, a
guide blade and braids under the nose, emissive lamps, and a raised roof glyph that
identifies its Racer without relying on colour. Authoring axes are X width, Y length, Z up,
with the front of the car at -Y; glTF export converts that to the game's +Z-forward frame.
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path
from typing import Any

import bpy
from mathutils import Vector

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parents[1]
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from car_shapes import (
    body,
    box_shell,
    interpolate_station,
    loft,
    station_section,
    multi_solid,
    prism,
    revolved_shell,
    ring_shell,
    rounded_box,
    surface_ribbon,
    swept_arc,
    tinted_shell,
)
from materials import principled_material
from render_cards import render_card

MODEL_DIR = PROJECT_ROOT / "public" / "assets" / "models"
CARD_DIR = PROJECT_ROOT / "public" / "assets" / "cards"
SOURCE_DIR = PROJECT_ROOT / "blender" / "source"
REPORT_PATH = PROJECT_ROOT / "blender" / "asset-report.json"
TRIANGLE_BUDGET = 7_000
LANE_SPACING = 1.35

# The fender swells the body out to just inside the tyre's outer face, so the tyre sidewall
# stays the widest part of the car by this much and catches its own highlight.
ARCH_TYRE_CLEARANCE = 0.012
# Length over which a haunch fades back into the authored body profile.
HAUNCH_SPAN_Y = 0.34
# Extra length samples inserted around each axle so the flare is smooth.
HAUNCH_SAMPLE_OFFSETS = (-0.30, -0.16, 0.0, 0.16, 0.30)
# Livery stripes run in pairs either side of the centre line.
LIVERY_STRIPE_X = 0.145
LIVERY_STRIPE_WIDTH = 0.105
MIN_LIVERY_RUN = 0.14
# Fraction of the canopy's height that is body-coloured roof rather than glass, and how
# far the glyph stands off that roof before its edges sink into the dome.
ROOF_BAND = 0.40
GLYPH_THICKNESS = 0.03
GLYPH_RELIEF = 0.006
GLYPH_SCALE = 1.40

WHEEL_NAMES = ("wheel-front-left", "wheel-front-right", "wheel-rear-left", "wheel-rear-right")

CAR_SPECS: tuple[dict[str, Any], ...] = (
    {
        # Club racer: the approachable coupe, upright cabin and a plain hood stripe.
        "id": "toy-car-starter",
        "style": "coupe",
        "colour": (0.86, 0.13, 0.10, 1.0),
        "accent": (0.97, 0.93, 0.88, 1.0),
        "glyph": {"sides": 24, "radius": 0.115, "turn": 0.0},
        "wheels": {"radius": 0.275, "width": 0.215, "track": 1.00, "front": -0.66, "rear": 0.70},
        "stations": (
            {"y": -1.030, "half_width": 0.2585, "bottom": 0.150, "top": 0.315, "squareness": 2.6},
            {"y": -0.880, "half_width": 0.3872, "bottom": 0.115, "top": 0.395, "squareness": 2.9},
            {"y": -0.620, "half_width": 0.4488, "bottom": 0.100, "top": 0.470, "tumble": 0.06},
            {"y": -0.250, "half_width": 0.4675, "bottom": 0.095, "top": 0.520, "tumble": 0.08},
            {"y": 0.180, "half_width": 0.4708, "bottom": 0.095, "top": 0.530, "tumble": 0.08},
            {"y": 0.600, "half_width": 0.4598, "bottom": 0.100, "top": 0.515, "tumble": 0.07},
            {"y": 0.900, "half_width": 0.396, "bottom": 0.120, "top": 0.470, "squareness": 2.9},
            {"y": 1.045, "half_width": 0.275, "bottom": 0.160, "top": 0.400, "squareness": 2.6},
        ),
        "canopy": (
            {"y": -0.330, "half_width": 0.33, "bottom": 0.470, "top": 0.560, "tumble": 0.10},
            {"y": -0.120, "half_width": 0.3872, "bottom": 0.480, "top": 0.780, "tumble": 0.22},
            {"y": 0.220, "half_width": 0.396, "bottom": 0.480, "top": 0.820, "tumble": 0.22},
            {"y": 0.560, "half_width": 0.374, "bottom": 0.480, "top": 0.755, "tumble": 0.20},
            {"y": 0.760, "half_width": 0.308, "bottom": 0.470, "top": 0.560, "tumble": 0.10},
        ),
        "roof": {"y": 0.20, "length": 0.60, "half_width": 0.262, "top": 0.828},
    },
    {
        # Track weapon: long wedge nose, low canopy, and a high rear wing.
        "id": "toy-car-sport",
        "style": "wedge",
        "colour": (0.07, 0.38, 0.92, 1.0),
        "accent": (1.00, 0.82, 0.13, 1.0),
        "glyph": {"sides": 3, "radius": 0.145, "turn": math.pi / 2},
        "wheels": {"radius": 0.255, "width": 0.235, "track": 1.00, "front": -0.72, "rear": 0.74},
        "stations": (
            {"y": -1.120, "half_width": 0.33, "bottom": 0.055, "top": 0.150, "squareness": 2.4},
            {"y": -0.960, "half_width": 0.4092, "bottom": 0.070, "top": 0.240, "squareness": 2.7},
            {"y": -0.700, "half_width": 0.451, "bottom": 0.085, "top": 0.360, "tumble": 0.10},
            {"y": -0.300, "half_width": 0.473, "bottom": 0.085, "top": 0.430, "tumble": 0.14},
            {"y": 0.150, "half_width": 0.4752, "bottom": 0.085, "top": 0.450, "tumble": 0.14},
            {"y": 0.560, "half_width": 0.4675, "bottom": 0.090, "top": 0.440, "tumble": 0.12},
            {"y": 0.880, "half_width": 0.418, "bottom": 0.105, "top": 0.410, "squareness": 2.8},
            {"y": 1.055, "half_width": 0.308, "bottom": 0.130, "top": 0.360, "squareness": 2.5},
        ),
        "canopy": (
            {"y": -0.420, "half_width": 0.319, "bottom": 0.380, "top": 0.440, "tumble": 0.12},
            {"y": -0.180, "half_width": 0.363, "bottom": 0.390, "top": 0.640, "tumble": 0.26},
            {"y": 0.160, "half_width": 0.3696, "bottom": 0.395, "top": 0.680, "tumble": 0.26},
            {"y": 0.470, "half_width": 0.352, "bottom": 0.395, "top": 0.600, "tumble": 0.22},
            {"y": 0.660, "half_width": 0.275, "bottom": 0.390, "top": 0.470, "tumble": 0.12},
        ),
        "roof": {"y": 0.16, "length": 0.50, "half_width": 0.232, "top": 0.686},
    },
    {
        # Bench buggy: raised ride height, fat tyres, exposed roll cage.
        "id": "toy-car-offroad",
        "style": "buggy",
        "colour": (0.16, 0.66, 0.24, 1.0),
        "accent": (0.10, 0.11, 0.13, 1.0),
        "glyph": {"sides": 4, "radius": 0.135, "turn": math.pi / 4},
        "wheels": {"radius": 0.345, "width": 0.265, "track": 1.00, "front": -0.635, "rear": 0.675},
        "stations": (
            {"y": -0.960, "half_width": 0.2805, "bottom": 0.320, "top": 0.470, "squareness": 2.6},
            {"y": -0.820, "half_width": 0.3795, "bottom": 0.290, "top": 0.545, "squareness": 3.0},
            {"y": -0.560, "half_width": 0.4345, "bottom": 0.270, "top": 0.610, "squareness": 3.4},
            {"y": -0.200, "half_width": 0.4532, "bottom": 0.265, "top": 0.650, "squareness": 3.6},
            {"y": 0.220, "half_width": 0.4565, "bottom": 0.265, "top": 0.660, "squareness": 3.6},
            {"y": 0.580, "half_width": 0.4455, "bottom": 0.270, "top": 0.640, "squareness": 3.4},
            {"y": 0.870, "half_width": 0.385, "bottom": 0.295, "top": 0.590, "squareness": 3.0},
            {"y": 1.000, "half_width": 0.275, "bottom": 0.330, "top": 0.520, "squareness": 2.6},
        ),
        "canopy": (
            {"y": -0.280, "half_width": 0.33, "bottom": 0.600, "top": 0.700, "tumble": 0.10},
            {"y": -0.060, "half_width": 0.3795, "bottom": 0.610, "top": 0.930, "tumble": 0.18},
            {"y": 0.300, "half_width": 0.385, "bottom": 0.610, "top": 0.960, "tumble": 0.18},
            {"y": 0.560, "half_width": 0.363, "bottom": 0.605, "top": 0.900, "tumble": 0.16},
            {"y": 0.720, "half_width": 0.3025, "bottom": 0.600, "top": 0.700, "tumble": 0.10},
        ),
        "roof": {"y": 0.24, "length": 0.58, "half_width": 0.272, "top": 0.968},
    },
    {
        # Bench van: tall boxy shell, roof rack, and a friendly blunt nose.
        "id": "toy-car-family",
        "style": "van",
        "colour": (0.98, 0.63, 0.06, 1.0),
        "accent": (0.10, 0.30, 0.55, 1.0),
        "glyph": {"sides": 4, "radius": 0.125, "turn": 0.0, "cross": True},
        "wheels": {"radius": 0.265, "width": 0.215, "track": 1.00, "front": -0.68, "rear": 0.715},
        "stations": (
            {"y": -1.040, "half_width": 0.297, "bottom": 0.150, "top": 0.430, "squareness": 2.8},
            {"y": -0.900, "half_width": 0.4015, "bottom": 0.120, "top": 0.520, "squareness": 3.2},
            {"y": -0.640, "half_width": 0.4565, "bottom": 0.105, "top": 0.580, "squareness": 3.6},
            {"y": -0.250, "half_width": 0.4752, "bottom": 0.100, "top": 0.610, "squareness": 3.8},
            {"y": 0.220, "half_width": 0.4785, "bottom": 0.100, "top": 0.620, "squareness": 3.8},
            {"y": 0.640, "half_width": 0.473, "bottom": 0.105, "top": 0.615, "squareness": 3.6},
            {"y": 0.940, "half_width": 0.429, "bottom": 0.125, "top": 0.580, "squareness": 3.2},
            {"y": 1.075, "half_width": 0.3135, "bottom": 0.160, "top": 0.500, "squareness": 2.8},
        ),
        "canopy": (
            {"y": -0.560, "half_width": 0.363, "bottom": 0.540, "top": 0.640, "tumble": 0.10},
            {"y": -0.380, "half_width": 0.429, "bottom": 0.560, "top": 0.960, "tumble": 0.14},
            {"y": 0.200, "half_width": 0.4378, "bottom": 0.560, "top": 1.000, "tumble": 0.14},
            {"y": 0.760, "half_width": 0.429, "bottom": 0.560, "top": 0.985, "tumble": 0.14},
            {"y": 0.930, "half_width": 0.352, "bottom": 0.545, "top": 0.870, "tumble": 0.10},
        ),
        "roof": {"y": 0.46, "length": 1.18, "half_width": 0.320, "top": 1.004},
    },
)


def reset_scene() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    bpy.context.preferences.filepaths.save_version = 0
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0
    scene.render.fps = 30


def car_materials(spec: dict[str, Any]) -> dict[str, bpy.types.Material]:
    asset_id = spec["id"]
    return {
        "body": principled_material(f"mat-{asset_id}-body", spec["colour"], roughness=0.24, metallic=0.05),
        "accent": principled_material(f"mat-{asset_id}-accent", spec["accent"], roughness=0.3),
        # A near-black canopy reads as a hole in the body at race distance, so the glass is
        # a light smoked tint and the body carries a surround and pillars around it.
        "glass": principled_material(f"mat-{asset_id}-glass", (0.15, 0.23, 0.31, 1.0), roughness=0.09, metallic=0.35),
        "tyre": principled_material(f"mat-{asset_id}-tyres", (0.045, 0.048, 0.054, 1.0), roughness=0.82),
        # The rim is a dark turned metal covering less of the wheel face, so the tyre keeps
        # the silhouette instead of the wheel reading as a pale blob down the straight.
        "rim": principled_material(f"mat-{asset_id}-rims", (0.34, 0.36, 0.40, 1.0), roughness=0.34, metallic=0.55),
        "hub": principled_material(f"mat-{asset_id}-hubs", (0.16, 0.17, 0.19, 1.0), roughness=0.4, metallic=0.3),
        "trim": principled_material(f"mat-{asset_id}-trim", (0.09, 0.10, 0.11, 1.0), roughness=0.45),
        "chrome": principled_material(f"mat-{asset_id}-chrome", (0.86, 0.88, 0.90, 1.0), roughness=0.12, metallic=1.0),
        "braid": principled_material(f"mat-{asset_id}-braid", (0.76, 0.50, 0.24, 1.0), roughness=0.28, metallic=0.9),
        # Livery is picked for contrast against the body, not from the accent, so the glyph
        # and stripes stay legible on a light body and on a dark one.
        "marking": principled_material(f"mat-{asset_id}-marking", marking_colour(spec["colour"]), roughness=0.34),
        # Lamps glow gently by default; the runtime raises the tail lamps when a Car is
        # actually losing speed, so brake lights mean something instead of always blazing.
        "headlight": principled_material(
            f"mat-{asset_id}-headlights", (1.0, 0.95, 0.80, 1.0),
            roughness=0.15, emission=(1.0, 0.93, 0.72, 1.0), emission_strength=0.7,
        ),
        "taillight": principled_material(
            f"mat-{asset_id}-taillights", (0.62, 0.05, 0.04, 1.0),
            roughness=0.2, emission=(1.0, 0.12, 0.06, 1.0), emission_strength=0.5,
        ),
    }


def marking_colour(colour: tuple[float, float, float, float]) -> tuple[float, float, float, float]:
    """Near-white on a dark body, near-black on a light one."""
    luminance = 0.2126 * colour[0] + 0.7152 * colour[1] + 0.0722 * colour[2]
    return (0.06, 0.065, 0.075, 1.0) if luminance > 0.45 else (0.94, 0.95, 0.96, 1.0)


def haunched_stations(spec: dict[str, Any]) -> list[dict[str, float]]:
    """
    The authored body profile with a fender flare grown into it over each axle.

    Building the arch as body stations rather than as a separate swept solid is what stops
    it reading as a fin beside the car: it is literally the same surface and material.
    """
    base = list(spec["stations"])
    wheels = spec["wheels"]
    axles = (wheels["front"], wheels["rear"])
    outer = wheels["track"] / 2.0 - ARCH_TYRE_CLEARANCE
    lengths = [station["y"] for station in base]
    for axle in axles:
        for offset in HAUNCH_SAMPLE_OFFSETS:
            candidate = round(axle + offset, 4)
            if base[0]["y"] < candidate < base[-1]["y"] and all(abs(candidate - value) > 0.05 for value in lengths):
                lengths.append(candidate)

    stations: list[dict[str, float]] = []
    for y in sorted(lengths):
        station = interpolate_station(base, y)
        nearest = min(abs(y - axle) for axle in axles)
        amount = max(0.0, 1.0 - (nearest / HAUNCH_SPAN_Y) ** 2)
        station["haunch"] = amount * max(0.0, outer / station["half_width"] - 1.0)
        stations.append(station)
    return stations


def wheel(name: str, spec: dict[str, Any], materials: dict[str, bpy.types.Material], location: tuple[float, float, float]) -> bpy.types.Object:
    """One wheel as a single object: tyre, dished rim, hub, and spokes in three slots."""
    radius = spec["wheels"]["radius"]
    width = spec["wheels"]["width"]
    half = width / 2.0
    outer = 1.0 if location[0] > 0 else -1.0

    # Closed tyre cross section: flat inner face, rounded shoulders, a tread band.
    profile = [
        (0.02, -half),
        (radius * 0.40, -half),
        (radius * 0.94, -half * 0.94),
        (radius, -half * 0.55),
        (radius, half * 0.55),
        (radius * 0.94, half * 0.94),
        (radius * 0.40, half),
        (0.02, half),
    ]
    parts: list[tuple[list, list, int]] = [(*revolved_shell(profile, segments=18), 0)]

    # The rim is dished well inside the tyre face and covers under half of the wheel radius,
    # so at race distance the wheel reads as a dark tyre with a small hub, not as a disc.
    rim_face = half * 0.99 * outer
    rim_profile = [
        (0.02, rim_face - 0.055 * outer),
        (radius * 0.46, rim_face - 0.055 * outer),
        (radius * 0.46, rim_face - 0.018 * outer),
        (0.02, rim_face - 0.018 * outer),
    ]
    parts.append((*revolved_shell(rim_profile, segments=18), 1))
    hub_profile = [
        (0.02, rim_face - 0.018 * outer),
        (radius * 0.17, rim_face - 0.018 * outer),
        (radius * 0.14, rim_face - 0.002 * outer),
        (0.02, rim_face - 0.002 * outer),
    ]
    parts.append((*revolved_shell(hub_profile, segments=12), 2))

    for index in range(5):
        angle = index / 5 * math.tau
        distance = radius * 0.29
        spoke_vertices, spoke_faces = box_shell(
            (radius * 0.26, radius * 0.11, 0.05),
            (math.cos(angle) * distance, math.sin(angle) * distance, rim_face - 0.039 * outer),
        )
        rotated = [
            (
                math.cos(angle) * (x - math.cos(angle) * distance) - math.sin(angle) * (y - math.sin(angle) * distance) + math.cos(angle) * distance,
                math.sin(angle) * (x - math.cos(angle) * distance) + math.cos(angle) * (y - math.sin(angle) * distance) + math.sin(angle) * distance,
                z,
            )
            for x, y, z in spoke_vertices
        ]
        parts.append((rotated, spoke_faces, 1))

    obj = multi_solid(name, parts, [materials["tyre"], materials["rim"], materials["hub"]])
    obj.location = location
    obj.rotation_euler = (0.0, math.pi / 2.0, 0.0)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    obj.select_set(False)
    return obj


def add_wheels(spec: dict[str, Any], materials: dict[str, bpy.types.Material], parts: list[bpy.types.Object]) -> None:
    wheels = spec["wheels"]
    axle_x = wheels["track"] / 2.0 - wheels["width"] / 2.0
    for axle, y in (("front", wheels["front"]), ("rear", wheels["rear"])):
        for side, sign in (("left", -1.0), ("right", 1.0)):
            parts.append(wheel(f"wheel-{axle}-{side}", spec, materials, (sign * axle_x, y, wheels["radius"])))


def canopy(spec: dict[str, Any], materials: dict[str, bpy.types.Material]) -> bpy.types.Object:
    """
    The greenhouse: smoked glass in the sides and windscreen, body colour over the roof and
    across the front and rear pillars.

    The roof is part of this same surface, so there is no panel resting on the canopy and
    nothing for the chase camera to read as a second stacked slab. Structure comes from the
    roof band meeting the glass and from the beltline around its base.
    """
    stations = spec["canopy"]
    ceiling = max(station["top"] for station in stations)
    floor = min(station["bottom"] for station in stations)
    roof_z = ceiling - (ceiling - floor) * ROOF_BAND
    def classify(centre) -> int:
        return 1 if centre.z >= roof_z else 0

    sections = [station_section(station) for station in stations]
    return tinted_shell(
        f"{spec['id']}-canopy", sections, [materials["glass"], materials["body"]], classify,
    )


def add_greenhouse(spec: dict[str, Any], materials: dict[str, bpy.types.Material], parts: list[bpy.types.Object]) -> None:
    """A body-coloured rim around the base of the glass, the toy equivalent of a beltline."""
    surround = [
        {
            "y": station["y"],
            "half_width": station["half_width"] * 1.045,
            "bottom": station["bottom"] - 0.014,
            "top": station["bottom"] + 0.052,
            "tumble": station.get("tumble", 0.0) * 0.3,
            "squareness": 3.0,
        }
        for station in spec["canopy"]
    ]
    parts.append(body(f"{spec['id']}-beltline", surround, materials["body"]))


def add_lamps(spec: dict[str, Any], materials: dict[str, bpy.types.Material], parts: list[bpy.types.Object]) -> None:
    stations = spec["stations"]
    front = stations[1]
    rear = stations[-2]
    asset_id = spec["id"]
    for sign in (-1.0, 1.0):
        side = "right" if sign > 0 else "left"
        parts.append(rounded_box(
            f"{asset_id}-headlight-{side}", (0.16, 0.07, 0.10),
            (sign * front["half_width"] * 0.60, front["y"] - 0.045, (front["bottom"] + front["top"]) / 2.0 + 0.05),
            materials["headlight"], bevel=0.022,
        ))
        parts.append(rounded_box(
            f"{asset_id}-taillight-{side}", (0.13, 0.06, 0.085),
            (sign * rear["half_width"] * 0.62, rear["y"] + 0.055, (rear["bottom"] + rear["top"]) / 2.0 + 0.06),
            materials["taillight"], bevel=0.02,
        ))
    parts.append(rounded_box(
        f"{asset_id}-splitter", (front["half_width"] * 1.75, 0.20, 0.05),
        (0.0, stations[0]["y"] + 0.06, stations[0]["bottom"] - 0.005), materials["trim"], bevel=0.018,
    ))
    parts.append(rounded_box(
        f"{asset_id}-diffuser", (rear["half_width"] * 1.7, 0.18, 0.06),
        (0.0, stations[-1]["y"] - 0.05, stations[-1]["bottom"] + 0.01), materials["trim"], bevel=0.018,
    ))


def add_guide(spec: dict[str, Any], materials: dict[str, bpy.types.Material], parts: list[bpy.types.Object]) -> None:
    """Guide blade and pickup braids: what makes these read as slot cars rather than toys."""
    asset_id = spec["id"]
    nose = spec["stations"][1]
    y = nose["y"] + 0.10
    parts.append(rounded_box(f"{asset_id}-guide-blade", (0.045, 0.20, 0.13), (0.0, y, 0.068), materials["trim"], bevel=0.012))
    parts.append(rounded_box(f"{asset_id}-guide-post", (0.09, 0.09, 0.10), (0.0, y, 0.145), materials["trim"], bevel=0.02))
    for sign in (-1.0, 1.0):
        parts.append(rounded_box(
            f"{asset_id}-braid-{'right' if sign > 0 else 'left'}", (0.075, 0.24, 0.012),
            (sign * 0.085, y + 0.02, 0.012), materials["braid"], bevel=0.004,
        ))


def add_livery(spec: dict[str, Any], materials: dict[str, bpy.types.Material], parts: list[bpy.types.Object]) -> None:
    """
    Glyph and stripes: Racer identity that survives on a small, colour-blind screen.

    The glyph is a marking set flush into the roof panel rather than a tile resting on it,
    and the stripes follow the body's own upper surface where the chase camera looks.
    """
    asset_id = spec["id"]
    roof = spec["roof"]
    glyph = spec["glyph"]
    ceiling = max(station["top"] for station in spec["canopy"])
    centre_z = ceiling + GLYPH_RELIEF - GLYPH_THICKNESS / 2.0
    if glyph.get("cross"):
        for index, size in enumerate(((0.30, 0.10), (0.10, 0.30))):
            parts.append(rounded_box(
                f"{asset_id}-glyph-{index}",
                (size[0] * GLYPH_SCALE, size[1] * GLYPH_SCALE, GLYPH_THICKNESS),
                (0.0, roof["y"], centre_z), materials["marking"], bevel=0.008,
            ))
    else:
        parts.append(prism(
            f"{asset_id}-glyph", glyph["sides"], glyph["radius"] * GLYPH_SCALE, GLYPH_THICKNESS,
            materials["marking"], location=(0.0, roof["y"], centre_z), turn=glyph["turn"],
        ))

    stations = haunched_stations(spec)
    runs = (
        ("hood", spec["stations"][1]["y"] + 0.02, spec["canopy"][0]["y"] - 0.02),
        ("deck", spec["canopy"][-1]["y"] + 0.02, spec["stations"][-2]["y"] + 0.02),
    )
    for label, y_from, y_to in runs:
        if y_to - y_from < MIN_LIVERY_RUN:
            continue
        for sign in (-1.0, 1.0):
            parts.append(surface_ribbon(
                f"{asset_id}-stripe-{label}-{'right' if sign > 0 else 'left'}",
                stations, materials["marking"],
                x_centre=sign * LIVERY_STRIPE_X, width=LIVERY_STRIPE_WIDTH,
                y_from=y_from, y_to=y_to,
            ))


def add_style_details(spec: dict[str, Any], materials: dict[str, bpy.types.Material], parts: list[bpy.types.Object]) -> None:
    asset_id = spec["id"]
    style = spec["style"]
    stations = spec["stations"]

    if style == "coupe":
        parts.append(rounded_box(f"{asset_id}-hood-scoop", (0.15, 0.36, 0.06), (0.0, -0.52, 0.485), materials["accent"], bevel=0.02))
        parts.append(rounded_box(f"{asset_id}-lip-spoiler", (0.62, 0.13, 0.05), (0.0, 0.930, 0.500), materials["accent"], bevel=0.016))
    elif style == "wedge":
        parts.append(rounded_box(f"{asset_id}-wing", (0.82, 0.20, 0.045), (0.0, 0.985, 0.700), materials["accent"], bevel=0.014))
        for sign in (-1.0, 1.0):
            parts.append(rounded_box(
                f"{asset_id}-wing-post-{'right' if sign > 0 else 'left'}", (0.055, 0.075, 0.28),
                (sign * 0.28, 0.965, 0.560), materials["trim"], bevel=0.014,
            ))
            parts.append(rounded_box(
                f"{asset_id}-canard-{'right' if sign > 0 else 'left'}", (0.16, 0.16, 0.03),
                (sign * 0.335, -0.870, 0.215), materials["accent"], bevel=0.01, rotation=(math.radians(-8.0), 0.0, 0.0),
            ))
        parts.append(rounded_box(f"{asset_id}-airbox", (0.20, 0.26, 0.14), (0.0, 0.560, 0.660), materials["trim"], bevel=0.03))
    elif style == "buggy":
        cage = materials["chrome"]
        for sign in (-1.0, 1.0):
            side = "right" if sign > 0 else "left"
            parts.append(rounded_box(f"{asset_id}-cage-{side}", (0.05, 0.05, 0.44), (sign * 0.315, 0.400, 0.870), cage, bevel=0.012))
            parts.append(rounded_box(
                f"{asset_id}-cage-brace-{side}", (0.05, 0.78, 0.05), (sign * 0.315, 0.140, 1.075),
                cage, bevel=0.012, rotation=(math.radians(9.0), 0.0, 0.0),
            ))
        parts.append(rounded_box(f"{asset_id}-cage-hoop", (0.68, 0.05, 0.05), (0.0, 0.400, 1.085), cage, bevel=0.012))
        parts.append(rounded_box(f"{asset_id}-light-bar", (0.56, 0.09, 0.09), (0.0, -0.180, 1.010), materials["headlight"], bevel=0.02))
        parts.append(rounded_box(f"{asset_id}-skid", (0.60, 0.30, 0.07), (0.0, stations[0]["y"] + 0.09, 0.290), materials["accent"], bevel=0.02, rotation=(math.radians(-14.0), 0.0, 0.0)))
        parts.append(rounded_box(f"{asset_id}-spare", (0.30, 0.30, 0.14), (0.0, 0.980, 0.560), materials["tyre"], bevel=0.05))
    elif style == "van":
        for index, y in enumerate((-0.52, -0.06)):
            parts.append(rounded_box(f"{asset_id}-rack-rail-{index}", (0.74, 0.055, 0.055), (0.0, y, 1.070), materials["trim"], bevel=0.014))
        for sign in (-1.0, 1.0):
            parts.append(rounded_box(
                f"{asset_id}-rack-side-{'right' if sign > 0 else 'left'}", (0.055, 0.60, 0.055),
                (sign * 0.325, -0.290, 1.070), materials["trim"], bevel=0.014,
            ))
        parts.append(rounded_box(f"{asset_id}-rack-crate", (0.46, 0.40, 0.18), (0.0, -0.310, 1.180), materials["accent"], bevel=0.03))
        parts.append(rounded_box(f"{asset_id}-bumper-front", (0.80, 0.14, 0.12), (0.0, stations[0]["y"] + 0.03, 0.215), materials["chrome"], bevel=0.03))
        parts.append(rounded_box(f"{asset_id}-bumper-rear", (0.80, 0.13, 0.11), (0.0, stations[-1]["y"] - 0.03, 0.225), materials["chrome"], bevel=0.03))


def build_car(spec: dict[str, Any]) -> tuple[bpy.types.Object, list[bpy.types.Object]]:
    asset_id = spec["id"]
    root = bpy.data.objects.new(asset_id, None)
    root.empty_display_type = "PLAIN_AXES"
    root.empty_display_size = 0.25
    bpy.context.scene.collection.objects.link(root)

    materials = car_materials(spec)
    parts: list[bpy.types.Object] = [
        body(f"{asset_id}-body", haunched_stations(spec), materials["body"]),
        canopy(spec, materials),
    ]
    add_greenhouse(spec, materials, parts)
    add_wheels(spec, materials, parts)
    add_lamps(spec, materials, parts)
    add_guide(spec, materials, parts)
    add_style_details(spec, materials, parts)
    add_livery(spec, materials, parts)

    for part in parts:
        part.parent = root
        part["asset_part"] = part.name
    root["asset_id"] = asset_id
    root["authoring_axes"] = "X width, Y length, Z up; front -Y"
    root["game_axes"] = "X width, Y up, Z length; front +Z"
    root["wheel_objects"] = json.dumps(list(WHEEL_NAMES))
    root["wheel_radius"] = round(spec["wheels"]["radius"], 4)
    return root, parts


def centre_parts(parts: list[bpy.types.Object]) -> None:
    """
    Moves every part in mesh space so the car is centred across the bench, centred along its
    own length, and resting exactly on the ground plane. Doing this after assembly keeps the
    authored numbers readable instead of pre-compensated.
    """
    points = [obj.matrix_world @ Vector(corner) for obj in parts for corner in obj.bound_box]
    minimum = [min(point[index] for point in points) for index in range(3)]
    maximum = [max(point[index] for point in points) for index in range(3)]
    offset = Vector((
        -(minimum[0] + maximum[0]) / 2.0,
        -(minimum[1] + maximum[1]) / 2.0,
        -minimum[2],
    ))
    if offset.length < 1e-6:
        return
    for obj in parts:
        for vertex in obj.data.vertices:
            vertex.co += offset
        obj.data.update()


def scene_dimensions(parts: list[bpy.types.Object]) -> tuple[float, float, float]:
    points = [obj.matrix_world @ Vector(corner) for obj in parts for corner in obj.bound_box]
    minimum = [min(point[index] for point in points) for index in range(3)]
    maximum = [max(point[index] for point in points) for index in range(3)]
    return tuple(maximum[index] - minimum[index] for index in range(3))


def triangle_count(parts: list[bpy.types.Object]) -> int:
    total = 0
    for obj in parts:
        obj.data.calc_loop_triangles()
        total += len(obj.data.loop_triangles)
    return total


def export_glb(root: bpy.types.Object, parts: list[bpy.types.Object], output_path: Path) -> None:
    bpy.ops.object.select_all(action="DESELECT")
    root.select_set(True)
    for part in parts:
        part.select_set(True)
    bpy.context.view_layer.objects.active = root
    bpy.ops.export_scene.gltf(
        filepath=str(output_path),
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_cameras=False,
        export_lights=False,
        export_extras=True,
    )


def build_all() -> list[dict[str, Any]]:
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    CARD_DIR.mkdir(parents=True, exist_ok=True)
    SOURCE_DIR.mkdir(parents=True, exist_ok=True)
    reports: list[dict[str, Any]] = []
    for spec in CAR_SPECS:
        reset_scene()
        root, parts = build_car(spec)
        centre_parts(parts)
        dimensions_xyz = scene_dimensions(parts)
        triangles = triangle_count(parts)
        if triangles > TRIANGLE_BUDGET:
            raise RuntimeError(f"{spec['id']} has {triangles} triangles; budget is {TRIANGLE_BUDGET}")
        root["dimensions_blender_xyz"] = json.dumps([round(value, 4) for value in dimensions_xyz])
        root["triangle_count"] = triangles
        collider = {
            "width": round(spec["wheels"]["track"], 3),
            "height": round(dimensions_xyz[2] * 0.9, 3),
            "length": round(dimensions_xyz[1] * 0.94, 3),
        }
        root["suggested_collider"] = json.dumps(collider)

        source_path = SOURCE_DIR / f"{spec['id']}.blend"
        model_path = MODEL_DIR / f"{spec['id']}.glb"
        card_path = CARD_DIR / f"{spec['id']}.png"
        bpy.ops.wm.save_as_mainfile(filepath=str(source_path), check_existing=False)
        export_glb(root, parts, model_path)
        render_card(card_path)

        reports.append({
            "assetId": spec["id"],
            "modelPath": f"/assets/models/{spec['id']}.glb",
            "cardPath": f"/assets/cards/{spec['id']}.png",
            "dimensionsGameXYZ": [round(dimensions_xyz[0], 4), round(dimensions_xyz[2], 4), round(dimensions_xyz[1], 4)],
            "forwardAxis": "+Z",
            "wheelObjects": list(WHEEL_NAMES),
            "wheelRadius": round(spec["wheels"]["radius"], 4),
            "triangleCount": triangles,
            "suggestedColliderGameXYZ": [collider["width"], collider["height"], collider["length"]],
        })
        print(f"BUILT {spec['id']}: dimensions(game XYZ)={reports[-1]['dimensionsGameXYZ']}, triangles={triangles}")

    REPORT_PATH.write_text(json.dumps({"schemaVersion": 1, "assets": reports}, indent=2) + "\n", encoding="utf-8")
    return reports


def main() -> None:
    build_all()
    from validate_assets import validate_all
    validate_all()
    print("Toy-car build and validation complete")


if __name__ == "__main__":
    main()
