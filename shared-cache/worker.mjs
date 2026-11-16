const TTL = 30 * 60 * 1000;
const MAX_SLOTS = 1000000;
const MAX_BODY = 8192;
const headers = {
  "content-type": "application/json",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "cache-control": "no-store",
};

function reply(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers });
}

function validKey(key) {
  return key && typeof key === "object" && /^[A-Z0-9]{10}$/.test(key.asin) &&
    typeof key.parent === "boolean" && Object.keys(key).every((name) => name === "asin" || name === "parent");
}

function slot(key) {
  let hash = 2166136261;
  for (const char of `${key.asin}:${key.parent ? 1 : 0}`) {
    hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  }
  return hash % MAX_SLOTS;
}

async function readJson(request) {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new Error("Expected JSON.");
  }
  if (!request.body) throw new Error("Missing request body.");
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) {
      await reader.cancel();
      throw new Error("Request body too large.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    const path = new URL(request.url).pathname;
    if (request.method !== "POST" || !["/v1/lookup", "/v1/contribute"].includes(path)) {
      return reply({ error: "Not found." }, 404);
    }
    const ip = request.headers.get("cf-connecting-ip");
    if (!ip || !env.LIMITER || !env.DB) return reply({ error: "Cache unavailable." }, 503);
    try {
      const { success } = await env.LIMITER.limit({ key: ip });
      if (!success) return reply({ error: "Rate limit exceeded." }, 429);
    } catch (error) {
      console.error("Cache rate limiter failed:", error);
      return reply({ error: "Cache unavailable." }, 503);
    }
    let body;
    try { body = await readJson(request); } catch { return reply({ error: "Invalid request body." }, 400); }
    try {
      const now = Date.now();
      if (path === "/v1/lookup") {
        if (!body || Object.keys(body).some((name) => name !== "keys") ||
            !Array.isArray(body.keys) || body.keys.length < 1 || body.keys.length > 80 ||
            !body.keys.every(validKey)) return reply({ error: "Invalid lookup." }, 400);
        const slots = [...new Set(body.keys.map(slot))];
        const marks = slots.map(() => "?").join(",");
        const rows = await env.DB.prepare(`SELECT asin, parent, cents, updated_at FROM etv_cache WHERE slot IN (${marks}) AND updated_at > ?`)
          .bind(...slots, now - TTL).all();
        const requested = new Set(body.keys.map((key) => `${key.asin}:${Number(key.parent)}`));
        const results = rows.results.filter((row) => requested.has(`${row.asin}:${row.parent}`) && row.updated_at <= now)
          .map((row) => ({ asin: row.asin, parent: !!row.parent, cents: row.cents, updatedAt: row.updated_at }));
        return reply({ results });
      }
      if (!body || Object.keys(body).some((name) => !["key", "cents"].includes(name)) ||
          !validKey(body.key) || !Number.isSafeInteger(body.cents) || body.cents < 0 || body.cents > 10000000) {
        return reply({ error: "Invalid contribution." }, 400);
      }
      await env.DB.prepare(`INSERT INTO etv_cache (slot, asin, parent, cents, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(slot) DO UPDATE SET asin=excluded.asin, parent=excluded.parent, cents=excluded.cents, updated_at=excluded.updated_at
        WHERE etv_cache.updated_at <= ?`)
        .bind(slot(body.key), body.key.asin, Number(body.key.parent), body.cents, now, now - TTL).run();
      return reply({ ok: true });
    } catch (error) {
      console.error("Cache database failed:", error);
      return reply({ error: "Cache unavailable." }, 503);
    }
  },
};
