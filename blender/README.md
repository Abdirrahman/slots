# Toy car asset pipeline

This directory contains the deterministic Blender pipeline for the four browser-game car models.

## What the pipeline produces

Each car is a moulded toy slot car rather than a stack of boxes:

- a body lofted through hand-authored cross sections (`car_shapes.body`), with tumblehome and adjustable squareness per station;
- **wheel arches grown into that same loft** as fender haunches (`haunched_stations`), rather than swept as separate solids;
- a **two-tone canopy** (`tinted_shell`) whose upper band takes the body material, so the roof is the canopy's own surface, plus a body-coloured beltline around its base;
- a guide blade, guide post, and copper braids under the nose, the detail that reads as a slot car;
- wheels built as one object each — tyre, dished rim, hub, and five spokes in three material slots — each with its origin on its own hub, so the runtime can spin them by name;
- head and tail lamps at low emission, the tail lamps driven from Car state at runtime, plus splitter and diffuser;
- a roof glyph (disc, triangle, square, cross) set nearly flush into the roof, in a marking colour picked for contrast against the body; and
- livery stripes that follow the body's own upper surface (`surface_ribbon`) across the hood and rear deck, where the chase camera looks.

### Appearance fixes, and what caused them

Six of these are corrections to specific reported faults, recorded here because the causes were
not what they looked like:

- **Arches read as detached fins.** They were separate swept solids standing proud of a body
  that tapered away beneath them. Building the flare as widened body stations makes it literally
  the same surface and the same material, so there is no seam to read as a fin.
- **Roof panel and glyph read as stacked slabs.** A body-coloured box rested on the glass and a
  glyph tile rested on that — three layers from the chase camera. Making the canopy two-tone
  removed the panel entirely; the glyph now sits nearly flush in the roof it marks.
- **Wheels read as pale blobs.** The rim covered 66% of the wheel radius in bright metal, and —
  the part that was not visible from the cards — **the hub cap and spokes projected through the
  outer tyre face**, making them the widest part of the car and catching side light. Recessing
  both behind the tyre face and shrinking the rim to 46% lets the tyre hold the silhouette.
- **Wheels orbited the car instead of spinning.** This one was invisible on the cards and on a
  parked car, and obvious the moment a car moved. `wheel()` applied its placement into mesh
  data and `centre_parts` shifted every vertex again, so each wheel object's origin was left at
  the car's own origin while its hub sat 0.72–0.75 units away. The runtime spins a wheel by
  turning the object about its local X axis, so that origin turned the spin into an orbit on a
  0.72-unit radius, sweeping each wheel up through the body and below the bench. `seat_wheel_origins`
  now moves each wheel's origin onto its own hub after centring, leaving world positions
  untouched, and validation fails the build if a wheel's geometry is not centred on its origin.
  The runtime's spin direction was wrong too, and had been hidden by the orbit: forward is local
  `+Z`, so rolling forward is a *positive* turn about `+X`.
- **Canopy read as a hole.** Its base colour was `0.04, 0.08, 0.12`. It is now a light smoked
  tint with a body-coloured roof and beltline giving the greenhouse structure.
- **Livery read as an accidental rocker panel.** The stripe sat at maximum body half-width, low
  down, where it intersected the arches. It is now paint on the upper surfaces.

Cars are centred and set on the ground automatically after assembly (`centre_parts`), so authored numbers stay readable instead of pre-compensated. Wheels are the one exception to the pipeline's everything-baked-at-the-origin rule: `seat_wheel_origins` runs after centring and gives each wheel an object origin on its own hub, because that origin is the axle the runtime rotates about.

## Inspected game constraints

- Renderer: Three.js `WebGLRenderer` with soft shadow maps and `MeshStandardMaterial` (`src/main.ts`).
- Model loading: `GLTFLoader` loads the registered GLBs from `src/car-assets.ts`. Before this work the cars were generated from Three.js boxes and there was no model loader or asset manifest.
- Game coordinates: right-handed Three.js world, `+Y` up, local `+Z` forward. Track poses rotate cars around `Y`.
- Blender coordinates: `+Z` up, `X` width, `Y` length. Cars are authored facing `-Y`; Blender's glTF axis conversion produces `+Z` forward in Three.js.
- Units: one Blender metre is exported as one Three.js game unit. The game does not declare a real-world physical conversion.
- Track: four lanes at `1.35` units centre-to-centre. The road is about `5.94` units wide including its `0.7`-lane edge margins. Track surfaces climb and bank, so cars are posed on a sampled surface normal rather than a flat plane; nothing in the model may sink below its ground plane.
- Contact: gameplay collision is discrete Lane/progress logic with a provisional `2.0`-unit longitudinal separation. It does not consume mesh colliders.
- Naming: project-authored IDs use lowercase kebab-case. Assets therefore use `toy-car-*`; wheel objects are `wheel-front-left`, `wheel-front-right`, `wheel-rear-left`, and `wheel-rear-right`.
- Materials and shadows: generated materials use only glTF-compatible Principled BSDF nodes. Runtime meshes cast and receive shadows. No image textures are used.

**Car width against lane spacing is a deliberate call.** Every car is now exactly `1.00` units
wide — 74% of the `1.35`-unit lane spacing, leaving `0.35` of a gap between two cars running
abreast. It was `1.14` (`0.21` of a gap), and that width came from the old arches and the
protruding hubs standing outside the wheels rather than from any decision. Fixing those brought
the widest point back to the tyre sidewalls, which is the track width itself, so the number is
now something the model means rather than something it accumulated. A third of a lane of daylight
reads as tight racing while still letting a racer see which lane a neighbour is in; lane spacing
(`PROVISIONAL_PRESENTATION.laneSpacing`) is therefore unchanged, so no track view geometry moves.

Each silhouette differs in stance and height while sharing that envelope: the buggy is `1.16`
units tall and the wedge `0.73`, and the wedge is longest at `2.26`, against a 2.35 limit.

**Guide blade and braid clearance.** The blade's underside sits `0.003` above the car's ground
plane and the braids `0.006`; the car is posed `0.02` above the sampled track surface, and the
lane grooves and their braids are lifted `0.009` and `0.013`. That leaves `0.014` and `0.010` of
clearance, measured along the same surface normal the car is posed on, so the margin holds on
climbing and banked sections rather than only on the flat. Ground-contact validation forbids
dropping the blade any further, so the blade rides just above its groove rather than in it.

## Outputs

- GLBs: `public/assets/models/toy-car-*.glb`
- Cards: `public/assets/cards/toy-car-*.png`
- Editable sources: `blender/source/toy-car-*.blend`
- Generated measurements: `blender/asset-report.json`
- Runtime registry: `src/car-assets.ts`, regenerated from the report by `node tools/sync-car-assets.mjs`

Each GLB root also exports glTF extras for the asset ID, authoring/game axes, dimensions, triangle count, suggested collider, wheel names, and wheel radius (the runtime turns the wheels at the distance the car actually covers). Suggested colliders are metadata only because the current race simulation has no geometric collider system.

## Generate and validate

From the project root:

```sh
npm run assets:cars
```

That wraps the following command and then regenerates `src/car-assets.ts`:

```sh
env -i HOME=/home/am PATH=/usr/bin:/bin /usr/bin/blender --background --factory-startup --python blender/scripts/build_assets.py
```

A clean environment is intentional on this workstation: its shell-managed Python 3.14 otherwise leaks into Blender and prevents Blender from loading standard-library extension modules. On systems without that conflict, this shorter command is equivalent:

```sh
blender --background --factory-startup --python blender/scripts/build_assets.py
```

`build_assets.py` starts from factory settings for every variant, and `car_shapes.py` holds the mesh construction helpers, writes all outputs, and invokes `validate_assets.py`. Validation checks output presence, 512×512 RGBA cards, applied rotation/scale, root placement, ground contact, lane fit, Principled materials, triangle budget, valid normals, manifold meshes, material assignments, wheel names, **wheel origins seated on their hubs in both the source scene and the round-tripped GLB**, and GLB re-import.

To validate existing outputs without regenerating:

```sh
env -i HOME=/home/am PATH=/usr/bin:/bin /usr/bin/blender --background --factory-startup --python blender/scripts/validate_assets.py
```
