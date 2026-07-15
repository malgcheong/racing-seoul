// 비 — 카메라 주변 박스 안에서 떨어지는 라인 스트릭(랩어라운드).
// 비 필드는 카메라에 상대적(레이싱 게임 표준): 차가 달려도 밀도가 유지된다.

import * as THREE from 'three';

export class Rain {
  constructor(scene, count = 650) {
    this.scene = scene;
    this.count = count;
    this.boxX = 56;
    this.boxY = 30;
    this.boxZ = 56;
    this.speed = 26; // 낙하 속도 m/s
    this.len = 1.15; // 스트릭 길이

    this.offsets = new Float32Array(count * 3); // 카메라 기준 상대 위치
    for (let i = 0; i < count; i++) {
      this.offsets[i * 3] = (Math.random() - 0.5) * this.boxX;
      this.offsets[i * 3 + 1] = Math.random() * this.boxY;
      this.offsets[i * 3 + 2] = (Math.random() - 0.5) * this.boxZ;
    }
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 6), 3));
    const mat = new THREE.LineBasicMaterial({
      color: 0x93a7cc,
      transparent: true,
      opacity: 0.32,
      depthWrite: false,
    });
    this.mesh = new THREE.LineSegments(this.geo, mat);
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  update(dt, camPos) {
    const p = this.geo.attributes.position.array;
    for (let i = 0; i < this.count; i++) {
      let y = this.offsets[i * 3 + 1] - this.speed * dt;
      if (y < 0) y += this.boxY;
      this.offsets[i * 3 + 1] = y;
      const x = camPos.x + this.offsets[i * 3];
      const z = camPos.z + this.offsets[i * 3 + 2];
      const wy = camPos.y - 12 + y; // 카메라 아래 12m ~ 위 18m 창
      const o = i * 6;
      p[o] = x; p[o + 1] = wy; p[o + 2] = z;
      p[o + 3] = x; p[o + 4] = wy + this.len; p[o + 5] = z;
    }
    this.geo.attributes.position.needsUpdate = true;
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.geo.dispose();
    this.mesh.material.dispose();
  }
}
