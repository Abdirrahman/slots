# Model races as lane state instead of rigid-body physics

Slots will represent each car by progress along an authored track, one of four lanes, transition progress, speed, and effects. Rendering samples the track from that state; a general-purpose physics engine will not determine gameplay. This makes collisions and multiplayer outcomes deterministic and cheap enough for browsers, at the cost of authoring explicit behavior for jumps, loops, and other special track sections.
