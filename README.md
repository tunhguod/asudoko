# Asudoko（スロット予定マップ v3）

パチンコ・パチスロで「その日に打つホール」を日付ごとに共有する地図サイト。

## 構成

GitHub Pages（`frontend/` のみ公開）→ Cloudflare Workers（`worker/index.js`）→ Cloudflare D1

- `halls`（D1）: ホールマスタ。予定との結合用（`halls.sql` で投入）
- `worker/halls.json`: ホール検索用のデータ。Workerに組み込み、検索はメモリ上で行う（D1の読み込みを消費しない・CSVを公開しない）
- `plans`（D1）: 日付ごとの予定
- ホールは店舗URLで識別する（D1の自動採番IDに依存しない）

## デプロイ手順（v2 → v3）

```bash
cd worker

# 1) マイグレーション（それぞれ1回だけ、番号順に）
npx wrangler d1 execute slot-plan --remote --file=migrations/001_v3.sql
npx wrangler d1 execute slot-plan --remote --file=migrations/002_delete_pin.sql
npx wrangler d1 execute slot-plan --remote --file=migrations/003_security.sql
#   ※ Authentication error [code: 10000] が出たら `npx wrangler logout && npx wrangler login`
#     それでもダメなら各SQLを --command="..." で実行

# 2) シークレット（最初のデプロイ前に1回。PIN_PEPPER は以後変更しないこと）
npx wrangler secret put PIN_PEPPER          # 長いランダム文字列を入力（例: openssl rand -hex 32 の出力）
npx wrangler secret put TURNSTILE_SECRET    # Turnstile を使う場合のみ

# 3) wrangler.toml の ALLOWED_ORIGINS に GitHub Pages のURLを設定（例: https://ユーザー名.github.io）

# 4) デプロイ
npx wrangler deploy
```

フロントエンドは GitHub の Settings → Pages → Source を「GitHub Actions」にし、
`.github/workflows/pages.yml` で **`frontend/` フォルダだけ**を公開する。

### 新規セットアップ

```bash
npx wrangler d1 create slot-plan          # 出力された database_id を worker/wrangler.toml に設定
npx wrangler d1 execute slot-plan --remote --file=worker/schema.sql
npx wrangler d1 execute slot-plan --remote --file=halls.sql
# 以降は上の 2)〜4)
```

### ホールマスタを更新したとき

```bash
python3 conv.py halls_source.csv halls.sql                 # D1用SQL
python3 tools/build_halls_json.py halls.sql worker/halls.json   # 検索用JSON
npx wrangler d1 execute slot-plan --remote --file=halls.sql
cd worker && npx wrangler deploy
```

## Frontend の設定（`frontend/app.js` の先頭）

```js
const API_BASE = "https://slot-plan-api.asudoko.workers.dev";
const MAPTILER_KEY = "...";
const TURNSTILE_SITE_KEY = "";   // Turnstile を使う場合のみ
```

API_BASE を変えたら `index.html` の CSP（`connect-src`）も合わせて変更すること。

## セキュリティ対策

| リスク | 対策 |
|---|---|
| 大量投稿・荒らし、D1無料枠の使い切り（サイト停止） | IPごとの回数制限（投稿・削除 6回/分、閲覧 120回/分）、同じ内容の連投を拒否、Turnstile（任意）、本文4KBまで |
| ホール検索で D1 を大量に読み込む | 検索・現在地検索は Worker のメモリ上で実行（D1の読み込み0） |
| 他サイトからの書き込み | `ALLOWED_ORIGINS` 以外のオリジンからの POST/DELETE を拒否、CORS も同オリジンに限定 |
| SQLインジェクション | すべてプリペアドステートメント |
| XSS | 出力時に全てエスケープ、リンクは https のみ、CSP で読み込み元を限定 |
| CDN改ざん | Leaflet を SRI（integrity）付きで読み込み |
| 予定の不正削除 | 削除キー必須。salt＋pepper（Workerのシークレット）付き SHA-256 で保存、5回間違えると30分ロック（投稿したブラウザからは削除可） |
| プライバシー | 予定は `RETENTION_DAYS`（既定3日）を過ぎると毎日自動削除（Cron）、フォームに注意書き |
| 秘密情報の公開 | `.gitignore` で `.wrangler/`・CSV・`halls.sql`・バックアップを除外、Pages は `frontend/` のみ公開 |
| APIレスポンス | `nosniff`、`no-referrer`、`frame-ancestors 'none'`、エラー詳細は返さない |

### 手動で行う設定

- **MapTiler**: 管理画面（Account → Keys）でキーの「Allowed HTTP origins」に GitHub Pages のURLだけを登録する
- **SRI の確認**: integrity の値は公式の値を設定済み。念のため次のコマンドの出力と一致するか確認する
  ```bash
  curl -s https://unpkg.com/leaflet@1.9.4/dist/leaflet.js  | openssl dgst -sha256 -binary | openssl base64 -A
  curl -s https://unpkg.com/leaflet@1.9.4/dist/leaflet.css | openssl dgst -sha256 -binary | openssl base64 -A
  ```
- **Turnstile（任意）**: Cloudflare ダッシュボード → Turnstile でウィジェットを作成（ホスト名に GitHub Pages のドメイン）。サイトキーを `app.js`、シークレットキーを `wrangler secret put TURNSTILE_SECRET` に設定

## 予定の削除（ログインなしの削除キー方式）

| 状況 | 削除方法 |
|---|---|
| 投稿したのと同じブラウザ | 「削除」を押すだけ（投稿時に発行された自動キーを localStorage に保存） |
| 別のスマホ・PC | 投稿時に設定した**削除キー**（必須・4〜32文字）を入力 |
| v2時代の予定（キーなし） | 画面からは削除不可。管理者が `wrangler d1 execute ... --command="DELETE FROM plans WHERE id=…"` で削除 |

## API

| メソッド | パス | 説明 |
|---|---|---|
| GET | `/api/halls?q=キーワード` | ホール検索（空白区切りでAND、ひらがな/カタカナ・全角/半角を区別しない） |
| GET | `/api/halls/near?lat=&lng=` | 近くのホール（10km以内・近い順20件） |
| GET | `/api/plans?date=YYYY-MM-DD` | その日の予定 |
| POST | `/api/plans` | 予定追加 `{date,hall_url,nickname,machine,comment,delete_pin,turnstile?}` → `{id,delete_key}` |
| DELETE | `/api/plans/:id` | 削除。ヘッダ `X-Delete-Key`（自動キー）または本文 `{pin}`（削除キー） |

## 今後の課題

- Xへの共有ボタン（web intent、無料）＋OGP画像
