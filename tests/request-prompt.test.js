const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const source = fs.readFileSync(require("node:path").join(__dirname, "../request-prompt.js"), "utf8");

function run(hash, buttons) {
  const notices = [];
  const location = { hash, pathname: "/vine/vine-items", search: "?queue=encore" };
  const history = { state: null, replaceState: (_state, _title, url) => { history.replaced = url; } };
  const document = {
    readyState: "complete",
    body: { prepend: (notice) => notices.push(notice) },
    querySelectorAll: () => buttons,
    createTextNode: (text) => ({ text }),
    createElement: () => ({
      style: {}, children: [], setAttribute() {},
      append(...nodes) { this.children.push(...nodes); },
      addEventListener(_type, callback) { this.onClick = callback; },
      remove() {},
    }),
  };
  vm.runInNewContext(source, { location, history, document, setTimeout: (callback) => callback() });
  return { notices, history };
}

test("opens only the selected item's details and supplies a manual retry", () => {
  let clicked = 0;
  const target = { dataset: { asin: "B000000001" }, click: () => clicked++ };
  const other = { dataset: { asin: "B000000002" }, click: () => assert.fail("Wrong item clicked") };
  const { notices, history } = run("#vine-viewer-request=B000000001", [other, target]);
  assert.equal(clicked, 1);
  assert.equal(history.replaced, "/vine/vine-items?queue=encore");
  assert.match(notices[0].children[0].text, /No order has been placed/);
  notices[0].children[1].onClick();
  assert.equal(clicked, 2);
});

test("missing and invalid item links never click a details button", () => {
  const button = { dataset: { asin: "B000000002" }, click: () => assert.fail("Unexpected click") };
  const missing = run("#vine-viewer-request=B000000001", [button]);
  assert.match(missing.notices[0].children[0].text, /no longer on this page/);
  const invalid = run("#vine-viewer-request=invalid", [button]);
  assert.equal(invalid.notices.length, 0);
  assert.equal(invalid.history.replaced, undefined);
});
