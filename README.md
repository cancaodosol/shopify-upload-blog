# Shopify ブログ投稿ツール

ゆにわマートオンラインの Shopify ストアに、ブラウザからブログ記事（サムネイル画像付き）を投稿するためのツールです。

- 画面：[public/index.html](public/index.html)（1ファイル完結。本文エディタは TinyMCE を CDN から読み込み）
- API：[src/shopify.js](src/shopify.js)（Shopify Admin API とのやり取り。ローカル・本番で共通）
- 本番：Cloudflare Workers（[src/worker.js](src/worker.js) / [wrangler.jsonc](wrangler.jsonc)）
- ローカル：Node.js の簡易サーバー（[server.js](server.js)）

```
ブラウザ ──/api/*──▶ server.js または Workers ──▶ Shopify Admin API
   │
   └── 画像ファイル本体は Shopify のアップロード先へ直接送信（中継サーバーを経由しない）
```

接続情報（ストアドメイン / Client ID / Client Secret）はサーバーに保存しません。画面で入力した値をリクエストごとにヘッダーで送り、ブラウザ側ではタブ内（sessionStorage）にのみ一時保存します。

---

## 1. 事前準備

### 必要なもの

- Node.js 20 以上
- Shopify のアプリ（Client ID / Client Secret）
- 本番デプロイする場合のみ：Cloudflare アカウント

### 依存パッケージのインストール

```sh
npm install
```

### Shopify アプリの設定

Shopify の Dev Dashboard でアプリを作成し、投稿先のストアにインストールしておきます。必要なスコープは次の2つです。

| スコープ | 用途 |
| --- | --- |
| `write_content` | ブログ一覧の取得、記事の作成 |
| `write_files` | サムネイル画像のアップロード |

スコープを追加・変更した場合は、新しいバージョンをリリースし、ストア側で権限を承認し直してください。承認前に投稿すると「スコープ不足」のエラーになります。

---

## 2. テスト環境での動かし方

ローカルでの起動方法は2通りあります。普段の確認は A、本番と同じ環境で確かめたいときは B を使います。

### A. Node.js サーバーで起動（手軽）

```sh
npm start
```

ブラウザで http://localhost:3939 を開きます。

- ポートを変えるときは `PORT=4000 npm start`
- 外部からアクセスされないよう `127.0.0.1` にだけ接続を受け付けます
- `index.html` をファイルとして直接開く（`file://`）と API に接続できません。必ず上の URL から開いてください

### B. Cloudflare Workers のローカル環境で起動（本番と同じ構成）

```sh
npm run dev
```

ターミナルに表示される URL（通常は http://localhost:8787 ）を開きます。

### 動作確認の手順

1. 「接続設定」にストアドメイン（`xxxx.myshopify.com`）、Client ID、Client Secret を入力し、「接続してブログを読み込む」を押す
2. 「接続済み（ブログ ○ 件）」と表示されることを確認する
3. サムネイル画像・タイトル・本文を入力して「投稿する」を押す
4. 結果欄のリンクから、Shopify 管理画面に記事ができていることを確認する

テストでは「すぐに公開する」のチェックを外したままにすると、下書き（非公開）で作成されるため、ストアの表示に影響しません。作成したテスト記事は Shopify 管理画面から削除してください。

### URL で接続情報を渡す

次のように GET パラメータを付けて開くと、接続情報が自動で入力され、そのまま接続します。パラメータは読み込み後にアドレスバーと履歴から取り除かれます。

```
http://localhost:3939/?shop=xxxx.myshopify.com&clientId=...&clientSecret=...
```

Client Secret を含む URL なので、チャットやメールでそのまま共有しないよう注意してください。

### ストアごとの挙動

[public/index.html](public/index.html) の定数で、次の挙動が決まっています。

| 定数 | 値 | 挙動 |
| --- | --- | --- |
| `FIXED_BLOG_HANDLE` | `today-uniwamart` | このハンドルのブログがあれば、投稿先をそこに固定し、最近の記事のサムネイルをヘッダーに表示する |
| `HIDE_CONN_SHOP` | `uniwa-mart.myshopify.com` | このストアに接続できたら、接続設定欄を隠す |

テスト用ストアにも `today-uniwamart` というハンドルのブログを作っておくと、本番と同じ画面で確認できます。

---

## 3. デプロイ方法（Cloudflare Workers）

### 初回のみ：Cloudflare にログイン

```sh
npx wrangler login
```

ブラウザが開くので、Cloudflare アカウントでログインして許可します。

### デプロイ

```sh
npm run deploy
```

`public/` の静的ファイルと `src/worker.js` が、Worker 名 `uniwa-shopify-blog` としてデプロイされます。完了時に表示される URL（`https://uniwa-shopify-blog.<アカウントのサブドメイン>.workers.dev`）が公開先です。

### デプロイ前のチェック

- `npm run dev` で、接続・投稿まで一通り動くこと
- 変更がコミット済みであること（デプロイは手元のファイルがそのまま反映されます）

### 設定値

[wrangler.jsonc](wrangler.jsonc) の `vars` で設定します。

| 変数 | 既定値 | 内容 |
| --- | --- | --- |
| `SHOPIFY_API_VERSION` | `2026-04` | 使用する Shopify Admin API のバージョン |

ローカルの `npm start` では環境変数 `SHOPIFY_API_VERSION` で上書きできます（未指定なら `2026-04`）。API バージョンを上げるときは、テスト環境で動作確認してからデプロイしてください。

### 元に戻すとき

Cloudflare のダッシュボード（Workers & Pages → `uniwa-shopify-blog` → Deployments）から、以前のバージョンにロールバックできます。

---

## 4. よくあるエラー

| 表示 | 原因と対処 |
| --- | --- |
| 公開先の URL か、server.js を起動して…から開いてください | `index.html` を直接開いている。`npm start` などで起動した URL から開く |
| ストアドメインは「xxxx.myshopify.com」の形式で… | 独自ドメインではなく `myshopify.com` のドメインを入力する |
| 認証に失敗しました | Client ID / Secret、またはストアが違う。アプリがそのストアにインストールされているか確認する |
| …アプリのスコープ不足です… | `write_content` / `write_files` を追加し、新バージョンをリリースしてストアで承認する |
| 画像は 20MB 以下にしてください | Shopify の画像サイズ上限。画像を縮小する |
