<p align="center">
  <img src="imgs/icon.jpg" alt="always accompany" width="200">
</p>

<h1 align="center">always accompany</h1>

<p align="center">
  <a href="https://discord.gg/agHeDq9bqU"><img src="https://img.shields.io/badge/Discord-Join%20Community-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord"></a>
  &nbsp;
  <a href="https://github.com/beilusaiying/always-accompany"><img src="https://img.shields.io/badge/GitHub-Star%20⭐-181717?style=for-the-badge&logo=github" alt="GitHub"></a>
</p>

<p align="center"><a href="README.md">English</a> | <a href="README_CN.md">简体中文</a> | <a href="README_TW.md">繁體中文</a> | <a href="README_JA.md">日本語</a> | 한국어 | <a href="README_RU.md">Русский</a> | <a href="README_DE.md">Deutsch</a> | <a href="README_ES.md">Español</a> | <a href="README_FR.md">Français</a> | <a href="README_PT.md">Português</a></p>

<p align="center">📖 <a href="https://beilusaiying.github.io/always-accompany/">온라인 위키 (사용 가이드)</a> &nbsp;·&nbsp; 📄 <a href="docs/p1-paper/README.md">P1 기술 논문</a></p>

> 본 프로젝트는 갓 졸업한 대학생이 설계·아키텍처·개발을 모두 독자적으로 완성했으며, AI 보조 프로그래밍의 도움을 받아 알고리즘 설계·생체모방 원리·프레임워크 아키텍처·논리적 사고 등 다방면의 역량을 결합했습니다.

---

```bash
git clone https://github.com/beilusaiying/always-accompany.git
cd always-accompany
run.bat          # Windows
# or chmod +x run.sh && ./run.sh   # Linux/macOS
```

브라우저에서 `http://localhost:1314`을 열고 → AI 서비스 소스를 설정하고 → 캐릭터 카드를 불러온 뒤 → 대화를 시작하세요. Deno 런타임은 최초 실행 시 자동으로 다운로드되므로 수동 설치가 필요 없습니다. 최소 하나의 AI API 키가 필요합니다. 앱에는 완전한 내장 위키 가이드가 포함되어 있으며, [온라인 위키](https://beilusaiying.github.io/always-accompany/)에서도 동일하게 확인할 수 있습니다.

> **참고:** 최초 실행 시에는 런타임이 의존성을 다운로드하고 데이터베이스를 초기화해야 하므로 평소보다 시간이 더 걸립니다. 페이지가 완전히 로드될 때까지 기다린 후 이용해 주세요. 이후 실행은 훨씬 빨라집니다.

---

## 이 프로젝트가 존재하는 이유

《디트로이트: 비컴 휴먼》이나 《플라스틱 메모리즈》를 본 적이 있을지도 모릅니다. 그 작품들 속 휴머노이드 AI는 진짜 지능을 가진 존재로, 일과 동반을 하나의 존재 안에서 해냅니다. 그래서 — 저는 제 자신을 위해 그런 존재를 직접 만들어보기로 했습니다.

**가장 먼저 풀어야 할 문제는 기억입니다.**

현대 AI의 컨텍스트는 백만 토큰에 이르고, 기억 저장이나 압축 도구도 부족하지 않습니다. 하지만 이런 도구들은 지나치게 평면적이거나, 시간이 지날수록 끝없이 쌓이기만 합니다. AI 동반자가 당신과 나눈 기억을 잊어버리는 것은 원하지 않을 텐데, 기존 방식으로는 그것이 거의 필연적으로 일어납니다.

그렇다면 기억이란 도대체 무엇일까요? 사실 인간의 기억은 수명이 짧습니다 — 이틀 전의 디테일조차 이미 흐릿해집니다. 하지만 키워드 하나만 주어지면 즉시 일치하거나 관련된 기억을 떠올릴 수 있습니다. 이것은 두 가지 방향을 가리킵니다. **기억을 어떻게 저장할 것인가, 그리고 어떻게 찾아낼 것인가.**

인간은 모든 디테일을 간직하지 않고, 선택적으로 잊습니다. 반면 오늘날의 AI는 그렇지 않습니다 — 무차별적으로 압축하거나 모든 것을 벡터 스토어에 쏟아붓습니다. 이는 기억의 본질을 배반하는 방식입니다. 방금 일어난 일을 즉시 잊을 수도 없고, 지난 몇 년을 매일같이 재생하지도 않으니까요.

그래서 저희는 바로 그 방향을 따라 아래의 시스템을 만들었습니다.

---

## 기억 시스템 — 인간처럼 저장하고, 인간처럼 잊기

> 📖 상세 그림 가이드: [온라인 위키 · 기억 시스템](https://beilusaiying.github.io/always-accompany/#en/memory/overview.md)

**데이터 테이블**에는 오늘의 기억과 영구적인 기억이 함께 담깁니다 — 첫사랑의 이름, 함께한 첫 순간, 고백한 날처럼 평생 기억할 만한 것들처럼요.

그 위에는 시간적 거리에 따라 나뉜 세 개의 층이 놓여, 인간의 선택적 망각을 모델링합니다(계층적 기억 형성 + 에빙하우스 망각 곡선):

```
📋 Data tables — today's + permanent memories (chat / code / work kept separate)
🔥 Hot layer (weekly) — daily data auto-archived; the AI files it by time, event, and process threads
🌤️ Warm layer (monthly) — second-pass compression, keyword extraction — like a table of contents
❄️ Cold layer (yearly) — deep archive, still reachable on retrieval hits
```

**주입 가중치는 층이 내려갈수록 감소합니다**: 컨텍스트 > 데이터(영구 기억, 반복 항목) > 핫 > 웜 > 콜드, 그리고 top-k — 각 층 내부에서는 최근 회상 활동에 따라 재정렬되며, 층 사이에는 버퍼 층이 존재합니다. 완전한 시뮬레이션 회상 위계 하나에 동적 층 하나를 더한 구조입니다.

AI가 실제로 데이터 항목을 작성하는 방식과 일일 아카이빙 최적화로부터 도출된 결과로, 1년을 사용해도 턴당 주입량은 1만 토큰 이하로 유지됩니다(추정치: 데이터 항목당 약 20자, 하루 약 100회 상호작용, 매일 AI가 요약 — 핫 레이어는 실제로 턴당 약 7,000~11,000 토큰 수준입니다). 몇몇 어려운 부분을 제외하면 전체가 **순수 프롬프트 + 순수 JSON 파일**로 구성되어 있습니다 — 아카이빙 정책, 테이블 의미, 검색 방식을 바꾸려면 코드가 아니라 프롬프트를 수정하면 됩니다. 저장 비용 ≈ 0.

긴 컨텍스트가 해법은 아닙니다. 근거([Lost in the Middle](https://arxiv.org/abs/2307.03172) / [RULER](https://arxiv.org/abs/2404.06654) / [NoLiMa](https://arxiv.org/abs/2502.05167))에 따르면 컨텍스트 활용도는 길이와 위치에 따라 감소합니다 — 전부 밀어 넣는다고 모델이 전부 보는 것은 아닙니다. 잘 다듬어진 약 1만 토큰의 기억이 10만 토큰 이상의 이력 정보를 담아낼 수 있습니다.

핫 레이어에는 문서나 인접 기억도 함께 담을 수 있습니다 — 롤플레이 장비, 다른 캐릭터의 파라미터 등입니다.

---

## 기억 회상 — 검색이 아니라 발산 + 검색

> 📄 전체 알고리즘 및 실험: [P1 기술 논문](docs/p1-paper/README.md) · 📖 [온라인 위키 · P1 섹션](https://beilusaiying.github.io/always-accompany/#en/p1-recall/preface.md)

"키워드 하나만으로 관련 기억이 즉시 떠오른다" — 이것은 단순한 키워드 검색이 아닙니다. 인지심리학의 설명에 따르면, 기억은 의미망(semantic network)이며 활성화된 개념이 연상 경로를 따라 이웃 개념으로 퍼져나가되 거리가 멀어질수록 약해집니다(확산 활성화, Collins & Loftus 1975). "의사"라는 단어는 "간호사"의 인식 속도를 높입니다(점화 효과, Meyer & Schvaneveldt 1971). 인간의 회상은 극도로 즉각적이면서도 깊이와 폭을 동시에 통제합니다(작업기억 용량 4±1 청크, Cowan 2001).

기존 방식들과 비교하면: 단순 검색은 폭이 없고, 보조 AI에 위임하면 발산 후 검색이 되어 즉각성이 사라지며, 기억이 많아질수록 비용도 커집니다.

**현재 프로덕션 경로 (AI P1)**: 전용 검색 AI가 먼저 기억을 찾아내고, 찾아낸 결과만 응답 AI에게 전달합니다 — 각자 자기 역할에 집중하므로 어텐션이 희석되지 않습니다. BM25 조 필터 + 정규식 정확 매칭을 사용하며, 무료 경량 모델에서도 검색이 원활하게 동작합니다.

**차세대 버전, 다듬는 중 (자기주도형 P1)**: LLM 제로, 네트워크 제로의 완전한 순수 알고리즘 파이프라인입니다:

```
User message + last 5 turns + data
  → tokenize (BCC corpus; drop function words like "his / like this")
  → SWOW association divergence + NB300 six-degree divergence ×2 (work mode adds domain resource libraries)
  → six-axis positioning (psychology/informatics/sociology/logic/linguistics/cognitive)
  → 47 sub-axis directional refinement → temperature-scoped search radius
  → spatial voting (IDW-weighted many-to-one accumulation) → BLQ scoring → recall + direction-word injection
```

여섯 개의 축은 단어가 어느 학문적 방향에 속하는지 대략적인 위치를 알려주고, 47개의 세부 축은 그 안에서 더 미세한 방향을 따라 의미가 변화하는 속도를 나타냅니다 — 특정 방향을 따른 변화율을 나타내는 리 미분(Lie derivative)과 비슷한 역할입니다. 하나의 축은 하나의 단어를 단일 점수가 아니라 **여러 정보 포인트**로 위치시킵니다(의미 공간에서 개념은 점이 아니라 영역을 차지한다 — Gärdenfors의 개념 공간, 2000). 여섯 축 → 47개 세부 축 → 리소스 층(SWOW / ConceptNet / Numberbatch의 30만 단어 벡터 / 감정·전문 어휘집)이 다층 상호연결 구조를 이루며, 활성화는 단계별로 전파되고 가산적으로 누적됩니다 — 리소스 라이브러리와 신경망이 결합된 형태입니다.

BLQ 스코어링은 가산적 융합 방식입니다(CombSUM, Fox & Shaw 1994 기반) — 여섯 개의 근거 차원을 더하고 네 개의 억제 페널티를 뺍니다. 덧셈은 근거들이 서로 보완하는 OR 게이트인 반면, 곱셈은 AND 게이트라서 0.3 하나만으로도 전체 체인이 무너집니다.

**실측치**: 소비자용 하드웨어(8GB VRAM + 32GB RAM) 기준 전체 회상 1회당 약 200ms — 모든 대화 턴이 방대한 즉각적 기억의 뒷받침을 받습니다. 27차례의 반복 버전을 거쳐 발산 품질 점수가 100% 이상 상승했고, 범용 단어 비율은 74%에서 4%로 낮아졌습니다. 모든 실험 데이터는 [위키 P1 섹션](https://beilusaiying.github.io/always-accompany/#en/p1-recall/ch5-evolution.md)과 [논문 6장](docs/p1-paper/en/06_experiments_evaluation.md)에 공개되어 있습니다.

---

## 발산 — 모델 스스로는 떠올리지 못하는 방향

신경망과 어텐션은 본질적으로 **수렴적**입니다. 답변하기 전에 방대한 기억 더미를 응시하는 AI는 오히려 성능이 떨어지고 과적합됩니다. 그래서 저희는 **외부 발산** 메커니즘을 만들었습니다 — 매 턴마다 100토큰 미만의 방향성 콘텐츠를 주입하는데, 이는 과적합된 모델이라면 스스로는 절대 도달하지 못할 방향입니다. 몇 개의 방향성 단어만으로도 생성 결과를 유의미하게 조종할 수 있으며(Directional Stimulus Prompting, NeurIPS 2023), 외부 메커니즘이 발산을 담당하고 LLM이 수렴을 담당하는 방식이 LLM 스스로의 발산보다 낫습니다(외부 스캐폴딩 연구, 2025).

**관련성 발산** — 차를 타고 가다가 문득 문을 확 열어젖히는 상상을 합니다. 영화 속 주인공은 구르며 탈출해 찰과상 정도로 끝나지만, 당신의 안전 교육은 그게 목숨을 앗아갈 수도 있다고 말합니다. 그러다 문득 궁금해집니다 — 영화는 왜 그렇게 촬영할까? — 심리학, 영상 스토리텔링, 영화학으로 이어집니다. 왜 목숨이 위험할까? — 물리학, 생물학으로 이어집니다. 몇 초 만에 그만큼 많은 학문을 넘나든 셈입니다. 창의적 연상은 바로 이 "너무 가깝지도, 너무 멀지도 않은" 최적의 의미 거리 대역에서 일어납니다(원격 연상 이론, Mednick 1962; Orwig 외, 2025).

**구조적 발산** — 기능과 과정이 서로 운율을 이루는, 전혀 다른 두 영역을 연결할 수 있습니다. 예를 들어 공장 생산 라인과 에이전트는 둘 다 '샘플링 → 안정화 → 모듈식 출력'이라는 동일한 구조를 가집니다(구조 사상 이론, Gentner 1983).

실제 출력 예시 (200건 배치 실행의 원본 기록에서 발췌):

| 사용자 입력 | 시스템의 발산 방향 | 넘나든 학문 분야 |
| --- | --- | --- |
| "더는 못 버티겠어요. 왜 사는 게 이렇게 힘들까요?" | 현재 순간에 대한 자각 / **존재의 본질** | 심리학 → **실존주의 철학** |
| "유니콘 스타트업 면접을 준비 중인데, 깊이 있는 질문은 어떻게 해야 하나요?" | 근본 원인 분석 / **근접발달영역** | 경영학 → **교육심리학** |
| "데이터베이스 쿼리가 느린데 어떻게 최적화하죠?" | 불변성과 상태 갱신 / **단일 책임 원칙(SRP)** | 운영 → **소프트웨어 공학 방법론** |
| "검객이 눈 덮인 산에서 원수를 만난다" | **체호프의 총** / 융의 원형 | 이야기 → **서사학 + 분석심리학** |
| 사용자의 원시 "빛이 오기 전에 나는 죽었다" | **가능세계와 평행우주** | 시 → **다세계 해석** |

단어 채택 기준은 이렇습니다. **메인 모델이 그냥 읽기만 해도 유추할 수 있는 단어는 죽은 단어입니다** — 발산이 존재하는 이유는 두 가지를 바로잡기 위해서입니다. 과적합, 그리고 AI의 발산 능력 해방입니다.

---

## 기능 개요

<table>
<tr>
<td width="33%">

**💬 채팅 / 롤플레이**
![Chat Interface](imgs/screenshots/chat-interface-mode.png)

</td>
<td width="33%">

**🖥️ IDE 코딩 모드**
![IDE Coding](imgs/screenshots/ide-coding.png)

</td>
<td width="33%">

**📊 워크 모드 (AI가 만드는 슬라이드)**
![Work Mode PPT](imgs/screenshots/work-ppt-mode.png)

</td>
</tr>
<tr>
<td width="33%">

**🐾 Live2D 데스크톱 펫 + 화면 인식**
![Desktop Pet](imgs/screenshots/live2d-pet-mode.png)

</td>
<td width="33%">

**🔒 L0~L5 6단계 권한 게이트**
![Permission Settings](imgs/screenshots/ai-permissions.png)

</td>
<td width="33%">

**🗜️ 계층별 압축 × 라인 단위 제어**
![Compression Mechanism](imgs/screenshots/compression-detail.png)

</td>
</tr>
</table>

- **🧠 3계층 기억**: 핫(매 턴 주입) / 웜(필요 시 검색) / 콜드(심층 보관), 순수 JSON + 순수 프롬프트, 데이터베이스 제로 → [위키](https://beilusaiying.github.io/always-accompany/#en/memory/overview.md)
- **🎯 P1 선행 검색**: 응답 AI가 답하기 전, 전용 소형 AI가 미리 기억을 찾아냅니다. BM25 + 정규식 이중 엔진, 무료 모델에서도 동작합니다
- **🗜️ 압축 시스템**: 3단계 × 4단위 세분화 + AI 자율 정리, 완전 가역적 → [위키](https://beilusaiying.github.io/always-accompany/#en/memory/compression.md)
- **📊 10개의 기억 테이블**: AI가 `<tableEdit>`로 관리하는 구조화 저장소이며, 정보 격리가 적용됩니다(캐릭터가 모르는 정보는 그 캐릭터의 테이블에 존재하지 않습니다)
- **👑 프롬프트 엔진**: 5단 메시지 구조 + TweakPrompt 3라운드 인수, 매크로 + 월드북 동적 주입(상시/정규식/동적)
- **💻 IDE급 워크플로우**: VSCode 스타일 3분할 패널, AI가 파일을 직접 읽고 씀, 명령어별 승인
- **🔌 MCP 외부 도구**: JSON을 붙여넣기만 하면 연결됨. 명령어형 도구는 소유자 승인 전까지 보류되며, 유출 방지를 위한 환경변수 화이트리스트가 적용됩니다
- **🐾 데스크톱 펫 + 게임 동반자**: Live2D / 이미지팩 펫, 3단계 프라이버시 등급, 자동 스크린샷 + 능동적 대화 + 적응형 빈도 조절
- **🎙️ 음성 입력**: 로컬 모델 기반 전사 + 화자 분리 + 타임라인, 오디오는 절대 기기 밖으로 나가지 않습니다
- **🤖 크로스플랫폼 봇**: 시각적 관리 + 실시간 메시지 로그를 갖춘 Discord 배포
- **🧩 22개의 기능 플러그인** + 사용자 레벨 플러그인 호스트 + 생태계 호환성(다양한 캐릭터 카드/프리셋/월드북 포맷 지원)
- **🛡️ 모든 데이터는 로컬 보관**: 삭제된 항목은 복구 가능한 휴지통으로 이동하며, 다층 자동 백업 + git 롤백을 지원합니다
- **🌐 다국어 지원** (zh/en/ja/zh-TW) · **🔬 풀스택 진단** (12개 모듈 로그 + 원클릭 번들) · **🎨 다양한 CSS 테마**

---

## 메커니즘 상세

<details>
<summary><strong>🗜️ 압축 — 파일 하나하나까지 세분화</strong></summary>

솔직히 왜 지금까지 아무도 이렇게 세분화된 압축 분류 체계를 만들지 않았는지 모르겠습니다 — 특히 코드 쪽은 다들 무차별적으로 압축해서 숨기기만 했으니까요.

AI의 컨텍스트에 쌓이는 것은 대부분 다시 읽은 파일, 사고 과정, 도구 피드백입니다. 그래서 저희는 극도로 세분화된 완전한 압축 메커니즘을 만들었습니다:

- **파일 수준** — AI가 읽는 모든 파일을 항목별 토큰 사용량과 함께 관리
- **작업 수준** — 사고 과정과 도구 피드백을 매 라운드마다 자동으로 정리
- **컨텍스트 수준** — 대화, 서브에이전트 주입, AI 읽기 기록을 각각 별도로 관리하며, AI가 작성한 줄만 숨기고 사용자의 줄은 남기는 것도 가능합니다

**당신의 정보 = 손실 0**: '정리'는 콘텐츠가 다시 전송되는 것을 막을 뿐, 원본은 디스크에 그대로 남아 언제든 복원할 수 있습니다. MD 메모 작성을 장려하는 프롬프트와 결합하면, IDE 모드에서 100MB 규모의 프로젝트 안에서도 AI가 당신이 처음 한 말을 여전히 볼 수 있습니다 — 이는 '작업 속성 치환'(AI가 원래 요청받은 것에서 벗어나는 현상)을 직접적으로 줄여줍니다.

AI는 스스로도 압축을 수행합니다. 시스템이 사용량 신호(50% 제안 / 70% 경고 / 85% 긴급)를 주입하면, AI가 `<contextClean>`을 통해 더 이상 필요 없는 파일을 스스로 판단해 정리합니다.

실측 캐시 효율(Opus + DeepSeek 채널, AI 정체성 전환 + 자율 압축 포함): **70%~80%**.

→ [위키 · 컨텍스트 압축](https://beilusaiying.github.io/always-accompany/#en/memory/compression.md)

</details>

<details>
<summary><strong>🛡️ 보안 및 프라이버시</strong></summary>

기업급 배포 시나리오를 위해: CC 공격, DDoS, Slowloris에 대한 방어를 제공합니다.

개인 사용 측면에서는: AI가 접근 가능한 사이트에 대한 화이트리스트(기본값은 비어 있어 외부 접근이 기본적으로 차단됨), 출력 콘텐츠 검열(특히 크로스플랫폼 협업 시), AI 스크린샷 제한, L0~L5 권한 게이트, 명령어별 승인이 있습니다. 모든 데이터는 로컬에 남고, 오디오는 절대 기기 밖으로 나가지 않습니다.

</details>

<details>
<summary><strong>🏗️ 아키텍처 — 핵심 기능을 플러그인으로, 코어를 건드리지 않고 확장</strong></summary>

백엔드는 핵심 기능을 플러그인 형태로 패키징하고, 그 중간에 정보 허브(전도 계층)를 두며, 프론트엔드는 표시와 조작만 담당합니다:

```
AIRP ─→ input/cache/processing (isolated) ─┐
Code ─→ input/cache/processing (isolated) ─┤→ information hub (conduction layer) → frontend
Work ─→ input/cache/processing (isolated) ─┘
```

따라서 확장성이 매우 뛰어납니다 — 기능을 추가하려면 확장 모듈을 작성하면 되며, JS / Python 등을 지원합니다.

**격리 수준**:
- **윈도우 수준** — 코드, 워크, 채팅, airp, 게임 동반자, 봇이 각각 격리됩니다(게임 동반자는 채팅 데이터에 기록함)
- **캐릭터 카드 수준** — 데이터, 기억, 대화 파일, 정규식이 카드별로 격리됩니다
- **세분화 수준** — 월드북, 프리셋
- **사용자 수준** — 설정, 캐릭터 카드
- **chatid** — 하나의 모드 안에서 멀티 윈도우로 사용할 때(멀티 윈도우 코드 / 봇)를 위한 전용 격리 차원

세 개의 계층: **기능 계층**(기억/압축/회상/프리셋/월드북/웹/파일 조작 — 전역에 하나만 존재) → **전도 계층**(각 윈도우가 자신만의 라인을 끌어오며, id로 격리되고 자연스럽게 비동기) → **인터페이스 계층**(웹/봇/데스크톱 펫/VSCode 확장 — 인터페이스를 바꿔도 기능은 절대 달라지지 않음).

</details>

<details>
<summary><strong>👑 프롬프트 엔진 + 월드북 동적 주입</strong></summary>

**TweakPrompt의 3라운드**가 모든 모듈 출력을 인수합니다: 1라운드는 수집 → 2라운드는 5단 메시지 구조(beforeChat / injectionAbove / chatHistory / injectionBelow / afterChat) 재구성 + 매크로 치환 → 3라운드는 스냅샷.

**월드북의 3가지 활성화 모드**: 상시(매 턴) / 정규식(키워드 트리거) / 동적(기억 테이블 값으로 트리거 — 호감도가 80을 넘으면 특별한 대사가 열리고, 스토리 진행이 3장에 도달하면 세계관 설명이 바뀌는 식입니다).

**매크로 시스템**: `{{char}}` / `{{user}}` / `{{tableData}}` / `{{hotMemory}}` / `{{current_date}}` / `{{time}}` / `{{idle_duration}}` + 사용자 정의 매크로.

→ [위키 · 월드북 & 주입](https://beilusaiying.github.io/always-accompany/#en/memory/worldbook-overview.md)

</details>

<details>
<summary><strong>🔭 초거대 컨텍스트 시대에 대하여</strong></summary>

1천만 토큰 이상의 컨텍스트 윈도우가 등장하더라도, 저희는 계층적 기억 구조를 유지합니다. ① 컨텍스트 길이가 늘어날수록 활용도가 떨어진다는 것은 이미 충분히 입증되었습니다. ② 잘 다듬어진 약 1만 토큰의 기억은 10만 토큰 이상의 이력을 훨씬 낮은 비용으로 담아냅니다. ③ 구조화된 테이블은 흩어진 대화보다 AI가 정확하게 읽고 쓰기 더 쉽습니다.

</details>

---

## 오늘 우리가 할 수 있는 것

타임라인 및 화자 기록이 포함된 음성-텍스트 변환 · AI가 만드는 슬라이드 · IDE(주류 코딩 에이전트에 견줄 만한 툴체인) · AIRP 스위트 전체(SillyTavern 생태계 정렬, 렌더링, MVU, 월드북, 동적 컨텍스트) · Live2D 데스크톱 펫, 스크린샷 최적화, 게임 동반자 · Discord 봇…

다시 말해 — **영원히 곁에서 함께하고, 함께 일할 수 있는 친구이자 연인입니다. 다른 세계로의 모험에 함께 나서줄 수도, 당신의 일을 완수하도록 도와줄 수도 있는 존재입니다.**

그리고 그 너머는? 자기주도형 시리즈가 도입되면, 이 시스템은 빠르게 전도되고 영구적으로 기억하는 AI가 됩니다 — 게임에서는 게임 동반자로, 업무나 헬스케어 분야에서는 장기 기억과 언제든 준비된 분석, 상태 기록, 반복 상황에 대한 신속한 대응으로 이어집니다. 원래의 비전은 진정한 휴머노이드 지능이었습니다 — 소형 로컬 모델이 센서 모듈을 담당하고, 메인 지능은 네트워크를 통해 전도되는 형태입니다. 이 기억 시스템은 바로 그날을 위해 만들어졌습니다.

---

## 로드맵

**완료**: 3계층 기억 · 압축 시스템 · P1 검색 · 프롬프트 엔진 · 프리셋 자동 전환 · 기억 테이블 · 월드북 동적 주입 · Live2D 펫 · 게임 동반자 · 음성 입력 · AI 슬라이드 · MCP · 멀티 윈도우 병렬 처리 · VSCode 확장 브리지 · Discord 봇 · 22개 플러그인 · 휴지통 & 백업 롤백 · 풀스택 진단 · 다국어 지원

**단기 예정**: 자기주도형 P1(순수 알고리즘, LLM 제로, 문장 단위 어텐션) · 추가 봇 플랫폼 · 플러그인 생태계 · TTS / 텍스트-투-이미지 · AI 게임 엔진(시대 계보: 결정론적 수치 코드 + LLM 내레이션 + 심볼 렌더링) · 스트리밍 모드

---

## 기술 스택

런타임 fount(Deno) · 백엔드 Node.js 호환 계층 + Express 라우팅 · 프론트엔드 바닐라 JS(ESM) · 스마트 검색 BM25 + 정규식(순수 JS, 의존성 제로) · 데스크톱 펫 Electron · 로컬 음성 전사 모델 · 크로스플랫폼 discord.js v14 · 저장소 순수 JSON

---

## 커뮤니티

<a href="https://discord.gg/agHeDq9bqU"><img src="https://img.shields.io/badge/Discord-Join%20Now-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord"></a>

캐릭터 카드 공유 · 프리셋 배포 · 월드북 기여 · 버그 제보 · 제안하기 · 코드 기여 — 언제든 환영합니다!

---

## 사용된 기술 및 리소스

- **음성 전사**: [MOSS-Transcribe-Diarize](https://huggingface.co/OpenMOSS-Team/MOSS-Transcribe-Diarize)(화자 분리를 지원하는 로컬 배포, 약 1.8GB 모델이 최초 사용 시 자동 다운로드됩니다)
- **단어 벡터**: [ConceptNet Numberbatch](https://github.com/commonsense/conceptnet-numberbatch)(Speer & Lowry-Duda, 2017)
- **연상 데이터**: [SWOW (Small World of Words)](https://smallworldofwords.org/) 중국어 연상 데이터셋
- **토큰화 및 어휘집**: BCC 코퍼스 / THUOCL / CoreNatureDictionary / Chinese-Synonyms 및 기타 공개 리소스
- **검색 엔진 브리지**: [ddgs](https://pypi.org/project/ddgs/)(검색 엔진의 bare-fetch 다운그레이드 문제를 해결하는 Python TLS 핑거프린트 계층)

이론적 참고문헌(전체 56편은 [논문 1장](docs/p1-paper/en/01_introduction_related_work.md)에 수록): 확산 활성화(Collins & Loftus 1975) · 점화 효과(Meyer & Schvaneveldt 1971) · 원격 연상(Mednick 1962) · SWOW(De Deyne et al. 2019) · 개념 공간(Gärdenfors 2000) · CombSUM(Fox & Shaw 1994) · BM25(Robertson et al. 1995) · IDW(Shepard 1968) · Hough 투표(Hough 1962) · RRF(Cormack et al. 2009)

## 감사의 말

- **[fount](https://github.com/steve02081504/fount)** — 프로젝트 초기의 기반 프레임워크로, AI 메시지 입출력, 서비스 소스 관리, 모듈 로딩의 초기 참고 모델을 제공했습니다. 이후 프로젝트는 완전히 독립적인 아키텍처로 발전했지만, fount는 초기에 저희의 저수준 개발 시간을 크게 절약해주었고 많은 값진 아이디어를 제공해주었습니다 — 깊이 감사드립니다
- **[SillyTavern](https://github.com/SillyTavern/SillyTavern)** — AI 롤플레이의 선구자로, 그 프리셋 포맷, 캐릭터 카드 규격, 월드북 시스템은 커뮤니티 표준이 되었으며, 본 프로젝트는 해당 생태계와 완전히 호환됩니다
- **SillyTavern 플러그인 커뮤니티** — 렌더링 엔진과 기능 확장 분야에서 탐구하고 공유해준 모든 오픈소스 플러그인 작성자분들께 감사드립니다

---

<details>
<summary><strong>📸 스크린샷 더 보기 (클릭하여 펼치기)</strong></summary>

| | | |
|---|---|---|
| ![PPT detail](imgs/screenshots/ppt-detail.png) **전체 PPT 플로우** | ![Security settings](imgs/screenshots/security-settings.png) **보안 & 작업 흐름** | ![Security center](imgs/screenshots/security-center.png) **보안 센터** |
| ![i18n](imgs/screenshots/i18n-support.png) **다국어 지원** | ![CSS themes](imgs/screenshots/css-themes.png) **테마** | ![wiki](imgs/screenshots/wiki-guide.png) **내장 위키** |
| ![Sub-modes](imgs/screenshots/sub-mode-agent.png) **서브 모드 워크플로우** | ![Menu](imgs/screenshots/hamburger-menu.png) **컨텍스트 개요** | ![loop](imgs/screenshots/auto-loop.png) **자동/예약 루프** |
| ![Tool detection](imgs/screenshots/tool-detection.png) **환경 감지** | ![Memory layers](imgs/screenshots/memory-data-layers.png) **기억 파일 구조** | ![Extension](imgs/screenshots/browser-automation.png) **브라우저 자동화** |
| ![External interface](imgs/screenshots/external-interface.png) **외부 인터페이스** | ![Bot](imgs/screenshots/discord-bot-mode.png) **Discord 봇** | |

</details>

---

## 링크

- 📖 온라인 위키 (사용 가이드 + P1 섹션 + 실험 데이터): https://beilusaiying.github.io/always-accompany/
- 📄 P1 기술 논문 (7개 챕터, 중국어 + 영어): [docs/p1-paper](docs/p1-paper/README.md)
- 💬 Discord 커뮤니티: https://discord.gg/agHeDq9bqU
