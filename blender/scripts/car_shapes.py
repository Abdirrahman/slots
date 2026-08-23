"""Deterministic mesh construction for the toy slot cars.

Bodies are lofted through hand-authored cross sections instead of assembled from boxes, so
each car keeps a rounded toy silhouette at a low triangle count. Every generated mesh is a
closed manifold solid with applied transforms, which is what the asset validation requires.
"""

from __future__ import annotations

import math
from typing import Iterable, Sequence

import bmesh
import bpy

Point = tuple[float, float, float]
Section = Sequence[Point]


def _finalize(mesh: bpy.types.Mesh) -> None:
    topology = bmesh.new()
    topology.from_mesh(mesh)
    bmesh.ops.remove_doubles(topology, verts=topology.verts, dist=1e-5)
    bmesh.ops.recalc_face_normals(topology, faces=topology.faces)
    topology.to_mesh(mesh)
    topology.free()
    mesh.validate(verbose=False)
    mesh.update()


def solid(name: str, vertices: Sequence[Point], faces: Sequence[Sequence[int]], material: bpy.types.Material) -> bpy.types.Object:
    """A mesh object at the scene origin with identity transforms and one material."""
    mesh = bpy.data.meshes.new(f"mesh-{name}")
    mesh.from_pydata([tuple(vertex) for vertex in vertices], [], [list(face) for face in faces])
    _finalize(mesh)
    mesh.materials.append(material)
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def multi_solid(
    name: str,
    parts: Sequence[tuple[Sequence[Point], Sequence[Sequence[int]], int]],
    materials: Sequence[bpy.types.Material],
) -> bpy.types.Object:
    """One object holding several closed shells, each shell using one material slot."""
    vertices: list[Point] = []
    faces: list[list[int]] = []
    indices: list[int] = []
    for part_vertices, part_faces, material_index in parts:
        offset = len(vertices)
        vertices.extend(tuple(vertex) for vertex in part_vertices)
        for face in part_faces:
            faces.append([offset + index for index in face])
            indices.append(material_index)

    mesh = bpy.data.meshes.new(f"mesh-{name}")
    mesh.from_pydata(vertices, [], faces)
    _finalize(mesh)
    for material in materials:
        mesh.materials.append(material)
    for polygon, material_index in zip(mesh.polygons, indices):
        polygon.material_index = material_index
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def ring_shell(sections: Sequence[Section], *, closed_ends: bool = True) -> tuple[list[Point], list[list[int]]]:
    """Vertices and faces for one lofted shell, for composing into a multi-material object."""
    width = len(sections[0])
    vertices: list[Point] = [point for section in sections for point in section]
    faces: list[list[int]] = []
    for index in range(len(sections) - 1):
        base = index * width
        following = base + width
        for step in range(width):
            nxt = (step + 1) % width
            faces.append([base + step, base + nxt, following + nxt, following + step])
    if closed_ends:
        faces.append(list(range(width - 1, -1, -1)))
        last = (len(sections) - 1) * width
        faces.append([last + step for step in range(width)])
    return vertices, faces


def revolved_shell(
    profile: Sequence[tuple[float, float]],
    *,
    segments: int = 16,
    offset: Point = (0.0, 0.0, 0.0),
) -> tuple[list[Point], list[list[int]]]:
    """Vertices and faces of a closed profile revolved around the local Z axis."""
    width = len(profile)
    vertices: list[Point] = []
    for step in range(segments):
        angle = step / segments * math.tau
        cosine = math.cos(angle)
        sine = math.sin(angle)
        for radius, height in profile:
            vertices.append((
                offset[0] + radius * cosine,
                offset[1] + radius * sine,
                offset[2] + height,
            ))
    faces: list[list[int]] = []
    for index in range(segments):
        base = index * width
        following = ((index + 1) % segments) * width
        for step in range(width):
            nxt = (step + 1) % width
            faces.append([base + step, base + nxt, following + nxt, following + step])
    return vertices, faces


def box_shell(size: tuple[float, float, float], centre: Point) -> tuple[list[Point], list[list[int]]]:
    """Axis-aligned box shell, for spokes and other small solid details."""
    half = [value / 2.0 for value in size]
    vertices = [
        (centre[0] + sx * half[0], centre[1] + sy * half[1], centre[2] + sz * half[2])
        for sx, sy, sz in (
            (-1, -1, -1), (1, -1, -1), (1, 1, -1), (-1, 1, -1),
            (-1, -1, 1), (1, -1, 1), (1, 1, 1), (-1, 1, 1),
        )
    ]
    faces = [
        [0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4],
        [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7],
    ]
    return vertices, faces


def loft(name: str, sections: Sequence[Section], material: bpy.types.Material, *, closed_ends: bool = True) -> bpy.types.Object:
    """Skins equal-length rings into one solid, capping the first and last ring."""
    width = len(sections[0])
    if any(len(section) != width for section in sections):
        raise ValueError(f"{name}: every loft section needs the same point count")

    vertices: list[Point] = [point for section in sections for point in section]
    faces: list[list[int]] = []
    for index in range(len(sections) - 1):
        base = index * width
        following = base + width
        for step in range(width):
            nxt = (step + 1) % width
            faces.append([base + step, base + nxt, following + nxt, following + step])
    if closed_ends:
        faces.append(list(range(width - 1, -1, -1)))
        last = (len(sections) - 1) * width
        faces.append([last + step for step in range(width)])
    return solid(name, vertices, faces, material)


# The fender flare is widest a little below the section's mid-height and tapers to nothing
# at the roof and the floor, so a haunch reads as a swelling of the body rather than a band.
HAUNCH_CENTRE = -0.15
HAUNCH_SPAN = 0.95


def _haunch_scale(sine: float, haunch: float) -> float:
    if haunch == 0.0:
        return 1.0
    bump = max(0.0, 1.0 - ((sine - HAUNCH_CENTRE) / HAUNCH_SPAN) ** 2)
    return 1.0 + haunch * bump


def body_section(
    y: float,
    half_width: float,
    bottom: float,
    top: float,
    *,
    tumble: float = 0.0,
    squareness: float = 3.2,
    haunch: float = 0.0,
    points: int = 16,
) -> list[Point]:
    """
    One car cross section in the X/Z plane at length `y`.

    `squareness` blends between an ellipse (2) and a rounded box (higher), `tumble`
    narrows the section toward its roof the way a moulded toy body draws in at the top,
    and `haunch` swells it outward over an axle so the wheel arch is the body's own
    surface instead of a separate band floating beside it.
    """
    centre = (bottom + top) / 2.0
    half_height = (top - bottom) / 2.0
    exponent = 2.0 / squareness
    section: list[Point] = []
    for index in range(points):
        angle = index / points * math.tau
        cosine = math.cos(angle)
        sine = math.sin(angle)
        x = math.copysign(abs(cosine) ** exponent, cosine) * half_width
        z = math.copysign(abs(sine) ** exponent, sine) * half_height
        x *= 1.0 - tumble * max(0.0, sine)
        x *= _haunch_scale(sine, haunch)
        section.append((x, y, centre + z))
    return section


def station_section(station: dict[str, float], *, points: int = 16) -> list[Point]:
    return body_section(
        station["y"],
        station["half_width"],
        station["bottom"],
        station["top"],
        tumble=station.get("tumble", 0.0),
        squareness=station.get("squareness", 3.2),
        haunch=station.get("haunch", 0.0),
        points=points,
    )


def body(name: str, stations: Iterable[dict[str, float]], material: bpy.types.Material, *, points: int = 16) -> bpy.types.Object:
    sections = [station_section(station, points=points) for station in stations]
    return loft(name, sections, material)


def tinted_shell(
    name: str,
    sections: Sequence[Section],
    materials: Sequence[bpy.types.Material],
    classify,
) -> bpy.types.Object:
    """
    One lofted shell whose faces choose a material from their own position.

    This is how the canopy gets a body-coloured roof and pillars: they are the canopy's own
    surface rather than panels resting on it, so nothing can stack, poke through, or leave
    a seam. `classify` receives each face centre and returns a material slot index.
    """
    vertices, faces = ring_shell(sections, closed_ends=True)
    mesh = bpy.data.meshes.new(f"mesh-{name}")
    mesh.from_pydata(vertices, [], [list(face) for face in faces])
    _finalize(mesh)
    for material in materials:
        mesh.materials.append(material)
    for polygon in mesh.polygons:
        polygon.material_index = classify(polygon.center)
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def top_surface_z(station: dict[str, float], x: float) -> float:
    """
    Height of a station's upper surface at lateral position `x`.

    The tumble and haunch terms make the section hard to invert in closed form, so it is
    sampled densely and read back. Livery that hugs this height sits on the body instead
    of hovering over it.
    """
    section = station_section(station, points=192)
    upper = [point for point in section if point[2] >= (station["bottom"] + station["top"]) / 2.0]
    target = abs(x)
    best = min(upper, key=lambda point: abs(abs(point[0]) - target))
    return best[2]


def interpolate_station(stations: Sequence[dict[str, float]], y: float) -> dict[str, float]:
    """The station profile read at an arbitrary length, clamped to the authored ends."""
    keys = ("half_width", "bottom", "top", "tumble", "squareness")
    defaults = {"tumble": 0.0, "squareness": 3.2}
    if y <= stations[0]["y"]:
        source = stations[0]
    elif y >= stations[-1]["y"]:
        source = stations[-1]
    else:
        source = None
    if source is not None:
        return {"y": y, **{key: source.get(key, defaults.get(key, 0.0)) for key in keys}}
    for first, second in zip(stations, stations[1:]):
        if first["y"] <= y <= second["y"]:
            span = second["y"] - first["y"]
            amount = 0.0 if span == 0.0 else (y - first["y"]) / span
            return {
                "y": y,
                **{
                    key: first.get(key, defaults.get(key, 0.0))
                    + (second.get(key, defaults.get(key, 0.0)) - first.get(key, defaults.get(key, 0.0))) * amount
                    for key in keys
                },
            }
    raise ValueError("station interpolation fell through")


def surface_ribbon(
    name: str,
    stations: Sequence[dict[str, float]],
    material: bpy.types.Material,
    *,
    x_centre: float,
    width: float,
    y_from: float,
    y_to: float,
    samples: int = 7,
    thickness: float = 0.010,
    sink: float = 0.012,
) -> bpy.types.Object:
    """
    A livery ribbon that follows the body's own upper surface between two lengths.

    Each section is set just below the surface and given enough thickness to stay proud
    across the body's curvature, so the stripe reads as paint rather than as a tile.
    """
    sections: list[list[Point]] = []
    half = width / 2.0
    for step in range(samples):
        y = y_from + (y_to - y_from) * step / (samples - 1)
        station = interpolate_station(stations, y)
        heights = [top_surface_z(station, x_centre + half * offset) for offset in (-1.0, 0.0, 1.0)]
        base = min(heights) - sink
        rise = max(heights) - min(heights)
        top = base + sink + rise + thickness
        sections.append([
            (x_centre - half, y, base),
            (x_centre + half, y, base),
            (x_centre + half, y, top),
            (x_centre - half, y, top),
        ])
    return loft(name, sections, material)


def rounded_box(
    name: str,
    size: tuple[float, float, float],
    location: Point,
    material: bpy.types.Material,
    *,
    bevel: float = 0.03,
    rotation: Point = (0.0, 0.0, 0.0),
    segments: int = 2,
) -> bpy.types.Object:
    """A bevelled box built directly in mesh space, so no object transform is left over."""
    width, length, height = size
    radius = max(1e-4, min(bevel, min(size) * 0.32))
    steps = max(1, segments)
    profile = [
        (
            math.cos(math.pi / 2 * (step + 0.5) / steps),
            math.sin(math.pi / 2 * (step + 0.5) / steps),
        )
        for step in range(steps)
    ]

    sections: list[list[Point]] = []
    ends = [
        (-length / 2.0, 0.0),
        (-length / 2.0 + radius, 1.0),
        (length / 2.0 - radius, 1.0),
        (length / 2.0, 0.0),
    ]
    for y, scale in ends:
        section: list[Point] = []
        # Rounded rectangle in X/Z, shrunk toward the ends so the box reads as bevelled.
        inset = radius * (1.0 - scale)
        half_width = width / 2.0 - inset
        half_height = height / 2.0 - inset
        for sign_x, sign_z in ((1, 1), (-1, 1), (-1, -1), (1, -1)):
            corner_x = sign_x * (half_width - radius)
            corner_z = sign_z * (half_height - radius)
            for cosine, sine in profile:
                section.append((
                    corner_x + sign_x * radius * cosine,
                    y,
                    corner_z + sign_z * radius * sine,
                ))
        sections.append(section)

    obj = loft(name, sections, material)
    _place(obj, location, rotation)
    return obj


def revolved(
    name: str,
    profile: Sequence[tuple[float, float]],
    material: bpy.types.Material,
    *,
    location: Point = (0.0, 0.0, 0.0),
    rotation: Point = (0.0, 0.0, 0.0),
    segments: int = 16,
) -> bpy.types.Object:
    """
    Revolves a closed 2D profile of (radius, height) points around the local Z axis.

    Used for wheels and other turned shapes; the profile must not touch the axis, so the
    result is a torus-like closed surface with no caps.
    """
    sections: list[list[Point]] = []
    for step in range(segments):
        angle = step / segments * math.tau
        cosine = math.cos(angle)
        sine = math.sin(angle)
        sections.append([(radius * cosine, radius * sine, height) for radius, height in profile])

    width = len(profile)
    vertices: list[Point] = [point for section in sections for point in section]
    faces: list[list[int]] = []
    for index in range(segments):
        base = index * width
        following = ((index + 1) % segments) * width
        for step in range(width):
            nxt = (step + 1) % width
            faces.append([base + step, base + nxt, following + nxt, following + step])
    obj = solid(name, vertices, faces, material)
    _place(obj, location, rotation)
    return obj


def prism(
    name: str,
    sides: int,
    radius: float,
    height: float,
    material: bpy.types.Material,
    *,
    location: Point = (0.0, 0.0, 0.0),
    rotation: Point = (0.0, 0.0, 0.0),
    turn: float = 0.0,
) -> bpy.types.Object:
    """A flat-topped prism, used for the roof glyphs that identify Racers without colour."""
    sections = []
    for z in (-height / 2.0, height / 2.0):
        sections.append([
            (
                math.cos(turn + index / sides * math.tau) * radius,
                math.sin(turn + index / sides * math.tau) * radius,
                z,
            )
            for index in range(sides)
        ])
    obj = loft(name, sections, material)
    _place(obj, location, rotation)
    return obj


def swept_arc(
    name: str,
    material: bpy.types.Material,
    *,
    centre: Point,
    radius: float,
    thickness: float,
    width: float,
    start: float,
    end: float,
    steps: int = 8,
) -> bpy.types.Object:
    """
    A wheel arch: a rectangular profile swept along an arc in the Y/Z plane.

    `start` and `end` are angles measured from the positive Y axis toward positive Z.
    """
    sections: list[list[Point]] = []
    for step in range(steps + 1):
        angle = start + (end - start) * step / steps
        y = centre[1] + math.cos(angle) * radius
        z = centre[2] + math.sin(angle) * radius
        outward_y = math.cos(angle) * thickness / 2.0
        outward_z = math.sin(angle) * thickness / 2.0
        sections.append([
            (centre[0] - width / 2.0, y - outward_y, z - outward_z),
            (centre[0] + width / 2.0, y - outward_y, z - outward_z),
            (centre[0] + width / 2.0, y + outward_y, z + outward_z),
            (centre[0] - width / 2.0, y + outward_y, z + outward_z),
        ])
    return loft(name, sections, material)


def _place(obj: bpy.types.Object, location: Point, rotation: Point) -> None:
    """Bakes a placement into mesh data so the object keeps identity transforms."""
    obj.location = location
    obj.rotation_euler = rotation
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    obj.select_set(False)
