# プリセット条目の構造

プリセットエンジン（PresetEngine）は SillyTavern プリセット形式と互換性があります。1つのプリセット JSON ファイルは**条目リスト**（prompts）と**ソートテーブル**（prompt_order）の2つの部分で構成されます。エンジンはこれらのデータを解析し、ルールに従ってソートした後、4段のメッセージ（beforeChat / afterChat / injectionAbove / injectionBelow）を生成して、下流の provider に引き渡します。

## プリセット JSON の構造

<div class="wiki-grid wiki-grid-3">
<div class="wiki-group" style="grid-column: span 3">
<div class="wiki-group-title">prompts[] — 条目配列</div>
<div class="wiki-grid wiki-grid-4">
<div class="wiki-card"><div class="wiki-card-title">identifier</div><div class="wiki-card-desc">一意の識別子</div></div>
<div class="wiki-card"><div class="wiki-card-title">name</div><div class="wiki-card-desc">表示名</div></div>
<div class="wiki-card"><div class="wiki-card-title">role</div><div class="wiki-card-desc">メッセージロール (system / user / assistant)</div></div>
<div class="wiki-card"><div class="wiki-card-title">content</div><div class="wiki-card-desc">条目のテキスト内容（マクロ対応）</div></div>
<div class="wiki-card"><div class="wiki-card-title">injection_position</div><div class="wiki-card-desc">インジェクション位置 (0=afterChat / 1=beforeChat)</div></div>
<div class="wiki-card"><div class="wiki-card-title">injection_depth</div><div class="wiki-card-desc">インジェクション深度（チャット履歴内の挿入位置）</div></div>
<div class="wiki-card"><div class="wiki-card-title">enabled</div><div class="wiki-card-desc">有効かどうか</div></div>
<div class="wiki-card"><div class="wiki-card-title">marker</div><div class="wiki-card-desc">内蔵マーカーかどうか（例：chatHistory）</div></div>
</div>
</div>
</div>

<div class="wiki-grid wiki-grid-2">
<div class="wiki-group">
<div class="wiki-group-title">prompt_order[] — 並び順</div>
<div class="wiki-card"><div class="wiki-card-title">character_id</div><div class="wiki-card-desc">100000=システムレベル / 100001=ユーザーレベル</div></div>
<div class="wiki-card"><div class="wiki-card-title">order[]</div><div class="wiki-card-desc">そのレベル内の identifier の並び</div></div>
</div>
<div class="wiki-group">
<div class="wiki-group-title">model_params — モデルパラメータ（任意）</div>
<div class="wiki-card"><div class="wiki-card-desc">プリセットに付随する温度、サンプリングなどのモデルパラメータ</div></div>
</div>
</div>

## 条目の分類

### 内蔵マーカー条目（Marker）

エンジンには 12 個の内蔵マーカーが事前定義されており、プリセット構造の骨格を形成します：

| Marker | 役割 | マクロ展開対象 |
|--------|------|-----------|
| main | メインシステムプロンプト | - |
| nsfw | NSFW 関連指示 | - |
| jailbreak | ジェイルブレイク/アンロック指示 | - |
| chatHistory | チャット履歴の分割点 | _chat_log |
| charDescription | キャラクター説明 | char_prompt |
| charPersonality | キャラクター性格 | char_personality |
| scenario | シナリオ設定 | scenario |
| personaDescription | ユーザーペルソナの説明 | user_prompt |
| worldInfoBefore | ワールドブック（前置） | world_prompt |
| worldInfoAfter | ワールドブック（後置） | world_prompt_after |
| dialogueExamples | 対話サンプル | dialogue_examples |
| enhanceDefinitions | 拡張定義 | - |

Marker 条目はコマンダーモードで対応モジュールの実際のコンテンツに展開されます（マクロ環境 env を通じて注入）。

### ユーザー定義条目

ユーザーは自由に条目を追加できます。identifier が内蔵マーカーと重複しなければ問題ありません。injection_position と injection_depth で最終メッセージ内の位置を制御します。

## ソートルール

### 2段階ソート

プリセットは prompt_order でソートを定義します：

- **システムレベル**（character_id = 100000）：内蔵 Marker とシステム指示を含み、プロンプトの骨格を構成します
- **ユーザーレベル**（character_id = 100001）：ユーザーが追加したカスタム条目

### インジェクション位置

| injection_position | 意味 | 配置位置 |
|-------------------|------|---------|
| 0 | afterChat | チャット履歴の後（フッタープリセット） |
| 1 | beforeChat | チャット履歴の前（ヘッダープリセット） |

### インジェクション深度（injection_depth）

インジェクション深度は、チャット履歴内での条目の挿入位置を決定します：

- **深度 0**：最下部、最新メッセージに隣接します
- **深度 4**（ST デフォルト）：下から4番目のメッセージの位置
- **深度 N**：下から N 番目のメッセージの位置

深度が小さいほど、条目は最新の対話に近くなり、AI が「見て」従いやすくなります。

## エンジンのワークフロー

PresetEngine のコアメソッド `buildAllEntries()` は以下のステップで動作します：

<div class="wiki-flow">
<div class="wiki-box wiki-box-amber"><b>1. prompt_order を走査</b><small>システムレベル → ユーザーレベルの順序で処理します</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-blue"><b>2. 無効な条目をフィルタ</b><small>enabled = false をスキップします</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-green"><b>3. Marker の展開</b><small>内蔵マーカー条目がマクロ環境の実際のコンテンツに展開されます</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-green"><b>4. マクロ置換</b><small>カスタム条目で evaluateMacros を実行します</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-purple"><b>5. injection_position でグループ化</b><small>→ beforeChat / afterChat</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-purple"><b>6. injection_depth で分流</b><small>深度 >= 1 → injectionAbove / 深度 = 0 → injectionBelow</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-red"><b>7. 4段の成果物を返却</b><small>TweakPrompt で消費されます</small></div>
</div>

## マクロ置換

条目の内容はマクロ構文に対応しています。buildAllEntries の段階で、エンジンが `evaluateMacros` を呼び出して条目テキストの置換を行います。よく使われるマクロには以下があります：

- `{{char}}` — 現在のキャラクター名
- `{{user}}` — 現在のユーザー名
- `{{time}}` — 現在の時刻
- カスタム変数マクロ

詳しくは[マクロシステム](../macros/overview.md)をご覧ください。

## モデルパラメータの抽出

プリセットにはモデルパラメータを付随させることができます。エンジンは `extractModelParams` でプリセットデータから以下の canonical パラメータを抽出します：

| パラメータ | 説明 | デフォルト値 |
|------|------|-------|
| temperature | 生成温度 | PARAM_SCHEMA で定義 |
| top_p | 核サンプリング | PARAM_SCHEMA で定義 |
| top_k | Top-K サンプリング | PARAM_SCHEMA で定義 |
| max_tokens | 最大出力トークン数 | PARAM_SCHEMA で定義 |
| frequency_penalty | 頻度ペナルティ | PARAM_SCHEMA で定義 |
| presence_penalty | 存在ペナルティ | PARAM_SCHEMA で定義 |
| repetition_penalty | 繰り返しペナルティ | PARAM_SCHEMA で定義 |
| min_p | Min-P サンプリング | PARAM_SCHEMA で定義 |
| top_a | Top-A サンプリング | PARAM_SCHEMA で定義 |
| seed | ランダムシード | PARAM_SCHEMA で定義 |

すべてのデフォルト値は `paramSchema.mjs` の PARAM_SCHEMA で統一的に定義されており、エンジン層、アプリケーション層、フロントエンド UI の3箇所が同一ソースとなっています。

## ナビゲーション

- [プリセットシステム概要](overview.md) — プリセットの基本概念
- [コマンダーモード](commander.md) — プリセットがメッセージ組み立てを制御する仕組み
- [プリセットとモードの連動](mode-binding.md) — モードバインディングの仕組み
