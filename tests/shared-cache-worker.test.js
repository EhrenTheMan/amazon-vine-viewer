const test = require("node:test");
const assert = require("node:assert/strict");

async function setup() {
  const { default: worker } = await import("../shared-cache/worker.mjs");
  const records = new Map();
  const env = {
    LIMITER: { limit: async () => ({ success: true }) },
    DB: { prepare: (sql) => ({ bind: (...args) => ({
      async run() {
        const [slot, asin, parent, cents, updated_at, cutoff] = args;
        const old = records.get(slot);
        if (!old || old.updated_at <= cutoff) records.set(slot, { asin, parent, cents, updated_at });
      },
      async all() {
        const cutoff = args.at(-1);
        return { results: args.slice(0, -1).map((slot) => records.get(slot)).filter((row) => row && row.updated_at > cutoff) };
      },
    }) }) },
  };
  async function send(path, data, customEnv = env) {
    return worker.fetch(new Request(`https://cache.example${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "127.0.0.1" },
      body: JSON.stringify(data),
    }), customEnv);
  }
  return { send, env, records };
}

test("stores and returns an exact parent/ASIN match without overwriting fresh entries", async () => {
  const { send } = await setup();
  const key = { asin: "B000000001", parent: true };
  assert.equal((await send("/v1/contribute", { key, cents: 1234 })).status, 200);
  await send("/v1/contribute", { key, cents: 0 });
  const result = await (await send("/v1/lookup", { keys: [key, { ...key, parent: false }] })).json();
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].cents, 1234);
  assert.equal(result.results[0].parent, true);
});

test("rejects unexpected fields, invalid values, oversized requests and rate-limited clients", async () => {
  const { send, env } = await setup();
  const key = { asin: "B000000001", parent: false };
  assert.equal((await send("/v1/contribute", { key: { ...key, recommendationId: "private" }, cents: 5 })).status, 400);
  assert.equal((await send("/v1/contribute", { key, cents: -1 })).status, 400);
  assert.equal((await send("/v1/lookup", { keys: Array(81).fill(key) })).status, 400);
  assert.equal((await send("/v1/lookup", { keys: [key], extra: "x".repeat(9000) })).status, 400);
  const denied = { ...env, LIMITER: { limit: async () => ({ success: false }) } };
  assert.equal((await send("/v1/lookup", { keys: [key] }, denied)).status, 429);
});

test("expired and hash-colliding entries are never returned as another item", async () => {
  const { send, records } = await setup();
  const key = { asin: "B000000001", parent: false };
  await send("/v1/contribute", { key, cents: 300 });
  const row = [...records.values()][0];
  row.asin = "B000000002";
  assert.deepEqual((await (await send("/v1/lookup", { keys: [key] })).json()).results, []);
  row.asin = key.asin;
  row.updated_at = Date.now() - 31 * 60 * 1000;
  assert.deepEqual((await (await send("/v1/lookup", { keys: [key] })).json()).results, []);
});
