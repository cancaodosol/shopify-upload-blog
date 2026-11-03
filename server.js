// ローカル動作用の中継サーバー（外部依存なし / Node 18+）
// public/index.html を配信し、/api/* は Cloudflare Workers 版と共通の src/shopify.js で処理する。

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleApi } from "./src/shopify.js";

const PORT = Number(process.env.PORT || 3939);
const API_VERSION = process.env.SHOPIFY_API_VERSION;
const INDEX = path.join(path.dirname(fileURLToPath(import.meta.url)), "public", "index.html");
const MAX_BODY = 1024 * 1024; // 画像はブラウザから Shopify へ直接送るので、ここに届くのは JSON だけ

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error("送信データが大きすぎます")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch { resolve({}); }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, "http://localhost");
  const result = await handleApi({
    method: req.method,
    pathname,
    getHeader: (name) => req.headers[name],
    readJson: () => readJson(req),
    apiVersion: API_VERSION,
  });
  if (result) {
    res.writeHead(result.status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(result.body));
    return;
  }
  if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    fs.createReadStream(INDEX).pipe(res);
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not Found");
});

// ローカル専用。外部からアクセスされないよう 127.0.0.1 にのみバインドする。
server.listen(PORT, "127.0.0.1", () => {
  console.log(`Shopify ブログ投稿ツール: http://localhost:${PORT}`);
});
