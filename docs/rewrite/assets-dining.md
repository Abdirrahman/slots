# Dining Table Run — first playable map asset

Original Blender-authored household map for the first asset slice. The exported GLB includes the complete road, rather than dressing an unrelated runtime circle. No source game models, maps, textures or branding are copied.

## Outputs and reproducible build

- Builder: `blender/scripts/build_dining_room.py` (Blender `bpy`, no add-ons or downloaded resources)
- Editable source: `blender/source/dining-table-run.blend`
- Runtime scene: `public/assets/maps/dining-table-run.glb`
- Authoritative track: `src/dining-track.json`
- Transparent 512 × 512 card: `public/assets/cards/dining-table-run.png`
- Transparent 1600 × 1000 overview: `public/assets/cards/dining-table-run-overview.png`
- Machine validation evidence: `blender/dining-room-report.json`

```bash
env -i HOME=/home/am PATH=/usr/bin:/bin ALSOFT_DRIVERS=null /usr/bin/blender \
  --background --factory-startup -noaudio --python-exit-code 1 \
  --python blender/scripts/build_dining_room.py
```

The builder regenerates JSON from its declared authoring controls, samples exactly the same periodic Catmull–Rom interpolation used in TypeScript, validates the result, exports GLB, and renders both previews. GLB is replaced atomically after geometry validation. A thrown exception gives a nonzero process exit code with `--python-exit-code 1`. Blender's optional user-cache thumbnail warning does not affect the saved scene or renders.

## Content and game coordinates

Identity: **`dining-table-run@1.0.0`**, schema version 1. Four lanes indexed 0–3, each separated by **1.35 world units**. The roadway is **5.94 units wide**; the kerbs extend outside that surface. Cars around 1 unit wide and 2.2 long fit the lane spacing.

Game coordinates are +Y up and +Z forward. Authoring coordinates are `(gameX, -gameZ, gameY)`; glTF export converts them back to game coordinates. The `dining-room` root and `track-surface` object have identity transforms in the GLB. No runtime scaling or recentering is required. Individual fruit, cylinders and lamps retain ordinary translated child nodes with unit scale.

The starting point is `(-22, 0.65, -25)`, travelling approximately +X along a clear foreground passing straight. A checker stripe and a gantry mark the start. Independent meshes `start-light-0`, `start-light-1`, `start-light-2` each have an independent Principled emissive material `start-light-material-N`; the runtime can change these for its countdown.

The 340.285533-unit simulation lap covers approximately 248.408439 world units, preserving the existing 0.73 world/progress factor. Fourteen control knots provide a broad closed circuit; progression values approximate physical distance between knots. The mesh has 1,024 longitudinal samples. This is an authored spline route, not a claim of exact arc-length parametrization; a future track compiler can remove residual within-segment speed variation.

- Foreground straight supports a clear initial chase view and passing.
- The eastern bend climbs on blue trestles to roughly 6.41 units, then descends toward the table tunnel.
- The north straight passes under a raised dining table whose underside is at 17.1 units.
- The west sweeper returns past the original toy storage box.
- Both bends have negative camber, raising the outside Lane 0 edge; provisional outside-lane speed limits are 19/18/17/16.
- There are no self-crossings, unsupported jump gaps or inversions in this slice.

The JSON defines three ordered checkpoints, four item markers, four hazard placement markers and two corner regions. Fixed obstacles are empty: household props remain outside the road envelope. The runtime owns item/hazard animation and gameplay; markers are metadata, not permanently baked pickups.

## Geometry and art implementation

The road surface contains actual recessed slot profiles for all four lanes, copper contact rails on each side of every slot, blue moulded base geometry, pale edge pinstripes, alternating red/ivory shoulder kerbs and panel seams. The surface uses the existing runtime lane-offset equation exactly:

```text
R = (-dz / hypot(dx,dz) * cos(bank), sin(bank), dx / hypot(dx,dz) * cos(bank))
laneCenter = splinePosition + (lane - 1.5) * 1.35 * R
```

Surface thickness and raised trim use a pitch-aware upward normal derived from `R × tangent`. Banked/elevated lane centres therefore match current TypeScript; a future orthonormal track frame must update both the compiler and runtime together.

The room uses warm oak planks, walnut table/chairs, sage cutaway walls, teal cushions and toy packaging, a terracotta table runner and curtains, a ceramic fruit bowl, recipe books, a brass lamp and original geometric wall art. Floor planks, chair pieces, table legs and other repeated rectangular parts are batched by object/material. The entire scene uses original geometry and flat Principled materials, without textures. Large shapes remain readable from a low toy-car camera.

The camera-facing walls are omitted, and the back-wall return is short. Scenery has no collision mesh in this slice; gameplay is lane-constrained. Clearances are validated so visual props do not occupy the driving envelope. The builder's preview lights and camera are saved in the `.blend`, but excluded from GLB so the Three.js renderer controls lighting.

## Validation and budgets

The current build is approximately **96,736 triangles**, **65 mesh objects**, **30 Blender materials**, and a **5.2 MB GLB**. Exact output sizes and route hash are in the report. This leaves room below the proposed 250k-triangle per-view budget for four cars and runtime effects; actual frame time must still be measured in the running game.

Automated checks cover:

- Finite mesh coordinates, applied unit scales and present materials.
- Nonempty source, GLB and PNG outputs, and a 200k-triangle hard ceiling.
- 2,048 sampled route positions: minimum 3-D bend radius approximately **12.52** units.
- Nonadjacent route separation approximately **14.76** units, excluding a 16-unit along-route neighbourhood, against a 7.14-unit minimum envelope.
- Every scenery collision proxy against 1,024 route cross sections and 17 samples across the full road plus a 0.20-unit shoulder, with 1.4-unit car headroom. Repeated boxes use per-part bounds, avoiding a false collision volume across all four table legs.
- Independent TypeScript/GLB tests added by the runtime integration verify exported road edge positions against `sampleTrackPose`.

Both renders were visually inspected after the normal orientation, floor boundary and east-bend camber were corrected. This is the first finished map asset slice; exact reference handling, lane locks, jumps, championship progression, additional routes and optimized LOD/texture variants remain subsequent roadmap work.
