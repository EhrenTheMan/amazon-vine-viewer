(function (root) {
  "use strict";
  const endpoint = "https://vine-etv-cache.ehren-lampcov.workers.dev";
  const ttl = 30 * 60 * 1000;

  function key(item) {
    return { asin: item.asin, parent: item.isParent };
  }

  async function request(path, data, signal) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(abort, 5000);
    try {
      const response = await fetch(`${endpoint}${path}`, {
        method: "POST", credentials: "omit", cache: "no-store", signal: controller.signal,
        headers: { "content-type": "application/json" }, body: JSON.stringify(data),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  }

  async function lookup(items, signal) {
    const keys = items.map(key);
    const data = await request("/v1/lookup", { keys }, signal);
    if (!Array.isArray(data?.results)) throw new Error("Invalid cache response");
    const requested = new Set(keys.map((entry) => `${entry.asin}:${entry.parent}`));
    const now = Date.now();
    for (const result of data.results) {
      if (!requested.has(`${result.asin}:${result.parent}`) ||
          !Number.isSafeInteger(result.cents) || result.cents < 0 || result.cents > 10000000 ||
          !Number.isSafeInteger(result.updatedAt) || result.updatedAt > now || now - result.updatedAt >= ttl) {
        throw new Error("Invalid cache entry");
      }
    }
    return data.results;
  }

  async function contribute(item, etv, signal) {
    const cents = Math.round(etv * 100);
    if (!Number.isSafeInteger(cents) || cents < 0 || cents > 10000000) {
      throw new Error("ETV is outside the shared cache's supported range");
    }
    const data = await request("/v1/contribute", { key: key(item), cents }, signal);
    if (data?.ok !== true) throw new Error("Invalid cache response");
  }

  const api = { lookup, contribute };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SharedEtv = api;
})(globalThis);
