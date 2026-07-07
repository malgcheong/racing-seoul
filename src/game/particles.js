// 링버퍼 기반 초경량 파티클 (부스터 불꽃, 드리프트 스모크)
// 가산 블렌딩 + 수명에 따라 색을 어둡게 → 자연스러운 페이드아웃

import * as THREE from 'three';

const MAX = 240;

export class ParticleSystem {
  constructor(scene) {
    this.positions = new Float32Array(MAX * 3);
    this.colors = new Float32Array(MAX * 3);
    this.data = Array.from({ length: MAX }, () => ({
      life: 0, maxLife: 1,
      x: 0, y: -999, z: 0,
      vx: 0, vy: 0, vz: 0,
      r: 1, g: 1, b: 1,
    }));
    this.cursor = 0;

    const geo = new THREE.BufferGeometry();
    this.positions.fill(-999);
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));

    const mat = new THREE.PointsMaterial({
      size: 1.5,
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
  }

  emit(pos, vel, color, life) {
    const d = this.data[this.cursor];
    this.cursor = (this.cursor + 1) % MAX;
    d.life = d.maxLife = life;
    d.x = pos.x; d.y = pos.y; d.z = pos.z;
    d.vx = vel.x; d.vy = vel.y; d.vz = vel.z;
    d.r = color.r; d.g = color.g; d.b = color.b;
  }

  update(dt) {
    for (let i = 0; i < MAX; i++) {
      const d = this.data[i];
      if (d.life <= 0) {
        this.positions[i * 3 + 1] = -999;
        continue;
      }
      d.life -= dt;
      d.x += d.vx * dt; d.y += d.vy * dt; d.z += d.vz * dt;
      d.vx *= 0.96; d.vz *= 0.96;
      const t = Math.max(0, d.life / d.maxLife);
      this.positions[i * 3] = d.x;
      this.positions[i * 3 + 1] = d.y;
      this.positions[i * 3 + 2] = d.z;
      this.colors[i * 3] = d.r * t;
      this.colors[i * 3 + 1] = d.g * t;
      this.colors[i * 3 + 2] = d.b * t;
    }
    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.geometry.attributes.color.needsUpdate = true;
  }
}
