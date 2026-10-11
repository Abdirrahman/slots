# Asset milestone 1 — Dining Table Run

Four original Blender cars and one household environment are now integrated into the TypeScript/Three.js race. This is the first content slice from the rewrite plan. Automatic acceleration, balanced handling and existing item rules remain for the later handling milestone.

## Play

```sh
npm run build
npm run server
```

Open `http://localhost:3000`, choose a body, enter a guest name and start Solo Quick Race. Private rooms use the same map and retain each player's selected body. `npm run dev` proxies WebSocket requests to the server on port 3000.

The four bodies are **Club 07** (compact coupe), **Hammer 22** (muscle coupe), **Vector 64** (endurance prototype) and **Prism 91** (angular GT). This is a body choice using the existing balanced profile, as identified in the garage. The server validates selection and retains it through reconnect and rematch. Protocol version 9 requires matching client/server builds.

## Source and exports

| Content | Editable source | Export |
| --- | --- | --- |
| Cars | `blender/source/r2-car-*.blend` | `public/assets/models/r2-car-*.glb` |
| Dining scene and road | `blender/source/dining-table-run.blend` | `public/assets/maps/dining-table-run.glb` |
| Car cards | Blender card cameras | `public/assets/cards/r2-car-*.png` |
| Map overview | Blender overview camera | `public/assets/cards/dining-table-run-overview.png` |
| Authoritative route | Knots in `build_dining_room.py` | `src/dining-track.json` |
| Measurements | Blender validation | `blender/rewrite-car-report.json`, `blender/dining-room-report.json` |

All content is original, generated using repository-owned Python/bpy code. No add-ons, downloaded models or new JavaScript dependencies are required. Previous cars and Workshop data remain available; the main client and default server now use Dining.

## Rebuild

```sh
npm run assets:rewrite-cars
npm run assets:dining
# Or both:
npm run assets:rewrite
```

The scripts use `/usr/bin/blender` in an isolated environment because the workstation's shell Python conflicts with Blender. `ALSOFT_DRIVERS=null` and `-noaudio` avoid a PulseAudio shutdown hang; `--python-exit-code 1` makes generation failures return a nonzero status. Car generation checks source/GLB round trips and transparent 512px cards, then generates `src/racing-assets.ts` from the measured report through `tools/sync-rewrite-cars.mjs`.

The Dining builder exports the visual road and route data together: four lanes, 1.35-unit spacing, a 5.94-unit road envelope, banked turns and an elevated supported section. It has no jump gaps or inversions yet. Blender and TypeScript use the same periodic Catmull–Rom curve and lane formula. The runtime resolves registered tracks by ID/version/length and rejects incompatible geometry.

Read [the car brief](assets-cars.md) and [the map brief](assets-dining.md) for modelling details and exact budgets. Reflect manual source edits in the builders if those changes need to survive regeneration.

## Integration and checks

- GLTFLoader loads the actual exported room, road and cars. Wheels rotate about exported axle pivots using measured radii.
- Rendered cards and a parked in-game preview support selection. Body identity belongs to the player, rather than seat order. Solo bots use the remaining bodies.
- Exported gantry lights respond to countdown/race state. Pickups, shields, boosts and hazards use the registered Dining path.
- Asset loading gates race actions and input; errors offer retry. Per-car cloned materials are released without disposing shared model geometry.
- Tests cover route knots, seams, lane spacing, elevation, identity mismatch, server/client agreement and selected-car validation/reconnect. An independent GLB reader compares baked road vertices against runtime positions within 0.00005 world units.
- A development raycast sweep checked 684 camera-to-car views across all four lanes and found no room/road occlusion. Actual browser racing was also inspected.

Run `npm run typecheck`, `bun test` and `npm run build`. Socket integration tests need local loopback access. Check Blender exports and browser rendering after geometry changes.

Final verification: **259 tests pass**, TypeScript checking and production build pass, both Blender builders complete successfully, and the live browser race renders the exported assets. The build retains the existing large-JavaScript-chunk warning. An existing reconnect test's fixed 24-tick assumption was replaced with a bounded wait for the actual checkpoint handoff, which depends on Bot traffic and player IDs.

## Next work

Use this scene to tune manual acceleration/lift, corner risk, contact and camera framing against the approved reference observations. Build a second, more tactical layout after handling is convincing. Full oriented loops, jumps, distinct profiles, voltage tiers, local split-screen and championship progression remain later rewrite work.
