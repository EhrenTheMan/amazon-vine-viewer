const test = require("node:test");
const assert = require("node:assert/strict");
const { parseVineDocument, parseEtv, safeImage, hasNextPage, parseKeywords, filterItems, sortItems, createArrivalTracker } = require("../core.js");

test("keeps zero ETV first in all sort modes, then sorts and leaves unknowns last", () => {
  const items = [{ etv: null }, { etv: 4 }, { etv: 12 }, { etv: 0 }, { etv: 4 }, {}];
  assert.deepEqual(sortItems(items, "high"), [items[3], items[2], items[1], items[4], items[0], items[5]]);
  assert.deepEqual(sortItems(items, "low"), [items[3], items[1], items[4], items[2], items[0], items[5]]);
  assert.deepEqual(sortItems(items, "recent"), [items[3], items[0], items[1], items[2], items[4], items[5]]);
});

test("parses numeric ETV without treating missing or malformed values as zero", () => {
  for (const value of [0, "0.00", " 12.50 "]) assert.equal(parseEtv(value), Number(value));
  for (const value of [null, "", " ", undefined, false, -1, "1,000", "$0", "1-2", Infinity]) assert.equal(parseEtv(value), null);
});

test("recognizes missing Vine grid and rejects malformed tiles", () => {
  assert.throws(() => parseVineDocument({ querySelector: () => null }), /Vine results/);
  const tile = { querySelector: () => null, getAttribute: () => null };
  assert.throws(() => parseVineDocument({ querySelector: () => ({ querySelectorAll: () => [tile] }) }), /unrecognized item/);
  assert.deepEqual(parseVineDocument({ querySelector: () => ({ querySelectorAll: () => [] }) }), []);
});

test("extracts a Vine item from its product link and title", () => {
  const link = { getAttribute: () => "/dp/B012345678?ref=vine", textContent: "Short title" };
  const tile = {
    querySelector: (selector) => selector === 'a[href*="/dp/"]' ? link :
      selector === ".a-truncate-full" ? { textContent: " Full title " } :
      selector === "img" ? { getAttribute: () => "https://m.media-amazon.com/item.jpg" } : null,
    getAttribute: () => null,
  };
  const doc = { querySelector: () => ({ querySelectorAll: () => [tile] }) };
  assert.deepEqual(parseVineDocument(doc), [{
    asin: "B012345678", title: "Full title", image: "https://m.media-amazon.com/item.jpg", recommendationId: "", isParent: false, isPreRelease: false,
  }]);
});

test("reads recommendation metadata from a parent tile", () => {
  const metadata = { getAttribute: (name) => ({ "data-recommendation-id": "queue#B012345678#enrollment", "data-is-parent-asin": "true", "data-is-pre-release": "true" })[name] };
  const tile = {
    querySelector: (selector) => selector === 'a[href*="/dp/"]' ? { getAttribute: () => "/dp/B012345678" } :
      selector === ".a-truncate-full" ? { textContent: "Title" } :
      selector === "[data-recommendation-id][data-asin]" ? metadata : null,
    getAttribute: () => null,
  };
  const [item] = parseVineDocument({ querySelector: () => ({ querySelectorAll: () => [tile] }) });
  assert.equal(item.recommendationId, "queue#B012345678#enrollment");
  assert.equal(item.isParent, true);
  assert.equal(item.isPreRelease, true);
});

test("restricts item images to HTTPS Amazon hosts", () => {
  assert.equal(safeImage(""), "");
  assert.equal(safeImage("https://m.media-amazon.com/images/I/example.jpg"), "https://m.media-amazon.com/images/I/example.jpg");
  assert.equal(safeImage("https://evil.example/x"), "");
  assert.equal(safeImage("http://m.media-amazon.com/x"), "");
});

test("filters case-insensitive literal keywords separated by commas or newlines", () => {
  const keywords = parseKeywords("  PHONE, cable\n phone, \n USB-C ");
  assert.deepEqual(keywords, ["phone", "cable", "usb-c"]);
  const items = [{ title: "Phone Case" }, { title: "USB-C adapter" }, { title: "Desk lamp" }];
  assert.deepEqual(filterItems(items, keywords), [items[2]]);
  assert.deepEqual(filterItems(items, []), items);
  const values = [{ title: "Free", etv: 0 }, { title: "Unknown", etv: null }, { title: "Costly", etv: 10 }];
  assert.deepEqual(filterItems(values, [], false), [values[1], values[2]]);
  assert.deepEqual(filterItems(values, [], true), values);
});

test("validates next-page links and identifies the end", () => {
  const doc = (href, disabled = false) => ({
    querySelector: () => ({
      querySelector: () => ({
        classList: { contains: () => disabled },
        querySelector: () => href ? { getAttribute: () => href } : null,
      }),
    }),
  });
  assert.equal(hasNextPage(doc("/vine/vine-items?queue=encore&pn=&cn=&page=2"), "encore", 1), true);
  assert.equal(hasNextPage(doc(null, true), "encore", 2), false);
  assert.throws(() => hasNextPage(doc("/vine/vine-items?queue=encore&page=4"), "encore", 1), /unexpected/);
  assert.throws(() => hasNextPage(doc("https://example.com/vine/vine-items?queue=encore&page=2"), "encore", 1), /unexpected/);
  assert.throws(() => hasNextPage(doc(null), "encore", 1), /not found/);
  assert.equal(hasNextPage({ querySelector: () => null }, "encore", 1), false);
  assert.throws(() => hasNextPage({ querySelector: () => null }, "encore", 2), /pagination/);
});

test("tracks session arrivals and switches fast mode after more than five", () => {
    const tracker = createArrivalTracker();
    const make = (...ids) => ids.map((asin) => ({ asin }));
    assert.deepEqual(tracker.complete(make("a", "b"), 5, true), { baseline: true, count: 0, fast: false, quietScans: 0 });
    assert.equal(tracker.isArrival("a"), false);
    assert.deepEqual(tracker.complete(make("a", "c", "d", "e", "f", "g"), 5, true), { baseline: false, count: 5, fast: false, quietScans: 0 });
    assert.equal(tracker.isArrival("c"), true);
    assert.deepEqual(tracker.complete(make("a", "h", "i", "j", "k", "l", "m"), 5, true), { baseline: false, count: 6, fast: true, quietScans: 0 });
    assert.equal(tracker.complete(make("a", "b"), 5, true).count, 0);
    assert.equal(tracker.isArrival("c"), true);
    assert.deepEqual(tracker.complete(make("n", "o", "p", "q", "r"), 5, true), { baseline: false, count: 5, fast: true, quietScans: 2 });
    assert.deepEqual(tracker.complete(make("n"), 5, true), { baseline: false, count: 0, fast: false, quietScans: 0 });
});

test("new drops reset quiet streak and disabled refresh stays disabled", () => {
    const tracker = createArrivalTracker();
    const make = (start, count) => Array.from({ length: count }, (_, i) => ({ asin: String(start + i) }));
    tracker.complete([], 1, true);
    tracker.complete(make(0, 6), 1, true);
    assert.equal(tracker.complete([], 1, true).quietScans, 1);
    assert.deepEqual(tracker.complete(make(6, 6), 1, true), { baseline: false, count: 6, fast: true, quietScans: 0 });
    assert.equal(tracker.complete(make(12, 6), 1, false).fast, false);
    assert.equal(tracker.isArrival("12"), true);
});

test("scope change rebaselines without forgetting session highlights", () => {
    const tracker = createArrivalTracker();
    tracker.complete([{ asin: "old" }], 1, true);
    tracker.complete([{ asin: "new" }], 1, true);
    assert.equal(tracker.complete([{ asin: "new" }, { asin: "older-page" }], 2, true).baseline, true);
    assert.equal(tracker.isArrival("new"), true);
    assert.equal(tracker.isArrival("older-page"), false);
    assert.equal(tracker.complete([{ asin: "older-page" }], 2, true).count, 0);
});
