// Shopify Admin API とのやり取り（ローカルの server.js と Cloudflare Workers の両方から使う）
// Web 標準の fetch / FormData のみを使い、Node.js 固有の機能には依存しない。
// 接続情報（ストア / Client ID / Client Secret）は画面で入力され、リクエストごとにヘッダーで受け取る。

const DEFAULT_API_VERSION = "2026-04";

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------- 接続情報 ----------
function readCredentials(getHeader, apiVersion) {
  const shop = String(getHeader("x-shop-domain") || "").trim().toLowerCase()
    .replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const clientId = String(getHeader("x-client-id") || "").trim();
  const clientSecret = String(getHeader("x-client-secret") || "").trim();
  // 任意のホストへ送信させないよう、myshopify.com ドメインに限定する
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) {
    throw new HttpError(400, "ストアドメインは「xxxx.myshopify.com」の形式で入力してください");
  }
  if (!clientId || !clientSecret) throw new HttpError(400, "Client ID と Client Secret を入力してください");
  return { shop, clientId, clientSecret, apiVersion: apiVersion || DEFAULT_API_VERSION };
}

// ---------- 認証 ----------
// client credentials grant でアクセストークン（約24時間有効）を取得し、期限まで使い回す。
const tokenCache = new Map();
const cacheKey = (c) => `${c.shop}\n${c.clientId}\n${c.clientSecret}`;

async function getAccessToken(creds) {
  const cached = tokenCache.get(cacheKey(creds));
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.value;

  const res = await fetch(`https://${creds.shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: creds.clientId, client_secret: creds.clientSecret }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    tokenCache.delete(cacheKey(creds));
    throw new HttpError(401, `認証に失敗しました（${res.status}）: ${json.error_description || json.error || "Client ID / Secret とストアを確認してください"}`);
  }
  tokenCache.set(cacheKey(creds), { value: json.access_token, expiresAt: Date.now() + (json.expires_in || 86399) * 1000 });
  return json.access_token;
}

// ---------- GraphQL ----------
async function gql(creds, query, variables = {}) {
  const res = await fetch(`https://${creds.shop}/admin/api/${creds.apiVersion}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": await getAccessToken(creds) },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(502, `Shopify API エラー（${res.status}）: ${JSON.stringify(json.errors || json)}`);
  if (json.errors?.length) {
    const message = json.errors.map((e) => e.message).join(" / ");
    if (json.errors.some((e) => e.extensions?.code === "ACCESS_DENIED")) {
      // スコープ追加後に新しい権限で取り直せるよう、古いトークンを捨てる
      tokenCache.delete(cacheKey(creds));
      throw new HttpError(403, `${message}（アプリのスコープ不足です。記事作成には write_content、画像アップロードには write_files が必要です。スコープを追加したら新しいバージョンをリリースし、ストアで権限を承認してから再度お試しください）`);
    }
    throw new HttpError(502, message);
  }
  return json.data;
}

function assertNoUserErrors(errors, label) {
  if (errors?.length) throw new HttpError(400, `${label}: ${errors.map((e) => e.message).join(" / ")}`);
}

async function listBlogs(creds) {
  const data = await gql(creds, `{ blogs(first: 50) { nodes { id title handle } } }`);
  return data.blogs.nodes;
}

// 画像のアップロード先を発行する。ファイル本体はブラウザから直接この URL へ送る
// （中継サーバーを経由させないことで、Workers の CPU 時間・リクエストサイズ制限を避ける）。
async function createStagedUpload(creds, { filename, mimeType, fileSize }) {
  if (!filename || !/^image\//.test(mimeType || "") || !(fileSize > 0)) {
    throw new HttpError(400, "画像ファイルの情報が不正です");
  }
  const data = await gql(
    creds,
    `mutation($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets { url resourceUrl parameters { name value } }
        userErrors { field message }
      }
    }`,
    { input: [{ resource: "IMAGE", filename, mimeType, fileSize: String(fileSize), httpMethod: "POST" }] }
  );
  assertNoUserErrors(data.stagedUploadsCreate.userErrors, "画像アップロード準備");
  return data.stagedUploadsCreate.stagedTargets[0];
}

// アップロード済みの画像を Shopify の「ファイル」に登録し、処理完了を待って CDN の URL を返す。
async function registerImage(creds, resourceUrl, alt) {
  const created = await gql(
    creds,
    `mutation($files: [FileCreateInput!]!) {
      fileCreate(files: $files) {
        files { id fileStatus ... on MediaImage { image { url } } }
        userErrors { field message }
      }
    }`,
    { files: [{ originalSource: resourceUrl, contentType: "IMAGE", alt }] }
  );
  assertNoUserErrors(created.fileCreate.userErrors, "画像登録");
  const file = created.fileCreate.files[0];
  if (file.image?.url) return file.image.url;

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const d = await gql(
      creds,
      `query($id: ID!) { node(id: $id) { ... on MediaImage { fileStatus image { url } } } }`,
      { id: file.id }
    );
    if (d.node?.fileStatus === "FAILED") throw new HttpError(502, "Shopify 側で画像の処理に失敗しました");
    if (d.node?.image?.url) return d.node.image.url;
  }
  throw new HttpError(504, "画像の処理がタイムアウトしました");
}

// プレーンテキスト → HTML。空行で段落を分け、段落内の改行は <br> にする。
function textToHtml(text) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}

async function createArticle(creds, { blogId, title, body, author, isPublished, imageResourceUrl }) {
  if (!blogId) throw new HttpError(400, "ブログを選択してください");
  if (!title?.trim()) throw new HttpError(400, "タイトルを入力してください");
  if (!body?.trim()) throw new HttpError(400, "本文を入力してください");
  if (!imageResourceUrl) throw new HttpError(400, "サムネイル画像を選択してください");

  const article = {
    blogId,
    title: title.trim(),
    body: textToHtml(body),
    author: { name: author?.trim() || "ゆにわマート" },
    isPublished: Boolean(isPublished),
  };
  article.image = { url: await registerImage(creds, imageResourceUrl, article.title), altText: article.title };

  const data = await gql(
    creds,
    `mutation($article: ArticleCreateInput!) {
      articleCreate(article: $article) {
        article { id title handle isPublished blog { handle } }
        userErrors { code field message }
      }
    }`,
    { article }
  );
  assertNoUserErrors(data.articleCreate.userErrors, "記事作成");
  const a = data.articleCreate.article;
  return {
    ...a,
    adminUrl: `https://${creds.shop}/admin/articles/${a.id.split("/").pop()}`,
    storefrontUrl: a.isPublished ? `https://${creds.shop}/blogs/${a.blog.handle}/${a.handle}` : null,
  };
}

// ---------- API ルーティング ----------
// 戻り値は { status, body }。該当しないパスは null を返す（呼び出し側で静的ファイル配信などに回す）。
export async function handleApi({ method, pathname, getHeader, readJson, apiVersion }) {
  if (!pathname.startsWith("/api/")) return null;
  try {
    if (method === "GET" && pathname === "/api/blogs") {
      return { status: 200, body: { blogs: await listBlogs(readCredentials(getHeader, apiVersion)) } };
    }
    if (method === "POST" && pathname === "/api/staged-uploads") {
      const creds = readCredentials(getHeader, apiVersion);
      return { status: 200, body: { target: await createStagedUpload(creds, await readJson()) } };
    }
    if (method === "POST" && pathname === "/api/articles") {
      const creds = readCredentials(getHeader, apiVersion);
      return { status: 200, body: { article: await createArticle(creds, await readJson()) } };
    }
    return { status: 404, body: { error: "Not Found" } };
  } catch (err) {
    console.error(err.message || err);
    return { status: err.status || 500, body: { error: err.message || String(err) } };
  }
}
