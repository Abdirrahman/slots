# Author corner speed limits as per-Lane simulation data

Tracks will carry **corners** — a stable id, a start and end in Track progress, and one speed
limit per Lane — as authoritative simulation data alongside checkpoints, obstacles and pickup
opportunities. The automatic throttle lifts to the limit of the corner a Car is in or about to
enter, Boost deliberately does not lift, and a Car held over its Lane's limit accumulates
de-slot pressure until it Crashes. This gives Slots the genre's signature tension — a slot car
carrying too much speed through a corner — without a physics engine, and it makes a Boost
charge a decision about *where* to spend it rather than free speed.

Limits are authored numbers, not geometry: the simulation never reads the presentation path's
height or bank, so ADR 0006 still holds and elevation stays presentation-only. `npm run
assets:track` derives the numbers from the layout's own curvature and writes them into the
authored Track, which keeps them honest to the shape a Racer sees.

Inner Lanes take the higher limit. Every Lane shares one progress value, so a Car in the inside
Lane of a turn sweeps the smaller radius at the same progress speed and pulls less lateral
acceleration than one on the outside — the same disagreement between presentation and
simulation that ADR 0006 records as a cost is what makes the inside line quick here. Because a
layout turns both ways, no single Lane is fast all the way round.

The costs are real. A Track's difficulty is now a function of its curvature, so re-authoring a
layout silently re-tunes it and lap times must be re-measured. Corner limits are calibrated
against one reference top speed, so a Car profile far from it would meet a Track authored for
someone else. And a Car dropped into a corner far above the limit de-slots even while braking
flat out; nothing in normal play does that, because the throttle lifts at the braking point,
but Respawn placement and Boost expiry both had to be checked against it.
