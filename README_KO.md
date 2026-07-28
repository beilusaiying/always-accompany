<p align="center">
  <img src="imgs/icon.jpg" alt="always accompany" width="200">
</p>

<h1 align="center">always accompany</h1>

<p align="center">
  <a href="https://discord.gg/agHeDq9bqU"><img src="https://img.shields.io/badge/Discord-커뮤니티_참여-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord"></a>
  &nbsp;
  <a href="https://github.com/beilusaiying/always-accompany"><img src="https://img.shields.io/badge/GitHub-Star_⭐-181717?style=for-the-badge&logo=github" alt="GitHub"></a>
</p>

<p align="center"><a href="README.md">English</a> | <a href="README_CN.md">简体中文</a> | <a href="README_TW.md">繁體中文</a> | <a href="README_JA.md">日本語</a> | 한국어 | <a href="README_RU.md">Русский</a> | <a href="README_DE.md">Deutsch</a> | <a href="README_ES.md">Español</a> | <a href="README_FR.md">Français</a> | <a href="README_PT.md">Português</a></p>

<p align="center">📖 <a href="https://beilusaiying.github.io/always-accompany/">온라인 위키 (사용 가이드)</a> &nbsp;·&nbsp; 📄 <a href="docs/p1-paper/README.md">P1 기술 논문</a></p>

> 본 프로젝트는 갓 졸업한 대학생이 설계·아키텍처·개발을 모두 독자적으로 완성했으며, AI 보조 프로그래밍의 도움을 받아 알고리즘 설계·생체모방 원리·프레임워크 아키텍처·논리적 사고 등 다방면의 역량을 결합했습니다.

---

```bash
git clone https://github.com/beilusaiying/always-accompany.git
cd always-accompany
run.bat          # Windows
# 또는 chmod +x run.sh && ./run.sh   # Linux/macOS
```

브라우저에서 `http://localhost:1314` 를 열고 → AI 서비스 소스를 설정 → 캐릭터 카드를 임포트 → 대화를 시작하세요. Deno 런타임은 최초 실행 시 자동으로 다운로드되며, 수동 설치가 필요 없습니다. 최소 하나의 AI API 키가 필요합니다. 앱에는 완전한 내장 wiki 튜토리얼이 포함되어 있습니다.

> **참고:** 첫 실행은 시간이 좀 걸립니다. 런타임이 의존성을 다운로드하고 데이터베이스를 초기화해야 합니다. 페이지가 완전히 로드될 때까지 기다려 주세요. 이후 실행은 훨씬 빠릅니다.

---

일→월→년 순으로 아카이빙되는 순수 JSON 기반 3계층 재귀 기억(260년 용량) + 전치 검색 AI(관련 기억만 전담으로 찾아 응답 AI에게 넘겨주는 전용 AI — 각자 자기 일만 함) + 계층형 컨텍스트 정리(정리한다는 것은 다시 전송하지 않는다는 뜻일 뿐, 원문은 그대로 남아 언제든 복원 가능). 이 세 가지가 맞물려 AI가 컨텍스트 윈도우에 얽매이지 않고 당신이 한 모든 말을 계속 기억하게 합니다. 이를 기반으로 채팅/롤플레이, IDE 코딩 모드, 업무 모드(AI가 만드는 슬라이드 포함), Live2D 데스크톱 펫(화면 인식 + 게임 동반), 음성 입력, Discord 봇, MCP 외부 도구 연동을 구축했습니다 — 모든 진입점이 동일한 기억을 공유하므로 창을 바꿔도 AI가 당신을 잊지 않습니다. 현재 다듬는 중: 차세대 검색 엔진(21노드 순수 알고리즘 파이프라인, LLM 제로, 네트워크 제로, 밀리초급, 문장 단위 주의를 목표).

---

## 기능 개요

<table>
<tr>
<td width="33%">

**💬 채팅 / 롤플레이**
![채팅 인터페이스](imgs/screenshots/chat-interface-mode.png)

</td>
<td width="33%">

**🖥️ IDE 코딩 모드**
![IDE 코딩](imgs/screenshots/ide-coding.png)

</td>
<td width="33%">

**📊 업무 모드(AI 슬라이드 제작)**
![업무 모드 PPT](imgs/screenshots/work-ppt-mode.png)

</td>
</tr>
<tr>
<td width="33%">

**🐾 Live2D 데스크톱 펫 + 화면 인식**
![데스크톱 펫](imgs/screenshots/live2d-pet-mode.png)

</td>
<td width="33%">

**🔒 L0–L5 6단계 권한 게이트**
![권한 설정](imgs/screenshots/ai-permissions.png)

</td>
<td width="33%">

**🗜️ 계층형 압축 × 항목별 제어**
![압축 메커니즘](imgs/screenshots/compression-detail.png)

</td>
</tr>
</table>

- **🧠 3계층 기억**: 핫(매 턴 주입) / 웜(필요 시 검색) / 콜드(심층 아카이브), 순수 JSON + 순수 프롬프트 구동, 데이터베이스 제로
- **🎯 P1 전치 검색**: 전담 소형 AI가 먼저 기억을 찾아 응답 AI에게 넘김, BM25 + 정규식 이중 엔진, 검색은 무료 모델로도 가능
- **🗜️ 압축 시스템**: 3단계(원클릭/유형별/항목별) × 4가지 세분화(채팅 메시지/파일 읽기/시스템 주입/과정 콘텐츠) + AI 자율 `<contextClean>` 정리, 전부 되돌리기 가능
- **📊 기억 테이블 10종**: 구조화 저장, AI가 `<tableEdit>`으로 자동 유지, 정보 격리 구현(캐릭터가 모르는 것은 테이블에 아예 없음)
- **👑 프롬프트 엔진**: 5단 메시지 구조 + TweakPrompt 3라운드 인수, 매크로 변수 + 월드북 동적 주입(상시/정규식/동적 3모드)
- **💻 IDE급 워크플로**: VSCode 스타일 3단 레이아웃, AI가 파일을 직접 읽고 쓰며, 명령 실행은 항목별 승인
- **🔌 MCP 외부 도구**: JSON을 붙여넣어 연결, 명령형 서버는 소유자 승인 전까지 기본 차단, env 화이트리스트로 유출 방지
- **🐾 데스크톱 펫 + 게임 동반**: Live2D / 이미지팩 펫, 3단계 프라이버시 스위치, 자동 스크린샷 + 자발적 말 걸기 + 빈도 자동 조절
- **🎙️ 음성 입력**: 로컬 모델 전사, 화자 분리 + 타임라인, 오디오는 기기 밖으로 나가지 않음
- **🤖 크로스플랫폼 봇**: Discord 배포, 시각적 관리 + 실시간 메시지 로그
- **🧩 22개 기능 플러그인** + 사용자 레벨 플러그인 호스트 + 생태계 호환(여러 형식의 캐릭터 카드/프리셋/월드북 임포트)
- **🛡️ 모든 데이터는 로컬에 저장**: 삭제해도 휴지통에서 복구 가능, 다층 자동 백업 + git 롤백
- **🌐 다국어**(중/영/일/번체) · **🔬 풀스택 진단**(12개 모듈 로그 + 원클릭 패키징) · **🎨 다양한 CSS 테마**

---

## 상세 메커니즘

<details>
<summary><strong>🧠 3계층 재귀 기억 — 왜 계층화하는가</strong></summary>

전체 히스토리를 하나의 큰 풀에 던져 넣으면 검색이 느려집니다 — 실험 데이터가 이를 뒷받침합니다([Lost in the Middle](https://arxiv.org/abs/2307.03172) / [RULER](https://arxiv.org/abs/2404.06654) / [NoLiMa](https://arxiv.org/abs/2502.05167)): 그 안에 들어 있어도 모델이 실제로 보지 못할 수 있습니다. 해마의 기억 형성 방식과 에빙하우스 망각 곡선을 참고해, 시간 거리에 따라 정보를 3계층으로 나눴습니다:

```
🔥 핫 계층 — 매 턴 자동 주입: 사용자 프로필 / 영구 기억 / 미완료 작업 / 최근 기억
🌤️ 웜 계층 — 필요 시 검색(최근 1개월): 일일 요약 / 임시 아카이브 / 월간 인덱스
❄️ 콜드 계층 — 심층 검색(1개월 이상): 월간 요약 / 과거 일일 요약 / 연도 인덱스
```

핫 계층은 매 턴 약 7,000~11,000 토큰만 차지합니다(128K 윈도우의 5–9%). 기억 감쇠는 에빙하우스 망각 곡선을 차용합니다: `score = weight × (1 / (1 + days × 0.1))`. 순수 프롬프트 구동 — 아카이빙 전략, 테이블 의미, 검색 스타일을 바꾸려면 프롬프트만 수정하면 되고 코드는 건드릴 필요가 없습니다.

</details>

<details>
<summary><strong>🎯 P1 전치 검색 AI — 왜 AI를 둘로 나누는가</strong></summary>

응답 AI가 스스로 수백 건의 히스토리 중에서 관련된 것을 골라야 한다면, 찾는 일과 답하는 일을 동시에 해야 해서 주의가 두 작업 사이에서 분산됩니다. 그래서 "기억 찾기"를 전담 소형 AI로 분리했습니다:

```
사용자가 메시지 전송 → P1 검색 AI(5K 토큰 미만, 검색에만 집중) → 선별된 기억 + 현재 대화 → 응답 AI(응답에만 집중)
```

BM25 대략 필터링 + 정규식 정확 매칭, 최대 3라운드 안에 목표에 도달합니다. 검색은 무료 경량 모델로도 충분히 돌아가므로, 대화당 실제 비용은 사실상 응답 AI 호출 1회 분과 같습니다. P1은 프리셋 자동 전환도 담당합니다(진동 방지를 위한 5턴 쿨다운 포함).

</details>

<details>
<summary><strong>🗜️ 컨텍스트 관리 — 압축 세분화 × 단계 × AI 자율 정리</strong></summary>

AI가 작업하는 동안 과정성 콘텐츠가 계속 쌓입니다(같은 파일을 반복해서 읽기, 낡은 검색 결과, 오래된 도구 결과). 우리의 정리는 항상 숨기기(hide)일 뿐 — 언제든 복원할 수 있습니다.

**AI 자율 정리**: 시스템이 AI에게 자신의 컨텍스트 사용량 신호를 제공하고(50% 권장 / 70% 경고 / 85% 긴급), AI는 `<contextClean>` 명령으로 스스로 다이어트합니다. 정리 전에 먼저 기록을 남기므로 잘못 지워도 되돌릴 수 있습니다.

**사용자 세밀 제어**: 3단계(원클릭 전체 정리 / 유형별 / 항목별 직접 선택) × 4가지 세분화(채팅 메시지 / 파일 읽기별 토큰 청구서 / 5가지 체크 가능한 시스템 주입 카테고리 / 자동 다이어트되는 과정 콘텐츠).

실측 캐시 적중률(Opus + DeepSeek, AI 페르소나 전환 + 자율 압축 포함): **75%–80%**.

![압축 패널](imgs/screenshots/compression-multi.png)

</details>

<details>
<summary><strong>🔬 자율주행 P1 — 활발히 개발 중인 LLM 제로 검색 엔진</strong></summary>

P1 AI는 매 턴 API 요청을 보내야 합니다 — 지연, 비용이 발생하고 오프라인에서는 사용할 수 없습니다. 우리는 밀리초급 속도, 네트워크 의존성 제로, 문장 단위 주의를 목표로 완전 알고리즘 파이프라인(21노드, 약 9,000줄)을 구축해왔습니다.

**데이터 기반**: [SWOW 중국어 연상 네트워크](https://smallworldofwords.org/) / [ConceptNet Numberbatch 300차원 단어 벡터](https://github.com/commonsense/conceptnet-numberbatch)(약 30만 단어) / ConceptNet 중국어 관계 그래프 / THUOCL 등 다중 소스 사전. 어휘집은 AI 웹 검색 + 2일간의 자체 검토로 구축했으며, 구축 비용은 거의 제로에 가깝습니다.

**파이프라인**: 토큰화 → SWOW 연상 발산(동의어 확산은 금지 — 활성화하면 품질이 실측 55–76% 하락) → 6축 병렬 스코어링(심리 / 정보 / 사회 / 논리 / 언어 / 인지) → 47개 하위 방향 위치 지정 → 다중 리소스 교차 확인 → 공간 투표 랭킹(가산 IDW, 곱셈이 아님) → 2차 발산(독립 경로 5개) → BLQ 스코어링(CombSUM 가산 융합 참조, 자체 연구한 차원 가중치) → 방향어 선택 → 컨텍스트 주입. 21개 노드 전부 순수 알고리즘, LLM 제로.

**실험**: 27개 버전 반복; 발산 점수는 v9→v26 사이 2.01에서 4.05로 상승(+101%, 5점 만점, 사람이 단어 단위로 직접 판정); 리콜 적중률 약 90%; 종합 평균 약 3.5점. 만능 답변(범용) 비율은 74%에서 4%로 하락.

**실제 출력**(200건 배치 실행 원본 기록):

| 사용자 입력 | 시스템 발산 방향 | 넘어간 학문 분야 |
| --- | --- | --- |
| "더는 못 버티겠어, 사는 게 왜 이렇게 힘들까?" | 현재 순간 자각 / 내수용감각 인지 / **실재의 본질이란 무엇인가** | 심리학 → **실존주의 철학** |
| "유니콘 기업 면접을 준비하는데, 깊이 있는 질문은 어떻게 준비하나요?" | 근본 원인 분석 / **근접발달영역** | 경영학 → **교육심리학** |
| "제한된 예산으로 오운드 트래픽에서 이탈 고객 되찾기" | **디폴트 모드 네트워크 활성화** / **BDNF(뇌유래신경영양인자)** | 마케팅 → **인지신경과학** |
| "데이터베이스 쿼리가 너무 느린데 어떻게 최적화하나요" | 불변성과 상태 업데이트 / **SRP(단일 책임 원칙)** | 운영 → **소프트웨어 공학 방법론** |
| "설산에서 적을 만난 검객의 이야기" | **체호프의 총** / 융의 원형 | 이야기 → **서사학 + 분석심리학** |
| 사용자 원작시 "빛이 오기 전에 나는 죽었다" | **가능세계와 평행우주** | 시 → **물리학의 다세계 해석** |

어휘집 등재 기준: **주 모델이 원문만 읽고도 스스로 추론해낼 수 있는 단어는 무용한 단어** — P1의 가치는 모델이 스스로 떠올리지 못하는 방향을 주는 데 있습니다.

</details>

<details>
<summary><strong>👑 프롬프트 엔진 + 월드북 동적 주입</strong></summary>

**TweakPrompt 3라운드**가 모든 모듈의 출력을 통일적으로 인수합니다: Round 1 수집 → Round 2 5단 메시지 구조 재구성(beforeChat / injectionAbove / chatHistory / injectionBelow / afterChat) + 매크로 치환 → Round 3 스냅샷.

**월드북 3가지 활성화 모드**: 상시(매 턴 주입) / 정규식(키워드 트리거) / 동적(기억 테이블 수치 조건을 읽어 트리거 — 예: 호감도 > 80이면 특수 대사 해금, 퀘스트 진행이 3장에 도달하면 세계관 설명 전환).

**매크로 시스템**: `{{char}}` / `{{user}}` / `{{tableData}}` / `{{hotMemory}}` / `{{current_date}}` / `{{time}}` / `{{idle_duration}}` + 사용자 정의 매크로.

</details>

<details>
<summary><strong>🏗️ 시스템 아키텍처</strong></summary>

3계층: **기능 계층**(기억/압축/회상/프리셋/월드북/네트워킹/파일 조작…전역 단일 사본) → **전달 계층**(각 창이 각자의 라인을 끌어오며, id로 격리되어 자연스럽게 비동기·비차단) → **인터페이스 계층**(웹/봇/데스크톱 펫/VSCode 확장 — 인터페이스를 바꿔도 기능은 그대로).

데이터 격리: 사용자 레벨(AI 소스/전역 설정) / 캐릭터 카드 레벨(기억/채팅/월드북/정규식) / 대화 레벨(채팅 기록/모드/서브모드).

22개 플러그인 모두 통일된 규격 아래 성장하며, MCP가 외부 도구를 연결하고, 사용자 레벨 플러그인 호스트가 Python/Node 프로그램을 탑재합니다 — 확장은 절대 코어 코드를 건드리지 않습니다.

</details>

<details>
<summary><strong>🔭 거대 컨텍스트 윈도우 시대에 대하여</strong></summary>

컨텍스트 윈도우가 1000만 토큰 이상으로 확장되더라도 우리는 여전히 계층형 기억을 유지합니다: ① 길이가 길어질수록 컨텍스트 활용률이 저하된다는 확실한 실험적 증거가 있음; ② 약 1만 토큰의 엄선된 기억이 10만 토큰 이상의 원본 히스토리 정보량을 담아내며, 비용은 자릿수 단위로 낮음; ③ 구조화된 테이블이 대화에 흩어진 정보보다 AI가 정확히 읽고 쓰기 쉬움.

</details>

---

## 로드맵

**완료**: 3계층 기억 · 압축 시스템 · P1 검색 · 프롬프트 엔진 · 프리셋 자동 전환 · 기억 테이블 · 월드북 동적 주입 · Live2D 데스크톱 펫 · 게임 동반 · 음성 입력 · AI 슬라이드 제작 · MCP · 다중 창 병렬 · VSCode 확장 브리지 · Discord Bot · 22개 플러그인 · 휴지통 및 백업 롤백 · 풀스택 진단 · 다국어

**단기 계획**: 자율주행 P1(순수 알고리즘, LLM 제로, 문장 단위 주의) · 더 많은 봇 플랫폼 · 플러그인 생태계 · TTS / 텍스트투이미지 · AI 게임 엔진("era" 계열 게임 혈통 — 수치 상태를 위한 결정론적 코드 + LLM 내러티브 + 상징적 렌더링) · 라이브 스트리밍 모드

---

## 기술 스택

런타임 fount(Deno) · 백엔드 Node.js 호환 레이어 + Express 스타일 라우팅 · 프런트엔드 순수 JS(ESM) · 스마트 검색 BM25 + 정규식(순수 JS, 의존성 제로) · 데스크톱 펫 Electron · 음성 로컬 전사 모델 · 크로스플랫폼 discord.js v14 · 저장소 순수 JSON

---

## 커뮤니티

<a href="https://discord.gg/agHeDq9bqU"><img src="https://img.shields.io/badge/Discord-지금_참여하기-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord"></a>

캐릭터 카드 공유 · 프리셋 배포 · 월드북 기여 · 버그 제보 · 제안 · 코드 기여 — 모두 환영합니다!

---

## 사용한 기술과 리소스

- **음성 전사**: [MOSS-Transcribe-Diarize](https://huggingface.co/ICTNLP/MOSS-Transcribe-Diarize)(화자 분리 기능이 있는 로컬 배포; 모델은 약 1.8GB로 최초 사용 시 자동 다운로드)
- **단어 벡터**: [ConceptNet Numberbatch](https://github.com/commonsense/conceptnet-numberbatch)(Speer & Lowry-Duda, 2017)
- **연상 데이터**: [SWOW(Small World of Words)](https://smallworldofwords.org/) 중국어 연상 데이터셋
- **분사 및 사전**: THUOCL / CoreNatureDictionary / Chinese-Synonyms 등 공개 리소스
- **검색 엔진 브리지**: [ddgs](https://pypi.org/project/ddgs/)(원시 fetch 요청이 검색 엔진에 의해 저품질 처리되는 문제를 해결하는 Python TLS 핑거프린트 레이어)

## 감사의 말

- **[fount](https://github.com/steve02081504/fount)** — 이 프로젝트 초기의 기초 프레임워크로, AI 메시지 송수신·서비스 소스 관리·모듈 로딩 등 핵심 인프라의 초기 참조를 제공했습니다. 프로젝트는 이후 아키텍처적으로 완전히 독립적으로 진화했지만, fount는 초기에 많은 로우레벨 개발 시간을 절약해주었고 값진 아이디어를 많이 참고할 수 있게 해주었습니다 — 진심으로 감사드립니다
- **[SillyTavern](https://github.com/SillyTavern/SillyTavern)** — AI 롤플레이 분야의 선구적 프로젝트로, 그 프리셋 형식·캐릭터 카드 규격·월드북 시스템은 커뮤니티 표준이 되었으며, 본 프로젝트는 그 생태계와 완전히 호환됩니다
- **SillyTavern 플러그인 커뮤니티** — 렌더링 엔진, 기능 확장 등에서 탐구하고 공유해 준 모든 오픈소스 플러그인 제작자분들께 감사드립니다

---

<details>
<summary><strong>📸 더 많은 기능 스크린샷(클릭하여 펼치기)</strong></summary>

| | | |
|---|---|---|
| ![PPT 상세](imgs/screenshots/ppt-detail.png) **전체 PPT 워크플로** | ![보안 설정](imgs/screenshots/security-settings.png) **보안 및 작업 흐름** | ![보안 센터](imgs/screenshots/security-center.png) **보안 방어 센터** |
| ![다국어](imgs/screenshots/i18n-support.png) **다국어 지원** | ![CSS 테마](imgs/screenshots/css-themes.png) **다양한 테마** | ![wiki](imgs/screenshots/wiki-guide.png) **내장 Wiki** |
| ![서브모드](imgs/screenshots/sub-mode-agent.png) **서브모드 워크플로** | ![메뉴](imgs/screenshots/hamburger-menu.png) **컨텍스트 한눈에 보기** | ![loop](imgs/screenshots/auto-loop.png) **자동/예약 Loop** |
| ![도구 감지](imgs/screenshots/tool-detection.png) **환경 감지** | ![기억 계층](imgs/screenshots/memory-data-layers.png) **기억 파일 구조** | ![확장](imgs/screenshots/browser-automation.png) **브라우저 자동화** |
| ![외부 인터페이스](imgs/screenshots/external-interface.png) **외부 인터페이스** | ![Bot](imgs/screenshots/discord-bot-mode.png) **Discord Bot** | |

</details>
