# Slots Racing

Slots is a browser-based arcade slot-car racing game for private sessions between friends. This context defines the language used to describe races, cars, tracks, collisions, power-ups, and rooms.

## Participants

**Player**:
A person participating in or observing a room.
_Avoid_: User, client

**Racer**:
A human player or bot currently controlling a car in a race.
_Avoid_: Driver, competitor

**Bot**:
A server-controlled racer that fills an available racing position or temporarily replaces a disconnected human racer.
_Avoid_: AI player, NPC

**Spectator**:
A player who can watch a race but does not control a car in it.
_Avoid_: Viewer, observer

**Race seat**:
A Room-owned persistent participation record with one stable Car identity and result during a Race. A human-owned Race seat preserves its Car while control changes between its Player and a temporary Bot; a configured-Bot Race seat belongs directly to its Bot.
_Avoid_: Slot, driver record, temporary player

## Racing

**Race**:
One timed competition on a track, ending after its configured number of laps or the post-finish timeout.
_Avoid_: Match, game, round

**Car**:
The miniature vehicle controlled by a racer during a race.
_Avoid_: Vehicle, kart

**Car profile**:
A fixed, balanced combination of top speed, acceleration, and lane-change speed assigned to a car.
_Avoid_: Class, build, loadout

**Track**:
A handcrafted four-lane circuit followed by every car in a race.
_Avoid_: Course, map, level

**Lane**:
One of the track's four discrete lateral car positions.
_Avoid_: Slot, rail

**Lane change**:
A racer-initiated transition from the current lane to one adjacent lane.
_Avoid_: Turn, steering, switch

**Checkpoint**:
A safe track position used to validate progress and select a respawn location.
_Avoid_: Save point, spawn point

**Lap**:
One complete traversal of the track in the intended direction.
_Avoid_: Circuit, loop

## Contact and recovery

**Ordinary collision**:
Non-destructive rear contact in which the trailing car loses speed and remains behind the leading car.
_Avoid_: Rear-end crash, bump

**Blocked lane change**:
A lane change that returns the changing car to its original lane because another car occupies the destination path.
_Avoid_: Side collision, failed turn

**Boosted impact**:
Contact initiated by a boosted car that crashes an unshielded target car.
_Avoid_: Attack, takedown, ram

**Crash**:
A temporary removal caused by an unshielded car hitting an obstacle, hazard, or boosted car.
_Avoid_: Death, elimination, wreck

**Respawn**:
A crashed car's return at the safest lane of its previous checkpoint after the shared recovery delay.
_Avoid_: Reset, revive

**Ghost state**:
The translucent, intangible state after a respawn that lasts until the car has had at least one second and a clear position.
_Avoid_: Invulnerability, spawn protection

## Power-ups and obstructions

**Power-up**:
An immediately activated pickup that grants a boost or shield, or generates a hazard.
_Avoid_: Item, ability, bonus

**Boost**:
A temporary speed increase that also enables boosted impacts.
_Avoid_: Turbo, acceleration pickup

**Shield**:
Temporary protection that absorbs one otherwise crashing impact.
_Avoid_: Armor, immunity

**Hazard**:
A power-up-generated obstruction telegraphed in a random viable lane behind its collector.
_Avoid_: Trap, obstacle

**Track obstacle**:
A fixed, moving, or environmental obstruction authored as part of a track.
_Avoid_: Hazard, trap

## Multiplayer

**Room**:
A private session reached through a room code, containing racers, spectators, and consecutive races.
_Avoid_: Lobby, server, match

**Host**:
The player allowed to configure and start races in a room.
_Avoid_: Owner, administrator

**Room code**:
The short identifier friends use to join a room.
_Avoid_: Invite code, lobby code

**Authoritative race state**:
The canonical race outcome maintained by the server for every room.
_Avoid_: Server truth, master state
