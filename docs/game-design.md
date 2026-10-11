# Slots Game Design

> Current playable rules: [Racing mechanics milestone](MECHANICS_MILESTONE.md). Its Club, Party and Time Trial contracts supersede the automatic-driving, checkpoint-recovery and lap-reset pickup behavior described in the earlier milestone sections below.

Status: accepted on 2026-07-30

This document is the canonical product and gameplay specification for Slots. Domain terminology is defined in [`CONTEXT.md`](../CONTEXT.md); architectural rationale is recorded in [`docs/adr`](./adr/).

## Product boundary

Slots is a personal learning project and browser-based spiritual successor to *Grooverider: Slot Car Thunder*. It is an original game shared through an unlisted website for private sessions between friends.

The project provides:

- desktop-browser play;
- private online rooms for up to four racers;
- solo quick races against bots;
- three handcrafted tracks;
- four immediately available car profiles; and
- a modernized PS2-era low-poly presentation.

The project does not initially provide:

- public matchmaking;
- accounts;
- progression or gameplay unlocks;
- car customization;
- a campaign or practice-only mode;
- a tutorial;
- global leaderboards;
- analytics; or
- monetization.

## Controls and movement

> **Amendment 2026-08-23 (Boost became a spent resource).** "Players control only left and
> right lane changes" no longer holds. Racers also spend Boost charges with `Space`, `W`, or
> `ArrowUp`. Everything else in this section stands: there is still no throttle, no brake and
> no steering, and the Car still moves forward on its own. The reason is recorded under
> [Boost](#boost): a Boost that fires the instant it is collected is not a decision, and the
> de-slot rule below only has teeth if the Racer chooses when to carry too much speed.

- Cars move forward automatically, lifting for authored corners on their own.
- Players control left and right lane changes, and when to spend a Boost charge.
- `ArrowLeft`/`ArrowRight` and `A`/`D` change lane; `Space`, `W`, or `ArrowUp` spend Boost.
- Every track has exactly four permanent lanes.
- A key press begins one adjacent-lane change.
- A successful lane change takes approximately 0.2 seconds, adjusted by the car's lane-change stat.
  At the 30-tick simulation rate that is **six ticks**, which is the number the car profile
  carries; state it in ticks alongside the seconds so the two cannot drift apart again.
- Another lane change may begin immediately after the current transition ends, including one
  the racer pressed slightly early — see [Lane input responsiveness](#lane-input-responsiveness).
- Lane changing is disabled during crashes, respawns, jumps, loops, and other special track transitions.
- Boost cannot be spent while crashed, ghosted, already boosting, or without a charge.
- An outward input from an outside lane is ignored.
- Cars cannot leave the track.

### Lane input responsiveness

> **Amendment 2026-08-23 (early lane presses are held, and lane movement is predicted locally).**
> Two rules are added here. Nothing above is withdrawn: a press still begins one adjacent-lane
> change, a change still takes about 0.2 seconds, and the server still decides every outcome.
>
> The reason. Lane changing is the only control a racer has, so the delay between the press and
> the car moving *is* the game's feel. Two things were adding to it. Presses made during a
> transition were discarded, so lining up a two-lane move meant waiting for the first change to
> visibly finish before pressing again. And the client rendered no lane movement at all until an
> authoritative snapshot carrying the transition arrived — measured at 70–128 ms of dead time on
> a *local* server, before any real network latency.

Lane changing is server-authoritative and deterministic. Two rules keep it responsive without
moving any decision off the server:

- **A lane edge pressed during a transition is held, not dropped.** The room keeps at most one
  such edge and starts it on the first tick the car is free. The edge expires after one of that
  car's own lane changes plus two ticks, so a press never fires a whole lane change after the
  opening the racer was aiming at. A blocked return can outlast that window, which is intended:
  after a bump the racer picks their line again.
- **The client predicts its own lane movement and takes forward travel from authority.** A lane
  transition is the racer's decision and the room advances it by a fixed fraction per tick, so
  the client reproduces it exactly and reconciles against the next snapshot. Forward travel is
  the track's decision — an obstacle, a hazard or a car ahead can cut it short — so it is
  extrapolated only on a track carrying none of those, and interpolated from authority
  otherwise. Predicting a lane change the server later blocks is self-correcting, because a
  blocked change already renders as a partial move followed by a return.

An unacknowledged predicted lane change is dropped after half a second. The room advances its
processed-input sequence only for inputs it accepts, so a refused edge is never acknowledged and
would otherwise leave the local car drawn part-way into a lane it never entered.

Measured on the Workshop Bench against a local server: the rendered car begins moving 16–52 ms
after the press (mean 28 ms, often within a single frame) where it previously could not move at
all for 70–128 ms; and 6 of 6 double taps with both presses inside one frame complete both lane
changes, which before this change completed only the first.

### Authoritative lane input truth table

| Scenario | Deterministic logical outcome |
| --- | --- |
| Lane edge while the Car is settled | It becomes the pending edge and starts a transition on the next tick. |
| Lane edge while a transition is running | It is held as the one buffered edge and acknowledged. Acknowledgement is what stops the client predicting a change it cannot yet show. |
| Second lane edge while one is already held | Rejected. At most one edge is ever held, so a burst of presses cannot queue a run of lane changes. |
| Held edge and the Car becomes free inside the window | It is promoted at that tick's input assembly, from the same pre-tick Car state as every other input, and starts a transition that tick. |
| Held edge and the window closes first | It is discarded and never fires. A blocked return, or a crash and its recovery, both outlast the window. |
| Held edge when control changes between human and Bot | Discarded with the pending edge (Milestone 6 rule 7). |
| Held edge on a Crashed, finished or DNF Car | Never promoted; it expires on the window like any other. |
| Held outward edge from an outside Lane | Promoted normally and then ignored by the lane rules, exactly as a directly pressed one is. |

## Cars and starting positions

Four balanced car profiles are available immediately:

1. balanced;
2. high top speed;
3. fast acceleration; and
4. fast lane changing.

Each profile has top speed, automatic acceleration, braking rate, and lane-change speed. The
braking rate is what the automatic throttle uses to lift for a corner; it is not a player
control. The slowest and fastest top speeds should differ by approximately 5%. A higher top speed is principally offset by slower acceleration, and all profiles should use an equivalent overall stat budget. Crash recovery time is the same for every car.

Multiple racers may choose the same car. Automatic player colors distinguish duplicates but are not user-selectable customization.

Each racer starts in a separate lane. First-race lanes are random; lanes rotate between racers in subsequent races.

## Collisions

### Ordinary rear collision

When a non-boosted trailing car catches a leading car in the same lane:

1. the trailing car loses 30% of its current speed;
2. the leading car is unaffected;
3. the cars do not visually overlap;
4. the trailing car remains constrained behind the leading car; and
5. after reaching an open lane, the trailing car accelerates according to its profile.

### Blocked lane change

Cars in adjacent lanes may travel safely side by side. If a lane change would overlap another car, the changing car visibly bumps it, a collision sound plays, and the changing car returns to its original lane. Neither car loses forward speed. The racer may try again after the bump animation.

If two cars attempt to exchange lanes simultaneously, both changes are rejected and collision feedback plays.

### Authoritative collision truth table

Collision rules use cyclic Track progress and logical Lane occupancy, never rendered geometry. The provisional minimum longitudinal gap is measured in Track-progress units.

| Scenario | Deterministic logical outcome |
| --- | --- |
| Rear contact in one settled Lane | The nearest trailing Car is constrained one minimum gap behind the leading Car; only the trailing Car loses speed. |
| Contact enters / persists | Entry emits one Ordinary collision and applies one speed loss. Persistent contact maintains the gap without another loss; opening a gap or leaving the settled Lane clears contact. |
| Car changes into an occupied destination path | The change is Blocked before logical overlap and enters an authoritative return to its source Lane; forward speeds are unchanged. |
| Blocked return | Return starts from the reached transition progress, occupies both paths, and must finish before another Lane change can begin. A buffered Lane edge waits for it like any other transition, and is discarded if the return outlasts the buffer window. |
| Two Cars exchange Lanes simultaneously | Both claims are Blocked and both return. |
| Two Cars claim one destination Lane | If their longitudinal paths conflict, every conflicting claim is Blocked; separated claims may proceed. |
| Same-tick conflicting claims | Claims are evaluated as one batch from the pre-resolution state; no claim wins through processing order. |
| Three-Car longitudinal chain | Nearest-neighbour gaps are resolved front-to-back; each entering trailing contact is penalized once and every active gap is maintained. |
| Three-Car transition conflict | Every claim in the connected longitudinal/path conflict is Blocked; non-conflicting claims proceed. |
| Finish-line contact | Separation correction is applied before swept Checkpoint and finish validation; each Car receives its own corrected crossing time. |
| Equal position or transition time | Stable Car id order breaks the tie; the lexicographically smaller id is treated as leading. |

Assumption for otherwise unspecified same-destination priority: conflicting claims have no winner. Rejecting all of them is the smallest rule that is symmetric, batch-resolved, and independent of Car storage order.

### Boosted impact

A boosted car that catches an unshielded car crashes the target and continues forward. If the target is shielded, the shield is consumed, the target continues, and the boosted attacker is slowed behind it.

### Milestone 5 deterministic impact order

All interaction times are fractions of corrected forward travel in one simulation tick. Candidates sort by time, then the affected Car id, then interaction kind (`pickup`, `boosted impact`, `fixed obstacle`, `Hazard`), then stable source id. Storage order never resolves a tie.

| Same-tick scenario | Deterministic outcome |
| --- | --- |
| Pickup before impact | The effect activates immediately and may affect the later impact. |
| Pickup exactly at impact | Pickup resolves first. |
| Several crashing causes affect one Car | Resolve in candidate order; the first enters Crash or consumes Shield. Once Crashed, later candidates do nothing. |
| One Shield and several impacts | The first otherwise-crashing impact consumes Shield; a later same-tick impact crashes the Car. |
| Several Cars reach one pickup | Earliest swept crossing wins; exact-time ties use lexicographically smaller stable Car id. |
| Boosted attacker reaches several Cars | Resolve by swept impact time, then target id. Each unshielded target crashes; a shielded target consumes Shield and constrains/slows the attacker as an ordinary contact. |
| Car reaches several fixed obstacles | The earliest obstacle resolves; stable obstacle id breaks an exact-time tie. |

Boost remains active after every Boosted impact until its timer expires. A shielded target slows the boosted attacker to 70% of its impact-entry speed and constrains it one minimum gap behind; this is the only Boosted impact that stops the attacker. Ordinary non-boosted contact retains its existing entry-only penalty.

## Crashing and respawning

An unshielded car crashes after hitting a track obstacle, hitting a hazard, or receiving a
boosted impact. A car also crashes by de-slotting, which no shield prevents; see
[Cornering and de-slotting](#cornering-and-de-slotting).

A crash causes:

1. a spinout with sparks and smoke;
2. a shared several-second recovery delay;
3. respawn in the safest lane at the previous checkpoint;
4. return at full speed; and
5. a translucent ghost state lasting at least one second and until the car no longer overlaps a car or obstruction.

A ghosted car cannot cause or receive collisions. The exact recovery delay is a tuning value shared by all cars.

### Milestone 5 deterministic Crash and recovery rules

Provisional shared values are three seconds of recovery and one second minimum Ghost state. Active Boost and Shield timers continue ticking during Crash/recovery and therefore survive only if time remains. Crash itself does not clear either effect.

Interaction resolution truncates a Car's forward travel at its earliest unshielded Crash point. Checkpoints and finish markers strictly before that point validate; a marker exactly at the Crash time does not. Crash clears Lane transition, blocked return, and ordinary contact and emits one Crash event only on entry. A Crashed Car has zero speed, accepts no movement or Lane-change input, and cannot interact.

Respawn occurs after the shared recovery timer at the most recently validated Checkpoint, or start/finish if none has been validated since the last completed Lap. Respawn speed is exactly the Car profile's normal top speed (the agreed “full speed”), not Boost top speed. The Car enters Ghost state immediately.

Safest-Lane selection considers each Lane at the respawn progress using cyclic Track distance only. For each candidate Lane, find the nearest non-Crashed Car whose logical occupied path includes that Lane and the nearest fixed obstacle or active Hazard in that Lane. Choose the Lane with the greatest nearest clearance; an empty Lane has infinite clearance; ties choose the lower Lane index. Warning Hazards do not block a Lane. If all four Lanes are occupied, the same rule still places the intangible Ghost Car in the best tied Lane, so Respawn never waits.

A Ghost Car moves forward automatically, may change Lanes, validate Checkpoints/Laps, cross the finish, and leave Ghost state. It cannot collect a Power-up, cause or receive ordinary or Boosted Car contact, hit or consume a fixed obstacle or Hazard, or count as an obstruction for Hazard placement. After the one-second minimum, Ghost state ends on the first tick where every occupied path of the Ghost Car has more than the minimum longitudinal gap from every non-Crashed, non-Ghost Car and from every fixed obstacle and active Hazard. These cyclic checks include the Track seam. Until then Ghost continues without a maximum timeout; because it remains drivable and intangible, space becoming available ends Ghost without deadlock.

## Cornering and de-slotting

A slot car carrying too much speed through a corner leaves its slot. That is the signature
tension of the genre, and Slots reproduces it without a physics engine.

Every track authors **corners** as simulation data: a stable id, a start and end in track
progress, and one speed limit per lane. Corners are authoritative, like checkpoints and
obstacles; they are not read from the presentation path's height or bank, which remain
presentation-only under ADR 0006. `npm run assets:track` derives the Workshop Bench's corner
limits from the layout's own curvature and writes them into the authored track.

**Inner lanes carry the higher limit.** Every lane shares one progress value, so a car in the
inside lane of a turn sweeps the smaller radius at the same progress speed and pulls less
lateral acceleration than one on the outside. The inside line is therefore the fast line and
the outside line is the safe one — and because the Workshop Bench turns both ways, no single
lane is quick all the way round.

- The automatic throttle lifts to the limit of the corner it is in, and starts lifting early
  enough to arrive at the limit of a corner ahead.
- **Boost does not lift.** A boosted car holds boost top speed into a corner.
- A car over its lane's limit accumulates **de-slot pressure** in proportion to how far over
  it is. Small overspeeds survive a corner; large ones do not.
- Crossing the warning fraction emits one telegraphed warning, on the rising edge only.
- Reaching the threshold crashes the car with cause `deslot`.
- **Shield does not absorb a de-slot.** Shield protects against boosted impacts, track
  obstacles and hazards. De-slotting is driver error, not an impact.

### Authoritative cornering truth table

Provisional values: braking lookahead 26 progress units, overspeed tolerance 2%, de-slot
threshold 0.45, warning at 30% of the threshold, recovery 0.02 per tick.

| Scenario | Deterministic logical outcome |
| --- | --- |
| Car inside a corner | Its automatic target speed is the corner's limit for the lane it occupies. |
| Car approaching a corner within the braking lookahead | Its target is the speed it can arrive at the limit from, braking at the profile's rate over the remaining distance. |
| Car approaching a corner beyond the lookahead | The corner does not constrain it. |
| Car straddling two lanes mid-change | It is held to the tighter of the two lanes' limits. |
| Corner crossing the track seam | Membership uses cyclic progress, so the corner applies unbroken across the start/finish line. |
| Overlapping corners | Every corner constrains the car; the lowest resulting target wins. Stable id order resolves which corner is reported as active. |
| Car at or under the limit plus tolerance | Pressure decays by the recovery rate, floored at zero. |
| Car over the limit plus tolerance | Pressure grows by `(speed / limit - 1)` per second. |
| Pressure crosses the warning fraction upward | One `deslot_warning` is emitted, naming the corner. It is not re-emitted until pressure has returned below the fraction. |
| Pressure reaches the threshold | The car crashes with cause `deslot`, sourced to the corner id, and its pressure resets to zero. |
| Shielded car reaches the threshold | It crashes. The shield is neither consumed nor consulted. |
| Boost expires mid-corner | The throttle lifts at the braking rate and pressure decays once the car is back under the limit. |
| Track with no authored corners | No lift, no pressure, no de-slot. |
| Crashed or ghosted car | It neither builds pressure nor de-slots. |

De-slot is resolved before lane claims, contact and interactions, from a stable car id order,
so it never depends on car storage order.

Assumption for otherwise unspecified overlapping-corner behaviour: every overlapping corner
constrains the car. Taking the minimum is the smallest rule that cannot be gamed by authoring
a generous corner on top of a tight one.

## Slipstream

A car running in the wake of another gains a bounded top-speed bonus. It closes a gap; it does
not complete an overtake on its own.

Provisional values: the wake reaches 9 progress units back, and the bonus peaks at 12% of top
speed at the minimum longitudinal gap, fading linearly to nothing at the edge of the wake.

| Scenario | Deterministic logical outcome |
| --- | --- |
| Car within the wake of a car sharing one of its occupied lanes | Its top speed is raised by the bonus for that gap, and `drafting` is true. |
| Two or more cars ahead in range | The largest single bonus applies. Bonuses never sum. |
| Gap at or below the minimum longitudinal gap | Contact rules govern instead; no bonus is granted. |
| Gap beyond the wake | No bonus, and `drafting` is false. |
| Leading car crashed, ghosted, finished or DNF | It casts no wake. |
| Trailing car crashed, ghosted, finished or DNF | It takes no slipstream. |
| Drafting car inside a corner | The corner limit still caps it. A slipstream never raises a car above its lane's limit. |
| Same-tick resolution | Bonuses are computed from the pre-tick batch, so no bonus depends on car storage order. |

## Power-ups

Power-ups activate immediately when collected, except Boost, which is banked as a charge and
spent by the racer. Different effects may coexist; collecting an already-active effect refreshes its timer rather than stacking it.

### Boost

> **Amendment 2026-08-23 (Boost is banked, not fired on pickup).** "Power-ups activate
> immediately when collected" no longer holds for Boost. Collecting Boost adds one charge to a
> meter of at most three; the racer spends a charge with the boost control. Duration, speed
> multiplier and boosted impacts are unchanged. The reason: with the de-slot rule above, *when*
> a boost is spent is the most interesting decision in the race, and a boost that fires on
> pickup makes that decision for the racer. Shield and Hazard still activate on collection.

- Collecting Boost adds one charge, to a maximum of three. A collection at the cap is absorbed.
- Spending a charge lasts approximately three seconds and temporarily raises speed.
- Enables boosted impacts.
- Ignores authored corner limits, which is what makes spending it a decision.
- Cannot be chained: a spend is rejected while a boost is already running, so charges cannot be
  stacked into one longer boost.
- Charges survive a crash. They are inventory, not an active effect.

### Authoritative Boost economy truth table

| Scenario | Deterministic logical outcome |
| --- | --- |
| Boost collected below the cap | Charges increase by one; no boost starts and no timer changes. |
| Boost collected at the cap | The pickup is still consumed; charges stay at the cap. |
| Spend with at least one charge, not already boosting | One charge is deducted, the boost timer is set to its full duration, and one `boost_activated` is emitted carrying the charges remaining. |
| Spend with no charge | Nothing happens and nothing is emitted. |
| Spend while already boosting | Rejected; the charge is retained and the running timer is untouched. |
| Spend while crashed, recovering, or ghosted | Rejected; the charge is retained. |
| Spend and a lane change in one input | Both are applied on the same tick; neither blocks the other. |
| Crash while holding charges | Charges are retained across the crash and the respawn. |
| Controller changes between human and bot | Any queued spend is discarded with the queued lane edge (Milestone 6 rule 7). |

### Shield

- Lasts ten seconds or until it absorbs one crashing impact.
- Protects against boosted impacts, track obstacles, and hazards.
- Does not permit leaving the track.

### Hazard

- Appears behind its collector in a randomized lane and track position.
- Is visibly telegraphed before becoming solid.
- Cannot appear underneath a car.
- Must leave at least one viable lane.
- Crashes the first unshielded car to hit it, then disappears.

Power-up opportunities occur in authored track sections, but their active lanes vary between laps. Trailing racers receive mildly favorable power-up weighting; no hidden speed adjustment is applied.

### Milestone 5 deterministic Power-up and Hazard rules

Each authored opportunity has a stable id, Track progress, allowed effects, and one active Lane selected by the Race-owned seeded generator. It can be collected once per Lap, then resets when the Race advances to the next Lap; its next Lane and effect are selected and stored authoritatively. Crashed and Ghost Cars cannot collect. Shield lasts a provisional ten seconds, Boost lasts a provisional three seconds, and collecting an already-active Shield or Boost replaces its remaining timer with the full duration rather than adding time.

Hazard opportunities use authored placement locations rather than arbitrary progress. A location has a stable id, Track progress, and allowed Lanes. Candidate locations must be behind the collector within half a Track length. A candidate Lane is valid only when no non-Crashed, non-Ghost Car is within the minimum longitudinal gap at that progress, no fixed obstacle or warning/active Hazard occupies it there, and at least one of the other three Lanes remains free of fixed obstacles and active Hazards at that progress. The seeded generator chooses uniformly from the stable-id-sorted valid candidates. If none is valid, collection succeeds but creates no Hazard.

A placed Hazard warns for a provisional one second, becomes active on the following tick, remains active for a provisional five seconds, then is removed. Warning Hazards are non-solid. An active Hazard uses swept cyclic collision. The earliest valid Car impact consumes it; exact-time ties use stable Car id. Shield is consumed instead of Crash, but the Hazard is consumed in either case. Ghost and Crashed Cars neither hit nor consume it. Placement, warning, activation, impact, and cleanup are authoritative state/events.

## Tracks

The three release tracks are:

1. Workshop;
2. Neon Bedroom/Arcade; and
3. Garden/Backyard.

All tracks are fixed, handcrafted four-lane circuits with no branches or shortcuts. They may contain jumps, steep drops, banked turns, tunnels, loops, corkscrews, inverted sections, and crossovers.

The initial track should establish fixed obstacles. Later tracks may add moving and environmental obstacles. Every obstruction must be visible early enough for at least one lane change; moving or obscured obstructions receive explicit warnings.

Each track has one authored time-of-day and weather presentation. Physical edge barriers are used where appropriate, backed by an invisible lane constraint.

### Workshop Bench layout

Workshop Bench is a figure-eight laid out on an oversized workbench. It runs 280 progress units over roughly 209 units of bench, starting on a flat straight along the front edge, dropping through the far-end hairpin to bench level at the underpass, then climbing the long bench-end sweeper onto a flyover that crosses back over the underpass with more than four units of clearance. Its two loops are deliberately unequal so each half of the lap has its own rhythm.

Authored corners (ADR 0007) carry the circuit's five turns as per-Lane speed limits: the
front-edge turn, the far-end hairpin, the long bench-end sweeper, the flyover arc, and the
descent back to the start line. They cover about 47% of the lap, and the gaps between them —
39, 40, 17, 44 and 8 progress units — are all shorter than the 56 units a three-second Boost
covers, which is why every Boost on this circuit carries some de-slot risk and why spending one
on a corner's exit is the skilled move.

Authored path points carry height and bank as well as position (ADR 0006). Banking is derived from curvature so the outside lane of every meaningful turn sits above the inside lane, and barriers are placed only where the track is raised or turning hard enough to need them, leaving kerbs to mark the edge elsewhere.

Because lanes share one progress value, a corner tighter than roughly seven times the lane spacing makes the inside and outside lanes cover visibly different distances at the same speed. Layouts therefore hold a minimum turn radius rather than using hairpins as tight as a real slot-car set would. `npm run assets:track` (`tools/generate-track-path.mjs`) regenerates the path from hand-placed control points, resamples it so one progress unit is the same length of track everywhere, derives the per-lane corner speed limits from the resulting curvature, and rejects a layout that breaks the radius, gradient, or flyover-clearance limits.

Changing an authored track's version invalidates local best times for that track, which is the intended behaviour when a layout changes.

## Race format

> **Amendment 2026-08-23 (pace and race distance).** "Default races use three laps and target
> 4–6 minutes" no longer describes the default. The default is now **eight laps**, measured at
> about **2 minutes 50 seconds**. The 4–6 minute band is reachable, but as a host setting.
>
> The arithmetic. The provisional profile used to run a 30-unit top speed, which finished a
> Workshop Bench lap in about **9.3 s** — roughly ten car lengths of bench every second, which
> read as a fast-forward rather than as racing. Top speed is now 15 units per second, about
> five car lengths per second, and a lap measures **21.0 s** solo (19.5–26.4 s in traffic, once
> incidents are counted). Reaching four minutes from a 21-second lap needs **12 laps**, and six
> minutes needs **17**. Twelve to seventeen laps of one 21-second figure-eight asks a racer to
> read the same three obstacles that many times, so the shipped default is eight and the lap
> setting carries anyone who wants the longer race.
>
> What still holds: the 4–6 minute target as a description of a *long* race, the host's control
> of lap count, and everything else in this section. What does not: three laps as the default,
> and the "Known design risks" entry recording the nine-second lap, which this amendment closes.

- Default races use eight laps and measure about 2 minutes 50 seconds.
- The host may configure lap count; twelve laps is about four minutes and seventeen about six.
- Finish order uses authoritative server time displayed to milliseconds.
- When the first car finishes, a 30-second timer starts.
- Racers that have not finished when the timer expires receive DNF.
- Solo races may pause; online races may not.

## Camera, visuals, and audio

- Use an elevated chase camera with the readability and general framing of *Grooverider*.
- Keep all four lanes, upcoming pickups, and obstructions readable.
- Use a PS2-era low-poly aesthetic modernized with current resolution, materials, lighting, and effects.
- Present miniature slot cars in oversized everyday environments.
- Use simple toy-like car models with animated wheels and no detailed interiors.
- Give each car a distinct silhouette, a guide blade and braids under the nose, and a roof glyph set into the roof in a contrasting marking colour, so racers are identifiable without relying on colour.
- Keep every car one unit wide against the 1.35-unit lane spacing, so two cars abreast leave a third of a lane of daylight: tight racing that still reads as separate lanes. See `blender/README.md` for the measurement.
- Show crashes as spinouts, sparks, smoke, and temporary disappearance; do not implement deformation or persistent damage.
- Keep power-up and collision effects strong but avoid obscuring upcoming lanes.
- Open the camera's field of view with speed, bounded, so boost is felt as well as read; pin it
  at rest under `prefers-reduced-motion`. Camera shake scales with the same amount and is small
  enough that the four lanes stay readable at boost top speed.
- Ease the lateral movement of a lane change rather than sliding the car across at a constant
  rate, so a change reads as a car committing to a line instead of a part being moved by a
  machine. Easing is presentation only: it changes where the car is drawn during a transition,
  never the authoritative transition progress that lane occupancy, contact, and corner limits
  are all resolved from.
- Drive tail lamps from car state: dim at a steady speed, bright while losing speed, and lifted
  while de-slot pressure is building, so a racer can read the car in front. Lamps are never at
  full strength by default.
- Show race position, the gaps to the cars either side, boost charges, active effects, and the
  de-slot warning on the HUD. The meters sit in a corner of the stage and never cross the middle
  of the view, where the upcoming lanes are read.
- Use an original high-energy electronic/breakbeat soundtrack, synthesised in the repository
  from Web Audio primitives, running only while a race is live and only after a trusted gesture
  has created the audio context.
- Do not copy *Grooverider* assets, branding, code, distinctive track layouts, music, or UI.

## Rooms and participants

- Players join with a guest display name and room code; no account is required.
- All human racers must mark ready before the host starts.
- The host selects track, lap count, bot count, and bot difficulty.
- Empty racing positions may be filled by bots at the host's choice.
- Solo quick races support easy, normal, and hard bot difficulty.
- Late arrivals spectate until the next race.
- A room supports at most ten spectators.
- If a racer disconnects, a bot takes control immediately.
- A reconnecting racer retakes control at the next checkpoint.
- If the host leaves, host privileges transfer to the longest-connected remaining player.
- Local best times are stored in the browser.

### Milestone 6 resilient Room rules

The canonical persistent participation record is a **Race seat**. A Player is Room membership; a Race seat is the stable Racer participation whose Car persists through controller changes. Spectators are Players without Race seats. A human-owned Race seat and its Car use the owning Player's stable ID; a configured-Bot Race seat uses its Bot's stable ID and has no Player.

1. **Membership and participation.** Room membership records Players, connection state, role, join order, Host capability, and reconnect reservation. At most four Racer Players own human Race seats. Starting a Race freezes the connected human Race seats and any configured-Bot Race seats as participants; disconnecting or reconnecting never recreates their Cars or changes result attribution.
2. **Reconnect tokens.** On create/join the server creates a cryptographically secure 32-byte base64url token scoped to that Room and Player. The browser stores only its own token in `sessionStorage`, keyed by Room code. Each successful reconnect atomically replaces the token; replaced, expired, malformed, and other-Room tokens receive the same rejection. Tokens stay in memory, are delivered only in a targeted identity message, never appear in shared snapshots, and are never logged.
3. **Connection generations.** Each accepted initial connection starts at generation 1. Every successful reconnect increments the Player's generation. Exactly that generation is active.
4. **Replaced sockets.** The server deactivates and closes the previous socket after accepting its replacement. Messages and close events from a stale generation are harmless because every Room mutation verifies the active generation.
5. **Known disconnect takeover.** A known disconnect immediately clears a pending Lane edge. If its Race seat is participating in Countdown or Racing, control changes to Bot at the start of the next `Room.advance()` tick, before that tick's Race input is assembled.
6. **Half-open takeover.** Human input lease expiry at exactly 60 Room ticks since the last accepted heartbeat or Lane input changes control to Bot at the start of that same `Room.advance()` tick, before simulation. Connection membership remains connected until transport closure, but it has no control after lease expiry.
7. **Transition clearing.** Every human/Bot controller transition clears queued Lane edges and cached Bot intent.
8. **Human reclaim.** Reconnect in Open restores human control immediately. Reconnect in Countdown schedules human control for the first Racing simulation tick. Reconnect in Racing first receives a complete snapshot, then remains reclaim-pending until the authoritative tick that emits the next required Checkpoint event for its Car. Results reconnect restores membership only and cannot alter results.
9. **Next Checkpoint.** At reconnect, the reclaim target is the Car's current `nextCheckpointIndex` in the authoritative ordered Track checkpoints. Reclaim occurs after that Checkpoint is crossed and takes effect before input assembly on the following simulation tick. If the Car finishes or becomes DNF first, reclaim is cancelled. Crash/recovery delays crossing; Ghost movement may cross and satisfy it normally.
10. **Pending input.** Human Race input received before reclaim is rejected and never queued or replayed. Reclaim clears both the final Bot intent and all stale human intent.
11. **Host transfer.** On Host disconnect, replacement, reservation expiry, or removal, Host transfers immediately to the connected eligible Player with lowest stable join order, then stable Player ID. Connected Racers are eligible before connected Spectators. Exactly one connected Player is Host whenever any eligible Player is connected. If only Spectators remain in Open or Results and a Race seat is unreserved, the first Spectator is promoted before receiving Host capability; if all four seats remain reserved, the Spectator stays capability-restricted until reservation cleanup frees a seat, then promotion occurs deterministically.
12. **Previous Host reconnect.** Reconnecting restores membership but does not pre-empt the current Host. It may become Host only through a later ordinary transfer.
13. **Spectator admission.** New Players in Countdown, Racing, or Results are Spectators. In Open, new Players receive a Race seat while fewer than four Racer Players are reserved; otherwise they are Spectators.
14. **Next Open phase.** On Results-to-Open rematch, connected Spectators are promoted into unreserved Race seats by join order then Player ID until four seats are filled. Remaining Spectators stay Spectators.
15. **Limits.** A Room supports at most four Racer Players, ten Spectators, and fourteen active connections. Disconnected reconnect reservations count toward the role limit until they expire.
16. **Expiration and reservations.** Reconnect reservations last five minutes of injected server time. Disconnected non-participating memberships are removed after that duration. A Room with no connected Players starts a five-minute empty timer only in Open or Results and expires when the duration elapses. Countdown and Racing do not expire; their Bots and existing bounded Race rules drive them to Results. Expiration removes the Room and all tokens from server memory; reconnect cannot recreate it.
17. **Bot decisions.** A Bot emits ordinary `CarInput` only, now including Boost spends. It reacts on a cadence set by its difficulty, using a stable Race-seat-derived phase. It scores its current and adjacent Lanes over a difficulty-set lookahead: active Hazards and fixed obstacles are impassable, nearby interactive Cars are strongly avoided, and reachable uncollected pickups are a preference weighted by difficulty. Lowest Lane index breaks equal scores. It still has no random mistakes and needs no second random stream.
17a. **Bot difficulty is racecraft, not speed.** Every Bot drives the identical Car profile; difficulty changes only what it decides. Three behaviours separate the levels, and each was measured rather than assumed (a candidate racing three copies of `normal` scores 2.50 at parity, over 56 Races):

   - **Racing line.** Inner Lanes carry the higher corner limit, so a Bot that reads the line moves toward the quicker Lane of the corner it is *approaching*, then holds that Lane once inside it. Taking the line mid-corner is a mistake: a Car changing Lanes occupies both and is held to the tighter of the two limits. This single term is the largest contributor to Bot quality — ignoring the line scores 1.70–2.23, reading it scores 2.45–3.29.
   - **Boost timing.** A Bot measures how much of the run of a Boost charge falls inside a corner and refuses the spend when that exceeds its budget. Waiting for clear track is the wrong rule and was tried first: a three-second Boost covers about 56 progress units, the Workshop Bench's longest straight is 44, so a Bot that waits for room always ends its Boost deep inside the next corner. Spending on a corner's *exit*, where the exposure is nearly over, is the safe moment.
   - **Defending.** A hard Bot holds the Lane a Car is closing on from behind, valued at about what the racing line is worth so it never sits in front of an obstacle or gives up a pickup it was already taking. Measured, defending costs its own driver about 0.2 points a race; it is kept because a hard Bot should read as racing the player rather than merely driving fast.

   Measured ordering in a four-Car field over 24 Races (4 points for a win, 1 for last): hard 3.17, normal 2.83, easy 2.00, with crashes per Race 0.33, 0.88 and 1.27 respectively.

18. **Bot inactive states.** A Bot emits no Lane edge while Crashed/recovering, finished, or DNF. During Ghost state it resumes ordinary Lane selection because every active Car uses the same automatic forward movement contract. It waits for an active blocked/changing Lane transition to finish before requesting another Lane change.
19. **Stale authority.** Old `raceId` commands remain harmless. Connection-wide stale sequences are rejected. Stale generations cannot mutate Room state. Replaced tokens cannot reconnect. All failures at the token boundary use one non-enumerating rejection.

## Technology and performance constraints

Architecture decisions are detailed in ADRs 0001–0008.

- Use TypeScript, Vite, Three.js, WebGL2, native HTML/CSS UI, Web Audio, and WebSockets.
- Keep the authoritative race simulation independent of rendering.
- Do not add a general-purpose physics engine.
- Target current Chrome, Edge, and Firefox on ordinary integrated-graphics laptops.
- Target 60 FPS and treat 30 FPS as the hard minimum.
- Automatically select and adapt low, medium, and high quality profiles.
- Adapt render resolution, shadows, particles, transparency, and post-processing before changing gameplay.
- Prefer baked lighting, compressed textures and glTF assets, instanced repeated geometry, and pooled effects.
- Defer WebGPU until profiling demonstrates a useful benefit without harming browser coverage.

The multiplayer service starts in one geographic region on a free tier. It may move to hosting costing approximately $10 per month if sleeping instances, WebSocket restrictions, or reliability require it.

The game collects no analytics. Operational logs must avoid persistent player identifiers.

## Assets

Car models are generated deterministically by the Blender pipeline in `blender/` and exported as GLB with 512x512 cards; track, scenery, interface, and audio are generated at runtime from source. Use original Blender assets and legal zero-cost assets as useful. Any imported asset must have explicit terms permitting its use in this project, and those terms must be followed even when the asset is free.

Maintain an asset manifest recording:

- asset and creator name;
- source URL;
- license or applicable terms;
- required attribution;
- modifications; and
- where the asset is used.

Do not use assets whose permissions cannot be established.

## Delivery

The project is built by one person with an LLM coding agent, without a fixed deadline or initial asset budget.

### Phase 1: deterministic offline simulation

Implement track progress, four-lane state, automatic acceleration, lane changes, collision rules, power-up timers, crashing, and ghost respawns. Add focused automated checks for every race-critical rule.

### Phase 2: grey-box browser race

Render one representative track with placeholder cars, elevated camera, keyboard input, HUD, lap counting, finish state, bots, and all three power-ups.

### Phase 3: authoritative multiplayer

Add room codes, lobby readiness, two-to-four-player races, authoritative rule processing, interpolation, local input prediction, reconnect and bot takeover, host transfer, and spectators.

### Phase 4: vertical slice

The vertical slice succeeds when four remote players can repeatedly complete races on one representative track with all four car profiles, bots, all three power-ups, authoritative collisions under realistic latency, and acceptable performance. Placeholder art and audio are acceptable.

### Phase 5: finished personal game

Replace placeholders with cohesive legal assets, complete all three tracks, add final lighting/effects/audio, complete browser and integrated-GPU performance testing, and deploy the unlisted site.

## Validation priorities

- Deterministic tests for lane conflicts, rear collisions, boosted impacts, shields, hazards, laps, ghost respawns, corner limits, de-slotting, slipstream, and the boost economy.
- Bot difficulty measured by finishing position against a fixed reference bot, not asserted from its settings.
- **Every authoritative event type round-tripped through the client's own parser, and at least one complete race driven to results with every snapshot and event batch validated.** Adding a rule to the simulation adds a shape to the wire, and the client validates strictly enough to drop the connection when it meets one it does not know. Unit tests cannot reach this: the rules that broke it only fire once a bot spends a charge or a car crashes while drafting, minutes into a race.
- Multi-client tests for two-to-four racers, disconnect/reconnect, host transfer, spectators, and finish timing.
- Network tests under added latency and packet loss.
- Performance tests on integrated graphics in Chrome, Edge, and Firefox.
- License review against the asset manifest before deployment.

## Known design risks

- Top speed may dominate despite the 5% range; tune stat budgets through bot simulation and multiplayer playtesting.
- Random hazards may feel unfair; preserve telegraphing, safe placement, and a viable lane.
- Full-speed respawns may reduce crash penalties beyond the recovery delay; measure race outcomes before changing the agreed behavior.
- Free hosting may sleep or restrict persistent WebSockets; upgrade only after the limitation is observed.
- No tutorial or settings may reduce approachability; make rules legible through HUD icons and audiovisual feedback.
- Art production may dominate the schedule; do not produce all three polished environments before the vertical slice works.
- ~~Provisional car speeds finish a Workshop Bench lap in about nine seconds, so a three-lap race is far shorter than the 4–6 minute target.~~ Closed 2026-08-23 by the pace amendment under "Race format": a lap is now 21.0 s and the default race is eight laps.
- De-slotting punishes a badly spent boost with a three-second recovery, which is a heavy price for one mistake. The warning is telegraphed and the pressure model makes small overspeeds survivable, but the threshold still needs a playtesting pass with human racers rather than bots.
- Boost charges give a trailing racer a bankable resource, which may compound with the trailing-racer power-up weighting. Measure collected charges by finishing position before adjusting either.
- Corner limits are derived from the layout's curvature by `npm run assets:track`, so re-authoring a track silently re-tunes its difficulty. Re-measure lap times after any layout change.
