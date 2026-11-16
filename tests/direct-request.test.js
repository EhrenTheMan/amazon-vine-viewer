const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { parseEtv } = require("../core.js");
const { checkedDetails, csrfFromDocument, checkoutFields } = require("../direct-request.js");
const source = fs.readFileSync(path.join(__dirname, "../direct-request.js"), "utf8");

const details = { asin: "B000000002", productTitle: "Blue item", taxValue: "12.50", taxCurrency: "USD", promotionId: "PROMO", purchasePolicyCode: "AmazonVine" };

test("requires matching, current variant details and checkout fields", () => {
  const checked = checkedDetails(details, details.asin, parseEtv);
  assert.equal(checked.etv, 12.5);
  for (const invalid of [
    { ...details, asin: "B000000003" }, { ...details, taxValue: null },
    { ...details, taxCurrency: "EUR" }, { ...details, promotionId: "" },
  ]) assert.throws(() => checkedDetails(invalid, details.asin, parseEtv), /complete, matching/);
  assert.equal(checkoutFields(details.asin, checked, { result: { proceedToCheckout: true, offerListingId: "offer" } })[3][1], "offer");
  assert.throws(() => checkoutFields(details.asin, checked, { result: { proceedToCheckout: true, offerListingId: "offer", orderId: "already-ordered" } }), /Check your Vine orders/);
  assert.throws(() => checkoutFields(details.asin, checked, { error: "unavailable" }), /Check your Vine orders/);
});

test("reads only the Vine context token", () => {
  const script = (state, content) => ({ getAttribute: () => state, textContent: content });
  const doc = { querySelectorAll: () => [script("bad JSON", "{}"), script('{"key":"vvp-context"}', '{"csrfToken":"token"}')] };
  assert.equal(csrfFromDocument(doc), "token");
  assert.throws(() => csrfFromDocument({ querySelectorAll: () => [] }), /request token/);
});

function harness({ failPost = false } = {}) {
  const nodes = new Map();
  const submissions = [];
  let posts = 0;
  let now = 1000000;
  const node = () => ({
    children: [], events: {}, hidden: false, disabled: false, value: "", textContent: "",
    addEventListener(name, fn) { this.events[name] = fn; },
    replaceChildren() { this.children = []; },
    append(...children) { this.children.push(...children); },
    remove() {},
    submit() { submissions.push(this); },
    showModal() { this.open = true; },
    close() { this.open = false; this.events.close?.(); },
    dispatch(name) { return this.events[name]?.({ preventDefault() {} }); },
  });
  const document = {
    body: node(),
    getElementById(id) { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); },
    createElement() { return node(); },
  };
  const responses = [];
  const context = {
    document, URL, Intl, VineCore: { parseEtv }, Date: class extends Date { static now() { return now; } },
    window: { open: () => ({ closed: false, close() { this.closed = true; } }) },
    amazonEtvResponse: async (url) => {
      responses.push(url);
      return url.includes("/item/") ? details : { recommendationId: "variant-rec", variations: [{ asin: details.asin, dimensions: { Color: "Blue" } }] };
    },
    amazonDocument: async () => ({ querySelectorAll: () => [{ getAttribute: () => '{"key":"vvp-context"}', textContent: '{"csrfToken":"token"}' }] }),
    fetch: async (_url, options) => {
      posts++;
      const body = JSON.parse(options.body);
      assert.equal(body.itemAsin, details.asin);
      assert.equal(body.recommendationId, responses[0] === "rec" ? "variant-rec" : "rec");
      if (failPost) throw new Error("Connection lost");
      return { ok: true, redirected: false, headers: { get: () => "application/json" }, json: async () => ({ result: { proceedToCheckout: true, offerListingId: "offer" } }) };
    },
  };
  vm.runInNewContext(source, context);
  return { context, el: document.getElementById, submissions, responses, posts: () => posts, advance: (ms) => { now += ms; } };
}

test("requires variant selection and confirmation before requesting and opening checkout", async () => {
  const h = harness();
  const item = { asin: "B000000001", title: "Item", isParent: true, recommendationId: "rec", sourceQueue: "encore" };
  await h.context.DirectRequest.open(item);
  assert.equal(h.posts(), 0);
  assert.equal(h.el("request-confirm").disabled, true);
  h.el("request-variants").value = details.asin;
  h.el("request-variants").dispatch("change");
  await new Promise(setImmediate);
  assert.match(h.el("request-details").textContent, /12\.50/);
  assert.match(h.responses[1], /^variant-rec\/item\//);
  assert.equal(h.el("request-confirm").disabled, false);
  await h.el("request-confirm").dispatch("click");
  assert.equal(h.posts(), 1);
  assert.equal(h.submissions.length, 1);
  assert.match(h.submissions[0].action, /^https:\/\/www\.amazon\.com\/checkout\//);
  assert.match(h.el("request-details").textContent, /does not confirm an order/);
  await h.el("request-confirm").dispatch("click");
  assert.equal(h.posts(), 1);
});

test("expired ETV requires a fresh review rather than sending a request", async () => {
  const h = harness();
  await h.context.DirectRequest.open({ asin: details.asin, title: "Item", isParent: false, recommendationId: "rec", sourceQueue: "encore" });
  h.advance(120001);
  await h.el("request-confirm").dispatch("click");
  assert.equal(h.posts(), 0);
  assert.equal(h.el("request-confirm").disabled, true);
  assert.match(h.el("request-error").textContent, /expired/);
});

test("does not retry after an uncertain submission and blocks pre-release requests", async () => {
  const h = harness({ failPost: true });
  const item = { asin: details.asin, title: "Item", isParent: false, recommendationId: "rec", sourceQueue: "encore" };
  await h.context.DirectRequest.open(item);
  await h.el("request-confirm").dispatch("click");
  assert.match(h.el("request-error").textContent, /outcome is unknown/);
  assert.equal(h.submissions.length, 0);
  await h.el("request-confirm").dispatch("click");
  assert.equal(h.posts(), 1);
  h.el("request-dialog").close();
  await h.context.DirectRequest.open({ ...item, isPreRelease: true });
  assert.match(h.el("request-error").textContent, /Pre-release/);
  assert.equal(h.el("request-confirm").disabled, true);
});
