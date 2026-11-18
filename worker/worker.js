/**
 * 扩展管家 —— 状态云同步 Worker（Cloudflare Workers + KV）
 *
 *   GET  /health   存活检查（无需鉴权）
 *   GET  /state    读取状态快照（需 Authorization: Bearer <TOKEN>）
 *   PUT  /state    覆盖写入状态快照（需鉴权，body 为 { "<扩展ID>": { name, enabled, ts } }）
 *
 * 部署：
 *   1. wrangler kv namespace create STATE      # 把返回的 id 填进 wrangler.toml
 *   2. wrangler secret put TOKEN               # 自定义一个足够长的随机串
 *   3. wrangler deploy
 *
 * 调试：
 *   curl -H "Authorization: Bearer <TOKEN>" https://<worker>.workers.dev/state
 *   curl -X PUT -H "Authorization: Bearer <TOKEN>" -H "Content-Type: application/json" \
 *        --data '{"abc":{"name":"Demo","enabled":false,"ts":1}}' https://<worker>.workers.dev/state
 */
export default {
  async fetch(request, env) {
    const cors = {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, PUT, OPTIONS",
      "access-control-allow-headers": "content-type, authorization",
      "access-control-max-age": "86400"
    };
    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { ...cors, "content-type": "application/json; charset=utf-8" }
      });

    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    const { pathname } = new URL(request.url);
    if (pathname === "/health") return json({ ok: true });
    if (pathname !== "/state") return json({ error: "not found" }, 404);
    if (!env.TOKEN) return json({ error: "server not configured: run `wrangler secret put TOKEN`" }, 500);

    const auth = request.headers.get("authorization") || "";
    const match = auth.match(/^Bearer\s+(.+)$/i);
    if (!match || match[1].trim() !== env.TOKEN) return json({ error: "unauthorized" }, 401);

    if (request.method === "GET") {
      const stored = await env.STATE.get("state");
      // 校验 KV 内容，坏数据以 500 暴露而非伪装成 200 + 非法 JSON
      try {
        const data = stored ? JSON.parse(stored) : {};
        if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("bad state");
      } catch {
        return json({ error: "corrupted state" }, 500);
      }
      return new Response(stored || "{}", {
        headers: {
          ...cors,
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store"
        }
      });
    }

    if (request.method === "PUT" || request.method === "POST") {
      const text = await request.text();
      if (text.length > 256 * 1024) return json({ error: "too large (max 256KB)" }, 413);

      let data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        return json({ error: "invalid json" }, 400);
      }
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        return json({ error: "state must be an object keyed by extension id" }, 400);
      }

      await env.STATE.put("state", JSON.stringify(data));
      return json({ ok: true, count: Object.keys(data).length, updatedAt: Date.now() });
    }

    return json({ error: "method not allowed" }, 405);
  }
};
