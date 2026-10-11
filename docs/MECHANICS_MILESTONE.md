# Racing mechanics — playable pass

Implemented 8 October 2026. Preview: http://127.0.0.1:3031/ . This is an original adaptation of the research recommendations, not a claim to reproduce undocumented GrooveRider physics.

## Single-player entry

- **Play single player** is the primary action at the top of the opening screen. It starts the countdown immediately; a blank name becomes `Player`. No room code or second human is required.
- First-run defaults are three laps, two Easy bots, 3V and automatic throttle/corner braking. Lane changes and item use remain player decisions. Manual driving, higher voltages, other presets and the Dining Cup are available under **Race options**; private multiplayer has its own disclosure.
- Loading, connection and race-start status appear beside the primary action. Repeated starts are blocked while a setup request is pending. Starting a race closes utility panels and focuses the race view; closing in-race settings restores that focus. Results reveal and focus **Race again** so the next action remains visible.
- The previous setup used a non-wrapping flex row with a full-width rules panel. At a 1368px viewport, the Solo button began at x=1762px, outside the visible page. The new layout places the primary action before the garage and wraps optional fields. Browser checks verify an initially visible Start action and no horizontal overflow at desktop, 390px and 320px widths. [Opening screen proof](qa/single-player-start.png).

## Driving and racing

- Manual throttle (`W` / Up), lift on release, and braking (`S` / Down) are available by disabling driving assist. Assist supplies throttle and corner braking and is enabled on first run. Boost still requires a decision about corner risk.
- Adjacent lane changes (`A` / `D` / Left / Right) retain commitment, blocking and the existing bounded input buffer.
- Authored corner data now defines a route-length factor and a physical grip limit in the new presets. Inside lanes cover more progress per unit of travel but tolerate less speed. Outside lanes offer a safer alternative. Straights have no corner grip warning.
- Grip pressure, corner limits, brake lamps and the existing warning sound precede a de-slot. Recovery takes 1.2 simulation seconds, preserves earned progress and gives at least one second of intangible protection until a clear lane is available.
- Club 07 balances acceleration/braking; Hammer 22 trades braking and lane-change speed for top speed; Vector 64 has faster acceleration/lane changes and lower top speed; Prism 91 has stronger braking. These are initial sidegrades, not a proven final balance.
- 3V / 6V / 9V scale acceleration and top speed by 0.78 / 1 / 1.22. Grip and braking remain consistent. 3V is forgiving; 9V requires deliberate braking.
- Humans, configured bots and reconnect takeover bots use the same simulation, contacts, inventory and attack rules. Difficulty changes planning cadence, lookahead, lane priorities, boost judgment and braking errors.

## Pickups and fairness

The leader completing a lap no longer resets the field's pickups in Club or Party.

1. Four stable pickup slots independently move between authored straight-line spawn zones. Position within the zone, lane, item and timing come from server-seeded randomness. All clients receive the same result.
2. Collection schedules a random 6–10 second cooldown. A crate left untouched expires after 20 seconds and enters a new cycle. Initial slots are staggered. Failed placement retries after one second.
3. New positions must clear all cars by at least 10 progress units and their next two seconds of approach at boosted top speed. Positions also clear checkpoint/start lines, corner interiors and boundaries, obstacles, live hazards and other crates.
4. A pulsing smaller crate warns for 1.5 seconds before collection is enabled. The warning remains recognizable with reduced motion enabled through its smaller scale.
5. A car must travel at least 18% of a lap and wait four seconds between collections. Ghosts and recovering cars cannot collect. Full inventories leave the crate available to another racer.
6. Inventory holds at most three charges: up to two boosts, one shield and one mine. `Space` spends boost, `Q` activates a shield, and `E` attempts a mine placement. A mine charge is retained if no safe nearby trailing location exists.
7. Mines retain their visible one-second warning and five-second active lifetime, avoid occupied placements and leave another lane viable.
8. Boost alone causes ordinary contact. `F` commits to a barge while boosting: 0.2 seconds of brighter/larger exhaust windup, then a 0.2-second contact window and a three-second cooldown. Changing lane or shielding provides counterplay. These are provisional timing values.

### Presets

- **Club:** shared item rolls and fixed bot difficulty; no deficit-based item substitution or hidden pace changes.
- **Party:** the same placement and inventory rules. A racer more than 15% of a lap behind may receive boost, or shield if already holding two boosts, instead of a mine. The replacement must be allowed by the authored slot. Leaders retain their speed and earned progress.
- **Time Trial:** solo, zero bots, zero pickups or combat hazards. Records distinguish assist, voltage, laps, track version and the complete handling profile.

The Dining authoring script preserves the safe zones when regenerated. Road geometry and the editable Blender assets are unchanged by this mechanics pass.

## Rematches and progression

- Solo rematch immediately starts a fresh countdown with a fresh race seed.
- Time Trial saves a browser-local personal-best ghost and checkpoint/lap sector marks. Subsequent runs show the translucent ghost and individual sector comparisons.
- Ghost playback is visual only; it cannot draft, obstruct, collect or attack. Only a finished, eligible human run can replace a slower ghost. Bot takeover invalidates record eligibility.
- Best-time keys are versioned separately from old automatic-driving records. Storage failure leaves the race playable. Records are local and do not claim leaderboard integrity.
- The Dining Cup runs three races on the current Dining map at 3V, 6V and 9V, retaining the chosen car, lap count, bot count, difficulty, assist and Club/Party preset. Points are 10 / 6 / 3 / 1; DNFs receive zero. The Cup score persists for the current page session, and a clear overall win stores a local champion badge.
- A garage/leave-race action permits changing car or rules. Touch buttons and standard gamepad controls are available. RT throttles, LT brakes, D-pad changes lanes, A boosts, X shields, B places a mine and Y barges. Physical gamepad testing remains outstanding.

## Validation and limits

- `npm run typecheck` passes.
- `bun test`: **275 passed, zero failed**, including a real WebSocket test for manual throttle/braking, clean Trial eligibility and a one-click voltage rematch.
- `npm run build` passes. Vite reports the existing large Three.js bundle warning.
- New tests cover deterministic safe spawning, clearance, independent lap/timer behavior, progress/inventory gates, Party item substitution without pace changes, deliberate barge windup and shielding, manual driving/recovery, snapshot validation, record isolation, ghost seam interpolation/corruption handling and Cup scoring.
- A controlled three-lap, one-bot Dining simulation across seeds 0–9 with the same Club 07 profile produced median finish times of approximately 62.04s Easy / 57.58s Normal / 56.53s Hard. This checks difficulty ordering in that scenario; it does not establish multiplayer balance.
- Browser QA covers an assisted Club finish, one-click rematch, a clean Trial finish, visible translucent ghost playback alongside a different live lane, saved ghost sector comparisons, all three Cup rounds with accumulated points, and the corrected HUD layout. Browser console checks found no errors.
- Single-player entry QA reproduces the old offscreen button and required-name blocker, then verifies an empty-name one-click start, automatic acceleration, native Enter activation, restored keyboard focus after Settings, a complete one-lap Club race against two Easy bots and a direct rematch countdown. Expanded options also fit the 320px viewport's 305px usable width without horizontal overflow. [Solo race proof](qa/single-player-race.png).

The implementation establishes rules and a playable loop. Enjoyment, newcomer comprehension, 9V tuning, mixed-skill Party outcomes and car balance across more maps still need player playtests. The current Cup deliberately reuses the one completed map. It is not a multi-track championship or a large unlock economy.

Legacy programmatic `{ laps }` configurations retain the earlier automatic rules for the existing simulation fixtures. The current UI always sends an explicit preset, assist and voltage. Protocol version 10 rejects incompatible old clients.
