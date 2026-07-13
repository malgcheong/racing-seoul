// cannon-es 기반 평면 강체 물리.
// 모든 차량은 데크 평면에 구속(상하 이동/롤·피치 없음, 요(yaw)만) → 뒤집히거나 떨어지지 않음.
// 차-차 충돌은 엔진이 처리(질량·운동량 → 서로 밀리고 스핀). 조작은 아케이드 힘 모델.

import * as CANNON from 'cannon-es';

export const carMaterial = new CANNON.Material('car');

export function createWorld() {
  const world = new CANNON.World({ gravity: new CANNON.Vec3(0, 0, 0) });
  world.broadphase = new CANNON.SAPBroadphase(world);
  world.solver.iterations = 12;
  world.allowSleep = false;
  // 차끼리: 마찰 낮고 반발 있음(부딪히면 튕김)
  world.addContactMaterial(new CANNON.ContactMaterial(carMaterial, carMaterial, {
    friction: 0.25, restitution: 0.45,
  }));
  return world;
}

// 평면 구속 강체(박스). Y이동 금지, yaw 회전만 허용.
export function makeCarBody(world, { w, h, l, mass, pos }) {
  const body = new CANNON.Body({ mass, material: carMaterial });
  body.addShape(new CANNON.Box(new CANNON.Vec3(w / 2, h / 2, l / 2)));
  body.position.set(pos.x, pos.y, pos.z);
  body.linearFactor.set(1, 0, 1);   // 상하 이동 금지(데크에 붙어있음)
  body.angularFactor.set(0, 1, 0);  // yaw만 회전
  body.linearDamping = 0.08;
  body.angularDamping = 0.55;
  world.addBody(body);
  return body;
}

// 강체를 트랙 폭 안으로 가둔다(가장자리 배리어). 넘으면 되밀고 측면속도 반사(튕김).
// near: 가장 가까운 트랙 샘플 {pos,left}. lateral 범위 [minLat, maxLat](중앙선 기준).
// 졸음쉼터 구간에선 maxLat을 크게 줘서 우측으로 진입 가능.
export function clampToRoad(body, near, minLat, maxLat) {
  const dx = body.position.x - near.pos.x;
  const dz = body.position.z - near.pos.z;
  const lat = dx * near.left.x + dz * near.left.z;
  const target = Math.min(maxLat, Math.max(minLat, lat));
  if (target !== lat) {
    const over = lat - target;
    body.position.x -= near.left.x * over;
    body.position.z -= near.left.z * over;
    const vlat = body.velocity.x * near.left.x + body.velocity.z * near.left.z;
    body.velocity.x -= near.left.x * vlat * 1.4;
    body.velocity.z -= near.left.z * vlat * 1.4;
  }
}
