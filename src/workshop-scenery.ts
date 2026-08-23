import * as THREE from "three";

/**
 * The oversized workshop the miniature slot Track is laid out on: bench, back wall, the
 * clutter around the circuit, and the lighting that reads as one late-afternoon workshop.
 * Everything here is presentation only and is generated from code, so it ships no
 * third-party assets.
 */
export const WORKSHOP = Object.freeze({
  benchWidth: 96,
  benchDepth: 62,
  benchThickness: 1.35,
  wallZ: -36,
  roomHeight: 34,
  fogNear: 58,
  fogFar: 168,
  background: 0x252d38,
});

const MATERIALS = {
  bench: () => new THREE.MeshStandardMaterial({ map: woodTexture(), roughness: 0.9 }),
  benchEdge: () => new THREE.MeshStandardMaterial({ color: 0x6d5335, roughness: 0.92 }),
  wall: () => new THREE.MeshStandardMaterial({ color: 0x2a3038, roughness: 0.96 }),
  pegboard: () => new THREE.MeshStandardMaterial({ map: pegboardTexture(), roughness: 0.9 }),
  steel: (color = 0xa8b0b8) => new THREE.MeshStandardMaterial({ color, roughness: 0.32, metalness: 0.78 }),
  plastic: (color: number) => new THREE.MeshStandardMaterial({ color, roughness: 0.44 }),
  rubber: () => new THREE.MeshStandardMaterial({ color: 0x1d2024, roughness: 0.9 }),
  paper: (color: number) => new THREE.MeshStandardMaterial({ color, roughness: 0.95 }),
};

function woodTexture(): THREE.CanvasTexture {
  const width = 512;
  const height = 512;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#9a7448";
  context.fillRect(0, 0, width, height);
  for (let index = 0; index < 420; index += 1) {
    const y = Math.random() * height;
    const shade = 96 + Math.floor(Math.random() * 60);
    context.strokeStyle = `rgba(${shade},${Math.floor(shade * 0.76)},${Math.floor(shade * 0.48)},0.5)`;
    context.lineWidth = 0.6 + Math.random() * 2.6;
    context.beginPath();
    context.moveTo(0, y);
    for (let x = 0; x <= width; x += 32) context.lineTo(x, y + Math.sin(x / 90 + y) * 3.4);
    context.stroke();
  }
  // Plank seams, so the bench reads at its oversized scale.
  context.fillStyle = "rgba(48,34,20,0.55)";
  for (let index = 0; index <= 4; index += 1) context.fillRect(0, index * height / 4 - 2, width, 4);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.repeat.set(3, 2);
  texture.anisotropy = 4;
  return texture;
}

function pegboardTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#c1935f";
  context.fillRect(0, 0, size, size);
  context.fillStyle = "#3a2a19";
  for (let row = 0; row < 8; row += 1) {
    for (let column = 0; column < 8; column += 1) {
      context.beginPath();
      context.arc(column * 16 + 8, row * 16 + 8, 2.6, 0, Math.PI * 2);
      context.fill();
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.repeat.set(14, 5);
  return texture;
}

function box(
  width: number,
  height: number,
  depth: number,
  material: THREE.Material,
  position: readonly [number, number, number],
  rotationY = 0,
): THREE.Mesh {
  const created = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), material);
  created.position.set(position[0], position[1], position[2]);
  created.rotation.y = rotationY;
  created.castShadow = true;
  created.receiveShadow = true;
  return created;
}

function cylinder(
  radiusTop: number,
  radiusBottom: number,
  height: number,
  material: THREE.Material,
  position: readonly [number, number, number],
  rotation: readonly [number, number, number] = [0, 0, 0],
  segments = 14,
): THREE.Mesh {
  const created = new THREE.Mesh(new THREE.CylinderGeometry(radiusTop, radiusBottom, height, segments), material);
  created.position.set(position[0], position[1], position[2]);
  created.rotation.set(rotation[0], rotation[1], rotation[2]);
  created.castShadow = true;
  created.receiveShadow = true;
  return created;
}

export function buildWorkshop(scene: THREE.Scene): void {
  scene.background = new THREE.Color(WORKSHOP.background);
  scene.fog = new THREE.Fog(WORKSHOP.background, WORKSHOP.fogNear, WORKSHOP.fogFar);

  const workshop = new THREE.Group();
  workshop.name = "workshop";
  addBench(workshop);
  addWalls(workshop);
  addProps(workshop);
  scene.add(workshop);
  addLighting(scene);
}

function addBench(group: THREE.Group): void {
  const top = box(WORKSHOP.benchWidth, WORKSHOP.benchThickness, WORKSHOP.benchDepth, MATERIALS.bench(),
    [0, -WORKSHOP.benchThickness / 2, 0]);
  top.castShadow = false;
  group.add(top);

  const edge = MATERIALS.benchEdge();
  group.add(box(WORKSHOP.benchWidth + 0.6, 0.5, 0.7, edge, [0, -0.25, WORKSHOP.benchDepth / 2]));
  group.add(box(WORKSHOP.benchWidth + 0.6, 0.5, 0.7, edge, [0, -0.25, -WORKSHOP.benchDepth / 2]));

  const leg = MATERIALS.benchEdge();
  for (const x of [-WORKSHOP.benchWidth / 2 + 4, WORKSHOP.benchWidth / 2 - 4]) {
    for (const z of [-WORKSHOP.benchDepth / 2 + 4, WORKSHOP.benchDepth / 2 - 4]) {
      group.add(box(2.4, 16, 2.4, leg, [x, -9, z]));
    }
  }

  // A cutting mat and a spilled drift of sawdust break up the empty bench.
  const mat = box(26, 0.09, 17, MATERIALS.plastic(0x2f5a4f), [-34, 0.04, 22], 0.16);
  mat.castShadow = false;
  group.add(mat);
  for (let index = 0; index < 9; index += 1) {
    const angle = index * 2.4;
    const dust = cylinder(1.1 + (index % 3) * 0.5, 1.6 + (index % 3) * 0.6, 0.22, MATERIALS.paper(0xd9bd8c),
      [30 + Math.cos(angle) * 7, 0.11, -24 + Math.sin(angle) * 5], [0, angle, 0], 10);
    dust.castShadow = false;
    group.add(dust);
  }
}

function addWalls(group: THREE.Group): void {
  const wall = MATERIALS.wall();
  // The walls are oversized on purpose: no chase-camera angle should ever find their edges.
  const back = box(300, WORKSHOP.roomHeight * 2, 1.2, wall, [0, WORKSHOP.roomHeight - 16, WORKSHOP.wallZ - 8]);
  back.castShadow = false;
  group.add(back);
  for (const x of [-110, 110]) {
    const side = box(1.2, WORKSHOP.roomHeight * 2, 220, wall, [x, WORKSHOP.roomHeight - 16, 30]);
    side.castShadow = false;
    group.add(side);
  }

  const pegboard = box(96, 22, 0.4, MATERIALS.pegboard(), [0, 6, WORKSHOP.wallZ - 7.3]);
  pegboard.castShadow = false;
  group.add(pegboard);
  addHangingTools(group);
  addWindow(group);
}

function addHangingTools(group: THREE.Group): void {
  const steel = MATERIALS.steel();
  const handle = MATERIALS.plastic(0xcf3b26);
  const z = WORKSHOP.wallZ - 6.6;

  // Hammer.
  group.add(box(1.2, 8, 1.2, handle, [-30, 4, z]));
  group.add(box(5.4, 1.9, 1.9, steel, [-30, 8.6, z]));
  // Saw.
  const blade = box(15, 5.4, 0.35, steel, [-9, 6, z], 0);
  group.add(blade);
  group.add(box(3.4, 3.2, 1.1, handle, [-17.5, 7.4, z]));
  // Spanner set.
  for (let index = 0; index < 4; index += 1) {
    group.add(box(1.3, 7 + index * 1.4, 0.5, MATERIALS.steel(0x9199a1), [8 + index * 3.4, 5 + index * 0.7, z]));
  }
  // Coiled cable.
  const coil = new THREE.Mesh(new THREE.TorusGeometry(3.6, 0.62, 8, 22), MATERIALS.rubber());
  coil.position.set(26, 6, z);
  coil.castShadow = true;
  group.add(coil);
}

function addWindow(group: THREE.Group): void {
  const frame = MATERIALS.plastic(0xdad6cc);
  const pane = new THREE.MeshStandardMaterial({
    color: 0xbfd9e8,
    emissive: 0x9fc6de,
    emissiveIntensity: 0.85,
    roughness: 0.2,
  });
  const glass = box(26, 15, 0.3, pane, [40, 12, WORKSHOP.wallZ - 7.4]);
  glass.castShadow = false;
  group.add(glass);
  group.add(box(27.4, 0.9, 0.9, frame, [40, 19.6, WORKSHOP.wallZ - 7.2]));
  group.add(box(27.4, 0.9, 0.9, frame, [40, 4.4, WORKSHOP.wallZ - 7.2]));
  group.add(box(0.9, 15.6, 0.9, frame, [40, 12, WORKSHOP.wallZ - 7.2]));
}

/**
 * Prop placement follows one rule: anything tall enough to hide the Track sits at least a
 * few units clear of the road, in an infield or at the bench edge. Flat props — the cutting
 * mat, the ruler, spilled sawdust — may pass under the raised Track.
 */
function addProps(group: THREE.Group): void {
  addToolbox(group, 19, 0);
  addPaintTins(group, -18, 1);
  addMug(group, -4, 26);
  addScrewdrivers(group, -40, -24);
  addRuler(group, 4, 27.5);
  addPowerPack(group, -44, -26);
  addWorkLamp(group);
  addCardboardBox(group, 45, 26);
  addScatteredHardware(group);
}

/** Hero prop in the middle of the east loop: an open toolbox the Track runs around. */
function addToolbox(group: THREE.Group, x: number, z: number): void {
  const shell = MATERIALS.plastic(0xc63c26);
  const tray = MATERIALS.plastic(0x2a2f35);
  group.add(box(15, 4.6, 8.4, shell, [x, 2.3, z], 0.12));
  group.add(box(13.6, 1.1, 7.2, tray, [x, 5.1, z], 0.12));
  const handle = new THREE.Mesh(new THREE.TorusGeometry(2.6, 0.34, 6, 14, Math.PI), MATERIALS.steel());
  handle.position.set(x, 5.4, z);
  handle.rotation.y = Math.PI / 2 + 0.12;
  handle.castShadow = true;
  group.add(handle);
  for (let index = 0; index < 3; index += 1) {
    group.add(cylinder(0.42, 0.42, 6.5, MATERIALS.steel(0xb8c0c8),
      [x - 3.5 + index * 2.6, 6.2, z + 0.6], [Math.PI / 2, 0.2 * index, 0.06], 8));
  }
}

function addPaintTins(group: THREE.Group, x: number, z: number): void {
  const tin = MATERIALS.steel(0xd4d8dc);
  const colors = [0x2f7fd0, 0xe0c33a, 0xcf3b26];
  for (let index = 0; index < 3; index += 1) {
    const height = 5.4;
    const offsetX = x + Math.cos(index * 2.1) * 3.4;
    const offsetZ = z + Math.sin(index * 2.1) * 3.0;
    group.add(cylinder(2.5, 2.4, height, tin, [offsetX, height / 2, offsetZ]));
    group.add(cylinder(2.55, 2.55, 1.5, MATERIALS.plastic(colors[index]!), [offsetX, height * 0.42, offsetZ]));
    group.add(cylinder(2.6, 2.6, 0.35, tin, [offsetX, height + 0.15, offsetZ]));
  }
  // A brush resting across the nearest tin.
  group.add(box(0.9, 0.6, 7.5, MATERIALS.plastic(0x8a5a2b), [x + 5.4, 5.9, z - 1.2], 0.5));
  group.add(box(1.5, 1.1, 2.6, MATERIALS.paper(0x2f7fd0), [x + 7.6, 5.9, z - 2.4], 0.5));
}

function addMug(group: THREE.Group, x: number, z: number): void {
  const ceramic = MATERIALS.plastic(0xe8e4dc);
  const mug = cylinder(2.4, 2.15, 5.2, ceramic, [x, 2.6, z]);
  group.add(mug);
  group.add(cylinder(2.1, 2.1, 0.2, MATERIALS.plastic(0x4a3222), [x, 4.4, z]));
  const handle = new THREE.Mesh(new THREE.TorusGeometry(1.4, 0.42, 6, 14, Math.PI), ceramic);
  handle.position.set(x + 2.4, 2.8, z);
  handle.rotation.z = Math.PI / 2;
  handle.rotation.y = Math.PI / 2;
  handle.castShadow = true;
  group.add(handle);
}

function addScrewdrivers(group: THREE.Group, x: number, z: number): void {
  const angles = [0.4, 1.15, 2.1];
  const colors = [0xd8452f, 0xe0c33a, 0x2f7fd0];
  for (let index = 0; index < angles.length; index += 1) {
    const angle = angles[index]!;
    const offsetX = x + index * 3.2;
    const offsetZ = z + index * 1.6;
    group.add(cylinder(1.15, 1.05, 7.2, MATERIALS.plastic(colors[index]!),
      [offsetX, 1.15, offsetZ], [Math.PI / 2, angle, 0], 10));
    group.add(cylinder(0.35, 0.35, 9, MATERIALS.steel(),
      [offsetX + Math.sin(angle) * 8, 1.15, offsetZ + Math.cos(angle) * 8], [Math.PI / 2, angle, 0], 8));
  }
}

function addRuler(group: THREE.Group, x: number, z: number): void {
  const ruler = box(46, 0.4, 4.2, MATERIALS.paper(0xe8d59a), [x, 0.2, z], -0.06);
  group.add(ruler);
  const ticks = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.28, 0.06, 2.2),
    MATERIALS.paper(0x2b2b2b),
    22,
  );
  const matrix = new THREE.Matrix4();
  for (let index = 0; index < 22; index += 1) {
    matrix.makeRotationY(-0.06);
    matrix.setPosition(x - 21 + index * 2, 0.42, z - 0.8 + (x - 21 + index * 2) * 0.06);
    ticks.setMatrixAt(index, matrix);
  }
  ticks.receiveShadow = true;
  group.add(ticks);
}

/** The battery pack and leads that power the slot Track, wired in at the bench edge. */
function addPowerPack(group: THREE.Group, x: number, z: number): void {
  group.add(box(9, 4.2, 6.4, MATERIALS.plastic(0x24282e), [x, 2.1, z], 0.24));
  group.add(box(7.4, 0.7, 4.6, MATERIALS.plastic(0x35d17a), [x, 4.4, z], 0.24));
  for (const [index, color] of [0xd8452f, 0x1b1e22].entries()) {
    const lead = new THREE.Mesh(
      new THREE.TubeGeometry(
        // The leads trail toward the Track without crowding it; the Track's own supply is
        // implied rather than modelled all the way to the rail.
        new THREE.CatmullRomCurve3([
          new THREE.Vector3(x + 3.6, 2.2 + index * 0.8, z + 1 - index * 1.2),
          new THREE.Vector3(x + 7.5, 0.6, z + 0.4),
          new THREE.Vector3(x + 11, 0.4, z + 1.2 - index),
          new THREE.Vector3(x + 14.5, 0.5 + index * 0.3, z + 1.8 - index * 1.4),
        ]),
        24,
        0.32,
        6,
      ),
      MATERIALS.plastic(color),
    );
    lead.castShadow = true;
    group.add(lead);
  }
}

/** Clamp lamp on a stand behind the bench; its warm pool is the workshop's key light. */
function addWorkLamp(group: THREE.Group): void {
  const position = new THREE.Vector3(-30, 27, -20);
  const stand = MATERIALS.steel(0x6a7178);
  const base: [number, number] = [-41, -27];
  group.add(cylinder(2.6, 3.4, 0.8, stand, [base[0], 0.4, base[1]], [0, 0, 0], 10));
  group.add(cylinder(0.55, 0.55, position.y, stand, [base[0], position.y / 2, base[1]], [0, 0, 0], 8));
  const reach = new THREE.Vector3(position.x - base[0], 0, position.z - base[1]);
  const arm = cylinder(0.42, 0.42, reach.length(), stand,
    [(base[0] + position.x) / 2, position.y, (base[1] + position.z) / 2],
    [Math.PI / 2, 0, -Math.atan2(reach.z, reach.x) + Math.PI / 2], 8);
  group.add(arm);
  const shade = new THREE.Mesh(
    new THREE.ConeGeometry(5.2, 5, 16, 1, true),
    new THREE.MeshStandardMaterial({ color: 0xd8452f, roughness: 0.5, side: THREE.DoubleSide }),
  );
  shade.position.copy(position);
  shade.rotation.set(Math.PI + 0.35, 0, 0.2);
  shade.castShadow = true;
  group.add(shade);
  const bulb = new THREE.Mesh(
    new THREE.SphereGeometry(1.5, 12, 10),
    new THREE.MeshStandardMaterial({ color: 0xfff2cc, emissive: 0xffd88a, emissiveIntensity: 2.2 }),
  );
  bulb.position.set(position.x, position.y - 2.2, position.z + 0.8);
  group.add(bulb);
}

function addCardboardBox(group: THREE.Group, x: number, z: number): void {
  const cardboard = MATERIALS.paper(0xb08753);
  group.add(box(14, 9, 12, cardboard, [x, 4.5, z], -0.3));
  group.add(box(7.2, 0.5, 12.4, cardboard, [x - 3.4, 9.4, z], -0.3));
  const flap = box(7.2, 0.5, 12.4, cardboard, [x + 4.4, 10.6, z], -0.3);
  flap.rotation.z = -0.7;
  group.add(flap);
}

function addScatteredHardware(group: THREE.Group): void {
  const screws = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.32, 0.32, 1.9, 6), MATERIALS.steel(0x9aa2aa), 26);
  const matrix = new THREE.Matrix4();
  const rotation = new THREE.Euler();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3(1, 1, 1);
  for (let index = 0; index < 26; index += 1) {
    const angle = index * 2.399;
    const radius = 42 + (index % 5) * 2;
    rotation.set(Math.PI / 2, angle * 1.7, 0);
    quaternion.setFromEuler(rotation);
    matrix.compose(
      new THREE.Vector3(Math.cos(angle) * radius, 0.32, Math.sin(angle) * radius * 0.55),
      quaternion,
      scale,
    );
    screws.setMatrixAt(index, matrix);
  }
  screws.castShadow = true;
  screws.receiveShadow = true;
  group.add(screws);
}

function addLighting(scene: THREE.Scene): void {
  scene.add(new THREE.HemisphereLight(0xa8bed6, 0x3a2f22, 1.15));

  // Daylight through the workshop window: the shadow-casting key.
  const key = new THREE.DirectionalLight(0xffe9c4, 3.2);
  key.position.set(34, 44, -46);
  key.target.position.set(-4, 0, 2);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.left = -52;
  key.shadow.camera.right = 52;
  key.shadow.camera.top = 44;
  key.shadow.camera.bottom = -44;
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 140;
  key.shadow.bias = -0.0009;
  key.shadow.normalBias = 0.03;
  scene.add(key, key.target);

  // Warm pool from the clamp lamp, and a cool bounce from the far side of the bench.
  const lamp = new THREE.SpotLight(0xffcf86, 900, 96, Math.PI / 4.4, 0.55, 1.7);
  lamp.position.set(-30, 27.5, -19);
  lamp.target.position.set(-16, 0, 2);
  scene.add(lamp, lamp.target);

  const bounce = new THREE.PointLight(0x5f9ad8, 220, 120, 1.9);
  bounce.position.set(38, 16, 30);
  scene.add(bounce);

  const rim = new THREE.PointLight(0xff7a3c, 150, 90, 2);
  rim.position.set(-40, 12, 26);
  scene.add(rim);
}
