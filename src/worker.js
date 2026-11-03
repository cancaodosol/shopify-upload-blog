// Cloudflare Workers のエントリーポイント
// public/ の静的ファイル（index.html）は Workers の Static Assets が配信し、/api/* だけがここに届く。

import { handleApi } from "./shopify.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const result = await handleApi({
      method: request.method,
      pathname: url.pathname,
      getHeader: (name) => request.headers.get(name),
      readJson: async () => {
        try { return await request.json(); }
        catch { return {}; }
      },
      apiVersion: env.SHOPIFY_API_VERSION,
    });
    if (!result) return env.ASSETS.fetch(request);
    return Response.json(result.body, { status: result.status });
  },
};
