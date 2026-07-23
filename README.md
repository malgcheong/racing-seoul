# NIGHT DRIVE — 서울 한강 야경 레이싱

강 건너 야경을 끼고 한강 다리를 건너 달리는 **Three.js 아케이드 레이싱**.
동쪽 도심에서 출발해 붉은 아치 다리를 건너 여의도(국회의사당·63빌딩) 방면 도심까지,
밤·노을·비 무드가 시드마다 바뀌는 편도 코스를 달린다.

## 실행

```bash
npm install
npm run dev        # http://localhost:5173
```

## 조작

- **키보드**: `↑↓←→` / `WASD` 운전 · `Shift` 드리프트 · `F` 상향등(앞차 양보 요구) · `C` 1인칭↔3인칭 전환
- **게임패드** (표준 매핑): 좌스틱/십자 조향 · `RT` 가속 · `LT` 브레이크 · `A` 드리프트 · `X` 상향등 · `Y` 시점 전환 — 트리거·스틱은 아날로그
- **터치**: 터치 기기에서 온스크린 버튼 자동 표시 (조향 ◀▶ · 가속/브레이크 · 드리프트 · 상향등 · 시점)

## 특징

- **동적 코스**: 시드 난수 Catmull-Rom 트랙, 왕복 8차선 + 중앙분리대, 한강 다리·올림픽대로 분기
- **맵 선택**: 한밤의 한강 / 노을의 한강 — 시작 시 하늘을 고른다 (`?tod=dusk|night`로 강제)
- **AI 트래픽**: 한국 지정차로제(1차로 추월 전용·정속 빌런·상향등 양보), pure-pursuit 조향
- **봇 대결**: AI 레이서 최대 3대와 출발 그리드에서 경쟁 — 봇도 플레이어와 같은 규칙(트래픽 충돌 = 리타이어)로 달리고, HUD 실시간 순위 + 결과 순위표(라이브 갱신)
- **1인칭 콕핏**: 918 실내 셸 + 계기판·사이드미러 실시간 렌더
- **만화 렌더(NPR)**: 시작 화면 토글 — 셀셰이딩(MeshToon) + 화면공간 잉크 윤곽선 (`?npr=1|0`으로 강제 가능)
- **연출**: WebAudio 합성 엔진음·충돌음, 미니맵 + 분기 사전 안내, 사고 슬로모, 발광 노면 화살표

## 코드 구조

```
src/
  main.js             화면 흐름(시작→차량→맵→주행→결과) + HUD/결과 UI 바인딩
  game/
    game.js           오케스트레이션: 씬 조립, 레이스 상태(완주/사고/순위), 메인 루프
    view.js           렌더러·포스트프로세싱(블룸/비네트)·NPR 파이프라인·자동 품질 강등
    sceneEnv.js       조명·하늘(밤/노을)·환경맵 + 태양(그림자)/하늘돔 추적
    cameraRig.js      시점(추격/1인칭/조감) + 속도 FOV + 사고 셰이크
    input.js          키보드/게임패드/터치 → 아날로그 컨트롤 합성
    branchDrive.js    플레이어 도로 구속 + 분기(램프) 진출/복귀/종점 상태기계
    car.js            플레이어 차량 물리(아케이드 힘 모델, 아날로그 입력)
    bots.js           AI 레이서 — 순항/커브 감속/추월/정체 탈출, 트래픽 충돌=리타이어
    traffic.js        AI 트래픽 — 지정차로제, 차간 유지, 상향등 양보, 봇 인지
    cockpit.js        1인칭 콕핏 — 계기판, 거울(룸/좌/우 개별 RT)
    minimap.js · particles.js · physics.js · sky.js · sounds.js · npr.js · carPreview.js
  map/
    buildWorld.js     월드 조립(도로·분기·화살표·장식) — 주행 파라미터 반환
    trackGenerator.js 시드 트랙(곡률 완만 보장 멀티그리드 스무딩) · branchRoad.js 분기
    decorations.js    도시/도로변 배치 오케스트레이터 (GLB meshopt 압축 금지 주의)
    env/              common(헬퍼·텍스처) · buildings(파사드·인스턴싱) · river(강·교량) · terrain(산)
    palette.js · roadArrows.js
  utils/
    assets.js         GLB 로더(meshopt 디코더, 이름 접두 탐색) · rng.js 시드 난수 · trackMath.js 최근접 탐색
```

## 기술 스택

- **렌더**: Three.js (r170) — 절차적 셰이더 창문, PCF 그림자, Bloom/비네트 포스트프로세싱
- **물리**: cannon-es — 평면 구속 강체 + 아케이드 힘 모델
- **빌드**: Vite 6
- **에셋**: Blender(MCP)로 가공한 GLB — 실차는 Sketchfab CC-BY 모델을 경량화(데시메이트)

## 라이선스

- **소스 코드**: [MIT](LICENSE)
- **3D 에셋** (`public/assets/`): 아래 Sketchfab 모델은 **CC BY 4.0** 이며 재배포 시 저작자 표시를 유지해야 한다 (게임 시작 화면에도 표기 · 전문은 [NOTICE](NOTICE)).

  | 모델 | 제작자 |
  |---|---|
  | Porsche 918 Spyder 2015 | 3D Cars Studio |
  | Mercedes-Benz S63 Coupe Brabus 800 | Black Snow |
  | Mercedes-Benz SL63 AMG | Black Snow |
  | BMW M4 CSL 2023 | Black Snow |
  | Car interior (XJ220) | Gerhald |
  | Hyundai Ioniq 5 lowpoly | andikapratamaw |
  | 2017 Hyundai Sonata Hybrid | m3ika3D |
  | 1998 Hyundai Aero Space Coach Bus | ImperialBlue3D |
  | Mercedes Benz G-Class W263 | Lexyc16 |
  | Chevrolet Damas | own.guest |
  | Hyundai Porter II (Bongo III) | yunho98 |
  | Hyundai Xcient | nguyenhoanglam20100609 |
