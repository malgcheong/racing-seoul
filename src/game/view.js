// 렌더 파이프라인(View) — WebGLRenderer + 포스트프로세싱(블룸·비네트) + NPR 경로.
// 게임 로직은 프레임마다 tickShadow() → renderFrame()만 호출한다.
// NPR 모드: 씬을 전용 RT(색+뎁스)에 그리고 컴포저(잉크 엣지→블룸→비네트)는 읽기만 —
// 컴포저 핑퐁 버퍼에 뎁스를 부착하면 뒤 패스가 그 버퍼에 그릴 때
// "샘플 중 텍스처=렌더 대상" 피드백 루프로 화면이 깜빡인다(GL_INVALID_OPERATION).

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { InkEdgeShader } from './npr.js';

// 화면 가장자리를 살짝 어둡게 (비네트)
const VignetteShader = {
  uniforms: {
    tDiffuse: { value: null },
    strength: { value: 0.4 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float strength;
    varying vec2 vUv;
    void main() {
      vec4 color = texture2D(tDiffuse, vUv);
      float d = distance(vUv, vec2(0.5));
      color.rgb *= 1.0 - smoothstep(0.3, 0.8, d) * strength;
      gl_FragColor = color;
    }
  `,
};

export class View {
  // opts: { palette, quality({dpr, shadow, shadowEvery}), npr, dprOverride }
  constructor(container, scene, camera, opts) {
    this.container = container;
    this.scene = scene;
    this.camera = camera;
    this.npr = !!opts.npr;
    const quality = opts.quality;
    const dusk = opts.palette.tod === 'dusk';

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    // 성능: 고DPI에서 픽셀 수가 제곱으로 늘어 비용이 커짐. 품질 프리셋 dpr로 캡
    // (?dpr= 파라미터가 있으면 개발용으로 우선)
    this.renderer.setPixelRatio(Math.min(
      window.devicePixelRatio,
      Number.isFinite(opts.dprOverride) ? opts.dprOverride : quality.dpr));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap; // Soft 대비 저렴(야간이라 차이 미미)
    // 그림자 깊이 패스는 씬 전체를 한 번 더 그린다 — 격프레임 갱신으로 절반 절약.
    // (태양이 차를 따라가며 미세 이동하는 정도라 한 프레임 지연은 티가 안 남)
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.needsUpdate = true;
    this._shadowEvery = quality.shadowEvery; // N프레임마다 그림자 깊이 패스 갱신
    this._shadowTick = 0;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.95;
    container.appendChild(this.renderer.domElement);

    // 포스트프로세싱: (NPR이면 잉크 엣지 →) bloom → 비네트 → 출력
    this.composer = new EffectComposer(this.renderer);
    if (this.npr) {
      const ds = this.renderer.getDrawingBufferSize(new THREE.Vector2());
      this.nprRT = new THREE.WebGLRenderTarget(ds.x, ds.y, {
        depthTexture: new THREE.DepthTexture(ds.x, ds.y),
      });
      this.edgePass = new ShaderPass(InkEdgeShader);
      this.edgePass.uniforms.tScene.value = this.nprRT.texture;
      this.edgePass.uniforms.tDepth.value = this.nprRT.depthTexture;
      this.edgePass.uniforms.resolution.value.copy(ds);
      this.edgePass.uniforms.cameraNear.value = camera.near;
      this.edgePass.uniforms.cameraFar.value = camera.far;
      this.composer.addPass(this.edgePass); // 씬 렌더는 renderFrame()에서 수동
    } else {
      this.composer.addPass(new RenderPass(scene, camera));
    }
    this.bloomPass = new UnrealBloomPass(
      // 절반 해상도 — 블룸은 블러라 반해상도로도 차이가 안 보이고 비용은 크게 줆
      new THREE.Vector2(container.clientWidth / 2, container.clientHeight / 2),
      // 야간: 광원만 은은하게 / 노을: 노면이 밝아 빛 웅덩이가 과하게 타므로 임계값 상향
      dusk ? 0.3 : 0.38, 0.45, dusk ? 0.88 : 0.72
    );
    this.composer.addPass(this.bloomPass);
    this.vignettePass = new ShaderPass(VignetteShader);
    this.vignettePass.uniforms.strength.value = 0.4; // 야간 무드용 고정 비네트
    this.composer.addPass(this.vignettePass);
    this.composer.addPass(new OutputPass());
  }

  // NPR: 씬을 전용 RT(색+뎁스)에 먼저 그리고 컴포저(엣지→블룸→비네트)는 읽기만
  renderFrame() {
    if (this.npr) {
      this.renderer.setRenderTarget(this.nprRT);
      this.renderer.render(this.scene, this.camera);
      this.renderer.setRenderTarget(null);
    }
    this.composer.render();
  }

  // 그림자 격프레임 갱신 (shadowMap.autoUpdate=false 페어) — 매 프레임 호출
  tickShadow() {
    this._shadowTick = (this._shadowTick + 1) % this._shadowEvery;
    if (this._shadowTick === 0) this.renderer.shadowMap.needsUpdate = true;
  }

  onResize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this._resizeNprRT();
  }

  // 자동 품질 강등(첫 몇 초 FPS 측정 결과 반영): dpr 캡 + 그림자 갱신 주기
  applyQuality({ dpr, shadowEvery }) {
    if (shadowEvery) this._shadowEvery = shadowEvery;
    if (dpr) {
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, dpr));
      this.composer.setSize(this.container.clientWidth, this.container.clientHeight);
      this._resizeNprRT();
    }
  }

  // NPR RT는 뎁스텍스처 크기를 함께 바꿔야 해서 리사이즈 시 재생성이 안전
  _resizeNprRT() {
    if (!this.nprRT) return;
    const ds = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.nprRT.dispose();
    this.nprRT = new THREE.WebGLRenderTarget(ds.x, ds.y, {
      depthTexture: new THREE.DepthTexture(ds.x, ds.y),
    });
    this.edgePass.uniforms.tScene.value = this.nprRT.texture;
    this.edgePass.uniforms.tDepth.value = this.nprRT.depthTexture;
    this.edgePass.uniforms.resolution.value.copy(ds);
  }

  dispose() {
    this.nprRT?.dispose();
    this.composer?.dispose();
    this.renderer?.dispose();
    this.renderer?.domElement?.remove();
  }
}
