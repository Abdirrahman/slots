"""Build four original first-milestone racers without changing the legacy asset set.

Run from factory startup. Geometry and materials are authored in Blender; no add-ons,
downloaded meshes or raster textures are used. Blender -Y maps to game +Z on export.
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector

SCRIPT_DIR = Path(__file__).resolve().parent
ROOT = SCRIPT_DIR.parents[1]
sys.path.insert(0, str(SCRIPT_DIR))
from build_assets import centre_parts, export_glb, mesh_centre, reset_scene, scene_dimensions, triangle_count
from car_shapes import _finalize, body, box_shell, multi_solid, prism, revolved_shell, surface_ribbon, tinted_shell
from materials import principled_material
from render_cards import render_card
from validate_assets import mesh_bounds, validate_material, validate_mesh, validate_wheel_origin

WHEELS = ("wheel-front-left", "wheel-front-right", "wheel-rear-left", "wheel-rear-right")


def stations(rows):
    return [dict(y=y, half_width=w, bottom=b, top=t, squareness=3.4, tumble=.035) for y, w, b, t in rows]


SPECS = (
    dict(id="r2-car-club", name="Club 07", kind="club", number="07", color=(.72,.035,.045,1), accent=(.98,.88,.67,1),
         radius=.23, front=-.65, rear=.66,
         body=stations(((-1.09,.33,.14,.32),(-.97,.43,.12,.41),(-.66,.485,.12,.46),(-.32,.485,.13,.46),(.30,.485,.13,.46),(.70,.48,.13,.45),(.98,.44,.14,.42),(1.09,.34,.16,.36))),
         cabin=((- .38,.32,.448,.49),(-.12,.32,.453,.79),(.38,.32,.45,.80),(.75,.31,.44,.49)), roof_y=.13, roof_z=.807,
         hood=(-.94,-.39), deck=(.77,1.0), stripe_x=0, stripe_w=.22),
    dict(id="r2-car-muscle", name="Hammer 22", kind="muscle", number="22", color=(1,.43,.025,1), accent=(.035,.045,.055,1),
         radius=.24, front=-.79, rear=.78,
         body=stations(((-1.25,.36,.13,.32),(-1.17,.46,.10,.42),(-.78,.49,.11,.45),(-.32,.49,.12,.45),(.29,.49,.12,.45),(.78,.485,.12,.46),(1.18,.45,.13,.42),(1.25,.35,.15,.35))),
         cabin=((- .31,.34,.445,.48),(-.04,.325,.45,.72),(.40,.325,.45,.72),(.80,.325,.445,.48)), roof_y=.18, roof_z=.727,
         hood=(-1.16,-.33), deck=(.82,1.16), stripe_x=.13, stripe_w=.11),
    dict(id="r2-car-prototype", name="Vector 64", kind="prototype", number="64", color=(.025,.63,.77,1), accent=(.96,.97,.90,1),
         radius=.225, front=-.76, rear=.77,
         body=stations(((-1.25,.38,.08,.21),(-1.16,.47,.09,.29),(-.76,.49,.10,.40),(-.34,.46,.10,.37),(.32,.46,.10,.37),(.77,.49,.10,.42),(1.17,.46,.10,.36),(1.25,.34,.12,.30))),
         cabin=((- .53,.22,.365,.395),(-.21,.24,.37,.64),(.28,.235,.37,.66),(.65,.21,.37,.43)), roof_y=.10, roof_z=.663,
         hood=(-1.17,-.55), deck=(.67,1.14), stripe_x=0, stripe_w=.20),
    dict(id="r2-car-gt", name="Prism 91", kind="gt", number="91", color=(.34,.075,.72,1), accent=(.66,.94,.065,1),
         radius=.235, front=-.74, rear=.73,
         body=stations(((-1.23,.35,.09,.25),(-1.09,.46,.10,.34),(-.74,.49,.11,.45),(-.30,.465,.11,.43),(.33,.465,.11,.44),(.73,.49,.11,.49),(1.08,.45,.13,.42),(1.23,.34,.15,.33))),
         cabin=((- .45,.29,.425,.46),(-.16,.29,.43,.73),(.29,.28,.435,.73),(.73,.29,.44,.48)), roof_y=.10, roof_z=.737,
         hood=(-1.09,-.47), deck=(.75,1.06), stripe_x=-.15, stripe_w=.13),
)


def materials(spec):
    prefix = spec["id"]
    colors = {"body":spec["color"], "accent":spec["accent"], "glass":(.075,.16,.23,1),
              "tyre":(.023,.028,.034,1), "rim":(.51,.56,.60,1), "hub":(.10,.13,.16,1),
              "trim":(.035,.044,.055,1), "chrome":(.7,.75,.78,1), "braid":(.65,.38,.12,1),
              "white":(.96,.97,.94,1), "ink":(.027,.038,.05,1)}
    result = {}
    for name, color in colors.items():
        result[name] = principled_material(f"mat-{prefix}-{name}", color,
            roughness=.85 if name=="tyre" else (.14 if name=="glass" else .3),
            metallic=.75 if name in ("rim","chrome","braid") else (.25 if name=="glass" else .04))
    result["headlight"] = principled_material(f"mat-{prefix}-headlights", (1,.9,.68,1), roughness=.18, emission=(1,.88,.6,1), emission_strength=.45)
    result["taillight"] = principled_material(f"mat-{prefix}-taillights", (.65,.025,.025,1), roughness=.22, emission=(1,.025,.012,1), emission_strength=.3)
    return result


def cube(name, size, location, material, bevel=.012, rotation=(0,0,0)):
    bpy.ops.mesh.primitive_cube_add(size=1, location=location)
    obj = bpy.context.object
    obj.name = name
    obj.dimensions = size
    obj.rotation_euler = rotation
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if bevel:
        mod = obj.modifiers.new("Moulded edge", "BEVEL")
        mod.width = min(bevel, min(size)*.3)
        mod.segments = 1
        bpy.ops.object.modifier_apply(modifier=mod.name)
    obj.data.materials.append(material)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    return obj


def cut_arches(obj, spec):
    for y in (spec["front"],spec["rear"]):
        for sign in (-1,1):
            bpy.ops.mesh.primitive_cylinder_add(vertices=24, radius=spec["radius"]+.025, depth=.27, location=(sign*.465,y,spec["radius"]), rotation=(0,math.pi/2,0))
            cutter = bpy.context.object
            cutter.data.materials.append(obj.data.materials[0])
            bpy.context.view_layer.objects.active = obj
            mod = obj.modifiers.new("Wheel arch", "BOOLEAN")
            mod.operation = "DIFFERENCE"
            mod.solver = "EXACT"
            mod.object = cutter
            bpy.ops.object.modifier_apply(modifier=mod.name)
            bpy.data.objects.remove(cutter, do_unlink=True)
    for face in obj.data.polygons:
        face.use_smooth = abs(face.normal.y)<.98


def make_cabin(spec, mats):
    sections = []
    for y,w,b,t in spec["cabin"]:
        # A single integrated greenhouse with a flat painted roof and glazed slopes.
        sections.append([(-w,y,b),(w,y,b),(w*.95,y,b+.04),(w*.78,y,t-.025),(w*.68,y,t),(-w*.68,y,t),(-w*.78,y,t-.025),(-w*.95,y,b+.04)])
    roof = max(row[3] for row in spec["cabin"])-.035
    return tinted_shell(f"{spec['id']}-greenhouse",sections,[mats["glass"],mats["body"]],lambda center:1 if center.z>roof else 0)


def make_wheel(name, radius, side, location, mats):
    half=.095
    tyre = [(.12,-half),(.205,-half),(.23,-.075),(radius,-.045),(radius,.045),(.23,.075),(.205,half),(.12,half)]
    # Scale the rounded tyre shoulder for the slightly different axle radii.
    tyre=[(r*radius/.24,z) for r,z in tyre]
    face=.082*side
    rim=[(.118,face-.025*side),(.153,face-.025*side),(.153,face),(.118,face)]
    disc=[(.004,face-.029*side),(.143,face-.029*side),(.143,face-.019*side),(.004,face-.019*side)]
    hub=[(.004,face-.012*side),(.041,face-.012*side),(.041,face+.01*side),(.004,face+.01*side)]
    parts=[(*revolved_shell(tyre,segments=24),0),(*revolved_shell(rim,segments=24),1),(*revolved_shell(disc,segments=20),2),(*revolved_shell(hub,segments=16),1)]
    for i in range(6):
        angle=i/6*math.tau
        verts,faces=box_shell((.115,.026,.018),(.095,0,face-.004*side))
        verts=[(x*math.cos(angle)-y*math.sin(angle),x*math.sin(angle)+y*math.cos(angle),z) for x,y,z in verts]
        parts.append((verts,faces,1))
    wheel=multi_solid(name,parts,[mats["tyre"],mats["rim"],mats["hub"]])
    wheel.rotation_euler=(0,math.pi/2,0)
    wheel.location=location
    bpy.context.view_layer.objects.active=wheel
    wheel.select_set(True)
    bpy.ops.object.transform_apply(location=False,rotation=True,scale=True)
    wheel.select_set(False)
    for face in wheel.data.polygons:
        face.use_smooth = face.material_index == 0
    return wheel


def text_mesh(name, text, size, position, material):
    curve=bpy.data.curves.new(name,"FONT")
    curve.body=text
    curve.align_x="CENTER"
    curve.align_y="CENTER"
    curve.size=size
    curve.extrude=.0015
    curve.resolution_u=1
    obj=bpy.data.objects.new(name,curve)
    bpy.context.collection.objects.link(obj)
    obj.location=position
    curve.materials.append(material)
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active=obj
    bpy.ops.object.convert(target="MESH")
    bpy.ops.object.transform_apply(location=True,rotation=True,scale=True)
    _finalize(bpy.context.object.data)
    return bpy.context.object


def build(spec):
    aid=spec["id"]
    mats=materials(spec)
    root=bpy.data.objects.new(aid,None)
    bpy.context.collection.objects.link(root)
    shape=[dict(row) for row in spec["body"]]
    for row in shape:
        if min(abs(row["y"]-axle) for axle in (spec["front"],spec["rear"]))<.05:
            row["top"]=max(row["top"],2*spec["radius"]+.05)
    shell=body(f"{aid}-moulded-body",shape,mats["body"],points=24)
    cut_arches(shell,spec)
    parts=[shell,make_cabin(spec,mats)]
    for axle,y in (("front",spec["front"]),("rear",spec["rear"])):
        for side,sign in (("left",-1),("right",1)):
            parts.append(make_wheel(f"wheel-{axle}-{side}",spec["radius"],sign,(sign*.425,y,spec["radius"]),mats))
    def add(label,size,pos,mat="trim",bevel=.01,rotation=(0,0,0)):
        parts.append(cube(f"{aid}-{label}",size,pos,mats[mat],bevel,rotation))
    nose=spec["body"][0]["y"]
    rear=spec["body"][-1]["y"]
    add("chassis",(.71,rear-nose-.25,.06),(0,0,.12))
    add("front-splitter",(.84,.15,.045),(0,nose+.005,.105))
    add("rear-diffuser",(.82,.13,.055),(0,rear-.02,.13))
    add("guide-blade",(.045,.23,.11),(0,spec["front"]-.15,.055))
    for s in (-1,1):
        add(f"braid-{s}",(.065,.24,.014),(s*.09,spec["front"]-.14,.009),"braid",.002)
        # Lamp inserts and recesses sit on the end faces, visible from above at race scale.
        lamp_z=.28 if spec["kind"] in ("club","muscle") else .23
        add(f"lamp-bezel-{s}",(.20,.045,.10),(s*.245,nose+.025,lamp_z),"trim")
        add(f"headlamp-{s}",(.155,.048,.062),(s*.245,nose+.005,lamp_z),"headlight")
        add(f"tail-bezel-{s}",(.21,.04,.08),(s*.23,rear-.02,.28),"trim")
        add(f"taillamp-{s}",(.17,.042,.045),(s*.23,rear+.002,.28),"taillight")
        add(f"side-sill-{s}",(.055,spec["rear"]-spec["front"]-.48,.06),(s*.478,0,.16),"accent")
        add(f"mirror-stalk-{s}",(.09,.055,.025),(s*.32,-.17,.54),"trim",.004)
        add(f"mirror-{s}",(.10,.08,.055),(s*.385,-.17,.55),"body")
    # Geometric paint ribbons hug the loft, with no runtime decals or texture dependency.
    xs=(spec["stripe_x"],) if spec["kind"]!="muscle" else (-spec["stripe_x"],spec["stripe_x"])
    for label in ("hood","deck"):
        for i,x in enumerate(xs):
            parts.append(surface_ribbon(f"{aid}-{label}-stripe-{i}",shape,mats["accent"],x_centre=x,width=spec["stripe_w"],y_from=spec[label][0],y_to=spec[label][1],samples=10,thickness=.004,sink=.008))
    badge_mat="accent"
    parts.append(prism(f"{aid}-roof-number-roundel",32,.176,.004,mats[badge_mat],location=(0,spec["roof_y"],spec["roof_z"])))
    number_mat="ink" if spec["kind"] in ("club","prototype","gt") else "white"
    parts.append(text_mesh(f"{aid}-roof-number",spec["number"],.217,(0,spec["roof_y"],spec["roof_z"]+.003),mats[number_mat]))
    # Each family has a visibly different planform and aero silhouette.
    if spec["kind"]=="club":
        add("grille",(.35,.038,.082),(0,nose-.005,.255),"trim",.007)
        add("bumper",(.78,.09,.065),(0,nose+.02,.16),"chrome")
        add("boot-lip",(.76,.10,.035),(0,.99,.44),"accent")
        for s in (-1,1):
            add(f"door-handle-{s}",(.018,.13,.022),(s*.488,.17,.405),"chrome",.004)
    elif spec["kind"]=="muscle":
        add("hood-scoop",(.29,.39,.07),(0,-.72,.48),"accent")
        add("scoop-intake",(.23,.018,.033),(0,-.91,.485),"trim",.003)
        add("rear-ducktail",(.85,.18,.075),(0,1.13,.46),"accent")
        add("grille",(.35,.03,.095),(0,nose-.006,.27),"trim")
        for s in (-1,1):
            add(f"exhaust-{s}",(.09,.16,.07),(s*.27,1.225,.16),"chrome")
    else:
        wing_z=.62 if spec["kind"]=="prototype" else .69
        add("rear-wing",(.98,.23,.045),(0,1.12,wing_z),"accent")
        for s in (-1,1):
            add(f"wing-post-{s}",(.035,.075,.22),(s*.31,1.10,wing_z-.12),"trim",.006)
            add(f"wing-endplate-{s}",(.025,.29,.12),(s*.477,1.12,wing_z-.015),"body",.004)
            add(f"canard-{s}",(.15,.22,.025),(s*.40,-1.00,.25),"accent",.004)
            for i in range(3):
                add(f"haunch-vent-{s}-{i}",(.13,.028,.008),(s*.33,.54+i*.06,.443 if spec["kind"]=="gt" else .395),"trim",.001)
        if spec["kind"]=="prototype":
            add("air-intake",(.20,.25,.12),(0,.53,.56),"trim")
            add("spine",(.035,.55,.15),(0,.83,.47),"accent",.004)
        else:
            add("front-intake",(.33,.03,.07),(0,nose-.004,.19),"trim")
            add("engine-spine",(.21,.29,.035),(0,.85,.47),"trim")
    for part in parts:
        part.parent=root
        part["asset_part"]=part.name
        bpy.context.view_layer.objects.active=part
        mod=part.modifiers.new("Export triangles","TRIANGULATE")
        bpy.ops.object.modifier_apply(modifier=mod.name)
    bpy.context.view_layer.update()
    # centre_parts works in baked mesh coordinates, so temporarily bake only wheel
    # translations, then reseat each wheel pivot after the common ground adjustment.
    for wheel in (p for p in parts if p.name in WHEELS):
        bpy.context.view_layer.objects.active=wheel
        bpy.ops.object.select_all(action="DESELECT")
        wheel.select_set(True)
        bpy.ops.object.transform_apply(location=True,rotation=False,scale=False)
    centre_parts(parts)
    for wheel in (p for p in parts if p.name in WHEELS):
        center=mesh_centre(wheel)
        for vertex in wheel.data.vertices:
            vertex.co-=center
        wheel.location=center
        wheel.data.update()
    bpy.context.view_layer.update()
    root["asset_id"]=aid
    root["display_name"]=spec["name"]
    root["authoring_axes"]="X width, Y length, Z up; front -Y"
    root["game_axes"]="X width, Y up, Z length; front +Z"
    root["wheel_objects"]=json.dumps(WHEELS)
    root["wheel_radius"]=spec["radius"]
    return root,parts


def validate(spec, expected):
    aid=spec["id"]
    for kind,path in (("source",ROOT/"blender/source"/f"{aid}.blend"),("GLB",ROOT/"public/assets/models"/f"{aid}.glb")):
        if kind=="source":
            bpy.ops.wm.open_mainfile(filepath=str(path),load_ui=False)
        else:
            reset_scene()
            bpy.ops.import_scene.gltf(filepath=str(path))
        meshes=[o for o in bpy.context.scene.objects if o.type=="MESH"]
        if not meshes or {o.name for o in meshes if o.name.startswith("wheel-")}!=set(WHEELS):
            raise RuntimeError(f"{aid} {kind}: missing mesh/wheel objects")
        for obj in meshes:
            if kind=="source":
                validate_mesh(aid,obj)
            else:
                # glTF deliberately splits vertices at normal/material boundaries.
                # Source topology is checked above; check the exported render data.
                if not obj.data.materials or any(mat is None for mat in obj.data.materials):
                    raise RuntimeError(f"{aid} GLB: missing materials on {obj.name}")
                for mat in obj.data.materials:
                    validate_material(aid,mat)
                if any(not math.isfinite(c) for v in obj.data.vertices for c in v.co):
                    raise RuntimeError(f"{aid} GLB: non-finite vertices on {obj.name}")
            if obj.name in WHEELS:
                validate_wheel_origin(aid,obj,kind)
            if any(abs(s-1)>1e-5 for s in obj.scale) or any(abs(r)>1e-5 for r in obj.rotation_euler):
                raise RuntimeError(f"{aid} {kind}: unapplied transforms on {obj.name}")
        minimum,maximum=mesh_bounds(meshes)
        dims=[maximum[i]-minimum[i] for i in range(3)]
        # Blender's glTF importer restores authoring axes, as well as the wheel pivots.
        actual=[dims[0],dims[2],dims[1]]
        if any(abs(a-b)>.002 for a,b in zip(actual,expected["dimensionsGameXYZ"])):
            raise RuntimeError(f"{aid} {kind}: round-trip dimensions {actual}")
        if abs(minimum[2])>.002 or abs(minimum[0]+maximum[0])>.002 or abs(minimum[1]+maximum[1])>.002:
            raise RuntimeError(f"{aid} {kind}: root is not ground-centered")
        if triangle_count(meshes)!=expected["triangleCount"]:
            raise RuntimeError(f"{aid} {kind}: triangle count changed")
    img=bpy.data.images.load(str(ROOT/"public/assets/cards"/f"{aid}.png"),check_existing=False)
    if tuple(img.size)!=(512,512) or img.channels!=4:
        raise RuntimeError(f"{aid}: card must be 512 RGBA")
    alpha=list(img.pixels)[3::4]
    if min(alpha)>.01 or max(alpha)<.99:
        raise RuntimeError(f"{aid}: card transparency invalid")
    bpy.data.images.remove(img)


def main():
    reports=[]
    for spec in SPECS:
        reset_scene()
        root,parts=build(spec)
        dims=scene_dimensions(parts)
        triangles=triangle_count(parts)
        if not (4000<=triangles<=8000 and dims[0]<1.1 and 2.1<=dims[1]<=2.65):
            raise RuntimeError(f"{spec['id']}: geometry budget exceeded: {triangles} triangles / {dims}")
        aid=spec["id"]
        record=dict(assetId=aid,displayName=spec["name"],modelPath=f"/assets/models/{aid}.glb",cardPath=f"/assets/cards/{aid}.png",
                    dimensionsGameXYZ=[round(dims[0],4),round(dims[2],4),round(dims[1],4)],triangleCount=triangles,forwardAxis="+Z",
                    wheelRadius=spec["radius"],wheelObjects=list(WHEELS),suggestedColliderGameXYZ=[round(dims[0]*.94,4),round(dims[2]*.88,4),round(dims[1]*.94,4)])
        root["triangle_count"]=triangles
        root["dimensions_game_xyz"]=json.dumps(record["dimensionsGameXYZ"])
        source=ROOT/"blender/source"/f"{aid}.blend"
        model=ROOT/"public/assets/models"/f"{aid}.glb"
        card=ROOT/"public/assets/cards"/f"{aid}.png"
        for path in (source,model,card):
            path.parent.mkdir(parents=True,exist_ok=True)
        bpy.ops.wm.save_as_mainfile(filepath=str(source),check_existing=False)
        export_glb(root,parts,model)
        render_card(card)
        validate(spec,record)
        reports.append(record)
        print(f"VALID {aid}: {triangles} triangles; game XYZ {record['dimensionsGameXYZ']}",flush=True)
    (ROOT/"blender/rewrite-car-report.json").write_text(json.dumps(dict(schemaVersion=1,assets=reports),indent=2)+"\n")
    print("Four rewrite racers built and round-trip validated",flush=True)


if __name__=="__main__":
    main()
