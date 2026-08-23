"""Consistent transparent product-card rendering for generated toy cars."""

from __future__ import annotations

from pathlib import Path

import bpy
from mathutils import Vector

from materials import principled_material

CARD_SIZE = 512
CAMERA_POSITION = (4.2, -6.2, 3.35)
CAMERA_TARGET = (0.0, 0.0, 0.48)
CAMERA_ORTHO_SCALE = 3.55


def _look_at(obj: bpy.types.Object, target: tuple[float, float, float]) -> None:
    obj.rotation_euler = (Vector(target) - obj.location).to_track_quat("-Z", "Y").to_euler()


def _area_light(name: str, location: tuple[float, float, float], energy: float, size: float, color: tuple[float, float, float]) -> None:
    data = bpy.data.lights.new(name=f"light-{name}", type="AREA")
    data.energy = energy
    data.shape = "DISK"
    data.size = size
    data.color = color
    light = bpy.data.objects.new(name=f"card-{name}", object_data=data)
    bpy.context.scene.collection.objects.link(light)
    light.location = location
    _look_at(light, CAMERA_TARGET)


def _add_contact_shadow() -> None:
    bpy.ops.mesh.primitive_circle_add(vertices=48, radius=1.0, fill_type="NGON", location=(0.0, 0.08, 0.006))
    shadow = bpy.context.object
    shadow.name = "card-contact-shadow"
    shadow.data.name = "mesh-card-contact-shadow"
    shadow.scale = (0.74, 1.28, 1.0)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    material = principled_material("mat-card-contact-shadow", (0.035, 0.045, 0.05, 0.18), roughness=1.0)
    material.surface_render_method = "DITHERED"
    shadow.data.materials.append(material)


def render_card(output_path: Path) -> None:
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = CARD_SIZE
    scene.render.resolution_y = CARD_SIZE
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.film_transparent = True
    scene.render.filepath = str(output_path)
    scene.render.image_settings.color_depth = "8"

    world = bpy.data.worlds.new("world-card") if scene.world is None else scene.world
    scene.world = world
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.055, 0.065, 0.075, 1.0)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.35

    camera_data = bpy.data.cameras.new("camera-card")
    camera_data.type = "ORTHO"
    camera_data.ortho_scale = CAMERA_ORTHO_SCALE
    camera_data.lens = 52
    camera = bpy.data.objects.new("card-camera", camera_data)
    scene.collection.objects.link(camera)
    camera.location = CAMERA_POSITION
    _look_at(camera, CAMERA_TARGET)
    scene.camera = camera

    _area_light("key", (-3.8, -4.4, 6.2), 620.0, 4.2, (1.0, 0.82, 0.68))
    _area_light("fill", (4.5, -1.0, 3.5), 420.0, 3.8, (0.65, 0.82, 1.0))
    _area_light("rim", (0.5, 4.8, 5.0), 520.0, 3.0, (1.0, 0.96, 0.82))
    _add_contact_shadow()

    for obj in scene.objects:
        if obj.type == "MESH" and not obj.name.startswith("card-"):
            obj.visible_shadow = True

    output_path.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.render.render(write_still=True)


if __name__ == "__main__":
    raise SystemExit("render_cards.py is a helper; run build_assets.py to render the complete set")
