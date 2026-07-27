# ツール一覧

YonBan は 30 以上のツールを提供し、AI が会話内で `<ideToolCall>` タグを通じて呼び出します。書き込み操作は承認システムで承認された後に実行されます。

## ファイル操作（7）

| ツール | 機能 | 主要パラメータ | 読み/書き |
|------|------|---------|-------|
| read_file | ファイル内容の読み取り（ページネーションおよび xlsx/docx/pptx/pdf ドキュメント解析に対応） | path, offset, limit | 読み |
| write_file | ファイルの書き込み/作成 | path, content | 書き |
| list_files | ディレクトリ内容の一覧 | path, recursive | 読み |
| replace_lines | 行番号範囲で内容を置換 | path, start_line, end_line, new_content | 書き |
| insert_at_line | 指定行番号に内容を挿入 | path, line, content | 書き |
| fuzzy_edit | ファジーマッチ置換（インデント/空行の差異を許容） | path, old_string, new_string | 書き |
| edit_xlsx | Excel ファイルの読み書き | path, sheet, operations | 書き |

## 検索（4）

| ツール | 機能 | 主要パラメータ | 読み/書き |
|------|------|---------|-------|
| search_files | 正規表現/テキストでファイル内容を検索 | pattern, path, regex | 読み |
| search_by_name | ファイル名パターンで検索 | pattern, path | 読み |
| smart_search | セマンティック検索（ファイル名 + 内容 + パスを組み合わせ） | query, path | 読み |
| ast_search | AST 構造検索（関数/クラス/変数の定義） | pattern, language | 読み |

## コマンド実行（2）

| ツール | 機能 | 主要パラメータ | 読み/書き |
|------|------|---------|-------|
| run_command | IDE ターミナルでコマンドを実行 | command, cwd | 書き |
| run_script | スクリプトファイルを実行 | path, args | 書き |

## 診断（5）

| ツール | 機能 | 主要パラメータ | 読み/書き |
|------|------|---------|-------|
| get_diagnostics | IDE 診断情報（エラー/警告）を取得 | path | 読み |
| get_status | IDE ステータス（開いているファイル/アクティブエディタ）を取得 | — | 読み |
| get_project_summary | プロジェクト構造サマリーを取得 | path | 読み |
| validate_html | HTML ファイルを検証 | path | 読み |
| lint_code | コード lint チェック | path, rules | 読み |

## ナビゲーション（2）

| ツール | 機能 | 主要パラメータ | 読み/書き |
|------|------|---------|-------|
| goto_definition | シンボル定義にジャンプ | path, line, character | 読み |
| find_references | シンボルのすべての参照を検索 | path, line, character | 読み |

## TODO（2）

| ツール | 機能 | 主要パラメータ | 読み/書き |
|------|------|---------|-------|
| todo_read | TODO リストを読み取り | filter | 読み |
| todo_write | TODO 項目を書き込み/更新 | items | 書き |

## Git（9）

| ツール | 機能 | 主要パラメータ | 読み/書き |
|------|------|---------|-------|
| git_status | ワークスペースの状態を表示 | cwd | 読み |
| git_diff | 変更差分を表示 | staged, path, cwd | 読み |
| git_log | コミット履歴を表示 | maxCount, cwd | 読み |
| git_add | ファイルをステージング | paths, path, cwd | 書き |
| git_commit | コミット | message, all, cwd | 書き |
| git_branch | ブランチの作成/一覧 | create, cwd | 書き |
| git_checkout | ブランチの切り替え | branch, cwd | 書き |
| git_stash | ワークスペースをスタッシュ | action, message, ref, cwd | 書き |
| git_merge | ブランチのマージ | branch, noFf, cwd | 書き |

git ファミリー全体でオプションの `cwd`（リポジトリディレクトリ、ワークスペース内のパス）を受け付けます：リポジトリがワークスペースのサブディレクトリにある場合に指定し、省略するとワークスペースルートで実行されます。

## 内部ツール

`_` プレフィックスが付いたツールはシステム内部用で、AI が直接呼び出すものではありません：

| ツール | 機能 |
|------|------|
| _checkpoint_start | スナップショットトランザクションを開始 |
| _checkpoint_commit | スナップショットトランザクションをコミット |
| _checkpoint_revert | 指定したスナップショットにリバート |
| _checkpoint_revert_to_message | 特定のメッセージに対応する状態にリバート |
| _checkpoint_revert_diff | 差分に基づいてリバート |
| _checkpoint_list | すべてのスナップショットを一覧表示 |
| _checkpoint_can_replay | 特定のスナップショットがリプレイ可能かを照会 |
| _checkpoint_get_ops | スナップショットの操作記録を取得 |
| _checkpoint_get_diff | スナップショットの差分を取得 |
| _get_operation_log | 操作ログを読み取り |
| _reveal | IDE で指定ファイルを開く/ハイライト |

スナップショットツールはコードモードの操作タイムライン機能を支えています——AI がファイルを変更する前に自動的にスナップショットを作成し、ユーザーはタイムラインパネルから任意の履歴ノードにリバートできます。

## ナビゲーション

- [YonBan 概要](overview.md) — インストールと接続
- [承認と権限](approval.md) — どのツールに承認が必要か
- [実行リンク](architecture.md) — ツール呼び出しの完全な実行フロー
