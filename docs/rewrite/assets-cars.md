# First rewrite milestone: original slot racers

Four new original cars are generated in Blender. The existing `toy-car-*` family is preserved.

| Asset ID | Display name | Shape and livery |
| --- | --- | --- |
| `r2-car-club` | Club 07 | Compact upright coupe; red body, cream stripe and roof roundel, chrome bumper |
| `r2-car-muscle` | Hammer 22 | Long hood, low coupe roof, amber body, twin black stripes, scoop and ducktail |
| `r2-car-prototype` | Vector 64 | Low endurance body, narrow glazed cockpit, cyan/white livery, intake, spine and wing |
| `r2-car-gt` | Prism 91 | Angular violet GT, lime offset stripe, broad rear shoulders and raised wing |

The cars share dark rounded tyres, recessed six-spoke metal wheels, illuminated lamp inserts, moulded wheel arches, door mirrors, a chassis, guide blade and copper pickup braids. Numbers are actual mesh geometry, so their identity survives without an image texture or runtime decal system. These are original shapes and liveries; no reference-game mesh, logo or texture is reused.

## Rebuild

From the repository root, using the installed Blender:

```bash
env -i HOME=/home/am PATH=/usr/bin:/bin ALSOFT_DRIVERS=null /usr/bin/blender --background --factory-startup -noaudio --python-exit-code 1 --python blender/scripts/build_rewrite_cars.py
```

`--python-exit-code 1` makes validation exceptions fail the command. `ALSOFT_DRIVERS=null` keeps this headless build from trying to connect to desktop audio when Blender resets its preferences. The script uses native `bpy`, existing geometry/material/card helpers and no add-ons. All output is deterministic from its four authored profiles. Rebuilding affects only this new asset set.

For each ID the builder writes:

- `blender/source/<id>.blend`, with geometry and root metadata;
- `public/assets/models/<id>.glb`, with glTF-compatible Principled materials;
- `public/assets/cards/<id>.png`, a 512 × 512 RGBA transparent card;
- an entry in `blender/rewrite-car-report.json`, the authoritative dimensions, triangle count, wheel radius, object names and suggested collider.

## Runtime contract

Blender axes are X width, Y length, Z up; the nose points toward **−Y**. Standard glTF Y-up export converts this to game **+Y up, +Z forward**. All cars have a ground-level root centered across their width and length, with applied mesh rotation and scale. Wheel objects are exactly `wheel-front-left`, `wheel-front-right`, `wheel-rear-left` and `wheel-rear-right`; each origin is at its axle center, ready for local-X wheel spin. Wheel radius is 0.225–0.24 game units. The tyre-to-tyre width is 1.04 units, inside the current 1.35 lane spacing.

The GLB uses geometric stripes and numbers with simple shared PBR material slots. No external texture, font, HDRI or other file is required at runtime. Cars are triangulated before export, and the report must be used instead of hard-coding their bounds. Body styles do not imply different handling statistics in this asset milestone.

## Validation

The builder reopens every BLEND and imports every GLB. Source checks cover manifold geometry, finite normals, material slots, applied transforms, exact wheel names, wheel-origin placement, centered ground bounds, width/length limits and the 4,000–8,000 triangle envelope. GLB checks cover material presence and compatibility, finite vertex positions, applied transforms, wheel names/origins, unchanged triangle count and bounds within 0.002 units of the source. glTF can split vertices at hard normals, so exported vertex topology is not incorrectly treated as source topology. Card checks require 512 × 512 RGBA, transparent background and opaque visible art. Rendered cards are also inspected visually.

Production LODs, additional liveries and texture atlases remain for the broader art phase. These four complete, playable LOD0 assets establish the silhouette, scale, export and runtime animation contract first.
