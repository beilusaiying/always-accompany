# プラットフォームリーチ (beilu-reach)

beilu-reach は、AI が 13 のインターネットプラットフォームの構造化データを取得できるようにするプラグインです——汎用ウェブスクレイピングより深い層（HTML 本文ではなく API/CLI レベルのデータ）にアクセスします。AI は `<reach>` タグで呼び出し、結果は次のラウンドの会話にインジェクションされます。

## 3 つのトリガー経路

```
① AI の能動呼び出し：返信に <reach platform="..." action="...">query</reach> を記述
② 検索の自動ルーティング：検索語に site:既知プラットフォームのドメイン を含む → そのプラットフォームの構造化結果を自動補完
③ URL スマート抽出：既知プラットフォームの URL を <browse> → プラットフォームアダプタで構造化データを優先取得、失敗時は汎用取得にフォールバック
```

## タグ形式

```xml
<reach platform="v2ex" action="hot">latest</reach>
<reach platform="github" action="search-repos" limit="5">AI agent</reach>
<reach platform="bilibili" action="video">BV1xx411c7mD</reach>
```

## プラットフォーム一覧

| プラットフォーム | 操作 | バックエンド | 設定 |
|------|------|------|------|
| V2EX | hot / node / topic / user | 公開 API | 設定不要 |
| RSS/Atom | read | ネイティブ解析 | 設定不要 |
| Jina Reader | read | r.jina.ai | 設定不要 |
| GitHub | search-repos / search-code / repo / issues / prs | gh CLI | Token 任意（レート制限緩和） |
| YouTube | info / subtitle / search | yt-dlp | Cookie 取得元ブラウザ任意 |
| Bilibili | search / video / hot / rank | bili-cli / opencli / 公開 API | SESSDATA 任意 |
| Twitter/X | search / read / user / feed | twitter-cli / opencli | Cookie |
| Reddit | search / read / subreddit / hot | opencli / rdt-cli | — |
| 小紅書 (Xiaohongshu) | search / note / comments / feed | opencli / mcporter | Cookie |
| 雪球 (Xueqiu) | quote / search-stock / hot-posts / hot-stocks | 公開 API | Cookie（xq_a_token） |
| Facebook | search / profile / feed | opencli | — |
| Instagram | search / profile / user / explore | opencli | — |
| LinkedIn | profile / search-people / search-jobs / company | mcporter / Jina | — |

パネルの「プラットフォーム状態」カードが各プラットフォームのツール可用性をリアルタイムに検出します（各プラットフォームの実際の操作とバックエンドは状態カードが基準——単一情報源はバックエンドレジストリです）。

## 設定

「追加プラグイン → プラットフォームリーチ」パネル：

- **基本スイッチ**：マスタースイッチ / 検索プラットフォームルーティング / URL スマート抽出
- **プラットフォーム認証情報**：各プラットフォームの Cookie / Token（サーバー側がプラットフォームにリクエストする際にのみ使用され、AI のコンテキストには現れません）
- **ネットワークとセキュリティ**：CLI プロキシアドレス、コマンドタイムアウト、プラットフォームホワイトリスト（AI が使用できるプラットフォームの範囲を制限）

設定変更は即時にバックエンドへ同期・永続化され、再起動しても失われません。

## セキュリティ

- **SSRF 防護**：AI が渡す URL 型パラメータ（フィードアドレス、動画リンクなど）は統一アウトバウンドセキュリティチェックを通過します。プライベートネットワーク・ループバック・クラウドメタデータアドレスは一律拒否されます。
- **コンテンツ境界**：プラットフォームの返却コンテンツは AI にインジェクションされる前に信頼できないコンテンツ境界処理（山括弧の中性化 + nonce 境界マーカー）を通過し、プラットフォームコンテンツによる AI への間接プロンプトインジェクションをブロックします。
- **認証情報の隔離**：Cookie/Token はアダプタ内部のリクエストにのみ使用され、AI の可視コンテキストには入りません。
- **コマンドインジェクション防護**：外部 CLI は常に引数配列で呼び出され、shell を経由しません。

## 能力ガイダンス

AI の `<reach>` 用法説明はインジェクションテキスト設定チェーン（`reach.capabilities` キー）を通じて提供され、設定のインジェクションテキストエディタで変更できます。使用可能なプラットフォーム一覧はバックエンドのリアルタイム検出により動的に生成され、文面に固定化されません。
