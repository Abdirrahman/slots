"""Validate generated source scenes, cards, and round-tripped GLB files."""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path
from typing import Any

import bmesh
import bpy
from mathutils import Vector

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from build_assets import CARD_DIR, CAR_SPECS, LANE_SPACING, MODEL_DIR, REPORT_PATH, SOURCE_DIR, TRIANGLE_BUDGET, mesh_centre

EPSILON = 1e-4
EXPECTED_WHEELS = {"wheel-front-left", "wheel-front-right", "wheel-rear-left", "wheel-rear-right"}


def fail(asset_id: str, message: str) -> None:
    raise RuntimeError(f"{asset_id}: {message}")


def close(value: float, expected: float = 0.0, epsilon: float = EPSILON) -> bool:
    return abs(value - expected) <= epsilon


def mesh_bounds(meshes: list[bpy.types.Object]) -> tuple[list[float], list[float]]:
    points = [obj.matrix_world @ Vector(corner) for obj in meshes for corner in obj.bound_box]
    return (
        [min(point[index] for point in points) for index in range(3)],
        [max(point[index] for point in points) for index in range(3)],
    )


def validate_material(asset_id: str, material: bpy.types.Material) -> None:
    if not material.use_nodes or material.node_tree is None:
        fail(asset_id, f"material {material.name} does not use nodes")
    if not any(node.bl_idname == "ShaderNodeBsdfPrincipled" for node in material.node_tree.nodes):
        fail(asset_id, f"material {material.name} is not Principled BSDF")
    if any(node.bl_idname == "ShaderNodeTexImage" for node in material.node_tree.nodes):
        fail(asset_id, f"material {material.name} unexpectedly uses an image texture")


def validate_mesh(asset_id: str, obj: bpy.types.Object) -> int:
    mesh = obj.data
    if len(mesh.polygons) == 0:
        fail(asset_id, f"mesh {obj.name} is empty")
    if len(mesh.materials) == 0 or any(material is None for material in mesh.materials):
        fail(asset_id, f"mesh {obj.name} has a missing material")
    if any(polygon.material_index >= len(mesh.materials) for polygon in mesh.polygons):
        fail(asset_id, f"mesh {obj.name} has an invalid material assignment")
    for material in mesh.materials:
        validate_material(asset_id, material)
    mesh.calc_loop_triangles()
    if any(not all(math.isfinite(component) for component in polygon.normal) or polygon.normal.length < 0.99 for polygon in mesh.polygons):
        fail(asset_id, f"mesh {obj.name} has invalid normals")
    topology = bmesh.new()
    topology.from_mesh(mesh)
    non_manifold = [edge for edge in topology.edges if not edge.is_manifold]
    topology.free()
    if non_manifold:
        fail(asset_id, f"mesh {obj.name} has {len(non_manifold)} non-manifold edges")
    return len(mesh.loop_triangles)


def validate_wheel_origin(asset_id: str, obj: bpy.types.Object, where: str) -> None:
    """
    The runtime spins a wheel by turning the object about its local X axis, so the origin has
    to sit on the axle. An origin left at the car's centre turns that spin into an orbit and
    is invisible on a static card, so it is checked here rather than looked at.
    """
    offset = mesh_centre(obj)
    if any(not close(value, 0.0, 0.002) for value in offset):
        fail(asset_id, f"{where} {obj.name} origin is {offset} from its own hub; the runtime would orbit it")


def validate_source(spec: dict[str, Any]) -> dict[str, Any]:
    asset_id = spec["id"]
    source_path = SOURCE_DIR / f"{asset_id}.blend"
    if not source_path.is_file():
        fail(asset_id, f"missing source file {source_path}")
    bpy.ops.wm.open_mainfile(filepath=str(source_path), load_ui=False)
    root = bpy.data.objects.get(asset_id)
    if root is None or root.type != "EMPTY":
        fail(asset_id, "missing root Empty")
    if root.location.length > EPSILON or any(not close(value) for value in root.rotation_euler) or any(not close(value, 1.0) for value in root.scale):
        fail(asset_id, "root origin or transforms are not applied")

    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    if not meshes:
        fail(asset_id, "source scene contains no meshes")
    for obj in meshes:
        if any(not close(value) for value in obj.rotation_euler) or any(not close(value, 1.0) for value in obj.scale):
            fail(asset_id, f"{obj.name} has unapplied rotation or scale")
        if obj.parent != root:
            fail(asset_id, f"{obj.name} is not parented to the asset root")

    wheel_names = {obj.name for obj in meshes if obj.name.startswith("wheel-")}
    if wheel_names != EXPECTED_WHEELS:
        fail(asset_id, f"wheel names are {sorted(wheel_names)}, expected {sorted(EXPECTED_WHEELS)}")
    for obj in meshes:
        if obj.name in EXPECTED_WHEELS:
            validate_wheel_origin(asset_id, obj, "source")

    minimum, maximum = mesh_bounds(meshes)
    dimensions_blender = [maximum[index] - minimum[index] for index in range(3)]
    if not close(minimum[2], 0.0, 0.002):
        fail(asset_id, f"car does not sit on ground; minimum Z is {minimum[2]:.6f}")
    if not close((minimum[0] + maximum[0]) / 2.0, 0.0, 0.002) or not close((minimum[1] + maximum[1]) / 2.0, 0.0, 0.03):
        fail(asset_id, "root is not horizontally centred under the car")
    if dimensions_blender[0] >= LANE_SPACING * 0.9:
        fail(asset_id, f"width {dimensions_blender[0]:.3f} is too large for {LANE_SPACING:.3f}-unit lane spacing")
    if dimensions_blender[1] > 2.35:
        fail(asset_id, f"length {dimensions_blender[1]:.3f} exceeds the track presentation envelope")

    triangles = sum(validate_mesh(asset_id, obj) for obj in meshes)
    if triangles > TRIANGLE_BUDGET:
        fail(asset_id, f"triangle count {triangles} exceeds {TRIANGLE_BUDGET}")
    return {
        "dimensionsGameXYZ": [round(dimensions_blender[0], 4), round(dimensions_blender[2], 4), round(dimensions_blender[1], 4)],
        "triangleCount": triangles,
    }


def validate_outputs(spec: dict[str, Any]) -> None:
    asset_id = spec["id"]
    model_path = MODEL_DIR / f"{asset_id}.glb"
    card_path = CARD_DIR / f"{asset_id}.png"
    if not model_path.is_file() or model_path.stat().st_size == 0:
        fail(asset_id, f"missing GLB file {model_path}")
    if not card_path.is_file() or card_path.stat().st_size == 0:
        fail(asset_id, f"missing card image {card_path}")
    image = bpy.data.images.load(str(card_path), check_existing=False)
    try:
        if tuple(image.size) != (512, 512):
            fail(asset_id, f"card is {tuple(image.size)}, expected 512x512")
        if image.channels != 4:
            fail(asset_id, "card image is not RGBA")
        alpha = list(image.pixels)[3::4]
        if min(alpha) > 0.01 or max(alpha) < 0.99:
            fail(asset_id, "card image must contain both transparent background and visible artwork")
    finally:
        bpy.data.images.remove(image)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    try:
        bpy.ops.import_scene.gltf(filepath=str(model_path))
    except Exception as error:
        fail(asset_id, f"GLB import failed: {error}")
    imported_meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    if not imported_meshes:
        fail(asset_id, "round-tripped GLB contains no meshes")
    if not EXPECTED_WHEELS.issubset({obj.name for obj in imported_meshes}):
        fail(asset_id, "round-tripped GLB lost wheel object names")
    for obj in imported_meshes:
        if len(obj.data.materials) == 0 or any(material is None for material in obj.data.materials):
            fail(asset_id, f"round-tripped mesh {obj.name} has a missing material")
        if obj.name in EXPECTED_WHEELS:
            validate_wheel_origin(asset_id, obj, "round-tripped")


def validate_all() -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    for spec in CAR_SPECS:
        result = validate_source(spec)
        validate_outputs(spec)
        results.append({"assetId": spec["id"], **result})
        print(f"VALID {spec['id']}: dimensions(game XYZ)={result['dimensionsGameXYZ']}, triangles={result['triangleCount']}")
    if not REPORT_PATH.is_file():
        fail("asset-set", f"missing build report {REPORT_PATH}")
    report = json.loads(REPORT_PATH.read_text(encoding="utf-8"))
    if [asset["assetId"] for asset in report.get("assets", [])] != [spec["id"] for spec in CAR_SPECS]:
        fail("asset-set", "build report does not contain the expected assets")
    return results


if __name__ == "__main__":
    validate_all()
    print("Toy-car validation complete")
