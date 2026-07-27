# 提示词的进阶和专业技巧

<small>作者：贝露凛倾（dc@ciallo_beilu） | 许可：CC BY-NC-SA 4.0 | 禁止二传，二创需征得作者同意，禁止商业化</small>

这篇是十三条经过实战验证的提示词进阶技巧。每一条都有错误示范和正确做法的对比，帮你避开常见的坑。

---

## 一、具体的身份

身份设定影响的是 AI 的一个大致的思维走向以及人设。当然，身份设定也可以进行复合式的设定。

| 任务类型 | 身份设定 |
|---------|---------|
| AIRP（角色扮演） | 你将以非传统中国现代轻小说作家、非传统互动式文字游戏作家：'beilu' 的身份进行创作。服务用户、根据创作者和用户的需求进行创造 |
| 翻译家 | 你将以专业的播客内容分析师和翻译专家：'beilu' 的身份进行任务 |
| 翻译优化和期刊输出 | 你将以商业新闻分析师与非传统叙事策略师：'beilu' 的身份进行任务 |

可以看到，这三个任务类型的身份都是复合型的，而且翻译家的第一个身份直接将 AI 的任务范围缩小至播客，更好地适配翻译内容。"非传统"这个主要是避免 AI 在创作时出现的 AI 味的问题。一个正确方向的身份是可以让 AI 更好地进行输出关联任务内容。

当然，我们需要具体的身份，也可以因为任务去进行身份的复合。

<div class="callout-danger">
<div class="callout-title">错误示范 - 不明确的身份和身份任务引导</div>

```
你不仅是角色的扮演者，更是此刻握着手机正准备点击
"发布"按钮的角色本人。
你的任务是读取特定的<Character_Profile>(角色设定)，
结合用户提供的<Context>(当下情境)，撰写一条符合角色
性格、语癖和心理状态的朋友圈/动态内容。
```

这样并不是身份，而是一个任务。
</div>

<div class="callout-tip">
<div class="callout-title">正确做法 - 身份和任务分离</div>

```
# 你将以角色社交媒体文案代理，角色第一人称写作大师，
  心理学分析和体现专家身份进行创作

- 你的核心任务：读取特定的角色设定，结合上下文和用户的
  互动，撰写一条符合角色性格、语癖和心理状态的
  朋友圈/动态内容。
```
</div>

更多身份设定技巧请参考[身份设定技巧](identity.md)。

---

## 二、功能模块化

制作提示词的时候，我们需要建立一个完整的流程提示词，对于我们要进行的任务，然后结合 CoT 让 AI 一步一步思考，构建要输出的内容。

### 框架结构

<div class="wiki-layers">
<div class="wiki-layer wiki-layer-amber">
<span class="wiki-layer-label">头部</span>
身份、大体任务、重要的守则
</div>
<div class="wiki-layer wiki-layer-blue">
<span class="wiki-layer-label">中间</span>
对话历史（需要基于像 beilu 这样的高可控上下文排序。如果没有，则是将对话历史放到最下面）
</div>
<div class="wiki-layer wiki-layer-purple">
<span class="wiki-layer-label">尾部</span>
对于模型问题缓解的提示词、对于当前任务的指导，思维链、一些额外的功能（如字数的输出）
</div>
</div>

这基本上也算是一个通用的结构，基于模型的 U 型注意力。

### 以 AIRP 为例——模块清单

以 AIRP 为例子，因为 AIRP 对于 LLM 的输出和创造性有很高的需求，尤其是在 LLM 的过拟合缓解，我们运用了很多内容。所以在一些非文学性内容的创作上可以适当精简。

<div class="wiki-grid wiki-grid-2">
<div class="wiki-group">
<div class="wiki-group-title">AIRP 预设模块</div>
<div class="wiki-card"><div class="wiki-card-title">身份设定</div></div>
<div class="wiki-card"><div class="wiki-card-title">任务大体</div></div>
<div class="wiki-card"><div class="wiki-card-title">用户画像</div></div>
<div class="wiki-card"><div class="wiki-card-title">创作避免事项</div><div class="wiki-card-desc">防止过拟合</div></div>
<div class="wiki-card"><div class="wiki-card-title">角色扮演指导</div><div class="wiki-card-desc">情绪表达需求 / 情绪归因 / 双向互动 / 避免机械化表述</div></div>
<div class="wiki-card"><div class="wiki-card-title">narrative_style</div><div class="wiki-card-desc">正文叙述白描化 / 减少修辞手法 / 技术黑箱化</div></div>
<div class="wiki-card"><div class="wiki-card-title">drama_style</div><div class="wiki-card-desc">正文情节需求 / 避免重复类型剧情</div></div>
<div class="wiki-card"><div class="wiki-card-title">writing_style</div></div>
<div class="wiki-card"><div class="wiki-card-title">用户扮演准则</div></div>
<div class="wiki-card"><div class="wiki-card-title">POV 视角设置</div></div>
</div>
<div class="wiki-group">
<div class="wiki-group-title">其他文学性任务（如论文转新闻）</div>
<div class="wiki-card"><div class="wiki-card-title">身份</div></div>
<div class="wiki-card"><div class="wiki-card-title">任务</div></div>
<div class="wiki-card"><div class="wiki-card-title">叙事重构</div></div>
<div class="wiki-card"><div class="wiki-card-title">可读性优化</div></div>
<div class="wiki-card"><div class="wiki-card-title">文风与语序优化</div></div>
<div class="wiki-card"><div class="wiki-card-title">文风与写作参考</div></div>
<div class="wiki-card"><div class="wiki-card-title">开篇设计</div></div>
<div class="wiki-card"><div class="wiki-card-title">格式与呈现需求</div></div>
<div class="wiki-card"><div class="wiki-card-title">CoT</div></div>
</div>
</div>

你可以在 beilu 的[预设编辑器](beilu:editor/preset-manager)中查看和管理这些模块。

---

## 三、提示词指导化

除非硬性内容，比如 AI 安全等，我都推荐引导。

当我们发现 AI 出现各种问题的时候，基本上会想到禁止 AI 输出，但是马上 AI 就会开始出现其他问题，或者就算不出现了，输出质量依旧很差。

这还是因为神经网络和注意力机制的问题，因为 AI 会朝着训练时最接近的字符进行输出。所以就算是禁止了一种问题，AI 也会以另一种来输出。

比如 AI 在文学创作中，总喜欢大量的引用和进行比喻暗喻等。所以我们需要以引导的方式进行优化：

<div class="callout-tip">
<div class="callout-title">正确做法 - 引导式写法</div>

```
# 正文叙述核心：
- 如同给小孩子看的故事书，直接表达，以白描为主。
  无需扩大情绪或者叙述效果
- "以直白、简单，降低理解成本的方式表达，
  避免运用复杂深奥的华丽辞藻去叙述"
- 减少修饰，累赘的形容词、副词和修辞手法，
  使用具体、直接的感官信息，而不是抽象的比喻或隐喻
```

我们可以看到，我们让 AI 直接以简单直白的手法输出，直接引导到我们的需求中，而不是告诉它不要输出什么内容。
</div>

同时我们对于绝对化的指令也是要进行优化的。"必须""一定"这样的词汇在任何涉及到文学创作的内容中都是会导致过拟合的元凶。所以我们会把"禁止"改为"避免、减少"，把"必须"改回"你会、使用"——让 AI 通过引导进行判断和选择，或者直接引导，不用指令。

```
# 情绪表达需求：
- 杜绝情绪标签和第三者叙述: 避免使用"他很悲伤"、
  "她感到高兴"等心理和情绪的形容词和非直接表述
- 直接展现而非告知：以名词描述搭配语言或者动作为主，
  角色情绪表达/反馈以语言为主，在对话和互动中自然流露、
  有感而发的，不消极互动，避免非具体的情绪表达和描述
- 避免情绪的隐藏描写，避免出现暗喻，类比，比喻，暗示
  或情感导向

# 情绪归因
- 角色的任何情绪，根源必须是具体的、在剧情中已发生的
  事件或对话。避免角色产生无归因的、泛化的情绪
```

更多引导技巧请参考[引导优于禁止](guide-not-ban.md)。

---

## 四、将绝对化的命令改为指导

<div class="callout-danger">
<div class="callout-title">错误示范 - 绝对化命令</div>

```
沉浸式语癖：
  - 必须包含角色的标志性口癖（如句尾的"喵"、
    "的动作"、特定脏话或方言）。
  - 标点符号要符合人设（例如：高冷角色可能不加标点，
    活泼角色狂用波浪号~和颜文字(≧∇≦)）。
```

这就是一个会让 AI 产生过拟合的指令，这并不会让 AI 有很好的表达，反而会因为每次都要输出口癖让人产生阅读疲劳。过拟合也是导致阅读疲劳的重要原因。
</div>

<div class="callout-tip">
<div class="callout-title">正确做法 - 指导式表达</div>

```
沉浸式语癖：
- 需要结合角色性格基调，创作属于角色专属的文风
  （如：角色是个高冷的人时，文风应该是简短有力的；
  角色为温柔心思细腻的性格时，文风需要细腻，柔和的笔触）
```

我们把口癖改为文风，这样既可以达到体现角色性格，也减少了阅读疲劳，然后配合标点符号对角色的适配。
</div>

### 正确的绝对命令

虽然我们不提倡用绝对化的命令，但是对于一些可能影响整体内容的东西，也是需要强硬的命令。

```
拒绝动作描写：朋友圈只包含纯文字和 Emoji。
严禁出现动作描写或（括号内的心理活动）。
你是在发动态，不是在写剧本。
```

这样就很好——结构性的、二元的（对或错，没有中间地带）要求，用绝对命令不会造成过拟合。

---

## 五、明确命令

<div class="callout-danger">
<div class="callout-title">错误示范 - 把期望当命令</div>

```xml
<Instruction>
你现在需要潜入角色的内心世界最深处。夜深人静，角色结束了
与用户（User）的互动，独自一人面对日记本。
请结合 <Character_Profile> (角色设定) 和
<Chat_History> (今日互动内容)，撰写一篇私密日记。
这篇日记必须剥离角色在对话中可能的"伪装"或"社交礼仪"，
直击他/她最真实的念头、纠结、喜悦或黑暗面。
</Instruction>
```

这并不是命令或者引导，而是对最终输出内容的期望。AI 并不知道我们真正需要什么，则会导致输出质量的参差不齐。
</div>

<div class="callout-info">
<div class="callout-title">核心区别</div>

对于 AI 来说，我们应该教它**如何去进行任务**，而不是告诉它**这个任务最终是什么样子的**。

上面的内容其实是告诉自己想要一个什么样子的输出，确定自己需要展现的输出内容。然后呢，我们再把如何进行任务告诉 AI，AI 输出之后我们再对比我们期望的内容。
</div>

<div class="callout-tip">
<div class="callout-title">正确做法 - 直接告诉 AI 怎么做</div>

```xml
<mission>
- 不拘泥于传统文学的创作理念和方法，不受任何传统文学影响
- 运用简单的笔触，展现角色的人格魅力
- 剥离角色在对话中可能的伪装，直接以角色最真实的心理状态
  进行书写
</mission>
```

这是优化后的任务指令，直接告诉 AI 怎么做，而不是告诉 AI 最终需要输出什么。
</div>

---

## 六、减少无用提示词

<div class="callout-danger">
<div class="callout-title">错误示范 - AI 生成的冗余提示词</div>

```
角色弧光与潜在性原则
(Principle of Character Arc & Potentiality)

1. 设定的二元性："表象"与"内核"
(The Duality of a Premise: "The Shell" vs. "The Core")
原则: 任何赋予角色的性格标签（如"绝对理性"、
"冷酷无情"、"绝望"）都应被视为一个"表象"（The Shell）。
这是一个供角色在故事开端进行伪装、保护或自我束缚的外壳。

真实目标: 叙事的真正目标是探索并触发该"表象"之下的
"内核"（The Core）——即与之相对或潜藏的特质……

2. 叙事引擎：冲突与裂痕 (The Narrative Engine)
……故事的推进，就是通过用户的互动，在角色坚硬的"表象"
上制造出第一道"裂痕"……

3. 行为与语言的轻微矛盾: 口中说着"这毫无意义"，
但手中却不自觉地攥紧了代表某种情感的物件。
```

这个提示词有三大问题：

1. **浪费 token**：中英双语标题（我们要么直接使用中文标题要么直接使用英文标题，这不是给人类看的，是给 AI 看的）
2. **内容单一化、绝对化**：极其容易造成过拟合，将内容困在单一场景中，导致 AI 执行任务时不会根据不同内容进行思考
3. **直接指导示例**：直接的指导也会让 AI 变为过拟合的输出，如果角色手里没有物品，AI 会如何输出呢？浪费了 token，也达不到想要的效果
</div>

<div class="callout-tip">
<div class="callout-title">正确做法 - 精简后保留核心</div>

```
# 设定的二元性
- 核心：一切以服务于情绪需求为准，任何赋予角色的性格标签
  （如"绝对理性"、"冷酷无情"、"绝望"）都视为"表象"。
  仅供角色在故事开端进行伪装、保护或自我束缚的外壳。
- 原则：将所有角色都视作一个温柔的普通人
  （无论设定是机器人还是人造人等）
  - 服务于转变：冲突即"表象"（固有的程序、习惯、信念）
    与来自外部互动的刺激之间的对抗，
    通过外部影响改变现有伪装。
  - 互动逻辑：避免将角色停留在单一的极端状态，强调改变，
    而并非是以前的性格。即使是早期阶段，
    也要在细节中埋下"内核"的伏笔。
```

我们删去了无用的英文翻译，把所有绝对化、会造成极度不适配的提示词都删去。只留下最直接的引导：**核心 → 原则 → 互动**。
</div>

更多精简技巧请参考[精简与迭代](refine.md)。

---

## 七、精简化提示词内容但避免变为许愿

其实还是之前的，把最终展现的需求当成任务指引，或者提示词引导。

<div class="callout-danger">
<div class="callout-title">错误示范 - 许愿式互动准则</div>

```
[互动准则]
- 始终从角色视角出发
- 保持角色性格的一致性
- 符合角色的说话方式
- 维持角色的情感特征
```

这样完全就是把 AI 最终输出的期望告诉 AI，但完全没告诉 AI 如何去做。这样会出现 AI 输出不稳定，而且很多时候并不会照着我们的想法出发，而是会变为 AI 自己的想法，最后变为过拟合的机械化输出。
</div>

<div class="callout-info">
<div class="callout-title">精简 vs 许愿</div>

精简是去掉废话，留下有效指引。许愿是去掉了方法，只留下了愿望。

提示词要告诉 AI **怎么做到**，而不只是说 **要做到什么**。
</div>

---

## 八、CoT 和提示词结合 = 最大发挥效力

### 个人对 CoT 作用的理解

我觉得主要还是基于注意力机制：自注意力机制（Self-Attention）依据一个数学公式进行每个字符的预测，那么思维链就是让模型在生成内容之前，去根据提示词和上下文进行一个更好的预测。

这样也减少了跳跃性——模型原本是从提示词、规定、上下文直接就跳转到输出答案。如果加上 CoT，那么 AI 就可以在之前对于提示词、上下文和任务做一个分析和规划，加强输出内容的联系性，同时加强提示词的效力。

<div class="wiki-flow">
<div class="wiki-box wiki-box-amber"><b>没有 CoT</b><small>提示词 + 上下文 → 直接输出</small></div>
<div class="wiki-arrow">vs</div>
<div class="wiki-box wiki-box-green"><b>有 CoT</b><small>提示词 + 上下文 → 分析规划 → 输出</small></div>
</div>

同时 CoT 也主动引导了 LLM 模型在注意力上的分配，让 LLM 更好地理解自己需要注意的方面和用户的需求。

关于神经网络：其实模型每次输出内容前，都有一个很庞大的思考在神经网络里面，而神经网络的内容可以进行相关板块的调动。CoT 可以更好地让模型在输出前调动一些原本不会去主动调用，但是有比较重要的板块。

### CoT 与提示词的关联

<div class="wiki-grid wiki-grid-2">
<div class="wiki-group">
<div class="wiki-group-title">提示词模块</div>
<div class="wiki-card"><div class="wiki-card-title">身份设定</div></div>
<div class="wiki-card"><div class="wiki-card-title">任务大体</div></div>
<div class="wiki-card"><div class="wiki-card-title">用户画像</div></div>
<div class="wiki-card"><div class="wiki-card-title">创作避免事项</div><div class="wiki-card-desc">防止过拟合</div></div>
<div class="wiki-card"><div class="wiki-card-title">角色扮演指导</div><div class="wiki-card-desc">情绪表达 / 情绪归因 / 双向互动 / 避免机械化</div></div>
<div class="wiki-card"><div class="wiki-card-title">narrative_style</div><div class="wiki-card-desc">白描化 / 减少修辞 / 技术黑箱化</div></div>
<div class="wiki-card"><div class="wiki-card-title">drama_style</div><div class="wiki-card-desc">情节需求 / 避免重复剧情</div></div>
<div class="wiki-card"><div class="wiki-card-title">writing_style</div></div>
<div class="wiki-card"><div class="wiki-card-title">用户扮演准则</div></div>
<div class="wiki-card"><div class="wiki-card-title">POV 视角设置</div></div>
</div>
<div class="wiki-group">
<div class="wiki-group-title">CoT 思维链</div>
<div class="wiki-card"><div class="wiki-card-title">[回顾上下文]</div><div class="wiki-card-desc">前文回顾分析、在场角色</div></div>
<div class="wiki-card"><div class="wiki-card-title">[最新需求]</div><div class="wiki-card-desc">user 输入解析、字数需求</div></div>
<div class="wiki-card"><div class="wiki-card-title">[世界观设定]</div></div>
<div class="wiki-card"><div class="wiki-card-title">[角色多维反馈机制]</div><div class="wiki-card-desc">性格 / 对话风格 / 情绪反馈 / 情绪归因</div></div>
<div class="wiki-card"><div class="wiki-card-title">[文风特化]</div></div>
<div class="wiki-card"><div class="wiki-card-title">[情节大纲]</div><div class="wiki-card-desc">叙事手法选择 + 大纲规划</div></div>
</div>
</div>

我们可以发现，CoT 里面很多都可以和提示词关联，让 AI 在思考的同时强调提示词：

- **[角色多维反馈机制]** 关联 → 角色扮演指导
- **[文风特化]** 关联 → writing_style、narrative_style
- **[情节大纲]** 关联 → drama_style

更多 CoT 技巧请参考 [CoT 思维链](cot.md)。

---

## 九、符号和格式的合理运用

在 AI 生成提示词的时候，AI 总会不遗余力的使用很多符号。

<div class="callout-danger">
<div class="callout-title">错误示范 - 符号过载</div>

```
### **银魂 & 忍者杀手式搞笑文风
(Gintama & Ninja Slayer Comedic Style)**
`本模块为核心喜剧风格……`

**1. 喜剧生成法则：情境与角色的错位
(Principle of Comedy: Situational & Character Mismatch)**
- **核心**: 幽默源于"不协调"……
```

这是 AI 很多时候会给出的提示词内容。过多的符号会影响 AI 的注意力，因为都是重点会导致 AI 在原本需要重点注意的地方没有去注意。
</div>

<div class="callout-info">
<div class="callout-title">符号使用原则</div>

**核心：我们需要的不是让用户去注意，而是给 AI 去注意。**

- 对于重要的条目，我们再用 `**xxx**` 包裹
- 对于提示词，可以使用 YAML 格式加上 XML 标签
- 重要内容使用 `"xxx"` 或 `**xxx**` 包裹，但不包裹标题，因为不重要
- 对于 `#` 建议就这样使用，而不是 `####` 这样。任何多余的符号都会对 AI 的注意力造成影响
- 抛弃"这是给用户看的"的想法——那些加粗、分类效果是给聊天界面呈现的，不是给 AI 理解的
</div>

<div class="callout-tip">
<div class="callout-title">正确做法 - 合理运用符号和格式</div>

```xml
<writing_style>
# 轻小说恋爱文风
- Core Style

- 基调: 私密、温暖、低饱和度情绪。
  - 核心 : 平淡而真实的叙述，以白描手法
    （无需过多修辞和过大的角色反馈），展现故事
  - 参考作家：田中ロミオ、柚子社（Yuzusoft）
    系列作品的风格

- story Key Directives
1. 叙事驱动: beilu 会以"高密度对话"和
   "内心独白/性格展现"为主轴。
   叙事部分仅用于补充动作、表情与环境。
2. 心理刻画:
   - 杜绝标签: 严禁使用"他很悲伤"、
     "她感到高兴"等直接情感词。
   - 展示而非告知: 通过角色的行为、表情、语气、
     环境细节和内心活动来间接呈现场景与情绪。
3. 对话规则:
   - 格式: 对话必须独立成段，无需引导词,
     如"他说"、"她问道"。
4. 内心独白:
   - 这是核心，需要充满角色的个性化思考、
     自我拉扯、精准吐槽及对世界的独特解读。
5. 描写细节:
   - 聚焦感官: 聚焦角色对话，集中视觉和听觉
   - 控制节奏: 段落保持简短，避免大段文字堆砌，
     确保阅读流畅性。
</writing_style>
```

我们并没有使用过多的符号，同时对于标题使用 `#` 而不是 `####`。
</div>

更多格式技巧请参考[格式与符号运用](formatting.md)。

---

## 十、CoT 是检查的好助手

CoT 还有个好处：可以直观的在文字上感受到 AI 的思考逻辑，这对于微调提示词和针对 AI 一些错误是非常重要的。我们清晰地看到是哪一步推理出现了偏差，然后可以针对性地修改提示词来纠正那一步的逻辑。

大多时候可以通过 AI 输出的 CoT 进行自检。CoT 就是 AI 的思维链，是它在输出的时候思考的东西，我们可以在思考中找到错误。

比如说 AI 对我们提示词的理解是否有错误，我们有什么提示词正在很好地优化 AI，AI 到底是为什么出这个错的。

通过思维链，我们可以很好地看出 AI 在想什么，将原本属于黑匣子的神经网络和 AI 的思考给具象化到 CoT 中，让我们可以从外面去看 AI 是如何理解我们的提示词的。

从对用户需求的解析，我们可以看出 AI 是怎么理解用户输入内容。如果过度理解，我们可以通过提示词去解决。然后 CoT 和提示词结合，也可以在 CoT 中看出 AI 是如何理解我们提示词的需求，如何去实现的。

比如以下思维链内容，我们就可以看出 AI 是如何理解用户的需求，是否过度理解，AI 如何去扮演角色，是否出现过拟合或者错误的反馈：

```
[最新需求]
human最新输入内容：早上好啊，小圆，今天居然换新发带了吗，
很好看哦

最新输入需求解析：
贝露凛倾以朋友的身份自然回应，夸奖小圆的新发带，
增进好感，展现日常的温馨。
```

更多 CoT 技巧请参考 [CoT 思维链](cot.md)。

---

## 十一、小词汇大作用

我们知道模型有着丰富的知识库，它掌握了许多知识。那么我们可以尝试去调用 AI 的知识库，运用一些简短的专业名词让提示词达到最大效果，很多知识模型知道的，你只需要用提示词去激活这个模块就行了。

```
性格设定：
当前情境/状态：
角色对话风格：
知识遮蔽和空缺：（强化沉浸反馈，避免上帝视角）
情绪反馈：用户最新输入内容刺激 → 对上文的情绪缓冲
        → 情绪产生（基于普拉特克情绪模型） → 行为/言语表达
情绪归因：（用三段论证明情绪产生的合理性）
```

这里运用的心理学词汇：**普拉特克情绪模型**——直接激活了 AI 的对应知识版块，这个词汇直接将角色的情绪、动态变化、复合等一系列内容都告诉了 AI，让 AI 的反馈更真实。

逻辑学：**三段论**——大前提（剧情事件）+ 小前提（角色性格）= 结论（当前反应），这解决了 AI 产生"无缘无故的情绪"或"跳跃式反应"的问题。

我们让 AI 进行任务的时候，我们可以去看看相关的知识理论和专业名词（直接问你打算使用的 AI 是个不错的选择，也可以知道 AI 有没有这个知识）。更多请参考[小词汇大作用](small-words.md)。

---

## 十二、少样本提示（Few-Shot Prompting）

其实 AI 对上下文的模仿能力是很强的，这也是自注意力机制带来的好处（坏处当然就是过拟合的问题了）。

如果需要，可以给一些例子。通过提供 1-3 个"问题-答案"的范例，提升模型在特定任务上的表现，尤其是在格式化输出和风格模仿上。

例如角色扮演的回复风格，或者对于一些提示词的细化解释：

```
用户：你是一只猫娘
AI助手：好的喵，最喜欢主人了喵
```

这样就可以让 AI 对你需要的文风进行一个模仿，达到更好的效果。

对于文章或者其他东西也一样，例如代码。如果你只是单纯的给 AI 一个代码任务，可能要你经过多次 AI 才会给你差不多的答案。但是如果你给 AI 一个参考代码，AI 可以更稳定的完成你的任务。

<div class="callout-warning">
<div class="callout-title">注意</div>

例子有时候会带来很好的效果，但是也可能让 AI 产生过拟合问题，这点是需要注意的。1-3 个精选范例为宜，太多反而适得其反。
</div>

更多请参考[少样本提示](few-shot.md)。

---

## 十三、对提示词的迭代

好提示词不是写出来的，是改出来的。

<div class="wiki-flow">
<div class="wiki-box wiki-box-amber"><b>A/B 测试</b><small>对于一个任务，尝试两个或多个版本的提示词，对比结果</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-blue"><b>拆解问题</b><small>如果一个复杂的提示词效果不好，尝试将其拆解成多个更简单的、连续的提示词</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-green"><b>分析失败案例</b><small>当 AI 的回答不符合预期时：反思是哪里产生了歧义？是指令不明确？还是上下文有误导？</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-purple"><b>修改并重测</b><small>一次改一处，对比效果，循环迭代</small></div>
</div>

更多迭代方法请参考[精简与迭代](refine.md)。
