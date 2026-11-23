(function (root) {
  "use strict";

  function parseVineDocument(doc) {
    const grid = doc.querySelector("#vvp-items-grid");
    if (!grid) throw new Error("Vine results were not found. Sign in to Amazon and check for a verification page.");
    const tiles = [...grid.querySelectorAll(".vvp-item-tile")];
    return tiles.map((tile) => {
      const link = tile.querySelector('a[href*="/dp/"]');
      const href = link?.getAttribute("href") || "";
      const asin = href.match(/\/dp\/([a-z0-9]{10})(?:[/?#]|$)/i)?.[1]?.toUpperCase()
        || tile.querySelector("[data-asin]")?.getAttribute("data-asin")?.toUpperCase()
        || tile.getAttribute("data-asin")?.toUpperCase();
      const title = tile.querySelector(".a-truncate-full")?.textContent?.trim()
        || link?.textContent?.trim()
        || tile.querySelector("img")?.getAttribute("alt")?.trim();
      if (!/^[A-Z0-9]{10}$/.test(asin || "") || !title) {
        throw new Error("Amazon returned an unrecognized item layout. No results were replaced.");
      }
      const image = tile.querySelector("img")?.getAttribute("src") || "";
      const details = tile.querySelector("[data-recommendation-id][data-asin]");
      const recommendationId = details?.getAttribute("data-recommendation-id") || "";
      const isParent = details?.getAttribute("data-is-parent-asin") === "true";
      const isPreRelease = details?.getAttribute("data-is-pre-release") === "true";
      return { asin, title, image: safeImage(image), recommendationId, isParent, isPreRelease };
    });
  }

  function safeImage(value) {
    if (!value) return "";
    try {
      const url = new URL(value, "https://www.amazon.com/");
      return url.protocol === "https:" &&
        (url.hostname === "www.amazon.com" || url.hostname.endsWith(".media-amazon.com"))
        ? url.href : "";
    } catch {
      return "";
    }
  }

  function parseEtv(value) {
    if (typeof value !== "number" && (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value.trim()))) {
      return null;
    }
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
  }

  function hasNextPage(doc, queue, currentPage, category = null) {
    const pagination = doc.querySelector("#vvp-items-grid-container .a-pagination");
    if (!pagination) {
      if (currentPage > 1) throw new Error("Amazon's pagination was not found on a later page.");
      return false;
    }
    const next = pagination.querySelector("li.a-last");
    if (!next) throw new Error("Amazon's next-page control was not found.");
    const link = next.querySelector("a[href]");
    if (!link) {
      if (next.classList.contains("a-disabled")) return false;
      throw new Error("Amazon's next-page link was not found.");
    }
    const url = new URL(link.getAttribute("href"), "https://www.amazon.com");
    if (url.protocol !== "https:" || url.hostname !== "www.amazon.com" ||
        url.pathname !== "/vine/vine-items" || url.searchParams.get("queue") !== queue ||
        url.searchParams.get("page") !== String(currentPage + 1) ||
        (category && (url.searchParams.get("pn") !== category.pn || url.searchParams.get("cn") !== category.cn))) {
      throw new Error("Amazon returned an unexpected next-page link.");
    }
    return true;
  }

  function parseKeywords(value) {
    return [...new Set(value.split(/[\n,]+/).map((word) => word.trim().toLowerCase()).filter(Boolean))];
  }

  function matchesKeywords(item, keywords) {
    const title = item.title.toLowerCase();
    return keywords.some((keyword) => title.includes(keyword));
  }

  function parseCategories(value) {
    const categories = [];
    const seen = new Set();
    for (const line of value.split(/\n/).map((entry) => entry.trim()).filter(Boolean)) {
      let url;
      try { url = new URL(line); } catch { throw new Error("Enter one complete Amazon.com category URL per line."); }
      const pn = url.searchParams.get("pn");
      const cn = url.searchParams.get("cn");
      if (url.protocol !== "https:" || url.hostname !== "www.amazon.com" || url.port || url.username || url.password ||
          url.pathname !== "/vine/vine-items" || url.searchParams.get("queue") !== "encore" ||
          url.searchParams.has("search") ||
          !/^\d+$/.test(pn || "") || !/^\d+$/.test(cn || "") ||
          url.searchParams.getAll("queue").length !== 1 || url.searchParams.getAll("pn").length !== 1 ||
          url.searchParams.getAll("cn").length !== 1) {
        throw new Error("Each favorite must be an Amazon.com Additional Items category URL with numeric pn and cn parameters.");
      }
      const key = `${pn}:${cn}`;
      if (!seen.has(key)) {
        seen.add(key);
        categories.push({ pn, cn });
      }
    }
    return categories;
  }

  function filterItems(items, keywords, showZero = true, search = "") {
    const query = search.trim().toLowerCase();
    return items.filter((item) => (showZero || item.etv !== 0) &&
      !matchesKeywords(item, keywords) &&
      (!query || item.title.toLowerCase().includes(query) || item.asin?.toLowerCase().includes(query)));
  }

  function createArrivalTracker() {
    const seen = new Set();
    const arrivals = new Set();
    let scope = null;
    let fast = false;
    let quietScans = 0;
    return {
      complete(items, pageLimit, autoEnabled) {
        const ids = new Set(items.map((item) => item.asin));
        if (scope !== pageLimit) {
          scope = pageLimit;
          for (const id of ids) seen.add(id);
          fast = false;
          quietScans = 0;
          return { baseline: true, count: 0, fast, quietScans };
        }
        let count = 0;
        for (const id of ids) {
          if (!seen.has(id)) {
            seen.add(id);
            arrivals.add(id);
            count++;
          }
        }
        if (!autoEnabled) {
          fast = false;
          quietScans = 0;
        } else if (count > 5) {
          fast = true;
          quietScans = 0;
        } else if (fast && ++quietScans >= 3) {
          fast = false;
          quietScans = 0;
        }
        return { baseline: false, count, fast, quietScans };
      },
      isArrival(asin) { return arrivals.has(asin); },
      get fast() { return fast; },
      disableFast() { fast = false; quietScans = 0; },
    };
  }

  function sortItems(items, order) {
    return items.map((item, index) => ({ item, index })).sort((a, b) => {
      if ((a.item.etv === 0) !== (b.item.etv === 0)) return a.item.etv === 0 ? -1 : 1;
      if (order === "recent") return a.index - b.index;
      const aKnown = Number.isFinite(a.item.etv);
      const bKnown = Number.isFinite(b.item.etv);
      if (aKnown !== bKnown) return aKnown ? -1 : 1;
      if (!aKnown) return a.index - b.index;
      return (order === "high" ? b.item.etv - a.item.etv : a.item.etv - b.item.etv) || a.index - b.index;
    }).map(({ item }) => item);
  }

  const api = { parseVineDocument, parseEtv, safeImage, hasNextPage, parseKeywords, matchesKeywords, parseCategories, filterItems, sortItems, createArrivalTracker };
  if (typeof module !== "undefined") module.exports = api;
  else root.VineCore = api;
})(globalThis);
