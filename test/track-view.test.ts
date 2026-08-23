import { beforeAll, describe, expect, test } from "bun:test";

import { WORKSHOP_TRACK } from "../src/authored-track";
import { sampleTrackPose } from "../src/presentation";

/**
 * The Track view generates its textures from a canvas, which does not exist outside the
 * browser. A minimal stub keeps this a real check of the generated geometry.
 */
function stubCanvas(): void {
  const context = new Proxy({}, {
    get: (_target, property) => {
      if (property === "canvas") return {};
      return () => undefined;
    },
    set: () => true,
  });
  const element = { width: 0, height: 0, getContext: () => context, addEventListener: () => undefined };
  (globalThis as Record<string, unknown>).document ??= { createElement: () => element };
}

beforeAll(stubCanvas);

async function buildView() {
  const { buildTrackView } = await import("../src/track-view");
  return buildTrackView(WORKSHOP_TRACK);
}

describe("Workshop Track view", () => {
  test("builds one Track group whose geometry stays on the bench", async () => {
    const view = await buildView();
    const THREE = await import("three");
    view.group.updateMatrixWorld(true);
    const point = new THREE.Vector3();
    const instance = new THREE.Matrix4();
    let vertices = 0;
    let lowest = Infinity;
    let highest = -Infinity;
    let widest = 0;

    view.group.traverse((object) => {
      const mesh = object as InstanceType<typeof THREE.Mesh>;
      const position = mesh.geometry?.getAttribute("position");
      if (position === undefined) return;
      const instanced = object instanceof THREE.InstancedMesh ? object : null;
      const placements = instanced === null ? 1 : instanced.count;
      vertices += position.count * placements;
      for (let placement = 0; placement < placements; placement += 1) {
        if (instanced !== null) instanced.getMatrixAt(placement, instance);
        for (let index = 0; index < position.count; index += 1) {
          point.fromBufferAttribute(position, index);
          if (instanced !== null) point.applyMatrix4(instance);
          point.applyMatrix4(mesh.matrixWorld);
          lowest = Math.min(lowest, point.y);
          highest = Math.max(highest, point.y);
          widest = Math.max(widest, Math.abs(point.x), Math.abs(point.z));
        }
      }
    });

    expect(vertices).toBeGreaterThan(1_000);
    // Nothing sinks through the bench, and the flyover deck is the highest Track surface.
    expect(lowest).toBeGreaterThan(-0.6);
    expect(highest).toBeGreaterThan(5);
    expect(highest).toBeLessThan(10);
    expect(widest).toBeLessThan(44);
  });

  test("places the start gantry lights over the start/finish line", async () => {
    const view = await buildView();
    const start = sampleTrackPose(WORKSHOP_TRACK, WORKSHOP_TRACK.startFinish, 1.5);

    expect(view.startLights).toHaveLength(3);
    for (const light of view.startLights) {
      expect(Math.hypot(light.position.x - start.x, light.position.z - start.z)).toBeLessThan(6);
      expect(light.position.y).toBeGreaterThan(start.y + 2);
    }
  });

  test("poses Track content on the banked surface rather than on flat ground", async () => {
    const { buildObstacle, poseOnTrack, surfacePoint } = await import("../src/track-view");
    const banked = 14;
    const obstacle = buildObstacle("obstacle-toolbox");
    poseOnTrack(obstacle, WORKSHOP_TRACK, banked, 3);
    const expected = surfacePoint(WORKSHOP_TRACK, banked, 3, 0);
    const pose = sampleTrackPose(WORKSHOP_TRACK, banked, 3);

    expect(obstacle.position.x).toBeCloseTo(expected.x, 6);
    expect(obstacle.position.y).toBeCloseTo(expected.y, 6);
    expect(obstacle.position.z).toBeCloseTo(expected.z, 6);
    expect(obstacle.rotation.y).toBeCloseTo(pose.heading, 6);
    expect(obstacle.rotation.z).toBeCloseTo(-pose.bank, 6);
    expect(Math.abs(pose.bank)).toBeGreaterThan(0.05);
  });

  test("builds one pickup marker per authored opportunity with a shape per effect", async () => {
    const { buildPickup } = await import("../src/track-view");
    for (const opportunity of WORKSHOP_TRACK.powerUpOpportunities ?? []) {
      const pickup = buildPickup(opportunity.id);
      expect(pickup.group.name).toBe(`power-up:${opportunity.id}`);
      expect(Object.keys(pickup.shapes).sort()).toEqual(["boost", "hazard", "shield"]);
    }
  });
});

describe("Workshop scenery", () => {
  test("builds the bench, walls, props, and lighting around the Track", async () => {
    const THREE = await import("three");
    const { buildWorkshop, WORKSHOP } = await import("../src/workshop-scenery");
    const scene = new THREE.Scene();
    buildWorkshop(scene);

    const workshop = scene.getObjectByName("workshop");
    expect(workshop).toBeDefined();
    expect(workshop!.children.length).toBeGreaterThan(20);
    expect(scene.fog).not.toBeNull();

    let lights = 0;
    let benchTop = -Infinity;
    scene.traverse((object) => {
      if ((object as InstanceType<typeof THREE.Light>).isLight === true) lights += 1;
      const mesh = object as InstanceType<typeof THREE.Mesh>;
      if (mesh.geometry === undefined) return;
      mesh.geometry.computeBoundingBox();
      const box = mesh.geometry.boundingBox!;
      // Nothing may sit on top of the Track: the bench surface is the play surface.
      if (Math.abs(mesh.position.x) < 20 && Math.abs(mesh.position.z) < 12) {
        benchTop = Math.max(benchTop, mesh.position.y + box.max.y);
      }
    });

    expect(lights).toBeGreaterThanOrEqual(4);
    expect(benchTop).toBeLessThan(WORKSHOP.roomHeight);
  });
});

describe("Workshop scenery placement", () => {
  test("keeps every view-blocking prop clear of the Track", async () => {
    const THREE = await import("three");
    const { buildWorkshop } = await import("../src/workshop-scenery");
    const { PROVISIONAL_PRESENTATION, sampleTrackPose: samplePose } = await import("../src/presentation");
    const scene = new THREE.Scene();
    buildWorkshop(scene);
    scene.updateMatrixWorld(true);

    const roadHalfWidth = (3 + PROVISIONAL_PRESENTATION.roadEdgeLaneMargin * 2) * PROVISIONAL_PRESENTATION.laneSpacing / 2;
    const centres = Array.from({ length: 720 }, (_, index) => (
      samplePose(WORKSHOP_TRACK, index / 720 * WORKSHOP_TRACK.length, 1.5)
    ));
    const box = new THREE.Box3();
    const size = new THREE.Vector3();
    const centre = new THREE.Vector3();
    const instance = new THREE.Matrix4();
    const offenders: string[] = [];

    scene.traverse((object) => {
      const mesh = object as InstanceType<typeof THREE.Mesh>;
      if (mesh.geometry === undefined) return;
      const instanced = object instanceof THREE.InstancedMesh ? object : null;
      const placements = instanced === null ? 1 : instanced.count;
      for (let placement = 0; placement < placements; placement += 1) {
        box.setFromObject(mesh, true);
        if (instanced !== null) {
          instanced.getMatrixAt(placement, instance);
          box.copy(mesh.geometry.boundingBox ?? box.makeEmpty())
            .applyMatrix4(instance)
            .applyMatrix4(mesh.matrixWorld);
        }
        box.getSize(size);
        box.getCenter(centre);
        const footprint = Math.max(size.x, size.z);
        // Walls, the bench, props no taller than a Car, and anything above the flyover
        // cannot hide the Track from a Racer.
        if (footprint > 30 || box.max.y < 1.6 || box.min.y > 8) continue;
        // Measure to the prop's footprint, not its centre, so long thin props are judged fairly.
        const nearest = Math.min(...centres.map((pose) => Math.hypot(
          pose.x - Math.min(box.max.x, Math.max(box.min.x, pose.x)),
          pose.z - Math.min(box.max.z, Math.max(box.min.z, pose.z)),
        )));
        if (nearest < roadHalfWidth + 1.5) offenders.push(`${mesh.name || mesh.type} at ${centre.x.toFixed(1)}, ${centre.z.toFixed(1)}`);
      }
    });

    expect(offenders).toEqual([]);
  });
});
