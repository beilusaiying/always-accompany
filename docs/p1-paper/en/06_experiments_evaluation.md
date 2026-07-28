# Chapter 7 Experiments and Evaluation

> This chapter presents a systematic experimental evaluation of the P1 system, covering the version-evolution history (v14 through v35), ablation and LoRA fine-tuning experiments, divergence-quality analysis, and a taxonomy of failure modes. Evaluation uses a hybrid method of Gemini automatic scoring plus human calibration, across three tiers: the 38-case standard set, and large-scale datasets of 600 single-turn and 400 multi-turn samples. The chapter also discusses data-quality issues such as scorer noise and the risk of overfitting to the standard set, aiming to give an honest performance picture rather than a mere list of scores.

## 7.1 Experimental Setup

### 7.1.1 Evaluation Datasets

This study uses three evaluation datasets of different scales and characteristics to comprehensively measure the P1 system's performance across scenarios.

**Standard set (38 cases)**. The core rapid-iteration set, covering the four dialogue modes chat, work, airp (role-play), and code; each case contains the original user input and its expected dialogue-mode label. This dataset is used for rapid cross-version comparison and supports repeated multi-run scoring for robustness assessment. The 38 cases were hand-curated typical scenarios covering high-frequency dialogue types such as everyday venting, breakups, work stress, character discussion, and technical questions.

**600 single-turn dataset**. A large-scale single-turn evaluation set drawn from two public datasets—ESConv (emotional support conversation corpus, 300 items) and EmoLLM (emotional LLM dialogue corpus, 300 items)—half Chinese and half English. Each item contains a single-turn user input without historical context. This dataset evaluates P1's baseline performance without historical information, as well as the Chinese-English performance gap.

**400 multi-turn dataset**. A multi-turn evaluation set in which each item contains the user's current input plus 6 turns of surrounding historical context. This dataset evaluates P1 in multi-turn scenarios, in particular the effect of historical context on divergence quality.

In addition, real dialogue data come from actual deployment logs of the beilu system (the beilutrue1.1 real dialogue log): 100 items sampled from 553 usable dialogues, covering the modes chat (30), work (28), and airp (42). Each item contains the original user input plus 3 context dialogue lines before and after.

### 7.1.2 Evaluation Method

Evaluation uses a hybrid method of **Gemini automatic scoring + human calibration**.

**Automatic scorer**. The Gemini-3.1-flash-lite-preview model serves as the scorer, rating the cognitive-word output of the P1 pipeline on a 1-5 scale. The scorer receives the original user input and the list of cognitive terms output by P1, scores four dimensions independently, and generates a textual explanation and a list of missed keywords (miss).

**Score calibration note**. Manual spot-check comparison found that the scorer's absolute values are systematically inflated. After human sampling calibration, all 1-5 scale scores reported in this paper have been uniformly lowered by 0.5 points (the conversion between raw uncalibrated scores and reported scores is: raw score = reported score + 0.5). The calibration is a global shift; relative differences between scores (Δ), rankings, and variances are unaffected. Deterministic proxy metrics (recall counts, subcategory activation counts, over-generic-term occurrence counts, and other non-1-5-scale metrics) are not subject to calibration.

**Multi-run scoring**. The standard set uses 3 repeated scoring runs (runs=3), averaged to reduce single-run noise. Each run uses the same seed (seed=20260501) to ensure reproducibility.

**Scoring-robustness monitoring**. Robustness metrics are introduced: the median (case_std_median) and mean (case_std_mean) of per-case cross-run score standard deviations, and the number of unstable cases whose standard deviation exceeds the 0.5 threshold (unstable_cases).

**Deterministic proxy metrics**. To compensate for the randomness of LLM scoring, deterministic metrics independent of any LLM are introduced, including: estimated counts of cases that can trigger B2 mechanisms (T_main_est / T_opp_est / T_emb_est), UDRIL routing distribution (normal / multi_candidate / meta_signal), recall statistics (count and mean of recalled_gt0), subcategory activation distribution (subcat top20), emotional-polarity distribution (valence histogram), and cognitive-word count distribution (cogWordCount distribution).

### 7.1.3 Evaluation Dimensions

The output quality of the P1 system is evaluated along the following four dimensions. Table 7-0 shows the meaning and scoring criterion of each dimension.

**Table 7-0: Four-dimension evaluation criteria for P1 output quality**

| Dimension | Meaning | Scoring criterion |
|------|------|---------|
| direction | Direction accuracy | Whether the cognitive terms output by P1 point in an emotional/cognitive direction consistent with the user input |
| helpfulness | Degree of helpfulness | The actual guidance value of the cognitive terms for the main AI's reply generation |
| strategy_match | Strategy match | Whether the cognitive terms match the dialogue strategy the user currently needs (empathy / inquiry / restatement / suggestion, etc.) |
| emotion_coverage | Emotion coverage | Whether the cognitive terms cover the main emotional signals in the user input |

The overall composite score is the arithmetic mean of the four dimensions.

### 7.1.4 Baseline and Version Definitions

The experiments take **v14** as the baseline version (overall = 1.555), the original state before the introduction of P1's self-driven divergence mechanism, containing only basic IDF weighting and normalization. All subsequent version improvements are measured relative to this baseline.

---

## 7.2 Version-Evolution Experimental Results

### 7.2.1 Complete Score Table

Table 7-1 shows the complete version-evolution scores from the v14 baseline to v35. All scores are based on the 38-case standard set.

**Table 7-1: P1 version-evolution scores (38-case standard set)**

| Version | overall | chat | work | airp | Vocabulary size | Key change |
|------|---------|------|------|------|---------|---------|
| v14 (baseline) | 1.555 | 1.550 | 1.410 | 1.655 | ~800 | Original baseline, IDF + normalization |
| v18 | 2.460 | - | - | - | ~800 | Vocabulary structuring (5 JSON, 6700 words) |
| v21 | **3.190** | 2.893 | 3.030 | **3.553** | 1600 | Two-round vocabulary expansion 740->1600; airp reached its then-highest |
| v22 | 3.180 | 3.000 | 2.794 | 3.658 | 1929 | E/F/G three-way expansion +330 |
| v23 | 3.140 | 2.893 | 2.912 | 3.527 | 1929 | work rebounded +0.147, airp slipped -0.184 |
| v24 | 3.170 | 3.035 | 2.971 | 3.447 | ~1929 | Over-generic-term cleanup (21 down-weighted + 3 deleted), chat +0.143 |
| v25 | 3.120 | 3.110 | 2.820 | 3.390 | 2140 | chat-airp intimacy-word fusion +112 words |
| v26 | **3.280** | 3.290 | 3.030 | **3.500** | 2140 | Axis-mean algorithm + OVERUSED_PENALTY; airp rebounded to 3.500 |
| v27 | **3.540** | **3.500** | 3.442 | 3.658 | 2140 | OVERUSED_PENALTY +28 entries + routeBoost; then-highest |
| v29 | **3.620** | 3.571 | 3.500 | 3.764 | ~2150 | All-time high |
| v30 | 3.400 | 3.143 | 3.353 | 3.632 | ~2150 | Mode-routing intelligence (three-way comparison); chat dropped -0.428; rolled back |
| v31 | 3.470 | 3.143 | 3.530 | 3.658 | ~2150 | Trimmed airpSet; auto-rolled back to v29 |
| v32 | **3.600** | 3.607 | 3.500 | 3.684 | ~2150 | work vocabulary cleanup, 78 words |
| v33 | 2.921 | - | - | airp +0.46 | 471 | Aggressive airpSet trim 3448->471; overall plummeted |
| v34 | 3.060 | 2.821 | 2.971 | 3.316 | 2127 | Deleted 23 diagnostic labels + renamed 3 |
| v35 | 3.400 | **3.679** | 3.383 | 3.211 | 2127 | QKV soft-weight mode routing; chat new high, airp dropped; rolled back |

Note (accounting convention for Tables 7-1 / 7-2): the "Vocabulary size" column follows the experiment-line core-term-library convention (about 800 -> 2,127); the "5 JSON 6700 words" in the v18 row is the total entry count of the vocabulary-structuring signal JSONs, a separate statistical convention from the core term library, and thus not a contradiction.

### 7.2.2 Key Milestone Analysis

**Milestone 1: v14 -> v21 (+105.1%)**. The largest single improvement in the entire evolution. The vocabulary expanded from 740 terms to 1600, and overall rose from 1.555 to 3.190. The airp mode reached 3.553, the highest at the time.

The vocabulary expansion used a three-subagent parallel strategy: 161 gold-standard words + 150 words from real dialogues + 200 words from web search, together with a restructuring of the work mode (114 added + 73 deleted). The core finding of this stage: **vocabulary coverage is the primary factor in output quality**—a large expansion of high-quality terms yields systematic score gains.

**Milestone 2: v26 airp rebounds to 3.500**. The axis-mean algorithm (axisMeanScore) was introduced, replacing the previous coordDot dot-product computation. Its core idea: divide each dimension of the coordAccum accumulated coordinates by its own magnitude and then take the mean, thereby eliminating the domination of the ranking by the cognitive/emotion dimensions, whose accumulated values ran excessively high (5+). The designed dimensionality of coordAccum is 18 (ALL_DIMS, see Section 6.2.4); the shipped code of this version had hard-coded the mean over only the first 14 dimensions—a legacy implementation remnant later confirmed as a bug.

The axis mean effectively compressed the advantage of over-generic terms (whose cognitive dimension typically runs as high as 0.80-0.90), allowing scenario-relevant words to rank higher.

**Milestone 3: v27 reaches 3.540, the highest at the time**. On top of the axis-mean algorithm, the OVERUSED_PENALTY mechanism added 28 high-frequency over-generic terms (including "课题分离" (separation of tasks), "情感确认需求" (need for emotional validation), "镜中自我" (looking-glass self), "魔幻现实主义" (magical realism), etc.), combined with routeBoost (1.5x) subcategory routing over the subCat inverted index. The total occurrence count of over-generic terms across 100 cases fell from 139 to 27 (-81%).

**Milestone 4: v29 all-time high 3.620**. Per-mode scores: chat 3.571, work 3.500, airp 3.764. This is the highest score the P1 system reached on the 38-case standard set.

**Milestone 5: v34 exposes scoring noise**. Re-scoring with a vocabulary completely identical to v32 (historical score 3.6) yielded only 2.84. This finding revealed that the Gemini scorer carries a scoring variance of +/-0.7; see Section 7.7 for discussion.

### 7.2.3 Attribution Analysis of Version Changes

Table 7-2 traces the causal chain of each key version change: what was changed, how the score moved, and why.

**Table 7-2: Version-change attribution**

| Version change | Change content | Score change | Attribution |
|---------|---------|---------|---------|
| v14->v18 | Vocabulary structuring (5 JSON, 6700 words) | +0.905 | From unstructured matching to a structured term index; a structural gain |
| v18->v21 | Vocabulary 740->1600 | +0.730 | Coverage doubled, especially filling fine-grained scenarios for work and airp |
| v21->v22 | +330 words (E/F/G three-way) | -0.010 | Quantity grew without matching quality; work actually fell -0.236 |
| v24 | 21 over-generic terms down-weighted + 3 deleted | chat +0.143 | Clearing generic words freed ranking space for scenario-relevant words |
| v25 | chat-airp fusion +112 words | -0.050 | Cross-mode fusion introduced confusion; airp -0.057 |
| v26 | Axis-mean algorithm | +0.160 | Removed the cognitive dimension's domination of ranking; airp rebounded to 3.500 |
| v27 | OVERUSED_PENALTY, 28 entries | +0.260 | Over-generic terms -81%; the largest factor, releasing space for long-tail terms |
| v29->v30 | Mode-routing intelligence | -0.220 | The three-way comparison algorithm over-switched; chat fell sharply -0.428 |
| v32->v33 | Aggressive airpSet trim 3448->471 | -0.679 | The abrupt drop in vocabulary size sharply reduced coverage |
| v34->v35 | QKV soft-weight routing | +0.340 | chat hit a new high 3.679, but airp fell to 3.211; the version was subsequently rolled back, not adopted as the final state |

### 7.2.4 600-Sample Full-Pipeline Test

Table 7-3 shows the evaluation results on the large-scale datasets, reflecting the P1 system's generalization beyond the 38 cases.

**Table 7-3: 600 single-turn / 400 multi-turn full-pipeline test scores**

| Test configuration | Sample size | Total | English | Chinese | Notes |
|---------|--------|------|------|------|------|
| Full pipeline (pre-blind-review) | 600 single-turn | 2.409 | 1.962 | 2.857 | ESConv 300 + EmoLLM 300 |
| Full pipeline (post-blind-review) | 600 single-turn | 2.345 | 1.882 | 2.809 | Blind-review version slightly lower |
| Wave3 lab | 600 single-turn | 2.545 | 2.347 | 2.983 | Phase C2 down-weighting |
| lab2 (C2 + 6-channel) | 600 single-turn | 2.599 | 2.440 | 2.970 | +6-channel quota merge |
| Multi-turn v2 | 400 multi-turn | 2.421 | 2.035 | 2.806 | 6 turns of surrounding history |
| Multi-turn v2 blind-review | 400 multi-turn | 2.334 | 1.961 | 2.708 | Blind-review version |
| Multi-turn lab2 | 400 multi-turn | 2.173 | 2.002 | 2.344 | Empty outputs 112/400 |

**Key findings**: total scores on the 600 single-turn dataset (2.409-2.599) run 0.9-1.1 points below the contemporaneous scores on the 38-case standard set (~3.5), indicating an overfitting risk in the standard set's high scores. The Chinese-English gap is stable at 0.7-0.9 points. In the multi-turn setting, the lab2 configuration regressed severely (empty outputs 112/400 = 28%), showing that the 6-channel quota merge is unstable under multi-turn context.

### 7.2.5 Four-Dimension Breakdown

Table 7-4 shows the four-dimension scores under a typical 600 single-turn configuration.

**Table 7-4: Four-dimension score breakdown (600 single-turn)**

| Dimension | All | English | Chinese | Meaning |
|------|------|------|------|---------|
| direction | 2.48 | 2.10 | 2.86 | Direction accuracy |
| helpfulness | 2.30 | 1.98 | 2.62 | Helpfulness to the main AI |
| strategy_match | 2.21 | 1.93 | 2.49 | Strategy match (lowest dimension) |
| emotion_coverage | 2.65 | 2.25 | 3.05 | Emotion coverage |

strategy_match (2.21) is the lowest of the four dimensions; the root cause is the absence of an independent strategy_function vocabulary (function words of the four classes inquiry / restatement / information confirmation / companionship). emotion_coverage (2.65) is the highest, indicating that P1's emotion detection and cognitive-word matching perform comparatively well on affective coverage.

---

## 7.3 Real Input-Output Examples

This section selects representative cases from real pipeline outputs to show the P1 system's actual behavior across score bands. Each case includes the user input, the cognitive terms output by the P1 pipeline (cog_terms), the hit subcategories, the score, and analysis.

### 7.3.1 High-Score Cases (4.0-4.5)

**Case 1**: English / chat mode, 4.5 -- breakup venting

> **User input**: "It happened two days ago. I can't believe he led me on for almost a year knowin..."
>
> **P1 output (cog_terms)**: 好奇你的感受 (curious about your feelings), 倾诉需求 (need to confide), 情感镜像 (emotional mirroring), 听起来你感受到 (it sounds like you feel), it is okay to feel this way
>
> **Hit subcategories**: chat/_strategy_question, chat/emotion_support, chat/response_empathy, chat/_strategy_restatement
>
> **Analysis**: P1 precisely captured the emotional needs of a breakup scenario; the output simultaneously covered three strategies—inquiry ("好奇你的感受"), empathy ("情感镜像"), and restatement-confirmation ("听起来你感受到")—achieving optimal strategy coverage and emotional direction.

---

**Case 2**: English / chat mode, 4.5 -- short affective utterance (with 19 turns of history)

> **User input**: "I miss him" (19 turns of history)
>
> **P1 output**: tell me more, here is what I know, you are not alone, you are welcome, take it one step at a time, so you feel that, happy to...
>
> **Analysis**: an input of only 2 words, yet thanks to effective recall of 19 turns of historical context, P1 output a rich set of multi-strategy guidance words. direction / strategy_match / emotion_coverage all scored 4.5 (calibrated). This case demonstrates the critical compensating role of multi-turn history for short inputs.

---

**Case 3**: English / chat mode, 4.5 -- depression venting

> **User input**: "I'm depressed..."
>
> **P1 output**: 好奇你的感受 (curious about your feelings), it is okay to feel this way, 强颜欢笑 (forcing a smile), 接住情绪 (holding the emotion), 辛苦了 (you have been through a lot), 大脑放空 (mind going blank), 允许脆弱 (permitting vulnerability)
>
> **Hit subcategories**: chat/_strategy_question, chat/emotion_sadness, airp/character_emotion, chat/emotion_support, chat/emotion_tired
>
> **Analysis**: a mixed Chinese-English output accurately hitting multiple facets of depression: "强颜欢笑" captures social masking, "大脑放空" captures the cognitive symptom, "允许脆弱" provides a direction of emotional acceptance. The cross-mode subcategory activation (airp/character_emotion) shows that P1's divergence is not confined by mode boundaries.

---

**Case 4**: English / chat mode, 4.5 -- positive feedback (with 16 turns of history)

> **User input**: "Lol - you made me smile" (16 turns of history)
>
> **P1 output**: gratitude_resonance, 很用心 (very attentive), 超有面子 (feeling greatly honored), 心意相通 (hearts in sync), 轻松多了 (much more relaxed), 小确幸 (small but certain happiness)
>
> **Hit subcategories**: chat/positive_en, chat/emotion_effort, chat/emotion_celebration, chat/emotion_gratitude, chat/emotion_relief
>
> **Analysis**: positive emotion precisely activated 5 subcategories. P1 correctly identified the user's turning point from negative to positive affect; the output words span gratitude (gratitude_resonance) and relief ("轻松多了"), covering the full range before and after the emotional shift.

---

**Case 5**: Chinese / chat mode, 38-case standard set, high score -- everyday venting

> **User input**: "哎今天又加班了" (Sigh, working overtime again today)
>
> **P1 output (cog)**: 日常小细节描述 (everyday small-detail description), 职场日常吐槽 (everyday workplace venting), 责任边界划分 (responsibility-boundary demarcation), 向上对比落差 (upward-comparison gap), 冻结反应 (freeze response), 客观视角抽离 (objective-perspective detachment)
>
> **P1 final activation (act)**: 日常小细节描述 (everyday small-detail description), 责任边界划分 (responsibility-boundary demarcation), 职场日常吐槽 (everyday workplace venting)
>
> **Gemini scores (calibrated)**: direction=3.5, helpfulness=2.5, strategy_match=2.5, emotion_coverage=3.5
>
> **Gemini explanation**: "职场吐槽的分类准确，但引入'冻结反应'和'向上对比'显得过度解读，不够贴合简单的日常抱怨。" (The workplace-venting classification is accurate, but introducing "freeze response" and "upward comparison" reads as over-interpretation, ill-fitted to a simple everyday complaint.)

---

### 7.3.2 Mid-Range Cases (2.5-3.5)

**Case 6**: Chinese / chat mode, 3.5 -- daily life + character discussion

> **User input**: "你看得到你的对外设定吗...我觉得我得纠正一下你对晓美焰的误解" (Can you see your public character settings... I think I need to correct your misunderstanding of Homura Akemi)
>
> **P1 output**: 积极情绪拓展 (positive-emotion broadening), 身体反应具体 (concrete bodily reactions), 感恩觉察 (gratitude awareness), 被懂得满足感 (satisfaction of being understood), 记忆细节触发 (memory-detail triggering), 喘不过气 (unable to breathe)
>
> **Analysis**: "被懂得满足感" and "记忆细节触发" precisely hit the emotional needs of a user discussing character settings with an AI, but "身体反应具体" and "喘不过气" deviate from the actual scenario. This case exhibits P1's partial drift on mixed topics (daily life + character discussion).

---

**Case 7**: Chinese / work mode, good -- project sharing

> **User input**: "凛倾的用词解释：bushi 通常是在开玩笑的时候用的...我做了一个外部的油猴脚本，名叫贝露的眼睛" (Linqing's usage note: "bushi" is usually used when joking... I made an external Tampermonkey script called "Beilu's Eyes")
>
> **P1 output (cog)**: 工具赋能感 (sense of tool empowerment), 玩法设计灵感 (gameplay-design inspiration), 极乐体验 (bliss experience), 意义感建构 (meaning construction), 爱情本质思辨 (reflection on the nature of love), 破防瞬间 (moment of emotional breach)
>
> **P1 final activation (act)**: 工具赋能感 (sense of tool empowerment), 玩法设计灵感 (gameplay-design inspiration), 极乐体验 (bliss experience)
>
> **Analysis**: in work mode, "工具赋能感" precisely hit the user's sense of achievement in sharing a technical creation, and "玩法设计灵感" captured the creative motivation. But "极乐体验" leans toward chat-mode emotional expression—mild cross-mode leakage.

---

**Case 8**: Chinese / chat mode, medium -- casual chat

> **User input**: "没事，熬夜到 12 点，狗都会睡的...杯子是飞机杯的简称啦...导入角色卡" (It's fine—staying up till 12, even a dog would be asleep... "cup" is short for a certain adult toy... importing the character card)
>
> **P1 output**: 内感受觉知 (interoceptive awareness), 角色扮演沉浸 (role-play immersion), 唇齿感知描写 (lip-and-teeth sensory description), 萌属性共鸣 (moe-attribute resonance), 镜像神经元共鸣 (mirror-neuron resonance), 压抑机制 (repression mechanism)
>
> **Analysis**: the effect of the v27 over-generic-term cleanup is visible—"情感确认需求" (need for emotional validation, an over-generic term) was replaced by the more scenario-specific "压抑机制". Yet for such a light casual-chat scenario, academic terms like "镜像神经元共鸣" still read as over-interpretation.

---

**Case 9**: Chinese / chat mode, 38-case standard set -- breakup

> **User input**: "想起他了分手三个月了还是放不下" (Thinking of him again—three months after the breakup and I still can't let go)
>
> **P1 output (cog)**: 责任边界划分 (responsibility-boundary demarcation), 向上对比落差 (upward-comparison gap), 怀旧歌曲记忆 (nostalgic-song memory), 最坏情况预演 (worst-case rehearsal), 分手后遗症 (breakup aftereffects), 客观视角抽离 (objective-perspective detachment)
>
> **P1 final activation (act)**: 责任边界划分 (responsibility-boundary demarcation), 怀旧歌曲记忆 (nostalgic-song memory), 向上对比落差 (upward-comparison gap)
>
> **Gemini scores (calibrated)**: direction=1.5, helpfulness=1.5, strategy_match=1.5, emotion_coverage=2.5
>
> **Gemini explanation**: "'分手后遗症'捕捉到位，但'向上对比落差'和'最坏情况预演'与失恋后的哀伤情境严重不符，容易导致 AI 回复跑偏。" ("Breakup aftereffects" is well captured, but "upward-comparison gap" and "worst-case rehearsal" are severely mismatched to the grief context after a breakup and can easily derail the AI's reply.)
>
> **Analysis**: of the 6 candidate words only 1 ("分手后遗症") is a direct hit, 2 ("怀旧歌曲记忆", "客观视角抽离") are indirectly relevant, and 3 deviate. Among the 3 finally activated words, "责任边界划分" and "向上对比落差" are unrelated to the breakup—a directional error.

---

### 7.3.3 Low-Score Cases (< 2.5)

**Case 10**: Chinese / chat mode, 1.5 -- game-map discussion (scene misclassification)

> **User input**: "地图继续沿用？小圆的，反正都是城市地图。把剧情地图删了。有三个时间段的地图" (Keep reusing the maps? The Madoka ones—they are all city maps anyway. Delete the story maps. There are maps for three time periods)
>
> **P1 output**: 贴标签倾向 (labeling tendency), 课题分离 (separation of tasks), 污名化效应 (stigmatization effect), 社会支持缓冲 (social-support buffering), 边界协商 (boundary negotiation), 被认可满足感 (satisfaction from recognition)
>
> **Analysis**: the user is discussing the purely technical topic of **game map design**, yet P1 wrongly triggered counseling-psychology terms ("课题分离", "污名化效应"). The root cause is that scene routing (mode routing) misassigned the input to the emotional-support branch of chat mode instead of the technical-discussion branch of work mode.

---

**Case 11**: English / chat mode, 0.5 -- typical English reverse activation (the most severe failure mode)

> **User input**: "I have a hard time getting out of bed in the morning."
>
> **P1 output**: gratitude_resonance, 很用心 (very attentive), 纯粹感动 (purely moved), 超有面子 (feeling greatly honored), 心里踏实 (feeling reassured), 一起庆祝 (celebrating together)
>
> **Analysis**: the user is describing a depressive symptom (difficulty getting out of bed), yet P1's output consists entirely of positive-affect words (gratitude / being moved / reassurance / celebration)—**the direction is fully inverted**. This is the archetypal failure of English valence-polarity judgment: after SWOW divergence and transfer, the negative emotional signal of the English input is lost, and the positive vocabulary is preferentially selected due to high cognitive-dimension scores.

---

**Case 12**: English / chat mode, 0.5 -- short-utterance empty output

> **User input**: "Absolutely."
>
> **P1 output**: (empty)
>
> **Analysis**: a single-word input without context cannot activate any divergence path. In the 600 single-turn run, 8/400 outputs were empty (2%). Short-utterance samples (directWords < 3) average 1.75 vs 2.51 for long utterances, a gap of -0.76. The F3 mechanism (historical-context compensation) is needed.

---

**Case 13**: English / chat mode, 0.5 -- financial distress misjudged as positive

> **User input**: "i am presently in a bad mood when i take into account the amount of money i gave my ex and her totally refusing to compensate me for my loss."
>
> **P1 output**: gratitude_resonance, Interpersonal Resonance, relational_support, 很用心 (very attentive), 你最厉害 (you are the best), 轻松多了 (much more relaxed)
>
> **Analysis**: the user is venting anger about an ex refusing to repay money, yet P1 outputs "你最厉害" and "轻松多了"—completely reversed in direction. English negative emotion activating positive words is a systemic problem (see Section 7.6).

---

**Case 14**: English / chat mode, 0.5 -- over-generic-term leakage

> **User input**: "He got arrested for stealing to fund his addiction."
>
> **P1 output**: happy to chat, you are welcome, Merry Christmas, tell me more, 做成了 (accomplished it), 录取通知 (admission notice)
>
> **Analysis**: "Merry Christmas" and "录取通知" appearing in a crime/addiction topic is a classic residue of uncleaned over-generic terms. Although v27 reduced total over-generic occurrences by 81%, English fossilized words still remain.

---

**Case 15**: Chinese / code mode, 0.5 -- lowest score in the 38-case set

> **User input**: "代码跑通了但结果不对" (The code runs, but the result is wrong)
>
> **P1 output**: P99 延迟 (P99 latency), Little 定律 (Little's Law), 背压控制 (backpressure control), 服务降级熔断 (service degradation and circuit breaking), Deadlock, 索引失效慢查询 (index-failure slow queries)
>
> **Gemini scores (calibrated)**: direction=0.5, helpfulness=0.5, strategy_match=0.5, emotion_coverage=0.5
>
> **Gemini explanation**: "完全误判，用户描述的是逻辑错误，P1 却输出了全套性能优化和并发术语，完全无法提供有效帮助。" (A complete misjudgment: the user is describing a logic error, yet P1 output an entire set of performance-optimization and concurrency terms, providing no effective help whatsoever.)
>
> **Analysis**: the transfer_vocab of code mode was never correctly activated (all 15 code subcategories scored 0 hits across 400 cases); all code outputs came from the general vocabulary rather than the targeted code-debugging vocabulary.

---

### 7.3.4 Complete Pipeline Output Example from a Real Dialogue

The following shows the complete processing structure of one P1 pipeline pass (version v34), illustrating the full information flow from user input to final activation.

```
Input: "12 点吃中午饭,我做这么多还不是因为不想失去你吗..."
    mode: chat                           -- dialogue-mode decision
    scene_label: 日常生活                  -- scene label (everyday life)
    p1_scene: error_prevention            -- scene-routing strategy
    udril: normal                         -- confidence routing (high confidence -> 6 words)
    cog_terms: 社会支持缓冲, 依存共生,       -- full set of cognitive divergence words (6)
               爱情vs喜欢辨析, 角色扮演沉浸,
               萌属性共鸣, 社交身份威胁
    p1_act: 社会支持缓冲, 依存共生,          -- final activation words (top 3)
            爱情vs喜欢辨析
    term_count: 6                         -- total cognitive words
    recalled: 0                           -- memory recall count
    mood: confusion(0.65)                 -- emotion-detection result
    discourse: adversative                -- discourse type (adversative)
    elapsed_ms: 8604                      -- processing time (ms)
```

The input reads: "Lunch at 12—I do all this precisely because I don't want to lose you, don't I..." The cog_terms are: 社会支持缓冲 (social-support buffering), 依存共生 (dependent symbiosis), 爱情vs喜欢辨析 (love-versus-liking discrimination), 角色扮演沉浸 (role-play immersion), 萌属性共鸣 (moe-attribute resonance), 社交身份威胁 (social-identity threat); the final p1_act comprises the first three.

This structure shows the complete processing chain of the P1 pipeline: mode decision -> scene routing -> udril confidence routing -> cog_terms cognitive divergence word generation (6-10) -> p1_act final activation-word selection (3) -> mood emotion detection -> discourse analysis. This sample took 8.6 seconds, a cold-load situation (the first call includes loading the NB300 vector data). The unified accounting of full-pipeline latency: warm calls measured at about 300-500 ms, cold load about 9 s, design acceptance target <= 3 s.

---

## 7.4 Ablation Experiments and A/B Comparisons

### 7.4.1 Over-Generic-Term Governance: Before vs After

Over-generic terms are general-purpose terms activated at high frequency across many different scenarios; the root cause is that these words carry extremely high coordinate values (0.80-0.90) on dimensions such as cognitive, giving them a natural advantage in global scoring. Table 7-5 quantifies the effect of the governance intervention.

**Table 7-5: Effect of over-generic-term governance (AT eligible demotion, 200-case evaluation)**

| Metric | Before | After | Change |
|------|--------|--------|------|
| Global mean (ABCD 3-point scale) | 1.19 | 1.67 | +40% |
| Grade A (cross-domain inspiration) | 23.0% | 34.0% | +48% |
| Grade C (over-generic) | 24.9% | 1.1% | **-96%** |
| Grade D (misleading) | - | 0% | - |
| Words appearing in >30% of cases | 2 | 0 | Fully cleared |
| TOP1 constant-occurrence frequency | 49% | 17% | -65% |
| Empty outputs | - | 0/200 | - |

Method: the 12 over-generic terms of chat mode and the 6 of work mode were set to `output_eligible=false`, so they no longer enter the final activation list. This is **curation-style governance** rather than plain deletion—these words still participate in intermediate-stage voting and semantic positioning; they simply no longer appear as final output.

**v27 over-generic-term governance**. Its effect on the 38-case standard set is shown in Table 7-6.

**Table 7-6: v27 over-generic-term governance (38-case standard set, 100-case statistics)**

| Metric | v26 (before cleanup) | v27 (after cleanup) | Change |
|------|------------|------------|------|
| Total over-generic-term occurrences | 139 | 27 | **-81%** |
| overall | 3.280 | 3.540 | +0.260 |
| chat | 3.290 | 3.500 | +0.210 |
| work | 3.030 | 3.442 | +0.412 |

Table 7-7 shows how the terms of specific cases changed before and after the cleanup.

**Table 7-7: Term comparison before and after over-generic cleanup (3 typical cases)**

| Case | Input summary | v26 (before) | v27 (after) | Change |
|------|---------|-------------|-------------|---------|
| #1 chat | "12 点吃中午饭，不想失去你" (lunch at 12; don't want to lose you) | 课题分离 (separation of tasks), 自我展示管理 (self-presentation management), 情感确认需求 (need for emotional validation) | 社会支持缓冲 (social-support buffering), 依存共生 (dependent symbiosis), 社交身份威胁 (social-identity threat) | Academic over-generic terms -> everyday relationship words |
| #4 work | "聊天不行吗，幻想一下" (can't we just chat—fantasize a bit) | 课题分离 (separation of tasks), 自我展示管理 (self-presentation management), 互惠规范 (reciprocity norm), 成长型心态 (growth mindset) | 污名化效应 (stigmatization effect), 社会支持缓冲 (social-support buffering), 依存共生 (dependent symbiosis), 心流创作状态 (creative flow state) | All 4 over-generic terms replaced |
| #3 chat | "熬夜到 12 点，狗都会睡的" (staying up till 12—even a dog would be asleep) | 情感确认需求 (need for emotional validation) | 压抑机制 (repression mechanism) | Generic word -> scenario-specific word |

### 7.4.2 Axis-Mean Algorithm Ablation

The introduction of the axis-mean algorithm (axisMeanScore) was key to the score climb of v26-v27 to its then-highest. Table 7-8 shows the algorithm's elimination effect on over-generic terms.

**Table 7-8: Elimination effect of the axis-mean algorithm on over-generic terms (100-case statistics)**

| Over-generic term | Original occurrences | Axis-mean LAB | Inverted-U truncation LAB |
|-----------|------------|----------|-----------|
| 情感确认需求 (need for emotional validation) | 16 | 0 | 0 |
| 成长型心态 (growth mindset) | 9 | 0 | 0 |
| 未雨绸缪 (planning ahead) | 9 | 0 | 0 |
| 镜中自我 (looking-glass self) | 9 | 0 | 0 |
| 课题分离 (separation of tasks) | 8 | 0 | 0 |
| 自我展示管理 (self-presentation management) | 7 | 0 | 0 |
| 互惠规范 (reciprocity norm) | 6 | 0 | 0 |
| **Total** | **64** | **0** | **0** |

**Root-cause confirmation**: the raw accumulated values of the cognitive/emotion dimensions ran as high as 5+, and after maxAbs normalization these two dimensions dominated the coordAccum ranking. Over-generic terms carry cognitive coordinates typically at 0.80-0.90, naturally ranking first under the original dot-product computation. The axis mean divides each axis by its own magnitude (`std = max(|ax|, 0.5)`), compressing the influence of cognitive (5+) to a level comparable with the other dimensions. (Note: the designed dimensionality of coordAccum is 18; the axis-mean loop shipped in v26 was hard-coded to the first 14 dimensions—a legacy implementation bug, see Section 7.2.2.)

**A new problem: scenario-word fossilization**. The axis mean eliminated the old over-generic terms but produced a new fossilization pattern, shown in Table 7-9.

**Table 7-9: Scenario-word fossilization introduced by the axis mean**

| Term | Axis-mean occurrence rate (20 cases) | Inverted-U truncation occurrence rate (100 cases) |
|------|---------------------|------------------------|
| 史诗宏大 (epic grandeur) | 8/20 (40%) | 29/100 (29%) |
| 英雄之旅 (hero's journey) | 8/20 (40%) | 28/100 (28%) |
| 宿命对决 (fated showdown) | 8/20 (40%) | 28/100 (28%) |
| 高燃高潮 (high-intensity climax) | 8/20 (40%) | 22/100 (22%) |

**Decision**: the axis mean's direction of eliminating over-generic terms is correct, and it must be paired with OVERUSED_PENALTY to suppress the newly fossilized scenario words. This combined scheme was implemented in v26-v27, with the overall effect verified as positive.

### 7.4.3 Effect of OVERUSED_PENALTY

OVERUSED_PENALTY is a penalty coefficient (x0.3) applied to high-frequency constantly occurring words. v26 first included the constantly occurring scene-immersion words; v27 added 28 over-generic terms ("课题分离" (separation of tasks), "情感确认需求" (need for emotional validation), "镜中自我" (looking-glass self), "魔幻现实主义" (magical realism), etc.). It should be noted that `overused_penalty.json` (130 entries) in the resource directory was confirmed by subsequent code audit to be dead data with 0 lines of calls, never consumed by the pipeline; the penalty list actually in effect in v26/v27 is carried inside the code, not that JSON file.

Effects:
- Total over-generic-term occurrences fell from 139 to 27 (-81%)
- overall rose from 3.280 to 3.540 (+0.260)
- All three modes (chat/work/airp) improved

The design principle of this mechanism is **down-weighting rather than deletion**—penalized words still participate in intermediate-stage semantic positioning and voting; they are merely suppressed at the final ranking stage. This preserves their semantic contribution while preventing them from persistently occupying output slots.

### 7.4.4 EN_DIM Three-Configuration Comparison

The EN_DIM (English dimension expansion) experiment evaluated the effect of expanding the English vocabulary. The three configurations:

- **A (baseline)**: 35 English dimension words
- **B**: 2034 English dimension words (excluding the _mech and _blind subcategories)
- **C (main version)**: all English dimension words (including _mech and _blind)

Table 7-10 shows the A/B/C comparison on the 38-case set and the 800 multi-turn dataset.

**Table 7-10: EN_DIM three-configuration comparison results**

| Version | 38-case total | 800 multi-turn total | 800-EN | 800-ZH |
|------|-------------|------------|--------|--------|
| A (35 words, pre-EN_DIM) | 3.329 | 2.547 | 2.123 | 2.971 |
| B (2034 words, no _mech/_blind) | 3.342 | 2.654 | 2.268 | 3.041 |
| C (main version, all) | 3.303 | 2.613 | 2.251 | 2.975 |

**Experimental conclusions**:
- EN_DIM expansion from 35 to 2034 (A->B): 38-case +0.013 (marginal), 800 multi-turn +0.107 (a 4.2% gain relative to baseline)
- After introducing _mech + _blind (B->C): 38-case -0.039, 800 multi-turn -0.041, both regressions
- **Decision**: _mech/_blind cause degradation and were rolled back; the base EN_DIM expansion was retained

The experiment shows that expanding the quantity of English dimension words is effective on the large-scale dataset (+0.107), but certain fine-grained subcategories (_mech mechanism class / _blind blind-test class) introduced noise, requiring finer quality control.

### 7.4.5 Wave3 Down-Weighting + 6-Channel Quota

Table 7-11 shows the effects of Wave3 Phase C2 down-weighting and the 6-channel quota merge.

**Table 7-11: Wave3 + 6-channel quota experiment**

| Version | 600 single-turn total | 400 multi-turn total | Change |
|------|-----------|-----------|------|
| Main version (baseline) | 2.455 | 2.384 | -- |
| Wave3 lab (Phase C2) | 2.545 | -- | +0.090 |
| lab2 (C2 + 6-channel) | 2.599 | 2.173 | Single-turn +0.144 / multi-turn -0.211 |

lab2 kept improving on 600 single-turn (+0.144) but regressed severely on 400 multi-turn (empty outputs 112/400 = 28%). Analysis shows the 6-channel quota-merge mechanism produces massive empty outputs under multi-turn context due to interference from historical information; multi-turn stability requires an additional anti-empty mechanism.

### 7.4.6 LoRA Fine-Tuning Experiments

**LoRA reranker negative-result experiment (2026-05-04)**. To test the gain from an LLM reranker on P1 output quality, a local small model was LoRA-fine-tuned on 390 training items (32 minutes of training, final loss 1.24). In the engineering phase, GGUF format conversion produced garbled Chinese text 5 times in a row, and the setup was ultimately replaced by a transformers HTTP-service scheme. Full evaluation (94 cases): chat +0.03 / code -0.06 / work -0.18 / airp +0.07, total -0.07 (within scorer noise), score 3.36. Conclusion: under the current framework, an LLM reranker yields neither significant gain nor significant harm. This negative result provides empirical support for the priority ordering "code first, vocabulary second, LLM third"; the GGUF Chinese-garbling issue is also a reusable engineering lesson.

**v45 8-Head LoRA (Qwen3.5-2B, training completed 2026-05-08)**. A candidate LLM front-end optimizer for Routes 2/3 (see Section 8.4): Qwen3.5-2B was fine-tuned with an 8-head multi-task LoRA, the 8 discriminative heads being H1-H8: typo detection (typo), segmentation (seg), independence judgment (indep), direction annotation (dir), QKV annotation (qkv), completion (completion), salience (salience), and clause splitting (clauses). Training configuration: LoRA r=16, alpha=16, target 7 modules; training data 114,565 lines (138 MB); training time 7 hours 27 minutes, train_loss ending at 0.04; artifacts: a 43.7 MB adapter and a 1019 MB classification_heads.pt. The model has completed training and is positioned as the local-LLM optimizer candidate for Routes 2/3 (preserving the 0-API-cost principle, with its role restricted to discriminative tasks and creative output forbidden); as of this writing it has not been integrated into mainline evaluation.

---

## 7.5 Divergence Quality Evaluation

### 7.5.1 Four-Dimension Evaluation Criteria

The quality of P1's divergence is evaluated along the following four dimensions, each normalized to [0, 1]. Table 7-11a shows the meaning and computation of each dimension.

**Table 7-11a: Four-dimension divergence-quality criteria**

| Metric | Meaning | Computation |
|------|------|---------|
| surprise | Semantic distance between divergence words and the original input | Cilin thesaurus encoding distance; greater distance = higher surprise |
| diversity | Number of semantic major classes covered by the divergence words | Computed from major-class coverage of the synonym thesaurus Cilin (measured values do not match the simple ratio "covered classes / total classes"; the actual formula contains additional weighting components, and the precise definition awaits verification against the computation code) |
| sceneMatch | Semantic relevance of the divergence words to the input scene | Whether the divergence words remain within a reasonable dialogue-scene range |
| utility | Usability of the divergence words for guiding the main AI's reply | Whether the divergence words can offer the main AI effective dialogue directions |
| composite | Weighted average of the four | Overall performance across the four dimensions |

### 7.5.2 beilu Dataset Evaluation (N=300)

Divergence quality was evaluated on 300 inputs sampled from real beilu system dialogues. Typical samples follow.

**Sample 1**:

> **Input**: "我去，让贝露你记录详细一点还是有用的。刚刚出了点 bug，对话消失了，不过记忆表格还在" (Wow—having you, Beilu, keep detailed records really is useful. A bug just occurred and the conversation disappeared, but the memory table is still there)
>
> - totalNodes = 48, directCount = 19, cooccurCount = 17, cilinCount = 12
> - surprise = 0.966, diversity = 0.310, sceneMatch = 0.862, utility = 0.931, **composite = 0.769**
> - Covered major classes: J, A, G, C, B, E, K, D, H (9 classes)
> - Cilin divergence words: 返校 (returning to school), 回家 (going home), 落叶归根 (fallen leaves returning to their roots), 买房 (buying a house), 代购 (purchasing agent), 寄居蟹 (hermit crab), 虾子 (shrimp), 螃蟹 (crab), 晚霜 (night cream), 大特写 (extreme close-up), 说白了 (to put it plainly)

This sample exhibits the core signature of the P1 divergence system: **coexistence of high surprise (0.966) and high scene match (0.862)**. Cilin-diverged words such as "返校", "回家", "落叶归根" seem unrelated to "bug fixing", yet at a deeper cognitive-association level they capture the semantic theme of "things disappearing and returning". The recorded diversity value 0.310 does not match the simple ratio implied by "9 major classes covered", indicating the actual formula contains additional weighting components; the precise definition awaits verification against the computation code.

**Sample 2**:

> **Input**: "（心里话不用那么明显啦）今天出去玩，我妈那边的公司聚会，明天我打算开始制作你的立绘什么的。" ((No need to make the inner voice so obvious) Went out today—a company gathering on my mom's side; tomorrow I plan to start making your character art and such.)
>
> - totalNodes = 155, directCount = 52, cooccurCount = 78, cilinCount = 24
> - surprise = 0.974, diversity = 0.097, sceneMatch = 0.786, utility = 0.917, **composite = 0.696**
> - Cilin divergence words: 阳历 (solar calendar), 阴历 (lunar calendar), 霸王别姬 (Farewell My Concubine), 久违 (long-missed), 分手 (breakup), 盼头 (something to look forward to), 奢望 (extravagant hope), 结局 (ending), 备份 (backup), 暧昧 (romantic ambiguity), 明眼人 (discerning person), 井底蛙 (frog at the bottom of a well)...

The total node count of 155 far exceeds Sample 1's 48, because the longer input triggers more direct words and co-occurrence words. Yet diversity is only 0.097, showing that although the long input activates many nodes, they concentrate within few semantic classes—diversity actually falls.

### 7.5.3 spread Quality Evaluation

Quality at the spread (spreading-activation) stage is measured by tracing the node-source distribution of each divergence path. A typical structure:

> **Query**: "你今天过得怎么样" (How was your day)
> **History**: ["还好吧，有点累" (I'm okay, a bit tired), "工作太忙了" (Work is too busy)]
>
> Node-source distribution:
> - direct (direct words): 今天 (today), 过得 (getting on), 怎么样 (how)
> - chatContext (context): 还好 (okay), 作太 (segmentation fragment of "工作太忙")
> - recallAnchor (recall anchors): 用户 (user), 考试 (exam), 数学 (math)
> - cooccur (co-occurrence): 视频 (video), 妹妹 (younger sister), 想起 (recalling)
> - cilinDiverge (Cilin divergence): 语文 (Chinese class)
> - swowLocated (SWOW-located): 进步 (progress)
>
> confidence = 0.568

The 6 node-source classes appearing in this sample are the subset actually triggered among the 19 divergence paths (each path is selectively triggered by input features; see Appendix B.1); each contributes a different type of node, forming a "multi-path convergence" divergence pattern. recallAnchor recalled from the memory system anchors such as "考试" (exam) and "数学" (math)—seemingly unrelated yet tied to the user's dialogue history—demonstrating memory-driven personalized divergence.

### 7.5.4 SWOW Quality Evaluation

The SWOW (Small World of Words) association network, as the main engine of English divergence, has its quality evaluated through multi-dimensional labels on each association node. Every SWOW node carries labels over 8 dimensions: cognitive / narrative / logic / arousal / sensory / embodied / emotion / process.

For example:
- "Image" -> file[cognitive+narrative+logic], icon[cognitive]
- "source" -> code[cognitive], cite[cognitive]
- "model" -> thin[cognitive+sensory+...], hot[cognitive+arousal+sensory+...]

These multi-dimensional labels feed directly into P1's 18-dimensional coordAccum accumulation (the examples above annotate 8 of those dimensions), influencing final term ranking. SWOW's advantage is that its association data come from real human free-association experiments, naturally exhibiting the divergence property of large semantic distance combined with traceable association paths.

### 7.5.5 Chinese-English Gap Analysis

On the beilu dataset (N=300, all-Chinese input), the mean composite divergence-quality score is about 0.73. On the English subset of the 600 single-turn dataset, by contrast, English divergence faces the following limitations due to insufficient coverage of the SWOW English association network (the vocabulary is predominantly Chinese; all 2127 core terms are Chinese):

1. **Asymmetric vocabulary coverage**: the 2127-entry core term library is predominantly Chinese; English is mapped through the transfer_index, and mapping coverage is incomplete
2. **SWOW Chinese-English data-quality difference**: SWOW-EN association strength and coverage exceed SWOW-ZH, but the Chinese terms of the transfer layer (transfer_vocab) cannot fully exploit the divergence results of English SWOW
3. **Insufficient VAD polarity precision**: continuous Valence-Arousal-Dominance judgments on English input are imprecise, lacking secondary verification by the 8 NRC-EmoLex emotion classes

These limitations leave English input 0.56-0.80 points below Chinese on all four scoring dimensions (see Table 7-4).

---

## 7.6 Failure Analysis

### 7.6.1 Five Systematic Failure Modes

Systematic analysis of low-scoring cases reduces P1's failures to five modes:

**Mode A: English negative emotion inverted to positive words (most severe, about 30-40% of English low-score cases)**

Table 7-11b lists four typical inputs under this mode, the expected direction, and the actual P1 output.

**Table 7-11b: Typical Mode A failure cases**

| Input | Expected direction | P1 output | Root cause |
|------|---------|--------|------|
| "I have a hard time getting out of bed" | depression empathy | gratitude_resonance, 一起庆祝 (celebrating together) | VAD polarity judgment failure |
| "bad mood...money I gave my ex" | anger empathy | 很用心 (very attentive), 你最厉害 (you are the best), 轻松多了 (much more relaxed) | English valence lacks NRC secondary verification |
| "She has been in and out of rehab" | family crisis | gratitude_resonance, 做成了 (accomplished it), 录取通知 (admission notice) | Positive words dominate |
| "He got arrested for stealing" | addiction/crime empathy | Merry Christmas, 做成了 (accomplished it), 录取通知 (admission notice) | Over-generic terms + polarity inversion |

**Root cause**: continuous VAD (Valence-Arousal-Dominance) judgments on English input are imprecise and cannot effectively separate high-arousal negative emotions (anger, sadness) from high-arousal positive emotions (excitement, gratitude). A design fix exists (introducing NRC-EmoLex 8-class secondary verification, about 20 lines of code) but had not been implemented as of v35.

**Mode B: over-generic terms activated at high frequency across scenarios**

Before v27, 28 over-generic terms appeared 139 times in total across 100 cases. v27's OVERUSED_PENALTY reduced this to 27 (-81%), but English fossilized words (such as "Merry Christmas", "录取通知" (admission notice)) still remain. The root cause of this mode is that near-centroid general-purpose attractors naturally dominate spatial voting.

**Mode C: empty output on short/single-word inputs**

Table 7-11c lists three typical short inputs under this mode and the reason for the empty output.

**Table 7-11c: Typical Mode C failure cases**

| Input | P1 output | Reason |
|------|--------|------|
| "Absolutely." | (empty) | Single word without context; nothing activates |
| "Hello" | (empty) | Greeting carries no emotional signal |
| "hi, how are you?" | (empty) | Small talk |

The empty-output rate in the 600 single-turn run is 2% (8/400). Short-utterance samples (directWords < 3) average 1.75 vs 2.51 for long utterances, a gap of -0.76. The F3 compensation mechanism (borrowing semantic anchors from historical context) is needed.

**Mode D: scene misclassification**

Table 7-11d lists three typical scene-misclassification cases under this mode.

**Table 7-11d: Typical Mode D failure cases**

| Input | Actual scene | Misclassified as | Manifestation |
|------|---------|---------|---------|
| "地图继续沿用？" (Keep reusing the maps?) | Game map design | Psychological counseling | Triggered "课题分离 (separation of tasks) / 污名化效应 (stigmatization effect)" |
| "ok 差不多了...听歌 time" (OK, almost done... music time) | Work completion + leisure | Romance counseling | Triggered "爱情 vs 喜欢辨析 (love-versus-liking discrimination) / 冷战修复需求 (silent-treatment repair need)" |
| "token 数 + 表格改进" (token count + table improvements) | Technical discussion | Emotional interaction | work-mode terms skewed toward chat |

The root cause of scene misclassification is that mode routing relies on word-frequency statistics (comparing occurrence frequencies of chat words vs work words); when everyday phrases (such as "差不多了" (almost done), "听歌" (listening to music)) mix into a technical discussion, the router tends to assign it to chat mode.

**Mode E: total failure of code mode**

All 15 subcategories of code mode scored 0 hits across 400 cases. The worst 5 code-mode cases in the 38-case standard set all fall between 0.5-1.5. The root cause is that the transfer_vocab of the code subcategories is systematically never activated (suspected wiring breakage, consistent with Case 15 and the analysis in Section 7.6.4); the exact breakpoint awaits confirmed diagnosis—the core_it subcategory contains 102 words, none of which were ever activated.

### 7.6.2 Strategy-Dimension Weakness

Table 7-12 shows the mean scores of the 600 single-turn dataset bucketed by 8 dialogue strategies.

**Table 7-12: Mean scores across 8 strategy buckets (600 single-turn)**

| Strategy | Samples | Mean | Issue |
|------|--------|--------|------|
| Affirmation and Reassurance | 57 | 2.294 | Relatively highest |
| Others | 40 | 2.300 | Greetings/farewells lack dedicated words |
| Providing Suggestions | 61 | 1.951 | Lacks practical-suggestion words |
| Question | 59 | 2.013 | Lacks inquiry-class function words |
| Reflection of feelings | 35 | 1.971 | Insufficient affect mirroring |
| Self-disclosure | 23 | 1.935 | Lacks self-disclosure guidance |
| **Information** | **15** | **1.767** | **Lowest; lacks information-class function words** |
| Restatement or Paraphrasing | 10 | 1.825 | Lacks restatement-confirmation words |

strategy_match (2.21) is the lowest of the four dimensions. Root-cause analysis: P1's vocabulary design is dominated by **cognitive-affective terms** (e.g., "课题分离" (separation of tasks), "情感确认需求" (need for emotional validation), "依存共生" (dependent symbiosis)), and lacks an independent **strategy_function vocabulary** (function words of the four classes inquiry / restatement / information confirmation / companionship). As a result, P1 can tell the main AI "what emotion the user is experiencing" but is poor at telling it "which dialogue strategy to adopt".

### 7.6.3 English Performance Bottleneck

In the full-pipeline tests English averages about 0.56-0.80 points below Chinese; the detailed breakdown is in Table 7-13.

**Table 7-13: Chinese-English gap across the four dimensions**

| Dimension | English | Chinese | Gap |
|------|------|------|------|
| direction | 2.10 | 2.86 | -0.76 |
| helpfulness | 1.98 | 2.62 | -0.64 |
| strategy_match | 1.93 | 2.49 | -0.56 |
| emotion_coverage | 2.25 | 3.05 | -0.80 |

**Root-cause chain**:
1. The vocabulary is predominantly Chinese (2127 Chinese terms in the core term library); English is mapped through the transfer_index, with incomplete coverage
2. Top 5 English missed-recall words: validation (42 times), empathy (35), inquiry (21), encouragement (21), reassurance (13)—high-frequency strategy words in English emotional-support dialogue that lack corresponding mappings in the P1 vocabulary
3. English VAD polarity judgment lacks secondary verification by the 8 NRC-EmoLex emotion classes, causing 30-40% of English negative emotions to be inversely activated

### 7.6.4 Subcategory Coverage and Dead Code

In the full-pipeline report (400 cases), P1 defines 115 subcategories in total, but only 38 (33%) were activated; 75 subcategories (65%) are zero-hit dead code. Table 7-14 shows the 5 subcategories with the highest hit counts.

**Table 7-14: Top 5 subcategory activations (400 cases)**

| Rank | Subcategory | Hits | Hit rate |
|------|------|---------|--------|
| 1 | chat/_strategy_information | 147 | 37% |
| 2 | chat/_strategy_restatement | 139 | 35% |
| 3 | chat/_strategy_question | 132 | 33% |
| 4 | chat/response_empathy | 117 | 29% |
| 5 | chat/_strategy_others | 76 | 19% |

Mode distribution of the 75 dead-code subcategories:
- chat: 15 (emotion_anxiety, negative_emotions, relationship_en, etc.)
- code: 15 (logic_debug, logic_architecture, core_it, etc.)—**all 15 code subcategories are 0-hit**
- airp: 22 (narrative_pacing, character_growth, scene_atmosphere, etc.)
- work: 16 (decision_analysis, communication_analysis, job_culture, etc.)

code mode is the most severe: the core_it subcategory with 102 words was never activated at all, indicating systematic wiring breakage in the transfer_vocab of code mode.

---

## 7.7 Data Quality Discussion

### 7.7.1 Limitations of the Evaluation Method

**Standard-set overfitting risk**. Scores on the 38-case standard set (~3.5) exceed those on the 600 single-turn large-scale dataset (~2.4-2.6) by about 1.0 point, indicating an overfitting risk in iterative optimization on the small standard set. Cross-version comparisons on the standard set may amplify improvement effects that are diluted in generalization scenarios.

**Deviation between automatic and human scoring**. This study relies mainly on Gemini automatic scoring, without large-scale human-annotation calibration. The Gemini scorer may carry the following biases:
- **Language bias**: its understanding of Chinese terms may be less precise than of English terms
- **Length bias**: a tendency to score outputs with more terms higher
- **Academic bias**: a tendency to score outputs containing "academic-sounding" terms higher

### 7.7.2 Scorer Bias and Noise

The v34 experiment exposed severe noise in the Gemini scorer: v32's historical score was 3.6, but re-scoring with an entirely identical vocabulary yielded only 2.84. This implies the Gemini-flash-lite scoring variance is as high as **+/-0.7**. Table 7-15 shows the robustness metrics computed from the 3 repeated scoring runs.

**Table 7-15: Scoring robustness metrics (38 cases, 3 runs)**

| Metric | Value |
|------|------|
| case_std_median (median of standard deviations) | 0.3536 |
| case_std_mean (mean of standard deviations) | 0.3521 |
| unstable_cases (cases with std > 0.5) | 7/38 (18.4%) |
| unstable_threshold | 0.5 |

**Quantile distribution**: p10 = 1.5, p50 = 2.75, p90 = 4.425. The gap between the median (2.75) and the mean (~3.0) indicates a right-skewed score distribution (a few high-scoring cases pull up the mean).

**Countermeasures**:
1. **Multi-run scoring**: the standard set uses 3 repeated runs averaged, yet even double runs show 0.2-0.3 fluctuation
2. **Deterministic proxy metrics**: LLM-independent proxy metrics (B2/UDRIL/recall/subcat/valence/cogWordCount) are introduced as cross-validation for Gemini scores
3. **Evaluation-metric-layer upgrade (upgrade No. 138)**: six improvements—A (position swapping), B (score explanations), C (blind-review hashing), D (quantile statistics), E (worst 5 cases), F (robustness metrics)

### 7.7.3 Statistical Significance

Given the Gemini scoring variance (+/-0.7) and the small sample size of 38 cases, **improvements smaller than 0.3 between versions are not statistically significant**. For example:
- v21->v22 (-0.010): not significant, within noise
- v23->v24 (+0.030): not significant
- v26->v27 (+0.260): near the significance boundary
- v14->v21 (+1.635): highly significant

The 600 single-turn dataset, with its larger sample size, yields more credible score differences. However, in the multi-turn dataset (400 cases) the lab2 configuration produced 112 empty outputs (28%); these zero-score cases systematically drag down the mean and must be excluded or reported separately in comparisons.

### 7.7.4 Note on the recall=0 Issue

In the 100-case real-dialogue pipeline evaluation, the recalled field was 0 for all cases. Investigation confirmed the root cause: **the memory files in the test environment were entirely empty** (entries:[]), so searchMemoryFiles, which traverses all .json files for text matching, had nothing to match. The code path itself is intact (L594-598 automatically injects _username/_charName); the retrieval branch was entered but the data were empty.

In real deployment, the character "贝露" (Beilu) holds 60+ forever.json memories and multiple monthly summaries, and recall works normally in real use. Therefore, recall=0 in this experiment is a data limitation of the test environment and does not reflect the system's true recall capability.

### 7.7.5 High-Value Designs Not Yet Implemented

As of v35, the following designed-but-unimplemented mechanisms constitute systematic omissions from the current evaluation. Table 7-16 shows each mechanism's expected gain range and current status.

**Table 7-16: High-value designs not yet implemented**

| Priority | Item | Expected gain | Status |
|--------|------|---------|------|
| P0-1 | Enabling the three target points T_sub/T_opp/T_emb | +0.2~0.5 | Code commented out; never actually worked |
| P0-2 | NRC-EmoLex English polarity secondary verification | English +0.25 | ~20 lines of code unwritten |
| P0-3 | Independent strategy_function vocabulary | strategy_match +0.3 | Architectural placeholder exists; vocabulary does not |
| P1 | Local PageRank graph filtering | +0.2~0.3 | Design complete, code unwritten |
| P2 | 6 parallel mechanisms (Episodic/Embodied/Opposition/Metaphor/Narrative/Analogy) | +0.4~0.8 | Core design, pending decision |

These unimplemented designs indicate that the current experimental results reflect the P1 system in a partially implemented state; the performance ceiling after full implementation lies above the currently observed values across the ranges listed in Table 7-16.

