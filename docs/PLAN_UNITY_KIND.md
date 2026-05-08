# Unity kind 기획서 — 옵시디언 런타임 초기화 시 Unity 프로젝트 에이전트 카탈로그

> 대상 사례: `C:\UnityProject\AresParSimVR` (Unity 6000.1.2f1 / URP 17.1 / OpenXR+Meta XR SDK 74 / XRI 3.1 / Netcode for GameObjects 2.4 / Addressables 2.4 / 낙하산 강하 시뮬레이터 VR)
>
> 작성: 2026-05-08 / 작성자: 노예1호 (성희님 의뢰)

---

## 1. 배경 — 왜 새 kind 가 필요한가

현 런타임의 `_recommended/<kind>/` 카탈로그는 4개:

| kind | 권장 에이전트 |
|------|---------------|
| web | frontend-reviewer · api-designer · docs-writer · test-writer |
| cli | cli-designer · docs-writer · test-writer |
| data | data-schema-reviewer · migration-writer · query-optimizer |
| library | api-designer · docs-writer · test-writer · semver-auditor |

Unity/게임 프로젝트는 **어느 카테고리에도 맞지 않는다**:

- "frontend"는 React/Vue 컴포넌트 가정 → Unity Scene/Prefab/UGUI/UI Toolkit 부적합
- "api-designer"는 REST/GraphQL 가정 → Unity는 ScriptableObject/이벤트 채널/Addressables 카탈로그
- "data-schema-reviewer"는 RDB/마이그레이션 가정 → Unity는 SerializedField/SO/Save 시스템
- "test-writer"는 Vitest/Jest/pytest 자동 감지 → Unity Test Runner(UTF) 미커버

따라서 **`unity` kind 신설**이 필요하다.

## 2. 핵심 설계 원칙 — "MCP 사각지대만 채운다"

타깃 프로젝트는 이미 `com.coplaydev.unity-mcp` 가 `Packages/manifest.json` 에 들어있다. 즉 **CoplayDev unity-mcp 가 처리하는 영역은 에이전트가 중복 설계하지 않는다.**

웹 리서치 결과(2026-05 기준) MCP 가 잘 처리하는 영역:

- GameObject/Component/Asset/Scene/Prefab CRUD
- Console 로그 read·필터, Play/Pause/Stop
- Editor 메뉴 실행, Recompile, Domain Reload
- Test Runner(UTF) EditMode/PlayMode 실행
- C# 스크립트 텍스트 편집 (`manage_script`)
- Profiler/Frame Debugger raw 데이터 추출 (`manage_profiler`)
- Physics(21 actions), Animation(14 actions), Build, Packages
- Material/Texture/Shader 바인딩 (`manage_shader` 는 list 수준)

MCP 가 못 하거나 약한 영역 = **에이전트가 채워야 할 영역**:

| 영역 | MCP 한계 | 에이전트 필요성 |
|------|----------|------------------|
| C# 코드 의미 리뷰 | 텍스트 편집은 가능, SRP/알로케이션/MonoBehaviour 라이프사이클 오용 판정은 LLM 영역 | ★★★ |
| VR Comfort & XRI 셋업 | Meta MCP 도 grab/teleport hotspot 까지. Tunneling Vignette·locomotion·OpenXR 충돌·snap turn 정책은 미커버 | ★★★ |
| Profiler 결과 해석 | raw counter 추출은 가능, GC spike 원인·draw call 후보·variant 폭증 추론은 LLM 영역 | ★★★ |
| URP/HDRP 파이프라인 리뷰 | post-process/volume 제어 수준. Renderer Feature 순서·SRP Batcher·Forward+ 선택은 미커버 | ★★ |
| 셰이더/ShaderGraph 의미 분석 | 바인딩만, 노드 그래프 의미·variant 비용 추정 미커버 | ★★ |
| Addressables 그룹 전략 | 패키지 설치만 cover. 그룹 분할·원격 카탈로그·PAD(Quest=Android) 미커버 | ★★ |
| Animator/Input System 설계 | CRUD 위주. transition 의미·blend tree·XR Controller binding 충돌 미커버 | ★★ |
| ScriptableObject 데이터 흐름 | 인스턴스 CRUD 가능, 이벤트 채널 패턴·데이터 스키마 일관성은 LLM 영역 | ★★ |
| Git LFS / .meta GUID / 라이트맵 | MCP 영역 밖 (외부 git 도구) | ★★ |
| Quest 컴플라이언스 외 시뮬 룰 | VRC-check 만 부분 cover. AAR 로깅·DIS/HLA·dead reckoning 등 미커버 | ★ |
| 햅틱 곡선 설계 | SendHapticImpulse 호출은 쓰지만 패턴 설계는 미커버 | ★ |
| 다인 동기화 토폴로지 | NGO/Fusion 설정 코드는 가능, interest management·VR lag compensation 미커버 | ★ |

## 3. 신설 kind: `unity` — 권장 에이전트 카탈로그

신설 위치: `templates/agents/_recommended/unity/`

### 3-1. 필수 (모든 Unity 프로젝트 공통, 6개)

| 파일명 | 역할 | MCP 분담 |
|--------|------|----------|
| `csharp-reviewer.md` | C# 코드 의미 단위 리뷰 — SRP/알로케이션/MonoBehaviour 라이프사이클·`Update` GC·LINQ in hot path·async-in-Awake | MCP 가 텍스트 편집, 에이전트가 패턴 판정 |
| `unity-test-writer.md` | Unity Test Framework — EditMode/PlayMode + Setup/TearDown + UnityTest IEnumerator + Performance Testing | MCP 가 실행, 에이전트가 작성 |
| `scene-reviewer.md` | Scene/Prefab 구조 리뷰 — 계층 깊이, 누락된 reference, missing script, `[ExecuteAlways]`, prefab variant 충돌 | MCP 가 계층 추출, 에이전트가 위생 판단 |
| `addressables-strategist.md` | 그룹 분할·라벨·원격/로컬 카탈로그·PAD(Android/Quest) 전략, 메모리 예산 vs 디스크 트레이드오프 | MCP 미커버 영역 |
| `repo-hygienist.md` | `.meta` GUID 충돌·`.gitattributes`/LFS 룰·UnityYAMLMerge 설정·LightingData.asset/베이크 산출물·asmdef 순환 참조 | MCP 미커버 영역 |
| `unity-docs-writer.md` | Worklog/Lesson 작성 시 Unity 컨벤션 — 매니페스트 버전·Editor 버전 명시, MenuItem 경로·Inspector 워크플로 단계화 | 공통 패턴 |

### 3-2. 그래픽스 옵션 (URP/HDRP 또는 ShaderGraph 사용 시, 2개)

| 파일명 | 역할 |
|--------|------|
| `urp-pipeline-reviewer.md` | Renderer Feature 순서·SRP Batcher 호환성·Forward+ vs Deferred·post-process volume 우선순위·Quest용 Single Pass Instanced 강제 검증 |
| `shader-reviewer.md` | ShaderGraph 노드 의미 분석·셰이더 variant 폭증 진단·mobile/Quest GPU 명령 비용 추정·`#pragma multi_compile` 가지치기 |

### 3-3. XR/VR 옵션 (XRI/OpenXR/Meta XR SDK 사용 시, 3개)

| 파일명 | 역할 |
|--------|------|
| `xr-comfort-reviewer.md` | Tunneling Vignette·locomotion provider 종류별 motion sickness·FOV vignette 강도·snap turn vs continuous turn 정책·teleport vs continuous move 매핑·IPD/height 보정. **IEEE VR comfort guideline** 룰북 내장 |
| `xr-setup-reviewer.md` | OpenXR Plugin 셋업·Meta XR SDK 충돌(OVR vs OpenXR)·XR Origin 구조·Hand tracking + Controller fallback·`Project Validation` 룰 매핑·Quest용 Player Settings(IL2CPP/ARM64/Android Texture Compression Targeting/Vulkan) |
| `xr-input-rig-reviewer.md` | InputActionAsset binding 충돌·XR Controller 매핑·hand interactor 우선순위·Animation Rigging 과 XR Origin 결합 검증 |

### 3-4. 도메인 옵션 (시뮬레이션/멀티플레이어 시, 2개)

| 파일명 | 역할 |
|--------|------|
| `netcode-reviewer.md` | NGO 또는 Photon Fusion 토폴로지·NetworkObject ownership·RPC vs NetworkVariable 선택·VR lag compensation·interest management·Movement Networking(Meta Movement) |
| `sim-domain-reviewer.md` | 도메인별 시뮬레이션 워크플로 — AAR 로깅 스키마·결정성(determinism)·시뮬레이션 시계·재현 가능 시드·텔레메트리. AresParSimVR 사례에서는 낙하산 비행역학·강하 단계별 이벤트·SDK 통합 룰 |

### 3-5. 성능 옵션 (Profiler 자주 보면, 1개)

| 파일명 | 역할 |
|--------|------|
| `profiler-analyst.md` | MCP 가 추출한 raw counter/Frame Debugger events 를 받아 **GC spike 원인·draw call 후보·셰이더 variant 폭증·메모리 누수 패턴·VR 90Hz/120Hz 프레임 예산** 해석. Memory Profiler 한계(IL2CPP managed VM 누락) 명시 |

### 3-6. 카탈로그 합계

- **필수 6개** + 그래픽스 2 + XR 3 + 도메인 2 + 성능 1 = **최대 14개**
- AresParSimVR 같은 풀스택 VR 시뮬레이터 = 14개 전부 권장
- 단순 모바일 게임 = 필수 6 + 그래픽스 1 = 7개 정도가 현실적

## 4. kind 의 하위 변형 — `unity` 단일 vs 분할?

두 가지 안:

### 안 A: `unity` 단일 kind (P1 권장)

- `--kind unity` 한 번이면 **필수 6개 + 옵션 8개 합집합** 14개 전부 dry-run 표시
- 사용자가 dry-run 화면에서 **체크박스로 골라 install**
- 장점: kind 폭발 방지, manifest 단순
- 단점: dry-run UI 가 길어짐 (현 `agents-bootstrap.md` 의 yes/no 흐름을 "체크박스 선택" 으로 살짝 확장 필요)

### 안 B: 분할 — `unity-core` / `unity-xr` / `unity-graphics` / `unity-netcode`

- `projectKinds: ["unity-core", "unity-xr", "unity-netcode"]` 처럼 hybrid 로 조합
- 장점: 기존 hybrid 메커니즘 그대로 재사용, 합집합 자동
- 단점: kind 4개 신설 → manifest 복잡, 사용자 혼란

**추천: 안 A** — `unity` 단일 kind + dry-run 단계에서 **카테고리 prompt** ("그래픽스 / XR / 도메인 / 성능 카테고리를 추가하시겠어요?"). hybrid 메커니즘은 향후 `unity` + `cli` 같은 진짜 다른 kind 조합에 남겨둠.

## 5. agents-bootstrap 흐름 변경 (최소 침습)

현 `templates/commands/agents-bootstrap.md` 4단계(dry-run → yes/no → install) 는 **거의 그대로 유지**. 단:

- `unity` kind 의 경우 **dry-run 출력에 카테고리 그룹 헤더** 표시:

  ```
  다음 에이전트를 설치합니다 (unity kind):

  [필수 / always]
    [install] .claude/agents/{{PROJECT_ID}}-csharp-reviewer.md
    [install] .claude/agents/{{PROJECT_ID}}-unity-test-writer.md
    [install] .claude/agents/{{PROJECT_ID}}-scene-reviewer.md
    [install] .claude/agents/{{PROJECT_ID}}-addressables-strategist.md
    [install] .claude/agents/{{PROJECT_ID}}-repo-hygienist.md
    [install] .claude/agents/{{PROJECT_ID}}-unity-docs-writer.md

  [그래픽스 / 자동 감지: URP 17.1 detected]
    [install] .claude/agents/{{PROJECT_ID}}-urp-pipeline-reviewer.md
    [install] .claude/agents/{{PROJECT_ID}}-shader-reviewer.md

  [XR / 자동 감지: OpenXR 1.14 + XRI 3.1 + Meta XR SDK 74 detected]
    [install] .claude/agents/{{PROJECT_ID}}-xr-comfort-reviewer.md
    [install] .claude/agents/{{PROJECT_ID}}-xr-setup-reviewer.md
    [install] .claude/agents/{{PROJECT_ID}}-xr-input-rig-reviewer.md

  [도메인 / 자동 감지: Netcode for GameObjects 2.4 detected]
    [install] .claude/agents/{{PROJECT_ID}}-netcode-reviewer.md
    [install] .claude/agents/{{PROJECT_ID}}-sim-domain-reviewer.md

  [성능 / 선택 — 추가하시려면 yes]
    [skip]    .claude/agents/{{PROJECT_ID}}-profiler-analyst.md

  계속 진행할까요? (yes / 카테고리만 선택 / no)
  ```

- **자동 감지 로직**: `Packages/manifest.json` 을 Read 해서 다음 패키지 키 존재로 카테고리 점등
  - `com.unity.render-pipelines.universal` 또는 `.high-definition` → 그래픽스 ON
  - `com.unity.shadergraph` → 그래픽스 ON
  - `com.unity.xr.openxr` 또는 `com.unity.xr.interaction.toolkit` 또는 `com.meta.xr.sdk.all` → XR ON
  - `com.unity.netcode.gameobjects` 또는 `com.photonengine.fusion` → 도메인 (netcode) ON
- 자동 감지가 빗나가도 사용자는 dry-run 단계에서 yes 거부 후 다시 호출 가능 (재실행 안전).

## 6. lead 의 Project Manager 발문 갱신

`templates/agents/_lead.md` § "Project Manager — 부트스트랩 질문·제시" 의 질문 텍스트를 다음으로 확장:

> "이 프로젝트 유형을 알려주세요. 복수 선택 가능합니다. 목록: web / cli / data / library / **unity** / unknown."

그리고 권장 에이전트 제시 표에 한 줄 추가:

> `unity` → csharp-reviewer, unity-test-writer, scene-reviewer, addressables-strategist, repo-hygienist, unity-docs-writer (+ URP/XR/Netcode 감지 시 카테고리별 추가)

## 7. capability routing 영향

`_lead.md` § "Capability Routing — 구조화 점수 매칭" 은 frontmatter `triggers` 배열을 부분문자열 매칭한다. Unity 에이전트들의 `triggers` 예시:

| 에이전트 | triggers 후보 |
|----------|---------------|
| csharp-reviewer | csharp, c#, monobehaviour, scriptableobject, update, awake, gc, allocation, async, coroutine, linq |
| unity-test-writer | unity test, edit mode, play mode, utf, unitytest, nunit, performance testing |
| scene-reviewer | scene, prefab, hierarchy, missing reference, missing script, prefab variant, executealways |
| addressables-strategist | addressables, addressable, asset bundle, catalog, group, label, pad, play asset delivery |
| repo-hygienist | meta file, lfs, gitattributes, gitlfs, lighting data, asmdef, guid conflict |
| urp-pipeline-reviewer | urp, hdrp, render pipeline, srp batcher, renderer feature, post process, volume, forward+ |
| shader-reviewer | shader, shadergraph, shader graph, hlsl, multi_compile, variant, pragma |
| xr-comfort-reviewer | comfort, motion sickness, vignette, tunneling, locomotion, snap turn, teleport, fov |
| xr-setup-reviewer | openxr, oculus, meta xr, xr origin, project validation, il2cpp, quest, vulkan, single pass |
| xr-input-rig-reviewer | xr controller, xr input, input action, action map, binding, hand tracking, animation rigging |
| netcode-reviewer | netcode, ngo, fusion, network object, networkvariable, rpc, ownership, interest management |
| sim-domain-reviewer | simulation, aar, after action, determinism, dead reckoning, telemetry, scenario |
| profiler-analyst | profiler, frame debugger, gc spike, draw call, allocation, memory profiler, 90hz, 120hz |

`agentFanoutCap = 2` 기본값이지만 Unity 프로젝트는 실무상 한 task 에 csharp + xr-comfort + profiler 3개를 동시에 부르고 싶은 경우가 많아서 **Unity kind 자동 install 시 manifest 의 `agentFanoutCap` 을 3 으로 권장 갱신**하는 것을 dry-run 마지막 단계에 안내한다 (자동 변경 X, 안내만).

## 8. 프로젝트별 특화 메모 — AresParSimVR

타깃 프로젝트의 매니페스트와 csproj 목록에서 확인된 특이사항:

- **Meta Movement / Movement Networking (Fusion + NGO 둘 다)** → multiplayer 토폴로지 둘 중 어느 쪽인지 task 시작 전 manifest 에 기록 필요. `netcode-reviewer` 가 첫 task 에서 자동 점검.
- **MR Utility Kit + Depth API** → 패스스루 + Scene Understanding. `xr-setup-reviewer` 의 룰북에 MRUK 룰 포함.
- **Voice SDK / Wit AI / Dictation** → 음성 명령 통합. 별도 에이전트는 비추 (사용 빈도 낮음). `csharp-reviewer` 의 trigger 에 `wit`, `voice command` 추가하는 정도.
- **Sirenix Odin** → Inspector 프로퍼티 어트리뷰트가 광범위. `csharp-reviewer` 가 Odin 어트리뷰트 (`[ShowInInspector]`, `[Button]`, `[FoldoutGroup]`) 를 인식해 false positive 줄여야 함.
- **WebRTC 3.0-pre.8** → 화상/음성 전송. `netcode-reviewer` 가 전용 룰 보유.
- **낙하산 SDK API PDF (Ver0205~0207)** → `sim-domain-reviewer` 의 Context loading 에서 `document/` 또는 루트 PDF 경로를 readFirst 후보로 제안.

## 9. 구현 순서 (P1 → P2 → P3)

### P1 — 카탈로그만 (이번 작업 범위)

1. `templates/agents/_recommended/unity/` 디렉토리 신설.
2. 필수 6개 + 옵션 8개 = 14개 `*.md` 작성. 각 파일은 기존 `_recommended/web/frontend-reviewer.md` 와 동일한 frontmatter 스키마 (name/description/capabilities/domain/triggers/model/tools).
3. `templates/commands/agents-bootstrap.md` 변경 부분 추가:
   - `--kind library` 또는 `--kind data` (P1 범위 밖) 안내문 옆에 `--kind unity` 케이스 분기.
   - dry-run 출력의 카테고리 그룹 헤더 + 자동 감지 로직 (manifest.json read).
4. `templates/agents/_lead.md` § "Project Manager" 의 목록과 제안 표에 unity 추가.
5. `docs/INSTALL.md` / `docs/QUICKSTART.md` 에 unity 섹션 1단락 추가.

### P2 — 자동 감지 & MCP 연계

1. 매니페스트 자동 감지 로직을 `agents-bootstrap.md` 에서 빼서 `commands/agents-bootstrap-detect-unity.mjs` 헬퍼로 옮길지 검토 (현 원칙: command 는 core 호출 금지 → 그대로 두고 Claude 가 Read/Glob 으로 판정).
2. `xr-comfort-reviewer` 의 IEEE VR comfort guideline 룰북 정리 (`templates/vault/04_Architecture/_xr_comfort_rulebook.md` 시드).
3. `profiler-analyst` 가 MCP `manage_profiler` 출력 포맷을 입력으로 받는 인터페이스 명세.

### P3 — 평가 & 일반화

1. AresParSimVR 1주일 운용 후 회고 → 카탈로그 14개 중 실 사용 빈도 측정.
2. 빈도 하위 30% 에이전트는 `_recommended/unity/_optional/` 로 이동 (기본 install 제외).
3. 다른 Unity 프로젝트(모바일 게임, 비-VR) 적용 → 일반화 검증.

## 10. 실패 모드 & 완화

| 실패 모드 | 완화 |
|-----------|------|
| 사용자가 14개를 한꺼번에 install 후 routing 시 fanout 초과 | dry-run 마지막에 `agentFanoutCap` 안내, lead 가 `[NOTIFY]` 로 알려줌 |
| 카탈로그가 너무 두꺼워 사용자가 중요 에이전트 식별 실패 | 필수/옵션 카테고리 그룹 헤더로 시각적 구분, 자동 감지로 옵션 자동 점등 |
| MCP 가 발전해서 카탈로그 영역을 잠식 | 분기별 (P3 평가 시) MCP 메이저 릴리스 changelog 확인, 사각지대 표(§2) 갱신 |
| Unity 6 vs Unity 2022 LTS 차이로 룰 충돌 | 각 에이전트 frontmatter 의 description 에 "Unity 6+ assumes Unity 6 API surface" 명시, 구버전 사용자에게 caveat 안내 |
| AresParSimVR 의 낙하산 SDK 가 비공개 → 에이전트가 PDF 본문 못 읽음 | `sim-domain-reviewer` 는 PDF 경로만 readFirst 안내. 본문은 사용자가 수동 발췌해 vault 에 넣도록 안내 |

## 11. 산출물 체크리스트

- [ ] `templates/agents/_recommended/unity/csharp-reviewer.md`
- [ ] `templates/agents/_recommended/unity/unity-test-writer.md`
- [ ] `templates/agents/_recommended/unity/scene-reviewer.md`
- [ ] `templates/agents/_recommended/unity/addressables-strategist.md`
- [ ] `templates/agents/_recommended/unity/repo-hygienist.md`
- [ ] `templates/agents/_recommended/unity/unity-docs-writer.md`
- [ ] `templates/agents/_recommended/unity/urp-pipeline-reviewer.md`
- [ ] `templates/agents/_recommended/unity/shader-reviewer.md`
- [ ] `templates/agents/_recommended/unity/xr-comfort-reviewer.md`
- [ ] `templates/agents/_recommended/unity/xr-setup-reviewer.md`
- [ ] `templates/agents/_recommended/unity/xr-input-rig-reviewer.md`
- [ ] `templates/agents/_recommended/unity/netcode-reviewer.md`
- [ ] `templates/agents/_recommended/unity/sim-domain-reviewer.md`
- [ ] `templates/agents/_recommended/unity/profiler-analyst.md`
- [ ] `templates/commands/agents-bootstrap.md` — unity 분기 추가
- [ ] `templates/agents/_lead.md` — Project Manager 목록 업데이트
- [ ] `docs/INSTALL.md`, `docs/QUICKSTART.md` — unity 단락 추가

---

## 부록 A — 참고 자료

- [CoplayDev/unity-mcp](https://github.com/CoplayDev/unity-mcp) (이미 타깃 프로젝트에 설치됨)
- [IvanMurzak/Unity-MCP](https://github.com/IvanMurzak/Unity-MCP) (Roslyn 기반 비교군)
- [CoderGamester/mcp-unity](https://github.com/CoderGamester/mcp-unity) (Test Runner 비교군)
- [Meta XR Unity MCP Extension](https://developers.meta.com/horizon/documentation/unity/unity-mcp-extension/)
- [XRI Tunneling Vignette Controller](https://docs.unity3d.com/Packages/com.unity.xr.interaction.toolkit@3.1/manual/tunneling-vignette-controller.html)
- [Unity Memory Profiler limitations](https://docs.unity3d.com/Manual/ProfilerMemory.html)
- [Build Addressables for Android (Quest=Android)](https://docs.unity3d.com/Packages/com.unity.addressables.android@1.0/manual/build-for-pad.html)
- [Unity & Git best practices (.meta/LFS/lightmap)](https://thoughtbot.com/blog/how-to-git-with-unity)

## 부록 B — 사례 매니페스트 발췌 (AresParSimVR)

```json
{
  "com.coplaydev.unity-mcp": "github main",
  "com.meta.xr.sdk.all": "74.0.3",
  "com.unity.render-pipelines.universal": "17.1.0",
  "com.unity.shadergraph": "17.1.0",
  "com.unity.xr.interaction.toolkit": "3.1.1",
  "com.unity.xr.openxr": "1.14.3",
  "com.unity.xr.hands": "1.5.0",
  "com.unity.netcode.gameobjects": "2.4.3",
  "com.unity.addressables": "2.4.6",
  "com.unity.inputsystem": "1.14.0",
  "com.unity.webrtc": "3.0.0-pre.8",
  "com.unity.timeline": "1.8.7",
  "Editor": "6000.1.2f1"
}
```

자동 감지 결과: 그래픽스 ON · XR ON · 도메인(netcode) ON. 권장 install = 필수 6 + 그래픽스 2 + XR 3 + 도메인 2 = **13개**. 성능(profiler-analyst) 은 사용자 추가 yes 시 14개.
