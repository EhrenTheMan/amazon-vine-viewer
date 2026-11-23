const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const VineCore = require("../core.js");

const source = fs.readFileSync(path.join(__dirname, "../viewer.js"), "utf8")
  .replace('start().catch((error) => showError(`Could not start viewer: ${error.message}`));', "");

function harness() {
  const nodes = new Map();
  const notifications = [];
  const timers = [];
  const context = vm.createContext({
    VineCore, URL, Date, Intl, AbortController, console,
    document: { getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, { value: "", textContent: "", hidden: true });
      return nodes.get(id);
    } },
    browser: {
      runtime: { getURL: (file) => file },
      notifications: { create: async (notification) => { notifications.push(notification); } },
    },
    setTimeout: (callback, delay) => { const timer = { callback, delay }; timers.push(timer); return timer; },
    clearTimeout: (timer) => { if (timer) timer.cleared = true; },
  });
  vm.runInContext(source, context);
  return { context, nodes, notifications, timers };
}

test("alerts on first-scan matches once per type and ignores hidden titles", async () => {
  const h = harness();
  vm.runInContext(`
    settings = { ...defaults, alertKeywords: true, alertZero: true, alertDesktop: true,
      highlightKeywords: "lamp", keywords: "hidden" };
    items = [
      { asin: "B000000001", title: "Lamp", etv: null },
      { asin: "B000000002", title: "Hidden lamp", etv: 0 }
    ];
    for (const item of items) eligibleAlerts.add("encore:" + item.asin);
    notifyMatches();
    items[0].etv = 0;
    notifyMatches();
    notifyMatches();
  `, h.context);
  await new Promise(setImmediate);
  assert.equal(h.notifications.length, 2);
  assert.match(h.notifications[0].message, /Lamp \(keyword\)/);
  assert.match(h.notifications[1].message, /Lamp \(\$0 ETV\)/);
});

test("refresh scheduling reports the timer and clears it when paused", () => {
  const h = harness();
  vm.runInContext("settings.interval = 120; scheduleRefresh();", h.context);
  assert.equal(h.timers[0].delay, 120000);
  assert.match(h.nodes.get("next-refresh").textContent, /^Next refresh: .+\.$/);
  vm.runInContext("paused = true; scheduleRefresh();", h.context);
  assert.equal(h.timers[0].cleared, true);
  assert.equal(h.nodes.get("next-refresh").textContent, "Next refresh: not scheduled.");
});

test("reveals collapsed scan settings when a category URL is invalid", async () => {
  const h = harness();
  vm.runInContext(`
    $("page-size").value = "24";
    $("scan-pages").value = "5";
    $("categories").value = "not a URL";
  `, h.context);
  await vm.runInContext("applySettings()", h.context);
  assert.equal(h.nodes.get("scan-settings").open, true);
  assert.match(h.nodes.get("error").textContent, /category URL/);
});
