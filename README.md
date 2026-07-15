# NIGHT DRIVE — 서울 한강 야경 레이싱

강 건너 야경을 끼고 한강 다리를 건너 달리는 **Three.js 아케이드 레이싱**.
동쪽 도심에서 출발해 붉은 아치 다리를 건너 여의도(국회의사당·63빌딩) 방면 도심까지,
밤·노을·비 무드가 시드마다 바뀌는 편도 코스를 달린다.

## 실행

```bash
npm install
npm run dev        # http://localhost:5173

# 멀티플레이 중계 서버 (택1)
npm run relay                       # Node 릴레이 (ws://localhost:8787)
cd server-spring && ./gradlew bootRun   # Spring Boot 릴레이 (동일 프로토콜)
```

## 조작

`↑↓←→` / `WASD` 운전 · `Shift` 드리프트 · `F` 상향등(앞차 양보 요구) · `C` 1인칭↔3인칭 전환

## 특징

- **동적 코스**: 시드 난수 Catmull-Rom 트랙, 왕복 8차선 + 중앙분리대, 다리·졸음쉼터·올림픽대로 분기 진출입
- **시간대/날씨**: 밤 / 노을 / 비 (시드 확률, `?tod=dusk|night` · `?wx=rain|clear`로 강제)
- **AI 트래픽**: 한국 지정차로제(1차로 추월 전용·정속 빌런·상향등 양보), pure-pursuit 조향
- **1인칭 콕핏**: 918 실내 셸 + 계기판·사이드미러 실시간 렌더
- **멀티플레이**: 방 코드(=맵 시드) 기반 실시간 레이스, 출발 그리드·순위·재대결. 서버는 중계만(각 클라가 자기 물리 시뮬), 방장이 트래픽 시뮬 → 승계
- **연출**: WebAudio 합성 엔진음·충돌음, 미니맵 + 분기 사전 안내, 사고 슬로모, 발광 노면 화살표

## 기술 스택

- **렌더**: Three.js (r170) — 절차적 셰이더 창문, PCF 그림자, Bloom/비네트 포스트프로세싱
- **물리**: cannon-es — 평면 구속 강체 + 아케이드 힘 모델
- **빌드**: Vite 6
- **멀티 서버**: Node `ws` 릴레이 / Spring Boot 4 릴레이 (동일 JSON 프로토콜, 방장 승계)
- **에셋**: Blender(MCP)로 가공한 GLB — 실차는 Sketchfab CC-BY 모델을 경량화(데시메이트)

## 라이선스

- **소스 코드**: [MIT](LICENSE)
- **3D 에셋** (`public/assets/`): 아래 Sketchfab 모델은 **CC BY 4.0** 이며 재배포 시 저작자 표시를 유지해야 한다 (게임 시작 화면에도 표기 · 전문은 [NOTICE](NOTICE)).

  | 모델 | 제작자 |
  |---|---|
  | Porsche 918 Spyder 2015 | 3D Cars Studio |
  | Car interior (XJ220) | Gerhald |
  | Hyundai Ioniq 5 lowpoly | andikapratamaw |
  | 2017 Hyundai Sonata Hybrid | m3ika3D |
  | 1998 Hyundai Aero Space Coach Bus | ImperialBlue3D |
