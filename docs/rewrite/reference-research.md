# Grooverider reference research

Research date: 8 October 2026. Scope: identify the PS2 reference and separate a defensible feature baseline from details that require hands-on measurement. This note does not claim a completed frame-by-frame parity study.

## Identity and source quality

The likely reference is **GrooveRider: Slot Car Racing**, the PS2 title on [publisher System 3's product page](https://system3.com/product/grooverider-slot-car-racing/). The contemporary Encore material uses **Grooverider: Slot Car Thunder**. Treat these as the intended reference family, but record the user's actual PS2 disc region and build before calibrating handling. Do not silently mix PS2, Xbox, and GameCube observations.

The strongest accessible sources were the publisher's PS2 feature page and its original screenshots. A reproduced Encore announcement is primary-authored marketing material, with a pre-release limitation. Recorded gameplay supplies direct visual evidence; a player's spoken explanation is a firsthand account, not a controller-input trace. A readable original PS2 instruction manual was not located in this research pass. Aggregator summaries, retail listings, cheats, and retrospective reviews were used only for discovery, not as the authority for exact implementation rules.

## Verified baseline versus inference

| Topic | Evidence | Confidence and consequence |
|---|---|---|
| Lanes | Publisher explicitly describes four lanes. [PS2 product page](https://system3.com/product/grooverider-slot-car-racing/) | High. Four-lane racing is a parity requirement. |
| Car power tiers | Publisher lists 3, 6 and 9 volts. [PS2 product page](https://system3.com/product/grooverider-slot-car-racing/) | High for tiers; their speed, grip and AI relationships require measurement. |
| Core actions/items | Publisher lists lane changing, barging, boosts, lane locks, mine dropping, shields and power-ups. [PS2 product page](https://system3.com/product/grooverider-slot-car-racing/) | High for existence. Durations, targeting, stacking and damage rules are unspecified. |
| Environments | Dining Room, Bedroom, Living Room, Kitchen and Roof Garden. [PS2 product page](https://system3.com/product/grooverider-slot-car-racing/) | High. These are themes, not verified circuit layouts. |
| Cars | British Classics, 70s Cop Show, Stock Cars, GT 24-Hour, Formula X and Japanese GT; publisher advertises over 40 models. [PS2 product page](https://system3.com/product/grooverider-slot-car-racing/) | High for marketed families; variants versus unique meshes and exact roster need inventory. |
| Modes/player count | Publisher lists Arcade and Championship for one or two players. [PS2 product page](https://system3.com/product/grooverider-slot-car-racing/) | High. Distinguish local human players from total racers. |
| Track count | Encore announced four tracks in each of five locations, plus loops and traps. [8 May 2003 press release reproduction](https://www.nintendoworldreport.com/forums/?topic=3488) | Primary-authored pre-release claim. Do not treat 20 as an independently verified shipped PS2 count. |
| Manual acceleration | PS2 footage shows speed 000 while the player tries X, followed by motion as he reports left-stick-up acceleration at 1:54–1:58. [Footage at 1:45](https://www.youtube.com/watch?v=TEFiMp70n9Y&t=105s) | Medium. Strong evidence for player-controlled forward speed; exact mapping lacks a manual/input overlay. |
| Brake/reverse | No primary control table inspected. | Unknown. Do not present an exact button map or braking equation as reference behavior. |
| Lane lock semantics | Publisher names the item but does not define its effect. | Unknown. “Temporarily disables rivals' lane changes” is a hypothesis to test, not established parity. |
| Race length | Official screenshots show three-lap races; inspected PS2 footage shows five laps. [Official screenshot](https://system3.com/wp-content/uploads/2023/10/Grooverider-Screens01.jpg), [PS2 footage](https://www.youtube.com/watch?v=TEFiMp70n9Y&t=105s) | High that both examples exist. Universal lap count is unverified; make race length event data. |
| Unlock progression | A 3-volt championship result visibly unlocks the 3-volt Bedroom and awards cars. [Footage at 11:59](https://www.youtube.com/watch?v=TEFiMp70n9Y&t=719s) | High for this example. Exact full unlock graph is unverified. |
| Exact handling | No game code, telemetry, or repeatable input recording available. | Unknown: acceleration curve, drag, lane transition time, safe corner speed, derail threshold and recovery penalty must be calibrated. |

## What the official images actually establish

The publisher gallery was inspected directly in the browser. The following are observations of static images, so they establish visual composition and local geometry, not how animated hazards or physics behave.

| Publisher image | Directly visible details | Implication for the rewrite plan |
|---|---|---|
| [Screens01](https://system3.com/wp-content/uploads/2023/10/Grooverider-Screens01.jpg) | Narrow slot track climbs sharply in front of a large washing machine; glowing lane elements; rear chase camera and oversized room props. | Build believable miniature scale and steep track sections; avoid treating the route as a flat tabletop ribbon. |
| [Screens02](https://system3.com/wp-content/uploads/2023/10/Grooverider-Screens02.jpg) | Broad curved track beside a lit fireplace; purple HUD item labelled JUMP. | Track hazards and item states need distinct visual language. The image alone does not establish jump duration, trajectory or immunity. |
| [Screens04](https://system3.com/wp-content/uploads/2023/10/Grooverider-Screens04.jpg) | Plants, trellis, city backdrop and a track passing overhead. | Rooftop theme includes layered route geometry and a larger world beyond the circuit. |
| [Screens03](https://system3.com/wp-content/uploads/2023/10/Grooverider-Screens03.jpg) | Steep rising track, lane markers and city seen outside. | Camera anticipation and track orientation must survive major elevation changes. |
| [Screens07](https://system3.com/wp-content/uploads/2023/10/Grooverider-Screens07.jpg) | Track approaches an open fireplace; an illuminated rail runs forward. | Author the hazard's safe route, telegraph and sight line with the track, then dress the room. |
| [Screens06](https://system3.com/wp-content/uploads/2023/10/Grooverider-Screens06.jpg) | Track curves among large furniture legs beneath a staircase; position four appears in HUD. | Household furniture frames the racing route and communicates scale. |
| [Screens09](https://system3.com/wp-content/uploads/2023/10/Grooverider-Screens09.jpg) | A full vertical loop beneath a dining table, with chairs and a four-slot approach curve. | Loops require continuous track frames and camera rules; a decorative loop model is insufficient. |

These support the broad design language: black modular toy track, metal rails, bold edge treatment, lanes with local effects, miniature cars, household-scale set pieces and a close chase view. Exact circuit topology, route lengths, splits/merges, obstacle timing and decorative asset placement remain to be inventoried.

## Footage catalog and evidence limits

- [Nerd³ FW — PS2 recording](https://www.youtube.com/watch?v=TEFiMp70n9Y), published 11 June 2015: inspected the start, acceleration-discovery and championship unlock moments above. The game image is primary evidence; spoken commentary is corroborating evidence. No controller overlay is present. Other sections were not exhaustively annotated.
- [GXZ95 — PS2 Dining Room recording](https://www.youtube.com/watch?v=L05mbxceh3s), published 30 October 2011: useful candidate for a controlled Dining Room visual inventory; discovered but not frame-by-frame inspected in this pass.
- [RetroDetect — PS2 multiplayer recording](https://www.youtube.com/watch?v=YGDX-xxwVRA), published 29 May 2015: useful candidate to verify split-screen behavior and human controls; discovered but not directly inspected in this pass.

Do not turn uploader descriptions into facts about exact controls, track counts, performance or physics.

## Recommended observation protocol before production lock

This is proposed project work, not a claim about the original game's internal implementation.

1. **Freeze the reference build.** Record title, region, disc identifier, console/emulator version, refresh rate and controller configuration. Prefer a legally acquired PS2 copy. Do not compare PAL and NTSC timings without normalizing elapsed seconds.
2. **Obtain the control table.** Photograph or scan the owned manual and inspect the game's control/options screens. Record accelerate, coast, brake/reverse, lane left/right, item activation, alternate item action, camera and pause. Distinguish held versus pressed actions, analog range and any configurable mapping.
3. **Record reproducible runs.** Capture gameplay with a controller overlay or synchronized controller video. Use the same car, tier, course, lane and launch condition. Run neutral, partial and full throttle tests; release/coast tests; braking tests; repeated single and held lane commands. Use at least five repeats per condition and record dispersion.
4. **Measure feel in time units.** Extract time to speed bands, top speed on a straight, braking/coast decay, lane-change initiation and completion, command buffering, collision slowdown, derail/recovery time and post-respawn immunity. Convert video frames to seconds using actual capture rate. Do not infer world metres from a decorative room prop.
5. **Test corners and stunts.** Repeat the same corner in every lane at increasing entry speeds, with and without boosts, for every voltage tier. Test loops, gaps, landings, splits and merge transitions independently. A safe-speed curve or derail model in the new game is a design model until these trials validate it.
6. **Isolate each item.** In two-player play record activation, target selection, visible cue, collision, duration, immunity, stacking, expiration and recovery. For lane lock specifically test the activator, every rival, held versus new lane commands, shields, jumping, respawn and recast. Determine whether it locks cars, track gates or both.
7. **Inventory the campaign.** Record each event's room, tier, available cars, lap count, entrants, point awards, unlock conditions and save behavior. Separate a new circuit from a modified obstacle configuration or tier replay. Build an evidence-linked unlock graph.
8. **Map the track grammar.** For each circuit annotate a complete lap: straight, turn, banking, rise/drop, loop, gap, split, merge, switch, pickup, lane effect, moving hazard, route choice, checkpoint and camera event. Capture a topological diagram plus sight-line screenshots; do not trace original art into production assets.
9. **Approve a parity sheet.** Label every rule as observed, measured, inferred or intentionally redesigned. Store clip timestamps and confidence beside each claim. Freeze measurable tolerances for the first graybox slice before expanding to five environments.

## Planning consequences

- Include player speed control in the first prototype and a measurement gate for its exact behavior; current automatic movement should not be assumed equivalent.
- Four lanes and lane transitions are necessary but insufficient. The authored route must provide meaningful lane choices through items, hazards, overtaking and speed tradeoffs.
- Build and validate a real 3D track frame supporting loops and overpasses before expanding the environment library.
- Keep voltage tuning, item behavior, lap rules and progression as explicit authored data.
- Use room themes, miniature scale and the original's route grammar as inspiration for original environments. The rewrite plan should commission new meshes, textures, branding, UI and audio rather than rely on extracted game assets.
- Clearly label proposed launch content counts and milestones as new-project scope. The accessible evidence is not a license to invent “exact parity” counts or handling values.
