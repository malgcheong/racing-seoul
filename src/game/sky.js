// 하늘 연출 모음: 돔 셰이더 / 별 필드 / 달 / 노을 태양·구름 / 밤하늘 생명감.
// 전부 skyDome 그룹에 담겨 카메라를 따라간다(무한히 먼 하늘처럼 — 시차 제거).

import * as THREE from 'three';

// 별 필드: 상반구에 랜덤 분포, 밝기·색온도(푸름/노람) 배리에이션
export function makeStars(count = 900) {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const R = 4000; // 산맥 링(루트 스케일)보다 바깥
  const warm = new THREE.Color(0xfff2d0);
  const cool = new THREE.Color(0xcfd8ff);
  for (let i = 0; i < count; i++) {
    const azimuth = Math.random() * Math.PI * 2;
    const y = 0.04 + Math.pow(Math.random(), 0.7) * 0.96; // 위쪽에 살짝 더 밀집
    const r = Math.sqrt(1 - y * y);
    positions[i * 3] = Math.cos(azimuth) * r * R;
    positions[i * 3 + 1] = y * R;
    positions[i * 3 + 2] = Math.sin(azimuth) * r * R;
    const tint = warm.clone().lerp(cool, Math.random());
    const brightness = 0.25 + Math.pow(Math.random(), 2.2) * 0.75; // 대부분 흐리고 일부만 밝게
    colors[i * 3] = tint.r * brightness;
    colors[i * 3 + 1] = tint.g * brightness;
    colors[i * 3 + 2] = tint.b * brightness;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  // 부드러운 원형 점 텍스처
  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 32;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.4, 'rgba(255,255,255,0.5)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 32, 32);

  const mat = new THREE.PointsMaterial({
    size: 2.4,
    sizeAttenuation: false, // 픽셀 고정 크기 (거리 무관)
    map: new THREE.CanvasTexture(canvas),
    vertexColors: true,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false, // 안개 거리(800) 밖이므로 필수
  });
  const stars = new THREE.Points(geo, mat);
  stars.frustumCulled = false;
  return stars;
}

// 달: 크레이터 텍스처 원판 + 은은한 달무리. 방향광과 같은 방향에 배치해
// 그림자가 달에서 오는 것처럼 보이게 한다.
export function makeMoon(dir) {
  const group = new THREE.Group();

  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#f4efdf';
  ctx.beginPath();
  ctx.arc(64, 64, 62, 0, Math.PI * 2);
  ctx.fill();
  // 크레이터 얼룩
  for (const [x, y, r, a] of [
    [45, 42, 14, 0.16], [82, 58, 10, 0.13], [58, 85, 16, 0.14],
    [90, 88, 8, 0.11], [36, 70, 8, 0.1], [70, 30, 7, 0.12],
  ]) {
    ctx.fillStyle = `rgba(150,145,135,${a})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  const moonTex = new THREE.CanvasTexture(canvas);

  const disc = new THREE.Mesh(
    new THREE.PlaneGeometry(150, 150),
    new THREE.MeshBasicMaterial({ map: moonTex, transparent: true, fog: false })
  );
  group.add(disc);

  // 달무리 (halo): 은은한 냉백색, 달을 중심으로
  const haloCanvas = document.createElement('canvas');
  haloCanvas.width = 128;
  haloCanvas.height = 128;
  const hctx = haloCanvas.getContext('2d');
  const hg = hctx.createRadialGradient(64, 64, 24, 64, 64, 64);
  hg.addColorStop(0, 'rgba(220,228,245,0.28)');
  hg.addColorStop(0.45, 'rgba(190,205,240,0.08)');
  hg.addColorStop(1, 'rgba(180,200,240,0)');
  hctx.fillStyle = hg;
  hctx.fillRect(0, 0, 128, 128);
  const halo = new THREE.Mesh(
    new THREE.PlaneGeometry(340, 340),
    new THREE.MeshBasicMaterial({
      map: new THREE.CanvasTexture(haloCanvas),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    })
  );
  halo.position.z = -1;
  group.add(halo);

  group.position.copy(dir).multiplyScalar(3800);
  group.lookAt(0, 0, 0);
  group.scale.setScalar(2.7); // 멀어진 만큼 크기 보정(각크기 유지)
  return group;
}

// 밤하늘 생명감: 천천히 가로지르는 비행기(점멸등) + 가끔 떨어지는 유성.
export function makeSkyLife() {
  const group = new THREE.Group();

  // 비행기: 좌현 빨강 / 우현 초록 / 흰 스트로브 점 3개
  const plane = new THREE.Group();
  const dotG = new THREE.SphereGeometry(1.5, 6, 4);
  const red = new THREE.Mesh(dotG, new THREE.MeshBasicMaterial({ color: 0xff4040, fog: false }));
  red.position.x = -5;
  const green = new THREE.Mesh(dotG, new THREE.MeshBasicMaterial({ color: 0x3aff6a, fog: false }));
  green.position.x = 5;
  const strobe = new THREE.Mesh(new THREE.SphereGeometry(2.0, 6, 4),
    new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false }));
  plane.add(red, green, strobe);
  group.add(plane);
  const A = new THREE.Vector3(-950, 330, -520);
  const B = new THREE.Vector3(950, 380, 430);

  // 유성: 가늘고 긴 additive 스트릭이 잠깐 떨어졌다 사라짐
  const meteorMat = new THREE.MeshBasicMaterial({
    color: 0xcfe4ff, transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
  });
  const meteor = new THREE.Mesh(new THREE.PlaneGeometry(50, 1.2), meteorMat);
  group.add(meteor);
  let meteorNext = 14;
  let meteorT = -1;

  function update(t, dt) {
    // 비행기 왕복 순환 (편도 ~95초)
    const T = 95;
    const k = (t % T) / T;
    plane.position.lerpVectors(A, B, k);
    strobe.visible = (t % 1.3) < 0.09; // 스트로브 번쩍
    // 유성 스폰/애니메이션
    meteorNext -= dt;
    if (meteorNext <= 0 && meteorT < 0) {
      meteorT = 0;
      meteorNext = 18 + Math.random() * 26;
      meteor.position.set((Math.random() - 0.5) * 1300, 430 + Math.random() * 170, -650);
      meteor.lookAt(0, meteor.position.y * 0.4, 0); // 대략 카메라 쪽을 향한 판
      meteor.rotateZ(-0.62);                        // 떨어지는 기울기
    }
    if (meteorT >= 0) {
      meteorT += dt;
      const p = meteorT / 0.9;
      if (p >= 1) { meteorT = -1; meteorMat.opacity = 0; }
      else {
        meteor.position.x += dt * 300;
        meteor.position.y -= dt * 210;
        meteorMat.opacity = (p < 0.25 ? p / 0.25 : 1 - (p - 0.25) / 0.75) * 0.85;
      }
    }
  }
  return { group, update };
}

// 하늘 돔: 상하 그라디언트 + (노을) 태양 방위 지평선 글로우
export function makeSky(palette, radius = 1600, sunDir = null) {
  const geo = new THREE.SphereGeometry(radius, 24, 16);
  const azim = sunDir
    ? new THREE.Vector3(sunDir.x, 0, sunDir.z).normalize()
    : new THREE.Vector3(0, 0, 1);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    uniforms: {
      topColor: { value: new THREE.Color(palette.skyTop) },
      bottomColor: { value: new THREE.Color(palette.skyHorizon) },
      glowColor: { value: new THREE.Color(palette.sunGlow ?? 0x000000) },
      sunAzim: { value: azim },
      // 노을: 태양 방위 지평선이 달궈진다 (밤엔 0 → 기존과 동일)
      glowStrength: { value: palette.tod === 'dusk' ? 1.0 : 0.0 },
    },
    vertexShader: `
      varying vec3 vPos;
      void main() {
        vPos = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 topColor;
      uniform vec3 bottomColor;
      uniform vec3 glowColor;
      uniform vec3 sunAzim;
      uniform float glowStrength;
      varying vec3 vPos;
      void main() {
        vec3 dir = normalize(vPos);
        float h = dir.y * 0.5 + 0.5;
        vec3 col = mix(bottomColor, topColor, pow(h, 0.8));
        if (glowStrength > 0.0) {
          float facing = max(dot(normalize(vec3(dir.x, 0.0, dir.z)), sunAzim), 0.0);
          float low = pow(1.0 - clamp(dir.y, 0.0, 1.0), 3.0);
          col += glowColor * pow(facing, 2.4) * low * glowStrength;
        }
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  return new THREE.Mesh(geo, mat);
}

// 노을 태양: 지평선 근처의 큰 주황 원반 + 넓은 웜 헤일로
export function makeDuskSun(dir) {
  const group = new THREE.Group();
  const mk = (size, draw) => {
    const c = document.createElement('canvas');
    c.width = 128;
    c.height = 128;
    draw(c.getContext('2d'));
    return new THREE.Mesh(
      new THREE.PlaneGeometry(size, size),
      new THREE.MeshBasicMaterial({
        map: new THREE.CanvasTexture(c), transparent: true,
        blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
      }));
  };
  const disc = mk(240, (ctx) => {
    const g = ctx.createRadialGradient(64, 64, 8, 64, 64, 58);
    g.addColorStop(0, 'rgba(255,236,190,1)');
    g.addColorStop(0.55, 'rgba(255,166,80,0.95)');
    g.addColorStop(1, 'rgba(255,120,50,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
  });
  const halo = mk(950, (ctx) => {
    const g = ctx.createRadialGradient(64, 64, 6, 64, 64, 64);
    g.addColorStop(0, 'rgba(255,160,80,0.34)');
    g.addColorStop(0.5, 'rgba(255,130,70,0.1)');
    g.addColorStop(1, 'rgba(255,110,60,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
  });
  halo.position.z = -1;
  group.add(disc, halo);
  group.position.copy(dir).multiplyScalar(3800);
  group.lookAt(0, 0, 0);
  group.scale.setScalar(2.7);
  return group;
}

// 노을 구름: 태양 쪽 하늘에 깔린 길쭉한 구름 띠 — 밑면이 주황으로 달궈짐
export function makeDuskClouds(rng, sunDir) {
  const group = new THREE.Group();
  const tex = (() => {
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 64;
    const ctx = c.getContext('2d');
    for (let i = 0; i < 26; i++) { // 겹친 타원 블롭 → 길쭉한 구름
      const x = 20 + Math.random() * 216;
      const y = 22 + Math.random() * 22;
      const r = 14 + Math.random() * 26;
      const g = ctx.createRadialGradient(x, y, 1, x, y, r);
      const warm = y > 34; // 아랫면일수록 주황
      g.addColorStop(0, warm ? 'rgba(255,150,95,0.34)' : 'rgba(212,180,205,0.30)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(x, y, r * 1.7, r * 0.55, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    return new THREE.CanvasTexture(c);
  })();
  const azim = Math.atan2(sunDir.x, sunDir.z);
  for (let k = 0; k < 9; k++) {
    const a = azim + (rng() - 0.5) * 2.4;         // 태양 방위 주변에 몰림
    const el = 0.06 + rng() * 0.2;                // 낮은 고도각
    const R = 3500;
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(700 + rng() * 700, 90 + rng() * 110),
      new THREE.MeshBasicMaterial({
        map: tex, transparent: true, depthWrite: false, fog: false,
        opacity: 0.5 + rng() * 0.4,
      }));
    m.position.set(Math.sin(a) * R * Math.cos(el), Math.sin(el) * R, Math.cos(a) * R * Math.cos(el));
    m.lookAt(0, m.position.y * 0.5, 0);
    group.add(m);
  }
  return group;
}
