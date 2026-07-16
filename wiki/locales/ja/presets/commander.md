# コマンダーモード

コマンダーモード（Commander Mode）はプリセットエンジンの上級動作モードです。このモードでは、プリセットがメッセージシーケンス全体の組み立てを制御します。各 provider が個別に組み立てるのではなく、プリセットエンジンが**5段組み立て**ルールに従って、AI に送信する最終メッセージリストを統一的に生成します。

通常モードでは、プリセットは「指示の断片」を提供するだけで、provider が配置を決定します。コマンダーモードでは、プリセットが「総指揮官」となり、各コンテンツの位置を精密に制御します。

## 5段組み立て

コマンダーモードでは最終メッセージを5つの段落に分け、固定順序で配列します：

<div class="wiki-flow">
<div class="wiki-box wiki-box-amber wiki-box-full"><b>1. beforeChat (ヘッダープリセット)</b><small>beilu_preset_before — システム指示、キャラクター設定、ワールドブック</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-blue wiki-box-full"><b>2. injectionAbove (@D>=1 インジェクション)</b><small>beilu_injection_above — 深度 >= 1 のインジェクション条目</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-green wiki-box-full"><b>3. chatSegment (チャット履歴)</b><small>provider が構築 — 対話のコアメッセージシーケンス</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-purple wiki-box-full"><b>4. injectionBelow (@D=0 インジェクション)</b><small>beilu_injection_below — 記憶、リアルタイムコンテキストなど</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-red wiki-box-full"><b>5. afterChat (フッタープリセット)</b><small>beilu_preset_after — jailbreak、フォーマット要件など</small></div>
</div>

### 各段の役割

| 段 | フィールド名 | 内容 | 位置の意味 |
|----|--------|------|---------|
| beforeChat | beilu_preset_before | システム指示、キャラクター設定、ワールドブックなど | AI が最初に見る指示 |
| injectionAbove | beilu_injection_above | 深度 >= 1 のインジェクション条目 | チャット履歴の上 |
| chatSegment | _(provider が構築)_ | チャット履歴メッセージシーケンス | 対話のコア |
| injectionBelow | beilu_injection_below | 深度 = 0 のインジェクション条目（記憶、リアルタイムコンテキストなど） | チャット履歴の下、最新メッセージに近い位置 |
| afterChat | beilu_preset_after | フッター指示（jailbreak、フォーマット要件など） | AI が最後に見る指示 |

## 共有レイヤーの実装

5段組み立てロジックは `_shared/commanderAssembly.mjs` に集約されており、6つの provider（proxy / grok / claude / claude-api / ollama / gemini）がすべて同一の組み立てコードを共用しています。

### パラメータ化設計の理由

6つの provider はメッセージの形状に本質的な違いがあります：

| Provider | メッセージ形状 |
|----------|---------|
| proxy | OpenAI 標準 messages（メタデータマーク付き） |
| grok / claude | シンプルな `{role, content}` |
| ollama | `{role, content}` + 画像フィールド |
| gemini | Gemini parts 形状（role が model にマッピング） |
| claude-api | Anthropic ネイティブ形式 + トップレベル system フィールド |

そのため共有レイヤーはパラメータ化設計を採用しています：

- `mapMsg`：各 provider が「段メッセージ → 目標形状」のマッピング関数を提供します
- `chatSegment`：各 provider が事前に構築したチャットメッセージ段
- `extractSystem`：Anthropic 系 provider が before/after 段をトップレベル system フィールドとして抽出する必要があります
- `cacheBoundary`：キャッシュ境界最適化を行うかどうか

### キャッシュ境界最適化

injectionBelow の最初のメッセージが 1000 文字を超える場合（通常は記憶データ）、共有レイヤーはそれを最下部からチャット段の最後から1番目の前に移動します。これは API のキャッシュ機構を活用するためです。記憶データは比較的安定しており、キャッシュ境界に近い位置に配置することでキャッシュヒット率が向上します。

## ゲート制御と検証

### コマンダーモードのゲート制御

プリセット条目に `commander_mode` マーカーが含まれている場合、provider はコマンダー分岐に入ります。ゲート検出は2値 AND ロジックです。プリセットマーカーの存在と実際の段内容の両方が必要です。

### Schema 検証

共有レイヤーは `validateCommanderPreset()` を呼び出して、プリセット段フィールドの存在性と型を検証します。4つの段フィールド（beilu_preset_before / beilu_injection_above / beilu_injection_below / beilu_preset_after）は配列型である必要があります。検証の異常は警告のみで中断しません（fail-safe）。メッセージの出力には影響しません。

## TweakPrompt でのコマンダー出力

プリセットエンジンは TweakPrompt Round 2 の段階でコマンダー段の内容を出力します：

<div class="wiki-flow">
<div class="wiki-box wiki-box-amber"><b>1. buildAllEntries()</b><small>エンジンが4段の内容を出力します</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-blue"><b>2. extension に書き込み</b><small>beforeChat / afterChat → beilu_preset_before / beilu_preset_after</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-blue"><b>3. extension に書き込み</b><small>injectionAbove / injectionBelow → beilu_injection_above / beilu_injection_below</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-green"><b>4. Provider StructCall 組み立て</b><small>extension から読み取り → assembleCommanderMessages()</small></div>
</div>

## コマンダーモードを使うタイミング

| シーン | 必要かどうか |
|------|---------|
| シンプルな対話 | 不要です。通常モードで十分です |
| ロールプレイ、プロンプト位置の精密制御が必要な場合 | 推奨します |
| カスタムの複雑なプロンプトアーキテクチャ | 必須です |
| コードモード/ワークモード | 内蔵プリセットにより自動的に有効化されています |

## ナビゲーション

- [プリセットシステム概要](overview.md) — プリセットの基本概念
- [プリセット条目の構造](structure.md) — 条目フィールドの詳細
- [メッセージパイプライン](../developer/message-pipeline.md) — 完全なメッセージフロー経路
