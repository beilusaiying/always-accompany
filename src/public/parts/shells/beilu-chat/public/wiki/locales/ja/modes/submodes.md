# サブモードと切り替え

[Code](beilu:mode/files) と [Work](beilu:mode/work) モード内部の2次モードシステムです。開発/ワークフローを複数の段階に分割し、各段階で AI の動作を個別に設定できます。

## サブモードの役割

サブモードを切り替えると、そのサブモードにバインドされた以下の設定が自動的に読み込まれます：

- **プリセット**：段階ごとに異なるシステムプロンプトを使用します
- **[API ソース](beilu:settings/api)**：段階ごとに異なる AI サービスプロバイダを選択できます
- **モデル**：段階ごとに異なる AI モデルを選択できます
- **サンプリングパラメータ**：Temperature、Top-P など、段階ごとに差別化した設定が可能です

## Code モードの 11 個のサブモード

<div class="wiki-grid wiki-grid-3">
<div class="wiki-card" style="border-left-color: var(--wiki-amber, #f59e0b);">
<div class="wiki-card-title">1. タスク確認師</div>
<div class="wiki-card-desc"><b>要件理解</b><br>要点を捕捉し、Web で類似案を検索して専門化を進めます</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-amber, #f59e0b);">
<div class="wiki-card-title">2. 前置設計師</div>
<div class="wiki-card-desc"><b>方案設計</b><br>タスクの実際のコードを読み込んで設計を行い、コード行レベルまで精密に特定します</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-blue, #3b82f6);">
<div class="wiki-card-title">3. フレームワーク審査員</div>
<div class="wiki-card-desc"><b>フレームワーク審査</b><br>コードフレームワークと全体フローの観点から審査し、妥当性を確認します</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-purple, #8b5cf6);">
<div class="wiki-card-title">4. 深度思考師</div>
<div class="wiki-card-desc"><b>アルゴリズムとシステム推演</b><br>アルゴリズム設計、フレームワークロジック、経路ロジック、実験検証後にコードエキスパートへ引き渡します</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-green, #22c55e);">
<div class="wiki-card-title">5. コードエキスパート</div>
<div class="wiki-card-desc"><b>コード実装</b><br>コード実装に専念します</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-red, #ef4444);">
<div class="wiki-card-title">6. 前置エラー生産師</div>
<div class="wiki-card-desc"><b>構文とフローの検査</b><br>構文エラー、HTML タグエラーの検出、フロー審査、必要に応じて差し戻します</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-blue, #3b82f6);">
<div class="wiki-card-title">7. テストエキスパート</div>
<div class="wiki-card-desc"><b>実際のテスト</b><br>スクリプトツールとブラウザバックグラウンドによる実際の操作テストを行います</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-red, #ef4444);">
<div class="wiki-card-title">8. デバッグエキスパート</div>
<div class="wiki-card-desc"><b>問題の特定と修正</b><br>全体を確認してから個別に集中し、コード挿入や F12 で迅速に問題を特定します</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-purple, #8b5cf6);">
<div class="wiki-card-title">9. タスク引継ぎ員</div>
<div class="wiki-card-desc"><b>ドキュメントと引継ぎ</b><br>md ファイルとして作成し、タスク確認師に渡して人間と確認します</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-green, #22c55e);">
<div class="wiki-card-title">10. 大規模プロジェクト調整</div>
<div class="wiki-card-desc"><b>大規模プロジェクトの調整ハブ</b><br>スコープ固定、依存チェーンの順序付け、増分マージ、マルチエージェント編成、完全出力</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-amber, #f59e0b);">
<div class="wiki-card-title">11. フロントエンド美化</div>
<div class="wiki-card-desc"><b>フロントエンドのデザインと美化</b><br>Brief 推論、3ノブ、デザインシステム、Pre-Flight Check</div>
</div>
</div>

## Work モードの 11 個のサブモード

<div class="wiki-grid wiki-grid-3">
<div class="wiki-card" style="border-left-color: var(--wiki-amber, #f59e0b);">
<div class="wiki-card-title">1. タスク確認師</div>
<div class="wiki-card-desc"><b>要件確認</b><br>要件を理解し、認識を確認し、原文を記録し、タスクファイルを作成します</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-amber, #f59e0b);">
<div class="wiki-card-title">2. タスク設計</div>
<div class="wiki-card-desc"><b>フロー設計</b><br>タスク MD を読み込み、最終効果から逆算して実行フローを設計します</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-purple, #8b5cf6);">
<div class="wiki-card-title">3. フロー最適化</div>
<div class="wiki-card-desc"><b>フロー最適化</b><br>設計済みのフローを最適化し、トークン消費を削減し、ステップを精簡します</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-blue, #3b82f6);">
<div class="wiki-card-title">4. フレームワーク審査</div>
<div class="wiki-card-desc"><b>フロー審査</b><br>フロー設計のエラーを審査し、問題の可能性を連想します。最適化のみで差し戻しはしません</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-green, #22c55e);">
<div class="wiki-card-title">5. プロンプト設計</div>
<div class="wiki-card-desc"><b>プロンプト作成</b><br>タスクに必要なプロンプトを設計し、プロンプトガイドを参考にします</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-green, #22c55e);">
<div class="wiki-card-title">6. プロンプト+プリセット設計</div>
<div class="wiki-card-desc"><b>プリセット設計</b><br>always-accompany のプロンプトとプリセット自体を設計します。チュートリアル、サンプル、方法論を含みます</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-green, #22c55e);">
<div class="wiki-card-title">7. Skill/スクリプト制作</div>
<div class="wiki-card-desc"><b>スクリプト制作</b><br>タスクに必要なスクリプト、skill、MCP 接続を制作します</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-blue, #3b82f6);">
<div class="wiki-card-title">8. フロー組み立て</div>
<div class="wiki-card-desc"><b>フロー組み立て</b><br>プロンプト、skill、スクリプトを実行可能なフローグループに組み立てます</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-purple, #8b5cf6);">
<div class="wiki-card-title">9. フローグループ実行</div>
<div class="wiki-card-desc"><b>フロー実行</b><br>組み立てたフローグループを実行し、各ステップを順番に実行してログを記録します</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-green, #22c55e);">
<div class="wiki-card-title">10. 検証</div>
<div class="wiki-card-desc"><b>結果検証</b><br>ユーザー検証または自動検証で実行結果を確認します</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-amber, #f59e0b);">
<div class="wiki-card-title">11. 仕上げ・アーカイブ</div>
<div class="wiki-card-desc"><b>アーカイブと仕上げ</b><br>タスク MD をアーカイブし、テーブルインデックスを更新し、経験を記録し、完了レポートを生成します</div>
</div>
</div>

## サブモードの切り替え

### 手動切り替え

Code または Work モードで、サイドバーまたはトップのサブモードセレクターから現在のサブモードを切り替えます。切り替え後、AI のプリセット、モデル、パラメータが自動的に更新されます。

### パイプライン自動切り替え

パイプライン（Flow Group）は複数のステップを自動実行シーケンスとして編成できます。各ステップの `steps[].mode` フィールドで対象サブモードを指定します：

<div class="wiki-flow-h">
<div class="wiki-box wiki-box-amber"><b>ステップ 1</b><small>タスク確認師</small></div>
<div class="wiki-arrow-h">→</div>
<div class="wiki-box wiki-box-amber"><b>ステップ 2</b><small>前置設計師</small></div>
<div class="wiki-arrow-h">→</div>
<div class="wiki-box wiki-box-green"><b>ステップ 3</b><small>コードエキスパート</small></div>
<div class="wiki-arrow-h">→</div>
<div class="wiki-box wiki-box-blue"><b>ステップ 4</b><small>テストエキスパート</small></div>
</div>

パイプライン実行時、システムは現在のステップの `mode` フィールドに従って自動的にサブモードを切り替え、対応するプリセットとパラメータを読み込んでから次のステップに進みます。プロセス全体で手動操作は不要です。

## サブモードの設定

各サブモードの個別設定項目：

| 設定項目 | 説明 |
|--------|------|
| プリセット | そのサブモードが使用するシステムプロンプトプリセット |
| API ソース | そのサブモードが使用する AI サービスソース |
| モデル | そのサブモードが使用する AI モデル |
| サンプリングパラメータ | Temperature、Top-P、頻度ペナルティなどのパラメータ |

これらの設定は主モードのグローバル設定とは独立しています。サブモードに切り替えた場合、サブモードの設定が主モードのデフォルト設定よりも優先されます。

## 使用上のアドバイス

- **段階に応じて切り替え**：開発プロセスの実際の段階に合わせてサブモードを切り替え、的確な AI 支援を受けましょう
- **差別化した設定**：サブモードごとに異なるモデルを設定しましょう。例えば、審査には推論に強いモデル、コーディングにはコード能力の高いモデルを使用します
- **パイプラインを活用**：繰り返しの多ステップフローはパイプラインに編成して、自動で進行させましょう
