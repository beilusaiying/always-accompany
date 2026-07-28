# 第五章 BLQ 打分与输出系统

> 本章描述 P1 管线从"信息词池"收敛为"最终方向词输出"的完整链路。核心是 BLQ 打分算法——一套从连乘公式重构为加性 CombSUM 的质量排序装置，配合 Hough 多对一投票（Node-9）与红线过滤（Node-10）完成收口。此外，本章还覆盖分词预处理（Node-1）与轴系统（六主轴 + 47 子轴）两个支撑模块，二者共同构成信息词在多学科空间中的坐标定位基础。

## 5.1 BLQ 算法

### 5.1.1 名称由来与设计定位

BLQ 全称 **Beilu Linqing Quality**，取自项目名"beilu"与核心设计者凛倾（Linqing）的名字缩写。它是 P1 收拢二阶段的核心排序算法，承担着对信息词池进行质量筛选和排名的功能。

系统在模块职责上确立了定位与评分分离的原则：47 子轴系统仅承担空间坐标定位（判定哪些子方向被激活），质量排序由 BLQ 与向量相似度模块独立完成。这一关注点分离（Separation of Concerns）设计避免了定位信号与质量信号的相互污染。BLQ 是**打分装置，不是发散引擎**。它接收上游各节点已完成定位和发散的信息词，对其进行多维度质量评估，产出排名结果供最终输出端消费。

### 5.1.2 从连乘到加性的演进

BLQ 的公式形态经历了一次根本性重构。早期版本采用全乘积公式：

```
blqScore = gate * rank * bonus
```

其中 `_rank` 内部也是 8 个信号的加权乘积。这种连乘（multiplicative）形态存在严重的**指数坍缩问题**：当信息词在某个因子上得分较低时（例如某个因子值为 0.3），多个因子连乘后分数将指数级下降。以 4 个因子各取 0.3 为例：

$$0.3^4 \approx 0.008$$

一个本来在多数维度上表现良好的信息词，仅因一个维度的低分即被压至接近零，等同于 AND 逻辑门——任意因子趋零则整体趋零。

这与系统"多轴共振奖励"的设计语义（OR 逻辑：只要有若干维度命中即可出线）相矛盾。算法效率审查（Expert_algorithm）将该问题定性为乘积打分的"短路效应"：任意因子趋零则整体趋零，等同 AND 逻辑门，与多轴共振所要求的 OR 语义直接冲突。

解决方案是将 BLQ 重构为**加性 CombSUM**（Combinatorial Sum）形态。CombSUM 是信息检索领域的经典多源融合方法（Fox & Shaw, 1994），核心思想是将多个独立排名信号的分数直接加和，而非相乘。这保留了每个维度的独立贡献，避免了连乘导致的指数坍缩。

### 5.1.3 完整公式展开

重构后的 calcBLQ 函数（位于 BLQ 模块）采用"6 加分维 + 4 抑制维"的加性架构。

#### 6 加分维（additive 基分）

加分维通过加权求和计算基础分数：

```
additive = W_SPATIAL * spatial + W_TF * tf + W_PATH * pathHarmony
         + W_NB * nb + W_SPEC * spec + W_CONFIRM * confirmLog
```

表 5-1 展示了 6 个加分维度的权重、计算方法与学术来源。

**表 5-1：BLQ 6 加分维详解**

| 维度 | 权重 | 计算方法 | 学术来源 |
|------|------|---------|---------|
| `spatial` | W_SPATIAL = 1.0 | 空间投票得分（node6 回写的 totalVote） | Hough Transform (Hough, 1962) |
| `tf` | W_TF = 0.6 | BM25 TF 饱和函数：`tf = f*(k1+1) / (f + k1*(1-b+b*|d|/avgdl))`，k1=1.5, b=0.75 | BM25 (Robertson et al., 1994) |
| `pathHarmony` | W_PATH = 0.4 | 路径和谐度（发散路径的学科一致性） | 自定义指标 |
| `nb` | W_NB = 0.5 | Numberbatch 300 维余弦相似度 | ConceptNet Numberbatch (Speer et al., 2017) |
| `spec` | W_SPEC = 0.4 | 术语特异性（IDF 区分度） | TF-IDF (Salton & Buckley, 1988) |
| `confirmLog` | W_CONFIRM = 0.3 | confirmCount 对数归一化：`log(1 + confirmCount)`，多路资源确认信号 | 自定义指标 |

其中 BM25 TF 饱和函数是信息检索领域的标准文档频率饱和公式，引入 k1 和 b 两个参数控制词频饱和速度和文档长度归一化。

在 P1 语境中，"文档"对应一个信息词在多个空间投票通道中被命中的次数，饱和函数使高频命中词的分数增长趋于饱和，防止其长期占据排名头部。

#### 4 抑制维（加性扣分）

抑制维采用加性扣分而非连乘，确保多门叠加不指数坍缩。表 5-2 展示了 4 个抑制维的扣分量、触发条件与设计说明。

**表 5-2：BLQ 4 抑制维详解**

| 抑制维 | 扣分量 | 触发条件 | 说明 |
|--------|--------|---------|------|
| `overused`（万金油名单） | 0.35 | 术语在 `overused_penalty.json`（129 条）名单中 | 80%+ 不同输入中都被激活的词 |
| `polarity_mismatch`（极性错位） | 0.30 | 信息词极性与输入极性不一致 | 如输入负面但词为正面 |
| `nb_irrelevant`（语义无关） | 0.15 | NB300 余弦相似度 < 0.05 | 与输入质心语义距离过远 |
| `isolated_noise`（孤立噪声） | via 0.50 | confirmCount = 0，无任何资源确认 | 未被多路资源交叉验证的孤立词 |

最终 BLQ 分数的计算公式：

```
blqScore = max(additive * BLQ_SUPPRESS_FLOOR, additive - SUM(penalties))
```

其中 `BLQ_SUPPRESS_FLOOR = 0.1` 是软地板——多门叠扣后仍保留基分的 10% 下限，不硬归零。这对应系统确立的软过滤设计原则（"量大擦边"）：即使一个词被多个抑制门命中，也不将其完全剔除，而是大幅降权后以低分保留，避免硬阈值造成的信号不可逆丢失。

### 5.1.4 核心代码

calcBLQ 函数位于 BLQ 模块，由 Transfer 模块以别名 `_calcBLQ_n8` 导入调用。

加性架构的核心实现模式如下（以 node9 方向词质量门为例，与 node8 calcBLQ 采用完全相同的加性形态）：

```javascript
// Node-9 方向词选择模块 — 加性扣分辅助函数
const _pen = (m, label) => {
  if (m >= 1) return; // m=1 不扣分(=未触发)
  const penalty = _score0 * (1 - m);
  _gates.push({ gate: label, factor: +m.toFixed(3), penalty: +penalty.toFixed(4) });
};

// 聚合 + 软地板 (Node-9 方向词选择模块)
if (_gates.length > 0) {
  const _penSum = _gates.reduce((s, g) => s + g.penalty, 0);
  dw.score = Math.max(_score0 * GATE_SUPPRESS_FLOOR, _score0 - _penSum);
}
```

上述代码段体现了加性重写的三条铁律：
1. **每门把乘子 m 转为一次加性扣分** `penalty = score * (1 - m)`，各门只扣一次不互相放大；
2. **禁连乘**：单门扣分 `score - score*(1-m) = score*m` 与旧连乘单门等价，但多门是线性叠扣而非指数坍缩；
3. **软地板不归零**：`max(score * FLOOR, score - SUM)` 保证最低保留 10% 基分。

### 5.1.5 否决记录

BLQ 公式的演进过程中，多个替代方案被实验否决。表 5-3 汇总了这些方案的实验结果与否决原因。

**表 5-3：BLQ 替代方案否决记录**

| 方案 | 实验结果 | 否决原因 |
|------|---------|---------|
| 几何均值（geometric mean） | lccc +25% 恶化 | 几何均值仍是乘法族，对零值敏感 |
| 乘积回退（旧全乘积公式） | lccc -62% | 指数坍缩（0.3^4 问题），AND 门逻辑与多轴共振矛盾 |
| cos-mu contrast 三处叠用 | 适得其反：低 mu 冷僻词反而新进入输出头部 | 治标补丁，真根因在 node6 未接回主排名（2026-06-02 整体删除） |

在方案否决层面，系统确立了"禁止症状层补丁"的工程纪律：任何与加性架构原则相悖的修改一经识别即整体移除，而非在其上继续叠加修正项——补丁叠加会将错误锁定在症状层并持续劣化架构。表 5-3 中 cos-mu contrast 方案的整体删除（2026-06-02）即该纪律的执行实例。

---

## 5.2 Hough 多对一投票（Node-9）

### 5.2.1 学术来源

Node-9 的核心算法灵感来自 **Hough Transform**（Hough, 1962），一种计算机视觉中用于从散点中检测直线等几何形状的经典方法。Hough 变换的本质是"多对一投票"：每个散点在参数空间中投票，只有被大量散点共同指向的参数组合才能出线。

P1 将这一思想迁移到语义空间。表 5-4 展示了 Hough Transform 原始概念与 P1 Node-9 迁移实现之间的对应关系。

**表 5-4：Hough Transform 到 Node-9 的概念迁移**

| Hough Transform（原版） | P1 Node-9（迁移） |
|------------------------|-------------------|
| 散点 | 信息词池中的每个信息词 |
| 参数空间中的候选 | AT（Activation Terms）中的 eligible 术语 |
| 投票 | 47D 余弦范围门 + NB300 语义相似度打分 |
| 被最多散点命中的参数 = 检测到的形状 | 被最多信息词共同指向的术语 = 方向词 |

### 5.2.2 算法详解

#### 设计原则

系统在投票语义上确立了三条设计约束：其一，投票方向为多对一——多个信息词共同指向一个方向词，而非单个信息词发散出多个方向词；其二，发散主体是信息池整体而非逐词——逐词发散再相加会使高连接度通用词天然占优；其三，聚合时不取均值、保留分布张力——质心化会将分布坍缩为单点，丢失多峰信息。

这三条约束分别否决了三种错误实现：
- 逐词发散相加（一个词发散一堆 → 万金油根因）
- 质心投票（取均值 → 丢失分布信息，万金油附近所有候选都高分）
- 均值塌缩（保留面不塌成点）

上述约束与 Hough 变换的参数空间投票语义一致：检测目标由大量散点的共同指向涌现，而非由单点外推或均值坍缩得出（Hough, 1962）。

#### 投票公式

每个信息词 i 独立对范围门内的 eligible 术语 t 投票：

$$\text{vote}_{i \to t} = w_i \cdot (\text{relW} + \text{domainW} + \lambda \cdot \cos_{47})$$

其中：
- $w_i$ = 信息词自身权重（反映其在池中的重要性）
- $\text{relW}$ = NB300 语义相似度（信息词 i 与术语 t 的 300 维余弦）
- $\text{domainW}$ = 域匹配加分（术语所属轴与域信号匹配时的奖励）
- $\cos_{47}$ = 47D 定位信号（P1_NODE9_LOC_VOTE 开启时加入票值，权重 LOC_VOTE_W = 0.3）
- $\lambda$ = 定位入票开关（默认 on，2026-07-03 200case A/B 判正转正）

累加得到每个 eligible 术语的总票数：

$$\text{totalVote}(t) = \sum_{i} \text{vote}_{i \to t}$$

$$\text{voterCount}(t) = \#\{i : \text{vote}_{i \to t} > 0\}$$

47D 范围门的阈值 `VOTE_COS_FLOOR = 0.15`，来自算法设计文档中六度路径停止条件"联系过小（<0.15）→ 自动停止"，与路径衰减族的停止门同值，并非任意选取。

#### 三通道统一累加器

所有投票通道汇入同一个累加器 `_voteAcc`，Hough 是唯一出词路径：

1. **Hough 通道**（主通道）：M 信息词 x N eligible 的 M*N 次独立投票
2. **ConceptNet 确认通道**：有界多对一确认票，`CN_VOTE_WEIGHT(0.5) * min(1, reacherCount / CN_FULL_REACH(3))`
3. **bridge_to 确认通道**：AT 静态精确映射的有界确认，`BRIDGE_WEIGHT(0.6) * min(1, reacherCount / BRIDGE_FULL_REACH(2))`

CN 和 bridge 通道都是"加分确认"而非独立出词——它们的票汇入 Hough 累加器参与统一排序，不独立产出方向词。

IDW（Inverse Distance Weighting，Shepard 1968）衰减作为距离调制因子参与投票计算，确保远距离候选的投票权重自然递减。

#### 方向词最终分数

```
score = totalVote * max(axisDecay, houghDecayFloor) * resonanceWeight
```

其中 `axisDecay` 是该术语所属轴的衰减系数（来自 node3 的 `exp(-rank * beta)`），`resonanceWeight` 是机制共振折扣（仅单通道拿票的靶打折）。

### 5.2.3 核心代码

完整的 Hough 多对一投票实现位于 Node-9 方向词选择模块（`selectDirectionWords` 函数）。以下代码展示了核心投票循环：

```javascript
// Node-9 方向词选择模块 — 每个信息词独立对该 eligible 投票
for (const { iw, a47t: iw47t, iwVec, norm47: iwNorm47, iwWeight, iwNbVec } of _iwPrecomputed) {
  // 47D 范围门: 该信息词是否指向该 eligible(只定位不打分)
  let cos47;
  let dot = 0;
  for (const k of AXES_47_KEYS) dot += (iw47t[k] || 0) * (a47t[k] || 0);
  cos47 = dot / (iwNorm47 * a47Norm);
  if (cos47 < VOTE_COS_FLOOR) continue;  // 未过范围门，不投票

  // NB300 打分: 该信息词与该 eligible 的语义相关性
  let relW = CONVERT_NB_NULL_W;  // OOV 中性票 0.3
  if (iwNbVec && eligNbVec) {
    let dot = 0;
    for (let j = 0; j < 300; j++) dot += iwNbVec[j] * eligNbVec[j];
    relW = Math.max(0.01, dot * _vecW);
  }

  // 投票 = 信息词权重 * (语义相关 + 域匹配 + 定位信号)
  const vote = iwWeight * (relW + _domainW + (_P9_LOC_VOTE ? LOC_VOTE_W * cos47 : 0));
  _entryTotalVote += vote;
  _entryVoterCount++;
}
```

上述循环对每个 eligible 术语逐一计算 47D 范围门与 NB300 语义相关性，最终累加为总票数。

### 5.2.4 金字塔输出

方向词的最终输出采用三层金字塔结构（来自 71 号设计文档"立体算法设计 Section 3.2 Phase5"）。该结构对应系统确立的发散质量总判据——产出应兼具远距离联想的新颖性与可追溯的关联依据。这一判据与 Mednick (1962) 的创造性联想理论一致：创造性产出源于远距离联想元素的有效组合，而非无根据的随机跳跃。

表 5-5 展示了金字塔三层的数量上限、选取依据与设计意图。

**表 5-5：方向词金字塔三层结构**

| 层级 | 数量 | 选取依据 | 设计意图 |
|------|------|---------|---------|
| apex | <=3 | voterCount 最高 | 池整体共识层（多对一投票的核心产物），定位最准的词 |
| mid | <=8 | 非 apex 中 score 排序 | 主体方向词 |
| base | <=3 | 跨主轴 + hop>=2 | 远距离联想层——跨域六度路径词 |

---

## 5.3 红线过滤系统（Node-10）

Node-10（`refineDirectionWords` + `isRedlineWord`，位于 BLQ 模块）是 P1 输出端的最后一级过滤，负责在方向词送达主 AI 之前进行质量精排和红线硬剔除。

### 5.3.1 四条输出红线

`isRedlineWord` 函数通过四组正则表达式实现硬剔除。表 5-6 展示了四条红线的类别、正则种子示例与学术依据。

**表 5-6：Node-10 四条输出红线**

| 红线编号 | 类别 | 正则种子示例 | 学术依据 |
|---------|------|------------|---------|
| R1 | 路线词（route） | 建议/应该/方法/步骤/策略... | 方向—路线分离原则（系统设计约束，见 6.4 节） |
| R2 | 诱导词（induce） | 你需要/你必须/快去/赶紧... | 避免 P1 越权指令用户 |
| R3 | 主观代述（subjective） | 你很/你好/你觉得/感觉很... | 禁止代替用户表达感受 |
| R4 | 诊断词（diagnostic） | 症/障碍/综合征/确诊... | P1 给方向不做诊断 |

红线的设计来自系统确立的输出四禁原则：不输出路线词（具体行为指令或安抚话术）；不输出泛化的心理安慰内容；不向用户下达行动指令（如"去旅游/打电话/早点睡"类）；在缺乏上下文时不锁定单一归因，改以多学科并行推定。该原则将 P1 的输出严格限定在"认知方向提示"的职能边界内。

被红线命中的词在 Pipeline 模块阶段被直接剔除，不进入最终 XML 输出。

### 5.3.2 高斯渐变衰减

`refineDirectionWords` 对方向词应用高斯渐变衰减，替代二值阈值过滤。衰减公式：

$$\text{decay}(d) = \max\left(\text{FLOOR},\; \exp\left(-\frac{(d - \text{PEAK})^2}{2 \cdot \text{SIGMA}^2}\right)\right)$$

其中：
- $d$ = 方向词与输入质心（inputCentroid）的 NB300 余弦距离
- PEAK = 0.45（最优语义距离——不太近也不太远）
- SIGMA = 0.25（高斯宽度）
- FLOOR = 0.15（衰减下限，不硬归零）

高斯衰减的设计意图：
- **过近的词**（$d < \text{PEAK}$）：与用户原文太相似 → 落入"废词"判据（主模型裸读原文即可自行推出，信息增量为零，见 6.4.2 节），衰减
- **过远的词**（$d > \text{PEAK}$）：与输入语义距离过大 → 无关噪声，衰减
- **最优距离附近的词**（$d \approx \text{PEAK}$）：既有关联又有新意 → 衰减最小，得分最高

这比传统的二值硬阈值（如 cos > 0.7 直接删除）更加平滑——同一个词不会因为 0.69 和 0.71 的微小差异而产生保留/删除的跳变。

最终方向词分数：

```
finalScore = node9Score * min(factors) * gaussDecay
```

### 5.3.3 断崖检测

为应对方向词分数分布中可能出现的自然断层，node10 实现了断崖检测机制：

```
如果 前词 score > 后词 score * N10_CLIFF_RATIO(3)
  → 在此处截断输出（最少保留 N10_CLIFF_MIN = 5 个词）
```

断崖检测允许输出少于标准 15 个方向词——当分数分布存在明显断层时，宁可少输出也不强凑数。这对应系统确立的"精准优先于数量"设计原则，其容量取向与 Cowan (2001) 的工作记忆容量研究一致（4 +/- 1 个核心信息项为最佳容量）。

### 5.3.4 完整输出流水线

Node-10 的完整处理流水线如下：

```
node9 方向词 top20
  → refineDirectionWords（高斯衰减 + BLQ 精排 + 断崖检测）
  → isRedlineWord（4 条正则硬剔除）
  → 最终 p1_act XML top15
```

四步依次执行：先精排、再硬剔除、最终产出限定 15 个方向词的 XML 输出。

---

## 5.4 分词与预处理（Node-1）

Node-1（Node-1 分词模块，466 行）是 P1 管线的入口，承担"三段机制第一段 = 收缩"的职能：将用户自然语言输入收拢为有信息量的词集。

### 5.4.1 jieba + BCC 双引擎

分词引擎采用 jieba-wasm（结巴分词的 WebAssembly 版本）作为主引擎，BCC（北京语言大学现代汉语语料库）频率表贪心匹配作为备选。以下代码展示了两引擎的调用顺序：

```javascript
// Node-1 分词模块 — 分词函数
function _tokenizeOrdered(text) {
  if (_jiebaCut) return _jiebaCut(text, true);  // jieba 主引擎
  // fallback: BCC 频率表贪心最大匹配
  // ...对每段连续汉字，取 len=MAX_GRAM(4)..2 中 BCC freq>0 的最长匹配
}
```

jieba 缺失时才会走 BCC 贪心兜底路径。设计约束（2026-05-29 确立）要求分词层同时覆盖中英文：英文词豁免中文 BCC 高频过滤，走独立的英文停用词表（来源：P1 资源库 pattern (CLiPS, BSD) 停用词 + opinion-lexicon-EN）。

2026-07-20 事故记录：jieba-wasm 缺失时曾静默降级到 BCC 贪心，产生"我觉/我一/了兴"等跨词界碎裂 token，波及 node2（碎裂词无 SWOW cue）和 node0 锚点质量。

修复后改为显式告警（console.warn），不再静默降级。

### 5.4.2 排噪三档

排噪机制于 2026-05-29 确立为"软降级"方案：不做二值删除，而是分档降权，最终形成三档排噪机制。表 5-7 展示了三档的 BCC 频率阈值、处理方式与示例词。

**表 5-7：三档排噪机制**

| 档位 | BCC 频率阈值 | 处理方式 | 示例 |
|------|-------------|---------|------|
| **硬排**（hard drop） | > 3,000,000 | 不进词池 | 的、了、是 |
| **软降权**（demote） | > 500,000 且 <= 3,000,000 | 进词池但带低权重 0.1 | 知道、感觉 |
| **保留**（keep） | <= 500,000 | 全权重 1.0 进池 | 失眠、焦虑 |

硬排还叠加了词性（POS）双签验证：HanLP 词性词典和 jieba 词性词典同时标为虚词（d/c/f/m/q/r/p/u/e/y/o/w/s/l）时才硬排，宁可多留不误删。

排噪的设计判据为：过滤对象限定为无信息量的高频常用词，而非具有诊断价值的内容词——排噪是信息量筛选，不是词频一刀切。

2026-06-13 的 THUOCL 专业域前缀仲裁是一个精巧的边界案例处理：词如"前端/后端/终端"在通用语视角下被 HanLP 和 jieba 双标为方位词（f），但在 IT 语境下是核心术语。

解决方案是查 THUOCL 专业域词典——如果一个 2-3 字词是某专业域内 >= 3 个更长术语的前缀（如"前端"是"前端开发/前端工程师/前端框架..."30 个 IT 词的前缀），则判定为领域术语而非虚词，放行。

实测结果验证了该方案的有效性：正例前端 IT:30/后端 IT:3/终端 IT:5 全救；反例 27 个虚词单专业域全 < 3，零误杀。

### 5.4.3 程度副词绑定

程度副词和否定词不作为噪声排除，而是提取为 `intensifiers` 信号供下游消费。以下为程度副词词表定义：

```javascript
// Node-1 分词模块 — 程度副词词表
export const DEGREE_WORDS = new Set([
  "死了", "太", "好", "很", "非常", "超", "特别", "真", "实在", "真的",
  "简直", "完全", "彻底", "这么", "那么",
  "so", "really", "extremely", "absolutely", "totally", "completely",
]);
```

上述词表来源：连接词分类模块 AMPLIFIERS 现有词表（非 AI 生成）。

否定词从 `polarity_lexicon.json#negation_zh + negation_en` 加载（2026-07-22 S7-1 迁移，从硬编码 11 词扩展到 40 词），与极性检测模块同源。

intensifier 绑定规则：仅向后寻找最近的信息词作为修饰目标（设计约束：程度副词按信息词的前置修饰处理，2026-05-29 确立）。例如"太害怕"中，"太"绑定到"害怕"，输出 `{word:"太", target:"害怕", type:"degree"}`。

### 5.4.4 输出接口

Node-1 最终向下游节点暴露以下标准化接口：

```javascript
{
  words: string[],           // 去重后的信息词集
  wordWeights: {word: float},// 每词权重（keep=1.0, demote=0.1）
  demoted: string[],         // 软降权词列表
  intensifiers: [{word, target, type}], // 程度/否定信号
  text: string,              // 原始输入文本
}
```

该接口是 Node-1 与后续节点之间的唯一契约边界，下游模块只消费这五个字段。

---

## 5.5 轴系统

**架构定位（先于分节说明）**：轴系统不是管线中的一个查表打分环节，而是 P1 的核心网络结构——6 主轴承担粗定位，47 子轴承担方向细化（刻画粗定位内部沿各细分方向的语义变化率），再连接 8+ 外部资源库（AT/TI/SWOW/NB300/Domain/cogmech/桥接库等），构成**多层互联结构**：词的激活按层级传导、加性汇聚（量大、多点）。第三章的 12 阶段管线只是这个结构的一次遍历序，不是系统本体。

设计语义上，每个轴对每个词的定位产出是**多个信息点**（信息 + 信息范围），而非单一分数：每轴内部包含基于学科的多维判断，叠加针对词条或内容的专门判断，整体结构为"6+n"而非 6 个标量。这一"轴即子空间"的设计与 Gardenfors (2000) 概念空间理论中"域（domain）由多个可积分维度构成"的结构一致。

### 5.5.1 六主轴定义

P1 的六主轴于 2026-05-11 定稿为固定学科维度：

```javascript
// 轴系统模块 — 6轴定义
// 凛倾: "语言学, 社会学, 信息学, 心理学, 逻辑学, 认知学"
const AXES = ["psychology", "informatics", "sociology", "logic", "linguistics", "cognitive"];
```

该定义的核心约束是：主轴必须是固定的学科维度（心理学 / 信息学 / 社会学 / 逻辑学 / 语言学等），而非数据驱动的统计聚类轴。

演进历史：4 主轴 → QKV 移出轴层改"信息学"替代（34 号设计文档，2026-05-11）→ 5 固定学科轴 → 6 固定（加认知，session13）。早期的涌现轴（动态检测自适应轴）已被否决，改为固定学科轴。

多信息点定位的设计意图可由一个手写标注示例说明：输入"你为什么这么笨"在各轴分别产出多个信息点——信息学：否定/反面/错误/失望；逻辑学：错误/长期问题/失落；心理学：负面/失望/预期不达标。每轴给出的是一组信息标注，而非单一模糊性质。

**打分机制的设计层与实现层**：设计上，8 个分类资源为每词×每轴产出**多个独立信息点**——cogmech 的维度明细、Domain 的域归属、BCC 的三域分布、VAD 的三元组等各自是独立的"信息 + 信息范围"（代码契约中的 `dimDetail` 字段即保留了这一 8 来源明细）；错误出现在下游——当前实现将这些信息点**累加折叠为每轴一个标量分数**再供 faceByAxis 排序消费，属于轴层的信息流失（与第三、四章标注的偏差同根，待框架级修正）。表 5-8 展示了这 8 个资源的词条数、覆盖范围与主要贡献轴（资源清单本身为事实，不受上述偏差影响）。

**表 5-8：6 轴打分的 8 个分类资源**

| 来源 | 词条数 | 覆盖范围 | 主要贡献轴 |
|------|--------|---------|-----------|
| cogmech_gemini.json | 9,134 词 | 认知机制标注（情感/物体/过程等） | psychology, cognitive |
| DomainWordsDict | 561,000 词 69 域 | 全域分类（计算机/社科/文学等） | 所有轴 |
| THUOCL | 11 域 | 领域精选词（IT/医/法/财等） | informatics, sociology |
| activation_terms | ~4,500 术语 | 已知 P1 术语 | 所有轴 |
| BCC 三域分布 | 434,000 词 | 新闻/文学/对话三域比例 | informatics, linguistics, psychology |
| NRC-VAD v2 | 54,801 词 | valence/arousal/dominance | psychology（辅助） |
| concreteness | 87,942 词 | 具象度 | informatics, cognitive |
| NB300 兜底 | 285,000 词 | 前 7 源全空时用锚点余弦 | 所有轴 |

### 5.5.2 47 子轴（实际 59 维）

47 子轴是 P1 产出端的精细坐标空间。"47"是历史命名，实际包含 59 个维度键：

$$\text{47 基础} + \text{12 跨学科} = 59 \text{维}$$

- **47 基础维度**：9 psy + 10 info + 7 soc + 7 logic + 10 lang + 4 mode
- **12 跨学科维度**：6 sem（语义）+ 6 sm（感官运动）

以下展示各学科组的子轴命名示例：

```
psychology  → psy_therapy, psy_analysis, psy_cbt, psy_dbt, psy_common,
              psy_emotion, psy_interpersonal, psy_physiology, psy_psychoanalysis
informatics → info_prog, info_frontend, info_backend, info_data, info_bug,
              info_multiplatform, info_tools, info_common, info_algo, info_learning
sociology   → soc_work, soc_interpersonal, soc_roles, soc_qa, soc_casual,
              soc_discussion, soc_norms
logic       → logic_behavioral, logic_linguistic, logic_design, logic_exploration,
              logic_decision, logic_debug, logic_causal
linguistics → lang_literary, lang_jp_ln, lang_cn_ln, lang_us_novel, lang_character,
              lang_3elements, lang_anime, lang_plot, lang_roles, lang_analysis
mode        → mode_chat, mode_airp, mode_code, mode_work
```

系统对 6 轴与 47 轴的关系确立了三条界定：二者职能不同，不构成上下级或同类关系；6 轴确定发散点（输入端学科定位），47 轴给出产出端的粗定位并在此基础上扩充产出；47 轴按激活子集参与计算，而非全量维度同时生效。

47 轴的设计依据有两层。理论层引自 Gardenfors (2000)《Conceptual Spaces》的概念空间理论——概念是高维空间中的凸区域。结构层的定位是：6 主轴给出词的粗定位后，47 子轴刻画该定位内部**沿各细分方向的语义变化率**，承担方向细化定位，驱动后续的定向发散与"扩充产出"。它是方向性操作，不是静态坐标表。

Node-4（Node-4 子轴定位模块）负责 47 轴坐标命中，2026-06-13 C2 重写后从"累加打分"改为"坐标命中集"——设计终裁确立"47 轴只定位不打分，打分归 NB300+BLQ"的职责划分（注意："不打分"约束的是不进质量排序，不等于定位可以退化为计数）。

**当前实现与设计的偏差**：现行代码为 `witnesses[subAxis].add(命中词)`，activated[subAxis] = |witnesses[subAxis]|——把"沿细分方向刻画语义变化率"的定位降维成了"命中词数 = 激活强度"的计数，上文引述的"扩充产出"职能在命中计数模型中不存在。这是设计的降维执行（变化率定位 → 命中集合的信息流失），属待重构项。

### 5.5.3 轴衰减公式

轴衰减（axis decay）控制不同轴的影响力权重。公式来自框架设计约束"带主方向轴 + 轴衰减"：主方向轴权重最大，远轴权重递减但不删除，衰减形态取 exp(-rank*beta)：

$$\text{axisDecay}[\text{axis}] = \begin{cases} e^{-\text{rank} \times \beta} & \text{if relevance} > 0 \\ 0 & \text{otherwise} \end{cases}$$

其中：
- rank = 该轴按关联度（face 贡献 Sigma v）降序的名次，0 = 主方向轴
- beta = 衰减速率（AXIS_DECAY_BETA = 0.5，待实验定）

该公式在代码中的实现如下：

```javascript
// Node-3 六轴面模块 — 轴衰减计算
axisDecay[axis] = axisRelevance[axis] > 0
  ? +Math.exp(-rank * AXIS_DECAY_BETA).toFixed(4)
  : 0;
```

表 5-9 展示了 beta = 0.5 时各轴名次对应的实际衰减系数。

**表 5-9：轴衰减系数实际效果（beta = 0.5）**

| 轴名次（rank） | 衰减系数 | 含义 |
|---------------|---------|------|
| 0（主轴） | 1.0000 | 完全保留 |
| 1（次轴） | 0.6065 | 保留 ~61% |
| 2（远轴） | 0.3679 | 保留 ~37% |
| 3 | 0.2231 | 保留 ~22% |
| 4 | 0.1353 | 保留 ~14% |
| 5 | 0.0821 | 保留 ~8% |

关键设计约束：远轴衰减但**不删除**（decay > 0，永不归零）。这对应系统确立的"软隔离"原则（铁律 #48）——不硬归零，保留微弱信号。

### 5.5.4 AXIS_CUTOFF 软停

框架线路中确立的发散门槛约束为：轴关联度低于 40% 时该轴不参与发散。该约束被实现为 AXIS_CUTOFF 机制：

```javascript
// Node-3 六轴面模块
const AXIS_CUTOFF = Number(process.env.P1_AXIS_CUTOFF ?? 0.40);
// 关联度=该轴 Sigma v / 主轴 Sigma v; < CUTOFF 的轴不发散(不注入锚词),
// 但原有 face 词不删(软停非硬删)
```

AXIS_CUTOFF = 0.40 是设计给定的算法常数（非实现层自选的魔法数字）。低于此阈值的轴不参与 axisDiverge 发散注锚，但已有的 face 词保留——这是"软停"而非"硬删"。

### 5.5.5 坐标命中算法

Node-4 通过 4 条路径探测散词对 47 子轴坐标的命中。表 5-10 展示了这 4 条路径各自的数据源与命中方式。

**表 5-10：47 子轴坐标命中的 4 条路径**

| 路径 | 数据源 | 命中方式 |
|------|--------|---------|
| path1 | AT axes_47 + atDimToSubAxis | 散词匹配 AT 术语名 → 命中 axes_47 坐标 |
| path2 | cogmech dimDetail + CN 日常 | dimDetail 维度 → 子轴；CN 日常词 → soc_casual |
| path3 | DomainWordsDict / THUOCL | 域文件索引 → 子轴（粗映射） |
| path4 | BCC 三域分布 | 占比 >= 0.45 视为命中（news→info, lit→lang, dialogue→psy+soc） |

2026-06-13 C2 重写后，所有路径都改为命中探测器（`_hit`），不再累加 val*weight 打分。`atDimToSubAxis` 函数（轴系统模块）通过 switch+regex 全前缀覆盖实现 AT dim 名到 47 子轴名的映射，覆盖 540 个 AT dim。

键名分裂 BUG（2026-06-03 根治）：产出端理论键（如 `cog_general`, `lang_narrative`）与消费端 FIELD 键（`psy_*`, `info_*` 等 59 键）不匹配导致静默丢失。

修复方案是通过 `_N4_THEORY_TO_FIELD` 全量映射表（43 键）补全，将所有理论键按学科语义归并到最近的 FIELD 键，补全后残余丢失 = 0。

---

## 本章小结

BLQ 打分与输出系统构成了 P1 管线从"信息词池"到"最终方向词输出"的完整收敛路径。其设计核心可概括为四个层次：

1. **分词预处理**（Node-1）：jieba + BCC 双引擎分词，三档排噪，程度副词绑定——为后续管线提供干净的输入词集。

2. **轴系统**（Node-3/4）：6 主轴 x 47(59) 子轴构成的概念空间，通过 8 资源打分 + 4 路径命中探测确定信息词在多学科空间中的坐标位置。轴衰减 `exp(-rank*beta)` 保证主轴主导而远轴不归零。

3. **多对一投票**（Node-9）：Hough Transform 灵感的 M*N 独立投票机制，三通道（Hough + CN + bridge）统一累加器排序，金字塔三层输出。

4. **质量过滤**（Node-8/10）：BLQ 加性 CombSUM 排名（6 加分维 + 4 抑制维），高斯渐变衰减，断崖检测，4 条输出红线硬剔除——确保最终输出既有质量又无越界。

从连乘到加性的重构是一个具有代表性的设计决策：它将"多维度评估"从 AND 逻辑（所有维度都要好）转变为 OR 逻辑的加性融合（多数维度好即可出线），符合人类认知中"多因素综合判断"的自然模式，也与信息检索领域 CombSUM 多源融合的成熟实践一致。
