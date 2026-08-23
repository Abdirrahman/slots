import { describe, expect, test } from "bun:test";
import {
  COUNTDOWN_TICKS,
  MAX_RACE_DURATION_TICKS,
  SERVER_TICKS_PER_SECOND,
  SNAPSHOTS_PER_SECOND,
} from "../src/multiplayer-config";
import { TICKS_PER_SECOND } from "../src/race";
import { Room } from "../src/room";

function runWithSnapshotSchedule(snapshotAt: (tick: number) => boolean): unknown {
  let raceNumber = 0;
  const room = new Room({
    code: "AB12",
    hostId: "host",
    hostName: "Host",
    createRaceId: () => `race-${++raceNumber}`,
  });
  room.join("guest", "Guest");
  const raceId = room.startRace("host")!;
  for (let tick = 0; tick < COUNTDOWN_TICKS; tick += 1) room.advance();
  room.acceptInput("host", { raceId, seq: 1 });
  room.acceptInput("guest", { raceId, seq: 1 });

  for (let tick = 0; tick < MAX_RACE_DURATION_TICKS && room.phase === "racing"; tick += 1) {
    if (tick === 20) room.acceptInput("host", { raceId, seq: 2, laneChange: 1 });
    if (tick === 50) room.acceptInput("guest", { raceId, seq: 2, laneChange: 1 });
    if (tick === 100) room.acceptInput("host", { raceId, seq: 3, laneChange: -1 });
    room.advance();
    if (snapshotAt(tick)) room.snapshot("host");
  }
  return room.snapshot().race;
}

describe("browser-independent multiplayer timing", () => {
  test("uses the Race core's exact 30 Hz tick and starts snapshots at 15 Hz", () => {
    expect(SERVER_TICKS_PER_SECOND).toBe(TICKS_PER_SECOND);
    expect(SERVER_TICKS_PER_SECOND).toBe(30);
    expect(SNAPSHOTS_PER_SECOND).toBe(15);
  });

  test("different snapshot publication schedules cannot alter authoritative outcomes", () => {
    const everyTick = runWithSnapshotSchedule(() => true);
    const sparseUneven = runWithSnapshotSchedule((tick) => tick % 7 === 0 || tick % 13 === 0);
    expect(sparseUneven).toEqual(everyTick);
    expect((everyTick as { status: string }).status).toBe("finished");
  });
});
