import * as THREE from "three";
import type { CarState } from "./race";
import type { VisualEffect } from "./feedback";

/** A fixed particle budget keeps boost exhaust and impacts cheap even in a full grid. */
export function createRaceVfx(scene: THREE.Scene) {
  const count = 320;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const fades = new Float32Array(count);
  const velocities = new Float32Array(count * 3);
  const life = new Float32Array(count);
  const duration = new Float32Array(count);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute("size", new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute("fade", new THREE.BufferAttribute(fades, 1));
  const material = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { pixelRatio: { value: Math.min(devicePixelRatio, 1.75) } },
    vertexShader: `attribute vec3 color; attribute float size; attribute float fade;
      uniform float pixelRatio; varying vec3 vColor; varying float vFade;
      void main() { vColor = color; vFade = fade; vec4 p = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = clamp(size * 210.0 * pixelRatio / max(1.0, -p.z), 1.0, 42.0);
        gl_Position = projectionMatrix * p; }`,
    fragmentShader: `varying vec3 vColor; varying float vFade;
      void main() { float r = length(gl_PointCoord - .5) * 2.0;
        float glow = pow(max(0.0, 1.0 - r), 2.0);
        gl_FragColor = vec4(vColor, glow * vFade); }`,
  });
  const particles = new THREE.Points(geometry, material);
  particles.frustumCulled = false;
  particles.renderOrder = 4;
  scene.add(particles);
  let cursor = 0;
  const point = new THREE.Vector3();
  const tint = new THREE.Color();

  function emit(at: THREE.Vector3, color: number, speed: number, size: number, seconds: number) {
    const i = cursor++ % count, k = i * 3;
    positions[k] = at.x; positions[k + 1] = at.y; positions[k + 2] = at.z;
    tint.setHex(color);
    colors[k] = tint.r * 2.2; colors[k + 1] = tint.g * 2.2; colors[k + 2] = tint.b * 2.2;
    velocities[k] = (Math.random() - .5) * speed;
    velocities[k + 1] = Math.random() * speed * .7;
    velocities[k + 2] = (Math.random() - .5) * speed;
    life[i] = duration[i] = seconds; sizes[i] = size;
  }

  return {
    car(car: THREE.Group, state: CarState, seconds: number, reduced: boolean) {
      if (reduced || state.result !== "racing" || state.crashRecoveryTicksRemaining > 0) return;
      const boosting = state.boostTicksRemaining > 0;
      const sliding = state.deslotPressure > 0 || state.ordinaryContact !== null;
      if (!boosting && !sliding) { car.userData.exhaustCarry = 0; return; }
      let carry = (car.userData.exhaustCarry as number | undefined ?? 0) + seconds * (boosting ? 65 : 28);
      while (carry >= 1) {
        carry -= 1;
        point.set((Math.random() - .5) * .55, boosting ? .26 : .08, -1.12).applyQuaternion(car.quaternion).add(car.position);
        emit(point, boosting ? (Math.random() > .5 ? 0x55cfff : 0xffc467) : 0xffb446,
          boosting ? 1.4 : 3.8, boosting ? .24 : .09, boosting ? .32 : .44);
      }
      car.userData.exhaustCarry = carry;
    },
    burst(source: THREE.Object3D, effect: VisualEffect, reduced: boolean) {
      if (reduced || effect === "ring" || effect === "banner") return;
      const impact = ["sparks", "impact", "hazard-hit", "bump"].includes(effect);
      for (let i = 0; i < (impact ? 28 : 14); i++) {
        point.copy(source.position); point.y += .35;
        emit(point, impact ? 0xffac40 : effect === "shield-pop" ? 0x55dfff : 0x81ecff,
          impact ? 6 : 3, impact ? .1 : .18, .4 + Math.random() * .35);
      }
    },
    update(seconds: number) {
      for (let i = 0; i < count; i++) {
        if (life[i]! <= 0) { fades[i] = 0; continue; }
        life[i] = Math.max(0, life[i]! - seconds);
        const k = i * 3;
        positions[k] = positions[k]! + velocities[k]! * seconds;
        positions[k + 1] = positions[k + 1]! + velocities[k + 1]! * seconds;
        positions[k + 2] = positions[k + 2]! + velocities[k + 2]! * seconds;
        velocities[k + 1] = velocities[k + 1]! - seconds * 3;
        fades[i] = life[i]! / duration[i]!;
      }
      geometry.attributes.position!.needsUpdate = true;
      geometry.attributes.color!.needsUpdate = true;
      geometry.attributes.size!.needsUpdate = true;
      geometry.attributes.fade!.needsUpdate = true;
    },
  };
}
