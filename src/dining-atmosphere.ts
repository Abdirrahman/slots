import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

/** The room is an afternoon miniature race meet: warm timber, cool racing plastic. */
export function enhanceDiningScene(
  scene: THREE.Scene,
  map: THREE.Group,
  renderer: THREE.WebGLRenderer,
): { update(elapsedSeconds: number, reducedMotion: boolean): void } {
  scene.background = new THREE.Color(0xc3c6bc);
  scene.fog = new THREE.Fog(0xc3c6bc, 105, 215);
  renderer.toneMappingExposure = 0.98;

  const environment = new RoomEnvironment();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(environment, 0.035).texture;
  scene.environmentIntensity = 0.42;
  environment.dispose();
  pmrem.dispose();

  scene.add(new THREE.HemisphereLight(0xc4ddf2, 0x75503a, 0.82));
  const sun = new THREE.DirectionalLight(0xffe3b7, 2.4);
  sun.position.set(-38, 64, 32);
  sun.target.position.set(3, 0, -8);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -67, right: 67, top: 60, bottom: -60, near: 1, far: 160 });
  sun.shadow.bias = -0.00025;
  sun.shadow.normalBias = 0.055;
  sun.shadow.radius = 3;
  scene.add(sun, sun.target);
  const windowFill = new THREE.DirectionalLight(0xc2e4ff, 0.45);
  windowFill.position.set(-28, 27, 42);
  windowFill.target.position.set(-15, 0, 0);
  scene.add(windowFill, windowFill.target);
  const roomBounce = new THREE.DirectionalLight(0xffe4cc, 0.32);
  roomBounce.position.set(45, 20, -35);
  scene.add(roomBounce);
  const lamp = new THREE.PointLight(0xffb963, 90, 40, 2);
  lamp.position.set(20, 26.9, 16);
  scene.add(lamp);

  dressMaterials(map, Math.min(renderer.capabilities.getMaxAnisotropy(), 8));

  const dressing = new THREE.Group();
  dressing.name = "dining-race-atmosphere";
  map.add(dressing);
  addRoomBackdrop(dressing);
  addWindow(dressing);
  addRug(dressing);
  addContactShadows(dressing);
  addRoomPoster(dressing);
  addPitKit(dressing);
  addTrackSigns(dressing);
  const flags = addFlags(dressing);
  const dust = addDust(dressing);

  return {
    update(elapsedSeconds, reducedMotion) {
      flags.forEach((flag, index) => {
        flag.rotation.y = -0.12 + (reducedMotion ? 0 : Math.sin(elapsedSeconds * 1.35 + index * 1.7) * 0.07);
      });
      if (reducedMotion) return;
      const positions = dust.geometry.getAttribute("position");
      for (let index = 0; index < dust.seeds.length; index += 1) {
        const seed = dust.seeds[index]!;
        positions.setXYZ(index,
          seed.x + Math.sin(elapsedSeconds * 0.18 + index) * 0.5,
          2 + ((seed.y + elapsedSeconds * 0.09) % 24),
          seed.z + Math.cos(elapsedSeconds * 0.15 + index * 0.7) * 0.35,
        );
      }
      positions.needsUpdate = true;
    },
  };
}

function random(seed = 31): () => number {
  return () => {
    seed = Math.imul(seed, 1664525) + 1013904223 | 0;
    return (seed >>> 0) / 4294967296;
  };
}

function paintedTexture(
  width: number,
  height: number,
  paint: (context: CanvasRenderingContext2D) => void,
): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d")!;
  paint(context);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function dressMaterials(map: THREE.Group, anisotropy: number): void {
  const rng = random();
  const grain = paintedTexture(512, 128, (ctx) => {
    ctx.fillStyle = "#e6dcc9";
    ctx.fillRect(0, 0, 512, 128);
    for (let line = 0; line < 200; line += 1) {
      const y = rng() * 128;
      ctx.strokeStyle = `rgba(86,53,28,${0.02 + rng() * 0.11})`;
      ctx.lineWidth = 0.3 + rng() * 1.1;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.bezierCurveTo(170, y + rng() * 7 - 3.5, 320, y + rng() * 7 - 3.5, 512, y);
      ctx.stroke();
    }
    for (let ring = 1; ring < 7; ring += 1) {
      ctx.strokeStyle = `rgba(74,43,24,${0.09 - ring * 0.01})`;
      ctx.beginPath();
      ctx.ellipse(340, 71, ring * 13, ring * 1.6, 0.02, 0, Math.PI * 2);
      ctx.stroke();
    }
  });
  const plastic = paintedTexture(128, 128, (ctx) => {
    ctx.fillStyle = "#dedfe0";
    ctx.fillRect(0, 0, 128, 128);
    for (let speck = 0; speck < 4200; speck += 1) {
      ctx.fillStyle = rng() > 0.5 ? "#c2c6c8" : "#f0f0ed";
      ctx.fillRect(rng() * 128, rng() * 128, 0.7, 0.7);
    }
  });
  const weave = paintedTexture(64, 64, (ctx) => {
    ctx.fillStyle = "#e4dfd5";
    ctx.fillRect(0, 0, 64, 64);
    ctx.fillStyle = "rgba(45,32,24,0.10)";
    for (let line = 0; line < 64; line += 3) {
      ctx.fillRect(line, 0, 1, 64);
      ctx.fillRect(0, line, 64, 1);
    }
  });
  for (const texture of [grain, plastic, weave]) {
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.anisotropy = anisotropy;
  }
  const treated = new Set<THREE.Material>();
  map.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.receiveShadow = true;
    // The window and cutaway wall are a painted backdrop; they must not block the key light.
    object.castShadow = !/floor|wall|window-blue-sky|road-panel-seams|pinstripe|copper|kerbs/.test(object.name);
    const wood = /oak|walnut/.test(object.material instanceof THREE.Material ? object.material.name : object.name)
      || /floor-planks|dining-table|dining-chair/.test(object.name);
    const cloth = /cloth|curtains|cushion/.test(object.name);
    const road = object.name.startsWith("track-surface");
    if (wood || cloth || road) projectTextureCoordinates(object.geometry, wood ? 16 : cloth ? 2 : 2.5, wood ? 4 : cloth ? 2 : 2.5);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (!(material instanceof THREE.MeshStandardMaterial) || treated.has(material)) continue;
      treated.add(material);
      if (/oak|walnut/.test(material.name)) {
        material.color.multiplyScalar(0.85);
        material.map = grain;
        material.bumpMap = grain;
        material.bumpScale = 0.018;
        material.roughness = material.name.includes("walnut") ? 0.38 : 0.66;
      } else if (material.name === "dining-asphalt") {
        material.color.set(0x313b43);
        material.map = plastic;
        material.bumpMap = plastic;
        material.bumpScale = 0.012;
        material.roughness = 0.64;
        material.metalness = 0.08;
      } else if (/cloth|teal/.test(material.name)) {
        material.map = weave;
        material.roughness = 0.94;
      } else if (/copper|brass/.test(material.name)) {
        material.roughness = 0.27;
        material.metalness = 0.9;
      } else if (/blue|edge/.test(material.name)) {
        material.roughness = 0.32;
        material.metalness = 0.08;
      } else if (material.name === "dining-ceramic") {
        material.roughness = 0.22;
      } else if (material.name === "dining-sage") {
        material.roughness = 1;
        material.color.set(0x799087);
      }
      material.needsUpdate = true;
    }
  });
}

/** Existing Blender meshes have no UVs; planar face projection keeps their authored geometry. */
function projectTextureCoordinates(geometry: THREE.BufferGeometry, width: number, height: number): void {
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  const uv = new Float32Array(position.count * 2);
  for (let index = 0; index < position.count; index += 1) {
    const nx = Math.abs(normal.getX(index));
    const ny = Math.abs(normal.getY(index));
    const nz = Math.abs(normal.getZ(index));
    uv[index * 2] = (nx > ny && nx > nz ? position.getZ(index) : position.getX(index)) / width;
    uv[index * 2 + 1] = (ny >= nx && ny >= nz ? position.getZ(index) : position.getY(index)) / height;
  }
  geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
}

function addRoomBackdrop(group: THREE.Group): void {
  const wallTexture = paintedTexture(1024, 256, (ctx) => {
    ctx.fillStyle = "#d9d1bd";
    ctx.fillRect(0, 0, 1024, 256);
    ctx.fillStyle = "#99a69b";
    ctx.fillRect(0, 204, 1024, 52);
    ctx.fillStyle = "#e8dfca";
    ctx.fillRect(0, 201, 1024, 5);
    ctx.fillRect(0, 247, 1024, 9);
    ctx.strokeStyle = "rgba(61,79,70,0.16)";
    ctx.lineWidth = 2;
    for (let x = 32; x < 1024; x += 128) ctx.strokeRect(x, 213, 102, 25);
    const rng = random(42);
    for (let speck = 0; speck < 4500; speck += 1) {
      ctx.fillStyle = "rgba(75,64,45,0.025)";
      ctx.fillRect(rng() * 1024, rng() * 256, 1, 1);
    }
  });
  const wall = new THREE.MeshStandardMaterial({ map: wallTexture, roughness: 1 });
  // Front faces close the room from the driving camera; exterior overview cameras keep the cutaway.
  const south = new THREE.Mesh(new THREE.PlaneGeometry(128, 32), wall);
  south.position.set(0, 16, -43.65);
  const east = new THREE.Mesh(new THREE.PlaneGeometry(87, 32), wall);
  east.position.set(63.65, 16, 0);
  east.rotation.y = -Math.PI / 2;
  south.receiveShadow = true;
  east.receiveShadow = true;
  group.add(south, east);

  const wood = new THREE.MeshStandardMaterial({ color: 0x644330, roughness: 0.67 });
  const shelfParts: [number, number, number, number, number, number][] = [
    [55, 9, -40.4, 12, 18, 0.5], [48.8, 9, -39.3, 0.45, 18, 2.7], [61.2, 9, -39.3, 0.45, 18, 2.7],
    ...[0.3, 4.6, 8.8, 13.1, 17.8].map((y): [number, number, number, number, number, number] => [55, y, -39.3, 12.8, 0.38, 2.9]),
  ];
  const shelves = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), wood, shelfParts.length);
  const transform = new THREE.Object3D();
  shelfParts.forEach(([x, y, z, w, h, d], index) => {
    transform.position.set(x, y, z);
    transform.scale.set(w, h, d);
    transform.updateMatrix();
    shelves.setMatrixAt(index, transform.matrix);
  });
  shelves.castShadow = true;
  shelves.receiveShadow = true;
  const books = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ roughness: 0.88 }), 32);
  const colors = [0x477d82, 0xc66b48, 0xc5a261, 0xe8dbc0, 0x3c5267, 0x788c68];
  const rng = random(45);
  for (let index = 0; index < 32; index += 1) {
    const shelf = Math.floor(index / 8);
    const height = 2.4 + rng() * 1.15;
    transform.position.set(50.1 + index % 8 * 1.24, 0.6 + shelf * 4.23 + height / 2, -39);
    transform.scale.set(0.65 + rng() * 0.33, height, 1.6 + rng() * 0.35);
    transform.rotation.z = (rng() - 0.5) * 0.09;
    transform.updateMatrix();
    books.setMatrixAt(index, transform.matrix);
    books.setColorAt(index, new THREE.Color(colors[index % colors.length]!));
  }
  books.castShadow = true;
  group.add(shelves, books);
}

function addWindow(group: THREE.Group): void {
  const sky = paintedTexture(1024, 512, (ctx) => {
    const gradient = ctx.createLinearGradient(0, 0, 0, 512);
    gradient.addColorStop(0, "#70b4ce");
    gradient.addColorStop(0.7, "#d4e3dc");
    gradient.addColorStop(1, "#f2e3b3");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 1024, 512);
    const haze = ctx.createRadialGradient(220, 125, 20, 220, 125, 370);
    haze.addColorStop(0, "rgba(255,250,225,0.8)");
    haze.addColorStop(1, "rgba(255,250,225,0)");
    ctx.fillStyle = haze;
    ctx.fillRect(0, 0, 1024, 512);
    ctx.fillStyle = "rgba(255,255,242,0.45)";
    for (const [x, y, w] of [[520, 93, 220], [880, 210, 270], [230, 265, 200]]) {
      ctx.beginPath();
      ctx.ellipse(x!, y!, w!, 19, -0.04, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = "#92ad8d";
    ctx.beginPath();
    ctx.moveTo(0, 420);
    ctx.bezierCurveTo(230, 365, 370, 450, 600, 388);
    ctx.bezierCurveTo(780, 365, 900, 380, 1024, 348);
    ctx.lineTo(1024, 512);
    ctx.lineTo(0, 512);
    ctx.fill();
    ctx.fillStyle = "#6e997e";
    ctx.beginPath();
    ctx.moveTo(0, 467);
    ctx.bezierCurveTo(290, 418, 440, 483, 690, 438);
    ctx.bezierCurveTo(875, 408, 925, 423, 1024, 403);
    ctx.lineTo(1024, 512);
    ctx.lineTo(0, 512);
    ctx.fill();
  });
  const view = new THREE.Mesh(new THREE.PlaneGeometry(26, 16), new THREE.MeshBasicMaterial({ map: sky }));
  view.name = "afternoon-window-view";
  view.position.set(-29, 21, 42.98);
  view.rotation.y = Math.PI;
  group.add(view);

  const sunlight = paintedTexture(256, 256, (ctx) => {
    for (let row = 0; row < 2; row += 1) {
      for (let column = 0; column < 2; column += 1) {
        const x = 12 + column * 124;
        const y = 10 + row * 125;
        const glow = ctx.createLinearGradient(0, y, 0, y + 118);
        glow.addColorStop(0, "rgba(255,222,151,0.24)");
        glow.addColorStop(0.75, "rgba(255,222,151,0.15)");
        glow.addColorStop(1, "rgba(255,222,151,0)");
        ctx.fillStyle = glow;
        ctx.fillRect(x, y, 113, 117);
      }
    }
  });
  const pool = new THREE.Mesh(new THREE.PlaneGeometry(27, 31), new THREE.MeshBasicMaterial({
    map: sunlight, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
  }));
  pool.name = "window-light-on-floor";
  pool.rotation.set(-Math.PI / 2, 0, -0.18);
  pool.position.set(-26, -0.035, 18);
  group.add(pool);
}

function addRug(group: THREE.Group): void {
  const texture = paintedTexture(768, 512, (ctx) => {
    ctx.fillStyle = "#627c79";
    ctx.fillRect(0, 0, 768, 512);
    for (const [inset, color] of [[9, "#d5b68a"], [19, "#a64e39"], [33, "#ddd0ae"], [42, "#345453"]] as const) {
      ctx.strokeStyle = color;
      ctx.lineWidth = 9;
      ctx.strokeRect(inset, inset, 768 - inset * 2, 512 - inset * 2);
    }
    ctx.lineWidth = 3;
    for (let x = 96; x < 730; x += 96) {
      for (let y = 90; y < 460; y += 84) {
        ctx.strokeStyle = (x / 96 + y / 84) % 2 < 1 ? "#a9b0a1" : "#bc986e";
        ctx.beginPath();
        ctx.moveTo(x, y - 20);
        ctx.lineTo(x + 15, y);
        ctx.lineTo(x, y + 20);
        ctx.lineTo(x - 15, y);
        ctx.closePath();
        ctx.stroke();
      }
    }
    const rng = random(53);
    for (let speck = 0; speck < 16000; speck += 1) {
      ctx.fillStyle = rng() > 0.5 ? "rgba(255,243,218,0.08)" : "rgba(15,36,31,0.1)";
      ctx.fillRect(rng() * 768, rng() * 512, 1, 1);
    }
  });
  texture.anisotropy = 8;
  const rug = new THREE.Mesh(new THREE.PlaneGeometry(38, 24), new THREE.MeshStandardMaterial({ map: texture, roughness: 1 }));
  rug.name = "woven-dining-rug";
  rug.rotation.x = -Math.PI / 2;
  rug.position.set(0, -0.025, 0);
  rug.receiveShadow = true;
  group.add(rug);
}

function addContactShadows(group: THREE.Group): void {
  const texture = paintedTexture(64, 64, (ctx) => {
    const shadow = ctx.createRadialGradient(32, 32, 3, 32, 32, 31);
    shadow.addColorStop(0, "rgba(32,22,16,0.40)");
    shadow.addColorStop(0.5, "rgba(32,22,16,0.15)");
    shadow.addColorStop(1, "rgba(32,22,16,0)");
    ctx.fillStyle = shadow;
    ctx.fillRect(0, 0, 64, 64);
  });
  const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, toneMapped: false });
  const geometry = new THREE.PlaneGeometry(1, 1);
  for (const [x, z, width, depth, y] of [
    [-12, 1, 14, 14, -0.014], [12, 1, 14, 14, -0.014], [-30, -2, 18, 15, -0.03],
    [-27, 11, 7, 7, -0.03], [27, 11, 7, 7, -0.03], [-27, 33, 7, 7, -0.03], [27, 33, 7, 7, -0.03],
  ]) {
    const shadow = new THREE.Mesh(geometry, material);
    shadow.name = "furniture-contact-shadow";
    shadow.rotation.x = -Math.PI / 2;
    shadow.scale.set(width!, depth!, 1);
    shadow.position.set(x!, y!, z!);
    group.add(shadow);
  }
}

function addRoomPoster(group: THREE.Group): void {
  const art = paintedTexture(512, 640, (ctx) => {
    ctx.fillStyle = "#eee4c8";
    ctx.fillRect(0, 0, 512, 640);
    ctx.fillStyle = "#215a68";
    ctx.fillRect(24, 24, 464, 592);
    ctx.fillStyle = "#eee4c8";
    ctx.font = "900 90px sans-serif";
    ctx.fillText("SLOT", 55, 122);
    ctx.fillText("CLUB", 55, 204);
    ctx.strokeStyle = "#e8ac54";
    ctx.lineWidth = 34;
    ctx.beginPath();
    ctx.moveTo(154, 337);
    ctx.bezierCurveTo(35, 340, 65, 508, 175, 507);
    ctx.lineTo(335, 507);
    ctx.bezierCurveTo(455, 507, 462, 337, 335, 337);
    ctx.closePath();
    ctx.stroke();
    ctx.strokeStyle = "#eee4c8";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = "#e56d4e";
    ctx.fillRect(195, 316, 60, 40);
    ctx.fillStyle = "#eee4c8";
    ctx.font = "bold 20px sans-serif";
    ctx.fillText("THE AFTER-SCHOOL GRAND PRIX", 56, 582);
  });
  const frame = new THREE.Mesh(new THREE.BoxGeometry(14.8, 18.5, 0.45), new THREE.MeshStandardMaterial({ color: 0x513d2c, roughness: 0.48 }));
  frame.position.set(47, 20.5, 42.8);
  const poster = new THREE.Mesh(new THREE.PlaneGeometry(13.8, 17.5), new THREE.MeshStandardMaterial({ map: art, roughness: 0.88 }));
  poster.rotation.y = Math.PI;
  poster.position.set(47, 20.5, 42.54);
  group.add(frame, poster);
}

function signTexture(title: string, subtitle: string, color: string): THREE.CanvasTexture {
  return paintedTexture(768, 192, (ctx) => {
    ctx.fillStyle = "#efe8d5";
    ctx.fillRect(0, 0, 768, 192);
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 18, 192);
    ctx.fillRect(0, 174, 768, 18);
    ctx.fillStyle = "#173f50";
    ctx.font = "900 italic 81px sans-serif";
    ctx.fillText(title, 36, 103);
    ctx.font = "bold 24px sans-serif";
    ctx.fillText(subtitle, 39, 147);
    ctx.fillStyle = color;
    for (let x = 637; x < 745; x += 27) ctx.fillRect(x, 30 + ((x - 637) / 27 % 2) * 25, 27, 25);
  });
}

function addTrackSigns(group: THREE.Group): void {
  const backing = new THREE.MeshStandardMaterial({ color: 0x183f50, roughness: 0.52 });
  for (const [x, z, title, subtitle, color] of [
    [-13, -30.6, "SLOT CLUB", "SMALL CARS. BIG RACING.", "#e46d48"],
    [9, -30.6, "APEX", "PERFORMANCE ELECTRICS", "#e3aa44"],
    [31, -29.6, "COPPER", "MOTOR WORKS · EST. 1998", "#44878c"],
  ] as const) {
    const board = new THREE.Mesh(new THREE.BoxGeometry(10, 2.45, 0.25), backing);
    board.position.set(x, 1.38, z);
    board.castShadow = true;
    const face = new THREE.Mesh(new THREE.PlaneGeometry(9.85, 2.3), new THREE.MeshStandardMaterial({
      map: signTexture(title, subtitle, color), roughness: 0.72,
    }));
    face.position.set(x, 1.38, z + 0.135);
    group.add(board, face);
  }
  const finish = new THREE.Mesh(new THREE.PlaneGeometry(4.6, 0.65), new THREE.MeshBasicMaterial({
    map: signTexture("SLOT CLUB", "", "#e46d48"),
  }));
  finish.position.set(-22.49, 5.5, -25);
  finish.rotation.y = -Math.PI / 2;
  group.add(finish);
  const boxLabel = new THREE.Mesh(new THREE.PlaneGeometry(8.8, 2.6), new THREE.MeshStandardMaterial({
    map: signTexture("SLOT CLUB", "FOUR-LANE RACING SET", "#e46d48"), roughness: 0.85,
  }));
  boxLabel.position.set(-30, 3.7, -7.64);
  boxLabel.rotation.y = Math.PI;
  group.add(boxLabel);
}

function addFlags(group: THREE.Group): THREE.Group[] {
  const flagTexture = paintedTexture(256, 128, (ctx) => {
    ctx.fillStyle = "#eee8d7";
    ctx.fillRect(0, 0, 256, 128);
    ctx.fillStyle = "#173f50";
    for (let y = 0; y < 4; y += 1) {
      for (let x = 0; x < 8; x += 1) if ((x + y) % 2 === 0) ctx.fillRect(x * 32, y * 32, 32, 32);
    }
  });
  const material = new THREE.MeshStandardMaterial({ map: flagTexture, side: THREE.DoubleSide, roughness: 0.92 });
  const poleMaterial = new THREE.MeshStandardMaterial({ color: 0xcbd3cf, roughness: 0.34, metalness: 0.65 });
  const flags: THREE.Group[] = [];
  for (const x of [-24, -20]) {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.075, 5.1, 8), poleMaterial);
    pole.position.set(x, 2.55, -31.2);
    pole.castShadow = true;
    const foot = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.16, 0.85), poleMaterial);
    foot.position.set(x, 0.08, -31.2);
    const pivot = new THREE.Group();
    pivot.position.set(x, 4.5, -31.2);
    const flag = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 1.2, 8, 1), material);
    const position = flag.geometry.getAttribute("position");
    for (let index = 0; index < position.count; index += 1) position.setZ(index, Math.sin((position.getX(index) + 1.2) * 3) * 0.08);
    flag.geometry.computeVertexNormals();
    flag.position.x = 1.2;
    pivot.add(flag);
    flags.push(pivot);
    group.add(pole, foot, pivot);
  }
  return flags;
}

function addPitKit(group: THREE.Group): void {
  const blue = new THREE.MeshStandardMaterial({ color: 0x225666, roughness: 0.42 });
  const cream = new THREE.MeshStandardMaterial({ color: 0xe9ddbf, roughness: 0.57 });
  const rubber = new THREE.MeshStandardMaterial({ color: 0x202527, roughness: 0.91 });
  const chrome = new THREE.MeshStandardMaterial({ color: 0xcbd2d0, metalness: 0.85, roughness: 0.3 });
  const toolbox = new THREE.Mesh(new THREE.BoxGeometry(5.4, 1.7, 3.1), blue);
  toolbox.position.set(-3, 0.85, -13);
  toolbox.castShadow = true;
  toolbox.receiveShadow = true;
  const lid = new THREE.Mesh(new THREE.BoxGeometry(5.55, 0.22, 3.25), cream);
  lid.position.set(-3, 1.79, -13);
  const handle = new THREE.Mesh(new THREE.TorusGeometry(0.55, 0.09, 6, 16, Math.PI), chrome);
  handle.position.set(-3, 2, -13);
  const controller = new THREE.Mesh(new THREE.BoxGeometry(1.45, 0.7, 2.5), new THREE.MeshStandardMaterial({ color: 0xbb4d35, roughness: 0.42 }));
  controller.position.set(4, 0.4, -13);
  controller.rotation.y = 0.3;
  controller.castShadow = true;
  const dial = new THREE.Mesh(new THREE.CylinderGeometry(0.33, 0.33, 0.2, 16), rubber);
  dial.position.set(4, 0.85, -13);
  const cable = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([
    new THREE.Vector3(4, 0.17, -14), new THREE.Vector3(6.4, 0.09, -15.5),
    new THREE.Vector3(8, 0.09, -14), new THREE.Vector3(6.5, 0.09, -12), new THREE.Vector3(7.2, 0.09, -11.2),
  ]), 32, 0.055, 5, false), rubber);
  const tires = new THREE.InstancedMesh(new THREE.TorusGeometry(0.47, 0.2, 8, 20), rubber, 6);
  const hubs = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.3, 0.3, 0.2, 12), chrome, 6);
  const transform = new THREE.Object3D();
  for (let index = 0; index < 6; index += 1) {
    const x = -9 + Math.floor(index / 3) * 1.6;
    const y = 0.22 + index % 3 * 0.38;
    transform.position.set(x, y, -13.5);
    transform.rotation.x = Math.PI / 2;
    transform.updateMatrix();
    tires.setMatrixAt(index, transform.matrix);
    transform.rotation.x = 0;
    transform.updateMatrix();
    hubs.setMatrixAt(index, transform.matrix);
  }
  tires.castShadow = true;
  group.add(toolbox, lid, handle, controller, dial, cable, tires, hubs);
}

function addDust(group: THREE.Group): { geometry: THREE.BufferGeometry; seeds: THREE.Vector3[] } {
  const rng = random(91);
  const seeds = Array.from({ length: 56 }, () => new THREE.Vector3(-43 + rng() * 35, rng() * 24, 8 + rng() * 32));
  const geometry = new THREE.BufferGeometry().setFromPoints(seeds.map((seed) => new THREE.Vector3(seed.x, seed.y + 2, seed.z)));
  const map = paintedTexture(32, 32, (ctx) => {
    const glow = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
    glow.addColorStop(0, "rgba(255,243,209,1)");
    glow.addColorStop(0.3, "rgba(255,243,209,0.6)");
    glow.addColorStop(1, "rgba(255,243,209,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, 32, 32);
  });
  const dust = new THREE.Points(geometry, new THREE.PointsMaterial({
    map, color: 0xffe9bc, size: 0.13, transparent: true, opacity: 0.32,
    depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  dust.name = "window-sunbeam-dust";
  dust.frustumCulled = false;
  group.add(dust);
  return { geometry, seeds };
}
