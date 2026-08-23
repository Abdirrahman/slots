// Regenerates the authored Workshop presentation path from hand-placed control points.
//
//   node tools/generate-track-path.mjs [--write]
//
// The control points below are the handcrafted circuit. This script closes them into a
// Catmull-Rom loop, resamples that loop at uniform arc length so one progress unit is the
// same distance of Track everywhere, derives banking from curvature, and reports the
// measurements that keep the layout drivable (minimum turn radius, maximum grade, flyover
// clearance, and bench footprint).

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TRACK_PATH = join(PROJECT_ROOT, "src", "workshop-track.json");

/** Output path points. More points keep the resampled loop faithful to the authored one. */
const PATH_POINTS = 40;
/** Banking radians per unit of curvature, and the maximum authored bank. */
const BANK_GAIN = 1.9;
const MAX_BANK = 0.25;
/** Curvature is averaged over this arc length before banking, so banks ease in and out. */
const BANK_SMOOTHING = 7;
/** Half the road, including its edge margins, in Track units. */
const ROAD_HALF_WIDTH = 3.3;

// --- Authored corner speed limits (simulation data, not presentation) ---------------------
// Lane spacing must match PROVISIONAL_PRESENTATION.laneSpacing.
const LANE_SPACING = 1.35;
// The reference Car this layout is balanced against: PROVISIONAL_CAR_PROFILE.topSpeedPerSecond.
const REFERENCE_TOP_SPEED = 15;
// Lateral acceleration a Car may carry before it starts to de-slot, in bench units per second
// squared. Raising it makes every corner faster and the Track less demanding.
const CORNER_LATERAL_LIMIT = 7.4;
// Runs shorter than this, and gaps shorter than this, are not worth authoring as corners.
const MIN_CORNER_PROGRESS = 6;
const MERGE_CORNER_GAP = 8;
// A Lane limit is stored no higher than this multiple of the reference top speed.
const MAX_STORED_LIMIT = REFERENCE_TOP_SPEED * 3;

// Travel order. `y` is the authored elevation: the loop climbs to the flyover at the
// crossing (index 8) and passes back underneath it at index 18.
const CONTROL_POINTS = [
  { x: -18.0, y: 2.90, z: 16.4 },  //  0 start/finish, flat straight along the bench edge
  { x: -25.5, y: 2.90, z: 16.4 },  //  1
  { x: -31.0, y: 2.40, z: 12.6 },  //  2 tight far-end hairpin
  { x: -33.2, y: 1.90, z: 5.4 },   //  3
  { x: -32.4, y: 1.50, z: -2.4 },  //  4
  { x: -28.8, y: 1.10, z: -9.2 },  //  5
  { x: -22.6, y: 0.80, z: -14.2 }, //  6
  { x: -14.6, y: 0.45, z: -16.4 }, //  7 back straight, kinked around the vice
  { x: -7.4, y: 0.20, z: -12.6 },  //  8
  { x: 0.0, y: 0.10, z: 0.0 },     //  9 underpass, beneath index 21
  { x: 5.8, y: 0.50, z: 9.4 },     // 10
  { x: 12.0, y: 1.00, z: 15.0 },   // 11
  { x: 20.0, y: 1.40, z: 17.2 },   // 12 long bench-end sweeper
  { x: 28.0, y: 1.60, z: 15.6 },   // 13
  { x: 33.4, y: 1.90, z: 9.4 },    // 14
  { x: 35.0, y: 2.30, z: 1.0 },    // 15
  { x: 33.2, y: 2.80, z: -7.4 },   // 16
  { x: 28.2, y: 3.40, z: -13.8 },  // 17 climb to the flyover
  { x: 20.6, y: 4.20, z: -16.8 },  // 18
  { x: 12.2, y: 5.00, z: -15.0 },  // 19
  { x: 6.0, y: 5.50, z: -9.2 },    // 20 flyover ramp
  { x: 0.0, y: 5.70, z: 0.0 },     // 21 flyover deck, directly over index 9
  { x: -6.4, y: 5.00, z: 9.6 },    // 22 descent
  { x: -12.2, y: 3.80, z: 15.0 },  // 23 sweep back onto the start/finish straight
];




const FINE_SAMPLES = 8_000;

function catmullRom(previous, from, to, following, amount) {
  const squared = amount * amount;
  const cubed = squared * amount;
  return 0.5 * (2 * from
    + (-previous + to) * amount
    + (2 * previous - 5 * from + 4 * to - following) * squared
    + (-previous + 3 * from - 3 * to + following) * cubed);
}

function samplePoint(points, t) {
  const count = points.length;
  const scaled = ((t % count) + count) % count;
  const segment = Math.floor(scaled);
  const amount = scaled - segment;
  const previous = points[(segment - 1 + count) % count];
  const from = points[segment];
  const to = points[(segment + 1) % count];
  const following = points[(segment + 2) % count];
  return {
    x: catmullRom(previous.x, from.x, to.x, following.x, amount),
    y: catmullRom(previous.y, from.y, to.y, following.y, amount),
    z: catmullRom(previous.z, from.z, to.z, following.z, amount),
  };
}

function fineSamples() {
  const samples = [];
  for (let index = 0; index < FINE_SAMPLES; index += 1) {
    samples.push(samplePoint(CONTROL_POINTS, index / FINE_SAMPLES * CONTROL_POINTS.length));
  }
  return samples;
}

function cumulativeLengths(samples) {
  const lengths = [0];
  for (let index = 1; index <= samples.length; index += 1) {
    const from = samples[index - 1];
    const to = samples[index % samples.length];
    lengths.push(lengths[index - 1] + Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z));
  }
  return lengths;
}

/** Signed XZ curvature; positive turns toward the lateral offset direction (-dz, dx). */
function curvatures(samples) {
  return samples.map((_, index) => {
    const previous = samples[(index - 1 + samples.length) % samples.length];
    const current = samples[index];
    const next = samples[(index + 1) % samples.length];
    const dx = (next.x - previous.x) / 2;
    const dz = (next.z - previous.z) / 2;
    const ddx = next.x - 2 * current.x + previous.x;
    const ddz = next.z - 2 * current.z + previous.z;
    const magnitude = Math.hypot(dx, dz);
    return magnitude === 0 ? 0 : (dx * ddz - dz * ddx) / magnitude ** 3;
  });
}

function smoothOverArcLength(values, lengths, window) {
  const total = lengths[lengths.length - 1];
  const spacing = total / values.length;
  const radius = Math.max(1, Math.round(window / 2 / spacing));
  return values.map((_, index) => {
    let sum = 0;
    for (let offset = -radius; offset <= radius; offset += 1) {
      sum += values[(index + offset + values.length) % values.length];
    }
    return sum / (radius * 2 + 1);
  });
}

function interpolateAtLength(samples, lengths, target) {
  const total = lengths[lengths.length - 1];
  const wrapped = ((target % total) + total) % total;
  let low = 0;
  let high = lengths.length - 1;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (lengths[middle] <= wrapped) low = middle;
    else high = middle;
  }
  const span = lengths[low + 1] - lengths[low];
  const amount = span === 0 ? 0 : (wrapped - lengths[low]) / span;
  return { index: low, amount };
}

function build() {
  const samples = fineSamples();
  const lengths = cumulativeLengths(samples);
  const worldLength = lengths[lengths.length - 1];
  const rawCurvature = curvatures(samples);
  const smoothedCurvature = smoothOverArcLength(rawCurvature, lengths, BANK_SMOOTHING);

  const track = JSON.parse(readFileSync(TRACK_PATH, "utf8"));
  const progressLength = track.length;
  const path = [];
  for (let index = 0; index < PATH_POINTS; index += 1) {
    const distance = index / PATH_POINTS * worldLength;
    const { index: sampleIndex, amount } = interpolateAtLength(samples, lengths, distance);
    const from = samples[sampleIndex];
    const to = samples[(sampleIndex + 1) % samples.length];
    const curvature = smoothedCurvature[sampleIndex] * (1 - amount)
      + smoothedCurvature[(sampleIndex + 1) % samples.length] * amount;
    // Positive curvature turns toward the lateral offset direction, so the bank is negated
    // to drop the inside of the turn and raise its outside.
    const bank = -Math.max(-MAX_BANK, Math.min(MAX_BANK, curvature * BANK_GAIN));
    path.push({
      progress: round(index / PATH_POINTS * progressLength, 4),
      x: round(from.x + (to.x - from.x) * amount, 3),
      y: round(from.y + (to.y - from.y) * amount, 3),
      z: round(from.z + (to.z - from.z) * amount, 3),
      bank: round(bank, 4),
    });
  }

  return { track, path, samples, lengths, worldLength, curvature: smoothedCurvature };
}

/**
 * Per-Lane cornering speed limits derived from the layout's own curvature.
 *
 * A Car in Lane L sweeps radius `R - sign(k) * offset(L)` about the turn centre while every
 * Lane shares one progress speed, so the outside Lane pulls the most lateral acceleration
 * and takes the lowest limit. That is the whole decision the Racer is being handed: the
 * inside line is quick and exposed, the outside line is slow and safe.
 */
function cornerLimits(radius, sign, unitsPerProgress) {
  return [0, 1, 2, 3].map((lane) => {
    const offset = (lane - 1.5) * LANE_SPACING;
    const laneRadius = Math.max(0.5, radius - sign * offset);
    const limit = (radius / unitsPerProgress) * Math.sqrt(CORNER_LATERAL_LIMIT / laneRadius);
    return Math.min(MAX_STORED_LIMIT, limit);
  });
}

/** Contiguous stretches whose tightest Lane limit is below the reference Car's top speed. */
function buildCorners({ samples, lengths, worldLength, curvature, track }) {
  const progressLength = track.length;
  const unitsPerProgress = worldLength / progressLength;
  const points = samples.map((_, index) => {
    const value = curvature[index];
    const radius = value === 0 ? Infinity : Math.abs(1 / value);
    const limits = Number.isFinite(radius) ? cornerLimits(radius, Math.sign(value), unitsPerProgress) : null;
    return {
      progress: lengths[index] / worldLength * progressLength,
      limits,
      binding: limits !== null && Math.min(...limits) < REFERENCE_TOP_SPEED,
    };
  });

  const runs = [];
  let open = null;
  for (const point of points) {
    if (point.binding) {
      if (open === null) open = { from: point.progress, to: point.progress, points: [] };
      open.to = point.progress;
      open.points.push(point);
    } else if (open !== null) {
      runs.push(open);
      open = null;
    }
  }
  if (open !== null) runs.push(open);
  // A run that is still open at the seam continues into the first run of the loop.
  if (runs.length > 1 && points[0].binding && points[points.length - 1].binding) {
    const last = runs.pop();
    runs[0] = { from: last.from, to: runs[0].to, points: [...last.points, ...runs[0].points] };
  }

  const merged = [];
  for (const run of runs) {
    const previous = merged[merged.length - 1];
    if (previous !== undefined && (run.from - previous.to + progressLength) % progressLength < MERGE_CORNER_GAP) {
      previous.to = run.to;
      previous.points.push(...run.points);
      continue;
    }
    merged.push({ ...run, points: [...run.points] });
  }

  return merged
    .filter((run) => (run.to - run.from + progressLength) % progressLength >= MIN_CORNER_PROGRESS)
    .map((run, index) => ({
      id: `corner-${String(index + 1).padStart(2, "0")}`,
      fromProgress: round(((run.from % progressLength) + progressLength) % progressLength, 3),
      toProgress: round(((run.to % progressLength) + progressLength) % progressLength, 3),
      // The tightest point of a corner governs the whole corner, so a Racer is never asked
      // to re-read the limit halfway through one.
      laneSpeedLimits: [0, 1, 2, 3].map((lane) =>
        round(Math.min(...run.points.map((point) => point.limits[lane])), 3)),
    }));
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function measure({ samples, lengths, worldLength, curvature, track }) {
  const radii = curvature.map((value) => (value === 0 ? Infinity : Math.abs(1 / value)));
  const minimumRadius = Math.min(...radii);
  let maximumGrade = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const from = samples[index];
    const to = samples[(index + 1) % samples.length];
    const run = Math.hypot(to.x - from.x, to.z - from.z);
    if (run > 0) maximumGrade = Math.max(maximumGrade, Math.abs(to.y - from.y) / run);
  }

  // Closest approach between Track sections that are far apart along the loop: the flyover.
  let clearance = Infinity;
  let separation = Infinity;
  for (let a = 0; a < samples.length; a += 8) {
    for (let b = a + 8; b < samples.length; b += 8) {
      const along = Math.min(lengths[b] - lengths[a], worldLength - (lengths[b] - lengths[a]));
      if (along < 30) continue;
      const first = samples[a];
      const second = samples[b];
      const horizontal = Math.hypot(second.x - first.x, second.z - first.z);
      if (horizontal > ROAD_HALF_WIDTH * 2) continue;
      clearance = Math.min(clearance, Math.abs(second.y - first.y));
      separation = Math.min(separation, horizontal);
    }
  }

  const bounds = ["x", "z", "y"].map((axis) => [
    round(Math.min(...samples.map((sample) => sample[axis])), 2),
    round(Math.max(...samples.map((sample) => sample[axis])), 2),
  ]);

  return {
    worldLength: round(worldLength, 2),
    progressLength: track.length,
    unitsPerProgress: round(worldLength / track.length, 3),
    minimumRadius: round(minimumRadius, 2),
    maximumGradePercent: round(maximumGrade * 100, 1),
    flyoverClearance: Number.isFinite(clearance) ? round(clearance, 2) : "none",
    flyoverHorizontalSeparation: Number.isFinite(separation) ? round(separation, 2) : "none",
    bounds: { x: bounds[0], z: bounds[1], y: bounds[2] },
  };
}

const built = build();
const measurements = measure(built);
console.log(JSON.stringify(measurements, null, 2));

function minimumFailures(values) {
  const failures = [];
  if (values.minimumRadius < ROAD_HALF_WIDTH + 2) failures.push(`minimum radius ${values.minimumRadius} is too tight for the road width`);
  if (values.maximumGradePercent > 26) failures.push(`maximum grade ${values.maximumGradePercent}% is too steep`);
  if (values.flyoverClearance !== "none" && values.flyoverClearance < 4) failures.push(`flyover clearance ${values.flyoverClearance} is too low`);
  return failures;
}

const corners = buildCorners(built);
console.log("corners:", corners
  .map((corner) => `${corner.id} ${corner.fromProgress}..${corner.toProgress} [${corner.laneSpeedLimits.join(", ")}]`)
  .join("\n          "));

if (process.argv.includes("--write")) {
  built.track.corners = corners;
  built.track.presentation = { path: built.path };
  writeFileSync(TRACK_PATH, `${JSON.stringify(built.track, null, 2)}\n`, "utf8");
  console.log(`Wrote ${built.path.length} path points to ${TRACK_PATH}`);
} else {
  console.log(JSON.stringify(built.path, null, 2));
}

function reportTightest({ samples, curvature }) {
  const entries = curvature
    .map((value, index) => ({ index, radius: value === 0 ? Infinity : Math.abs(1 / value), sample: samples[index] }))
    .sort((a, b) => a.radius - b.radius);
  const distinct = [];
  for (const entry of entries) {
    if (distinct.some((other) => Math.hypot(other.sample.x - entry.sample.x, other.sample.z - entry.sample.z) < 8)) continue;
    distinct.push(entry);
    if (distinct.length === 6) break;
  }
  console.log("tightest:", distinct
    .map((entry) => `r=${round(entry.radius, 2)} @ (${round(entry.sample.x, 1)}, ${round(entry.sample.z, 1)})`)
    .join("  "));
}

reportTightest(built);

const failures = minimumFailures(measurements);
if (failures.length > 0) {
  console.error(`Layout rejected: ${failures.join("; ")}`);
  process.exit(1);
}
