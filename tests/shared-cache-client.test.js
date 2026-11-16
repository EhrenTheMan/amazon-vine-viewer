const test = require("node:test");
const assert = require("node:assert/strict");
const SharedEtv = require("../shared-cache.js");

test("sends only public item identifiers and omits credentials", async () => {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => url.endsWith("/lookup") ? { results: [] } : { ok: true } };
  };
  try {
    const item = { asin: "B000000001", isParent: true, recommendationId: "private", sourceQueue: "encore" };
    await SharedEtv.lookup([item]);
    await SharedEtv.contribute(item, 12.5);
    assert.equal(calls[0].options.credentials, "omit");
    assert.deepEqual(JSON.parse(calls[0].options.body), { keys: [{ asin: item.asin, parent: true }] });
    assert.deepEqual(JSON.parse(calls[1].options.body), { key: { asin: item.asin, parent: true }, cents: 1250 });
  } finally { global.fetch = original; }
});

test("rejects stale, unrelated and malformed shared estimates", async () => {
  const original = global.fetch;
  const item = { asin: "B000000001", isParent: false };
  try {
    for (const result of [
      { asin: item.asin, parent: false, cents: 12, updatedAt: Date.now() - 31 * 60 * 1000 },
      { asin: "B000000002", parent: false, cents: 12, updatedAt: Date.now() },
      { asin: item.asin, parent: false, cents: -1, updatedAt: Date.now() },
    ]) {
      global.fetch = async () => ({ ok: true, json: async () => ({ results: [result] }) });
      await assert.rejects(SharedEtv.lookup([item]), /Invalid cache entry/);
    }
    global.fetch = async () => ({ ok: false, status: 503 });
    await assert.rejects(SharedEtv.lookup([item]), /HTTP 503/);
  } finally { global.fetch = original; }
});
