# Predict Lane locally and take forward travel from authority

The client will predict the local Car's **Lane** from the Racer's own input on every Track, and
will keep taking its **forward travel** from authoritative snapshots wherever the Track carries
anything that can interrupt it. The two halves of a Car's motion are predicted under different
rules rather than under one switch.

The reason they differ is what decides them. A Lane transition is decided by the Racer and
advanced by the Room at a fixed fraction per tick, so the client can reproduce it exactly and
reconcile against the next snapshot; it is also the only thing a Racer's input moves, so it is
the whole of what the game feels like responding. Forward travel is decided by the Track — a
fixed obstacle, a Hazard, a pickup or a Car ahead can truncate or alter it inside one snapshot
interval — and a progress prediction that overshoots is corrected by snapping the Car backwards,
which is worse than the lag it removes.

Predicting both under one guard is what the client did before, and because every authored Track
carries obstacles and pickups the guard was never satisfied in a real Race: prediction was
effectively off, and a Lane change waited a round trip plus up to a snapshot interval before
anything moved. Measured against a *local* server that was still 70-128 ms of dead time.

Mispredicting a Lane is cheap in a way mispredicting progress is not. If the Room Blocks the
change, the authoritative outcome is already a partial move followed by a return to the source
Lane, so a prediction that ran ahead and then reconciles renders as the rule itself. The
remaining exposure is a Lane edge the Room refuses outright, which it never acknowledges; the
client therefore drops an unacknowledged prediction after half a second rather than holding it.

The costs. The renderer now composes a pose from two sources with slightly different ages, so
the local Car is drawn marginally further across its Lane than authority has it — that is what
prediction means, and it is bounded by one snapshot interval. Lane prediction has to reproduce
the Room's transition arithmetic, so the two can drift apart if one changes without the other;
they share the Lane-change duration on the Car profile, and the prediction is tested against the
authoritative transition rather than against a copy of the formula. ADR 0002 is unchanged: the
Room still decides every Lane change, Blocked or not, and the client renders nothing it has not
either been told or is about to be corrected on.
