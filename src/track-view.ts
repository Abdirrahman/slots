import * as THREE from "three";

import { PROVISIONAL_PRESENTATION, sampleTrackPose, type TrackPose } from "./presentation";
import type { HazardState, LaneIndex, Track } from "./race";

/**
 * Builds the visible slot Track from the same authored samples the simulation poses use:
 * a moulded plastic road with Lane grooves and braids, kerbs, barriers where the Track
 * needs them, the support pylons that hold its raised sections over the bench, and the
 * start/finish gantry.
 */
export const TRACK_VIEW = Object.freeze({
  /** Samples around the loop. One section is about six samples wide. */
  segments: 520,
  /** Distance between the moulded section seams, in Track progress. */
  sectionProgress: 7,
  roadThickness: 0.34,
  kerbLane: 0.16,
  kerbWidth: 0.34,
  kerbHeight: 0.075,
  grooveWidth: 0.14,
  grooveLift: 0.009,
  braidOffset: 0.15,
  braidWidth: 0.075,
  barrierHeight: 0.62,
  barrierThickness: 0.1,
  barrierLane: 0.26,
  /** Barriers are authored where the Track is raised or turning hard enough to need them. */
  barrierRaisedHeight: 1.1,
  barrierBankThreshold: 0.1,
  pylonProgressSpacing: 9,
  pylonMinimumHeight: 0.75,
  pylonRadius: 0.34,
  startLineProgress: 1.7,
});

const COLORS = Object.freeze({
  road: 0x30343a,
  roadSeam: 0x3d434a,
  underside: 0x1b1e22,
  edge: 0x1f2226,
  groove: 0x0a0c0e,
  braid: 0xb87a3d,
  kerbLight: 0xe6e2d5,
  kerbDark: 0xd8452f,
  barrierPost: 0xdfe3e6,
  barrierRail: 0xe4442c,
  pylon: 0x8e959c,
  pylonFoot: 0x4a5057,
  gantry: 0x2b3138,
});

export interface TrackView {
  readonly group: THREE.Group;
  readonly startLights: readonly THREE.Mesh[];
}

interface Edge {
  readonly lane: number;
  readonly height: number;
}

/** Surface normal of the banked Track, used for every height offset above the road. */
function surfaceUp(pose: TrackPose): THREE.Vector3 {
  return new THREE.Vector3(
    Math.sin(pose.bank) * Math.cos(pose.heading),
    Math.cos(pose.bank),
    -Math.sin(pose.bank) * Math.sin(pose.heading),
  );
}

export function surfacePoint(track: Track, progress: number, lane: number, height: number): THREE.Vector3 {
  return surfaceOffset(sampleTrackPose(track, progress, lane), height);
}

/** A point `height` above the banked Track surface at an already sampled pose. */
export function surfaceOffset(pose: TrackPose, height: number): THREE.Vector3 {
  return new THREE.Vector3(pose.x, pose.y, pose.z).addScaledVector(surfaceUp(pose), height);
}

/**
 * Sits an object on the Track surface in the Track's own frame: heading around the bench,
 * pitch along the climb, and roll across the bank. `spin` and `roll` add presentation-only
 * rotation such as a crash spinout or a blocked Lane-change lean.
 */
export function placeOnSurface(
  object: THREE.Object3D,
  pose: TrackPose,
  height: number,
  spin = 0,
  roll = 0,
): void {
  object.position.copy(surfaceOffset(pose, height));
  object.rotation.set(-pose.pitch, pose.heading + spin, -pose.bank + roll, "YXZ");
}

/**
 * A ribbon between two Lane/height edges. `from`/`to` are Track progress; a full loop wraps
 * so the seam closes exactly on the authored sample rather than on a duplicated vertex.
 */
function ribbon(
  track: Track,
  left: Edge,
  right: Edge,
  options: { from?: number; to?: number; steps?: number; uRepeat?: number } = {},
): THREE.BufferGeometry {
  const closed = options.from === undefined;
  const from = options.from ?? 0;
  const to = options.to ?? track.length;
  const steps = options.steps ?? Math.max(2, Math.round((to - from) / track.length * TRACK_VIEW.segments));
  const count = closed ? steps : steps + 1;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  for (let index = 0; index < count; index += 1) {
    const amount = index / steps;
    const progress = from + (to - from) * amount;
    const leftPoint = surfacePoint(track, progress, left.lane, left.height);
    const rightPoint = surfacePoint(track, progress, right.lane, right.height);
    positions.push(leftPoint.x, leftPoint.y, leftPoint.z, rightPoint.x, rightPoint.y, rightPoint.z);
    const u = (options.uRepeat ?? 1) * amount * (to - from) / track.length;
    uvs.push(u, 0, u, 1);
    if (!closed && index === count - 1) continue;
    const next = closed ? (index + 1) % count : index + 1;
    indices.push(index * 2, index * 2 + 1, next * 2, index * 2 + 1, next * 2 + 1, next * 2);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function mesh(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  { cast = false, receive = true }: { cast?: boolean; receive?: boolean } = {},
): THREE.Mesh {
  const created = new THREE.Mesh(geometry, material);
  created.castShadow = cast;
  created.receiveShadow = receive;
  return created;
}

/** Moulded plastic with a lighter seam where one Track section clips into the next. */
function roadTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#3b4149";
  context.fillRect(0, 0, size, size);
  for (let index = 0; index < 2_600; index += 1) {
    const shade = 52 + Math.floor(Math.random() * 30);
    context.fillStyle = `rgba(${shade},${shade + 3},${shade + 7},0.5)`;
    context.fillRect(Math.random() * size, Math.random() * size, 1.5, 1.5);
  }
  context.fillStyle = "rgba(150,160,172,0.30)";
  context.fillRect(0, 0, 3, size);
  context.fillStyle = "rgba(8,9,11,0.55)";
  context.fillRect(3, 0, 2, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/** Alternating kerb blocks, striped along the Track. */
function kerbTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 32;
  canvas.height = 4;
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#e6e2d5";
  context.fillRect(0, 0, 32, 4);
  context.fillStyle = "#d8452f";
  context.fillRect(0, 0, 16, 4);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Yellow and black chevrons, painted on the Track ahead of a fixed obstacle. */
export function warningTexture(): THREE.CanvasTexture {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#f2c024";
  context.fillRect(0, 0, size, size);
  context.fillStyle = "#1a1a1c";
  context.lineWidth = 0;
  for (let index = -2; index < 4; index += 1) {
    context.beginPath();
    context.moveTo(index * 24, size);
    context.lineTo(index * 24 + 12, size);
    context.lineTo(index * 24 + 12 + size, 0);
    context.lineTo(index * 24 + size, 0);
    context.closePath();
    context.fill();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function checkeredTexture(): THREE.CanvasTexture {
  const size = 64;
  const checks = 4;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#f2f0ea";
  context.fillRect(0, 0, size, size);
  context.fillStyle = "#16181b";
  for (let row = 0; row < checks; row += 1) {
    for (let column = 0; column < checks; column += 1) {
      if ((row + column) % 2 === 0) {
        context.fillRect(column * size / checks, row * size / checks, size / checks, size / checks);
      }
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

const OUTER_LANE = 3 + PROVISIONAL_PRESENTATION.roadEdgeLaneMargin;
const INNER_LANE = -PROVISIONAL_PRESENTATION.roadEdgeLaneMargin;

export function buildTrackView(track: Track): TrackView {
  const group = new THREE.Group();
  group.name = "track";

  const road = new THREE.MeshStandardMaterial({
    map: roadTexture(),
    roughness: 0.82,
    metalness: 0.04,
  });
  road.map!.repeat.set(track.length / TRACK_VIEW.sectionProgress, 1);
  const edge = new THREE.MeshStandardMaterial({ color: COLORS.edge, roughness: 0.7, side: THREE.DoubleSide });
  const underside = new THREE.MeshStandardMaterial({ color: COLORS.underside, roughness: 0.95, side: THREE.DoubleSide });

  const surface = mesh(
    ribbon(track, { lane: INNER_LANE, height: 0 }, { lane: OUTER_LANE, height: 0 }, {
      uRepeat: track.length / TRACK_VIEW.sectionProgress,
    }),
    road,
    { cast: true },
  );
  surface.name = "track-surface";
  group.add(surface);

  const bottom = -TRACK_VIEW.roadThickness;
  group.add(mesh(ribbon(track, { lane: INNER_LANE, height: 0 }, { lane: INNER_LANE, height: bottom }), edge, { cast: true }));
  group.add(mesh(ribbon(track, { lane: OUTER_LANE, height: bottom }, { lane: OUTER_LANE, height: 0 }), edge, { cast: true }));
  group.add(mesh(ribbon(track, { lane: INNER_LANE, height: bottom }, { lane: OUTER_LANE, height: bottom }), underside));

  addKerbs(group, track);
  addSlots(group, track);
  addBarriers(group, track);
  addPylons(group, track);
  const startLights = addStartLine(group, track);

  return { group, startLights };
}

function addKerbs(group: THREE.Group, track: Track): void {
  const material = new THREE.MeshStandardMaterial({ map: kerbTexture(), roughness: 0.55 });
  material.map!.repeat.set(track.length / 3.4, 1);
  const kerbs: readonly [Edge, Edge][] = [
    [
      { lane: INNER_LANE + TRACK_VIEW.kerbLane, height: TRACK_VIEW.kerbHeight },
      { lane: INNER_LANE + TRACK_VIEW.kerbLane + TRACK_VIEW.kerbWidth, height: 0 },
    ],
    [
      { lane: OUTER_LANE - TRACK_VIEW.kerbLane - TRACK_VIEW.kerbWidth, height: 0 },
      { lane: OUTER_LANE - TRACK_VIEW.kerbLane, height: TRACK_VIEW.kerbHeight },
    ],
  ];
  for (const [left, right] of kerbs) {
    group.add(mesh(ribbon(track, left, right, { uRepeat: track.length / 3.4 }), material));
  }
}

/** Lane grooves with their copper braids, the detail that reads as a slot Track. */
function addSlots(group: THREE.Group, track: Track): void {
  // Grooves and braids sit just above the road, so they also bias depth to stay solid at
  // the far end of a straight instead of breaking into dashes.
  const groove = new THREE.MeshStandardMaterial({
    color: COLORS.groove, roughness: 0.98, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  const braid = new THREE.MeshStandardMaterial({
    color: COLORS.braid, roughness: 0.34, metalness: 0.85,
    polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
  });
  const laneWidth = PROVISIONAL_PRESENTATION.laneSpacing;
  const half = TRACK_VIEW.grooveWidth / laneWidth / 2;
  const braidLane = TRACK_VIEW.braidOffset / laneWidth;
  const braidHalf = TRACK_VIEW.braidWidth / laneWidth / 2;

  for (const lane of track.lanes) {
    const center = lane.index;
    const lift = TRACK_VIEW.grooveLift;
    group.add(mesh(ribbon(track, { lane: center - half, height: lift }, { lane: center + half, height: lift }), groove));
    for (const direction of [-1, 1]) {
      const offset = center + direction * braidLane;
      group.add(mesh(
        ribbon(track, { lane: offset - braidHalf, height: 0.013 }, { lane: offset + braidHalf, height: 0.013 }),
        braid,
      ));
    }
  }
}

/**
 * Barriers are placed where a Car most needs to read the Track edge: raised sections and the
 * outside of hard turns. Elsewhere the kerb alone keeps the road legible.
 */
function addBarriers(group: THREE.Group, track: Track): void {
  const post = new THREE.MeshStandardMaterial({ color: COLORS.barrierPost, roughness: 0.6, side: THREE.DoubleSide });
  const rail = new THREE.MeshStandardMaterial({ color: COLORS.barrierRail, roughness: 0.5, side: THREE.DoubleSide });

  for (const side of ["inner", "outer"] as const) {
    const lane = side === "inner" ? INNER_LANE - TRACK_VIEW.barrierLane : OUTER_LANE + TRACK_VIEW.barrierLane;
    for (const run of barrierRuns(track, side)) {
      const options = { from: run.from, to: run.to };
      group.add(mesh(ribbon(track, { lane, height: 0 }, { lane, height: TRACK_VIEW.barrierHeight }, options), rail, { cast: true }));
      group.add(mesh(
        ribbon(
          track,
          { lane: lane - TRACK_VIEW.barrierThickness, height: TRACK_VIEW.barrierHeight },
          { lane: lane + TRACK_VIEW.barrierThickness, height: TRACK_VIEW.barrierHeight },
          options,
        ),
        post,
        { cast: true },
      ));
    }
  }
}

interface Run { readonly from: number; readonly to: number }

function barrierRuns(track: Track, side: "inner" | "outer"): Run[] {
  const step = track.length / TRACK_VIEW.segments;
  const needed: boolean[] = [];
  for (let index = 0; index < TRACK_VIEW.segments; index += 1) {
    const pose = sampleTrackPose(track, index * step, 1.5);
    const raised = pose.y > TRACK_VIEW.barrierRaisedHeight;
    // Positive bank raises the Lane 3 edge, so it marks the outside of that turn.
    const outsideOfTurn = side === "outer" ? pose.bank > TRACK_VIEW.barrierBankThreshold : pose.bank < -TRACK_VIEW.barrierBankThreshold;
    needed.push(raised || outsideOfTurn);
  }

  const runs: Run[] = [];
  let start: number | null = null;
  for (let index = 0; index <= TRACK_VIEW.segments; index += 1) {
    const active = needed[index % TRACK_VIEW.segments]! && index < TRACK_VIEW.segments;
    if (active && start === null) start = index;
    if (!active && start !== null) {
      if (index - start > 3) runs.push({ from: start * step, to: index * step });
      start = null;
    }
  }
  return runs;
}

/** Pylons carry the raised Track back down to the bench, including under the flyover. */
function addPylons(group: THREE.Group, track: Track): void {
  const count = Math.round(track.length / TRACK_VIEW.pylonProgressSpacing);
  const tops: THREE.Vector3[] = [];
  for (let index = 0; index < count; index += 1) {
    const progress = index / count * track.length;
    for (const lane of [INNER_LANE + 0.35, OUTER_LANE - 0.35]) {
      const top = surfacePoint(track, progress, lane, -TRACK_VIEW.roadThickness);
      if (top.y >= TRACK_VIEW.pylonMinimumHeight) tops.push(top);
    }
  }
  if (tops.length === 0) return;

  const posts = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(TRACK_VIEW.pylonRadius * 0.72, TRACK_VIEW.pylonRadius, 1, 8),
    new THREE.MeshStandardMaterial({ color: COLORS.pylon, roughness: 0.55, metalness: 0.15 }),
    tops.length,
  );
  const feet = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(TRACK_VIEW.pylonRadius * 1.7, TRACK_VIEW.pylonRadius * 1.9, 0.12, 8),
    new THREE.MeshStandardMaterial({ color: COLORS.pylonFoot, roughness: 0.75 }),
    tops.length,
  );
  const matrix = new THREE.Matrix4();
  for (const [index, top] of tops.entries()) {
    matrix.makeScale(1, top.y, 1).setPosition(top.x, top.y / 2, top.z);
    posts.setMatrixAt(index, matrix);
    matrix.makeScale(1, 1, 1).setPosition(top.x, 0.06, top.z);
    feet.setMatrixAt(index, matrix);
  }
  for (const instanced of [posts, feet]) {
    instanced.castShadow = true;
    instanced.receiveShadow = true;
    group.add(instanced);
  }
}

function addStartLine(group: THREE.Group, track: Track): THREE.Mesh[] {
  const checkered = new THREE.MeshStandardMaterial({ map: checkeredTexture(), roughness: 0.6 });
  checkered.map!.repeat.set(1, 2);
  const lineProgress = TRACK_VIEW.startLineProgress * 2;
  group.add(mesh(
    ribbon(track, { lane: INNER_LANE, height: 0.006 }, { lane: OUTER_LANE, height: 0.006 }, {
      from: track.startFinish - TRACK_VIEW.startLineProgress,
      to: track.startFinish + TRACK_VIEW.startLineProgress,
      steps: 12,
      uRepeat: track.length / lineProgress,
    }),
    checkered,
  ));

  const structure = new THREE.MeshStandardMaterial({ color: COLORS.gantry, roughness: 0.45, metalness: 0.4 });
  const gantry = new THREE.Group();
  const left = surfacePoint(track, track.startFinish, INNER_LANE - 0.5, 0);
  const right = surfacePoint(track, track.startFinish, OUTER_LANE + 0.5, 0);
  const span = left.distanceTo(right);
  const height = 3.4;

  for (const base of [left, right]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.28, height, 0.28), structure);
    post.position.set(base.x, base.y + height / 2, base.z);
    post.castShadow = true;
    gantry.add(post);
  }

  const beam = new THREE.Mesh(new THREE.BoxGeometry(span, 0.42, 0.34), structure);
  beam.position.copy(left.clone().add(right).multiplyScalar(0.5)).setY(left.y + height);
  beam.rotation.y = Math.atan2(right.z - left.z, right.x - left.x) * -1;
  beam.castShadow = true;
  gantry.add(beam);

  const lights: THREE.Mesh[] = [];
  for (let index = 0; index < 3; index += 1) {
    const bulb = new THREE.Mesh(
      new THREE.SphereGeometry(0.19, 12, 8),
      new THREE.MeshStandardMaterial({ color: 0x3a1512, emissive: 0xff2a15, emissiveIntensity: 0.15, roughness: 0.4 }),
    );
    bulb.name = `start-light-${index}`;
    bulb.position.copy(left.clone().lerp(right, 0.3 + index * 0.2)).setY(left.y + height - 0.05);
    gantry.add(bulb);
    lights.push(bulb);
  }

  group.add(gantry);
  return lights;
}

/** Workshop clutter left on the Track: the authored fixed obstacles. */
export function buildObstacle(id: string): THREE.Group {
  const obstacle = new THREE.Group();
  if (id.includes("paint-tin")) {
    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(0.46, 0.44, 0.78, 14),
      new THREE.MeshStandardMaterial({ color: 0xc9ccd1, roughness: 0.42, metalness: 0.55 }),
    );
    body.position.y = 0.39;
    obstacle.add(body);
    const band = new THREE.Mesh(
      new THREE.CylinderGeometry(0.47, 0.47, 0.26, 14),
      new THREE.MeshStandardMaterial({ color: 0x2f7fd0, roughness: 0.5 }),
    );
    band.position.y = 0.34;
    obstacle.add(band);
    const lid = new THREE.Mesh(
      new THREE.CylinderGeometry(0.48, 0.48, 0.07, 14),
      new THREE.MeshStandardMaterial({ color: 0xdfe3e7, roughness: 0.38, metalness: 0.6 }),
    );
    lid.position.y = 0.8;
    obstacle.add(lid);
  } else if (id.includes("toolbox")) {
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(0.98, 0.62, 1.5),
      new THREE.MeshStandardMaterial({ color: 0xd4402c, roughness: 0.45, metalness: 0.25 }),
    );
    body.position.y = 0.31;
    obstacle.add(body);
    const tray = new THREE.Mesh(
      new THREE.BoxGeometry(0.9, 0.16, 1.36),
      new THREE.MeshStandardMaterial({ color: 0x2c3036, roughness: 0.6 }),
    );
    tray.position.y = 0.7;
    obstacle.add(tray);
    const handle = new THREE.Mesh(
      new THREE.TorusGeometry(0.3, 0.055, 6, 12, Math.PI),
      new THREE.MeshStandardMaterial({ color: 0x9aa1a8, roughness: 0.35, metalness: 0.7 }),
    );
    handle.position.y = 0.78;
    handle.rotation.y = Math.PI / 2;
    obstacle.add(handle);
  } else {
    const grain = new THREE.MeshStandardMaterial({ color: 0xbb8f52, roughness: 0.88 });
    const block = new THREE.Mesh(new THREE.BoxGeometry(1.02, 0.66, 1.62), grain);
    block.position.y = 0.33;
    obstacle.add(block);
    const offcut = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.3, 1.1), grain);
    offcut.position.set(0.1, 0.81, -0.1);
    offcut.rotation.y = 0.35;
    obstacle.add(offcut);
  }

  for (const child of obstacle.children) {
    child.castShadow = true;
    child.receiveShadow = true;
  }
  return obstacle;
}

export interface PickupView {
  readonly group: THREE.Group;
  readonly shapes: Readonly<Record<"boost" | "shield" | "hazard", THREE.Object3D>>;
}

/** One pickup marker per authored opportunity; its shape follows the selected effect. */
export function buildPickup(id: string): PickupView {
  const group = new THREE.Group();
  group.name = `power-up:${id}`;

  const boost = new THREE.Group();
  const boostMaterial = new THREE.MeshStandardMaterial({ color: 0xffb02e, emissive: 0xff7a10, emissiveIntensity: 0.7, roughness: 0.3 });
  for (let index = 0; index < 2; index += 1) {
    const chevron = new THREE.Mesh(new THREE.ConeGeometry(0.42, 0.34, 4), boostMaterial);
    chevron.rotation.x = Math.PI / 2;
    chevron.rotation.z = Math.PI / 4;
    chevron.position.z = index * 0.3 - 0.15;
    boost.add(chevron);
  }

  const shield = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.42, 0),
    new THREE.MeshStandardMaterial({ color: 0x6fd6ff, emissive: 0x1d7fb8, emissiveIntensity: 0.6, roughness: 0.25, metalness: 0.3 }),
  );

  const hazard = new THREE.Group();
  const hazardMaterial = new THREE.MeshStandardMaterial({ color: 0xe2503a, emissive: 0x7d1a0d, emissiveIntensity: 0.55, roughness: 0.4 });
  const spike = new THREE.Mesh(new THREE.ConeGeometry(0.36, 0.62, 6), hazardMaterial);
  spike.position.y = 0.1;
  hazard.add(spike);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.4, 0.07, 6, 14), hazardMaterial);
  ring.rotation.x = Math.PI / 2;
  ring.position.y = -0.22;
  hazard.add(ring);

  const halo = new THREE.Mesh(
    new THREE.RingGeometry(0.5, 0.62, 18),
    new THREE.MeshBasicMaterial({ color: 0xfff3c4, transparent: true, opacity: 0.45, side: THREE.DoubleSide }),
  );
  halo.rotation.x = -Math.PI / 2;
  halo.position.y = -0.5;

  group.add(boost, shield, hazard, halo);
  return { group, shapes: { boost, shield, hazard } };
}

/** Spilled workshop debris: the telegraphed and active Hazard. */
export function buildHazard(): THREE.Group {
  const group = new THREE.Group();
  const spill = new THREE.Mesh(
    new THREE.CylinderGeometry(0.62, 0.72, 0.14, 12),
    new THREE.MeshStandardMaterial({ color: 0x3a2f1c, roughness: 0.95, transparent: true }),
  );
  spill.name = "hazard-body";
  spill.position.y = 0.07;
  group.add(spill);

  const cone = new THREE.Mesh(
    new THREE.ConeGeometry(0.34, 0.68, 8),
    new THREE.MeshStandardMaterial({ color: 0xf07022, emissive: 0x6b2606, emissiveIntensity: 0.4, roughness: 0.5, transparent: true }),
  );
  cone.name = "hazard-marker";
  cone.position.y = 0.4;
  group.add(cone);

  for (const child of group.children) child.castShadow = true;
  return group;
}

export function poseHazard(group: THREE.Group, track: Track, state: HazardState): void {
  poseOnTrack(group, track, state.progress, state.lane);
  const warning = state.phase === "warning";
  for (const child of group.children) {
    const material = (child as THREE.Mesh).material as THREE.MeshStandardMaterial;
    material.opacity = warning ? 0.4 : 1;
    material.transparent = warning;
    material.wireframe = warning;
  }
  group.scale.setScalar(warning ? 0.85 : 1);
}

/** Places any Track-anchored object flat on the banked, climbing surface. */
export function poseOnTrack(object: THREE.Object3D, track: Track, progress: number, lane: number, height = 0): void {
  placeOnSurface(object, sampleTrackPose(track, progress, lane), height);
}

export type { LaneIndex };
