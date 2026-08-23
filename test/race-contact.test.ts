import { describe, expect, test } from "bun:test";
import {
  PROVISIONAL_CONTACT,
  SYNTHETIC_CIRCULAR_TRACK,
  advanceRace,
  createRace,
  type CarProfile,
  type CarState,
  type RaceCarStart,
  type RaceState,
  type Track,
} from "../src/race";

const profile: CarProfile = {
  accelerationPerSecondSquared: 0,
  topSpeedPerSecond: 10_000,
  brakingPerSecondSquared: 10_000,
  laneChangeDurationTicks: 4,
};

function race(cars: readonly Omit<RaceCarStart, "profile">[], track = SYNTHETIC_CIRCULAR_TRACK): RaceState {
  return createRace({
    track,
    configuration: { laps: 1 },
    cars: cars.map((car) => ({ ...car, profile })),
  });
}

function car(state: RaceState, id: string): CarState {
  return state.cars.find((candidate) => candidate.id === id)!;
}

function gap(trailing: CarState, leading: CarState, length = SYNTHETIC_CIRCULAR_TRACK.length): number {
  return ((leading.progress - trailing.progress) % length + length) % length;
}

describe("ordinary rear contact", () => {
  test("detects swept contact, prevents tunneling, slows only the trailing Car, and maintains the gap", () => {
    const initial = race([
      { id: "lead", lane: 1, progress: 50, speed: 0 },
      { id: "trail", lane: 1, progress: 0, speed: 6_000 },
    ]);
    const first = advanceRace(initial, {});
    const leading = car(first.state, "lead");
    const trailing = car(first.state, "trail");

    expect(first.events.filter((event) => event.type === "ordinary_collision")).toHaveLength(1);
    expect(trailing.speed).toBe(4_200);
    expect(leading.speed).toBe(0);
    expect(gap(trailing, leading)).toBeCloseTo(PROVISIONAL_CONTACT.minimumLongitudinalGap);

    const second = advanceRace(first.state, {});
    expect(second.events.some((event) => event.type === "ordinary_collision")).toBe(false);
    expect(car(second.state, "trail").speed).toBe(4_200);
    expect(gap(car(second.state, "trail"), car(second.state, "lead"))).toBeCloseTo(2);
  });

  test("sweeps contact across the cyclic seam", () => {
    const result = advanceRace(race([
      { id: "lead", lane: 2, progress: 1, speed: 0 },
      { id: "trail", lane: 2, progress: 115, speed: 240 },
    ]), {});

    expect(result.events.some((event) => event.type === "ordinary_collision")).toBe(true);
    expect(car(result.state, "trail").progress).toBeCloseTo(119);
    expect(gap(car(result.state, "trail"), car(result.state, "lead"))).toBeCloseTo(2);
  });

  test("clears separated contact so a later catch is a new entry", () => {
    const contacted = advanceRace(race([
      { id: "lead", lane: 0, progress: 10, speed: 0 },
      { id: "trail", lane: 0, progress: 0, speed: 600 },
    ]), {}).state;
    const separated: RaceState = {
      ...contacted,
      cars: contacted.cars.map((value) => value.id === "lead" ? { ...value, speed: 300 } : { ...value, speed: 0 }),
    };
    const open = advanceRace(separated, {}).state;
    expect(car(open, "trail").ordinaryContact).toBeNull();

    const recatch: RaceState = {
      ...open,
      cars: open.cars.map((value) => value.id === "trail" ? { ...value, speed: 900 } : { ...value, speed: 0 }),
    };
    expect(advanceRace(recatch, {}).events.filter((event) => event.type === "ordinary_collision")).toHaveLength(1);
  });

  test("resolves three- and four-Car chains front-to-back without overlap", () => {
    for (const count of [3, 4]) {
      const starts = Array.from({ length: count }, (_, index) => ({
        id: `car-${index}`,
        lane: 1 as const,
        progress: (count - index) * 5,
        speed: index * 300,
      }));
      const result = advanceRace(race(starts), {});
      const ordered = [...result.state.cars].sort((a, b) => b.progress - a.progress);
      for (let index = 1; index < ordered.length; index += 1) {
        expect(gap(ordered[index]!, ordered[index - 1]!)).toBeGreaterThanOrEqual(2 - 1e-9);
      }
      expect(result.events.filter((event) => event.type === "ordinary_collision")).toHaveLength(count - 1);
    }
  });

  test("uses stable ids for exact ties and is independent of Car storage order", () => {
    const initial = race([
      { id: "a", lane: 1, progress: 10, speed: 0 },
      { id: "b", lane: 1, progress: 10, speed: 0 },
      { id: "c", lane: 1, progress: 5, speed: 300 },
    ]);
    const reversed = { ...initial, cars: [...initial.cars].reverse() };
    const canonical = (state: RaceState) => [...state.cars].sort((a, b) => a.id < b.id ? -1 : 1);
    const first = advanceRace(initial, {});
    const second = advanceRace(reversed, {});

    expect(second.state).toEqual(first.state);
    expect(canonical(second.state)).toEqual(canonical(first.state));
    expect(second.events).toEqual(first.events);
    expect(car(first.state, "b").ordinaryContact?.leadingCarId).toBe("a");
  });

  test("validates finish crossing from corrected travel", () => {
    const finishTrack: Track = {
      id: "contact-finish",
      length: 100,
      lanes: [{ index: 0 }, { index: 1 }, { index: 2 }, { index: 3 }],
      startFinish: 0,
      checkpoints: [{ id: "one", progress: 20 }, { id: "two", progress: 50 }, { id: "three", progress: 80 }],
    };
    const initial = race([
      { id: "lead", lane: 1, progress: 98, speed: 90 },
      { id: "trail", lane: 1, progress: 95, speed: 300 },
    ], finishTrack);
    const ready = {
      ...initial,
      cars: initial.cars.map((value) => ({ ...value, nextCheckpointIndex: 3 })),
    };
    const result = advanceRace(ready, {});

    expect(car(result.state, "lead").result).toBe("finished");
    expect(car(result.state, "trail").result).toBe("racing");
    expect(result.events.filter((event) => event.type === "finish").map((event) => event.carId)).toEqual(["lead"]);
  });
});

describe("batched Lane claims and blocked return", () => {
  test("blocks a destination occupied by a settled Car and returns from reached progress", () => {
    const first = advanceRace(race([
      { id: "changing", lane: 0, progress: 10 },
      { id: "settled", lane: 1, progress: 10 },
    ]), { changing: { laneChange: 1 } });

    expect(car(first.state, "changing").laneTransition).toEqual({
      from: 0, to: 1, progress: 0.25, phase: "returning",
    });
    expect(first.events.some((event) => event.type === "blocked_lane_change")).toBe(true);
    const second = advanceRace(first.state, { changing: { laneChange: 1 } });
    expect(car(second.state, "changing").lane).toBe(0);
    expect(car(second.state, "changing").laneTransition).toBeNull();
  });

  test("constrains swept blocked-return paths without changing forward speed", () => {
    const result = advanceRace(race([
      { id: "changing", lane: 0, progress: 0, speed: 600 },
      { id: "settled", lane: 1, progress: 10, speed: 0 },
    ]), { changing: { laneChange: 1 } });
    const changing = car(result.state, "changing");
    const settled = car(result.state, "settled");

    expect(changing.laneTransition?.phase).toBe("returning");
    expect(changing.speed).toBe(600);
    expect(gap(changing, settled)).toBeCloseTo(PROVISIONAL_CONTACT.minimumLongitudinalGap);
  });

  test("does not begin a new change while a blocked return is active", () => {
    const initial = race([{ id: "car", lane: 1, progress: 10 }]);
    const returning: RaceState = {
      ...initial,
      cars: [{ ...initial.cars[0]!, laneTransition: { from: 1, to: 2, progress: 0.75, phase: "returning" } }],
    };
    const result = advanceRace(returning, { car: { laneChange: -1 } });
    expect(car(result.state, "car").laneTransition).toEqual({ from: 1, to: 2, progress: 0.5, phase: "returning" });
  });

  test("blocks simultaneous exchanges as one batch", () => {
    const result = advanceRace(race([
      { id: "a", lane: 0, progress: 10 },
      { id: "b", lane: 1, progress: 70 },
    ]), {
      a: { laneChange: 1 },
      b: { laneChange: -1 },
    });
    expect(result.state.cars.every((value) => value.laneTransition?.phase === "returning")).toBe(true);
  });

  test("blocks every conflicting same-destination claim but permits separated claims", () => {
    const starts = [
      { id: "a", lane: 0 as const, progress: 10 },
      { id: "b", lane: 2 as const, progress: 10 },
    ];
    const blocked = advanceRace(race(starts), {
      a: { laneChange: 1 },
      b: { laneChange: -1 },
    });
    expect(blocked.state.cars.every((value) => value.laneTransition?.phase === "returning")).toBe(true);

    const separated = advanceRace(race([{ ...starts[0]! }, { ...starts[1]!, progress: 20 }]), {
      a: { laneChange: 1 },
      b: { laneChange: -1 },
    });
    expect(separated.state.cars.every((value) => value.laneTransition?.phase === "changing")).toBe(true);
  });

  test("blocks a three-Car destination conflict and remains stable under permutation", () => {
    const initial = race([
      { id: "a", lane: 0, progress: 10 },
      { id: "b", lane: 1, progress: 10 },
      { id: "c", lane: 2, progress: 10 },
    ]);
    const inputs = {
      a: { laneChange: 1 as const },
      b: { laneChange: 1 as const },
      c: { laneChange: -1 as const },
    };
    const first = advanceRace(initial, inputs);
    const second = advanceRace({ ...initial, cars: [initial.cars[2]!, initial.cars[0]!, initial.cars[1]!] }, inputs);
    const phases = (state: RaceState) => Object.fromEntries(state.cars.map((value) => [value.id, value.laneTransition?.phase]));

    expect(phases(first.state)).toEqual({ a: "returning", b: "returning", c: "returning" });
    expect(phases(second.state)).toEqual(phases(first.state));
    expect(second.events).toEqual(first.events);
  });
});
