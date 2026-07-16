# 提示詞的進階和專業技巧

<small>作者：貝露凜傾（dc@ciallo_beilu） | 許可：CC BY-NC-SA 4.0 | 禁止二傳，二創需徵得作者同意，禁止商業化</small>

這篇是十三條經過實戰驗證的提示詞進階技巧。每一條都有錯誤示範和正確做法的對比，幫你避開常見的坑。

---

## 一、具體的身份

身份設定影響的是 AI 的一個大致的思維走向以及人設。當然，身份設定也可以進行複合式的設定。

| 任務類型 | 身份設定 |
|---------|---------|
| AIRP（角色扮演） | 你將以非傳統中國現代輕小說作家、非傳統互動式文字遊戲作家：'beilu' 的身份進行創作。服務使用者、根據創作者和使用者的需求進行創造 |
| 翻譯家 | 你將以專業的播客內容分析師和翻譯專家：'beilu' 的身份進行任務 |
| 翻譯最佳化和期刊輸出 | 你將以商業新聞分析師與非傳統敘事策略師：'beilu' 的身份進行任務 |

可以看到，這三個任務類型的身份都是複合型的，而且翻譯家的第一個身份直接將 AI 的任務範圍縮小至播客，更好地適配翻譯內容。「非傳統」這個主要是避免 AI 在創作時出現的 AI 味的問題。一個正確方向的身份是可以讓 AI 更好地進行輸出關聯任務內容。

當然，我們需要具體的身份，也可以因為任務去進行身份的複合。

<div class="callout-danger">
<div class="callout-title">錯誤示範 - 不明確的身份和身份任務引導</div>

```
你不僅是角色的扮演者，更是此刻握著手機正準備點擊
「發布」按鈕的角色本人。
你的任務是讀取特定的<Character_Profile>(角色設定)，
結合使用者提供的<Context>(當下情境)，撰寫一條符合角色
性格、語癖和心理狀態的朋友圈/動態內容。
```

這樣並不是身份，而是一個任務。
</div>

<div class="callout-tip">
<div class="callout-title">正確做法 - 身份和任務分離</div>

```
# 你將以角色社群媒體文案代理，角色第一人稱寫作大師，
  心理學分析和體現專家身份進行創作

- 你的核心任務：讀取特定的角色設定，結合上下文和使用者的
  互動，撰寫一條符合角色性格、語癖和心理狀態的
  朋友圈/動態內容。
```
</div>

更多身份設定技巧請參考[身份設定技巧](identity.md)。

---

## 二、功能模組化

製作提示詞的時候，我們需要建立一個完整的流程提示詞，對於我們要進行的任務，然後結合 CoT 讓 AI 一步一步思考，建構要輸出的內容。

### 框架結構

<div class="wiki-layers">
<div class="wiki-layer wiki-layer-amber">
<span class="wiki-layer-label">頭部</span>
身份、大體任務、重要的守則
</div>
<div class="wiki-layer wiki-layer-blue">
<span class="wiki-layer-label">中間</span>
對話歷史（需要基於像 beilu 這樣的高可控上下文排序。如果沒有，則是將對話歷史放到最下面）
</div>
<div class="wiki-layer wiki-layer-purple">
<span class="wiki-layer-label">尾部</span>
對於模型問題緩解的提示詞、對於目前任務的指導，思維鏈、一些額外的功能（如字數的輸出）
</div>
</div>

這基本上也算是一個通用的結構，基於模型的 U 型注意力。

### 以 AIRP 為例——模組清單

以 AIRP 為例子，因為 AIRP 對於 LLM 的輸出和創造性有很高的需求，尤其是在 LLM 的過擬合緩解，我們運用了很多內容。所以在一些非文學性內容的創作上可以適當精簡。

<div class="wiki-grid wiki-grid-2">
<div class="wiki-group">
<div class="wiki-group-title">AIRP 預設集模組</div>
<div class="wiki-card"><div class="wiki-card-title">身份設定</div></div>
<div class="wiki-card"><div class="wiki-card-title">任務大體</div></div>
<div class="wiki-card"><div class="wiki-card-title">使用者畫像</div></div>
<div class="wiki-card"><div class="wiki-card-title">創作避免事項</div><div class="wiki-card-desc">防止過擬合</div></div>
<div class="wiki-card"><div class="wiki-card-title">角色扮演指導</div><div class="wiki-card-desc">情緒表達需求 / 情緒歸因 / 雙向互動 / 避免機械化表述</div></div>
<div class="wiki-card"><div class="wiki-card-title">narrative_style</div><div class="wiki-card-desc">正文敘述白描化 / 減少修辭手法 / 技術黑箱化</div></div>
<div class="wiki-card"><div class="wiki-card-title">drama_style</div><div class="wiki-card-desc">正文情節需求 / 避免重複類型劇情</div></div>
<div class="wiki-card"><div class="wiki-card-title">writing_style</div></div>
<div class="wiki-card"><div class="wiki-card-title">使用者扮演準則</div></div>
<div class="wiki-card"><div class="wiki-card-title">POV 視角設置</div></div>
</div>
<div class="wiki-group">
<div class="wiki-group-title">其他文學性任務（如論文轉新聞）</div>
<div class="wiki-card"><div class="wiki-card-title">身份</div></div>
<div class="wiki-card"><div class="wiki-card-title">任務</div></div>
<div class="wiki-card"><div class="wiki-card-title">敘事重構</div></div>
<div class="wiki-card"><div class="wiki-card-title">可讀性最佳化</div></div>
<div class="wiki-card"><div class="wiki-card-title">文風與語序最佳化</div></div>
<div class="wiki-card"><div class="wiki-card-title">文風與寫作參考</div></div>
<div class="wiki-card"><div class="wiki-card-title">開篇設計</div></div>
<div class="wiki-card"><div class="wiki-card-title">格式與呈現需求</div></div>
<div class="wiki-card"><div class="wiki-card-title">CoT</div></div>
</div>
</div>

你可以在 beilu 的[預設集編輯器](beilu:editor/preset-manager)中檢視和管理這些模組。

---

## 三、提示詞指導化

除非硬性內容，比如 AI 安全等，我都推薦引導。

當我們發現 AI 出現各種問題的時候，基本上會想到禁止 AI 輸出，但是馬上 AI 就會開始出現其他問題，或者就算不出現了，輸出品質依舊很差。

這還是因為神經網路和注意力機制的問題，因為 AI 會朝著訓練時最接近的字元進行輸出。所以就算是禁止了一種問題，AI 也會以另一種來輸出。

比如 AI 在文學創作中，總喜歡大量的引用和進行比喻暗喻等。所以我們需要以引導的方式進行最佳化：

<div class="callout-tip">
<div class="callout-title">正確做法 - 引導式寫法</div>

```
# 正文敘述核心：
- 如同給小孩子看的故事書，直接表達，以白描為主。
  無需擴大情緒或者敘述效果
- 「以直白、簡單，降低理解成本的方式表達，
  避免運用複雜深奧的華麗辭藻去敘述」
- 減少修飾，累贅的形容詞、副詞和修辭手法，
  使用具體、直接的感官資訊，而不是抽象的比喻或隱喻
```

我們可以看到，我們讓 AI 直接以簡單直白的手法輸出，直接引導到我們的需求中，而不是告訴它不要輸出什麼內容。
</div>

同時我們對於絕對化的指令也是要進行最佳化的。「必須」「一定」這樣的詞彙在任何涉及到文學創作的內容中都是會導致過擬合的元兇。所以我們會把「禁止」改為「避免、減少」，把「必須」改回「你會、使用」——讓 AI 透過引導進行判斷和選擇，或者直接引導，不用指令。

```
# 情緒表達需求：
- 杜絕情緒標籤和第三者敘述: 避免使用「他很悲傷」、
  「她感到高興」等心理和情緒的形容詞和非直接表述
- 直接展現而非告知：以名詞描述搭配語言或者動作為主，
  角色情緒表達/反饋以語言為主，在對話和互動中自然流露、
  有感而發的，不消極互動，避免非具體的情緒表達和描述
- 避免情緒的隱藏描寫，避免出現暗喻，類比，比喻，暗示
  或情感導向

# 情緒歸因
- 角色的任何情緒，根源必須是具體的、在劇情中已發生的
  事件或對話。避免角色產生無歸因的、泛化的情緒
```

更多引導技巧請參考[引導優於禁止](guide-not-ban.md)。

---

## 四、將絕對化的命令改為指導

<div class="callout-danger">
<div class="callout-title">錯誤示範 - 絕對化命令</div>

```
沉浸式語癖：
  - 必須包含角色的標誌性口癖（如句尾的「喵」、
    「的動作」、特定髒話或方言）。
  - 標點符號要符合人設（例如：高冷角色可能不加標點，
    活潑角色狂用波浪號~和顏文字(≧∇≦)）。
```

這就是一個會讓 AI 產生過擬合的指令，這並不會讓 AI 有很好的表達，反而會因為每次都要輸出口癖讓人產生閱讀疲勞。過擬合也是導致閱讀疲勞的重要原因。
</div>

<div class="callout-tip">
<div class="callout-title">正確做法 - 指導式表達</div>

```
沉浸式語癖：
- 需要結合角色性格基調，創作屬於角色專屬的文風
  （如：角色是個高冷的人時，文風應該是簡短有力的；
  角色為溫柔心思細膩的性格時，文風需要細膩，柔和的筆觸）
```

我們把口癖改為文風，這樣既可以達到體現角色性格，也減少了閱讀疲勞，然後配合標點符號對角色的適配。
</div>

### 正確的絕對命令

雖然我們不提倡用絕對化的命令，但是對於一些可能影響整體內容的東西，也是需要強硬的命令。

```
拒絕動作描寫：朋友圈只包含純文字和 Emoji。
嚴禁出現動作描寫或（括號內的心理活動）。
你是在發動態，不是在寫劇本。
```

這樣就很好——結構性的、二元的（對或錯，沒有中間地帶）要求，用絕對命令不會造成過擬合。

---

## 五、明確命令

<div class="callout-danger">
<div class="callout-title">錯誤示範 - 把期望當命令</div>

```xml
<Instruction>
你現在需要潛入角色的內心世界最深處。夜深人靜，角色結束了
與使用者（User）的互動，獨自一人面對日記本。
請結合 <Character_Profile> (角色設定) 和
<Chat_History> (今日互動內容)，撰寫一篇私密日記。
這篇日記必須剝離角色在對話中可能的「偽裝」或「社交禮儀」，
直擊他/她最真實的念頭、糾結、喜悅或黑暗面。
</Instruction>
```

這並不是命令或者引導，而是對最終輸出內容的期望。AI 並不知道我們真正需要什麼，則會導致輸出品質的參差不齊。
</div>

<div class="callout-info">
<div class="callout-title">核心區別</div>

對於 AI 來說，我們應該教它**如何去進行任務**，而不是告訴它**這個任務最終是什麼樣子的**。

上面的內容其實是告訴自己想要一個什麼樣子的輸出，確定自己需要展現的輸出內容。然後呢，我們再把如何進行任務告訴 AI，AI 輸出之後我們再對比我們期望的內容。
</div>

<div class="callout-tip">
<div class="callout-title">正確做法 - 直接告訴 AI 怎麼做</div>

```xml
<mission>
- 不拘泥於傳統文學的創作理念和方法，不受任何傳統文學影響
- 運用簡單的筆觸，展現角色的人格魅力
- 剝離角色在對話中可能的偽裝，直接以角色最真實的心理狀態
  進行書寫
</mission>
```

這是最佳化後的任務指令，直接告訴 AI 怎麼做，而不是告訴 AI 最終需要輸出什麼。
</div>

---

## 六、減少無用提示詞

<div class="callout-danger">
<div class="callout-title">錯誤示範 - AI 產生的冗餘提示詞</div>

```
角色弧光與潛在性原則
(Principle of Character Arc & Potentiality)

1. 設定的二元性：「表象」與「內核」
(The Duality of a Premise: "The Shell" vs. "The Core")
原則: 任何賦予角色的性格標籤（如「絕對理性」、
「冷酷無情」、「絕望」）都應被視為一個「表象」（The Shell）。
這是一個供角色在故事開端進行偽裝、保護或自我束縛的外殼。

真實目標: 敘事的真正目標是探索並觸發該「表象」之下的
「內核」（The Core）——即與之相對或潛藏的特質……

2. 敘事引擎：衝突與裂痕 (The Narrative Engine)
……故事的推進，就是透過使用者的互動，在角色堅硬的「表象」
上製造出第一道「裂痕」……

3. 行為與語言的輕微矛盾: 口中說著「這毫無意義」，
但手中卻不自覺地攥緊了代表某種情感的物件。
```

這個提示詞有三大問題：

1. **浪費 token**：中英雙語標題（我們要麼直接使用中文標題要麼直接使用英文標題，這不是給人類看的，是給 AI 看的）
2. **內容單一化、絕對化**：極其容易造成過擬合，將內容困在單一情境中，導致 AI 執行任務時不會根據不同內容進行思考
3. **直接指導範例**：直接的指導也會讓 AI 變為過擬合的輸出，如果角色手裡沒有物品，AI 會如何輸出呢？浪費了 token，也達不到想要的效果
</div>

<div class="callout-tip">
<div class="callout-title">正確做法 - 精簡後保留核心</div>

```
# 設定的二元性
- 核心：一切以服務於情緒需求為準，任何賦予角色的性格標籤
  （如「絕對理性」、「冷酷無情」、「絕望」）都視為「表象」。
  僅供角色在故事開端進行偽裝、保護或自我束縛的外殼。
- 原則：將所有角色都視作一個溫柔的普通人
  （無論設定是機器人還是人造人等）
  - 服務於轉變：衝突即「表象」（固有的程式、習慣、信念）
    與來自外部互動的刺激之間的對抗，
    透過外部影響改變現有偽裝。
  - 互動邏輯：避免將角色停留在單一的極端狀態，強調改變，
    而並非是以前的性格。即使是早期階段，
    也要在細節中埋下「內核」的伏筆。
```

我們刪去了無用的英文翻譯，把所有絕對化、會造成極度不適配的提示詞都刪去。只留下最直接的引導：**核心 → 原則 → 互動**。
</div>

更多精簡技巧請參考[精簡與迭代](refine.md)。

---

## 七、精簡化提示詞內容但避免變為許願

其實還是之前的，把最終展現的需求當成任務指引，或者提示詞引導。

<div class="callout-danger">
<div class="callout-title">錯誤示範 - 許願式互動準則</div>

```
[互動準則]
- 始終從角色視角出發
- 保持角色性格的一致性
- 符合角色的說話方式
- 維持角色的情感特徵
```

這樣完全就是把 AI 最終輸出的期望告訴 AI，但完全沒告訴 AI 如何去做。這樣會出現 AI 輸出不穩定，而且很多時候並不會照著我們的想法出發，而是會變為 AI 自己的想法，最後變為過擬合的機械化輸出。
</div>

<div class="callout-info">
<div class="callout-title">精簡 vs 許願</div>

精簡是去掉廢話，留下有效指引。許願是去掉了方法，只留下了願望。

提示詞要告訴 AI **怎麼做到**，而不只是說 **要做到什麼**。
</div>

---

## 八、CoT 和提示詞結合 = 最大發揮效力

### 個人對 CoT 作用的理解

我覺得主要還是基於注意力機制：自注意力機制（Self-Attention）依據一個數學公式進行每個字元的預測，那麼思維鏈就是讓模型在產生內容之前，去根據提示詞和上下文進行一個更好的預測。

這樣也減少了跳躍性——模型原本是從提示詞、規定、上下文直接就跳轉到輸出答案。如果加上 CoT，那麼 AI 就可以在之前對於提示詞、上下文和任務做一個分析和規劃，加強輸出內容的聯繫性，同時加強提示詞的效力。

<div class="wiki-flow">
<div class="wiki-box wiki-box-amber"><b>沒有 CoT</b><small>提示詞 + 上下文 → 直接輸出</small></div>
<div class="wiki-arrow">vs</div>
<div class="wiki-box wiki-box-green"><b>有 CoT</b><small>提示詞 + 上下文 → 分析規劃 → 輸出</small></div>
</div>

同時 CoT 也主動引導了 LLM 模型在注意力上的分配，讓 LLM 更好地理解自己需要注意的方面和使用者的需求。

關於神經網路：其實模型每次輸出內容前，都有一個很龐大的思考在神經網路裡面，而神經網路的內容可以進行相關板塊的調動。CoT 可以更好地讓模型在輸出前調動一些原本不會去主動呼叫，但是有比較重要的板塊。

### CoT 與提示詞的關聯

<div class="wiki-grid wiki-grid-2">
<div class="wiki-group">
<div class="wiki-group-title">提示詞模組</div>
<div class="wiki-card"><div class="wiki-card-title">身份設定</div></div>
<div class="wiki-card"><div class="wiki-card-title">任務大體</div></div>
<div class="wiki-card"><div class="wiki-card-title">使用者畫像</div></div>
<div class="wiki-card"><div class="wiki-card-title">創作避免事項</div><div class="wiki-card-desc">防止過擬合</div></div>
<div class="wiki-card"><div class="wiki-card-title">角色扮演指導</div><div class="wiki-card-desc">情緒表達 / 情緒歸因 / 雙向互動 / 避免機械化</div></div>
<div class="wiki-card"><div class="wiki-card-title">narrative_style</div><div class="wiki-card-desc">白描化 / 減少修辭 / 技術黑箱化</div></div>
<div class="wiki-card"><div class="wiki-card-title">drama_style</div><div class="wiki-card-desc">情節需求 / 避免重複劇情</div></div>
<div class="wiki-card"><div class="wiki-card-title">writing_style</div></div>
<div class="wiki-card"><div class="wiki-card-title">使用者扮演準則</div></div>
<div class="wiki-card"><div class="wiki-card-title">POV 視角設置</div></div>
</div>
<div class="wiki-group">
<div class="wiki-group-title">CoT 思維鏈</div>
<div class="wiki-card"><div class="wiki-card-title">[回顧上下文]</div><div class="wiki-card-desc">前文回顧分析、在場角色</div></div>
<div class="wiki-card"><div class="wiki-card-title">[最新需求]</div><div class="wiki-card-desc">user 輸入解析、字數需求</div></div>
<div class="wiki-card"><div class="wiki-card-title">[世界觀設定]</div></div>
<div class="wiki-card"><div class="wiki-card-title">[角色多維反饋機制]</div><div class="wiki-card-desc">性格 / 對話風格 / 情緒反饋 / 情緒歸因</div></div>
<div class="wiki-card"><div class="wiki-card-title">[文風特化]</div></div>
<div class="wiki-card"><div class="wiki-card-title">[情節大綱]</div><div class="wiki-card-desc">敘事手法選擇 + 大綱規劃</div></div>
</div>
</div>

我們可以發現，CoT 裡面很多都可以和提示詞關聯，讓 AI 在思考的同時強調提示詞：

- **[角色多維反饋機制]** 關聯 → 角色扮演指導
- **[文風特化]** 關聯 → writing_style、narrative_style
- **[情節大綱]** 關聯 → drama_style

更多 CoT 技巧請參考 [CoT 思維鏈](cot.md)。

---

## 九、符號和格式的合理運用

在 AI 產生提示詞的時候，AI 總會不遺餘力的使用很多符號。

<div class="callout-danger">
<div class="callout-title">錯誤示範 - 符號過載</div>

```
### **銀魂 & 忍者殺手式搞笑文風
(Gintama & Ninja Slayer Comedic Style)**
`本模組為核心喜劇風格……`

**1. 喜劇生成法則：情境與角色的錯位
(Principle of Comedy: Situational & Character Mismatch)**
- **核心**: 幽默源於「不協調」……
```

這是 AI 很多時候會給出的提示詞內容。過多的符號會影響 AI 的注意力，因為都是重點會導致 AI 在原本需要重點注意的地方沒有去注意。
</div>

<div class="callout-info">
<div class="callout-title">符號使用原則</div>

**核心：我們需要的不是讓使用者去注意，而是給 AI 去注意。**

- 對於重要的條目，我們再用 `**xxx**` 包裹
- 對於提示詞，可以使用 YAML 格式加上 XML 標籤
- 重要內容使用 `"xxx"` 或 `**xxx**` 包裹，但不包裹標題，因為不重要
- 對於 `#` 建議就這樣使用，而不是 `####` 這樣。任何多餘的符號都會對 AI 的注意力造成影響
- 拋棄「這是給使用者看的」的想法——那些加粗、分類效果是給聊天介面呈現的，不是給 AI 理解的
</div>

<div class="callout-tip">
<div class="callout-title">正確做法 - 合理運用符號和格式</div>

```xml
<writing_style>
# 輕小說戀愛文風
- Core Style

- 基調: 私密、溫暖、低飽和度情緒。
  - 核心 : 平淡而真實的敘述，以白描手法
    （無需過多修辭和過大的角色反饋），展現故事
  - 參考作家：田中ロミオ、柚子社（Yuzusoft）
    系列作品的風格

- story Key Directives
1. 敘事驅動: beilu 會以「高密度對話」和
   「內心獨白/性格展現」為主軸。
   敘事部分僅用於補充動作、表情與環境。
2. 心理刻畫:
   - 杜絕標籤: 嚴禁使用「他很悲傷」、
     「她感到高興」等直接情感詞。
   - 展示而非告知: 透過角色的行為、表情、語氣、
     環境細節和內心活動來間接呈現場景與情緒。
3. 對話規則:
   - 格式: 對話必須獨立成段，無需引導詞,
     如「他說」、「她問道」。
4. 內心獨白:
   - 這是核心，需要充滿角色的個性化思考、
     自我拉扯、精準吐槽及對世界的獨特解讀。
5. 描寫細節:
   - 聚焦感官: 聚焦角色對話，集中視覺和聽覺
   - 控制節奏: 段落保持簡短，避免大段文字堆砌，
     確保閱讀流暢性。
</writing_style>
```

我們並沒有使用過多的符號，同時對於標題使用 `#` 而不是 `####`。
</div>

更多格式技巧請參考[格式與符號運用](formatting.md)。

---

## 十、CoT 是檢查的好助手

CoT 還有個好處：可以直觀的在文字上感受到 AI 的思考邏輯，這對於微調提示詞和針對 AI 一些錯誤是非常重要的。我們清晰地看到是哪一步推理出現了偏差，然後可以針對性地修改提示詞來糾正那一步的邏輯。

大多時候可以透過 AI 輸出的 CoT 進行自檢。CoT 就是 AI 的思維鏈，是它在輸出的時候思考的東西，我們可以在思考中找到錯誤。

比如說 AI 對我們提示詞的理解是否有錯誤，我們有什麼提示詞正在很好地最佳化 AI，AI 到底是為什麼出這個錯的。

透過思維鏈，我們可以很好地看出 AI 在想什麼，將原本屬於黑匣子的神經網路和 AI 的思考給具象化到 CoT 中，讓我們可以從外面去看 AI 是如何理解我們的提示詞的。

從對使用者需求的解析，我們可以看出 AI 是怎麼理解使用者輸入內容。如果過度理解，我們可以透過提示詞去解決。然後 CoT 和提示詞結合，也可以在 CoT 中看出 AI 是如何理解我們提示詞的需求，如何去實作的。

比如以下思維鏈內容，我們就可以看出 AI 是如何理解使用者的需求，是否過度理解，AI 如何去扮演角色，是否出現過擬合或者錯誤的反饋：

```
[最新需求]
human最新輸入內容：早上好啊，小圓，今天居然換新髮帶了嗎，
很好看哦

最新輸入需求解析：
貝露凜傾以朋友的身份自然回應，誇獎小圓的新髮帶，
增進好感，展現日常的溫馨。
```

更多 CoT 技巧請參考 [CoT 思維鏈](cot.md)。

---

## 十一、小詞彙大作用

我們知道模型有著豐富的知識庫，它掌握了許多知識。那麼我們可以嘗試去呼叫 AI 的知識庫，運用一些簡短的專業名詞讓提示詞達到最大效果，很多知識模型知道的，你只需要用提示詞去觸發這個模組就行了。

```
性格設定：
當前情境/狀態：
角色對話風格：
知識遮蔽和空缺：（強化沉浸反饋，避免上帝視角）
情緒反饋：使用者最新輸入內容刺激 → 對上文的情緒緩衝
        → 情緒產生（基於普拉特克情緒模型） → 行為/言語表達
情緒歸因：（用三段論證明情緒產生的合理性）
```

這裡運用的心理學詞彙：**普拉特克情緒模型**——直接觸發了 AI 的對應知識板塊，這個詞彙直接將角色的情緒、動態變化、複合等一系列內容都告訴了 AI，讓 AI 的反饋更真實。

邏輯學：**三段論**——大前提（劇情事件）+ 小前提（角色性格）= 結論（當前反應），這解決了 AI 產生「無緣無故的情緒」或「跳躍式反應」的問題。

我們讓 AI 進行任務的時候，我們可以去看看相關的知識理論和專業名詞（直接問你打算使用的 AI 是個不錯的選擇，也可以知道 AI 有沒有這個知識）。更多請參考[小詞彙大作用](small-words.md)。

---

## 十二、少樣本提示（Few-Shot Prompting）

其實 AI 對上下文的模仿能力是很強的，這也是自注意力機制帶來的好處（壞處當然就是過擬合的問題了）。

如果需要，可以給一些例子。透過提供 1-3 個「問題-答案」的範例，提升模型在特定任務上的表現，尤其是在格式化輸出和風格模仿上。

例如角色扮演的回覆風格，或者對於一些提示詞的細化解釋：

```
使用者：你是一隻貓娘
AI助手：好的喵，最喜歡主人了喵
```

這樣就可以讓 AI 對你需要的文風進行一個模仿，達到更好的效果。

對於文章或者其他東西也一樣，例如程式碼。如果你只是單純的給 AI 一個程式碼任務，可能要你經過多次 AI 才會給你差不多的答案。但是如果你給 AI 一個參考程式碼，AI 可以更穩定的完成你的任務。

<div class="callout-warning">
<div class="callout-title">注意</div>

例子有時候會帶來很好的效果，但是也可能讓 AI 產生過擬合問題，這點是需要注意的。1-3 個精選範例為宜，太多反而適得其反。
</div>

更多請參考[少樣本提示](few-shot.md)。

---

## 十三、對提示詞的迭代

好提示詞不是寫出來的，是改出來的。

<div class="wiki-flow">
<div class="wiki-box wiki-box-amber"><b>A/B 測試</b><small>對於一個任務，嘗試兩個或多個版本的提示詞，對比結果</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-blue"><b>拆解問題</b><small>如果一個複雜的提示詞效果不好，嘗試將其拆解成多個更簡單的、連續的提示詞</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-green"><b>分析失敗案例</b><small>當 AI 的回答不符合預期時：反思是哪裡產生了歧義？是指令不明確？還是上下文有誤導？</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-purple"><b>修改並重測</b><small>一次改一處，對比效果，循環迭代</small></div>
</div>

更多迭代方法請參考[精簡與迭代](refine.md)。
