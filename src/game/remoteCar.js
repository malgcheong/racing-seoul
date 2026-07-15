// 원격 플레이어 차량 — 물리 주체가 아니라 "네트워크 상태 재생기".
// 상대 클라이언트가 이미 계산한 좌표를 받아 지연 버퍼(~130ms) 보간으로 따라간다.
// 충돌용 바디는 '동적 + 스프링 추종': 키네마틱(불가침 벽)으로 두면 상대 화면에서
// 내 고스트에 막혀 전진을 못 하는 문제가 생긴다 — 동적 바디는 부딪히면 서로
// 밀리고, 스프링 힘이 네트워크 좌표로 다시 수렴시켜 아무도 영구히 막히지 않는다.
// __traffic 플래그를 달지 않으므로 부딪혀도 즉시 실패가 아닌 범퍼 충돌로 처리된다.

import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { instantiate } from '../utils/assets.js';

const DELAY_MS = 130; // 보간 지연 버퍼(스냅샷 ~15Hz 기준 2틱)

export class RemoteCar {
  // headLight: 게임이 미리 만들어둔 풀 광원(셰이더 재컴파일 방지) — 없으면 광원 생략
  constructor(scene, world, modelName = 'car2', headLight = null) {
    this.group = new THREE.Group();
    const model = instantiate(modelName);
    model.rotation.y = Math.PI; // 에셋 전방 보정(Car와 동일)
    this.group.add(model);
    scene.add(this.group);

    this.body = new CANNON.Body({ mass: 1300, linearDamping: 0.05 });
    this.body.addShape(new CANNON.Box(new CANNON.Vec3(1.1, 0.5, 2.6)));
    this.body.fixedRotation = true; // 접촉으로 회전하지 않게(요는 네트워크 값으로 직접)
    this.body.updateMassProperties();
    world.addBody(this.body);

    // 헤드라이트(진짜 광원): 상대가 상향등(F)을 켜면 증폭 — 내 화면의 노면이
    // 뒤에서부터 확 밝아지고 룸미러에도 번쩍임이 보인다.
    // 광원은 게임이 빌드 때 만들어둔 풀에서 받는다 — 씬 광원 수가 중간에 늘면
    // 모든 재질 셰이더가 재컴파일되며 크게 버벅이기 때문(프리워밍).
    this.head = headLight;
    if (this.head) {
      this.head.position.set(0, 2.0, 1.5);
      this.head.target.position.set(0, -1.5, 32);
      this.head.intensity = 620;
      this.group.add(this.head, this.head.target);
    }
    this.highBeam = false;

    this.world = world;
    this.scene = scene;
    this.buf = []; // { rt(수신 로컬시각), x, y, z, h(헤딩), v(속도) }
    this.name = null;
    this.progress = 0;
    this.finished = false;
  }

  // 차 위에 떠 있는 이름표(카메라를 항상 향하는 스프라이트) — 최초 1회 생성
  setName(name) {
    if (this.name === name) return;
    this.name = name;
    if (this.label) this.group.remove(this.label);
    const cv = document.createElement('canvas');
    cv.width = 256; cv.height = 64;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = 'rgba(10,14,24,0.62)';
    ctx.beginPath();
    ctx.roundRect(28, 8, 200, 48, 12);
    ctx.fill();
    ctx.font = 'bold 30px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#eaf0ff';
    ctx.fillText(name, 128, 34);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.label = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex, transparent: true, depthWrite: false,
    }));
    this.label.scale.set(3.4, 0.85, 1);
    this.label.position.set(0, 2.7, 0);
    this.group.add(this.label);
  }

  push(snap) {
    this.buf.push({ rt: performance.now(), ...snap });
    if (this.buf.length > 40) this.buf.shift();
  }

  // 매 프레임: 수신시각 기준 (now - DELAY) 시점을 스냅샷 사이에서 보간한 목표를
  // 스프링 힘으로 추종. 시각(그룹)은 물리 바디를 따라가서 충돌 밀림이 눈에 보인다.
  update() {
    const n = this.buf.length;
    if (!n) return;
    const t = performance.now() - DELAY_MS;
    let a = this.buf[0], b = this.buf[n - 1];
    for (let i = n - 1; i > 0; i--) {
      if (this.buf[i - 1].rt <= t) { a = this.buf[i - 1]; b = this.buf[i]; break; }
    }
    const span = Math.max(1, b.rt - a.rt);
    const k = THREE.MathUtils.clamp((t - a.rt) / span, 0, 1.05); // 외삽 최소화(오버슈트 억제)
    const x = a.x + (b.x - a.x) * k;
    const y = a.y + (b.y - a.y) * k;
    const z = a.z + (b.z - a.z) * k;
    // 헤딩 보간(각도 랩)
    let dh = b.h - a.h;
    while (dh > Math.PI) dh -= Math.PI * 2;
    while (dh < -Math.PI) dh += Math.PI * 2;
    const h = a.h + dh * k;
    const v = b.v || 0;

    const bd = this.body;
    const dx = x - bd.position.x;
    const dz = z - bd.position.z;
    if (dx * dx + dz * dz > 36) {
      // 6m 이상 벗어남(강한 충돌·디싱크) — 순간이동 복구
      bd.position.set(x, y, z);
      bd.velocity.set(Math.sin(h) * v, 0, Math.cos(h) * v);
    } else {
      // 스프링 추종: 목표 속도 = 상대 주행 속도 + 위치 오차 보정 성분
      const desVx = Math.sin(h) * v + dx * 4;
      const desVz = Math.cos(h) * v + dz * 4;
      let fx = (desVx - bd.velocity.x) * 6 * bd.mass;
      let fz = (desVz - bd.velocity.z) * 6 * bd.mass;
      const fm = Math.hypot(fx, fz), fmax = 30 * bd.mass; // 가속도 상한
      if (fm > fmax) { fx *= fmax / fm; fz *= fmax / fm; }
      bd.force.x += fx;
      bd.force.z += fz;
    }
    // 고도·요는 네트워크 값 직결(물리 y 진동·접촉 스핀 방지)
    bd.position.y = y;
    bd.velocity.y = 0;
    bd.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), h);

    this.group.position.set(bd.position.x, bd.position.y, bd.position.z);
    this.group.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), h);

    // 상향등 상태 반영 (플레이어 헤드라이트와 같은 증폭 비율)
    if (this.head) {
      this.head.intensity = 620 * (this.highBeam ? 2.6 : 1);
      this.head.distance = 70 * (this.highBeam ? 1.5 : 1);
      this.head.angle = 0.4 * (this.highBeam ? 1.12 : 1);
    }
  }

  dispose() {
    // 광원은 풀로 반환(씬에 남겨 광원 수 유지 — 제거해도 재컴파일이 일어난다)
    if (this.head) {
      this.head.intensity = 0;
      this.scene.add(this.head, this.head.target);
    }
    this.scene.remove(this.group);
    this.world.removeBody(this.body);
  }
}
