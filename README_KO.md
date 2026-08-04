<p align="center">
  <img src="imgs/icon.jpg" alt="always-accompany" width="180">
</p>

<h1 align="center">always-accompany</h1>

<p align="center"><strong>컨텍스트와 어텐션 메커니즘에 집중한 멀티 AI + Agent 프로젝트</strong></p>

<p align="center">동반, 채팅, 프로그래밍, 업무가 하나의 기억·컨텍스트 프레임워크를 함께 씁니다 — SF 작품에 나오는 그런 AI처럼, 당신을 곁에서 함께하고 일도 거들어 줍니다.</p>

<p align="center"><strong>동적 어텐션 · 고정 주입 · 프로젝트 격리 · 전용 모드</strong></p>

<p align="center">
  <a href="https://discord.gg/agHeDq9bqU"><img src="https://img.shields.io/badge/Discord-커뮤니티_참여-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord"></a>
  &nbsp;
  <a href="https://github.com/beilusaiying/always-accompany"><img src="https://img.shields.io/badge/GitHub-Star_한번_눌러주기_⭐-181717?style=for-the-badge&logo=github" alt="GitHub"></a>
</p>

<p align="center"><a href="README.md">English</a> · <a href="README_CN.md">简体中文</a> · <a href="README_TW.md">繁體中文</a> · <a href="README_JA.md">日本語</a> · 한국어 · <a href="README_RU.md">Русский</a> · <a href="README_DE.md">Deutsch</a> · <a href="README_ES.md">Español</a> · <a href="README_FR.md">Français</a> · <a href="README_PT.md">Português</a></p>

---

## 당장 무엇을 할 수 있나?

- 장기 채팅과 롤플레이를 진행하며, SillyTavern의 캐릭터 카드·프리셋·월드북 등 커뮤니티 포맷을 그대로 임포트할 수 있습니다.
- 로컬 Agent 워크벤치처럼 프로젝트 파일을 읽고 수정하며 명령을 실행합니다.
- Live2D / 이미지 데스크톱 펫, 화면 인식, 게임 동반, 음성 입력, 그리고 9개 플랫폼을 아우르는 Bot 시스템을 통해 브라우저 밖으로 확장됩니다.
- 장기 자료를 로컬 파일에 보관하고, 매 턴 현재 질문과 관련된 조각을 자동으로 찾아내며, 더 이상 필요 없는 오래된 컨텍스트는 물러나게 합니다.
- 캐릭터, 프롬프트 내용과 순서, 주입 신원과 위치, 조건 트리거 규칙, 기억 회상 경로, 권한과 플러그인을 편집해 자신만의 AI로 개조합니다.

**우리에게는 무엇이 있나?** 이 인터페이스들 뒤에는 같은 하나의 시스템이 있고, 진짜 차이는 네 가지에 집중되어 있습니다.

- **독특한 기억·컨텍스트 프레임워크** — Data + hot / warm / cold 계층으로 장기 자료를 보관하고, 컨텍스트를 수집하고 기억을 검색하는 도구(P1)가 매 턴 응답 전에 현재 관련된 조각을 회상합니다. 컨텍스트 정리는 파일 읽기 단위의 세분화까지 이르며 되돌릴 수 있고, AI 스스로도 더 이상 필요 없는 이미 읽은 파일을 놓을 수 있습니다(작성자 환경에서 과금 기준으로 실측한 캐시 효율은 약 70–80%이며, 보장값이 아닙니다).
- **모든 콘텐츠를 편집 가능** — 캐릭터, 프롬프트, 주입, 기억, 회상 경로, 권한과 플러그인은 블랙박스가 아니며, 어느 계층이든 손보고 싶은 곳에 진입점이 있습니다.
- **높은 확장성의 프레임워크** — 핵심 기능은 플러그인으로 조직되어 중간 정보 스테이션을 거쳐 전달되고, 프런트엔드는 표시와 조작만 담당합니다. 사용자 플러그인은 JS, Python 또는 독립 프로그램으로 작성할 수 있습니다.
- **agent가 갖춰야 할 모든 기능** — 파일, 명령, 브라우저, MCP, 다중 창, 승인과 복원이 모두 갖춰져 있으며, 같은 하나의 기억·컨텍스트 프레임워크를 공유합니다. 대형 프로젝트를 완수하기 위해 태어났고, 그 핵심은 한정된 어텐션을 요긴한 곳에 쓰는 것입니다.

---

## 빠른 시작

필요한 것은 딱 두 가지입니다.

- 사용 가능한 AI API 하나.
- 간단한 프롬프트를 쓸 줄 아는 것.

이 두 가지만 있으면 바로 체험할 수 있습니다. 미리 밝혀 둘 것은, 현재 AIRP와 Chat의 프롬프트는 아직 정교하게 다듬는 중이라는 점입니다 — 현 단계에서는 생산성에 중점을 두고 있으며, 동반 방향의 다듬기는 차차 채워 갑니다.

그냥 채팅만 시작하고 싶다면, 이것이 비용의 전부입니다. 자율주행 P1의 로컬 검색 서비스(현재 실측 피크 메모리는 약 2 GiB 규모)는 통째로 끌 수 있습니다. P1 파라미터, 프롬프트 주입 위치, Code, Work와 플러그인은 필요에 따라 깊이 파고드는 설정이지, 처음 쓸 때 거쳐야 할 선행 과목이 아닙니다.

```bash
git clone https://github.com/beilusaiying/always-accompany.git
cd always-accompany
run.bat          # Windows
# 또는 chmod +x run.sh && ./run.sh   # Linux / macOS
```

런처는 Deno가 없으면 런타임을 자동으로 내려받고, 의존성이 완전하지 않으면 설치를 마칩니다. 페이지가 준비되면 대개 브라우저가 자동으로 열립니다. 수동으로 `http://localhost:1314` 에 접속해도 됩니다.

| 1. 인터페이스 언어 선택 | 2. AI 서비스 소스 바인딩 |
|---|---|
| ![언어 선택](imgs/screenshots/onboarding-language.png) | ![API 바인딩](imgs/screenshots/onboarding-api.png) |

서비스 주소, API Key, 모델을 입력하고 저장한 뒤 캐릭터 카드를 하나 선택하거나 임포트하면 채팅을 시작할 수 있습니다. 최소한 사용 가능한 AI API 하나가 필요하며, 모델 성능과 비용은 바인딩한 서비스에 따라 달라집니다. 앱에는 [완전한 Wiki](site/wiki/getting-started/overview.md)가 내장되어 있으며, [온라인 버전](https://beilusaiying.github.io/always-accompany/)도 볼 수 있습니다.

> 최초 실행은 보통 더 오래 걸립니다. 런타임이 의존성을 내려받고 로컬 데이터를 초기화해야 하기 때문입니다. 페이지가 완전히 나타난 뒤에 조작해 주세요. 이후 실행은 더 빨라집니다. 음성, 데스크톱 펫 등 선택적 기능은 각자 최초 다운로드나 환경 요구가 따로 있을 수 있습니다.

---

## 기능 개요

<table>
<tr>
<td width="33%">

**💬 채팅 / 롤플레이**
![채팅 인터페이스](imgs/screenshots/chat-interface-mode.png)

</td>
<td width="33%">

**🖥️ IDE 프로그래밍 모드**
![IDE 프로그래밍](imgs/screenshots/ide-coding.png)

</td>
<td width="33%">

**📊 Work 모드와 PPT**
![Work 모드 PPT](imgs/screenshots/work-ppt-mode.png)

</td>
</tr>
<tr>
<td width="33%">

**🐾 Live2D 데스크톱 펫 + 화면 인식**
![데스크톱 펫](imgs/screenshots/live2d-pet-mode.png)

</td>
<td width="33%">

**🔒 6단계 권한 템플릿 + 도구별 규칙**
![권한 설정](imgs/screenshots/ai-permissions.png)

</td>
<td width="33%">

**🗜️ 계층형 압축 × 항목별 제어**
![압축 메커니즘](imgs/screenshots/compression-detail.png)

</td>
</tr>
</table>

- **🧭 4대 메인 모드 + 보조 뷰**: Smart 완전 지능, Chat 채팅 / 롤플레이, Code 프로그래밍, Work 업무가 각각 독립된 기억 테이블과 P1 경로를 가집니다. 이 밖에 Bot 관리, 게임 동반, 기억 관리, ST 적응 등 보조 뷰가 있습니다.
- **🧠 Data(편집 가능한 구조화 기억 테이블) + 3계층 기억**: Data와 `hot / warm / cold` 일반 JSON / MD 파일이 각각 현재 사실, 최근 자료, 아카이브를 받아냅니다. 내용은 조회하고 편집할 수 있습니다.
- **🎯 P1(전치 기억 회상)**: 메인 AI가 응답하기 전에, 현재 캐릭터와 모드가 읽도록 허용한 장기 자료에서 관련 조각을 먼저 찾습니다. Chat / Code / Work는 현재 로컬 알고리즘 경로를 기본으로 사용하고, Smart / Bot 모드는 독립된 AI 검색 경로를 유지합니다. 두 경로는 상호 배타적이며, 끌 수도 있습니다.
- **🗜️ 컨텍스트 관리**: 메시지, 파일 읽기, 도구 결과, 시스템 주입별로 점유량을 조회합니다. 일반 정리는 내용을 숨겨 AI에 더 이상 보내지 않을 뿐이고, 기록은 여전히 디스크에 남아 복원할 수 있습니다.
- **📊 모드별 기억 테이블**: Chat에는 #0–#9 테이블이 있고, Code와 Work는 자기 테이블과 전용 디렉터리를 사용하여, 모든 상황을 하나의 테이블에 몰아넣지 않습니다.
- **👑 모든 프롬프트 편집 가능**: 내용, 순서, 스위치, system / user / assistant 신원, 주입 위치와 조건을 모두 조정할 수 있습니다.
- **💻 IDE급 워크플로**: 3단 레이아웃, 파일 읽기와 편집, 명령 실행, 작업 목록, 다중 창과 VS Code 확장 브리지.
- **🔌 MCP(외부 도구 연결 프로토콜)**: JSON을 붙여넣어 외부 도구에 연결합니다. 명령형 서비스는 owner 승인과 환경 변수 화이트리스트 등 보안 관문을 거쳐야 합니다.
- **🐾 데스크톱 펫과 게임 동반**: Live2D / 이미지팩, 세 가지 화면 인식 방식, 자발적 코멘트, 독립된 게임 동반 루프와 적응형 빈도.
- **🎙️ 로컬 음성 입력**: MOSS-Transcribe-Diarize 로컬 전사로 화자 분리와 타임스탬프를 지원합니다. 현재는 음성-텍스트 변환만 하며 AI 낭독은 포함하지 않습니다.
- **🤖 9개 플랫폼 Bot**: 현재 소스에는 Discord, Telegram, Slack, LINE, 페이슈(Feishu), 딩톡(DingTalk), 위챗(WeChat), 기업 위챗(WeCom), X 플랫폼 셸이 들어 있습니다. 각 플랫폼은 여전히 자체 요구에 따라 Token, Webhook 또는 서드파티 브리지를 설정해야 합니다.
- **🔎 선택적 시맨틱 벡터 검색**: beilu-vectordb(Orama 기반, 전문 / 벡터 / 하이브리드 검색 지원)를 내장했으며, 기본은 꺼져 있고 embedding 엔드포인트를 직접 설정한 뒤 켤 수 있습니다. 자율주행 P1과 상호 보완적이며, 둘 중 하나를 고르는 관계가 아닙니다.
- **🧩 플러그인 시스템**: 현재 소스에는 23개의 내장 플러그인 디렉터리가 있고, 신규 사용자 템플릿은 기본으로 14개를 나열합니다. Python, Node 또는 독립 프로그램으로 사용자 플러그인을 작성할 수도 있습니다.
- **🛡️ 로컬 데이터와 복원**: 애플리케이션 데이터는 로컬에 보관되며 숨김 복원, 회수, 백업 체인을 지원합니다. 원격 AI나 원격 embedding 서비스로 보낸 내용은 여전히 당신이 선택한 서비스의 데이터 정책의 제약을 받습니다.
- **🌐 다국어 · 🔬 화이트박스 진단 · 🎨 다양한 테마**: 핵심 중 / 영 / 일 / 번체 인터페이스 외에도 다른 커뮤니티 번역을 제공하며, 일부 저자원 언어는 완전하지 않을 수 있습니다.

---

## 우리가 정말 풀려는 것은?

기억 보관 자체는 신비롭지 않습니다. Data는 쓸 수 있는 표이고, `hot / warm / cold`는 쉽게 말해 "시간 + 사건"으로 폴더 세 개를 만들어 md를 적어 넣는 것입니다. INJ(편집 가능한 프롬프트 주입 항목)와 프리셋 역시 SillyTavern 등 캐릭터 프런트엔드가 오래 탐구해 온 프롬프트 편성 방식을 이어받았습니다.

하지만 이것들을 조합하고, 다시 P1(컨텍스트를 수집하고 기억을 검색하는 도구)을 더하면, "벡터 + 동적 주입 + 기억이 현재 작업을 따라 움직임"이라는 자연스러운 생태계가 됩니다 — 높은 어텐션, 높은 정보 밀도의 기억 저장소입니다. 여기에 파일 단위까지 이르는 우리의 압축을 더하면 전체 체인이 완성됩니다.

사실 처음에는 P1을 작은 AI로 별도 배포하려 했습니다. 그러나 진짜 문제는 보관한 뒤에 생겼습니다. 기억이 쌓일수록, 매 턴 두 번째 AI를 따로 띄워 뒤져야 한다면 속도와 비용이 버틸 만할까요? 작은 AI가 정말 빠짐없이 찾아낼까요? 꼭 유료 AI를 써야만 할까요? 기억할수록 반응이 느려지지는 않을까요?

일상으로 내려오면 익숙한 몇 가지 장면이 됩니다. 큰 프로젝트에서 AI에게 먼저 링크, 프레임워크, MD를 보게 한 뒤 작업을 맡기는데, 절반쯤 하다 보면 token이 곧 가득 차고, 한 번 압축하면 다시 훑어봐야 합니다 — 여러 agent가 함께 돌 때는 컨텍스트가 더더욱 재앙입니다. 긴 작업 중에 AI는 몇 줄만 바뀐 같은 파일을 반복해서 읽고, 컨텍스트는 점점 쌓여 터지는데 당신은 지울 수가 없습니다. 어떤 때는 새 프로젝트를 열려 했는데 AI가 이전의 오래된 프로젝트 기억에 그대로 고정되기도 합니다.

이것들은 근거 없는 가정이 아닙니다.

- [Issue #6](https://github.com/beilusaiying/always-accompany/issues/6)
- [Codex #35226](https://github.com/openai/codex/issues/35226) · [Claude Code #34556](https://github.com/anthropics/claude-code/issues/34556);
- [커뮤니티 논의](https://www.reddit.com/r/SillyTavernAI/comments/1q7p33c/how_longterm_memory_works_in_sillytavernai/);
- 웹 채팅 제품의 사용자들도 프로젝트 기억의 투명성과 프로젝트 간 간섭 문제를 제기하고 있습니다: [검색 투명성 요청](https://community.openai.com/t/feature-request-make-project-memory-transparent-searchable-and-user-controlled/1385159) · [프로젝트 전용 기억 요청](https://community.openai.com/t/project-specific-memory-in-chatgpt/1140856).


### 보관한 뒤, 어떻게 AI에게 출력하나

자체 개발한 **P1 전치 기억 회상**을 통해서입니다. P1은 먼저 사용자의 현재 대화를 중심으로 검색 단서를 확장한 뒤, 현재 캐릭터와 모드가 읽도록 허용한 장기 자료에서 관련 원문을 찾아 메인 AI에게 넘깁니다. 이것을 모델 밖에서 돌아가는 동적 어텐션 메커니즘으로 이해할 수 있습니다 — 현재 질문이 무엇을 찾을지 결정하고, 장기 자료가 후보를 제공하며, 이번 턴에 선택된 조각만 응답에 들어갑니다.

사용 측면에서 이것이 뜻하는 바는, 원래 문장을 그대로 되뇔 필요가 없다는 것입니다. 관련되지만 완전히 똑같지는 않은 한마디가 옛일을 다시 불러올 수도 있습니다. 회상 이후 인터페이스는 이번 턴에 실제로 어떤 기억을 사용했는지 보여 줍니다 — 당신이 검증하는 것은 기록 그 자체이지, AI의 "기억나요"라는 한마디가 아닙니다.

---

## 상세 메커니즘

<details>
<summary><strong>🧠 Data와 3계층 재귀 기억 — 왜 여전히 계층화하는가</strong></summary>

`hot / warm / cold`는 무엇보다 읽고 쓸 수 있는 생명주기 디렉터리이지, 신비로운 데이터베이스가 아닙니다.

```text
🔥 hot  — 최근·고빈도·현재 사용 중인 자료
🌤️ warm — 단계적 정리와 아카이브 자료
❄️ cold — 더 장기의 과거 자료
📊 Data — 현재 모드에서 편집 가능하고 검증 가능한 구조화 사실
```

계층화는 고정 주입, 필요 시 회상, 심층 아카이브에 서로 다른 비용과 용도를 부여합니다. 원본 자료는 일반 JSON / MD에 남아 있어 사용자가 직접 검사하고 고칠 수 있습니다. 그다음 P1이 이번 턴에 어느 계층에서 조각을 가져올지 결정합니다.

장문 컨텍스트 연구는 이미 위치 편향과, 작업이 복잡해진 뒤의 활용도 저하를 관찰했습니다: [Lost in the Middle](https://aclanthology.org/2024.tacl-1.9/) · [RULER](https://arxiv.org/abs/2404.06654) · [Found in the Middle](https://aclanthology.org/2024.findings-acl.890/). 이 논문들은 "넣을 수 있다"와 "안정적으로 쓸 수 있다"가 같은 일이 아님을 보여 주지만, 본 프로젝트의 방안이 더 낫다는 것을 직접 증명하지는 않습니다.

</details>

<details>
<summary><strong>🗜️ 컨텍스트 관리 — 통짜 압축에서 파일 읽기 단위 정리까지</strong></summary>

AI가 실제 작업을 수행하면 대량의 과정 콘텐츠가 생깁니다: 반복해서 읽은 파일, 낡은 도구 결과, 이미 소비된 명령 태그와 지난 메시지. always-accompany는 자동 압축, 유형별 정리, 항목별 선택을 함께 제공합니다. 기본 정리는 `_hidden` 표시를 사용해 기록은 디스크에 남기되 AI에는 더 이상 보내지 않습니다.

AI도 `<contextClean>`을 출력해 정리를 요청할 수 있습니다. 시스템은 사용자 원문을 보호하며, 최저 token 임계값을 설정해 컨텍스트가 아직 작을 때 프롬프트 캐시를 빈번히 깨뜨리는 것을 막을 수 있습니다. 영구적이거나 고위험 조작은 일반 숨김과 섞어 쓰면 안 됩니다.

| 다층 압축과 세분화 | 파일 읽기 단위 정리 |
|---|---|
| ![다층 압축 패널](imgs/screenshots/compression-multi.png) | ![파일 읽기 단위 정리](imgs/screenshots/context-file-cleanup.png) |

일반 사용자는 더 이상 필요 없는 파일 읽기나 메시지만 선택하면 됩니다. 더 깊이 제어하고 싶을 때 token 청구서, 유형, 시간, 출처를 살펴보면 됩니다.

</details>

<details>
<summary><strong>🔬 자율주행 P1 — 모델 밖의 동적 기억 어텐션 체인</strong></summary>

현재 프로덕션 체인은 Node0–4이며, 옛 문서의 21노드 서술이 아닙니다.

```text
Node0  현재 입력 + 최근 사용자 메시지 + 현재 모드 Data
  ↓
Node1  분사, 품사, 시간, 고유명사와 구절 앵커
  ↓
Node2  SWOW / ConceptNet / Cilin / ATOMIC / 도메인 어휘 등 연관 확장
  ↓
Node3  BLQ(자체 알고리즘) / NB300 / WordNet 등 다중 증거 신호 필터링
  ↓
Node4  Data, hot / warm / cold와 모드 기록으로 돌아가, BM25·시간·계층·Top·importance 등을 결합한 랭킹
  ↓
recalledRecords + directionWords + trace
```

연상어는 기억 사실이 아닙니다. 후보는 실제 기록 계층으로 돌아가야만 최종 회상 결과가 될 수 있습니다. 화이트박스 패널은 입력 유닛, 각 노드의 후보와 삭제 이유, 인덱스 상태, 최종 출처와 오류를 표시하여, "회상 안 됨"이 매칭이 없어서인지, 리소스 다운그레이드인지, 체인 실패인지 판단하기 쉽게 합니다.

![자율주행 P1 화이트박스 테스트](imgs/screenshots/p1-self-driven-diagnostics.png)

화이트박스 패널은 각 노드와 실제 출처를 모두 검사할 수 있음을 증명합니다. 회상 품질은 여전히 같은 코퍼스, 같은 작업, 정답이 달린 데이터 위에서 평가해야 합니다. 완전한 실행 경계는 [P1 현재 프로덕션 계약](site/wiki/p1-recall/ch7-current-runtime.md)을 참조하세요.

</details>

<details>
<summary><strong>👑 모든 프롬프트를 편집 가능 — 기본으로 바로 쓸 수 있고, 자신만의 AI로 계속 개조할 수도</strong></summary>

캐릭터 설정, 시스템 규칙, 모드 설명, 기억 데이터 슬롯, 도구 사용법 안내 등 프롬프트 항목은 모두 인터페이스에서 편집할 수 있습니다. 각 항목은 다음을 조정할 수 있습니다.

- 실제 문구
- 앞뒤 순서
- 활성화 여부
- system, user, assistant 중 어느 신원으로 보낼지
- 채팅 기록의 어느 위치에 삽입할지
- Chat, Code, Work, Bot 또는 지정한 조건에서만 적용할지

</details>

<details>
<summary><strong>🔒 AI는 행동할 수 있지만, 조작마다 각자의 경계가 있다</strong></summary>

파일 쓰기는 도구, 경로, 3상태 규칙에 따라 `deny / ask / allow`를 받습니다. 명령은 여기에 더해 블랙리스트, 그레이리스트, 원격 화이트리스트를 거칩니다. server 배포에서 민감한 설정과 자식 프로세스 능력은 owner가 켜야 합니다.

L0–L5는 엄격 통제부터 전면 개방까지의 단축 템플릿 묶음이며, 사용자는 구체적인 도구와 경로까지 더 세분화할 수 있습니다. L5는 승인을 건너뛰며 명백한 고위험 선택입니다. 작업 공간 펜스, 배포 모드, 각 플러그인 자체의 보안 관문은 여전히 독립적으로 이해해야 합니다.

![AI 편집 권한 세분화](imgs/screenshots/ai-permission-rules.png)

</details>

<details>
<summary><strong>🏗️ 시스템 아키텍처와 격리 경계</strong></summary>

always-accompany는 Deno 백엔드와 네이티브 웹 프런트엔드로 실행되며, Shell, Plugin, Service Generator와 yonban 기능 계층을 통해 능력을 조직합니다. 인터페이스 호출, 모드 라우팅, 파일 / 도구 실행, 영속화, 비동기 결과에는 각각 명확한 진입점이 있습니다.

| 경계 | 현재 작용 |
|---|---|
| 사용자 | 멀티 유저 / server 시나리오에서의 영속화 루트 경계 |
| 캐릭터 카드 | 서로 다른 캐릭터, 관계, 고객, 프로젝트가 서로 다른 기억 루트, 설정, 대화를 사용 |
| 모드 | Chat / Code / Work가 서로 다른 테이블, 전용 디렉터리, 프리셋 기록, P1 경로를 사용. 같은 캐릭터 카드의 공통 장기 자료는 여전히 공유될 수 있음 |
| 창 | 이번 턴의 입력, P1 후보와 결과, 작업 공간, 비동기 회신을 제약 |

</details>

<details>
<summary><strong>🔭 1M, 2M, 그리고 더 큰 컨텍스트 윈도우에 관하여</strong></summary>

더 큰 윈도우는 매우 가치 있지만, 용량, 어텐션, 비용, 작업 상태는 같은 일이 아닙니다. always-accompany가 계층화와 회상을 하는 것은, 주로 어텐션을 높이고 컨텍스트 안의 저장 방식을 최적화하기 위해서이며, 특히 지금의 대형 코드 프로젝트와 장기 채팅을 겨냥합니다.

아마 이런 경험이 있을 겁니다. 채팅이 길어지고 기억이 많아질수록 AI가 받는 것이 많아지지만, 반응과 기억이 오히려 뒤엉키고 느려지기 시작합니다. 코드를 쓸 때는 — 1M 컨텍스트를 준다 해도 큰 프로젝트는 곧바로 상한에 부딪힐 수 있습니다.

</details>

---

## 로드맵

**현재 저장소에 이미 갖춰진 진입점과 구현**: Data + 3계층 기억 · 컨텍스트 관리 · 자율주행 P1 / AI P1 · 전체 프롬프트 편집과 프리셋 전환 · 모드 기억 테이블 · 조건 지식 동적 주입 · Live2D / 이미지 데스크톱 펫 · 화면 인식과 게임 동반 · 로컬 음성 입력 · PPT 생성 · MCP · 다중 창 · VS Code 확장 브리지 · 9개 플랫폼 Bot · 23개 내장 플러그인 디렉터리 · 사용자 플러그인 호스트 · 회수 / 백업 체인 · 화이트박스 진단 · 다국어와 테마.

**단기 방향**: 더 많은 Bot 플랫폼 · 플러그인 생태계와 예제 · TTS / 텍스트-투-이미지 · AI 게임 엔진(결정론적 수치 상태 + LLM 내러티브 + 상징적 렌더링)

---

## 기술 스택

Deno 런타임(Node.js 호환) · Express 스타일 라우팅 · 네이티브 JavaScript / ESM 프런트엔드 · WebSocket · JSON / MD 로컬 저장 · Electron 데스크톱 펫 · Python 선택 서비스(P1 리소스, STT, PPT) · discord.js v14 · VS Code 확장 브리지.

아키텍처 설명은 [시스템 아키텍처](site/wiki/developer/architecture.md)를, 메시지·도구·권한 체인은 [YonBan 도구 체계](site/wiki/yonban/tools.md)와 [승인 메커니즘](site/wiki/yonban/approval.md)을 참조하세요.

---

## 커뮤니티

<a href="https://discord.gg/agHeDq9bqU"><img src="https://img.shields.io/badge/Discord-지금_참여-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord"></a>

캐릭터 카드 공유 · 프리셋과 조건 지식 배포 · 플러그인 기여 · 버그 제보 · 실제 사용 사례 제안 · benchmark 참여 · 코드 기여.

---

## 사용한 기술과 리소스

- **음성 전사**: [MOSS-Transcribe-Diarize](https://huggingface.co/ICTNLP/MOSS-Transcribe-Diarize)(로컬 배포, 모델 약 1.8 GB, 최초 사용 시 별도 다운로드)
- **단어 벡터**: [ConceptNet Numberbatch](https://github.com/commonsense/conceptnet-numberbatch)(Speer & Lowry-Duda, 2017)
- **연상 데이터**: [SWOW(Small World of Words)](https://smallworldofwords.org/) 중국어 연상 데이터
- **분사와 사전**: THUOCL, CoreNatureDictionary, Chinese-Synonyms 등 공개 리소스
- **검색 엔진 브리지**: [ddgs](https://pypi.org/project/ddgs/)(검색 요청과 결과 획득에 사용)

## 감사의 말

- **[fount](https://github.com/steve02081504/fount)** — 프로젝트 초기의 참조 프레임워크로, AI 메시지 처리, 서비스 소스 관리, 모듈 로딩 등 인프라 아이디어를 제공하여 많은 로우레벨 개발 시간을 아껴 주었습니다.
- **[SillyTavern](https://github.com/SillyTavern/SillyTavern)** — AI 롤플레이와 프롬프트 생태계의 중요한 선구자입니다. always-accompany는 그 캐릭터 카드, 프리셋, 월드북 등 커뮤니티 포맷의 임포트를 지원합니다.
- **SillyTavern 플러그인 커뮤니티와 모든 오픈소스 리소스 제작자** — 렌더링, 캐릭터, 확장, 검색, 툴체인에서의 탐구와 공유에 감사드립니다.

## 왜 이 프로젝트를 만들었나

> 본 프로젝트의 설계, 아키텍처, 개발은 취업을 원하는 어느 집돌이(먼산)가 완성했으며, AI 보조 프로그래밍의 도움을 받아 알고리즘 설계, 생체모방 아이디어, 프레임워크 아키텍처, 논리적 사고를 결합했습니다.

always-accompany는 인기 기능을 한 메뉴에 욱여넣기 위한 것이 아닙니다 — 처음에는 그저 작성자 자신이 쓰고 싶었을 뿐입니다 :). 물론, 실제로 완전한 플러그인·프레임워크 체계를 갖추고 있고 여러 언어와 호환됩니다.

---

<details>
<summary><strong>📸 더 많은 기능 스크린샷(클릭하여 펼치기)</strong></summary>

| | | |
|---|---|---|
| ![PPT 상세](imgs/screenshots/ppt-detail.png) **PPT 전 과정** | ![보안 설정](imgs/screenshots/security-settings.png) **보안과 작업 흐름** | ![보안 센터](imgs/screenshots/security-center.png) **보안 방어 센터** |
| ![다국어](imgs/screenshots/i18n-support.png) **다국어 지원** | ![CSS 테마](imgs/screenshots/css-themes.png) **다양한 테마** | ![Wiki](imgs/screenshots/wiki-guide.png) **내장 Wiki** |
| ![서브모드](imgs/screenshots/sub-mode-agent.png) **서브모드 워크플로** | ![메뉴](imgs/screenshots/hamburger-menu.png) **컨텍스트 한눈에 보기** | ![Loop](imgs/screenshots/auto-loop.png) **자동 / 예약 Loop** |
| ![도구 감지](imgs/screenshots/tool-detection.png) **환경 감지** | ![기억 계층](imgs/screenshots/memory-data-layers.png) **기억 파일 구조** | ![확장](imgs/screenshots/browser-automation.png) **브라우저 자동화** |
| ![외부 인터페이스](imgs/screenshots/external-interface.png) **외부 인터페이스** | | |

</details>
